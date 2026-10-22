import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { defineConfig } from 'tsup'
import { baseConfig } from '../../tsup.config.base'

/**
 * The drafts this package ships, zero-padded, read off `src/drafts/draftNN/`.
 *
 * Read rather than listed so that the entry map, the codec allowlist and the
 * declaration `paths` cannot fall behind a new draft directory.
 */
const DRAFTS: readonly string[] = readdirSync(join(process.cwd(), 'src', 'drafts'), {
  withFileTypes: true,
})
  .filter((e) => e.isDirectory() && /^draft\d\d$/.test(e.name))
  .map((e) => e.name.slice('draft'.length))
  .sort()

/**
 * The bundle budget.
 *
 * `@moqtap/codec` root and `@moqtap/codec/session` both statically import every
 * draft — 39.6 KB gz against 5.3 KB for one draft's decoder, a 7.5x
 * regression that is invisible in review because the import line looks like
 * every other import line.
 *
 * The allowlist below declares intent; it is NOT the enforcement. tsup
 * externalises `dependencies` and `peerDependencies` automatically and
 * registers that plugin ahead of `esbuildPlugins`, so a root import would be
 * silently externalised rather than inlined or refused. Enforcement is the
 * source scan underneath, which runs at config load and depends on no plugin
 * ordering at all.
 */
const CODEC_ALLOWED = DRAFTS.map((d) => `@moqtap/codec/draft${d}`)

/** Bare root and `/session`. Everything else under `@moqtap/codec/` is fine. */
const FORBIDDEN_SPECIFIER =
  /(?:\bfrom|\bimport|\brequire)\s*\(?\s*['"]@moqtap\/codec(\/session)?['"]/

/** Strip comments so a comment *about* the root import is not mistaken for one. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ')
}

function tsFilesUnder(dir: string): string[] {
  const out: string[] = []
  let entries: { name: string; isDirectory(): boolean }[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    // src/ does not exist yet. Let tsup report the missing entry point itself.
    return out
  }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...tsFilesUnder(p))
    else if (e.name.endsWith('.ts')) out.push(p)
  }
  return out
}

function assertNoCodecRootImport(): void {
  // tsup runs with cwd set to the package directory (it loads package.json from
  // `process.cwd()` itself), and this config is bundled to a temp module, so
  // `__dirname` is not dependable here.
  const offenders = tsFilesUnder(join(process.cwd(), 'src')).filter((f) =>
    FORBIDDEN_SPECIFIER.test(stripComments(readFileSync(f, 'utf8'))),
  )
  if (offenders.length === 0) return
  throw new Error(
    [
      'Forbidden import of the @moqtap/codec root entry:',
      ...offenders.map((f) => `  ${f}`),
      '',
      'The root and /session entries statically import every draft:',
      '39.6 KB gz against 5.3 KB for one draft. Import a draft entry instead —',
      `allowed here: ${CODEC_ALLOWED.join(', ')} — with a STATIC string literal,`,
      'never a template literal such as `@moqtap/codec/draft<n>`, which defeats',
      'bundler analysis and pulls every draft anyway. Symbols reachable only',
      'from the root (core/accessors.ts, MoqtBufferReader) are copied into',
      'src/draft/, not imported — see src/draft/protocol.ts and src/draft/varint.ts.',
    ].join('\n'),
  )
}

assertNoCodecRootImport()

const TYPED_ENTRIES: Record<string, string> = {
  // Every entry but `internal` installs the dormant hook at module-eval
  // time, which is why package.json marks each as having side effects.
  index: 'src/index.ts',
  // Installs nothing: the parts a test, a harness or the extension builds on.
  internal: 'src/internal.ts',
  // `draft20`, not `d20` — every other package in this workspace uses the
  // zero-padded form and `d20` would be the only one of its kind.
  //
  // One entry per draft: the same API with that draft's decoder and no other's.
  ...Object.fromEntries(DRAFTS.map((d) => [`draft${d}`, `src/drafts/draft${d}/entry.ts`])),
  // `initWorker` without the page side, for a dedicated worker.
  worker: 'src/worker.ts',
}

/**
 * One per draft, flat (`draft14-worker` for `./draft14/worker`): dist/ holds no
 * subdirectories, which `scripts/smoke.ts` holds it to. Their declarations are
 * `worker`'s, which package.json points them at: the decoder a worker entry
 * carries is not in its types, and a declaration build per entry runs the
 * build out of memory.
 */
const DRAFT_WORKER_ENTRIES: Record<string, string> = Object.fromEntries(
  DRAFTS.map((d) => [`draft${d}-worker`, `src/drafts/draft${d}/worker.ts`]),
)

export default defineConfig({
  ...baseConfig,
  dts: {
    entry: TYPED_ENTRIES,
    compilerOptions: {
      composite: false,
      rootDir: undefined,
      // Point the declaration build at codec SOURCE rather than its dist, so a
      // collector build does not require a built codec sitting next to it.
      paths: Object.fromEntries(
        DRAFTS.map((d) => [`@moqtap/codec/draft${d}`, [`../codec/src/drafts/draft${d}/index.ts`]]),
      ),
    },
  },
  sourcemap: false,
  entry: { ...TYPED_ENTRIES, ...DRAFT_WORKER_ENTRIES },
  external: CODEC_ALLOWED,
})
