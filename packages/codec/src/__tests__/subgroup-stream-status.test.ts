/**
 * The Object Status varint that follows a zero-length Object, read through the
 * *streaming* decoders.
 *
 * draft-20 Section 11.4.2: "The Object Status field is only sent if the Object
 * Payload Length is zero." A decoder that reads the length, sees zero, and goes
 * straight on to the next Object leaves that varint in the stream, where it is
 * taken for the next Object's Object ID Delta. One status Object therefore
 * desynchronises the rest of the stream, silently — so what has to be asserted
 * is not the status Object itself but the Object *after* it.
 *
 * The one-shot decoders have always handled this; only the incremental
 * transforms were missing it, and nothing exercised them. Every draft that has a
 * streaming decoder is covered here, including the ones that were already
 * correct, so the two paths cannot drift apart again.
 */

import { describe, expect, it } from 'vitest'
import {
  createSubgroupStreamDecoder as createDecoder14,
  decodeSubgroupStream as decodeOneShot14,
} from '../drafts/draft14/index.js'
import {
  createSubgroupStreamDecoder as createDecoder15,
  createFetchStreamDecoder as createFetchDecoder15,
  decodeFetchStream as decodeFetchOneShot15,
  decodeSubgroupStream as decodeOneShot15,
} from '../drafts/draft15/index.js'
import {
  createSubgroupStreamDecoder as createDecoder16,
  decodeSubgroupStream as decodeOneShot16,
} from '../drafts/draft16/index.js'
import {
  createSubgroupStreamDecoder as createDecoder17,
  decodeSubgroupStream as decodeOneShot17,
} from '../drafts/draft17/index.js'
import {
  createSubgroupStreamDecoder as createDecoder18,
  decodeSubgroupStream as decodeOneShot18,
} from '../drafts/draft18/index.js'
import {
  createSubgroupStreamDecoder as createDecoder19,
  decodeSubgroupStream as decodeOneShot19,
} from '../drafts/draft19/index.js'
import {
  createSubgroupStreamDecoder as createDecoder20,
  decodeSubgroupStream as decodeOneShot20,
} from '../drafts/draft20/index.js'
import { bytesToHex, hexToBytes } from './helpers.js'

interface StreamingDraft {
  readonly draft: string
  readonly createDecoder: () => TransformStream<Uint8Array, unknown>
  readonly decodeOneShot: (bytes: Uint8Array) => {
    ok: boolean
    value?: unknown
    error?: unknown
  }
  /**
   * A two-byte encoding of the status value 0, in this draft's varint.
   *
   * Drafts 14 to 16 use QUIC's two-bit length prefix, where `01` opens a
   * two-byte integer; draft-17 replaced it with vi64's leading-ones prefix,
   * where `10` does. Both forms are non-minimal for a value of 0 and Section
   * 1.4.1 permits that, which is what makes them useful here: every status this
   * document defines fits in one byte, so a non-minimal encoding is the only way
   * to split a status varint itself across two feeds.
   */
  readonly twoByteStatus: string
}

/**
 * Every draft whose codec exposes a streaming subgroup decoder. Drafts 07 to 13
 * decode a subgroup stream only in one shot, so there is nothing to cover there.
 */
const STREAMING_DRAFTS: readonly StreamingDraft[] = [
  {
    draft: '14',
    createDecoder: createDecoder14,
    decodeOneShot: decodeOneShot14,
    twoByteStatus: '4000',
  },
  {
    draft: '15',
    createDecoder: createDecoder15,
    decodeOneShot: decodeOneShot15,
    twoByteStatus: '4000',
  },
  {
    draft: '16',
    createDecoder: createDecoder16,
    decodeOneShot: decodeOneShot16,
    twoByteStatus: '4000',
  },
  {
    draft: '17',
    createDecoder: createDecoder17,
    decodeOneShot: decodeOneShot17,
    twoByteStatus: '8000',
  },
  {
    draft: '18',
    createDecoder: createDecoder18,
    decodeOneShot: decodeOneShot18,
    twoByteStatus: '8000',
  },
  {
    draft: '19',
    createDecoder: createDecoder19,
    decodeOneShot: decodeOneShot19,
    twoByteStatus: '8000',
  },
  {
    draft: '20',
    createDecoder: createDecoder20,
    decodeOneShot: decodeOneShot20,
    twoByteStatus: '8000',
  },
]

