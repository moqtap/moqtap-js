import { describe, expect, it } from 'vitest'
import type { FetchGroupOrder } from '../../core/group-order.js'
import { createDraft21Codec, malformedTrackReason } from '../../drafts/draft21/codec.js'
import type {
  DatagramObject,
  Draft21DataStream,
  FetchStream,
  SubgroupStream,
} from '../../drafts/draft21/types.js'
import {
  bytesToHex,
  endpointRefuses,
  expectPropertyList,
  fetchGroupOrder,
  hexToBytes,
  loadVectorDir,
} from '../helpers.js'

const codec = createDraft21Codec()

const vectorEntries = loadVectorDir('transport/draft21/codec/data-streams')

/** See the note in messages.test.ts — these counts guard against silent skips. */
const EXPECTED_FILES = 3
const EXPECTED_VECTORS = 68

describe('draft-21 data stream vector corpus', () => {
  it('loads every published data-stream vector file', () => {
    expect(vectorEntries.map((e) => e.file).sort()).toEqual([
      'datagram.json',
      'fetch-header.json',
      'subgroup.json',
    ])
    expect(vectorEntries.length).toBe(EXPECTED_FILES)
  })

  it('executes every vector in them', () => {
    const total = vectorEntries.reduce((n, e) => n + e.data.vectors.length, 0)
    expect(total).toBe(EXPECTED_VECTORS)
    for (const { file, data } of vectorEntries) {
      for (const vector of data.vectors) {
        expect(
          Boolean(vector.decoded) !== Boolean(vector.error),
          `${file} [${vector.id}] must declare exactly one of decoded/error`,
        ).toBe(true)
      }
    }
  })
})

for (const { file, data: vectorFile } of vectorEntries) {
  const messageType = vectorFile.message_type

  describe(`draft-21 data stream: ${messageType} (${file})`, () => {
    for (const vector of vectorFile.vectors) {
      describe(`[${vector.id}] ${vector.description}`, () => {
        const bytes = hexToBytes(vector.hex)

        if (vector.error) {
          it('should fail to decode', () => {
            const streamType = getStreamType(file, vector)
            const result =
              streamType === 'fetch'
                ? codec.decodeFetchStream(bytes, fetchGroupOrder(vector))
                : codec.decodeDataStream(streamType, bytes)
            // An endpoint refuses what does not decode, and a Track whose
            // Prior Gaps make it malformed (Section 12.1).
            const refused =
              endpointRefuses(result, codec.decodeObjectProperties) ||
              (result.ok && malformedTrackReason(result.value) !== null)
            expect(refused).toBe(true)
          })
        } else if (vector.decoded) {
          const decoded = vector.decoded
          const streamType = getStreamType(file, vector)

          it('should decode correctly', () => {
            const result = decodeByStreamType(streamType, bytes, fetchGroupOrder(vector))
            expect(result.ok).toBe(true)
            if (!result.ok) return

            assertDataStreamMatch(result.value, decoded, streamType)
            expect(malformedTrackReason(result.value as Draft21DataStream)).toBeNull()
          })

          if (vector.canonical !== false) {
            it('should re-encode to same bytes', () => {
              const result = decodeByStreamType(streamType, bytes, fetchGroupOrder(vector))
              if (!result.ok) {
                expect.fail('decode failed')
                return
              }

              const reEncoded = encodeByStreamType(
                streamType,
                result.value,
                fetchGroupOrder(vector),
              )
              expect(bytesToHex(reEncoded)).toBe(vector.hex)
            })
          }
        }
      })
    }
  })
}

/**
 * Which decoder a vector belongs to.
 *
 * The published files all set `decoded.stream_type`, but an error vector has no
 * `decoded` block at all, so the file name is the fallback. Guessing from the
 * first byte would be wrong for exactly the vectors that matter here — the
 * whole point of `reserved-bit-4-set` is that its first byte is not a valid
 * SUBGROUP_HEADER.
 */
function getStreamType(
  file: string,
  vector: { decoded?: Record<string, unknown> },
): 'subgroup' | 'datagram' | 'fetch' {
  const declared = vector.decoded?.stream_type as string | undefined
  if (declared !== undefined) {
    if (declared === 'subgroup' || declared === 'subgroup_header') return 'subgroup'
    if (declared.startsWith('object_datagram') || declared === 'datagram') return 'datagram'
    if (declared === 'fetch' || declared === 'fetch_header') return 'fetch'
    throw new Error(`Unknown stream_type in vector: ${declared}`)
  }
  if (file.startsWith('subgroup')) return 'subgroup'
  if (file.startsWith('datagram')) return 'datagram'
  if (file.startsWith('fetch')) return 'fetch'
  throw new Error(`Cannot infer stream type for ${file}`)
}

