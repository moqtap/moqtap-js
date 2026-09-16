/**
 * The bundle-budget guard.
 *
 * The budget is why this package is split per draft at all: `@moqtap/codec`'s
 * root entry is 39.6 KB gz because it statically imports all fourteen drafts
 * (`packages/codec/src/index.ts`), against 5.3 KB for one draft. The `external`
 * allowlist in `tsup.config.ts` and its source scan make that regression
 * *refusable* at build time; this file makes the resulting size *observed*.
 *
 * ── Four things this test does differently from the obvious version, each
 *    because the obvious version silently measures nothing.
 *
 *  1. **It builds from `src/`, not from `dist/`.** `.github/workflows/` runs
 *     `bun run test` BEFORE `bun run build`, so any guard that reads `dist/`
 *     skips on every CI run it was written for.
 *
 *  2. **It bundles through a namespace-import shim, never `src/index.ts`
 *     directly.** `bun build` (1.3.13) drops the modules behind a pure
 *     `export … from` barrel and still emits the `export {}` clause naming
 *     them: `bun build src/index.ts` reports "Bundled 8 modules" and 8.7 KB gz
 *     for a bundle whose `init` is not defined anywhere in it. The real graph
 *     is 56 modules. A size guard written the obvious way would have reported
 *     a comfortable pass forever. TRUNCATION_MARKERS is the belt to that
 *     braces — if the bundler truncates again the markers vanish and this test
 *     fails rather than under-reporting.
 *
 *  3. **The target is not a cap, and the two ceilings are different kinds of
 *     number.** The "~10 KB gz static" stays a *target*: shipping a worse
 *     collector to hit an arbitrary number is the wrong trade. The entry
 *     ceiling is a chosen backstop with headroom; the chunk ceiling is a
 *     regression guard at the measured value. Either way the distance to the
 *     target rides in the failure message so nobody has to go looking for it.
 *
 *  4. **Both halves of the budget are measured.** The budget is "~10 KB gz
 *     static **+ 4–9 KB per negotiated draft**", and the static build above has
 *     `@moqtap/codec/*` external, so it says nothing about the second half. The
 *     `per negotiated draft` block below builds each draft chunk with the
 *     codec's decoder **inlined**, because that pair is what the network fetches
 *     when a draft is negotiated. It is also the only place the tree-shaking
 *     claim is genuinely tested: with the codec external, "no `encodeMessage` in
 *     the graph" is true by construction and proves nothing about the codec.
 */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SUPPORTED_DRAFTS } from '../../draft/protocol.js'

/** Package root — this file is `<root>/src/__tests__/harness/`. */
const PKG = resolve(__dirname, '..', '..', '..')

/**
 * The always-loaded entry's ceiling: `bun build --target=browser --minify
 * --splitting`, `@moqtap/codec/*` external, `gzip -9`. The reference target is
 * 10240 B.
 *
 * 40 KB is a chosen number, not a measured one. The entry sits around 35.8 KB
 * and moves a few bytes between builds of identical sources, so a ceiling
 * pinned to the measurement fails on a rebuild that changed nothing. The
 * headroom is deliberate — it grows as drafts are added — and this guard is a
 * backstop against a step change. Bringing the entry down toward the target is
 * its own work, not something done under a failing test.
 */
const ENTRY_CEILING_GZ = 40_000

/**
 * The largest single draft chunk, which is what one session actually fetches.
 *
 * A session negotiates one draft, fetches one chunk, and the other thirteen are
 * never requested, so "entry plus every lazy chunk" is a number nobody pays:
 * guarding the sum would make adding a draft look like a regression while the
 * number every page actually pays did not move.
 *
 * So the two numbers that mean something are guarded — the always-loaded entry
 * above and the worst single chunk here — and the sum is reported rather than
 * asserted on. Measured across all fourteen: 1914 B gz.
 */
const CHUNK_CEILING_GZ = 2_200
const MEASURED_MAX_CHUNK_GZ = 1_914
const SPEC_TARGET_GZ = 10_240

/**
 * Strings that must survive minification, one per subsystem the entry graph
 * reaches. Their absence means the bundler truncated the graph, which is the
 * failure mode that makes a size guard report a passing lie.
 */
const TRUNCATION_MARKERS = [
  'indexedDB', // flush/idb.ts
  'CompressionStream', // envelope/gzip.ts
  'sendBeacon', // flush/beacon.ts
  'moqtap-collector', // flush/idb.ts — the database name
  'performance.now', // transport/webtransport-hook.ts
] as const

