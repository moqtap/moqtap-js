/**
 * Every draft's data-stream walk, held to an externally-authored corpus.
 *
 * The walks in `src/drafts/data-walk.ts` are a second implementation of
 * something `@moqtap/codec` already implements. Fixtures built with the codec's
 * own *encoder* would catch a walk that disagrees with the encoder — most bugs —
 * but would agree with the codec for exactly the same wrong reasons if the codec
 * itself had the field order wrong, and could not catch a dialect row
 * transcribed from the wrong draft, because the encoder would have been asked
 * for that draft too. `@moqtap/test-vectors` was written against the drafts by
 * someone else: each vector is a hex string and the fields it decodes to, so
 * this walks bytes nobody here produced against ids nobody here computed.
 *
 * For every subgroup and fetch vector, in every draft:
 *
 *  - the Track Alias and Group ID off the header,
 *  - **every** object's Group ID, Object ID, payload length and Object Status,
 *    in order,
 *  - that the walk consumes the stream to its exact last byte.
 *
 * That last one is the load-bearing assertion. A dialect that skips the wrong
 * number of bytes still produces plausible ids for the first object and then
 * drifts, so an end-to-end byte count is what turns "looks right" into "is
 * right". The status assertion is the same idea aimed at the specific bug this
 * walk exists for: a zero-length object carries a status varint in the position
 * a payload would occupy, and missing it desynchronises everything after it.
 *
 * Datagrams are checked too, though they are the codec's own one-shot decoder
 * rather than a walk of ours — the adapter still has to pick the right fields
 * out, and drafts 07, 09 and 10 spell them differently from the rest.
 */

import { describe, expect, it } from 'vitest'
import { SUPPORTED_DRAFTS } from '../../draft/protocol.js'
import { NEED, newCursor } from '../../types.js'
import {
  adapterFor,
  big,
  expectedHeader,
  expectedObjects,
  hexToBytes,
  loadVectors,
  num,
  pad,
} from './corpus.js'

describe.each(
  SUPPORTED_DRAFTS.map((d) => ({ draft: d, name: `draft-${pad(d)}` })),
)('$name subgroup streams', ({ draft }) => {
  const vectors = loadVectors(draft, 'subgroup')

  it('has vectors to walk', () => {
    // A green suite that asserted nothing is the failure this file exists to
    // avoid elsewhere, so an empty corpus directory has to fail loudly.
    expect(vectors.length).toBeGreaterThan(0)
  })

  for (const v of vectors) {
    it(`walks ${v.id}`, () => {
      const a = adapterFor(draft)
      const b = hexToBytes(v.hex)
      const decoded = v.decoded as Record<string, unknown>

      // MoQT permits a non-minimal varint, so a type of `0x14` may legally
      // arrive as the two-byte `0x8014`, whose first byte is ≥ 0x80 and
      // sniffs as nothing. `'unknown'` is the documented outcome there, and
      // the header walk re-reads the field rather than trusting the sniff —
      // which is what the assertion below actually proves.
      const first = b[0] as number
      expect(a.sniff(first), 'first byte should sniff as a subgroup').toBe(
        first >= 0x80 ? 'unknown' : 'subgroup',
      )

      const head = a.readSubgroupHeader(b, 0)
      expect(head, 'header did not parse').not.toBe(NEED)
      if (head === NEED) return

      expect(head.trackAlias).toBe(big(decoded.track_alias))
      expect(head.groupId).toBe(big(decoded.group_id))
      const header = expectedHeader(decoded)
      expect(head.priority, 'publisher priority').toBe(header.priority)

      const want = expectedObjects(decoded, header)
      const cursor = newCursor()
      let p = head.next
      for (const [i, w] of want.entries()) {
        const got = a.readSubgroupObject(b, p, head, cursor)
        expect(got, `object ${i} did not parse`).not.toBe(NEED)
        if (got === NEED) return
        expect(got.objectId, `object ${i} id`).toBe(w.objectId)
        expect(got.groupId, `object ${i} group`).toBe(w.groupId)
        expect(got.payloadLength, `object ${i} payload length`).toBe(w.payloadLength)
        expect(got.status, `object ${i} status`).toBe(w.status)
        // The corpus states the resolved id; a first-object-id header resolves
        // only once its first object is read.
        const subgroup = head.subgroupIsFirstObjectId ? want[0]?.objectId : head.subgroupId
        expect(subgroup, 'subgroup id').toBe(w.subgroupId)
        p = got.next
      }
      // The whole stream, to the byte. A dialect that skips the wrong number
      // of bytes drifts rather than fails, and this is where the drift shows.
      expect(p, 'walk did not end on the last byte of the stream').toBe(b.length)
    })
  }
})

