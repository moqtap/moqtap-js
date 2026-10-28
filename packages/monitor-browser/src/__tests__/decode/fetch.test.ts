/**
 * The fetch walk, against vectors the codec's own encoder produced.
 *
 * Two things a fetch stream does that a subgroup stream does not, and both are
 * tested here because getting either wrong desynchronises the stream rather than
 * mis-reporting one field: End-of-Range markers, which are gap statements and
 * not objects (draft-20 §11.4.4.2), and the delta arithmetic, which resolves an
 * Object ID Delta *relative to the prior object* when no Group ID Delta
 * accompanies it — the one place draft-19 and draft-20 disagree on a
 * value.
 */

import { decodeFetchStream } from '@moqtap/codec/draft20'
import { describe, expect, it } from 'vitest'
import { FetchCounter } from '../../decode/fetch-counter.js'
import { TrackKeys } from '../../decode/track-key.js'
import { DRAFT19_ADAPTER } from '../../drafts/draft19/index.js'
import { DRAFT20_ADAPTER } from '../../drafts/draft20/index.js'
import type { DraftAdapter } from '../../types.js'
import { chunks, type FetchObjSpec, fetchBytes, Recorder } from './vectors.js'

/**
 * A stream that exercises every delta form: absolute first object, implicit
 * `prior + 1`, an Object ID Delta without a Group ID Delta, a new group, an
 * End-of-Range marker, and an object whose group resolves against the marker.
 */
const MIXED: readonly FetchObjSpec[] = [
  { group: 5n, id: 0n, bytes: 10, flags: 0x0c },
  { group: 5n, id: 1n, bytes: 20, flags: 0x00 },
  { group: 5n, id: 5n, bytes: 30, flags: 0x04 },
  { group: 7n, id: 0n, bytes: 40, flags: 0x0c },
  { group: 9n, id: 3n, bytes: 0, flags: 0x8c },
  { group: 10n, id: 0n, bytes: 50, flags: 0x0c },
]

function count(
  bytes: Uint8Array,
  chunkSize = bytes.length,
  adapter: DraftAdapter = DRAFT20_ADAPTER,
): Recorder {
  const sink = new Recorder()
  const c = new FetchCounter('rx', new TrackKeys(), sink, adapter)
  for (const part of chunks(bytes, chunkSize)) c.push(part, 1)
  c.end()
  return sink
}

describe('FetchCounter', () => {
  it('resolves ids exactly as the codec one-shot decoder does', () => {
    const bytes = fetchBytes(4n, MIXED)
    const oneShot = decodeFetchStream(bytes)
    expect(oneShot.ok).toBe(true)
    if (!oneShot.ok) return

    const sink = count(bytes)
    // The one-shot decoder returns the marker as an object; the counting decoder
    // does not, so the comparison drops it on that side.
    const real = oneShot.value.objects.filter((o) => o.serializationFlags < 0x80)
    expect(sink.objects.map((o) => [o.groupId, o.objectId])).toEqual(
      real.map((o) => [o.groupId, o.objectId]),
    )
  })

  it('does not count an End-of-Range marker as an object', () => {
    const sink = count(fetchBytes(4n, MIXED))
    expect(sink.objects).toHaveLength(5)
    expect(sink.objects.map((o) => o.payloadBytes)).toEqual([10, 20, 30, 40, 50])
  })

  it('accounts for every byte on the stream, markers included', () => {
    const bytes = fetchBytes(4n, MIXED)
    const sink = count(bytes)
    // A marker's bytes ride along on the next real object so the track's byte
    // total still balances against the wire.
    expect(sink.totalHeaderBytes + sink.totalPayloadBytes).toBe(bytes.length)
  })

  it('is independent of how the transport chunks the stream', () => {
    const bytes = fetchBytes(4n, MIXED)
    const whole = count(bytes).objects.map((o) => [o.groupId, o.objectId, o.payloadBytes])
    for (const size of [1, 2, 3, 5, 13, 64]) {
      expect(
        count(bytes, size).objects.map((o) => [o.groupId, o.objectId, o.payloadBytes]),
      ).toEqual(whole)
    }
  })

  it('keys the bucket on the request id in the header, with no epoch', () => {
    const sink = new Recorder()
    const keys = new TrackKeys()
    const c = new FetchCounter('rx', keys, sink, DRAFT20_ADAPTER)
    c.push(fetchBytes(11n, [{ group: 0n, id: 0n, bytes: 1, flags: 0x0c }]), 1)
    // `FetchStreamHeader` is `{type, requestId}` and nothing else, and a
    // request id is never reused in a session, so the id is natively stable.
    expect(sink.objects[0]?.key).toEqual({ dir: 'rx', kind: 'fetch', id: 11n, epoch: 0 })
  })

  it('reads an Object ID Delta as relative on draft-20 and absolute on draft-19', () => {
    // The single value-level divergence between the two supported drafts.
    const bytes = fetchBytes(1n, [
      { group: 2n, id: 3n, bytes: 1, flags: 0x0c },
      { group: 2n, id: 9n, bytes: 1, flags: 0x04 }, // wire delta = 9 - 3 = 6
    ])
    expect(count(bytes).objects.map((o) => o.objectId)).toEqual([3n, 9n])
    expect(count(bytes, bytes.length, DRAFT19_ADAPTER).objects.map((o) => o.objectId)).toEqual([
      3n,
      6n,
    ])
  })

  it('abandons a stream whose first object references a prior object', () => {
    // draft-20 §11.4.4.1: "The first Object MUST include a Group ID Delta and
    // Object ID Delta". Flags 0x00 references a prior object that cannot exist.
    const sink = count(fetchBytes(2n, [{ group: 0n, id: 0n, bytes: 4, flags: 0x00 }]))
    expect(sink.reasons).toEqual(['fetch-desync'])
    expect(sink.objects).toEqual([])
  })

  it('abandons a stream whose type is not FETCH_HEADER', () => {
    const sink = count(new Uint8Array([0x06, 0x01, 0x0c, 0x00, 0x00, 0x00]))
    expect(sink.reasons).toEqual(['fetch-desync'])
  })

  it('skips a large payload without buffering it', () => {
    const bytes = fetchBytes(3n, [{ group: 0n, id: 0n, bytes: 120_000, flags: 0x0c }])
    const sink = new Recorder()
    const c = new FetchCounter('rx', new TrackKeys(), sink, DRAFT20_ADAPTER)
    let peak = 0
    for (const part of chunks(bytes, 8192)) {
      c.push(part, 1)
      peak = Math.max(peak, c.bufferedBytes)
    }
    expect(sink.objects[0]?.payloadBytes).toBe(120_000)
    expect(peak).toBeLessThan(64)
  })

  it('does not report a truncated stream as a parse failure', () => {
    const bytes = fetchBytes(5n, [{ group: 1n, id: 1n, bytes: 60, flags: 0x0c }])
    const sink = new Recorder()
    const c = new FetchCounter('rx', new TrackKeys(), sink, DRAFT20_ADAPTER)
    c.push(bytes.subarray(0, 5), 1)
    c.end()
    expect(sink.reasons).toEqual([])
  })
})

