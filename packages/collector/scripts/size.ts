/**
 * `bun run size` — the standing bundle-size measurement.
 *
 * **No hard cap.** 10 KB gz was drawn before anything was built: a target worth
 * keeping in view, not a limit worth shipping a worse collector to hit. What is
 * not optional is measuring it, as a standing dev-loop metric rather than a
 * release-time audit, so a change that moves the number is visible in the diff
 * that caused it. This script never fails on a number: it prints one every time,
 * in the units the budget is stated in, and CI diffs it against the base branch.
 *
 * ── Why this exists next to `src/__tests__/harness/bundle-size.test.ts`
 *
 * That test is a *regression guard*: ceilings, assertions, a red suite when the
 * number moves past them. The right shape for "don't let this get worse by
 * accident" and the wrong shape for a dev loop — a ceiling only speaks when it
 * is breached, tells you nothing about the 900 bytes you added last week, and
 * cannot be run for a number without running a test suite. This script is the
 * other half: no ceilings, no assertions, no exit code that depends on the
 * measurement.
 *
 * ── Method, matching that test so the numbers stay comparable
 *
 * `bun build --target=browser --minify`, then `gzip -9`, measured **from
 * TypeScript source, not from `dist/`**: the published per-draft files are thin
 * re-exports over shared chunks (`dist/draft19.js` is 297 bytes of `import`
 * lines) and measure nothing alone. It also runs without a build, which is what
 * lets it sit in a dev loop.
 *
 * Two details, either of which silently under-reports if it is got wrong:
 *
 *  1. **Everything is bundled through a namespace-import shim.** `bun build`
 *     (1.3.13) drops the modules behind a pure `export … from` barrel while
 *     still emitting the `export {}` clause naming them — `bun build
 *     src/index.ts` reports 8 modules and 8.7 KB gz for a bundle whose `init`
 *     is not defined anywhere in it. A namespace import plus a global
 *     assignment keeps the graph whole.
 *  2. **The static entry is measured with `@moqtap/codec/*` external; the draft
 *     entries are measured with it inlined.** That asymmetry is the budget
 *     shape — "~10 KB gz static + 4–9 KB per negotiated draft" — not an
 *     oversight. The draft chunk plus its codec decoder is one network fetch at
 * `session.protocol` time, so they are weighed together.
 *
 * ── Usage
 *
 *   bun run size                        human-readable table
 *   bun run size --json                 machine-readable, for CI
 *   bun run size --json --out f.json    …written to a file as well as stdout
 *   bun run size --compare base.json    the same table with deltas
 *   bun run size --compare base.json --markdown   …as a PR comment
 *   bun run size --from head.json       re-render an earlier run, measuring nothing
 *
 * `--from` is there for CI, which wants the same measurement in three shapes —
 * JSON to keep, a table for the log, markdown for the PR — and should not pay
 * for twenty `bun build` invocations three times to get them.
 */

import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

/** Package root — this file is `<root>/scripts/`. */
const PKG = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const BUN = process.platform === 'win32' ? 'bun.exe' : 'bun'

/** The fourteen drafts, zero-padded as the entry points and the codec spell them. */
const DRAFTS = [
  '07',
  '08',
  '09',
  '10',
  '11',
  '12',
  '13',
  '14',
  '15',
  '16',
  '17',
  '18',
  '19',
  '20',
] as const

/**
 * The published entry points, from `package.json`'s `exports` map.
 *
 * `.` is measured against `src/index.ts` with the codec external — the static
 * half of the budget, "everything `init()` reaches".
 *
 * `./draftNN` is measured against its published `entry.ts` with the codec
 * **inlined**, because that pair is one network fetch at `session.protocol`
 * time. The published entry adds `PROTOCOL_STRINGS` and a type-only re-export
 * on top of `drafts/draftNN/index.ts`, which is a two-figure number of bytes;
 * measuring what is actually published is worth that much drift, and the drift
 * is named here so nobody re-derives it.
 *
 * **Read the per-draft rows as alternatives, never as a sum.** A session
 * negotiates one draft and fetches one of them. Adding them up describes a
 * consumer who imports all fourteen entry points by hand, which is not a thing
 * anyone does and not a number anyone pays.
 */
