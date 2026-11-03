/**
 * What the counting decoder hands the run recorder: each object's path,
 * subgroup, FIRST_OBJECT and END_OF_GROUP, a status only when it is not
 * Normal, the gap properties and FETCH range markers as marks, and a fetch
 * stream's groups in the order its request settled.
 */

import { describe, expect, it } from 'vitest'
import { countDatagram } from '../../decode/datagram-counter.js'
import { FetchCounter } from '../../decode/fetch-counter.js'
import { RequestOrder } from '../../decode/request-order.js'
import { SubgroupCounter } from '../../decode/subgroup-counter.js'
import { TrackKeys } from '../../decode/track-key.js'
import type {
  BucketKey,
  ControlFrameEvent,
  CountingSink,
  MarkSample,
  ObjectSample,
  ParseFailureReason,
} from '../../types.js'
import { DRAFT20_ADAPTER, datagramBytes, subgroupBytes } from './vectors.js'

class Sink implements CountingSink {
  readonly objects: ObjectSample[] = []
  readonly marks: MarkSample[] = []
  readonly failures: ParseFailureReason[] = []
  onObject(s: ObjectSample): void {
    this.objects.push({ ...s })
  }
  onMark(m: MarkSample): void {
    this.marks.push(m)
  }
  onControlFrame(_e: ControlFrameEvent): void {}
  onParseFailure(_k: BucketKey | null, r: ParseFailureReason): void {
    this.failures.push(r)
  }
}

function subgroup(bytes: Uint8Array): Sink {
  const sink = new Sink()
  const c = new SubgroupCounter('rx', new TrackKeys(), sink, DRAFT20_ADAPTER, { streamId: 3 })
  c.push(bytes, 1)
  c.end()
  return sink
}

describe('subgroup stream samples', () => {
  it('carry FIRST_OBJECT and END_OF_GROUP from the header, on a draft that has them', () => {
    const flagged = subgroup(
      subgroupBytes({ alias: 4n, group: 7n, headerType: 0x58, objects: [{ id: 0n, bytes: 3 }] }),
    )
    expect(flagged.objects[0]).toMatchObject({
      path: 'sub_stream',
      sub: 0n,
      fo: true,
      foKnown: true,
      eog: true,
      streamId: 3,
    })
    const plain = subgroup(subgroupBytes({ alias: 4n, group: 7n, objects: [{ id: 0n, bytes: 3 }] }))
    expect(plain.objects[0]).toMatchObject({ fo: false, foKnown: true, eog: false })
  })

  it('treat a zero-length Normal object as an arrival, and keep a non-Normal status', () => {
    const s = subgroup(
      subgroupBytes({
        alias: 4n,
        group: 7n,
        objects: [
          { id: 0n, bytes: 0 },
          { id: 1n, bytes: 0, status: 3n },
        ],
      }),
    )
    expect(s.objects.map((o) => [o.objectId, o.payloadBytes, o.status])).toEqual([
      [0n, 0, undefined],
      [1n, 0, 3n],
    ])
  })

  it('report Prior Group and Object ID Gaps as marks, and skip every other property', () => {
    const s = subgroup(
      subgroupBytes({
        alias: 4n,
        group: 7n,
        headerType: 0x11,
        objects: [{ id: 5n, bytes: 1, props: { prior_group_id_gap: 2n, prior_object_id_gap: 3n } }],
      }),
    )
    expect(s.objects).toHaveLength(1)
    expect(s.marks.map((m) => [m.what, m.groupId, m.objectId, m.path])).toEqual([
      [{ gap: 'group', n: 2n }, 7n, 5n, 'sub_stream'],
      [{ gap: 'object', n: 3n }, 7n, 5n, 'sub_stream'],
    ])
  })
})

describe('datagram samples', () => {
  it('carry the END_OF_GROUP flag and no subgroup', () => {
    const sink = new Sink()
    const keys = new TrackKeys()
    countDatagram(
      'rx',
      datagramBytes({ alias: 4n, group: 7n, id: 2n, bytes: 4, type: 0x02 }),
      1,
      keys,
      sink,
      DRAFT20_ADAPTER,
    )
    expect(sink.objects[0]).toMatchObject({ path: 'datagram', sub: null, eog: true })
    expect(sink.objects[0]).not.toHaveProperty('streamId')
  })
})

/** FETCH_HEADER for request 9, then group 11 object 0, then a Group ID Delta of 0. */
const TWO_GROUPS = new Uint8Array([
  0x05, 0x09, 0x0c, 0x0b, 0x00, 0x01, 0xaa, 0x0c, 0x00, 0x00, 0x01, 0xbb,
])

function fetchWith(keys: TrackKeys, bytes = TWO_GROUPS): { sink: Sink; counter: FetchCounter } {
  const sink = new Sink()
  const counter = new FetchCounter('rx', keys, sink, DRAFT20_ADAPTER, { streamId: 5 })
  counter.push(bytes, 1)
  return { sink, counter }
}