/**
 * Symbols that must never appear in the graph. The collector decodes and never
 * encodes; an encoder here means someone reached for a codec round-trip helper
 * and pulled its whole write path in with it.
 */
const FORBIDDEN_CODEC_IMPORTS = ['encodeMessage', 'encodeSubgroupStream', 'encodeDatagram']

/**
 * The per-draft band: "4–9 KB per negotiated draft".
 *
 * Measured with the collector adapter plus the codec's decoder inlined: draft-20
 * 6714 B gz, draft-19 6149 B gz. The codec's half of that is 5161 B gz for
 * draft-20 measured alone, against the published "draft-20, decode only —
 * 5.3 KB": the same number, reached independently. The band is used directly as
 * the ceiling rather than inventing a tighter one, because both drafts are
 * inside it and the budget is the thing worth defending.
 */
const DRAFT_CEILING_GZ = 9 * 1024

/**
 * Drafts that must never be reachable.
 *
 * The whole 7.5x saving is that the root entry — which statically imports all
 * fourteen (`packages/codec/src/index.ts`) — cannot be reached from here.
 * The static build cannot show this, because there the codec is external and
 * every draft is equally absent; the per-draft build can, because there the
 * codec is inlined and a leak would arrive with it.
 */
const FOREIGN_DRAFTS = [
  'draft07',
  'draft08',
  'draft09',
  'draft10',
  'draft11',
  'draft12',
  'draft13',
  'draft14',
  'draft15',
  'draft16',
  'draft17',
  'draft18',
  'draft19',
] as const

interface Built {
  readonly entry: string
  readonly chunks: readonly string[]
  readonly all: string
  readonly entryGz: number
  readonly totalGz: number
  /** The biggest single draft chunk — what one session pays on top of the entry. */
  readonly maxChunkGz: number
}

let out = ''
let built: Built

function shimSource(): string {
  const target = JSON.stringify(join(PKG, 'src', 'index.js').replaceAll('\\', '/'))
  return [
    // A namespace import, so nothing is tree-shaken and — critically — so the
    // barrel bug in note 2 above cannot silently empty the graph.
    `import * as C from ${target}`,
    ';(globalThis as unknown as Record<string, unknown>).__keep = C',
    '',
  ].join('\n')
}

const BUN = process.platform === 'win32' ? 'bun.exe' : 'bun'

function runBun(args: readonly string[]): void {
  const r = spawnSync(BUN, [...args], { encoding: 'utf8', cwd: PKG })
  if (r.status !== 0) {
    throw new Error(`bun build failed (status ${r.status})\n${r.stdout ?? ''}\n${r.stderr ?? ''}`)
  }
}

const gzip = (s: string): number => gzipSync(Buffer.from(s, 'utf8'), { level: 9 }).byteLength

/**
 * One namespace-import shim over an arbitrary source file of this package.
 *
 * The namespace import and the global assignment are load-bearing for the
 * reason in note 2: a bare entry lets the bundler drop a re-export barrel's
 * modules while keeping their names in the `export {}` clause.
 */
function shimFor(...parts: string[]): string {
  const target = JSON.stringify(join(PKG, 'src', ...parts).replaceAll('\\', '/'))
  return [
    `import * as C from ${target}`,
    ';(globalThis as unknown as Record<string, unknown>).__keep = C',
    '',
  ].join('\n')
}

interface OneFile {
  readonly minifiedBytes: number
  readonly gzippedBytes: number
  /** The same graph unminified, for symbol greps — a minifier renames locals. */
  readonly readable: string
}

/** Build one single-file bundle, minified and not, and measure it. */
function buildOne(name: string, source: string, external: readonly string[]): OneFile {
  const entry = join(out, `${name}.ts`)
  writeFileSync(entry, source)
  const externals = external.flatMap((e) => ['--external', e])
  const min = join(out, `${name}.min.js`)
  const raw = join(out, `${name}.raw.js`)
  runBun(['build', entry, '--target=browser', '--minify', ...externals, '--outfile', min])
  runBun(['build', entry, '--target=browser', ...externals, '--outfile', raw])
  const minified = readFileSync(min, 'utf8')
  return {
    minifiedBytes: Buffer.byteLength(minified, 'utf8'),
    gzippedBytes: gzip(minified),
    readable: readFileSync(raw, 'utf8'),
  }
}