const ENTRIES = [
  {
    id: '.',
    label: 'static entry — everything init() reaches',
    parts: ['index.ts'] as readonly string[],
    external: ['@moqtap/codec/*'] as readonly string[],
    /** Only the main entry is split: the draft adapters are its lazy chunks. */
    split: true,
  },
  ...DRAFTS.map((nn) => ({
    id: `./draft${nn}`,
    label: `draft-${nn} entry (collector adapter + codec decoder)`,
    parts: ['drafts', `draft${nn}`, 'entry.ts'] as readonly string[],
    external: [] as readonly string[],
    split: false,
  })),
] as const

/**
 * Labels for the per-subsystem table. Anything measured but unlabelled is
 * reported under its own directory name, so a new directory shows up on its own
 * rather than waiting for someone to add it here.
 */
const SUBSYSTEM_LABELS: Readonly<Record<string, string>> = {
  api: 'api — config, lifecycle, session runtime, metering',
  flush: 'flush — batching, gzip, uploader, IndexedDB',
  decode: 'decode — the counting decoder and its adapters',
  rollup: 'rollup',
  transport: 'transport — the WebTransport seam',
  draft: 'draft — loader and negotiation',
  drafts: 'drafts — the per-draft adapters (lazy chunks)',
  recorder: 'recorder — the flight recorder',
  envelope: 'envelope — framing and records',
  ring: 'ring',
  '(bundler)': '(bundler runtime, chunk glue, and unmapped output)',
}

/** The reference target for the static entry. Reported, never enforced. */
const SPEC_TARGET_GZ = 10_240

interface Measure {
  readonly gz: number
  readonly min: number
}

interface EntryMeasure extends Measure {
  readonly label: string
  /** Split entries only: the entry plus every lazy chunk it emits. */
  readonly chunks?: number
  readonly totalGz?: number
  readonly totalMin?: number
  /**
   * The largest single lazy chunk.
   *
   * The number a page actually pays on top of the entry, because a session
   * negotiates one draft and fetches one chunk. {@link totalGz} is the sum of
   * all fourteen plus what they share, which nothing downloads — it is reported
   * because a jump in it means a shared module stopped being shared, and for no
   * other reason.
   */
  readonly maxChunkGz?: number
}

interface Report {
  readonly schema: 2
  readonly package: string
  readonly generatedAt: string
  readonly bun: string
  readonly method: string
  readonly specTargetGz: number
  readonly entries: Record<string, EntryMeasure>
  readonly subsystems: Record<string, Measure & { readonly label: string }>
}

/** Baselines written by an older, incompatible layout are ignored, not merged. */
const SCHEMA = 2

/* ── measurement ─────────────────────────────────────────────────────────── */

const gz = (s: string): number => gzipSync(Buffer.from(s, 'utf8'), { level: 9 }).byteLength
const bytes = (s: string): number => Buffer.byteLength(s, 'utf8')

function runBun(args: readonly string[]): void {
  const r = spawnSync(BUN, [...args], { encoding: 'utf8', cwd: PKG })
  if (r.status !== 0) {
    throw new Error(`bun build failed (status ${r.status})\n${r.stdout ?? ''}\n${r.stderr ?? ''}`)
  }
}

/**
 * A namespace import over one source file, kept alive by a global assignment.
 *
 * Both halves are load-bearing. Without the namespace import the bundler is
 * free to drop the modules behind a re-export barrel while keeping their names
 * in the `export {}` clause; without the assignment it is free to drop the
 * namespace. Either way the number that comes back is a comfortable lie.
 */
function shimFor(...parts: readonly string[]): string {
  const target = JSON.stringify(join(PKG, 'src', ...parts).replaceAll('\\', '/'))
  return [
    `import * as C from ${target}`,
    ';(globalThis as unknown as Record<string, unknown>).__keep = C',
    '',
  ].join('\n')
}

/* ── attribution ─────────────────────────────────────────────────────────── */

