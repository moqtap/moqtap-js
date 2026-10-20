/**
 * The bundle-budget guard.
 *
 * The budget is why this package is split per draft at all: `@moqtap/codec`'s
 * root entry is 39.6 KB gz because it statically imports every draft
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
 *  3. **The target is not a cap.** The "~10 KB gz static" stays a *target*:
 *     shipping a worse collector to hit an arbitrary number is the wrong trade.
 *     The entry ceiling is a chosen backstop with headroom, and the distance to
 *     the target rides in the failure message so nobody has to go looking for it.
 *
 *  4. **Both halves of the budget are measured.** The budget is "~10 KB gz
 *     static **+ 4–9 KB per draft**", and the static build above has
 *     `@moqtap/codec/*` external, so it says nothing about the second half. The
 *     `per draft` block below builds each draft with the codec's decoder
 *     **inlined**, and a single-draft entry whole. It is also the only place the
 *     tree-shaking claim is genuinely tested: with the codec external, "no
 *     `encodeMessage` in the graph" is true by construction.
 */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SUPPORTED_DRAFTS } from '../../draft/protocol.js'

/** Package root — this file is `<root>/src/__tests__/harness/`. */
const PKG = resolve(__dirname, '..', '..', '..')

/**
 * The root entry's ceiling: `bun build --target=browser --minify`,
 * `@moqtap/codec/*` external, `gzip -9`. The reference target is 10240 B.
 *
 * 40 KB is a chosen number, not a measured one. The entry, with every draft's
 * adapter, sits around 37.2 KB and moves a few bytes between builds of
 * identical sources. The headroom is deliberate — it grows as drafts are added —
 * and this guard is a backstop against a step change. Bringing the entry down
 * toward the target is its own work, not something done under a failing test.
 */
const ENTRY_CEILING_GZ = 40_000
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
 * The whole 7.5x saving is that the root entry — which statically imports every
 * draft (`packages/codec/src/index.ts`) — cannot be reached from here.
 * The static build cannot show this, because there the codec is external and
 * every draft is equally absent; the per-draft build can, because there the
 * codec is inlined and a leak would arrive with it.
 */
const FOREIGN_DRAFTS: readonly string[] = SUPPORTED_DRAFTS.filter((d) => d !== 20).map(
  (d) => `draft${d < 10 ? `0${d}` : d}`,
)

interface Built {
  readonly all: string
  readonly entryGz: number
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
  const file = join(out, 'shim.js')
  runBun([
    'build',
    shim,
    '--target=browser',
    '--minify',
    `--outfile=${file}`,
    '--external',
    '@moqtap/codec/*',
  ])
  const all = readFileSync(file, 'utf8')
  return { all, entryGz: gzip(all) }
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

  it('loads nothing at runtime', () => {
    // Every decoder is a static import, so a bundle needs no chunk loading:
    // IIFE worker builds and CSPs without chunk loading work unchanged.
    expect(built.all).not.toMatch(/\bimport\(/)
  })
})

describe('the codec is only ever reached per draft', () => {
  it('names no codec specifier but the per-draft entries', () => {
    const specifiers = [...built.all.matchAll(/["']@moqtap\/codec[^"']*["']/g)].map((m) =>
      m[0].slice(1, -1),
    )
    expect(specifiers.length).toBeGreaterThan(0)
    // One per draft, every draft, and nothing else — no root entry, no
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

  it('reports the numbers even when it passes', () => {
    console.log(
      `[size] entry ${built.entryGz} B gz | ` +
        `${(built.entryGz / SPEC_TARGET_GZ).toFixed(1)}x the ${SPEC_TARGET_GZ} B target`,
    )
    expect(built.entryGz).toBeGreaterThan(0)
  })
})

describe('the other half of the budget: per draft', () => {
  // What each draft adds to the static half: the collector's own draft adapter
  // plus the codec decoder it imports, bundled together.
  //
  // Every draft, not a sample. The older drafts are a different shape —
  // draft-07's decoder has no Authorization Token structure and no factored
  // stream types at all — so each one is checked against the budget.
  const drafts = SUPPORTED_DRAFTS

  it.each(drafts)('draft-%i stays inside the 4–9 KB band', (n) => {
    const nn = n < 10 ? `0${n}` : `${n}`
    const m = buildOne(`draft${nn}`, shimFor('drafts', `draft${nn}`, 'index.ts'), [])
    console.log(
      `[size] draft-${nn} (collector adapter + codec decoder): ` +
        `${m.gzippedBytes} B gz, ${m.minifiedBytes} B min | band 4096–${DRAFT_CEILING_GZ} B`,
    )
    expect(
      m.gzippedBytes,
      `draft-${n} is over the per-draft budget. Unlike the static ` +
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
      expect(m.readable, `${sym} survived into draft-20`).not.toContain(sym)
    }
    for (const other of FOREIGN_DRAFTS) {
      expect(m.readable, `${other} reached draft-20`).not.toContain(other)
    }
    // The codec root's every-draft registry. Anywhere in here it would mean
    // the codec root was reached: 39.6 KB rather than 5.3.
    expect(m.readable).not.toContain('DRAFT_VERSIONS')
    // And the decoders that are supposed to be there, so the greps above are
    // not passing on an empty bundle.
    expect(m.readable).toContain('decodeMessage')
    expect(m.readable).toContain('decodeDatagram')
  })

  it('keeps a single-draft entry to the static half plus one draft', () => {
    const m = buildOne('entry20', shimFor('drafts', 'draft20', 'entry.ts'), [])
    console.log(`[size] @moqtap/collector/draft20, whole: ${m.gzippedBytes} B gz`)
    for (const other of FOREIGN_DRAFTS) {
      expect(m.readable, `${other} reached the draft-20 entry`).not.toContain(other)
    }
    expect(m.gzippedBytes).toBeLessThanOrEqual(ENTRY_CEILING_GZ + DRAFT_CEILING_GZ)
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
