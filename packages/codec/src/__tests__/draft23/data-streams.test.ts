import { describe, expect, it } from 'vitest'
import {
  createDraft23Codec,
  malformedTrackPropertiesReason,
  malformedTrackReason,
} from '../../drafts/draft23/codec.js'
import { SessionTerminationCode as Close } from '../../drafts/draft23/error-codes.js'
import type {
  DatagramObject,
  Draft23DataStream,
  FetchStream,
  SubgroupStream,
} from '../../drafts/draft23/types.js'
import {
  bytesToHex,
  endpointRefuses,
  expectPropertyList,
  hexToBytes,
  loadVectorDir,
} from '../helpers.js'

const codec = createDraft23Codec()

const vectorEntries = loadVectorDir('transport/draft23/codec/data-streams')

/** See the note in messages.test.ts — these counts guard against silent skips. */
const EXPECTED_FILES = 3
const EXPECTED_VECTORS = 73

describe('draft-23 data stream vector corpus', () => {
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

/**
 * The session termination code each refusing vector closes with, keyed
 * `file/id`. `null` marks a vector that decodes but makes the Track malformed
 * (Section 12.1), which is not a session close. Vectors marked `incomplete`
 * are left out: they name no code.
 *
 *  - Section 11.2.1: Type Flags with "bit 4 set, or ... a bit set whose meaning
 *    is not specified" and "both the STATUS bit (0x20) and END_OF_GROUP bit
 *    (0x02) set" close with INVALID_STREAM_HEADER, and "the PROPERTIES bit set
 *    and an Properties Length of 0" with MALFORMED_OBJECT.
 *  - Section 11.3.1: SUBGROUP_ID_MODE 0b11, bit 4 not set and values of 128 or
 *    greater close with INVALID_STREAM_HEADER.
 *  - Section 11.4.1: "If an endpoint receives any other value greater than
 *    127, it MUST close the session with MALFORMED_OBJECT."
 *  - Section 11.4.1.1, Section 11.4.2.1: an ID above 2^64-1 closes with
 *    DELTA_ENCODING_OVERFLOW.
 *  - Section 11.1.2: Properties on an Object whose status is not Normal close
 *    with INVALID_OBJECT_STATUS.
 *  - Section 12.2: MALFORMED_OBJECT, "The serialization of an Object on a data
 *    stream or in a datagram cannot be decoded", for bytes after a status
 *    datagram's Object Status.
 */
const CLOSE_CODES: Readonly<Record<string, bigint | null>> = {
  'datagram.json/status-datagram-with-payload': Close.MalformedObject,
  'datagram.json/reserved-bit-4-set': Close.InvalidStreamHeader,
  'datagram.json/status-and-end-of-group': Close.InvalidStreamHeader,
  'datagram.json/unspecified-bit-set': Close.InvalidStreamHeader,
  'datagram.json/type-flags-above-127': Close.InvalidStreamHeader,
  'datagram.json/properties-bit-with-zero-length': Close.MalformedObject,
  'datagram.json/status-and-properties-non-normal': Close.InvalidObjectStatus,
  'fetch-header.json/end-of-group-then-object-id-overflow': Close.DeltaEncodingOverflow,
  'fetch-header.json/end-of-range-object-id-overflow': Close.DeltaEncodingOverflow,
  'fetch-header.json/object-id-delta-plus-two-overflow': Close.DeltaEncodingOverflow,
  'fetch-header.json/invalid-serialization-flags': Close.MalformedObject,
  'fetch-header.json/invalid-serialization-flags-0x82': Close.MalformedObject,
  'subgroup.json/subgroup-properties-status-object': Close.InvalidObjectStatus,
  'subgroup.json/reserved-subgroup-id-mode': Close.InvalidStreamHeader,
  'subgroup.json/bit-4-not-set': Close.InvalidStreamHeader,
  'subgroup.json/type-flags-above-127': Close.InvalidStreamHeader,
  'subgroup.json/subgroup-properties-overrun': null,
  'subgroup.json/subgroup-prior-group-id-gap-exceeds-group-id': null,
  'subgroup.json/subgroup-prior-group-id-gap-differs': null,
  'subgroup.json/subgroup-prior-object-id-gap-exceeds-object-id': null,
}

describe('draft-23 data stream close codes', () => {
  it('has an entry for every refusing vector, and none for another', () => {
    const refusing = vectorEntries.flatMap(({ file, data }) =>
      data.vectors
        .filter((v) => v.error !== undefined && v.error !== 'incomplete')
        .map((v) => `${file}/${v.id}`),
    )
    expect(refusing.sort()).toEqual(Object.keys(CLOSE_CODES).sort())
  })
})

for (const { file, data: vectorFile } of vectorEntries) {
  const messageType = vectorFile.message_type

  describe(`draft-23 data stream: ${messageType} (${file})`, () => {
    for (const vector of vectorFile.vectors) {
      describe(`[${vector.id}] ${vector.description}`, () => {
        const bytes = hexToBytes(vector.hex)

        if (vector.error) {
          it('should fail to decode', () => {
            const streamType = getStreamType(file, vector)
            const result = codec.decodeDataStream(streamType, bytes)
            // An endpoint refuses what does not decode, and a Track whose
            // Object Properties make it malformed (Section 12.1).
            const refused =
              endpointRefuses(result, codec.decodeObjectProperties) ||
              (result.ok && malformedTrackReason(result.value) !== null)
            expect(refused).toBe(true)

            if (vector.error === 'incomplete') {
              expect(result.ok || result.error.closeCode).toBeUndefined()
              return
            }
            const expected = CLOSE_CODES[`${file}/${vector.id}`]
            if (expected === null) {
              expect(result.ok && malformedTrackReason(result.value)).toBeTruthy()
            } else {
              expect(result.ok || result.error.closeCode).toBe(expected)
            }
          })
        } else if (vector.decoded) {
          const decoded = vector.decoded
          const streamType = getStreamType(file, vector)

          it('should decode correctly', () => {
            const result = decodeByStreamType(streamType, bytes)
            expect(result.ok).toBe(true)
            if (!result.ok) return

            assertDataStreamMatch(result.value, decoded, streamType)
            expect(malformedTrackReason(result.value as Draft23DataStream)).toBeNull()
          })

          if (vector.canonical !== false) {
            it('should re-encode to same bytes', () => {
              const result = decodeByStreamType(streamType, bytes)
              if (!result.ok) {
                expect.fail('decode failed')
                return
              }

              const reEncoded = encodeByStreamType(streamType, result.value)
              expect(bytesToHex(reEncoded)).toBe(vector.hex)
            })
          }
        }
      })
    }
  })
}

/**
 * Which decoder a vector belongs to: its `decoded.stream_type`, or the file name
 * for an error vector, which has no `decoded` block. The first byte is no guide:
 * `reserved-bit-4-set` starts with an invalid SUBGROUP_HEADER byte.
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

function decodeByStreamType(streamType: 'subgroup' | 'datagram' | 'fetch', bytes: Uint8Array) {
  switch (streamType) {
    case 'subgroup':
      return codec.decodeSubgroupStream(bytes)
    case 'datagram':
      return codec.decodeDatagram(bytes)
    case 'fetch':
      return codec.decodeFetchStream(bytes)
  }
}

function encodeByStreamType(
  streamType: 'subgroup' | 'datagram' | 'fetch',
  value: unknown,
): Uint8Array {
  switch (streamType) {
    case 'subgroup':
      return codec.encodeSubgroupStream(value as SubgroupStream)
    case 'datagram':
      return codec.encodeDatagram(value as DatagramObject)
    case 'fetch':
      return codec.encodeFetchStream(value as FetchStream)
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

/**
 * The incremental fetch decoder against the one-shot one, on every fetch vector
 * the corpus decodes: the End of Group, End of Track and End of Range rules
 * carry state from one entry to the next, which a sweep of single-flag fixtures
 * does not exercise.
 */
describe('draft-23 fetch stream: streaming agrees with one-shot on the corpus', () => {
  async function drain(
    chunks: readonly Uint8Array[],
  ): Promise<{ objects: unknown[]; error: unknown }> {
    const decoder = codec.createFetchStreamDecoder()
    const objects: unknown[] = []
    let error: unknown
    const reader = decoder.readable.getReader()
    const collect = (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          if (value.type === 'object') objects.push(value)
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
    return { objects, error }
  }

  const fetchVectors = vectorEntries
    .filter((e) => e.file === 'fetch-header.json')
    .flatMap((e) => e.data.vectors)
    .filter((v) => v.decoded !== undefined)

  it('has fetch vectors to compare', () => {
    expect(fetchVectors.length).toBeGreaterThan(10)
  })

  for (const vector of fetchVectors) {
    it(`[${vector.id}] whole and byte by byte`, async () => {
      const bytes = hexToBytes(vector.hex)
      const one = codec.decodeFetchStream(bytes)
      expect(one.ok).toBe(true)
      if (!one.ok) return
      for (const chunks of [[bytes], Array.from(bytes, (b) => new Uint8Array([b]))]) {
        const streamed = await drain(chunks)
        expect(streamed.error).toBeUndefined()
        expect(streamed.objects).toEqual(one.value.objects)
      }
    })
  }
})

/** Write `bytes` to a stream decoder, close it, and return the error it fails with. */
async function errorOnClose(
  decoder: TransformStream<Uint8Array, unknown>,
  bytes: Uint8Array,
): Promise<unknown> {
  const reader = decoder.readable.getReader()
  const drained = (async () => {
    try {
      for (;;) if ((await reader.read()).done) return undefined
    } catch (e) {
      return e
    }
  })()
  const writer = decoder.writable.getWriter()
  await writer.write(bytes).catch(() => {})
  await writer.close().catch(() => {})
  return drained
}

// draft-23 Section 11.3: "If a stream ends gracefully (i.e., the stream
// terminates with a FIN) in the middle of a serialized Object, the receiver
// SHOULD close the session with TRUNCATED_OBJECT."
describe('draft-23 streams that end in the middle of an Object (Section 11.3)', () => {
  it('fails a subgroup stream with TRUNCATED_OBJECT', async () => {
    // Header 0x10, alias 1, group 2, priority 0x80; Object delta 0, payload
    // length 5, two payload bytes.
    const error = await errorOnClose(
      codec.createSubgroupStreamDecoder(),
      hexToBytes('100102800005aabb'),
    )
    expect(error).toMatchObject({ code: 'UNEXPECTED_END', closeCode: Close.TruncatedObject })
  })

  it('fails a fetch stream with TRUNCATED_OBJECT', async () => {
    const whole = hexToBytes('05011c05028001aa')
    expect(codec.decodeFetchStream(whole).ok).toBe(true)
    const error = await errorOnClose(codec.createFetchStreamDecoder(), whole.subarray(0, -1))
    expect(error).toMatchObject({ code: 'UNEXPECTED_END', closeCode: Close.TruncatedObject })
  })

  it('names no code when the stream ends inside its header', async () => {
    const error = await errorOnClose(codec.createSubgroupStreamDecoder(), hexToBytes('1001'))
    expect(error).toMatchObject({ code: 'UNEXPECTED_END' })
    expect((error as { closeCode?: bigint }).closeCode).toBeUndefined()
  })
})

// draft-23 Section 3.7: "An Object received with a Mandatory Track Property as
// an Object Property is malformed (see Section 12.1)." and "Grease values
// (Section 13) in this range are not Mandatory Track Properties."
describe('draft-23 Mandatory Track Properties on an Object (Section 3.7)', () => {
  // Fetch entry 0x3C: Group 5, Object 2, priority 0x80, a 4-byte Properties
  // block holding one even Property, payload 0xAA.
  const withProperty = (typeHex: string) => hexToBytes(`05013c05028004${typeHex}0001aa`)

  it('makes the Track malformed for 0x4000', () => {
    const result = codec.decodeFetchStream(withProperty('c04000'))
    expect(result.ok && malformedTrackReason(result.value)).toMatch(/Mandatory Track Property/)
  })

  it('does not for the grease value 0x401D', () => {
    const result = codec.decodeFetchStream(withProperty('c0401d'))
    expect(result.ok).toBe(true)
    expect(result.ok && malformedTrackReason(result.value)).toBeNull()
  })
})

describe('draft-23 Track Properties in control messages (Section 8.4, Section 10.7)', () => {
  function trackPropertiesOf(hex: string) {
    const result = codec.decodeMessage(hexToBytes(hex))
    if (!result.ok) throw result.error
    if (result.value.type !== 'request_ok') throw new Error(result.value.type)
    expect(bytesToHex(codec.encodeMessage(result.value))).toBe(hex)
    return result.value.track_properties
  }

  it('keeps a repeated Property after the first, and calls the Track malformed', () => {
    // REQUEST_OK, no parameters, DEFAULT_PUBLISHER_PRIORITY 5 and then 7.
    const props = trackPropertiesOf('070500' + '0e050007')
    expect(props.default_publisher_priority).toBe(5n)
    expect(props.unknown?.map((u) => u.id)).toEqual(['0xe'])
    expect(malformedTrackPropertiesReason(props)).toMatch(/more than once/)
  })

  it('counts a Property inside Immutable Properties', () => {
    // Immutable Properties holding DEFAULT_PUBLISHER_PRIORITY 6, then the
    // mutable DEFAULT_PUBLISHER_PRIORITY 5.
    const props = trackPropertiesOf('070700' + '0b020e06' + '0305')
    expect(malformedTrackPropertiesReason(props)).toMatch(/more than once/)
  })

  it('calls an Object-only Property out of scope', () => {
    // PRIOR_GROUP_ID_GAP 2.
    expect(malformedTrackPropertiesReason(trackPropertiesOf('0703003c02'))).toMatch(/Object-only/)
  })

  it('returns null for one instance of each', () => {
    expect(malformedTrackPropertiesReason(trackPropertiesOf('0703000e05'))).toBeNull()
  })
})

// draft-23 Section 11.4.2.2 states no rule for an End of Group straight after
// another one; the decoder accepts it and reports the prior entry's Location.
describe('draft-23 End of Group after End of Group (Section 11.4.2.2)', () => {
  it('accepts it, with the prior Object ID 2^64-1', () => {
    // Fetch entry 0x1C: Group 5, Object 2, priority 0x80, payload 0xAA; then
    // End of Group twice.
    const result = codec.decodeFetchStream(hexToBytes('05011c05028001aa80808080'))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const [, first, second] = result.value.objects
    expect(first).toMatchObject({ serializationFlags: 0x80, groupId: 5n, objectId: 2n })
    expect(second).toMatchObject({
      serializationFlags: 0x80,
      groupId: 5n,
      objectId: 2n ** 64n - 1n,
    })
  })
})
