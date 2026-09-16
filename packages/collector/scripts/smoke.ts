/**
 * `bun run smoke` — the published artefact, exercised as a consumer receives it.
 *
 * Every test in this repo runs against `src/`, and CI runs `test` before
 * `build`, so nothing otherwise executes the export map, the `types` resolution,
 * the ESM/CJS split or the `sideEffects` annotation of the thing actually being
 * published. This is the only check that touches `dist/` from outside the
 * package; `publish-collector.yml` runs it between `build` and `publish`.
 *
 * ── What "from outside the package" is made to mean here
 *
 * `npm pack` the tarball, extract it into a throwaway consumer's `node_modules`,
 * and load it **by bare specifier** from there. Three things fall out of doing
 * it that way rather than importing `dist/index.js` by path:
 *
 *  - the `exports` map is the only thing that can resolve the specifier, so an
 *    entry missing from it fails here rather than in a customer's install;
 *  - the `files` whitelist is the only thing that put the file on disk, so a
 *    `dist` that builds but does not ship fails here too;
 *  - the emitted `.d.ts` is typechecked in a program that contains **no source
 *    of this package at all**, which is the check that catches a declaration
 *    that only ever resolved because `src/` happened to be in the same program.
 *
 * ── Why every check is its own process
 *
 * Importing the main entry patches `globalThis.WebTransport` at module-eval
 * time, and that patch is a *global*: it cannot be undone by a `beforeEach`, and
 * ESM module records are cached per realm so a second import would not re-run
 * the side effect anyway. In a single-process runner the draft-entry assertions
 * would pass or fail on the order the files happened to run in, which is the
 * exact failure this check exists to rule out.
 *
 * So each probe is spawned as a **fresh `node` process** with a sentinel
 * `WebTransport` planted before anything is loaded; nothing leaks between probes
 * because nothing is shared between them. `node`, not `bun`, deliberately: this
 * package's `exports` map lists a `"bun"` condition pointing straight back at
 * `./src/*.ts`, so a bun-hosted probe would resolve **the source** and measure
 * nothing about the build.
 *
 * ── Usage
 *
 *   bun run build && bun run smoke
 *   bun run smoke --keep      leave the fixture on disk and print its path
 */

import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Package root — this file is `<root>/scripts/`. */
const PKG = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REPO = resolve(PKG, '..', '..')
const NODE = process.platform === 'win32' ? 'node.exe' : 'node'
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm'

interface PackageJson {
  readonly name: string
  readonly version: string
  readonly type?: string
  readonly sideEffects?: readonly string[]
  readonly exports: Readonly<Record<string, Readonly<Record<string, string>>>>
}

const pkg = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8')) as PackageJson

/* ── result accounting ───────────────────────────────────────────────────── */

const failures: string[] = []
let checks = 0

function check(ok: boolean, name: string, detail = ''): void {
  checks++
  if (ok) {
    process.stdout.write(`  ok    ${name}\n`)
    return
  }
  process.stdout.write(
    `  FAIL  ${name}${detail ? `\n        ${detail.replace(/\n/g, '\n        ')}` : ''}\n`,
  )
  failures.push(detail ? `${name}: ${detail}` : name)
}

function section(title: string): void {
  process.stdout.write(`\n${title}\n`)
}

/* ── fixture ─────────────────────────────────────────────────────────────── */

interface PackResult {
  readonly tarball: string
  readonly files: readonly string[]
  readonly size: number
  readonly unpackedSize: number
}

/**
 * `npm pack` the real tarball and read back the exact manifest npm would
 * publish.
 *
 * `--dry-run` would answer the "what ships" question on its own, but the
 * tarball is also the fixture every other check runs against — extracting what
 * npm actually wrote is the difference between asserting on a manifest and
 * asserting on the bytes.
 */
