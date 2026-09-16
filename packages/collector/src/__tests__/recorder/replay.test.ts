/**
 * The re-parse, and the promise around it.
 *
 * Every vector here is encoded by `@moqtap/codec` itself rather than written by
 * hand, for the reason the decoder's vectors give: a hand-transcribed stream
 * would agree with a wrong walk for exactly the same wrong reasons. The one
 * case that matters most is the **status object mid-stream** —
 * `createSubgroupStreamDecoder` desynchronises on it, which is why this package
 * hand-rolls the walk at all, and a replay that inherited that bug would report
 * plausible garbage for every object after the first status.
 */

import {
  type DatagramObject,
  encodeDatagram,
  encodeFetchStream,
  encodeSubgroupStream,
  type FetchObjectPayload,
  type ObjectPayload,
} from '@moqtap/codec/draft20'
import { describe, expect, it } from 'vitest'
import { DRAFT20_ADAPTER } from '../../drafts/draft20/index.js'
import {
  DATAGRAM_STREAM_ID,
  FlightRecorder,
  replayRing,
  replayWindow,
} from '../../recorder/index.js'
import { ByteRing } from '../../ring/index.js'
import type { EnvelopeRecord, FlightRecord, RecordSink, TriggerConfig } from '../../types.js'

/* ── vectors ─────────────────────────────────────────────────────────────── */

function filled(n: number): Uint8Array {
  const b = new Uint8Array(n)
  for (let i = 0; i < n; i++) b[i] = (0x40 + i) & 0xff
  return b
}

interface ObjSpec {
  readonly id: bigint
  readonly bytes?: number
  readonly status?: bigint
}

function objectPayload(o: ObjSpec): ObjectPayload {
  const len = o.bytes ?? 0
  const base = {
    type: 'object' as const,
    byteOffset: 0,
    payloadByteOffset: 0,
    objectId: o.id,
    payloadLength: len,
    payload: filled(len),
    extensionData: new Uint8Array(0),
  }
  return o.status === undefined ? base : { ...base, status: o.status }
}

function subgroupBytes(alias: bigint, group: bigint, objects: readonly ObjSpec[]): Uint8Array {
  return encodeSubgroupStream({
    type: 'subgroup',
    headerType: 0x10,
    trackAlias: alias,
    groupId: group,
    subgroupId: 0n,
    publisherPriority: 128,
    objects: objects.map(objectPayload),
  })
}

/**
 * `flags` is draft-20's Serialization Flags. `0x0c` — Group ID Delta and Object
 * ID Delta both present — is what the first object on a stream is required to
 * use; `0x04` carries only the Object ID Delta.
 */
function fetchBytes(
  requestId: bigint,
  objects: readonly { group: bigint; id: bigint; bytes?: number; flags?: number }[],
): Uint8Array {
  const encoded: FetchObjectPayload[] = objects.map((o) => ({
    type: 'object',
    byteOffset: 0,
    payloadByteOffset: 0,
    serializationFlags: o.flags ?? 0x0c,
    groupId: o.group,
    subgroupId: 0n,
    objectId: o.id,
    publisherPriority: 128,
    payloadLength: o.bytes ?? 0,
    payload: filled(o.bytes ?? 0),
    extensionData: new Uint8Array(0),
  }))
  return encodeFetchStream({ type: 'fetch', requestId, objects: encoded })
}

function datagramBytes(alias: bigint, group: bigint, id: bigint, bytes: number): Uint8Array {
  const d: DatagramObject = {
    type: 'datagram',
    datagramType: 0x00,
    trackAlias: alias,
    groupId: group,
    objectId: id,
    publisherPriority: 128,
    payloadLength: bytes,
    payload: filled(bytes),
  }
  return encodeDatagram(d)
}

/* ── harness ─────────────────────────────────────────────────────────────── */

const WHOLE_RING = { fromMono: Number.NEGATIVE_INFINITY, toMono: Number.POSITIVE_INFINITY }

