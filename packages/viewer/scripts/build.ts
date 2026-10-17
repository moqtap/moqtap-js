/**
 * Build the view bundle: `dist/view/{index.html,styles.css,main.js,worker.js}`.
 *
 *     bun run build
 *     bun run build -- --staging-parent https://<name>.workers.dev
 *     bun run build -- --out <dir>
 *
 * A static directory and nothing else, so any static host can serve it; the
 * host supplies the CSP and headers that make it safe. `bun build` rather than
 * tsup because the output is a page, not a library: two self-contained browser
 * entry points, no declarations, no CJS.
 *
 * `@moqtap/trace` resolves to its source through this package's `tsconfig.json`
 * `paths`, the same arrangement the collector's declaration build uses for the
 * codec, so the bundle does not depend on a built `trace/dist`.
 *
 * Extra parents for non-production deployments are the one build-time input.
 * Each must be an exact `https:` origin on `workers.dev`: accepting anything
 * else would let a mistyped command widen a production bundle.
 */

import { copyFileSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function parseArgs(argv: readonly string[]): { out: string; staging: string[] } {
  let out = join(ROOT, 'dist', 'view')
  const staging: string[] = []
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const value = argv[i + 1]
    if (arg === '--out' && value !== undefined) {
      out = resolve(value)
      i += 1
    } else if (arg === '--staging-parent' && value !== undefined) {
      staging.push(stagingOrigin(value))
      i += 1
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }
  return { out, staging }
}

function stagingOrigin(value: string): string {
  const url = new URL(value)
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.workers.dev') || url.origin !== value) {
    throw new Error(`--staging-parent must be a bare https://*.workers.dev origin, not ${value}`)
  }
  return value
}

const { out, staging } = parseArgs(process.argv.slice(2))

rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })

const result = await Bun.build({
  entrypoints: [join(ROOT, 'src', 'main.ts'), join(ROOT, 'src', 'worker.ts')],
  outdir: out,
  target: 'browser',
  format: 'esm',
  // Each entry stands alone: a shared chunk would be a third file the worker
  // imports, for no saving worth the extra request.
  splitting: false,
  minify: true,
  sourcemap: 'none',
  naming: '[name].js',
  define: { __MOQTAP_VIEW_STAGING_PARENTS__: JSON.stringify(staging) },
  tsconfig: join(ROOT, 'tsconfig.json'),
})

if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}

for (const file of ['index.html', 'styles.css']) {
  copyFileSync(join(ROOT, 'static', file), join(out, file))
}

console.log(
  `Built the view bundle into ${out}${staging.length > 0 ? ` (staging parents: ${staging.join(' ')})` : ''}.`,
)