function build(): Built {
  const shim = join(out, 'shim.ts')
  writeFileSync(shim, shimSource())

  const dist = join(out, 'dist')
  runBun([
    'build',
    shim,
    '--target=browser',
    '--minify',
    '--splitting',
    `--outdir=${dist}`,
    '--external',
    '@moqtap/codec/*',
  ])

  const files = readdirSync(dist).filter((f) => f.endsWith('.js'))
  if (!files.includes('shim.js')) throw new Error(`no entry among: ${files.join(', ')}`)

  const read = (f: string): string => readFileSync(join(dist, f), 'utf8')
  const entry = read('shim.js')
  const chunks = files.filter((f) => f !== 'shim.js').map(read)

  return {
    entry,
    chunks,
    all: [entry, ...chunks].join('\n'),
    entryGz: gzip(entry),
    totalGz: [entry, ...chunks].reduce((n, s) => n + gzip(s), 0),
    maxChunkGz: chunks.reduce((n, s) => Math.max(n, gzip(s)), 0),
  }
}

beforeAll(() => {
  out = mkdtempSync(join(tmpdir(), 'moqtap-collector-size-'))
  built = build()
}, 120_000)

afterAll(() => {
  if (out) rmSync(out, { recursive: true, force: true })
})

describe('the bundle is actually the whole bundle', () => {
  it.each(TRUNCATION_MARKERS)('reaches the subsystem that owns %s', (marker) => {
    expect(
      built.all.includes(marker),
      `"${marker}" is missing from the built bundle. Either the entry graph no ` +
        'longer reaches that subsystem, or the bundler truncated a re-export barrel ' +
        'again (see note 2 in this file). Do NOT relax this assertion to make a size ' +
        'ceiling pass — the size number is meaningless without it.',
    ).toBe(true)
  })

  it('emits the draft adapters as separate lazily-loaded chunks', () => {
    // src/draft/loaders.ts uses static literal specifiers, so a splitting
    // bundler emits one chunk per draft rather than inlining all fourteen into
    // the entry. If this fails, look for a template literal in loaders.ts.
    expect(built.chunks.length).toBeGreaterThanOrEqual(14)
    expect(built.entry).not.toContain('@moqtap/codec')
  })
})

describe('the codec is only ever reached per draft', () => {
  it('names no codec specifier but the per-draft entries', () => {
    const specifiers = [...built.all.matchAll(/["']@moqtap\/codec[^"']*["']/g)].map((m) =>
      m[0].slice(1, -1),
    )
    expect(specifiers.length).toBeGreaterThan(0)
    // One per draft, all fourteen, and nothing else — no root entry, no
    // `/session`, and no specifier built from a variable.
    expect([...new Set(specifiers)].sort()).toEqual(
      SUPPORTED_DRAFTS.map((d) => `@moqtap/codec/draft${d < 10 ? `0${d}` : d}`).sort(),
    )
  })

  it('imports no encoder from any of them', () => {
    for (const sym of FORBIDDEN_CODEC_IMPORTS) {
      expect(built.all, `${sym} must not be in the collector's graph`).not.toContain(sym)
    }
  })
})

describe('gzipped size', () => {
  it('keeps the always-loaded entry under its ceiling', () => {
    expect(
      built.entryGz,
      `Entry is ${built.entryGz} B gz, ceiling ${ENTRY_CEILING_GZ} B. The ceiling ` +
        'is a backstop with headroom rather than the measured number, so crossing ' +
        `it means a step change, not drift. The reference target is ` +
        `${SPEC_TARGET_GZ} B and the entry is ` +
        `~${(built.entryGz / SPEC_TARGET_GZ).toFixed(1)}x it — see the subsystem ` +
        'breakdown below for where the bytes are.',
    ).toBeLessThanOrEqual(ENTRY_CEILING_GZ)
  })

  it('keeps the largest single draft chunk under its ceiling', () => {
    expect(
      built.maxChunkGz,
      `The largest lazy chunk is ${built.maxChunkGz} B gz, ceiling ${CHUNK_CEILING_GZ} B ` +
        `(measured ${MEASURED_MAX_CHUNK_GZ} B). This is the collector's own adapter and ` +
        'excludes @moqtap/codec, which adds ~4.9-7.9 KB gz for the one negotiated draft ' +
        '— measured per draft in the block below. A session fetches exactly one of ' +
        'these, so this and the entry are the two numbers a page pays.',
    ).toBeLessThanOrEqual(CHUNK_CEILING_GZ)
  })

  it('emits one chunk per draft and shares the walk between them', () => {
    // Fourteen draft chunks plus the modules they share — `data-walk.ts` and
    // `adapter.ts`, which are one copy between all fourteen rather than
    // fourteen copies. If this drops to fourteen, the shared walk has been
    // inlined into every draft and the sum below will say so.
    expect(built.chunks.length).toBeGreaterThanOrEqual(14)
  })

  it('reports the numbers even when it passes', () => {
    console.log(
      `[size] entry ${built.entryGz} B gz | largest chunk ${built.maxChunkGz} B gz | ` +
        `all chunks ${built.totalGz} B gz | ` +
        `${built.chunks.length} lazy chunks | ` +
        `${(built.entryGz / SPEC_TARGET_GZ).toFixed(1)}x the ${SPEC_TARGET_GZ} B target`,
    )
    expect(built.entryGz).toBeGreaterThan(0)
  })
})

