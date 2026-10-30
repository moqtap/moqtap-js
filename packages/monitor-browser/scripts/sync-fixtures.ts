/**
 * `bun run fixtures <dir>` copies the golden fixtures (every
 * `*.json` in `<dir>`) over `src/__tests__/rollup/fixtures`, formatted as
 * the repo's lint expects. `bun run fixtures --check <dir>` changes nothing
 * and exits 1 when the vendored set or any file's content differs from
 * `<dir>`; formatting is not compared. A bad `<dir>` exits 2.
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

const dst = join(import.meta.dirname, '..', 'src', '__tests__', 'rollup', 'fixtures')
const jsonIn = (dir: string) =>
  readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()

const names = jsonIn(src)
if (names.length === 0) {
  console.error(`no *.json in ${src}`)
  process.exit(2)
}

if (check) {
  const vendored = jsonIn(dst)
  let differs = false
  for (const f of new Set([...names, ...vendored])) {
    if (!names.includes(f) || !vendored.includes(f)) {
      console.error(`${f}: only in ${names.includes(f) ? src : dst}`)
      differs = true
      continue
    }
    const want = JSON.stringify(JSON.parse(readFileSync(join(src, f), 'utf8')))
    const have = JSON.stringify(JSON.parse(readFileSync(join(dst, f), 'utf8')))
    if (want !== have) {
      console.error(`${f}: differs from ${src}`)
      differs = true
    }
  }
  process.exit(differs ? 1 : 0)
}

for (const f of jsonIn(dst)) rmSync(join(dst, f))
for (const f of names) writeFileSync(join(dst, f), readFileSync(join(src, f)))
const fmt = Bun.spawnSync(
  ['bun', 'x', 'biome', 'format', '--write', ...names.map((f) => join(dst, f))],
  {
    stdout: 'inherit',
    stderr: 'inherit',
  },
)
process.exit(fmt.exitCode)
