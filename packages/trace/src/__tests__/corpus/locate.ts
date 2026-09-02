/**
 * Where the shared `.moqtrace` corpus lives.
 *
 * The corpus is `trace/` inside `@moqtap/test-vectors`, the same repository
 * the codec vectors come from, because the claim it backs is a cross-language
 * one: `moqtap-trace` reads it as a git submodule, this package reads it as a
 * dependency. One copy, two readers — a corpus each implementation kept its
 * own copy of would drift, and drift is the failure it exists to catch.
 *
 * Two locations are tried, in order, because the dependency does not carry
 * the corpus until the next `@moqtap/test-vectors` release:
 *
 *   1. the installed package, which is where CI finds it;
 *   2. a `test-vectors` checkout beside this repository, which is how the
 *      corpus is developed before it ships.
 *
 * Neither is a fallback for the other being wrong — they are the same files
 * at two points in a release cycle.
 */

import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require_ = createRequire(import.meta.url)

/** Directory name of the corpus inside the test-vectors repository. */
const CORPUS_SUBDIR = 'trace'

function fromPackage(): string | undefined {
  try {
    const base = dirname(require_.resolve('@moqtap/test-vectors/manifest'))
    return resolve(base, CORPUS_SUBDIR)
  } catch {
    return undefined
  }
}

function fromSiblingCheckout(): string | undefined {
  let dir = dirname(fileURLToPath(import.meta.url))
  // Bounded rather than `while (true)`: a resolver that walks to the
  // filesystem root on a machine that happens to have `test-vectors`
  // somewhere above the repo would read a corpus nobody meant to point it at.
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, 'test-vectors', CORPUS_SUBDIR)
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

/**
 * Absolute path to the corpus directory, or `undefined` if neither location
 * has it.
 *
 * Callers report the miss themselves rather than throwing here, so a test
 * suite can say which of the two setups is missing instead of a stack trace.
 */
export function findCorpusDir(): string | undefined {
  for (const candidate of [fromPackage(), fromSiblingCheckout()]) {
    if (candidate != null && existsSync(candidate)) return candidate
  }
  return undefined
}

/** What to tell someone whose checkout has no corpus. */
export const CORPUS_MISSING_MESSAGE =
  'No .moqtrace corpus found. It ships in @moqtap/test-vectors under trace/; ' +
  'while it is unreleased, clone github.com/moqtap/test-vectors beside this repository.'
