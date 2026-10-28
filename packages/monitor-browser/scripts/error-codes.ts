/**
 * `bun run codes` — regenerate `ERROR-CODES.md` from `error-codes.json`.
 *
 * The JSON is the source of truth and the Markdown is a rendering of it, so the
 * site and the repo cannot drift from each other or from the code: the JSON is
 * what a docs site should consume, `ERROR-CODES.md` is what someone reading the
 * repo or the published tarball gets, and `src/__tests__/codes.test.ts` holds
 * the JSON to matching `src/codes.ts` exactly.
 *
 *   bun run codes            rewrite ERROR-CODES.md
 *   bun run codes --check    exit non-zero if it is out of date (for CI)
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), '..')

interface Entry {
  readonly summary: string
  readonly detail: string
  readonly value?: string
  readonly fatal?: boolean
  readonly retired?: boolean
}

interface Registry {
  readonly package: string
  readonly blocks: Record<string, string>
  readonly codes: Record<string, Entry>
}

const reg = JSON.parse(readFileSync(join(PKG, 'error-codes.json'), 'utf8')) as Registry

function render(r: Registry): string {
  const out: string[] = []
  out.push(`# \`${r.package}\` — error codes`)
  out.push('')
  out.push(
    'Every error this package reports carries a code. The runtime message is the',
    'code and the offending value and nothing else — the wording lives here, so',
    'that explanations can be as long as they need to be without every page that',
    'loads the collector paying for them in bytes.',
  )
  out.push('')
  out.push('```')
  out.push('MQ2101: 1.5')
  out.push('│       └ the value that was rejected')
  out.push('└ the code — look it up below')
  out.push('```')
  out.push('')
  out.push('Codes are permanent. A retired code is never reissued for a new meaning.')
  out.push('')
  out.push('| block | area |')
  out.push('| --- | --- |')
  for (const [n, label] of Object.entries(r.blocks)) out.push(`| \`${n}xxx\` | ${label} |`)
  out.push('')

  const byBlock = new Map<string, [string, Entry][]>()
  for (const [code, e] of Object.entries(r.codes)) {
    const b = code[2] as string
    const arr = byBlock.get(b)
    if (arr) arr.push([code, e])
    else byBlock.set(b, [[code, e]])
  }

  for (const [b, label] of Object.entries(r.blocks)) {
    const entries = (byBlock.get(b) ?? []).sort((x, y) => x[0].localeCompare(y[0]))
    if (entries.length === 0) continue
    out.push(`## ${b}xxx — ${label}`)
    out.push('')
    for (const [code, e] of entries) {
      const flags: string[] = []
      if (e.fatal === true) flags.push('**throws**')
      if (e.retired === true) flags.push('**retired**')
      out.push(`### \`${code}\` — ${e.summary}${flags.length ? ` ${flags.join(' ')}` : ''}`)
      out.push('')
      out.push(e.detail)
      out.push('')
      if (e.value !== undefined && e.value !== 'none') {
        out.push(`*Value carried:* ${e.value}.`)
        out.push('')
      }
    }
  }
  out.push('---')
  out.push('')
  out.push('Generated from `error-codes.json` by `bun run codes`. Do not edit by hand.')
  out.push('')
  return out.join('\n')
}

const text = render(reg)
const target = join(PKG, 'ERROR-CODES.md')

if (process.argv.includes('--check')) {
  let current = ''
  try {
    current = readFileSync(target, 'utf8')
  } catch {
    // Missing counts as out of date.
  }
  if (current !== text) {
    process.stderr.write('ERROR-CODES.md is out of date. Run `bun run codes`.\n')
    process.exit(1)
  }
  process.stdout.write('ERROR-CODES.md is up to date.\n')
} else {
  writeFileSync(target, text)
  process.stdout.write(`wrote ${target} (${Object.keys(reg.codes).length} codes)\n`)
}