/**
 * Where the bytes are, taken from the build's own sourcemaps.
 *
 * One build, with sourcemaps, and every output byte charged to the source file
 * the mapping names: rows are exclusive, they sum to the entry, and shared code
 * is charged once, to whichever module the bundler actually emitted it in.
 *
 * Not the obvious alternative — bundling each subsystem alone and ranking the
 * results. That cannot sum, and cannot see `api/` at all, which has no barrel to
 * point at: bundled alone, `api/` measures 35.5 KB against a 33.2 KB entry,
 * since it transitively imports nearly everything. A row larger than the whole
 * bundle is not a ranking, it is a trap.
 */
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const B64_INDEX = new Map<string, number>([...B64].map((c, i) => [c, i]))

/** One VLQ-encoded mapping segment to its signed fields. */
function decodeVlq(segment: string): number[] {
  const out: number[] = []
  let shift = 0
  let value = 0
  for (const ch of segment) {
    const digit = B64_INDEX.get(ch)
    if (digit === undefined) throw new Error(`bad base64-vlq digit ${JSON.stringify(ch)}`)
    value += (digit & 31) << shift
    if ((digit & 32) !== 0) {
      shift += 5
      continue
    }
    const negative = (value & 1) === 1
    value >>= 1
    out.push(negative ? -value : value)
    shift = 0
    value = 0
  }
  return out
}

interface SourceMap {
  readonly sources: readonly string[]
  readonly mappings: string
}

/** A half-open `[start, end)` span of one output file. */
interface Range {
  readonly start: number
  readonly end: number
}

/**
 * Output byte-ranges per source file, for one output file.
 *
 * A mapping segment owns the output from its own column up to the next
 * segment's column, or to the end of the line. Output covered by no segment —
 * the bundler's own prelude, chunk glue, `__toESM` helpers — is charged to
 * `(bundler)` rather than silently dropped, so the rows still sum.
 *
 * Ranges rather than counts, because the gzip column needs to splice a
 * subsystem out of the bundle and re-compress what is left.
 */
function attributeRanges(code: string, map: SourceMap): Map<string, Range[]> {
  const lineStarts = [0]
  for (let i = 0; i < code.length; i++) if (code[i] === '\n') lineStarts.push(i + 1)

  const perLine = new Map<number, { col: number; src: number }[]>()
  let src = 0
  const rows = map.mappings.split(';')
  for (let line = 0; line < rows.length; line++) {
    const row = rows[line]
    if (!row) continue
    let col = 0
    for (const raw of row.split(',')) {
      if (!raw) continue
      const fields = decodeVlq(raw)
      col += fields[0] ?? 0
      // A one-field segment carries a generated column and no source; it marks
      // a gap (a bundler helper, say) rather than a mapping into a file.
      if (fields.length >= 4) src += fields[1] ?? 0
      const arr = perLine.get(line)
      const seg = { col, src: fields.length >= 4 ? src : -1 }
      if (arr) arr.push(seg)
      else perLine.set(line, [seg])
    }
  }

  const ranges = new Map<string, Range[]>()
  const add = (key: string, start: number, end: number): void => {
    if (end <= start) return
    const arr = ranges.get(key)
    if (arr) arr.push({ start, end })
    else ranges.set(key, [{ start, end }])
  }

  for (let line = 0; line < lineStarts.length; line++) {
    const base = lineStarts[line]
    const end = line + 1 < lineStarts.length ? lineStarts[line + 1] : code.length
    const segs = (perLine.get(line) ?? []).slice().sort((a, b) => a.col - b.col)
    if (segs.length === 0) {
      add('(bundler)', base, end)
      continue
    }
    add('(bundler)', base, Math.min(base + segs[0].col, end))
    for (let i = 0; i < segs.length; i++) {
      const from = Math.min(base + segs[i].col, end)
      const to = i + 1 < segs.length ? Math.min(base + segs[i + 1].col, end) : end
      const source = segs[i].src >= 0 ? map.sources[segs[i].src] : undefined
      add(source === undefined ? '(bundler)' : source, from, to)
    }
  }
  return ranges
}

