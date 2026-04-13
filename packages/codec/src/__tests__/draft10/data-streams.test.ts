import { describe, expect, it } from 'vitest'
import { createDraft10Codec } from '../../drafts/draft10/codec.js'
import type {
  DatagramObject,
  DatagramStatusObject,
  FetchStream,
  SubgroupStream,
} from '../../drafts/draft10/types.js'
import { bytesToHex, hexToBytes, loadVectorDir } from '../helpers.js'

const codec = createDraft10Codec()

const vectorEntries = loadVectorDir('transport/draft10/codec/data-streams')

for (const { file, data: vectorFile } of vectorEntries) {
  const messageType = vectorFile.message_type

  describe(`draft-10 data stream: ${messageType} (${file})`, () => {
    for (const vector of vectorFile.vectors) {
      describe(`[${vector.id}] ${vector.description}`, () => {
        const bytes = hexToBytes(vector.hex)

        if (vector.error) {
          it('should fail to decode', () => {
            const streamType = getStreamType(messageType, vector)
            const result = codec.decodeDataStream(streamType, bytes)
            expect(result.ok).toBe(false)
          })
        } else if (vector.decoded) {
          const decoded = vector.decoded
          const streamType = getStreamType(messageType, vector)

          it('should decode correctly', () => {
            const result = decodeByStreamType(streamType, bytes)
            expect(result.ok).toBe(true)
            if (!result.ok) return

            assertDataStreamMatch(result.value, decoded, streamType)
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

function getStreamType(
  messageType: string,
  vector: { decoded?: Record<string, unknown> },
): 'subgroup' | 'datagram' | 'datagram_status' | 'fetch' {
  if (vector.decoded?.stream_type) {
    const st = vector.decoded.stream_type as string
    if (st === 'subgroup_header' || st === 'stream_header_subgroup') return 'subgroup'
    if (st === 'object_datagram') return 'datagram'
    if (st === 'object_datagram_status') return 'datagram_status'
    if (st === 'fetch_header') return 'fetch'
    return st as 'subgroup' | 'datagram' | 'datagram_status' | 'fetch'
  }
  if (messageType === 'object') return 'subgroup'
  if (messageType === 'fetch_header' || messageType === 'fetch-header') return 'fetch'
  return messageType as 'subgroup' | 'datagram' | 'datagram_status' | 'fetch'
}

function decodeByStreamType(streamType: string, bytes: Uint8Array) {
  switch (streamType) {
    case 'subgroup':
      return codec.decodeSubgroupStream(bytes)
    case 'datagram':
      return codec.decodeDatagram(bytes)
    case 'datagram_status':
      return codec.decodeDatagramStatus(bytes)
    case 'fetch':
      return codec.decodeFetchStream(bytes)
    default:
      throw new Error(`Unknown stream type: ${streamType}`)
  }
}

function encodeByStreamType(streamType: string, value: unknown): Uint8Array {
  switch (streamType) {
    case 'subgroup':
      return codec.encodeSubgroupStream(value as SubgroupStream)
    case 'datagram':
      return codec.encodeDatagram(value as DatagramObject)
    case 'datagram_status':
      return codec.encodeDatagramStatus(value as DatagramStatusObject)
    case 'fetch':
      return codec.encodeFetchStream(value as FetchStream)
    default:
      throw new Error(`Unknown stream type: ${streamType}`)
  }
}

function assertDataStreamMatch(
  actual: unknown,
  expected: Record<string, unknown>,
  _streamType: string,
): void {
  const a = actual as Record<string, unknown>

  if (expected.stream_type_id !== undefined) {
    expect(String(a.streamTypeId)).toBe(String(expected.stream_type_id))
  }
  if (expected.track_alias !== undefined) {
    expect(String(a.trackAlias)).toBe(String(expected.track_alias))
  }
  if (expected.group_id !== undefined) {
    expect(String(a.groupId)).toBe(String(expected.group_id))
  }
  if (expected.subgroup_id !== undefined) {
    expect(String(a.subgroupId)).toBe(String(expected.subgroup_id))
  }
  if (expected.publisher_priority !== undefined) {
    expect(String(a.publisherPriority)).toBe(String(expected.publisher_priority))
  }
  if (expected.object_id !== undefined) {
    expect(String(a.objectId)).toBe(String(expected.object_id))
  }
  if (expected.subscribe_id !== undefined && _streamType === 'fetch') {
    expect(String(a.subscribeId)).toBe(String(expected.subscribe_id))
  }
  if (expected.extension_headers_length !== undefined) {
    expect(String(a.extensionHeadersLength)).toBe(String(expected.extension_headers_length))
  }
  if (expected.object_status !== undefined) {
    expect(String(a.objectStatus)).toBe(String(expected.object_status))
  }

  if (expected.payload_hex !== undefined) {
    const payload = a.payload as Uint8Array
    expect(bytesToHex(payload)).toBe(expected.payload_hex)
  }

  if (expected.objects !== undefined) {
    const actualObjects = a.objects as Array<Record<string, unknown>>
    const expectedObjects = expected.objects as Array<Record<string, unknown>>
    expect(actualObjects.length).toBe(expectedObjects.length)

    for (let i = 0; i < expectedObjects.length; i++) {
      const ao = actualObjects[i]!
      const eo = expectedObjects[i]!
      if (eo.object_id !== undefined) {
        expect(String(ao.objectId)).toBe(String(eo.object_id))
      }
      if (eo.payload_length !== undefined) {
        expect(String(ao.payloadLength)).toBe(String(eo.payload_length))
      }
      if (eo.status !== undefined) {
        expect(String(ao.status)).toBe(String(eo.status))
      }
      if (eo.group_id !== undefined) {
        expect(String(ao.groupId)).toBe(String(eo.group_id))
      }
      if (eo.subgroup_id !== undefined) {
        expect(String(ao.subgroupId)).toBe(String(eo.subgroup_id))
      }
      if (eo.publisher_priority !== undefined) {
        expect(String(ao.publisherPriority)).toBe(String(eo.publisher_priority))
      }
      if (eo.extension_headers_length !== undefined) {
        expect(String(ao.extensionHeadersLength)).toBe(String(eo.extension_headers_length))
      }
      if (eo.payload_hex !== undefined) {
        expect(bytesToHex(ao.payload as Uint8Array)).toBe(eo.payload_hex)
      }
    }
  }
}
