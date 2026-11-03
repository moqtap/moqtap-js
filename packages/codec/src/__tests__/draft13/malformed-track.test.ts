import { describe, expect, it } from 'vitest'
import { encodeObjectProperties, malformedTrackReason } from '../../drafts/draft13/codec.js'
import type {
  DatagramObject,
  FetchObjectPayload,
  FetchStream,
  ObjectPayload,
  SubgroupStream,
} from '../../drafts/draft13/types.js'

const PRIOR_GROUP_ID_GAP = 0x40n
const empty = new Uint8Array(0)

function gap(value: bigint): Uint8Array {
  return encodeObjectProperties([{ type: PRIOR_GROUP_ID_GAP, value }])
}

function subgroup(groupId: bigint, ...blocks: Uint8Array[]): SubgroupStream {
  const objects: ObjectPayload[] = blocks.map((extensionData, i) => ({
    type: 'object',
    byteOffset: 0,
    payloadByteOffset: 0,
    objectId: BigInt(i),
    extensionData,
    payloadLength: 0,
    payload: empty,
  }))
  return {
    type: 'subgroup',
    streamTypeId: 0x15,
    trackAlias: 1n,
    groupId,
    subgroupId: 0n,
    publisherPriority: 0,
    objects,
  }
}

function fetch(...entries: [bigint, Uint8Array][]): FetchStream {
  const objects: FetchObjectPayload[] = entries.map(([groupId, extensionData]) => ({
    type: 'object',
    byteOffset: 0,
    payloadByteOffset: 0,
    groupId,
    subgroupId: 0n,
    objectId: 0n,
    publisherPriority: 0,
    extensionHeadersLength: BigInt(extensionData.byteLength),
    extensionData,
    payloadLength: 0,
    payload: empty,
  }))
  return { type: 'fetch', requestId: 0n, objects }
}

function datagram(groupId: bigint, extensionData?: Uint8Array): DatagramObject {
  return {
    type: 'datagram',
    streamTypeId: extensionData === undefined ? 0x00 : 0x01,
    trackAlias: 1n,
    groupId,
    objectId: 0n,
    publisherPriority: 0,
    ...(extensionData === undefined ? {} : { extensionData }),
    payloadLength: 0,
    payload: empty,
  }
}

describe('draft-13 malformedTrackReason', () => {
  it('returns null for conforming streams', () => {
    expect(malformedTrackReason(subgroup(5n))).toBeNull()
    expect(malformedTrackReason(subgroup(5n, gap(2n), empty, gap(2n)))).toBeNull()
    expect(malformedTrackReason(subgroup(5n, gap(5n)))).toBeNull()
    expect(
      malformedTrackReason(subgroup(1n, encodeObjectProperties([{ type: 0x3cn, value: 9n }]))),
    ).toBeNull()
    expect(malformedTrackReason(fetch([5n, gap(2n)], [7n, gap(1n)], [5n, gap(2n)]))).toBeNull()
    expect(malformedTrackReason(datagram(5n, gap(5n)))).toBeNull()
    expect(malformedTrackReason(datagram(5n))).toBeNull()
  })

  it('reports a Prior Group ID Gap larger than the Group ID', () => {
    const reason = 'Prior Group ID Gap 2 is larger than Group ID 1'
    expect(malformedTrackReason(subgroup(1n, gap(2n)))).toBe(reason)
    expect(malformedTrackReason(fetch([1n, gap(2n)]))).toBe(reason)
    expect(malformedTrackReason(datagram(1n, gap(2n)))).toBe(reason)
    const twoGaps = encodeObjectProperties([
      { type: PRIOR_GROUP_ID_GAP, value: 2n },
      { type: PRIOR_GROUP_ID_GAP, value: 7n },
    ])
    expect(malformedTrackReason(subgroup(5n, twoGaps))).toBe(
      'Prior Group ID Gap 7 is larger than Group ID 5',
    )
  })

  it('reports two Objects of one Group with different Prior Group ID Gaps', () => {
    const reason = 'Group 5 carries Prior Group ID Gap 2 and 3'
    expect(malformedTrackReason(subgroup(5n, gap(2n), empty, gap(3n)))).toBe(reason)
    expect(malformedTrackReason(fetch([5n, gap(2n)], [6n, gap(1n)], [5n, gap(3n)]))).toBe(reason)
    const twoGaps = encodeObjectProperties([
      { type: PRIOR_GROUP_ID_GAP, value: 2n },
      { type: PRIOR_GROUP_ID_GAP, value: 3n },
    ])
    expect(malformedTrackReason(subgroup(5n, twoGaps, gap(2n)))).toBe(
      'Group 5 carries Prior Group ID Gap 3 and 2',
    )
  })
})