function ringOf(maxBytes = 1 << 20): ByteRing {
  return new ByteRing({ maxBytes })
}

/** Push `bytes` as `parts` equal chunks, one per timestamp. */
function pushChunks(
  ring: ByteRing,
  streamId: number,
  bytes: Uint8Array,
  times: readonly number[],
): void {
  const size = Math.ceil(bytes.length / times.length)
  for (let n = 0; n < times.length; n++) {
    const slice = bytes.subarray(n * size, Math.min((n + 1) * size, bytes.length))
    if (slice.length === 0) continue
    ring.push({
      sessionId: 's',
      streamId,
      dir: 'rx',
      control: false,
      atMono: times[n] as number,
      data: slice,
    })
  }
}

class Sink implements RecordSink {
  readonly records: EnvelopeRecord[] = []
  readonly raws: Uint8Array[] = []

  json(r: EnvelopeRecord): void {
    this.records.push(r)
  }

  raw(b: Uint8Array): void {
    this.raws.push(b)
  }
}

/* ── the walk ────────────────────────────────────────────────────────────── */

describe('replayWindow recovers per-object timings from raw bytes', () => {
  it('recovers every object, and attributes every byte on the stream', () => {
    const ring = ringOf()
    const bytes = subgroupBytes(7n, 3n, [
      { id: 0n, bytes: 100 },
      { id: 1n, bytes: 200 },
      { id: 2n, bytes: 50 },
    ])
    pushChunks(ring, 4, bytes, [1_000])

    const r = replayWindow(ring, DRAFT20_ADAPTER, WHOLE_RING)

    expect(r.rows.map((o) => o.objectId)).toEqual([0n, 1n, 2n])
    expect(r.rows.map((o) => o.groupId)).toEqual([3n, 3n, 3n])
    expect(r.rows.every((o) => o.key.id === 7n && o.key.kind === 'alias')).toBe(true)
    // The stream header rides on the first object, so the rows account for the
    // whole stream and no byte goes unattributed.
    expect(r.rows.reduce((n, o) => n + o.bytes, 0)).toBe(bytes.length)
    expect(r.truncated).toBe(false)
    expect(r.streamsSkipped).toBe(0)
  })

  it('does not desynchronise on a status object mid-stream', () => {
    const ring = ringOf()
    const bytes = subgroupBytes(1n, 0n, [
      { id: 0n, bytes: 40 },
      { id: 1n, status: 3n },
      { id: 2n, bytes: 40 },
      { id: 3n, bytes: 40 },
    ])
    pushChunks(ring, 1, bytes, [10])

    const r = replayWindow(ring, DRAFT20_ADAPTER, WHOLE_RING)

    expect(r.rows.map((o) => o.objectId)).toEqual([0n, 1n, 2n, 3n])
    expect(r.rows.reduce((n, o) => n + o.bytes, 0)).toBe(bytes.length)
  })

  it('measures delivery duration as the span of the object own bytes', () => {
    const ring = ringOf()
    // One large object, split so its payload lands in the second chunk.
    const bytes = subgroupBytes(1n, 0n, [{ id: 0n, bytes: 1_000 }])
    pushChunks(ring, 1, bytes, [100, 110])

    const r = replayWindow(ring, DRAFT20_ADAPTER, WHOLE_RING)

    expect(r.rows).toHaveLength(1)
    expect(r.rows[0]?.at).toBe(100)
    expect(r.rows[0]?.deliveryMs).toBe(10)
  })

  it('reports zero delivery for an object that arrived inside one chunk', () => {
    const ring = ringOf()
    pushChunks(ring, 1, subgroupBytes(1n, 0n, [{ id: 0n, bytes: 20 }]), [5])
    const r = replayWindow(ring, DRAFT20_ADAPTER, WHOLE_RING)
    expect(r.rows[0]?.deliveryMs).toBe(0)
  })

  it('walks fetch streams, keyed on the request id that opened them', () => {
    const ring = ringOf()
    const bytes = fetchBytes(42n, [
      { group: 0n, id: 0n, bytes: 30, flags: 0x0c },
      { group: 0n, id: 1n, bytes: 30, flags: 0x04 },
    ])
    pushChunks(ring, 9, bytes, [200])

    const r = replayWindow(ring, DRAFT20_ADAPTER, WHOLE_RING)

    expect(r.rows).toHaveLength(2)
    expect(r.rows[0]?.key.kind).toBe('fetch')
    expect(r.rows[0]?.key.id).toBe(42n)
    expect(r.rows.reduce((n, o) => n + o.bytes, 0)).toBe(bytes.length)
  })

  it('does not count an End-of-Range marker as an object', () => {
    const ring = ringOf()
    const bytes = fetchBytes(4n, [
      { group: 5n, id: 0n, bytes: 10, flags: 0x0c },
      { group: 9n, id: 3n, bytes: 0, flags: 0x8c },
      { group: 10n, id: 0n, bytes: 50, flags: 0x0c },
    ])
    pushChunks(ring, 9, bytes, [1])

    const r = replayWindow(ring, DRAFT20_ADAPTER, WHOLE_RING)

    // A marker declares a gap; it is not an object. Its bytes still ride along
    // on the next real object, so the stream still balances.
    expect(r.rows.map((o) => o.groupId)).toEqual([5n, 10n])
    expect(r.rows.reduce((n, o) => n + o.bytes, 0)).toBe(bytes.length)
  })

  it('walks datagrams, which carry no stream of their own', () => {
    const ring = ringOf()
    const d = datagramBytes(5n, 2n, 9n, 60)
    ring.push({
      sessionId: 's',
      streamId: DATAGRAM_STREAM_ID,
      dir: 'rx',
      control: false,
      atMono: 77,
      data: d,
    })

    const r = replayWindow(ring, DRAFT20_ADAPTER, WHOLE_RING)

    expect(r.rows).toHaveLength(1)
    expect(r.rows[0]?.objectId).toBe(9n)
    expect(r.rows[0]?.bytes).toBe(d.length)
    expect(r.rows[0]?.deliveryMs).toBe(0)
  })

  it('never parses control bytes as objects', () => {
    const ring = ringOf()
    ring.push({
      sessionId: 's',
      streamId: 0,
      dir: 'rx',
      control: true,
      atMono: 1,
      data: subgroupBytes(1n, 0n, [{ id: 0n, bytes: 10 }]),
    })
    expect(replayWindow(ring, DRAFT20_ADAPTER, WHOLE_RING).rows).toEqual([])
  })

  it('orders objects by arrival across streams', () => {
    const ring = ringOf()
    pushChunks(ring, 1, subgroupBytes(1n, 0n, [{ id: 0n, bytes: 10 }]), [30])
    pushChunks(ring, 2, subgroupBytes(2n, 0n, [{ id: 0n, bytes: 10 }]), [10])
    pushChunks(ring, 3, subgroupBytes(3n, 0n, [{ id: 0n, bytes: 10 }]), [20])

    const r = replayWindow(ring, DRAFT20_ADAPTER, WHOLE_RING)
    expect(r.rows.map((o) => o.at)).toEqual([10, 20, 30])
  })
})

