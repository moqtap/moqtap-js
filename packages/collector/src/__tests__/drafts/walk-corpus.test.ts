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
 * For every subgroup and fetch vector, in all fourteen drafts:
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

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DRAFT_LOADERS } from '../../draft/loaders.js'
import { SUPPORTED_DRAFTS } from '../../draft/protocol.js'
import { type DraftAdapter, NEED, type ObjectCursor, type SupportedDraft } from '../../types.js'

const require_ = createRequire(import.meta.url)
const VECTORS = dirname(require_.resolve('@moqtap/test-vectors/manifest'))

interface Vector {
  readonly id: string
  readonly description?: string
  readonly hex: string
  readonly error?: unknown
  readonly decoded?: Record<string, unknown>
}

function loadVectors(draft: SupportedDraft, file: string): Vector[] {
  const path = resolve(VECTORS, `transport/draft${pad(draft)}/codec/data-streams/${file}.json`)
  const data = JSON.parse(readFileSync(path, 'utf8')) as { vectors: Vector[] }
  // Vectors carrying an `error` are the corpus's negative cases: bytes a
  // conforming decoder must reject. The walks have no failure variant to check
  // them with (see `data-walk.ts`), so they are skipped rather than asserted on
  // in a way that would pass for the wrong reason.
  return data.vectors.filter((v) => v.error === undefined && v.decoded !== undefined)
}

function pad(d: number): string {
  return d < 10 ? `0${d}` : `${d}`
}

function hexToBytes(hex: string): Uint8Array {
  const b = new Uint8Array(hex.length / 2)
  for (let i = 0; i < hex.length; i += 2) b[i / 2] = Number.parseInt(hex.slice(i, i + 2), 16)
  return b
}

/** The corpus writes every integer as a decimal string. */
function big(v: unknown): bigint | undefined {
  return typeof v === 'string' ? BigInt(v) : undefined
}

function num(v: unknown): number | undefined {
  return typeof v === 'string' ? Number(v) : undefined
}

/** What one object should look like, read out of the corpus and not out of us. */
interface Expected {
  readonly groupId?: bigint
  readonly objectId?: bigint
  readonly payloadLength?: number
  readonly status?: bigint
}

/**
 * The corpus spells the status two ways, and one of them lies.
 *
 * Drafts 07-14 write `object_status`; 15-20 write `status`. Both are read,
 * because reading one name would silently skip the assertion on seven drafts and
 * a skipped assertion is indistinguishable from a passing one.
 *
 * The lie is in drafts 07-10, where `object_status: "0"` is reported on objects
 * that carry a payload and therefore **have no status field on the wire** —
 * `subgroup-single-object` is `04 01 00 00 80 | 00 04 deadbeef`, eleven bytes
 * with nowhere for a status to sit. It is the corpus stating a default, not the
 * bytes.
 *
 * So the wire rule decides, and it is the same rule in all fourteen drafts: the
 * Object Status occupies the position a payload would, so it is present exactly
 * when the Payload Length is zero. Verified across the whole corpus — no vector
 * in any draft reports a status alongside a non-zero length except those four
 * defaults.
 */
function expectedStatus(o: Record<string, unknown>): bigint | undefined {
  if (num(o.payload_length) !== 0) return undefined
  return big(o.status) ?? big(o.object_status)
}

function expectedObjects(decoded: Record<string, unknown>, headerGroup?: bigint): Expected[] {
  const raw = decoded.objects
  if (!Array.isArray(raw)) return []
  return raw.map((o: Record<string, unknown>) => {
    const e: Record<string, unknown> = {
      objectId: big(o.object_id),
      payloadLength: num(o.payload_length),
    }
    e.groupId = big(o.group_id) ?? headerGroup
    const status = expectedStatus(o)
    if (status !== undefined) e.status = status
    return e as Expected
  })
}

const ADAPTERS = new Map<SupportedDraft, DraftAdapter>()

async function adapterFor(draft: SupportedDraft): Promise<DraftAdapter> {
  const cached = ADAPTERS.get(draft)
  if (cached !== undefined) return cached
  const mod = await DRAFT_LOADERS[draft]()
  ADAPTERS.set(draft, mod.adapter)
  return mod.adapter
}

function newCursor(): ObjectCursor {
  return { first: true, prevGroupId: 0n, prevObjectId: 0n }
}

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
    it(`walks ${v.id}`, async () => {
      const a = await adapterFor(draft)
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

      const want = expectedObjects(decoded, head.groupId)
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
    it(`walks ${v.id}`, async () => {
      const a = await adapterFor(draft)
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
    it(`counts ${v.id}`, async () => {
      const a = await adapterFor(draft)
      const b = hexToBytes(v.hex)
      const decoded = v.decoded as Record<string, unknown>

      const got = a.decodeDatagram(b)
      expect(got, 'datagram did not decode').not.toBeNull()
      if (got === null) return

      expect(got.trackAlias).toBe(big(decoded.track_alias))
      expect(got.groupId).toBe(big(decoded.group_id))
      expect(got.objectId).toBe(big(decoded.object_id) ?? 0n)
      // Header plus payload is the whole datagram: byte totals are built from
      // this split, so an adapter that loses it loses the totals.
      expect(got.headerBytes + got.payloadBytes, 'bytes do not add up').toBe(b.length)
    })
  }
})