function pack(dest: string): PackResult {
  const r = spawnSync(NPM, ['pack', '--json', '--pack-destination', dest], {
    cwd: PKG,
    encoding: 'utf8',
  })
  if (r.status !== 0) throw new Error(`npm pack failed\n${r.stdout ?? ''}\n${r.stderr ?? ''}`)
  // npm prints notices on stdout ahead of the JSON on some versions.
  const start = r.stdout.indexOf('[')
  const parsed = JSON.parse(r.stdout.slice(start)) as [
    {
      filename: string
      size: number
      unpackedSize: number
      files: { path: string }[]
    },
  ]
  const first = parsed[0]
  if (first === undefined) throw new Error('npm pack returned no entries')
  return {
    tarball: join(dest, first.filename),
    files: first.files.map((f) => f.path.replaceAll('\\', '/')),
    size: first.size,
    unpackedSize: first.unpackedSize,
  }
}

/**
 * Build the throwaway consumer.
 *
 * The collector is **extracted from the tarball**, because that is the artefact
 * under test. `@moqtap/codec` is **symlinked from the workspace**: it is a
 * `peerDependency` that a real consumer installs from the registry, it is not
 * what this script is checking, and reaching for the registry here would make a
 * publish gate depend on the network.
 */
function buildFixture(root: string, tarball: string): string {
  const consumer = join(root, 'consumer')
  const modules = join(consumer, 'node_modules', '@moqtap')
  mkdirSync(join(modules, 'collector'), { recursive: true })
  mkdirSync(join(consumer, 'probes'), { recursive: true })
  mkdirSync(join(consumer, 'types'), { recursive: true })

  // Extracted with `cwd` at the destination and a *relative* tarball path. GNU
  // tar reads `C:\…` as `host:path` and tries to open an rsh connection to a
  // host called `C` ("Cannot connect to C: resolve failed"); `--force-local`
  // fixes that on GNU tar but not on the bsdtar Windows ships. A relative path
  // has no colon in it on any platform.
  const dest = join(modules, 'collector')
  const untar = spawnSync(
    'tar',
    ['-xzf', relative(dest, tarball).replaceAll('\\', '/'), '--strip-components=1'],
    { cwd: dest, encoding: 'utf8' },
  )
  if (untar.status !== 0) {
    throw new Error(`tar failed\n${untar.stdout ?? ''}\n${untar.stderr ?? ''}`)
  }

  // `type: 'junction'` is Windows-only and ignored elsewhere, which is exactly
  // the portability we want: junctions need no elevation on Windows, and every
  // other platform gets an ordinary directory symlink.
  symlinkSync(join(REPO, 'packages', 'codec'), join(modules, 'codec'), 'junction')

  writeFileSync(
    join(consumer, 'package.json'),
    `${JSON.stringify({ name: 'collector-smoke-consumer', private: true, version: '0.0.0', type: 'module' }, null, 2)}\n`,
  )
  return consumer
}

/* ── probes ──────────────────────────────────────────────────────────────── */

/**
 * The sentinel. Planted on `globalThis` *before* the package is loaded, so
 * "did importing this patch the global?" is answerable as identity rather than
 * as `typeof`: Node has no `WebTransport` of its own, and without a sentinel
 * every entry would look unpatched.
 */
const PROBE_PREAMBLE = [
  'const SENTINEL = function WebTransport() {}',
  'SENTINEL.prototype = {}',
  'globalThis.WebTransport = SENTINEL',
  'const report = (m) => {',
  '  const ns = m && (m.default && Object.keys(m).length === 1 ? m.default : m)',
  '  process.stdout.write(JSON.stringify({',
  '    ok: true,',
  '    patched: globalThis.WebTransport !== SENTINEL,',
  '    stillFunction: typeof globalThis.WebTransport === "function",',
  '    names: Object.keys(ns).sort(),',
  '    kinds: Object.fromEntries(Object.keys(ns).sort().map((k) => [k, typeof ns[k]])),',
  '  }))',
  '}',
].join('\n')

interface ProbeOk {
  readonly ok: true
  readonly patched: boolean
  readonly stillFunction: boolean
  readonly names: readonly string[]
  readonly kinds: Readonly<Record<string, string>>
}

interface ProbeFailed {
  readonly ok: false
  /** Whatever node said, trimmed to something that fits on a failure line. */
  readonly output: string
}

type ProbeResult = ProbeOk | ProbeFailed