describe('the window', () => {
  it('reports only objects inside it, and never bytes that arrived after it', () => {
    const ring = ringOf()
    pushChunks(ring, 1, subgroupBytes(1n, 0n, [{ id: 0n, bytes: 10 }]), [100])
    pushChunks(ring, 2, subgroupBytes(2n, 0n, [{ id: 0n, bytes: 10 }]), [200])
    pushChunks(ring, 3, subgroupBytes(3n, 0n, [{ id: 0n, bytes: 10 }]), [300])

    const r = replayWindow(ring, DRAFT20_ADAPTER, { fromMono: 150, toMono: 250 })
    expect(r.rows.map((o) => o.at)).toEqual([200])
  })

  it('says truncated when the ring has already overwritten its head', () => {
    const bytes = subgroupBytes(1n, 0n, [
      { id: 0n, bytes: 200 },
      { id: 1n, bytes: 200 },
    ])
    const ring = new ByteRing({ maxBytes: 128 })
    pushChunks(ring, 1, bytes, [1, 2, 3, 4])

    expect(ring.evicted).toBeGreaterThan(0)
    const r = replayWindow(ring, DRAFT20_ADAPTER, WHOLE_RING)
    expect(r.truncated).toBe(true)
  })

  it('says truncated when a stream head is gone and the walk cannot resynchronise', () => {
    const bytes = subgroupBytes(1n, 0n, [{ id: 0n, bytes: 400 }])
    const ring = ringOf()
    // Only the tail of the stream: everything before the header is missing.
    ring.push({
      sessionId: 's',
      streamId: 1,
      dir: 'rx',
      control: false,
      atMono: 1,
      data: bytes.subarray(200),
    })

    const r = replayWindow(ring, DRAFT20_ADAPTER, WHOLE_RING)
    expect(r.rows).toEqual([])
    expect(r.streamsSkipped).toBe(1)
    expect(r.truncated).toBe(true)
  })

  it('drops the oldest objects, never the newest, when the cap is reached', () => {
    const ring = ringOf()
    pushChunks(
      ring,
      1,
      subgroupBytes(1n, 0n, [
        { id: 0n, bytes: 10 },
        { id: 1n, bytes: 10 },
        { id: 2n, bytes: 10 },
        { id: 3n, bytes: 10 },
      ]),
      [1],
    )

    const r = replayWindow(ring, DRAFT20_ADAPTER, WHOLE_RING, { maxObjects: 2 })
    expect(r.rows.map((o) => o.objectId)).toEqual([2n, 3n])
    expect(r.objectsDropped).toBe(2)
    expect(r.truncated).toBe(true)
  })
})