describe('FetchCounter header fields', () => {
  /**
   * Subgroup by every encoding, a priority stated then inherited, a DATAGRAM-
   * mode object with no subgroup, and a marker between them that changes
   * neither.
   */
  const FIELDS: readonly FetchObjSpec[] = [
    { group: 1n, id: 0n, bytes: 1, flags: 0x1f, subgroup: 4n, priority: 9 },
    { group: 1n, id: 1n, bytes: 1, flags: 0x01, subgroup: 4n },
    { group: 1n, id: 2n, bytes: 1, flags: 0x02, subgroup: 5n },
    { group: 2n, id: 0n, bytes: 1, flags: 0x1c, subgroup: 0n, priority: 1 },
    { group: 3n, id: 0n, bytes: 0, flags: 0x8c },
    { group: 4n, id: 0n, bytes: 1, flags: 0x4c },
    { group: 4n, id: 1n, bytes: 1, flags: 0x02, subgroup: 1n },
  ]

  function fields(bytes: Uint8Array, adapter: DraftAdapter = DRAFT20_ADAPTER) {
    const seen: [number, bigint | null][] = []
    const sink = new Recorder()
    const c = new FetchCounter('rx', new TrackKeys(), sink, adapter)
    sink.onObject = (): void => {
      seen.push([c.priority, c.subgroupId])
    }
    for (const part of chunks(bytes, 3)) c.push(part, 1)
    c.end()
    return seen
  }

  it('resolves each object’s subgroup and priority as the codec does', () => {
    const bytes = fetchBytes(4n, FIELDS)
    const oneShot = decodeFetchStream(bytes)
    expect(oneShot.ok).toBe(true)
    if (!oneShot.ok) return
    const real = oneShot.value.objects.filter((o) => o.serializationFlags < 0x80)
    const want = real.map((o): [number, bigint | null] => [
      o.publisherPriority,
      (o.serializationFlags & 0x40) === 0 ? o.subgroupId : null,
    ])
    expect(fields(bytes)).toEqual(want)
    expect(want).toEqual([
      [9, 4n],
      [9, 4n],
      [9, 5n],
      [1, 0n],
      [1, null],
      [1, 1n],
    ])
  })

  it('has no priority until an object states one', () => {
    const bytes = fetchBytes(4n, [
      { group: 1n, id: 0n, bytes: 1, flags: 0x0c },
      { group: 1n, id: 1n, bytes: 1, flags: 0x10, priority: 3 },
    ])
    expect(fields(bytes)).toEqual([
      [-1, 0n],
      [3, 0n],
    ])
  })

  it('reads the same fields through an older draft’s walk', () => {
    // Draft-19 reads the same flags; only its id arithmetic differs, and these
    // objects state their ids where it would matter.
    const bytes = fetchBytes(
      4n,
      FIELDS.filter((o) => o.flags !== 0x8c),
    )
    expect(fields(bytes, DRAFT19_ADAPTER)).toEqual(fields(bytes))
  })
})
