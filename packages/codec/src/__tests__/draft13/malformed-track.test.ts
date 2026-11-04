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

function gaps(...values: bigint[]): Uint8Array {
  return encodeObjectProperties(values.map((value) => ({ type: PRIOR_GROUP_ID_GAP, value })))
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

  it('returns null for Objects with a Prior Group ID Gap common to all', () => {
    expect(malformedTrackReason(subgroup(5n, gaps(2n, 3n)))).toBeNull()
    expect(malformedTrackReason(subgroup(5n, gaps(2n, 3n), gaps(3n, 2n, 3n)))).toBeNull()
    expect(
      malformedTrackReason(subgroup(5n, gaps(2n, 3n), gaps(3n, 4n), empty, gap(3n))),
    ).toBeNull()
    expect(malformedTrackReason(datagram(5n, gaps(2n, 3n)))).toBeNull()
    expect(malformedTrackReason(fetch([5n, gaps(2n, 3n)], [7n, gap(1n)], [5n, gap(3n)]))).toBeNull()
  })

  it('reports a Prior Group ID Gap larger than the Group ID', () => {
    const reason = 'Prior Group ID Gap 2 is larger than Group ID 1'
    expect(malformedTrackReason(subgroup(1n, gap(2n)))).toBe(reason)
    expect(malformedTrackReason(fetch([1n, gap(2n)]))).toBe(reason)
    expect(malformedTrackReason(datagram(1n, gap(2n)))).toBe(reason)
    expect(malformedTrackReason(subgroup(5n, gaps(2n, 7n)))).toBeNull()
    expect(malformedTrackReason(subgroup(5n, gaps(7n, 6n)))).toBe(
      'Prior Group ID Gap 6 is larger than Group ID 5',
    )
  })

  it('reports Objects of one Group with no Prior Group ID Gap common to all', () => {
    const reason = 'the Objects in Group 5 carry no Prior Group ID Gap value in common'
    expect(malformedTrackReason(subgroup(5n, gap(2n), empty, gap(3n)))).toBe(reason)
    expect(malformedTrackReason(fetch([5n, gap(2n)], [7n, gap(1n)], [5n, gap(3n)]))).toBe(reason)
    expect(malformedTrackReason(subgroup(5n, gaps(2n, 3n), gap(4n)))).toBe(reason)
    expect(malformedTrackReason(subgroup(5n, gaps(2n, 3n), gaps(3n, 4n), gap(4n)))).toBe(reason)
    expect(malformedTrackReason(subgroup(5n, gaps(1n, 2n), gaps(2n, 3n), gaps(1n, 3n)))).toBe(
      reason,
    )
  })

  it('reports a Group within the gap the Group before it on a fetch stream communicated', () => {
    expect(malformedTrackReason(fetch([10n, gap(2n)], [9n, empty]))).toBe(
      'Group 9 is within the Prior Group ID Gap 2 that Group 10 communicated',
    )
    expect(malformedTrackReason(fetch([10n, gap(2n)], [7n, empty]))).toBeNull()
    // Whichever of 1 and 3 is the Object's, it communicated at least 1.
    expect(malformedTrackReason(fetch([10n, gaps(1n, 3n)], [8n, empty]))).toBeNull()
    expect(malformedTrackReason(fetch([10n, gaps(1n, 3n)], [9n, empty]))).toBe(
      'Group 9 is within the Prior Group ID Gap 1 that Group 10 communicated',
    )
  })

  it('does not report a gap covering the Group before, which this draft does not list', () => {
    expect(malformedTrackReason(fetch([9n, empty], [10n, gap(2n)]))).toBeNull()
  })
})
