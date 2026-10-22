/**
 * The bundle guard: every published entry carries what it names and nothing
 * else.
 *
 * A multi-draft collector is only cheap if a page downloads the drafts and
 * features it imports and no others. So each entry is built the way a page
 * builds it — `import { init } from '<entry>'`, the codec inlined — and checked
 * three ways: the features it carries are in the bundle, the features it does
 * not carry are not, and the whole is under its tier's ceiling.
 *
 * ── Three things this test does differently from the obvious version, each
 *    because the obvious version silently measures nothing.
 *
 *  1. **It builds from `src/`, not from `dist/`.** CI runs `bun run test`
 *     BEFORE `bun run build`, so any guard that reads `dist/` skips on every
 *     run it was written for.
 *
 *  2. **Presence is asserted as well as absence.** `bun build` (1.3.13) drops
 *     the modules behind a pure `export … from` barrel when that barrel is the
 *     entry, and still emits the names, so a truncated graph is small and
 *     contains nothing. Every build here must contain the markers of what it
 *     carries, which a truncated one cannot.
 *
 *  3. **Absence is grepped in the unminified build** where the check is a
 *     name, since a minifier renames locals; string markers survive either way.
 */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SUPPORTED_DRAFTS } from '../../draft/protocol.js'

/** Package root — this file is `<root>/src/__tests__/harness/`. */
const PKG = resolve(__dirname, '..', '..', '..')

/**
 * One string per optional part, found in a minified bundle exactly when the
 * part is in it.
 */
const MARKERS = {
  /** `api/observation.ts` and what it reaches: the `WebTransport` hook. */
  hook: 'incomingUnidirectionalStreams',
  /** `features/workers.ts` in a page; `api/link.ts` in a worker. */
  workers: '__moqtap_collector__',
  persistence: 'indexedDB',
  /** The `flight` record the recorder's dump writes. */
  flightRecorder: 't:"flight"',
  /** The ceiling cause only the escalation controller writes. */
  escalation: 'kind:"ceiling"',
  /** Customer metric codes, from `rollup/custom-metrics.ts`. */
  customMetrics: 'MQ4001',
} as const

type Part = keyof typeof MARKERS

const PAGE_FEATURES: readonly Part[] = [
  'workers',
  'persistence',
  'flightRecorder',
  'escalation',
  'customMetrics',
]

/** Strings from the page runtime. A worker entry that holds one carries code a worker never runs. */
const PAGE_ONLY = [
  'sendBeacon', // flush/beacon.ts
  'retry-after', // flush/uploader.ts
  '1116352408', // envelope/sha256.ts — the first round constant, 0x428a2f98
  'pagehide', // api/session.ts
  'indexedDB', // flush/idb.ts
] as const

/** Strings every worker entry reaches. */
const WORKER_ALWAYS = [
  '__moqtap_collector__', // api/link.ts
  'CompressionStream', // envelope/gzip.ts, the probe's compressor
  'incomingUnidirectionalStreams', // the hook
] as const

/**
 * The collector decodes and never encodes; an encoder here means someone
 * reached for a codec round-trip helper and pulled its write path in with it.
 */
const FORBIDDEN_CODEC_IMPORTS = ['encodeMessage', 'encodeSubgroupStream', 'encodeDatagram']

/**
 * Ceilings, gzipped, per tier. Chosen backstops a little above the measured
 * sizes, so crossing one means a step change rather than drift. A draft entry
 * is checked for every draft against its tier's one ceiling.
 */
const CEILING_GZ = {
  /** `.`: every draft, every feature. */
  root: 69_500,
  /** `./draftNN`: one draft, every feature. */
  draft: 51_000,
  /** `./draftNN/thin`: one draft, no optional feature. */
  thin: 42_000,
  /** `compose({ features: [workers] })`: a page whose transports live in its workers. */
  linked: 18_500,
  /**
   * `compose({ features: [workers, escalation, persistence] })` built for
   * es2019 and es2020, where `#` members cost WeakMap helpers.
   */
  es2019: 22_500,
  es2020: 21_500,
  /** `./worker`: every draft and the flight recorder. */
  worker: 56_000,
  /** `./draftNN/worker`. */
  draftWorker: 34_500,
  /** `./draftNN/thin/worker`. */
  thinWorker: 30_500,
} as const

/**
 * What each draft adds: the collector's adapter plus the codec decoder it
 * imports, "4–9 KB per negotiated draft".
 */
const DRAFT_CEILING_GZ = 9 * 1024

const nn = (d: number): string => (d < 10 ? `0${d}` : `${d}`)
const DRAFTS = SUPPORTED_DRAFTS.map(nn)
const src = (...parts: string[]): string =>
  JSON.stringify(join(PKG, 'src', ...parts).replaceAll('\\', '/'))

let out = ''

/**
 * Shorten `_`-prefixed members as the published build does (`mangleProps` in
 * `tsup.config.ts`). `bun build` has no such option, so without this every
 * internal member would be measured at its full source-length name.
 */
