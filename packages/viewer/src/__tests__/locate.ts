/**
 * Where the shared `.moqtrace` corpus lives, for the viewer's tests.
 *
 * The same two places `packages/trace` looks (its `__tests__/corpus/locate.ts`
 * explains the order): the installed `@moqtap/test-traces`, then a
 * `test-traces` checkout beside this repository. Duplicated rather than
 * imported because one package's tests reaching into another's is a coupling
 * neither package's build knows about.
 */

import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require_ = createRequire(import.meta.url)

function fromPackage(): string | undefined {
  try {
    return dirname(require_.resolve('@moqtap/test-traces/manifest'))
  } catch {
    return undefined
  }
}

function fromSiblingCheckout(): string | undefined {
  let dir = dirname(fileURLToPath(import.meta.url))
  // Bounded, so a `test-traces` somewhere far above the repo is never read.
  for (let i = 0; i < 8; i++) {
    const candidate = resolve(join(dir, 'test-traces', 'moqtrace'))
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

export function findCorpusDir(): string | undefined {
  for (const candidate of [fromPackage(), fromSiblingCheckout()]) {
    if (candidate != null && existsSync(candidate)) return candidate
  }
  return undefined
}

export const CORPUS_MISSING_MESSAGE =
  'No .moqtrace corpus found. It ships in @moqtap/test-traces under moqtrace/; ' +
  'install it, or clone github.com/moqtap/test-traces beside this repository.'