/**
 * Run one probe in its own process.
 *
 * ESM probes use `await import()` rather than a static `import`, because static
 * imports are hoisted above the sentinel assignment — the module would be
 * evaluated before there was a `WebTransport` for it to patch, and the check
 * would report "no side effect" for an entry that has one. `import()` is the
 * same loader and the same `"import"` export condition, evaluated after the
 * preamble has run.
 */
function probe(consumer: string, name: string, specifier: string, cjs: boolean): ProbeResult {
  const file = join(consumer, 'probes', `${name}.${cjs ? 'cjs' : 'mjs'}`)
  writeFileSync(
    file,
    cjs
      ? `${PROBE_PREAMBLE}\nreport(require(${JSON.stringify(specifier)}))\n`
      : `${PROBE_PREAMBLE}\nreport(await import(${JSON.stringify(specifier)}))\n`,
  )
  const r = spawnSync(NODE, [file], { cwd: consumer, encoding: 'utf8' })
  if (r.status !== 0) {
    const output = `${r.stdout ?? ''}\n${r.stderr ?? ''}`.trim().split('\n').slice(0, 8).join('\n')
    return { ok: false, output }
  }
  return { ...(JSON.parse(r.stdout) as Omit<ProbeOk, 'ok'>), ok: true }
}

/* ── the entry contract ──────────────────────────────────────────────────── */

/**
 * A handful of names per entry, chosen so that resolving to the *wrong* file
 * fails rather than passes. An export map that points `./draft19` at the main
 * entry would resolve, import, and be caught only by `DRAFT19_ADAPTER`.
 */
const EXPECTED: Readonly<
  Record<string, { readonly names: readonly string[]; readonly patches: boolean }>
> = {
  '.': {
    names: [
      'init',
      'initWorker',
      'resolveConfig',
      'ensureDormantHook',
      'COLLECTOR_VERSION',
      'NEED',
    ],
    // The dormant install, and the reason `./dist/index.js` and `./dist/index.cjs` are the only
    // two files in the `sideEffects` allowlist.
    patches: true,
  },
  './draft19': {
    names: ['adapter', 'DRAFT19_ADAPTER', 'draft', 'PROTOCOL_STRINGS', 'NEED'],
    patches: false,
  },
  './draft20': {
    names: ['adapter', 'DRAFT20_ADAPTER', 'draft', 'PROTOCOL_STRINGS', 'NEED'],
    patches: false,
  },
}

/* ── main ────────────────────────────────────────────────────────────────── */