describe.each(
  SUPPORTED_DRAFTS.map((d) => ({ draft: d, name: `draft-${pad(d)}` })),
)('$name fetch streams', ({ draft }) => {
  const vectors = loadVectors(draft, 'fetch-header')

  it('has vectors to walk', () => {
    expect(vectors.length).toBeGreaterThan(0)
  })

  for (const v of vectors) {
    it(`walks ${v.id}`, () => {
      const a = adapterFor(draft)
      const b = hexToBytes(v.hex)
      const decoded = v.decoded as Record<string, unknown>

      expect(a.sniff(b[0] as number), 'first byte should sniff as a fetch').toBe('fetch')

      const head = a.readFetchHeader(b, 0)
      expect(head, 'header did not parse').not.toBe(NEED)
      if (head === NEED) return

      // `subscribe_id` through draft-10, `request_id` from draft-11. Same
      // field, same position, renamed.
      expect(head.requestId).toBe(big(decoded.request_id ?? decoded.subscribe_id))

      const want = expectedObjects(decoded)
      const cursor = newCursor()
      let p = head.next
      for (const [i, w] of want.entries()) {
        const got = a.readFetchObject(b, p, cursor)
        expect(got, `object ${i} did not parse`).not.toBe(NEED)
        if (got === NEED) return
        expect(got.objectId, `object ${i} id`).toBe(w.objectId)
        expect(got.groupId, `object ${i} group`).toBe(w.groupId)
        expect(got.payloadLength, `object ${i} payload length`).toBe(w.payloadLength)
        expect(got.status, `object ${i} status`).toBe(w.status)
        expect(got.marker === true, `object ${i} marker`).toBe(w.marker)
        // A marker has no priority or subgroup of its own; the corpus fills in
        // the codec's carried values, which are not on the wire.
        if (!w.marker) {
          expect(cursor.prevPriority, `object ${i} priority`).toBe(w.priority)
          expect(cursor.hadSubgroup ? cursor.prevSubgroupId : null, `object ${i} subgroup`).toBe(
            w.subgroupId,
          )
        }
        p = got.next
      }
      expect(p, 'walk did not end on the last byte of the stream').toBe(b.length)
    })
  }
})

describe.each(
  SUPPORTED_DRAFTS.map((d) => ({ draft: d, name: `draft-${pad(d)}` })),
)('$name datagrams', ({ draft }) => {
  const vectors = loadVectors(draft, 'datagram')

  it('has vectors to decode', () => {
    expect(vectors.length).toBeGreaterThan(0)
  })

  for (const v of vectors) {
    it(`counts ${v.id}`, () => {
      const a = adapterFor(draft)
      const b = hexToBytes(v.hex)
      const decoded = v.decoded as Record<string, unknown>

      const got = a.decodeDatagram(b)
      expect(got, 'datagram did not decode').not.toBeNull()
      if (got === null) return

      expect(got.trackAlias).toBe(big(decoded.track_alias))
      expect(got.groupId).toBe(big(decoded.group_id))
      expect(got.objectId).toBe(big(decoded.object_id) ?? 0n)
      expect(got.priority, 'publisher priority').toBe(num(decoded.publisher_priority) ?? -1)
      // Header plus payload is the whole datagram: byte totals are built from
      // this split, so an adapter that loses it loses the totals.
      expect(got.headerBytes + got.payloadBytes, 'bytes do not add up').toBe(b.length)
    })
  }
})