const MANGLED = new RegExp(
  /mangleProps = \/(.+)\/$/m.exec(readFileSync(join(PKG, 'tsup.config.ts'), 'utf8'))?.[1] ?? '(?!)',
)
const esbuild = createRequire(createRequire(join(PKG, 'package.json')).resolve('tsup'))(
  'esbuild',
) as {
  transformSync(code: string, o: Record<string, unknown>): { code: string }
  build(o: Record<string, unknown>): Promise<{ outputFiles?: { text: string }[] }>
}
const shorten = (code: string): string =>
  esbuild.transformSync(code, { mangleProps: MANGLED, minifyWhitespace: true }).code

const BUN = process.platform === 'win32' ? 'bun.exe' : 'bun'

function runBun(args: readonly string[]): void {
  const r = spawnSync(BUN, [...args], { encoding: 'utf8', cwd: PKG })
  if (r.status !== 0) {
    throw new Error(`bun build failed (status ${r.status})\n${r.stdout ?? ''}\n${r.stderr ?? ''}`)
  }
}

const gzip = (s: string): number => gzipSync(Buffer.from(s, 'utf8'), { level: 9 }).byteLength

interface Built {
  readonly min: string
  readonly gz: number
  /** The same graph unminified, for name greps. */
  readonly readable: string
}

/** Bundle `source` as a page would, everything inlined, minified and not. */
function bundle(name: string, source: string): Built {
  const entry = join(out, `${name}.ts`)
  writeFileSync(entry, source)
  const min = join(out, `${name}.min.js`)
  const raw = join(out, `${name}.raw.js`)
  runBun(['build', entry, '--target=browser', '--minify', '--outfile', min])
  runBun(['build', entry, '--target=browser', '--outfile', raw])
  const code = shorten(readFileSync(min, 'utf8'))
  return { min: code, gz: gzip(code), readable: readFileSync(raw, 'utf8') }
}

/** A page that imports one name from one entry and keeps it. */
function consumer(name: string, from: string): string {
  return [
    `import { ${name} as C } from ${from}`,
    ';(globalThis as unknown as Record<string, unknown>).__keep = C',
    '',
  ].join('\n')
}

/** The draft directories a readable bundle reaches. */
function draftsIn(readable: string): string[] {
  const found = new Set<string>()
  for (const m of readable.matchAll(/drafts[\\/]draft(\d\d)[\\/]/g)) found.add(m[1] as string)
  return [...found].sort()
}

function expectParts(b: Built, label: string, carries: readonly Part[]): void {
  for (const part of PAGE_FEATURES) {
    const marker = MARKERS[part]
    if (carries.includes(part)) {
      expect(b.min, `${label} must carry ${part} ("${marker}" is missing)`).toContain(marker)
    } else {
      expect(b.min, `${label} must not carry ${part} ("${marker}" reached it)`).not.toContain(
        marker,
      )
    }
  }
}

beforeAll(() => {
  out = mkdtempSync(join(tmpdir(), 'moqtap-collector-size-'))
}, 120_000)

afterAll(() => {
  if (out) rmSync(out, { recursive: true, force: true })
})

const sizes: string[] = []
afterAll(() => {
  if (sizes.length > 0) console.log(`\n[size] gzipped, as a page imports it\n${sizes.join('\n')}\n`)
})

