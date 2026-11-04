import { describe, expect, it } from 'vitest'
import { encodeObjectProperties, malformedTrackReason } from '../../drafts/draft14/codec.js'
import type {
  DatagramObject,
  FetchObjectPayload,
  FetchStream,
  ObjectPayload,
  SubgroupStream,
} from '../../drafts/draft14/types.js'

const G = 0x3cn
const O = 0x3en
const empty = new Uint8Array(0)

function props(...entries: [bigint, bigint][]): Uint8Array {
  return encodeObjectProperties(entries.map(([type, value]) => ({ type, value })))
}

function subgroup(groupId: bigint, ...entries: [bigint, Uint8Array][]): SubgroupStream {
  const objects: ObjectPayload[] = entries.map(([objectId, extensionData]) => ({
    type: 'object',
    byteOffset: 0,
    payloadByteOffset: 0,
    objectId,
    extensionData,
    payloadLength: 0,
    payload: empty,
  }))
  return {
    type: 'subgroup',
    headerType: 0x15,
    trackAlias: 1n,
    groupId,
    subgroupId: 0n,
    publisherPriority: 0,
    objects,
  }
}

function fetch(...entries: [bigint, bigint, Uint8Array][]): FetchStream {
  const objects: FetchObjectPayload[] = entries.map(([groupId, objectId, extensionData]) => ({
    type: 'object',
    byteOffset: 0,
    payloadByteOffset: 0,
    groupId,
    subgroupId: 0n,
    objectId,
    publisherPriority: 0,
    extensionData,
    payloadLength: 0,
    payload: empty,
  }))
  return { type: 'fetch', requestId: 0n, objects }
}

function datagram(groupId: bigint, objectId: bigint, extensionData?: Uint8Array): DatagramObject {
  return {
    type: 'datagram',
    datagramType: extensionData === undefined ? 0x00 : 0x01,
    trackAlias: 1n,
    groupId,
    objectId,
    publisherPriority: 0,
    ...(extensionData === undefined ? {} : { extensionData }),
    payloadLength: 0,
    payload: empty,
  }
}

describe('draft-14 malformedTrackReason', () => {
  it('returns null for conforming streams', () => {
    expect(
      malformedTrackReason(
        subgroup(5n, [3n, props([G, 2n], [O, 1n])], [4n, props([G, 2n])], [5n, empty]),
      ),
    ).toBeNull()
    expect(malformedTrackReason(subgroup(5n, [0n, props([G, 5n], [O, 0n])]))).toBeNull()
    expect(
      malformedTrackReason(fetch([5n, 1n, props([G, 2n])], [7n, 0n, props([G, 1n])])),
    ).toBeNull()
    expect(malformedTrackReason(datagram(5n, 2n, props([G, 5n], [O, 2n])))).toBeNull()
    expect(malformedTrackReason(datagram(5n, 0n))).toBeNull()
  })

  it('reports a Prior Group ID Gap an Object carries twice', () => {
    const reason = 'Prior Group ID Gap appears more than once'
    expect(malformedTrackReason(subgroup(5n, [0n, props([G, 2n], [G, 2n])]))).toBe(reason)
    expect(malformedTrackReason(fetch([5n, 0n, props([G, 2n], [G, 2n])]))).toBe(reason)
    expect(malformedTrackReason(datagram(5n, 0n, props([G, 2n], [G, 2n])))).toBe(reason)
  })

  it('reports a Prior Object ID Gap an Object carries twice', () => {
    const reason = 'Prior Object ID Gap appears more than once'
    expect(malformedTrackReason(subgroup(5n, [3n, props([O, 1n], [O, 1n])]))).toBe(reason)
    expect(malformedTrackReason(fetch([5n, 3n, props([O, 1n], [O, 1n])]))).toBe(reason)
    expect(malformedTrackReason(datagram(5n, 3n, props([O, 1n], [O, 1n])))).toBe(reason)
  })

  it('reports a Prior Group ID Gap larger than the Group ID', () => {
    const reason = 'Prior Group ID Gap 2 is larger than Group ID 1'
    expect(malformedTrackReason(subgroup(1n, [0n, props([G, 2n])]))).toBe(reason)
    expect(malformedTrackReason(fetch([1n, 0n, props([G, 2n])]))).toBe(reason)
    expect(malformedTrackReason(datagram(1n, 0n, props([G, 2n])))).toBe(reason)
  })

  it('reports a Prior Object ID Gap larger than the Object ID', () => {
    const reason = 'Prior Object ID Gap 1 is larger than Object ID 0'
    expect(malformedTrackReason(subgroup(5n, [0n, props([O, 1n])]))).toBe(reason)
    expect(malformedTrackReason(fetch([5n, 0n, props([O, 1n])]))).toBe(reason)
    expect(malformedTrackReason(datagram(5n, 0n, props([O, 1n])))).toBe(reason)
  })

  it('reports two Objects of one Group with different Prior Group ID Gaps', () => {
    const reason = 'Group 5 carries Prior Group ID Gap 2 and 3'
    expect(malformedTrackReason(subgroup(5n, [0n, props([G, 2n])], [1n, props([G, 3n])]))).toBe(
      reason,
    )
    expect(
      malformedTrackReason(
        fetch([5n, 0n, props([G, 2n])], [7n, 0n, props([G, 1n])], [5n, 1n, props([G, 3n])]),
      ),
    ).toBe(reason)
  })

  it('reports a gap covering the Group or Object before it on a fetch stream', () => {
    expect(malformedTrackReason(fetch([9n, 0n, empty], [10n, 0n, props([G, 1n])]))).toBe(
      'Prior Group ID Gap 1 of Group 10 covers Group 9, received earlier',
    )
    expect(malformedTrackReason(fetch([8n, 0n, empty], [10n, 0n, props([G, 1n])]))).toBeNull()
    expect(malformedTrackReason(fetch([3n, 8n, empty], [3n, 9n, props([O, 1n])]))).toBe(
      'Prior Object ID Gap 1 of Object 9 covers Object 8',
    )
    expect(malformedTrackReason(fetch([3n, 7n, empty], [3n, 9n, props([O, 1n])]))).toBeNull()
  })

  it('reports a Prior Object ID Gap covering the Object before it on a subgroup stream', () => {
    expect(malformedTrackReason(subgroup(3n, [8n, empty], [9n, props([O, 1n])]))).toBe(
      'Prior Object ID Gap 1 of Object 9 covers Object 8',
    )
    expect(malformedTrackReason(subgroup(3n, [7n, empty], [9n, props([O, 1n])]))).toBeNull()
  })

  it('reports a Group or Object within the gap the one before it on a fetch stream communicated', () => {
    expect(malformedTrackReason(fetch([10n, 0n, props([G, 2n])], [9n, 0n, empty]))).toBe(
      'Group 9 is within the Prior Group ID Gap 2 that Group 10 communicated',
    )
    expect(malformedTrackReason(fetch([3n, 10n, props([O, 2n])], [3n, 9n, empty]))).toBe(
      'Object 9 is within the Prior Object ID Gap 2 that Object 10 communicated',
    )
  })
})
