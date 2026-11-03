import { describe, expect, it } from 'vitest'
import { decodeFetchStream as decode11 } from '../drafts/draft11/data-streams.js'
import { decodeFetchStream as decode12 } from '../drafts/draft12/data-streams.js'
import { decodeFetchStream as decode13 } from '../drafts/draft13/data-streams.js'
import { decodeFetchStream as decode14 } from '../drafts/draft14/data-streams.js'
import { hexToBytes } from './helpers.js'

// Drafts 11-14: "Any Object may have extension headers except those with Object
// Status 'Object Does Not Exist'." A fetch Object always carries an extension
// block: FETCH_HEADER 05 01, then Group 5, Subgroup 0, Object 0, priority 0x80,
// a two-byte block 02 05, payload length 0 and the status.
const fetchWithStatus = (status: string) => hexToBytes(`050105000080020205000${status}`)

describe('extension headers on an Object Does Not Exist', () => {
  for (const [draft, decode] of [
    ['11', decode11],
    ['12', decode12],
    ['13', decode13],
    ['14', decode14],
  ] as const) {
    it(`draft-${draft} refuses them and keeps them on End of Group`, () => {
      expect(decode(fetchWithStatus('1')).ok).toBe(false)
      expect(decode(fetchWithStatus('3')).ok).toBe(true)
    })
  }
})
