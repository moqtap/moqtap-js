/**
 * Every draft's error-code registries have to be reachable from that draft's
 * entry point.
 *
 * The constants live in a per-draft `error-codes` module, but a consumer only
 * ever sees what `index.ts` re-exports, and the two lists drifting apart is not
 * hypothetical: draft-17's registries were written, committed and then left
 * unexported, so the constants sat in the published package with no way to name
 * them from outside their own file. A test that imported `error-codes.js`
 * directly would have stayed green through all of it, which is why every case
 * below reads the entry point and consults the registry module only for the
 * list of names it should have found there.
 */

import { describe, expect, it } from 'vitest'
import * as draft07Codes from '../drafts/draft07/error-codes.js'
import * as draft07Entry from '../drafts/draft07/index.js'
import * as draft08Codes from '../drafts/draft08/error-codes.js'
import * as draft08Entry from '../drafts/draft08/index.js'
import * as draft09Codes from '../drafts/draft09/error-codes.js'
import * as draft09Entry from '../drafts/draft09/index.js'
import * as draft10Codes from '../drafts/draft10/error-codes.js'
import * as draft10Entry from '../drafts/draft10/index.js'
import * as draft11Codes from '../drafts/draft11/error-codes.js'
import * as draft11Entry from '../drafts/draft11/index.js'
import * as draft12Codes from '../drafts/draft12/error-codes.js'
import * as draft12Entry from '../drafts/draft12/index.js'
import * as draft13Codes from '../drafts/draft13/error-codes.js'
import * as draft13Entry from '../drafts/draft13/index.js'
import * as draft14Codes from '../drafts/draft14/error-codes.js'
import * as draft14Entry from '../drafts/draft14/index.js'
import * as draft15Codes from '../drafts/draft15/error-codes.js'
import * as draft15Entry from '../drafts/draft15/index.js'
import * as draft16Codes from '../drafts/draft16/error-codes.js'
import * as draft16Entry from '../drafts/draft16/index.js'
import * as draft17Codes from '../drafts/draft17/error-codes.js'
import * as draft17Entry from '../drafts/draft17/index.js'
import * as draft18Codes from '../drafts/draft18/error-codes.js'
import * as draft18Entry from '../drafts/draft18/index.js'
import * as draft19Codes from '../drafts/draft19/error-codes.js'
import * as draft19Entry from '../drafts/draft19/index.js'
import * as draft20Codes from '../drafts/draft20/error-codes.js'
import * as draft20Entry from '../drafts/draft20/index.js'
import * as draft21Codes from '../drafts/draft21/error-codes.js'
import * as draft21Entry from '../drafts/draft21/index.js'

type Module = Record<string, unknown>

interface Case {
  draft: string
  entry: Module
  codes: Module
}

const CASES: Case[] = [
  { draft: '07', entry: draft07Entry, codes: draft07Codes },
  { draft: '08', entry: draft08Entry, codes: draft08Codes },
  { draft: '09', entry: draft09Entry, codes: draft09Codes },
  { draft: '10', entry: draft10Entry, codes: draft10Codes },
  { draft: '11', entry: draft11Entry, codes: draft11Codes },
  { draft: '12', entry: draft12Entry, codes: draft12Codes },
  { draft: '13', entry: draft13Entry, codes: draft13Codes },
  { draft: '14', entry: draft14Entry, codes: draft14Codes },
  { draft: '15', entry: draft15Entry, codes: draft15Codes },
  { draft: '16', entry: draft16Entry, codes: draft16Codes },
  { draft: '17', entry: draft17Entry, codes: draft17Codes },
  { draft: '18', entry: draft18Entry, codes: draft18Codes },
  { draft: '19', entry: draft19Entry, codes: draft19Codes },
  { draft: '20', entry: draft20Entry, codes: draft20Codes },
  { draft: '21', entry: draft21Entry, codes: draft21Codes },
]

/** A registry is a frozen object of code points; draft-20 also exports Sets. */
function isRegistry(value: unknown): value is Record<string, bigint> {
  return typeof value === 'object' && value !== null && !(value instanceof Set)
}

describe('error-code registries', () => {
  it('covers every draft the package ships', () => {
    expect(CASES.map((c) => c.draft)).toEqual([
      '07',
      '08',
      '09',
      '10',
      '11',
      '12',
      '13',
      '14',
      '15',
      '16',
      '17',
      '18',
      '19',
      '20',
      '21',
    ])
  })

  it.each(CASES)('draft-$draft re-exports every registry from its entry point', ({
    entry,
    codes,
  }) => {
    const names = Object.keys(codes)
    expect(names.length).toBeGreaterThan(0)
    for (const name of names) {
      expect(entry[name]).toBe(codes[name])
    }
  })

  it.each(CASES)('draft-$draft assigns each code point once per registry', ({ codes }) => {
    let checked = 0
    for (const registry of Object.values(codes)) {
      if (!isRegistry(registry)) continue
      const values = Object.values(registry)
      expect(values.length).toBeGreaterThan(0)
      for (const value of values) {
        expect(typeof value).toBe('bigint')
      }
      expect(new Set(values).size).toBe(values.length)
      checked++
    }
    expect(checked).toBeGreaterThan(0)
  })
})