/* ── the record ──────────────────────────────────────────────────────────── */

describe('the dump is one columnar record', () => {
  it('emits parallel arrays of equal length, rebased on the session anchor', () => {
    const ring = ringOf()
    pushChunks(
      ring,
      1,
      subgroupBytes(9n, 4n, [
        { id: 0n, bytes: 10 },
        { id: 1n, bytes: 10 },
      ]),
      [1_500],
    )

    const rec = replayRing(ring, DRAFT20_ADAPTER, WHOLE_RING, {
      trigger: 'cadence',
      originMono: 1_000,
    })

    expect(rec.t).toBe('flight')
    expect(rec.trigger).toBe('cadence')
    const { key, at, group, object, bytes, deliveryMs } = rec.cols
    expect(key).toHaveLength(2)
    for (const col of [at, group, object, bytes, deliveryMs]) expect(col).toHaveLength(key.length)
    expect(key[0]).toBe('rx:alias:9:0')
    expect(at).toEqual([500, 500])
    expect(group).toEqual([4, 4])
    expect(object).toEqual([0, 1])
    // A record is one JSON object no matter how many objects the window held.
    expect(JSON.parse(JSON.stringify(rec)).cols.at).toEqual([500, 500])
  })
})

/* ── the recorder ────────────────────────────────────────────────────────── */

const STALL_ONLY: TriggerConfig = { stall: { afterMs: 1_000 } }

function recorderOn(ring: ByteRing, sink: Sink): FlightRecorder {
  return new FlightRecorder({
    ring,
    sink,
    adapter: () => DRAFT20_ADAPTER,
  })
}

