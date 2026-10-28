/**
 * The error-code registry, held to being exhaustive and honest.
 *
 * A code is only worth six bytes instead of a sentence if the sentence is
 * reliably findable. Everything that could break that is checked here:
 *
 *  - every constant in `codes.ts` has a registry entry, and every entry has a
 *    constant, so neither file can grow alone;
 *  - no code appears as a bare literal anywhere else under `src/`, because a
 *    hand-typed `'MQ4002'` is exactly how a code ends up in the wire with no
 *    entry behind it;
 *  - codes are unique, and shaped the way the registry's blocks say;
 *  - **no registry prose reaches the bundle** — `error-codes.json` must never
 *    be imported from `src/`, which is the property the whole scheme rests on.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import * as codes from '../codes.js'

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SRC = join(PKG, 'src')

interface Registry {
  readonly schema: number
  readonly blocks: Record<string, string>
  readonly codes: Record<
    string,
    { summary: string; detail: string; value?: string; fatal?: boolean; retired?: boolean }
  >
}

const registry = JSON.parse(readFileSync(join(PKG, 'error-codes.json'), 'utf8')) as Registry

const CODE_RE = /\bMQ\d{4}\b/g

function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? tsFiles(join(dir, e.name))
      : e.name.endsWith('.ts')
        ? [join(dir, e.name)]
        : [],
  )
}

/** The exported constants, which are the codes this build can actually emit. */
const exported = Object.entries(codes as Record<string, string>)

describe('the registry and the constants agree', () => {
  it('gives every exported constant a registry entry', () => {
    for (const [name, value] of exported) {
      expect(registry.codes[value], `no registry entry for ${name}`).toBeTypeOf('object')
    }
  })

  it('gives every registry entry an exported constant', () => {
    const values = new Set(exported.map(([, v]) => v))
    for (const code of Object.keys(registry.codes)) {
      if (registry.codes[code]?.retired === true) continue
      expect(values.has(code), `${code} is in the registry but exported by nothing`).toBe(true)
    }
  })

  it('names each constant after its own value, so a grep finds both', () => {
    for (const [name, value] of exported) expect(name).toBe(value)
  })

  it('has no duplicate codes', () => {
    const values = exported.map(([, v]) => v)
    expect(new Set(values).size).toBe(values.length)
  })

  it('gives every entry a summary and a detail worth reading', () => {
    for (const [code, e] of Object.entries(registry.codes)) {
      expect(e.summary.length, `${code} summary`).toBeGreaterThan(10)
      // The detail is the thing that replaced the message string. If it is not
      // longer than the message would have been, the code bought nothing.
      expect(e.detail.length, `${code} detail`).toBeGreaterThan(60)
    }
  })

  it('puts every code in a block the registry describes', () => {
    for (const code of Object.keys(registry.codes)) {
      expect(code).toMatch(/^MQ\d{4}$/)
      expect(registry.blocks[code[2] as string], `no block for ${code}`).toBeTypeOf('string')
    }
  })
})

describe('codes are never written by hand', () => {
  it('has no bare MQ#### literal anywhere under src/ but codes.ts', () => {
    const offenders: string[] = []
    for (const file of tsFiles(SRC)) {
      const rel = relative(SRC, file).replaceAll('\\', '/')
      // Tests assert on codes by design — `toThrow(/MQ1002/)` is the point of
      // having one — and none of that ships. Only shipped modules are held to
      // importing the constant.
      if (rel === 'codes.ts' || rel.startsWith('__tests__/')) continue
      const text = readFileSync(file, 'utf8')
      for (const line of text.split('\n')) {
        // An import binding or a `${MQ1234}` interpolation is the constant, not
        // a literal. A quoted one is not.
        if (/['"`]MQ\d{4}['"`]/.test(line)) offenders.push(`${rel}: ${line.trim()}`)
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([])
  })

  it('keeps the registry out of the shipped graph', () => {
    // Naming the file in a comment is fine and useful — `codes.ts` and
    // `config.ts` both point at it deliberately. Resolving it at build time is
    // what must never happen, so the path has to appear as a real module
    // specifier: quoted, in single or double quotes, right after from/import/
    // require. A backticked mention in prose is not that.
    const IMPORTS_REGISTRY = /(?:from|import|require)\s*\(?\s*['"][^'"]*error-codes\.json['"]/
    const offenders: string[] = []
    for (const file of tsFiles(SRC)) {
      const rel = relative(SRC, file).replaceAll('\\', '/')
      if (rel === '__tests__/codes.test.ts') continue
      if (IMPORTS_REGISTRY.test(readFileSync(file, 'utf8'))) offenders.push(rel)
    }
    expect(offenders, offenders.join('\n')).toEqual([])
  })
})

describe('every code the package can emit is reachable', () => {
  it('uses each exported constant somewhere under src/', () => {
    const used = new Set<string>()
    for (const file of tsFiles(SRC)) {
      const rel = relative(SRC, file).replaceAll('\\', '/')
      if (rel === 'codes.ts') continue
      for (const m of readFileSync(file, 'utf8').matchAll(CODE_RE)) used.add(m[0])
    }
    const unused = exported.map(([, v]) => v).filter((v) => !used.has(v))
    expect(unused, `declared but never emitted: ${unused.join(', ')}`).toEqual([])
  })
})
