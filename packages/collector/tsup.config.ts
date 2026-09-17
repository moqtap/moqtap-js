import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { defineConfig } from 'tsup'
import { baseConfig } from '../../tsup.config.base'

/**
 * The bundle budget.
 *
 * `@moqtap/codec` root and `@moqtap/codec/session` both statically import all
 * fourteen drafts — 39.6 KB gz against 5.3 KB for one draft's decoder, a 7.5x
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
const CODEC_ALLOWED = [
  '@moqtap/codec/draft07',
  '@moqtap/codec/draft08',
  '@moqtap/codec/draft09',
  '@moqtap/codec/draft10',
  '@moqtap/codec/draft11',
  '@moqtap/codec/draft12',
  '@moqtap/codec/draft13',
  '@moqtap/codec/draft14',
  '@moqtap/codec/draft15',
  '@moqtap/codec/draft16',
  '@moqtap/codec/draft17',
  '@moqtap/codec/draft18',
  '@moqtap/codec/draft19',
  '@moqtap/codec/draft20',
]

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
      'The root and /session entries statically import all fourteen drafts:',
      '39.6 KB gz against 5.3 KB for one draft. Import a draft entry instead —',
      `allowed here: ${CODEC_ALLOWED.join(', ')} — with a STATIC string literal,`,
      'never a template literal such as `@moqtap/codec/draft<n>`, which defeats',
      'bundler analysis and pulls all fourteen anyway. Symbols reachable only',
      'from the root (core/accessors.ts, MoqtBufferReader) are copied into',
      'src/draft/, not imported — see src/draft/protocol.ts and src/draft/varint.ts.',
    ].join('\n'),
  )
}

assertNoCodecRootImport()

export default defineConfig({
  ...baseConfig,
  dts: {
    compilerOptions: {
      composite: false,
      rootDir: undefined,
      // Point the declaration build at codec SOURCE rather than its dist, so a
      // collector build does not require a built codec sitting next to it.
      paths: {
        '@moqtap/codec/draft07': ['../codec/src/drafts/draft07/index.ts'],
        '@moqtap/codec/draft08': ['../codec/src/drafts/draft08/index.ts'],
        '@moqtap/codec/draft09': ['../codec/src/drafts/draft09/index.ts'],
        '@moqtap/codec/draft10': ['../codec/src/drafts/draft10/index.ts'],
        '@moqtap/codec/draft11': ['../codec/src/drafts/draft11/index.ts'],
        '@moqtap/codec/draft12': ['../codec/src/drafts/draft12/index.ts'],
        '@moqtap/codec/draft13': ['../codec/src/drafts/draft13/index.ts'],
        '@moqtap/codec/draft14': ['../codec/src/drafts/draft14/index.ts'],
        '@moqtap/codec/draft15': ['../codec/src/drafts/draft15/index.ts'],
        '@moqtap/codec/draft16': ['../codec/src/drafts/draft16/index.ts'],
        '@moqtap/codec/draft17': ['../codec/src/drafts/draft17/index.ts'],
        '@moqtap/codec/draft18': ['../codec/src/drafts/draft18/index.ts'],
        '@moqtap/codec/draft19': ['../codec/src/drafts/draft19/index.ts'],
        '@moqtap/codec/draft20': ['../codec/src/drafts/draft20/index.ts'],
      },
    },
  },
  sourcemap: false,
  entry: {
    // src/index.ts installs the dormant hook at module-eval time, which is why
    // package.json marks dist/index.js as having side effects.
    index: 'src/index.ts',
    // `draft20`, not `d20` — every other package in this workspace uses the
    // zero-padded form and `d20` would be the only one of its kind.
    //
    // Fourteen entries, one per draft, each its own chunk. A consumer that
    // imports one of them gets that draft's decoder and no other's.
    draft07: 'src/drafts/draft07/entry.ts',
    draft08: 'src/drafts/draft08/entry.ts',
    draft09: 'src/drafts/draft09/entry.ts',
    draft10: 'src/drafts/draft10/entry.ts',
    draft11: 'src/drafts/draft11/entry.ts',
    draft12: 'src/drafts/draft12/entry.ts',
    draft13: 'src/drafts/draft13/entry.ts',
    draft14: 'src/drafts/draft14/entry.ts',
    draft15: 'src/drafts/draft15/entry.ts',
    draft16: 'src/drafts/draft16/entry.ts',
    draft17: 'src/drafts/draft17/entry.ts',
    draft18: 'src/drafts/draft18/entry.ts',
    draft19: 'src/drafts/draft19/entry.ts',
    draft20: 'src/drafts/draft20/entry.ts',
    draft21: 'src/drafts/draft21/entry.ts',
  },
  external: CODEC_ALLOWED,
})
