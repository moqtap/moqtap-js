// Every entry point of @moqtap/collector must resolve, in ESM and in CJS, to
// the same exports as the matching @moqtap/monitor-browser entry.
//
//   node scripts/check-collector-shim.mjs

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = join(import.meta.dirname, '..', 'packages')
const shim = JSON.parse(readFileSync(join(root, 'collector', 'package.json'), 'utf8'))
const target = JSON.parse(readFileSync(join(root, 'monitor-browser', 'package.json'), 'utf8'))
const require = createRequire(join(root, 'collector', 'package.json'))

let failed = false
const fail = (msg) => {
  console.error(`::error::${msg}`)
  failed = true
}

const missing = Object.keys(target.exports).filter((k) => !(k in shim.exports))
if (missing.length) fail(`@moqtap/collector lacks ${missing.join(', ')}`)

const same = (a, b) => {
  const ka = Object.keys(a).sort()
  const kb = Object.keys(b).sort()
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && a[k] === b[k])
}

// Each side through its own exports map: ESM by file, CJS by self-reference.
const esm = (dir, pkg, key) => import(pathToFileURL(join(root, dir, pkg.exports[key].import)).href)

for (const key of Object.keys(shim.exports)) {
  const sub = key === '.' ? '' : key.slice(1)
  const [from, to] = [`@moqtap/collector${sub}`, `@moqtap/monitor-browser${sub}`]
  const [a, b] = [await esm('collector', shim, key), await esm('monitor-browser', target, key)]
  if (!same(a, b)) fail(`${from} (ESM) differs from ${to}`)
  if (!same(require(from), require(to))) fail(`${from} (CJS) differs from ${to}`)
}

console.log(`${Object.keys(shim.exports).length} entries checked`)
process.exit(failed ? 1 : 0)