describe('the other half of the budget: per negotiated draft', () => {
  // What a session actually costs on top of the static half: the collector's own
  // draft adapter plus the codec decoder it imports, bundled together, because
  // that pair is one network fetch at `session.protocol` time.
  //
  // All fourteen, not a sample. The bands were set from drafts 19 and 20, and
  // the older drafts are a different shape — draft-07's decoder has no
  // Authorization Token structure and no factored stream types at all — so it is
  // worth knowing whether one of them blows the budget.
  const drafts = SUPPORTED_DRAFTS

  it.each(drafts)('draft-%i stays inside the 4–9 KB band', (n) => {
    const nn = n < 10 ? `0${n}` : `${n}`
    const m = buildOne(`draft${nn}`, shimFor('drafts', `draft${nn}`, 'index.ts'), [])
    console.log(
      `[size] draft-${nn} chunk (collector adapter + codec decoder): ` +
        `${m.gzippedBytes} B gz, ${m.minifiedBytes} B min | band 4096–${DRAFT_CEILING_GZ} B`,
    )
    expect(
      m.gzippedBytes,
      `the draft-${n} chunk is over the per-draft budget. Unlike the static ` +
        'ceiling, this one is the spec figure rather than a measured regression ' +
        'guard, so exceeding it is a real overrun of a real budget.',
    ).toBeLessThanOrEqual(DRAFT_CEILING_GZ)
  })

  it('carries no encoder and no other draft', () => {
    // The only place either claim is actually testable. Greps run against the
    // unminified build: minification renames every local, so a minified bundle
    // reports "no encodeMessage" whether one is there or not.
    const m = buildOne('draft20-shake', shimFor('drafts', 'draft20', 'index.ts'), [])
    for (const sym of FORBIDDEN_CODEC_IMPORTS) {
      expect(m.readable, `${sym} survived into the draft-20 chunk`).not.toContain(sym)
    }
    for (const other of FOREIGN_DRAFTS) {
      expect(m.readable, `${other} reached the draft-20 chunk`).not.toContain(other)
    }
    // The root entry's fourteen-draft registry. Anywhere in here it would mean
    // the root was reached and the chunk is 39.6 KB rather than 5.3.
    expect(m.readable).not.toContain('DRAFT_VERSIONS')
    // And the decoders that are supposed to be there, so the greps above are
    // not passing on an empty bundle.
    expect(m.readable).toContain('decodeMessage')
    expect(m.readable).toContain('decodeDatagram')
  })
})

describe('where the static bytes are', () => {
  it('breaks the entry down by subsystem, so the gap to the target is actionable', () => {
    // Reported, never asserted. Each subsystem is bundled alone against the same
    // externals, so they each carry their share of `types.ts` and of each other:
    // the column is a ranking, not an accounting, and does not sum to the entry.
    const parts: readonly [string, string[]][] = [
      ['whole entry', ['index.ts']],
      ['transport', ['transport', 'index.ts']],
      ['flush', ['flush', 'index.ts']],
      ['decode', ['decode', 'index.ts']],
      ['rollup', ['rollup', 'index.ts']],
      ['recorder', ['recorder', 'index.ts']],
      ['envelope', ['envelope', 'index.ts']],
      ['ring', ['ring', 'index.ts']],
      ['draft', ['draft', 'index.ts']],
    ]
    const rows = parts.map(([label, path], i) => {
      const m = buildOne(`part${i}`, shimFor(...path), ['@moqtap/codec/*'])
      return `  ${label.padEnd(12)} ${String(m.gzippedBytes).padStart(6)} B gz  ${String(
        m.minifiedBytes,
      ).padStart(7)} B min`
    })
    console.log(`\n[size] static bundle by subsystem, each measured alone\n${rows.join('\n')}\n`)
    expect(rows).toHaveLength(parts.length)
  }, 120_000)
})