/** `code` with `ranges` removed. Not valid JS; gzip does not need it to be. */
function spliceOut(code: string, ranges: readonly Range[]): string {
  const sorted = [...ranges].sort((a, b) => a.start - b.start)
  let out = ''
  let cursor = 0
  for (const r of sorted) {
    if (r.start > cursor) out += code.slice(cursor, r.start)
    cursor = Math.max(cursor, r.end)
  }
  return out + code.slice(cursor)
}

/** `…/src/flush/idb.ts` → `flush`; anything outside `src/` → `(bundler)`. */
function subsystemOf(source: string): string {
  const path = source.replaceAll('\\', '/')
  if (path.startsWith('(')) return path
  const at = path.indexOf('/src/')
  // Anything that is not under this package's `src/` is not package code — the
  // measurement shim above all, which resolves relative to a temp directory.
  // Charging it to `(bundler)` keeps it in the sum without inventing a `..` row.
  if (at < 0 && !path.startsWith('src/')) return '(bundler)'
  const rel = at >= 0 ? path.slice(at + 5) : path.slice(4)
  const slash = rel.indexOf('/')
  // A file sitting directly in `src/` (`types.ts`, `version.ts`) is its own row.
  return slash >= 0 ? rel.slice(0, slash) : rel
}

function measureSingle(out: string, name: string, source: string, external: readonly string[]) {
  const entry = join(out, `${name}.ts`)
  writeFileSync(entry, source)
  const outfile = join(out, `${name}.min.js`)
  runBun([
    'build',
    entry,
    '--target=browser',
    '--minify',
    ...external.flatMap((e) => ['--external', e]),
    '--outfile',
    outfile,
  ])
  const code = readFileSync(outfile, 'utf8')
  return { gz: gz(code), min: bytes(code) }
}