const fetchMsg = (groupOrder?: bigint) => ({
  type: 'fetch',
  request_id: 9n,
  track_namespace: ['a'],
  track_name: 'b',
  parameters: groupOrder === undefined ? {} : { group_order: groupOrder },
})

describe('a fetch stream’s group order', () => {
  it('reads Group ID Deltas ascending by default for a FETCH', () => {
    const keys = new TrackKeys()
    keys.applyControl(fetchMsg(), 'tx', 2, 0)
    const { sink } = fetchWith(keys)
    expect(sink.objects.map((o) => [o.groupId, o.path])).toEqual([
      [11n, 'fetch'],
      [12n, 'fetch'],
    ])
  })

  it('reads them descending when the FETCH asked for it', () => {
    const keys = new TrackKeys()
    keys.applyControl(fetchMsg(2n), 'tx', 2, 0)
    expect(fetchWith(keys).sink.objects.map((o) => o.groupId)).toEqual([11n, 10n])
  })

  it('holds a fill stream until SUBSCRIBE_OK settles its order, then walks it', () => {
    const keys = new TrackKeys()
    keys.applyControl(
      {
        type: 'subscribe',
        request_id: 9n,
        track_namespace: ['a'],
        track_name: 'b',
        parameters: {},
      },
      'tx',
      2,
      0,
    )
    const { sink, counter } = fetchWith(keys)
    expect(sink.objects).toEqual([])
    keys.applyControl(
      {
        type: 'subscribe_ok',
        track_alias: 1n,
        parameters: {},
        track_properties: { default_publisher_group_order: 2n },
      },
      'rx',
      2,
      1,
    )
    counter.retry()
    expect(sink.objects.map((o) => [o.groupId, o.path])).toEqual([
      [11n, 'fill'],
      [10n, 'fill'],
    ])
  })

  it('walks a stream whose request was never seen as far as it reads, and says why it stopped', () => {
    const { sink, counter } = fetchWith(new TrackKeys())
    counter.end()
    expect(sink.objects.map((o) => [o.groupId, o.path])).toEqual([[11n, null]])
    expect(sink.failures).toEqual(['fetch-order-unknown'])
  })
})

describe('RequestOrder', () => {
  const sub = (id: bigint, parameters: Record<string, unknown>) => ({
    type: 'subscribe',
    request_id: id,
    track_namespace: ['a'],
    track_name: 'b',
    parameters,
  })

  it('prefers FILL_PARAMETERS, then GROUP_ORDER, then the publisher’s default', () => {
    const r = new RequestOrder()
    r.apply(
      sub(1n, { group_order: 1n, fill_parameters: { group_order: 2n } }),
      'tx',
      4,
      1n,
      undefined,
    )
    expect(r.descending('rx', 1n)).toBe(true)
    r.apply(sub(3n, { group_order: 2n }), 'tx', 6, 3n, undefined)
    expect(r.descending('rx', 3n)).toBe(true)
    r.apply(sub(5n, {}), 'tx', 8, 5n, undefined)
    expect(r.descending('rx', 5n)).toBeNull()
    r.apply(
      { type: 'subscribe_ok', track_properties: { default_publisher_group_order: 2n } },
      'rx',
      8,
      undefined,
      5n,
    )
    expect(r.descending('rx', 5n)).toBe(true)
  })

  it('gives a REQUEST_UPDATE’s fill its own order, else its subscription’s', () => {
    const r = new RequestOrder()
    r.apply(sub(1n, { group_order: 2n }), 'tx', 4, 1n, undefined)
    r.apply({ type: 'request_update', request_id: 7n, parameters: {} }, 'tx', 4, 7n, 1n)
    expect(r.path('rx', 7n)).toBe('fill')
    expect(r.descending('rx', 7n)).toBe(true)
    r.apply(
      {
        type: 'request_update',
        request_id: 9n,
        parameters: { fill_parameters: { group_order: 1n } },
      },
      'tx',
      4,
      9n,
      1n,
    )
    expect(r.descending('rx', 9n)).toBe(false)
  })

  it('tells a joining FETCH from a standalone one, and names nothing it did not see', () => {
    const r = new RequestOrder()
    r.apply(
      { type: 'fetch', request_id: 2n, fetch_type: 1n, parameters: {} },
      'tx',
      0,
      2n,
      undefined,
    )
    r.apply(
      { type: 'fetch', request_id: 4n, fetch_type: 3n, parameters: {} },
      'tx',
      0,
      4n,
      undefined,
    )
    expect(r.path('rx', 2n)).toBe('fetch')
    expect(r.path('rx', 4n)).toBe('fetch_joining')
    expect(r.path('rx', 6n)).toBeNull()
    expect(r.descending('rx', 6n)).toBeNull()
  })
})
