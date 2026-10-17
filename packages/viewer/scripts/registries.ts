/**
 * Slim the site's per-draft registries down to what naming a message needs.
 *
 *     bun run registries [<site registries dir>]
 *     bun run registries:check [<site registries dir>]
 *
 * The site's per-draft registries (`draft-NN.json`) are extracted from the
 * draft documents and drive its reference pages. The viewer reads the same
 * rows, so a message named in a trace and the same message on a reference page
 * cannot disagree. The viewer is built from this repository alone, so it
 * carries a committed copy rather than reaching into another checkout at build
 * time. `--check` is what keeps the copy honest: it fails when the site's
 * registries say something the copy does not.
 *
 * Without a directory argument, the registries are read from a site checkout
 * beside this repository.
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '..', 'src', 'data', 'message-tables.json')
const DEFAULT_SOURCE = resolve(HERE, '..', '..', '..', '..', 'site', 'src', 'data', 'registries')

interface SiteRow {
  value: number
  name: string
  reserved?: boolean
  note: string | null
  specPath: string | null
}

interface SiteRegistry {
  num: number
  messages: { rows: SiteRow[] }
}

const args = process.argv.slice(2)
const check = args.includes('--check')
const source = args.find((a) => !a.startsWith('--')) ?? DEFAULT_SOURCE

const tables: Record<string, unknown[]> = {}
const files = readdirSync(source)
  .filter((f) => /^draft-\d+\.json$/.test(f))
  .sort()
if (files.length === 0) {
  console.error(`No draft-NN.json registries in ${source}.`)
  process.exit(1)
}
for (const file of files) {
  const registry = JSON.parse(readFileSync(join(source, file), 'utf8')) as SiteRegistry
  tables[String(registry.num)] = registry.messages.rows.map((row) => ({
    value: row.value,
    name: row.name,
    reserved: row.reserved === true,
    note: row.note,
    specPath: row.specPath,
  }))
}

const text = `${JSON.stringify(tables, null, 2)}\n`

if (check) {
  // Compared as data, not as bytes, so that the formatter reflowing the
  // committed file is not mistaken for drift.
  const committed = JSON.stringify(JSON.parse(readFileSync(OUT, 'utf8')))
  if (committed !== JSON.stringify(tables)) {
    console.error(
      `src/data/message-tables.json differs from the registries in ${source}. Run \`bun run registries\`.`,
    )
    process.exit(1)
  }
  console.log(`message-tables.json matches ${files.length} registries.`)
} else {
  writeFileSync(OUT, text)
  console.log(`Wrote ${OUT} from ${files.length} registries.`)
}