function measureSplit(out: string, name: string, source: string, external: readonly string[]) {
  const entry = join(out, `${name}.ts`)
  writeFileSync(entry, source)
  const dist = join(out, `${name}-dist`)
  runBun([
    'build',
    entry,
    '--target=browser',
    '--minify',
    '--splitting',
    // Emitted only so the output can be attributed to source files. The map
    // itself is never measured and never published — but see `read` below:
    // asking for one is not free, and the number must not move because of it.
    '--sourcemap=external',
    ...external.flatMap((e) => ['--external', e]),
    `--outdir=${dist}`,
  ])
  const files = readdirSync(dist).filter((f) => f.endsWith('.js'))
  const entryFile = `${name}.js`
  if (!files.includes(entryFile)) throw new Error(`no entry among: ${files.join(', ')}`)
  /**
   * Read one output, without the trailing `//# debugId=…` line.
   *
   * `--sourcemap=external` writes the map to its own file but still appends a
   * 44-byte debug-id comment to the `.js`. Measuring that would inflate every
   * published figure and break comparability with every number taken before
   * attribution existed, for a comment no consumer ever receives. It is at the
   * very end of the file, so stripping it leaves every mapping offset intact.
   */
  const read = (f: string): string =>
    readFileSync(join(dist, f), 'utf8').replace(/\n*\/\/# debugId=[0-9A-F]+\n?$/, '')
  const code = read(entryFile)
  const chunks = files.filter((f) => f !== entryFile).map(read)

  // Charge every output byte, across the entry and its lazy chunks, to a
  // subsystem. The rows are exclusive and sum to `totalMin`.
  const perOutput = new Map<string, Map<string, Range[]>>()
  for (const f of files) {
    const text = read(f)
    let byFile: Map<string, Range[]>
    try {
      const map = JSON.parse(readFileSync(join(dist, `${f}.map`), 'utf8')) as SourceMap
      byFile = attributeRanges(text, map)
    } catch {
      // No sourcemap for this output: charge it whole rather than lose it.
      byFile = new Map([['(bundler)', [{ start: 0, end: text.length }]]])
    }
    const bySubsystem = new Map<string, Range[]>()
    for (const [src, rs] of byFile) {
      const key = subsystemOf(src)
      const arr = bySubsystem.get(key)
      if (arr) arr.push(...rs)
      else bySubsystem.set(key, [...rs])
    }
    perOutput.set(f, bySubsystem)
  }

  const totalGz = files.reduce((n, f) => n + gz(read(f)), 0)
  const keys = new Set<string>()
  for (const m of perOutput.values()) for (const k of m.keys()) keys.add(k)

  const attributed = new Map<string, Measure>()
  for (const key of keys) {
    let min = 0
    let withoutGz = 0
    for (const f of files) {
      const text = read(f)
      const rs = perOutput.get(f)?.get(key) ?? []
      for (const r of rs) min += bytes(text.slice(r.start, r.end))
      // The gz column is marginal: gzip of the whole bundle, minus gzip of the
      // bundle with this subsystem spliced out. It is what you would stop
      // shipping if the subsystem vanished. Because gzip shares redundancy
      // across the whole stream, these sum to a little less than the total —
      // unlike the min column, which sums exactly.
      withoutGz += gz(rs.length > 0 ? spliceOut(text, rs) : text)
    }
    attributed.set(key, { min, gz: totalGz - withoutGz })
  }

  return {
    gz: gz(code),
    min: bytes(code),
    chunks: chunks.length,
    totalGz,
    maxChunkGz: chunks.reduce((n, s) => Math.max(n, gz(s)), 0),
    totalMin: [code, ...chunks].reduce((n, s) => n + bytes(s), 0),
    attributed,
  }
}

function measure(): Report {
  const out = mkdtempSync(join(tmpdir(), 'moqtap-collector-size-'))
  try {
    const entries: Record<string, EntryMeasure> = {}
    const subsystems: Record<string, Measure & { label: string }> = {}
    for (const e of ENTRIES) {
      const name = e.id === '.' ? 'entry' : e.id.replace('./', '')
      const source = shimFor(...e.parts)
      if (!e.split) {
        entries[e.id] = { label: e.label, ...measureSingle(out, name, source, e.external) }
        continue
      }
      const { attributed, ...m } = measureSplit(out, name, source, e.external)
      entries[e.id] = { label: e.label, ...m }
      // The breakdown comes from the static entry's own build, so the rows are
      // shares of exactly the number printed above them.
      for (const [id, measured] of [...attributed].sort((a, b) => b[1].min - a[1].min)) {
        subsystems[id] = { label: SUBSYSTEM_LABELS[id] ?? id, ...measured }
      }
    }

    const pkg = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8')) as { name: string }
    const version = spawnSync(BUN, ['--version'], { encoding: 'utf8' }).stdout?.trim() ?? 'unknown'

    return {
      schema: SCHEMA,
      package: pkg.name,
      generatedAt: new Date().toISOString(),
      bun: version,
      method: 'bun build --target=browser --minify, from src/, then gzip -9',
      specTargetGz: SPEC_TARGET_GZ,
      entries,
      subsystems,
    }
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
}

/* ── rendering ───────────────────────────────────────────────────────────── */

/** The unit: bytes / 1024, one decimal — "31.5 KB (32,230 B)". */
const kb = (n: number): string => `${(n / 1024).toFixed(1)} KB`
const withCommas = (n: number): string => n.toLocaleString('en-US')
const signed = (n: number): string => (n > 0 ? `+${withCommas(n)}` : withCommas(n))

/** `▲` grew, `▼` shrank, `·` unchanged. gzip is deterministic: 0 means 0. */
const arrow = (d: number): string => (d > 0 ? '▲' : d < 0 ? '▼' : '·')

function deltaCell(now: number, before: number | undefined): string {
  if (before === undefined) return '  (new)'
  const d = now - before
  if (d === 0) return '       ·'
  const pct = before === 0 ? '' : ` ${d > 0 ? '+' : ''}${((d / before) * 100).toFixed(1)}%`
  return ` ${arrow(d)} ${signed(d)} B${pct}`
}

function renderText(r: Report, base: Report | null): string {
  const lines: string[] = []
  lines.push('')
  lines.push(`${r.package} — bundle size`)
  lines.push(`  ${r.method}`)
  if (base) lines.push(`  compared against a baseline measured ${base.generatedAt}`)
  lines.push('')
  const NAME = 24
  lines.push('  published entry points')
  lines.push(`    ${'entry'.padEnd(NAME)} ${'gzipped'.padStart(19)} ${'minified'.padStart(13)}`)
  const entryRow = (
    name: string,
    g: number,
    m: number | null,
    before: number | undefined,
  ): string =>
    `    ${name.padEnd(NAME)} ${`${kb(g)} (${withCommas(g)} B)`.padStart(19)} ` +
    `${(m === null ? '—' : `${withCommas(m)} B`).padStart(13)}${base ? deltaCell(g, before) : ''}`
  for (const [id, m] of Object.entries(r.entries)) {
    const b = base?.entries[id]
    lines.push(entryRow(id, m.gz, m.min, b?.gz))
    // What one session pays: the entry plus the single chunk it fetches.
    if (m.maxChunkGz !== undefined) {
      lines.push(entryRow('  └ + largest lazy chunk', m.gz + m.maxChunkGz, null, undefined))
    }
    // What nothing pays. Reported only so that a jump says a shared module
    // stopped being shared.
    if (m.totalGz !== undefined) {
      lines.push(entryRow(`  └ + all ${m.chunks} chunks`, m.totalGz, m.totalMin ?? 0, b?.totalGz))
    }
  }

  const entry = r.entries['.']
  if (entry) {
    lines.push('')
    lines.push(
      `  the static entry is ${(entry.gz / r.specTargetGz).toFixed(1)}x the ` +
        `${withCommas(r.specTargetGz)} B reference target. "no hard cap" — ` +
        'this is a number to watch, not a gate.',
    )
  }

  lines.push('')
  lines.push('  where the static bytes are (entry + lazy chunks, charged by sourcemap)')
  lines.push(`    ${'subsystem'.padEnd(NAME)} ${'gzipped'.padStart(19)} ${'minified'.padStart(13)}`)
  const rows = Object.entries(r.subsystems).sort((a, b2) => b2[1].min - a[1].min)
  const totalMin = rows.reduce((n, [, m]) => n + m.min, 0)
  for (const [id, m] of rows) {
    const b = base?.subsystems[id]
    const share = totalMin === 0 ? '' : `${((m.min / totalMin) * 100).toFixed(1)}%`
    lines.push(
      `    ${id.padEnd(NAME)} ${kb(m.gz).padStart(19)} ${`${withCommas(m.min)} B`.padStart(13)}` +
        ` ${share.padStart(6)}${base ? deltaCell(m.gz, b?.gz) : ''}`,
    )
  }
  lines.push('')
  lines.push('    minified bytes are exclusive and sum to the entry; the gz column is marginal')
  lines.push('    (what removing that subsystem would save), so it sums to slightly less.')
  lines.push('')
  return lines.join('\n')
}

function renderMarkdown(r: Report, base: Report | null): string {
  const l: string[] = []
  l.push(`### Bundle size — \`${r.package}\``)
  l.push('')
  l.push(
    base
      ? 'Gzipped, measured from source. ' +
          '**No cap and nothing fails on a delta** — this is here so a size change is ' +
          'visible next to the diff that caused it.'
      : 'Gzipped, measured from source.',
  )
  l.push('')
  l.push(`| entry | gzipped | minified |${base ? ' Δ gz | Δ % |' : ''}`)
  l.push(`| --- | ---: | ---: |${base ? ' ---: | ---: |' : ''}`)
  const row = (name: string, now: number, min: number, before: number | undefined): string => {
    if (!base) return `| ${name} | ${kb(now)} (${withCommas(now)} B) | ${withCommas(min)} B |`
    if (before === undefined) {
      return `| ${name} | ${kb(now)} (${withCommas(now)} B) | ${withCommas(min)} B | (new) | — |`
    }
    const d = now - before
    const pct = before === 0 ? '—' : `${d > 0 ? '+' : ''}${((d / before) * 100).toFixed(1)}%`
    const cell = d === 0 ? '·' : `${arrow(d)} ${signed(d)} B`
    return `| ${name} | ${kb(now)} (${withCommas(now)} B) | ${withCommas(min)} B | ${cell} | ${
      d === 0 ? '·' : pct
    } |`
  }
  for (const [id, m] of Object.entries(r.entries)) {
    l.push(row(`\`${id}\``, m.gz, m.min, base?.entries[id]?.gz))
    if (m.maxChunkGz !== undefined) {
      l.push(row(`\`${id}\` + largest lazy chunk`, m.gz + m.maxChunkGz, 0, undefined))
    }
    if (m.totalGz !== undefined) {
      l.push(
        row(
          `\`${id}\` + all ${m.chunks} chunks`,
          m.totalGz,
          m.totalMin ?? 0,
          base?.entries[id]?.totalGz,
        ),
      )
    }
  }
  const entry = r.entries['.']
  if (entry) {
    l.push('')
    l.push(
      `The static entry is **${(entry.gz / r.specTargetGz).toFixed(1)}x** The ` +
        `${withCommas(r.specTargetGz)} B reference target, which is kept as a target ` +
        'and explicitly not as a cap.',
    )
  }
  l.push('')
  l.push('<details><summary>Where the static bytes are</summary>')
  l.push('')
  l.push(`| subsystem | gzipped |${base ? ' Δ gz |' : ''}`)
  l.push(`| --- | ---: |${base ? ' ---: |' : ''}`)
  for (const [id, m] of Object.entries(r.subsystems).sort((a, b2) => b2[1].gz - a[1].gz)) {
    const before = base?.subsystems[id]?.gz
    const d = before === undefined ? null : m.gz - before
    const cell = d === null ? '(new)' : d === 0 ? '·' : `${arrow(d)} ${signed(d)} B`
    l.push(`| ${m.label} | ${kb(m.gz)} |${base ? ` ${cell} |` : ''}`)
  }
  l.push('')
  l.push(
    'Every output byte of the static entry and its lazy chunks is charged to a subsystem ' +
      "using the build's own sourcemaps, so the rows are exclusive and the minified column " +
      'sums to the entry. The gzipped column is marginal — gzip of the bundle minus gzip of ' +
      'the bundle with that subsystem spliced out, i.e. what removing it would actually save ' +
      '— so it sums to slightly less than the total.',
  )
  l.push('</details>')
  l.push('')
  return l.join('\n')
}

/* ── cli ─────────────────────────────────────────────────────────────────── */

function argValue(argv: readonly string[], flag: string): string | undefined {
  const i = argv.indexOf(flag)
  return i >= 0 ? argv[i + 1] : undefined
}

function main(): void {
  const argv = process.argv.slice(2)
  const asJson = argv.includes('--json')
  const asMarkdown = argv.includes('--markdown')
  const comparePath = argValue(argv, '--compare')
  const outPath = argValue(argv, '--out')
  const fromPath = argValue(argv, '--from')

  const report =
    fromPath === undefined ? measure() : (JSON.parse(readFileSync(fromPath, 'utf8')) as Report)

  let base: Report | null = null
  if (comparePath !== undefined) {
    try {
      base = JSON.parse(readFileSync(comparePath, 'utf8')) as Report
      if (base.schema !== SCHEMA) base = null
    } catch (err) {
      // A missing or unreadable baseline is a *reason to still print the
      // number*, never a reason to fail: on the first PR after this lands
      // there is no baseline on the base branch at all, and a hard failure
      // there would teach everyone to ignore the job.
      process.stderr.write(
        `size: no usable baseline at ${comparePath} (${String(err)}); reporting absolute sizes\n`,
      )
    }
  }

  const text = asJson
    ? JSON.stringify(report, null, 2)
    : asMarkdown
      ? renderMarkdown(report, base)
      : renderText(report, base)

  if (outPath !== undefined) {
    mkdirSync(dirname(resolve(outPath)), { recursive: true })
    writeFileSync(outPath, `${text}\n`)
  }
  process.stdout.write(`${text}\n`)
}

main()
