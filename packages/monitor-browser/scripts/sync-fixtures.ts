/**
 * `bun run fixtures <dir>` copies the v2 viewer goldens (every `*.bin` and
 * `manifest.json` in `<dir>`) over
 * `src/__tests__/envelope/fixtures/contract-v2`, the manifest formatted as
 * the repo's lint expects and its top-level note replaced with this
 * package's own. `bun run fixtures --check <dir>` changes nothing and exits 1
 * when the vendored set or any file's content differs from `<dir>`; the
 * manifest's formatting and top-level note are not compared. A bad `<dir>`
 * exits 2.
 */

import { readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const usage = 'usage: sync-fixtures.ts [--check] <fixture directory>'
const args = process.argv.slice(2)
const check = args[0] === '--check'
const src = check ? args[1] : args[0]
if (src === undefined || args.length !== (check ? 2 : 1)) {
  console.error(usage)
  process.exit(2)
}
if (!statSync(src, { throwIfNoEntry: false })?.isDirectory()) {
  console.error(`not a directory: ${src}`)
  console.error(usage)
  process.exit(2)
}

const MANIFEST = 'manifest.json'
const NOTE =
  'Golden v2 viewer bodies. Not gzipped: every writer must produce these bytes. Do not hand-edit; re-vendor with `bun run fixtures`.'
const dst = join(
  import.meta.dirname,
  '..',
  'src',
  '__tests__',
  'envelope',
  'fixtures',
  'contract-v2',
)
const filesIn = (dir: string) =>
  readdirSync(dir)
    .filter((f) => f.endsWith('.bin') || f === MANIFEST)
    .sort()

const names = filesIn(src)
if (!names.includes(MANIFEST)) {
  console.error(`no ${MANIFEST} in ${src}`)
  process.exit(2)
}

/** The manifest with its top-level note set to this package's. */
const manifest = (bytes: Buffer): string =>
  `${JSON.stringify({ ...JSON.parse(bytes.toString('utf8')), note: NOTE }, null, 2)}\n`

const same = (f: string): boolean => {
  const a = readFileSync(join(src, f))
  const b = readFileSync(join(dst, f))
  if (f !== MANIFEST) return a.equals(b)
  return manifest(a) === manifest(b)
}

if (check) {
  const vendored = filesIn(dst)
  let differs = false
  for (const f of new Set([...names, ...vendored])) {
    if (!names.includes(f) || !vendored.includes(f)) {
      console.error(`${f}: only in ${names.includes(f) ? src : dst}`)
      differs = true
      continue
    }
    if (!same(f)) {
      console.error(`${f}: differs from ${src}`)
      differs = true
    }
  }
  process.exit(differs ? 1 : 0)
}

for (const f of filesIn(dst)) rmSync(join(dst, f))
for (const f of names) {
  const bytes = readFileSync(join(src, f))
  writeFileSync(join(dst, f), f === MANIFEST ? manifest(bytes) : bytes)
}
const fmt = Bun.spawnSync(['bun', 'x', 'biome', 'format', '--write', join(dst, MANIFEST)], {
  stdout: 'inherit',
  stderr: 'inherit',
})
process.exit(fmt.exitCode)