/**
 * A subgroup stream whose middle Object is a zero-length status Object.
 *
 *   10          SUBGROUP_HEADER type 0x10 — no properties, Subgroup ID is 0,
 *               Publisher Priority present
 *   01 00 80    Track Alias 1, Group ID 0, Publisher Priority 128
 *   00 04 dead… Object ID Delta 0 → Object ID 0, 4-byte payload
 *   00 00 00    Object ID Delta 0 → Object ID 1, Payload Length 0, Status 0
 *   00 02 cafe  Object ID Delta 0 → Object ID 2, 2-byte payload
 *
 * Status 0 (Normal) is the status a zero-length Object carries when it is not
 * marking an end of anything — draft-20 Section 11.2.1.1: "Zero-length objects
 * explicitly encode the Normal status" — so the third Object following it is
 * ordinary, not a stream that should have ended.
 *
 * The header and Object layouts are byte-identical across drafts 14 to 20 for
 * this combination of flags, which is why one string serves all of them; each
 * draft's own one-shot decoder is asserted against it too, so a draft that did
 * lay these bytes out differently would fail loudly rather than silently.
 */
const STATUS_IN_THE_MIDDLE = '100100800004deadbeef0000000002cafe'

/** `STATUS_IN_THE_MIDDLE` with the status written as a two-byte varint. */
function statusAsTwoByteVarint(twoByteStatus: string): string {
  return `100100800004deadbeef0000${twoByteStatus}0002cafe`
}

interface DecodedObject {
  objectId: bigint
  payloadLength: number
  payload: Uint8Array
  status?: bigint
}

/** The three Objects `STATUS_IN_THE_MIDDLE` carries, in order. */
const EXPECTED_OBJECTS = [
  { objectId: 0n, payloadLength: 4, payloadHex: 'deadbeef', status: undefined },
  { objectId: 1n, payloadLength: 0, payloadHex: '', status: 0n },
  { objectId: 2n, payloadLength: 2, payloadHex: 'cafe', status: undefined },
] as const

/**
 * Push `chunks` through a decoder and collect what comes out.
 *
 * The reader runs concurrently with the writes so that a decoder which enqueues
 * more than the default queue holds cannot deadlock the writer, and an error on
 * the readable is returned rather than thrown — a desynchronised stream tends to
 * end in one, and the object list is the more useful thing to report.
 */
async function drain(
  decoder: TransformStream<Uint8Array, unknown>,
  chunks: readonly Uint8Array[],
): Promise<{ events: Record<string, unknown>[]; error: unknown }> {
  const events: Record<string, unknown>[] = []
  let error: unknown
  const reader = decoder.readable.getReader()
  const collect = (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        events.push(value as Record<string, unknown>)
      }
    } catch (e) {
      error = e
    }
  })()
  const writer = decoder.writable.getWriter()
  try {
    for (const chunk of chunks) await writer.write(chunk)
    await writer.close()
  } catch (e) {
    error ??= e
  }
  await collect
  return { events, error }
}

/** The `object` events from a drained decoder, dropping the header event. */
function objectsOf(events: readonly Record<string, unknown>[]): DecodedObject[] {
  return events.filter((e) => e.type === 'object') as unknown as DecodedObject[]
}

function assertExpectedObjects(objects: readonly DecodedObject[], label: string): void {
  expect(objects.length, `${label}: object count`).toBe(EXPECTED_OBJECTS.length)
  for (const [i, expected] of EXPECTED_OBJECTS.entries()) {
    const actual = objects[i]
    expect(actual, `${label}: objects[${i}] missing`).toBeDefined()
    if (!actual) continue
    expect(actual.objectId, `${label}: objects[${i}].objectId`).toBe(expected.objectId)
    expect(actual.payloadLength, `${label}: objects[${i}].payloadLength`).toBe(
      expected.payloadLength,
    )
    expect(bytesToHex(actual.payload), `${label}: objects[${i}].payload`).toBe(expected.payloadHex)
    expect(actual.status, `${label}: objects[${i}].status`).toBe(expected.status)
  }
}

/** Every way of cutting `bytes` into two feeds, plus one byte at a time. */
function chunkings(bytes: Uint8Array): { label: string; chunks: Uint8Array[] }[] {
  const splits = Array.from({ length: bytes.length - 1 }, (_, i) => ({
    label: `split after byte ${i + 1}`,
    chunks: [bytes.subarray(0, i + 1), bytes.subarray(i + 1)],
  }))
  return [
    { label: 'one chunk', chunks: [bytes] },
    ...splits,
    {
      label: 'one byte at a time',
      chunks: Array.from({ length: bytes.length }, (_, i) => bytes.subarray(i, i + 1)),
    },
  ]
}