describe('armed costs nothing, and a trigger costs one record', () => {
  it('produces nothing while armed, however much traffic goes past', () => {
    const ring = ringOf()
    const sink = new Sink()
    const rec = recorderOn(ring, sink)
    rec.arm(STALL_ONLY)
    expect(rec.armed).toBe(true)

    for (let n = 0; n < 50; n++) {
      pushChunks(ring, n, subgroupBytes(BigInt(n), 0n, [{ id: 0n, bytes: 500 }]), [n])
    }

    expect(sink.records).toEqual([])
    expect(rec.capturesFired).toBe(0)
  })

  it('emits exactly one record per trigger', () => {
    const ring = ringOf()
    const sink = new Sink()
    const rec = recorderOn(ring, sink)
    rec.arm(STALL_ONLY)
    pushChunks(ring, 1, subgroupBytes(1n, 0n, [{ id: 0n, bytes: 10 }]), [10])

    rec.fire({ kind: 'stall', atMono: 20, detail: 'test' })

    expect(sink.records).toHaveLength(1)
    const record = sink.records[0] as FlightRecord
    expect(record.t).toBe('flight')
    expect(record.trigger).toBe('stall')
    expect(record.windowEnd).toBe(20)
    expect(record.cols.key).toHaveLength(1)
    expect(rec.capturesFired).toBe(1)
  })

  it('refuses a trigger the armed config does not enable', () => {
    const ring = ringOf()
    const sink = new Sink()
    const rec = recorderOn(ring, sink)
    rec.arm(STALL_ONLY)
    pushChunks(ring, 1, subgroupBytes(1n, 0n, [{ id: 0n, bytes: 10 }]), [10])

    rec.fire({ kind: 'cadence', atMono: 20, detail: 'not configured' })

    expect(sink.records).toEqual([])
    expect(rec.capturesSkipped).toBe(1)
  })

  it('produces nothing once disarmed, and never touches the ring', () => {
    const ring = ringOf()
    const sink = new Sink()
    const rec = recorderOn(ring, sink)
    rec.arm(STALL_ONLY)
    pushChunks(ring, 1, subgroupBytes(1n, 0n, [{ id: 0n, bytes: 10 }]), [10])
    const held = ring.entries

    rec.disarm()
    rec.fire({ kind: 'stall', atMono: 20, detail: 'test' })

    expect(rec.armed).toBe(false)
    expect(sink.records).toEqual([])
    expect(rec.capturesSkipped).toBe(1)
    // A trigger re-parses the ring; it never consumes it, and a disarm never
    // clears a buffer this module does not own.
    expect(ring.entries).toBe(held)
  })

  it('counts a fire it cannot serve rather than emitting an empty dump', () => {
    const sink = new Sink()
    const rec = new FlightRecorder({ ring: ringOf(), sink, adapter: () => undefined })
    rec.arm(STALL_ONLY)
    rec.fire({ kind: 'stall', atMono: 1, detail: 'degraded session' })
    expect(sink.records).toEqual([])
    expect(rec.capturesSkipped).toBe(1)
  })

  it('re-parses the same window twice without consuming it', () => {
    const ring = ringOf()
    const sink = new Sink()
    const rec = recorderOn(ring, sink)
    rec.arm(STALL_ONLY)
    pushChunks(ring, 1, subgroupBytes(1n, 0n, [{ id: 0n, bytes: 10 }]), [10])

    rec.fire({ kind: 'stall', atMono: 20, detail: 'first' })
    rec.fire({ kind: 'stall', atMono: 30, detail: 'second' })

    expect(sink.records).toHaveLength(2)
    const first = sink.records[0] as FlightRecord
    const second = sink.records[1] as FlightRecord
    expect(first.cols.object).toEqual(second.cols.object)
  })

  it('honours preRollMs as a second bound inside the byte depth', () => {
    const ring = ringOf()
    const sink = new Sink()
    const rec = new FlightRecorder({ ring, sink, adapter: () => DRAFT20_ADAPTER, preRollMs: 50 })
    rec.arm(STALL_ONLY)
    pushChunks(ring, 1, subgroupBytes(1n, 0n, [{ id: 0n, bytes: 10 }]), [100])
    pushChunks(ring, 2, subgroupBytes(2n, 0n, [{ id: 0n, bytes: 10 }]), [980])

    rec.fire({ kind: 'stall', atMono: 1_000, detail: 'test' })

    const record = sink.records[0] as FlightRecord
    expect(record.cols.at).toEqual([980])
    expect(record.windowStart).toBe(950)
  })
})