describe('the root entry: every draft, every feature', () => {
  let b: Built
  beforeAll(() => {
    b = bundle('root', consumer('init', src('index.ts')))
    sizes.push(`  .                        ${b.gz} B`)
  }, 120_000)

  it('carries every feature and the hook', () => {
    expectParts(b, '.', PAGE_FEATURES)
    expect(b.min).toContain(MARKERS.hook)
  })

  it('carries every draft', () => {
    expect(draftsIn(b.readable)).toEqual([...DRAFTS].sort())
  })

  it('imports no encoder and loads nothing at runtime', () => {
    for (const sym of FORBIDDEN_CODEC_IMPORTS) expect(b.readable).not.toContain(sym)
    // Every decoder is a static import, so a bundle needs no chunk loading:
    // IIFE worker builds and CSPs without chunk loading work unchanged.
    expect(b.min).not.toMatch(/\bimport\(/)
  })

  it('stays under its ceiling', () => {
    expect(b.gz).toBeLessThanOrEqual(CEILING_GZ.root)
  })
})

describe('a page whose transports live in its workers', () => {
  let b: Built
  beforeAll(() => {
    b = bundle(
      'linked',
      [
        `import { compose } from ${src('compose.ts')}`,
        `import { workers } from ${src('features', 'index.ts')}`,
        ';(globalThis as unknown as Record<string, unknown>).__keep = compose({ features: [workers] })',
        '',
      ].join('\n'),
    )
    sizes.push(`  compose({ workers })      ${b.gz} B`)
  }, 120_000)

  it('carries the links and no hook, decoder or codec', () => {
    expectParts(b, 'compose({ workers })', ['workers'])
    expect(b.min).not.toContain(MARKERS.hook)
    expect(draftsIn(b.readable)).toEqual([])
    expect(b.readable).not.toContain('decodeMessage')
    expect(b.min).toContain('pagehide')
  })

  it('stays under its ceiling', () => {
    expect(b.gz).toBeLessThanOrEqual(CEILING_GZ.linked)
  })
})

/**
 * A page built for browsers without class private fields, through esbuild
 * (the bundler tsup itself uses) with the package's own property mangling.
 * Each `#` member such a target sees is rewritten into a WeakMap helper,
 * so a `#` member added to internal code shows up here as a step in size.
 */
describe('a page built for older browsers', () => {
  it.each([
    ['es2019', CEILING_GZ.es2019],
    ['es2020', CEILING_GZ.es2020],
  ] as const)(
    '%s stays under its ceiling',
    async (target, ceiling) => {
      expect(MANGLED.source, 'tsup.config.ts must set mangleProps').not.toBe('(?!)')
      const r = await esbuild.build({
        stdin: {
          contents: [
            `import { compose } from ${src('compose.ts')}`,
            `import { escalation, persistence, workers } from ${src('features', 'index.ts')}`,
            ';(globalThis as unknown as Record<string, unknown>).__keep =',
            '  compose({ features: [workers, escalation, persistence] })',
            '',
          ].join('\n'),
          loader: 'ts',
          resolveDir: PKG,
        },
        bundle: true,
        minify: true,
        format: 'esm',
        target,
        mangleProps: MANGLED,
        write: false,
        logLevel: 'silent',
      })
      const gz = gzip(r.outputFiles?.[0]?.text ?? '')
      sizes.push(`  ${target} composition       ${gz} B`)
      expect(gz).toBeLessThanOrEqual(ceiling)
    },
    120_000,
  )
})

describe.each(DRAFTS)('draft %s', (d) => {
  const at = (...f: string[]): string => src('drafts', `draft${d}`, ...f)
  const tiers = [
    ['', 'init', 'entry.ts', CEILING_GZ.draft, PAGE_FEATURES],
    ['/thin', 'init', 'thin.ts', CEILING_GZ.thin, []],
    ['/worker', 'initWorker', 'worker.ts', CEILING_GZ.draftWorker, ['flightRecorder']],
    ['/thin/worker', 'initWorker', 'thin-worker.ts', CEILING_GZ.thinWorker, []],
  ] as const

  it.each(tiers)(
    `./draft${d}%s carries its draft and its features, no others`,
    (path, name, file, ceiling, carries) => {
      const label = `./draft${d}${path}`
      const b = bundle(`d${d}${path.replaceAll('/', '-')}`, consumer(name, at(file)))
      sizes.push(`  ${label.padEnd(24)} ${b.gz} B`)
      expect(draftsIn(b.readable), `${label} reached another draft`).toEqual([d])
      for (const sym of FORBIDDEN_CODEC_IMPORTS) expect(b.readable).not.toContain(sym)
      expect(b.min).toContain(MARKERS.hook)
      if (name === 'init') {
        expectParts(b, label, carries)
      } else {
        for (const marker of WORKER_ALWAYS) {
          expect(b.min, `"${marker}" is missing from ${label}`).toContain(marker)
        }
        for (const marker of PAGE_ONLY) {
          expect(b.min, `"${marker}" is page code and reached ${label}`).not.toContain(marker)
        }
        // A worker never escalates: the page owns the capture window.
        expect(b.min).not.toContain(MARKERS.escalation)
        const recorder = (carries as readonly Part[]).includes('flightRecorder')
        expect(b.min.includes(MARKERS.flightRecorder), `${label}: flight recorder`).toBe(recorder)
      }
      expect(b.gz, `${label} is ${b.gz} B gz, ceiling ${ceiling} B`).toBeLessThanOrEqual(ceiling)
    },
    120_000,
  )

  it(`adds no more than ${DRAFT_CEILING_GZ} B gz: the adapter and the codec's decoder`, () => {
    const b = bundle(
      `adapter${d}`,
      [
        `import * as C from ${at('index.ts')}`,
        ';(globalThis as unknown as Record<string, unknown>).__keep = C',
        '',
      ].join('\n'),
    )
    expect(b.readable).toContain('decodeMessage')
    // The codec root's every-draft registry: reaching it costs every draft.
    expect(b.readable).not.toContain('DRAFT_VERSIONS')
    expect(b.gz).toBeLessThanOrEqual(DRAFT_CEILING_GZ)
  })
})

describe('the worker entry: every draft and the flight recorder', () => {
  it('carries no page code and stays under its ceiling', () => {
    const b = bundle('worker', consumer('initWorker', src('worker.ts')))
    sizes.push(`  ./worker                 ${b.gz} B`)
    for (const marker of WORKER_ALWAYS) expect(b.min).toContain(marker)
    for (const marker of PAGE_ONLY) expect(b.min).not.toContain(marker)
    expect(b.min).toContain(MARKERS.flightRecorder)
    expect(draftsIn(b.readable)).toEqual([...DRAFTS].sort())
    expect(b.gz).toBeLessThanOrEqual(CEILING_GZ.worker)
  }, 120_000)
})