for (const { draft, createDecoder, decodeOneShot, twoByteStatus } of STREAMING_DRAFTS) {
  describe(`draft-${draft} streaming subgroup decoder: Object Status`, () => {
    const bytes = hexToBytes(STATUS_IN_THE_MIDDLE)

    it('decodes the Object after a status Object', async () => {
      const { events, error } = await drain(createDecoder(), [bytes])
      expect(error, 'stream errored').toBeUndefined()
      expect(events[0]?.type, 'first event is the header').toBe('subgroup_header')
      assertExpectedObjects(objectsOf(events), 'streamed')
    })

    it('agrees with the one-shot decoder', () => {
      const result = decodeOneShot(bytes)
      expect(result.ok, 'one-shot decode failed').toBe(true)
      if (!result.ok) return
      const stream = result.value as { objects: DecodedObject[] }
      assertExpectedObjects(stream.objects, 'one-shot')
    })

    // A status varint that arrives in a later feed than its Object Payload
    // Length is the second way this goes wrong: the decoder must hold the
    // Object back rather than emit it and resume in the middle of the status.
    it('decodes the same however the bytes are chunked', async () => {
      for (const { label, chunks } of chunkings(bytes)) {
        const { events, error } = await drain(createDecoder(), chunks)
        expect(error, `${label}: stream errored`).toBeUndefined()
        assertExpectedObjects(objectsOf(events), label)
      }
    })

    it('holds back an Object whose status varint is split across feeds', async () => {
      const wide = hexToBytes(statusAsTwoByteVarint(twoByteStatus))
      // The status varint sits at bytes 12-13; cut between them.
      expect(bytesToHex(wide.subarray(12, 14)), 'status varint position').toBe(twoByteStatus)
      const { events, error } = await drain(createDecoder(), [
        wide.subarray(0, 13),
        wide.subarray(13),
      ])
      expect(error, 'stream errored').toBeUndefined()
      assertExpectedObjects(objectsOf(events), 'split status varint')
    })
  })
}

/**
 * The same rule on a fetch stream, which only draft-15 needs.
 *
 * draft-14 and draft-15 serialize an Object Status on a fetch stream the same
 * way a subgroup stream does. From draft-16 the field is gone from fetch
 * altogether — draft-20 Section 11.2.1.1: the Object Status "is only present in
 * objects that are delivered via a SUBSCRIPTION, and is absent in Objects
 * delivered via a FETCH" — so drafts 16 and later read a zero Payload Length as
 * simply an empty payload, and their encoders write nothing after it. draft-14's
 * streaming fetch decoder already had the branch; draft-15's did not.
 *
 *   05 04       fetch stream type 0x05, Request ID 4
 *   1c 00 00 80 flags 0x1c (Group ID, Object ID and Priority present),
 *               Group ID 0, Object ID 0, Publisher Priority 128
 *   04 deadbeef Payload Length 4 and its payload
 *   04 01 00 00 flags 0x04 (Object ID only), Object ID 1, Length 0, Status 0
 *   04 02 02 ca… flags 0x04, Object ID 2, Length 2, payload cafe
 */
const FETCH_STATUS_IN_THE_MIDDLE = '05041c00008004deadbeef04010000040202cafe'

const EXPECTED_FETCH_OBJECTS = [
  { objectId: 0n, payloadLength: 4, payloadHex: 'deadbeef', status: undefined },
  { objectId: 1n, payloadLength: 0, payloadHex: '', status: 0n },
  { objectId: 2n, payloadLength: 2, payloadHex: 'cafe', status: undefined },
] as const

describe('draft-15 streaming fetch decoder: Object Status', () => {
  const bytes = hexToBytes(FETCH_STATUS_IN_THE_MIDDLE)

  function assertFetchObjects(objects: readonly DecodedObject[], label: string): void {
    expect(objects.length, `${label}: object count`).toBe(EXPECTED_FETCH_OBJECTS.length)
    for (const [i, expected] of EXPECTED_FETCH_OBJECTS.entries()) {
      const actual = objects[i]
      expect(actual, `${label}: objects[${i}] missing`).toBeDefined()
      if (!actual) continue
      expect(actual.objectId, `${label}: objects[${i}].objectId`).toBe(expected.objectId)
      expect(actual.payloadLength, `${label}: objects[${i}].payloadLength`).toBe(
        expected.payloadLength,
      )
      expect(bytesToHex(actual.payload), `${label}: objects[${i}].payload`).toBe(
        expected.payloadHex,
      )
      expect(actual.status, `${label}: objects[${i}].status`).toBe(expected.status)
    }
  }

  it('decodes the Object after a status Object', async () => {
    const { events, error } = await drain(createFetchDecoder15(), [bytes])
    expect(error, 'stream errored').toBeUndefined()
    expect(events[0]?.type, 'first event is the header').toBe('fetch_header')
    assertFetchObjects(objectsOf(events), 'streamed')
  })

  it('agrees with the one-shot decoder', () => {
    const result = decodeFetchOneShot15(bytes)
    expect(result.ok, 'one-shot decode failed').toBe(true)
    if (!result.ok) return
    assertFetchObjects((result.value as { objects: DecodedObject[] }).objects, 'one-shot')
  })

  it('decodes the same however the bytes are chunked', async () => {
    for (const { label, chunks } of chunkings(bytes)) {
      const { events, error } = await drain(createFetchDecoder15(), chunks)
      expect(error, `${label}: stream errored`).toBeUndefined()
      assertFetchObjects(objectsOf(events), label)
    }
  })
})