function main(): void {
  if (!existsSync(join(PKG, 'dist', 'index.js'))) {
    process.stderr.write(
      'smoke: packages/collector/dist is missing. This checks the built artefact — run `bun run build` first.\n',
    )
    process.exit(1)
  }

  const keep = process.argv.includes('--keep')
  const root = mkdtempSync(join(tmpdir(), 'moqtap-collector-smoke-'))
  process.stdout.write(`${pkg.name}@${pkg.version} — smoke test of the published artefact\n`)
  process.stdout.write(`  fixture: ${root}\n`)

  try {
    /* 0 ── is `dist/` the thing `bun run build` produced? ─────────────────── */

    section('dist/ holds the build output and nothing else')
    distIsOnlyTheBuild()

    /* 1 ── what a consumer actually receives ─────────────────────────────── */

    const packed = pack(root)
    const files = new Set(packed.files)
    section(
      `publish contents — ${packed.files.length} files, ` +
        `${(packed.size / 1024).toFixed(1)} KB packed / ${(packed.unpackedSize / 1024).toFixed(1)} KB unpacked`,
    )

    // Every path the export map can resolve to must be in the tarball. This
    // covers the `bun` condition too, which points at `./src/*.ts` and would
    // break silently for every bun consumer the day `src` left `files`.
    const exportTargets = new Set<string>()
    for (const conditions of Object.values(pkg.exports)) {
      for (const target of Object.values(conditions)) exportTargets.add(target.replace(/^\.\//, ''))
    }
    for (const target of [...exportTargets].sort()) {
      check(files.has(target), `exports map target ships: ${target}`)
    }

    // The `sideEffects` allowlist names files by path. A path that is not in the
    // tarball is an annotation a bundler cannot match, and an unmatched entry in
    // a `sideEffects` array is silently treated as "no side effects".
    for (const target of pkg.sideEffects ?? []) {
      check(files.has(target.replace(/^\.\//, '')), `sideEffects entry ships: ${target}`)
    }

    check(files.has('package.json'), 'package.json ships')
    check(files.has('README.md'), 'README.md ships')
    check(files.has('LICENSE'), 'LICENSE ships')

    // What must NOT be there. `files` is a whitelist, but it lets `dist` and
    // `src` through wholesale, so anything that lands in either directory ships
    // unless something says otherwise.
    const forbidden: readonly [RegExp, string][] = [
      [/(^|\/)__tests__\//, 'a test tree (fixtures can carry real capture bytes)'],
      [/\.test\.[cm]?[jt]s$/, 'a test file'],
      [/\.map$/, 'a source map or declaration map (tsup sets sourcemap: false)'],
      [/\.tsbuildinfo$/, 'incremental build state'],
      [/^scripts\//, 'this package’s own build/CI scripts'],
      [/^(tsconfig|tsup\.config|vitest\.config|biome)/, 'build configuration'],
      [/(^|\/)\.npmignore$/, 'the npmignore itself'],
    ]
    for (const [pattern, what] of forbidden) {
      const hits = packed.files.filter((f) => pattern.test(f))
      check(hits.length === 0, `does not ship ${what}`, hits.slice(0, 8).join(', '))
    }

    // And the positive backstop: the built output and the declarations are
    // there in both module formats.
    for (const base of ['index', 'draft19', 'draft20']) {
      for (const ext of ['js', 'cjs', 'd.ts']) {
        check(files.has(`dist/${base}.${ext}`), `dist/${base}.${ext} ships`)
      }
    }

    /* 2 ── resolve and import, from outside, in both formats ─────────────── */

    const consumer = buildFixture(root, packed.tarball)

    section('resolve and import, by bare specifier, from a consumer’s node_modules')
    const results = new Map<string, ProbeOk>()
    for (const [sub, expected] of Object.entries(EXPECTED)) {
      const specifier = sub === '.' ? pkg.name : `${pkg.name}/${sub.slice(2)}`
      for (const cjs of [false, true]) {
        const label = `${specifier} (${cjs ? 'CJS require' : 'ESM import'})`
        const name = `${sub.replace(/[^a-z0-9]/gi, '_') || 'root'}-${cjs ? 'cjs' : 'esm'}`
        const r = probe(consumer, name, specifier, cjs)
        if (!r.ok) {
          check(false, `imports: ${label}`, r.output)
          continue
        }
        results.set(label, r)
        check(true, `imports: ${label}`)
        const missing = expected.names.filter((n) => !r.names.includes(n))
        check(
          missing.length === 0,
          `exports the right names: ${label}`,
          missing.length ? `missing: ${missing.join(', ')} — got ${r.names.length} names` : '',
        )
      }

      // ESM and CJS must present the same surface. A mismatch is an interop bug
      // that no test against `src/` can see, because `src/` has one format.
      const esm = results.get(`${specifier} (ESM import)`)
      const cjsr = results.get(`${specifier} (CJS require)`)
      if (esm && cjsr) {
        const only = (a: readonly string[], b: readonly string[]) => a.filter((n) => !b.includes(n))
        const diff = [
          ...only(esm.names, cjsr.names).map((n) => `+esm ${n}`),
          ...only(cjsr.names, esm.names).map((n) => `+cjs ${n}`),
        ]
        check(
          diff.length === 0,
          `ESM and CJS agree on the export surface: ${specifier}`,
          diff.slice(0, 12).join(', '),
        )
      }
    }

    /* 3 ── the documented side-effect boundary ───────────────────────────── */

    section('side-effect boundary — package.json marks only the main entry')
    for (const [sub, expected] of Object.entries(EXPECTED)) {
      const specifier = sub === '.' ? pkg.name : `${pkg.name}/${sub.slice(2)}`
      for (const fmt of ['ESM import', 'CJS require']) {
        const r = results.get(`${specifier} (${fmt})`)
        if (!r) continue
        check(
          r.patched === expected.patches,
          expected.patches
            ? `${specifier} (${fmt}) installs the WebTransport hook at module-eval`
            : `${specifier} (${fmt}) leaves globalThis.WebTransport alone`,
          r.patched === expected.patches
            ? ''
            : expected.patches
              ? 'Importing the main entry installs the dormant hook, and the ' +
                'sideEffects allowlist is written on that promise. It did not fire.'
              : 'A draft entry patched a global. Both draft entries document "no module-eval ' +
                'side effect", and package.json omits them from sideEffects — so a bundler is ' +
                'free to tree-shake away a patch a consumer is now relying on.',
        )
        if (expected.patches) {
          check(r.stillFunction, `${specifier} (${fmt}) leaves a constructible WebTransport behind`)
        }
      }
    }

    /* 4 ── the emitted declarations, consumed from outside ───────────────── */

    section('declarations — typechecked in a program containing none of this package’s source')
    typecheck(consumer)

    /* ── verdict ─────────────────────────────────────────────────────────── */

    process.stdout.write(`\n${checks} checks, ${failures.length} failed\n`)
    if (failures.length > 0) {
      process.stdout.write('\nfailures:\n')
      for (const f of failures) process.stdout.write(`  - ${f}\n`)
      process.exitCode = 1
    }
  } finally {
    if (keep) process.stdout.write(`\nfixture kept at ${root}\n`)
    else rmSync(root, { recursive: true, force: true })
  }
}

/**
 * `dist/` must contain exactly what tsup emitted, and nothing else.
 *
 * **Two tools write to this directory.** `tsup` owns it (`outDir: 'dist'`,
 * `clean: true`) and `tsconfig.json` also points `outDir` at it, so
 * `bun run typecheck` — `tsc --build` from the repo root — emits a second,
 * *unbundled* compilation on top: `dist/api/*.js`, `dist/**\/*.d.ts` and, because
 * `tsconfig.base.json` sets `declarationMap` and `sourceMap`, a `.map` beside
 * each. Whichever ran last wins, file by file.
 *
 * That is not cosmetic. `tsc`'s `dist/index.js` is `src/index.ts` compiled
 * alone, so it carries `import { … } from './api/dormant.js'`, and `tsc --build`
 * is incremental: on a warm tree it rewrites only the entries whose sources
 * changed and leaves the imports dangling. `files: ["dist"]` then ships the
 * result. `.npmignore` and the `files` negations keep the debris out of the
 * tarball; nothing but running the build last keeps `dist/index.js` correct, and
 * this check is what notices when it was not. The workflows order `typecheck`
 * before `build`; a developer running them the other way round has no such luck.
 */
function distIsOnlyTheBuild(): void {
  const dist = join(PKG, 'dist')
  // Files only, and nested ones at that. tsup's `clean` empties the directory
  // tree without removing the directories, so a bare `dist/api/` left over from
  // an earlier `tsc --build` is harmless — npm does not pack empty directories
  // — and failing on it would make this check cry wolf on every warm tree.
  const nested: string[] = []
  const maps: string[] = []
  const walk = (dir: string, prefix: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name
      if (e.isDirectory()) walk(join(dir, e.name), rel)
      else if (prefix) nested.push(rel)
      else if (e.name.endsWith('.map')) maps.push(rel)
    }
  }
  walk(dist, '')
  const advice =
    'tsup emits a flat dist/ and sets sourcemap: false, so this is `tsc --build` output ' +
    'on top of it — packages/collector/tsconfig.json points outDir at the same directory. ' +
    'Re-run `bun run build`, and keep it after `typecheck`. See distIsOnlyTheBuild().'
  check(
    nested.length === 0,
    'dist/ holds no nested compilation',
    nested.length
      ? `${nested.slice(0, 6).join(', ')}${nested.length > 6 ? `, +${nested.length - 6} more` : ''} — ${advice}`
      : '',
  )
  check(
    maps.length === 0,
    'dist/ holds no .map files',
    maps.length ? `${maps.slice(0, 6).join(', ')} — ${advice}` : '',
  )
}

/**
 * Compile a tiny consumer against the built `.d.ts`.
 *
 * `module: nodenext` rather than the repo's `bundler`, on purpose: `bundler`
 * resolution ignores the ESM/CJS distinction entirely, so it would resolve the
 * `types` condition and never ask whether the declaration it found matches the
 * format the consumer is in. Half of what can go wrong with a dual-format
 * package is invisible under `bundler`.
 *
 * `skipLibCheck: false`, also on purpose: the *point* is to check the emitted
 * declarations themselves, not merely that they resolve.
 */
function typecheck(consumer: string): void {
  writeFileSync(
    join(consumer, 'types', 'esm.ts'),
    [
      "import { init, resolveConfig, COLLECTOR_VERSION, NEED } from '@moqtap/collector'",
      "import type { Collector, InitOptions, CollectorConfig, ResolvedConfig } from '@moqtap/collector'",
      "import { adapter as a19, PROTOCOL_STRINGS } from '@moqtap/collector/draft19'",
      "import { adapter as a20, DRAFT20_ADAPTER } from '@moqtap/collector/draft20'",
      "import type { DraftAdapter, Need, SupportedDraft } from '@moqtap/collector/draft20'",
      '',
      '// Exercise the shapes rather than merely naming them. A declaration that',
      '// degraded to `any` on the way out of the build still resolves, still',
      '// imports, and still typechecks anything you write against it — annotating',
      '// every result with the type it is supposed to have is what notices.',
      'export function use(config: CollectorConfig, options: InitOptions): Collector {',
      '  const resolved: ResolvedConfig = resolveConfig(config)',
      '  void resolved',
      '  return init(config, options)',
      '}',
      'export const drafts: readonly SupportedDraft[] = [a19.draft, a20.draft]',
      'export const adapters: readonly DraftAdapter[] = [a19, DRAFT20_ADAPTER]',
      'export const version: string = COLLECTOR_VERSION',
      '// `NEED` is a `unique symbol`, and `Need` is `typeof NEED`. Round-tripping',
      '// it through both names is the check that the symbol survived declaration',
      '// emit as one identity rather than being widened to `symbol` — see types.ts',
      '// notes that a widened one makes every `=== NEED` across the boundary false.',
      'export const need: Need = NEED',
      'export const proto: string = PROTOCOL_STRINGS[20]',
      '',
    ].join('\n'),
  )
  writeFileSync(
    join(consumer, 'types', 'cjs.cts'),
    [
      '// A CommonJS consumer. `.cts` gives this file CJS semantics under nodenext',
      '// regardless of the enclosing package `type`, so TypeScript resolves the',
      '// export map with the `require` condition — the half of a dual-format',
      '// package that an ESM-only consumer never touches.',
      "import collector = require('@moqtap/collector')",
      "import draft20 = require('@moqtap/collector/draft20')",
      'export const v: string = collector.COLLECTOR_VERSION',
      'export const d: number = draft20.adapter.draft',
      '',
    ].join('\n'),
  )
  writeFileSync(
    join(consumer, 'tsconfig.json'),
    `${JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          lib: ['ES2022', 'DOM'],
          module: 'nodenext',
          moduleResolution: 'nodenext',
          strict: true,
          exactOptionalPropertyTypes: true,
          noUncheckedIndexedAccess: true,
          noEmit: true,
          skipLibCheck: false,
          types: [],
        },
        include: ['types'],
      },
      null,
      2,
    )}\n`,
  )

  const require_ = createRequire(join(REPO, 'package.json'))
  const tsc = require_.resolve('typescript/bin/tsc')
  const r = spawnSync(NODE, [tsc, '-p', join(consumer, 'tsconfig.json')], { encoding: 'utf8' })
  const output = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim()
  check(
    r.status === 0,
    'a consumer compiles against the emitted .d.ts (ESM and CJS, nodenext)',
    output.split('\n').slice(0, 25).join('\n'),
  )
}

main()
