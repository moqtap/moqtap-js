// Every published package carries its moqtap.com page in docs/site.md, and the
// page's `version` must be the version package.json is about to release.
// Packages in README_ONLY carry no page.
//
//   node scripts/check-site-docs.mjs            every published package
//   node scripts/check-site-docs.mjs collector  one package

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..', 'packages')

const README_ONLY = new Set(['media'])

const named = process.argv.slice(2)
const packages = named.length
  ? named
  : readdirSync(root).filter((d) => {
      const pkg = join(root, d, 'package.json')
      return (
        existsSync(pkg) && !JSON.parse(readFileSync(pkg, 'utf8')).private && !README_ONLY.has(d)
      )
    })

let failed = false
const fail = (msg) => {
  console.error(`::error::${msg}`)
  failed = true
}

for (const name of packages) {
  const pkgPath = join(root, name, 'package.json')
  if (!existsSync(pkgPath)) {
    fail(`packages/${name}: no package.json`)
    continue
  }
  const { version } = JSON.parse(readFileSync(pkgPath, 'utf8'))
  const page = join(root, name, 'docs', 'site.md')
  if (!existsSync(page)) {
    fail(`packages/${name}/docs/site.md is missing`)
    continue
  }
  const text = readFileSync(page, 'utf8').replace(/\r\n/g, '\n')
  const fm = /^---\n([\s\S]*?)\n---\n/.exec(text)
  if (!fm) {
    fail(`packages/${name}/docs/site.md has no frontmatter`)
    continue
  }
  const field = (key) =>
    new RegExp(`^${key}:\\s*(.+)$`, 'm')
      .exec(fm[1])?.[1]
      .trim()
      .replace(/^["']|["']$/g, '')
  for (const key of ['title', 'description']) {
    if (!field(key)) fail(`packages/${name}/docs/site.md: frontmatter has no ${key}`)
  }
  const documented = field('version')
  if (documented !== version) {
    fail(
      `packages/${name}/docs/site.md documents ${documented ?? 'no version'}, package.json is ${version}. ` +
        'Update the page for this release and set its version.',
    )
    continue
  }
  console.log(`packages/${name}: docs/site.md documents ${version}`)
}

process.exit(failed ? 1 : 0)