function decodeByStreamType(
  streamType: 'subgroup' | 'datagram' | 'fetch',
  bytes: Uint8Array,
  groupOrder: FetchGroupOrder,
) {
  switch (streamType) {
    case 'subgroup':
      return codec.decodeSubgroupStream(bytes)
    case 'datagram':
      return codec.decodeDatagram(bytes)
    case 'fetch':
      return codec.decodeFetchStream(bytes, groupOrder)
  }
}

function encodeByStreamType(
  streamType: 'subgroup' | 'datagram' | 'fetch',
  value: unknown,
  groupOrder: FetchGroupOrder,
): Uint8Array {
  switch (streamType) {
    case 'subgroup':
      return codec.encodeSubgroupStream(value as SubgroupStream)
    case 'datagram':
      return codec.encodeDatagram(value as DatagramObject)
    case 'fetch':
      return codec.encodeFetchStream(value as FetchStream, groupOrder)
  }
}

/** snake_case vector key → camelCase codec field, for everything but `objects`. */
const TOP_LEVEL_FIELDS: Record<string, string> = {
  track_alias: 'trackAlias',
  group_id: 'groupId',
  subgroup_id: 'subgroupId',
  publisher_priority: 'publisherPriority',
  object_id: 'objectId',
  object_id_delta: 'objectIdDelta',
  request_id: 'requestId',
  end_of_group: 'endOfGroup',
  first_object: 'firstObject',
  object_status: 'objectStatus',
  payload_length: 'payloadLength',
}

const OBJECT_FIELDS: Record<string, string> = {
  object_id: 'objectId',
  object_id_delta: 'objectIdDelta',
  group_id: 'groupId',
  group_id_delta: 'groupIdDelta',
  subgroup_id: 'subgroupId',
  publisher_priority: 'publisherPriority',
  payload_length: 'payloadLength',
  object_status: 'status',
  status: 'status',
}

function assertDataStreamMatch(
  actual: unknown,
  expected: Record<string, unknown>,
  streamType: 'subgroup' | 'datagram' | 'fetch',
): void {
  const a = actual as Record<string, unknown>
  const seen = new Set<string>(['stream_type'])

  for (const [key, camel] of Object.entries(TOP_LEVEL_FIELDS)) {
    if (expected[key] === undefined) continue
    seen.add(key)
    expect(String(a[camel]), key).toBe(String(expected[key]))
  }

  if (expected.header_type !== undefined) {
    seen.add('header_type')
    expect(hexByte(a.headerType as number)).toBe(expected.header_type)
  }
  if (expected.datagram_type !== undefined) {
    seen.add('datagram_type')
    expect(hexByte(a.datagramType as number)).toBe(expected.datagram_type)
  }
  if (expected.object_properties !== undefined) {
    seen.add('object_properties')
    expectPropertyList(
      codec.decodeObjectProperties,
      a.extensionData as Uint8Array | undefined,
      expected.object_properties,
      'object_properties',
    )
  }
  if (expected.payload_hex !== undefined) {
    seen.add('payload_hex')
    expect(bytesToHex(a.payload as Uint8Array)).toBe(expected.payload_hex)
  }

  if (expected.objects !== undefined) {
    seen.add('objects')
    const actualObjects = a.objects as Array<Record<string, unknown>>
    const expectedObjects = expected.objects as Array<Record<string, unknown>>
    expect(actualObjects.length, 'object count').toBe(expectedObjects.length)

    for (let i = 0; i < expectedObjects.length; i++) {
      const ao = actualObjects[i]!
      const eo = expectedObjects[i]!
      const seenObj = new Set<string>()

      for (const [key, camel] of Object.entries(OBJECT_FIELDS)) {
        if (eo[key] === undefined) continue
        seenObj.add(key)
        expect(String(ao[camel]), `objects[${i}].${key}`).toBe(String(eo[key]))
      }
      if (eo.serialization_flags !== undefined) {
        seenObj.add('serialization_flags')
        expect(hexByte(ao.serializationFlags as number), `objects[${i}].serialization_flags`).toBe(
          eo.serialization_flags,
        )
      }
      if (eo.object_properties !== undefined) {
        seenObj.add('object_properties')
        expectPropertyList(
          codec.decodeObjectProperties,
          ao.extensionData as Uint8Array,
          eo.object_properties,
          `objects[${i}].object_properties`,
        )
      }
      if (eo.payload_hex !== undefined) {
        seenObj.add('payload_hex')
        expect(bytesToHex(ao.payload as Uint8Array), `objects[${i}].payload_hex`).toBe(
          eo.payload_hex,
        )
      }
      // No key in the vector may go unchecked: an unrecognised one would
      // otherwise be silently accepted.
      expect(
        Object.keys(eo).filter((k) => !seenObj.has(k)),
        `objects[${i}] has unasserted keys`,
      ).toEqual([])
    }
  }

  expect(
    Object.keys(expected).filter((k) => !seen.has(k)),
    `${streamType} vector has unasserted keys`,
  ).toEqual([])
}

function hexByte(value: number): string {
  return `0x${value.toString(16).padStart(2, '0')}`
}
