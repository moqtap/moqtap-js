/**
 * The dispatcher and the replay entry point.
 *
 * Two of these tests exist because of things that are easy to get wrong and
 * silent when wrong:
 *
 *  - **A bidirectional stream is two byte streams under one id.** The seam hands
 *    out one synthetic id per stream, and a request stream carries the request
 *    one way and the response the other. One framer for both desynchronises on
 *    the first response — and a control plane that "decodes" garbage reports
 *    frames that are not there rather than failing.
 *  - **The replay entry point is the benchmark harness.** The whole rollup
 *    design depends on parse-and-discard being effectively free, so the
 *    benchmark has to run the real dispatcher over real bytes rather than a
 *    sketch of one.
 */

import { describe, expect, it } from 'vitest'
import {
  recordedStreamEvents,
  replay,
  replayStreams,
  StreamDispatcher,
  sniffStream,
} from '../../decode/dispatch.js'
import { TrackKeys } from '../../decode/track-key.js'
import type { StreamChunk } from '../../types.js'
import {
  concatBytes,
  DRAFT20_ADAPTER,
  datagramBytes,
  fetchBytes,
  filled,
  Recorder,
  subgroupBytes,
  subscribeBytes,
  subscribeOkBytes,
} from './vectors.js'

function chunk(over: Partial<StreamChunk> & { data: Uint8Array }): StreamChunk {
  return {
    sessionId: 's',
    streamId: over.streamId ?? 1,
    direction: over.direction ?? 'rx',
    bidi: over.bidi ?? false,
    control: over.control ?? false,
    data: over.data,
    at: over.at ?? 1,
  }
}

/** The draft-20 PADDING stream type `0x132B3E28`, as a five-byte vi64. */
const PADDING_STREAM = new Uint8Array([0xf0, 0x13, 0x2b, 0x3e, 0x28, 0x00, 0x00])

describe('sniffStream', () => {
  it('recognises the three stream types draft-20 §3.4 defines', () => {
    expect(sniffStream(0xaf)).toBe('control') // SETUP 0x2F00 as `af 00`
    expect(sniffStream(0x05)).toBe('fetch')
    expect(sniffStream(0x10)).toBe('subgroup')
    expect(sniffStream(0x3d)).toBe('subgroup')
  })

  it('calls anything else unknown, which is an ordinary outcome', () => {
    expect(sniffStream(0x00)).toBe('unknown') // bit 4 clear
    expect(sniffStream(0x16)).toBe('unknown') // reserved SUBGROUP_ID_MODE 0b11
    expect(sniffStream(0xf0)).toBe('unknown') // PADDING
    // MoQT permits non-minimal varints, so a subgroup type of 0x10 may
    // legally arrive as the two-byte 0x8010 — whose first byte sniffs as
    // nothing. That is why the sniff is a heuristic and the walk re-reads.
    expect(sniffStream(0x80)).toBe('unknown')
  })
})

describe('StreamDispatcher', () => {
  it('routes each stream kind to its own counting decoder', () => {
    const sink = new Recorder()
    const d = new StreamDispatcher(DRAFT20_ADAPTER, new TrackKeys(), sink)

    d.onStreamData(
      chunk({
        streamId: 1,
        data: subgroupBytes({ alias: 4n, group: 0n, objects: [{ id: 0n, bytes: 8 }] }),
      }),
    )
    d.onStreamData(
      chunk({ streamId: 2, data: fetchBytes(6n, [{ group: 1n, id: 0n, bytes: 9, flags: 0x0c }]) }),
    )
    d.onStreamData(chunk({ streamId: 3, control: true, data: subscribeBytes(0n) }))
    d.onDatagram({
      sessionId: 's',
      direction: 'rx',
      data: datagramBytes({ alias: 4n, group: 1n, id: 2n, bytes: 7 }),
      at: 5,
    })

    expect(sink.objects.map((o) => [o.key.kind, o.key.id, o.payloadBytes])).toEqual([
      ['alias', 4n, 8],
      ['fetch', 6n, 9],
      ['alias', 4n, 7],
    ])
    expect(sink.control).toHaveLength(1)
    expect(sink.reasons).toEqual([])
  })

  it('keeps the two directions of one bidi stream in separate framers', () => {
    const sink = new Recorder()
    const d = new StreamDispatcher(DRAFT20_ADAPTER, new TrackKeys(), sink)
    // One synthetic stream id, two byte streams: the request out, the response
    // back. `StreamRegistry.next` assigns one id per stream, not one per side.
    d.onStreamData(
      chunk({
        streamId: 9,
        bidi: true,
        control: true,
        direction: 'tx',
        data: subscribeBytes(0n),
        at: 10,
      }),
    )
    d.onStreamData(
      chunk({
        streamId: 9,
        bidi: true,
        control: true,
        direction: 'rx',
        data: subscribeOkBytes(3n),
        at: 40,
      }),
    )

    expect(sink.control.map((c) => c.message?.type)).toEqual(['subscribe', 'subscribe_ok'])
    // The response carries no request id, so the stream is what
    // ties it to its request — and that is the only reason this is measurable.
    expect(sink.latencies).toEqual([{ kind: 'subscribe', ms: 30 }])
  })

  it('feeds decoded control messages to the alias epoch map', () => {
    const sink = new Recorder()
    const keys = new TrackKeys()
    const d = new StreamDispatcher(DRAFT20_ADAPTER, keys, sink)

    d.onStreamData(
      chunk({ streamId: 9, bidi: true, control: true, direction: 'tx', data: subscribeBytes(0n) }),
    )
    d.onStreamData(
      chunk({
        streamId: 9,
        bidi: true,
        control: true,
        direction: 'rx',
        data: subscribeOkBytes(3n),
      }),
    )
    d.onStreamClose(9)
    // A second subscription rebinds the same alias once the first has closed.
    d.onStreamData(
      chunk({ streamId: 11, bidi: true, control: true, direction: 'tx', data: subscribeBytes(2n) }),
    )
    d.onStreamData(
      chunk({
        streamId: 11,
        bidi: true,
        control: true,
        direction: 'rx',
        data: subscribeOkBytes(3n),
      }),
    )

    d.onStreamData(
      chunk({
        streamId: 12,
        data: subgroupBytes({ alias: 3n, group: 0n, objects: [{ id: 0n, bytes: 4 }] }),
      }),
    )
    expect(sink.objects[0]?.key).toEqual({ dir: 'rx', kind: 'alias', id: 3n, epoch: 1 })
  })

  it('counts an unknown stream type once and then ignores the stream', () => {
    const sink = new Recorder()
    const d = new StreamDispatcher(DRAFT20_ADAPTER, new TrackKeys(), sink)
    d.onStreamData(chunk({ streamId: 4, data: PADDING_STREAM }))
    d.onStreamData(chunk({ streamId: 4, data: filled(64) }))
    expect(sink.reasons).toEqual(['unknown-stream-type'])
    expect(sink.objects).toEqual([])
  })

  it('waits for a non-empty chunk before classifying a stream', () => {
    const sink = new Recorder()
    const d = new StreamDispatcher(DRAFT20_ADAPTER, new TrackKeys(), sink)
    d.onStreamData(chunk({ streamId: 5, data: new Uint8Array(0) }))
    expect(d.openStreams).toBe(0)
    d.onStreamData(
      chunk({
        streamId: 5,
        data: subgroupBytes({ alias: 1n, group: 0n, objects: [{ id: 0n, bytes: 2 }] }),
      }),
    )
    expect(sink.objects).toHaveLength(1)
  })

  it('releases a stream on close', () => {
    const sink = new Recorder()
    const d = new StreamDispatcher(DRAFT20_ADAPTER, new TrackKeys(), sink)
    d.onStreamData(
      chunk({
        streamId: 6,
        data: subgroupBytes({ alias: 1n, group: 0n, objects: [{ id: 0n, bytes: 2 }] }),
      }),
    )
    expect(d.openStreams).toBe(1)
    d.onStreamClose(6)
    expect(d.openStreams).toBe(0)
  })

  it('counts a malformed datagram without throwing into the page', () => {
    const sink = new Recorder()
    const d = new StreamDispatcher(DRAFT20_ADAPTER, new TrackKeys(), sink)
    // Type Flags bit 4 is reserved and MUST be zero (draft-20 §11.3.1).
    d.onDatagram({
      sessionId: 's',
      direction: 'rx',
      data: new Uint8Array([0x10, 0x01, 0x00]),
      at: 1,
    })
    expect(sink.reasons).toEqual(['malformed-datagram'])
  })

  it('reports a datagram bucket refused by the cap once per id, not once per datagram', () => {
    const sink = new Recorder()
    const d = new StreamDispatcher(DRAFT20_ADAPTER, new TrackKeys({ maxBuckets: 1 }), sink)
    for (const alias of [1n, 2n, 2n, 2n]) {
      d.onDatagram({
        sessionId: 's',
        direction: 'rx',
        data: datagramBytes({ alias, group: 0n, id: 0n, bytes: 2 }),
        at: 1,
      })
    }
    expect(sink.objects).toHaveLength(1)
    expect(sink.reasons).toEqual(['bucket-cap'])
  })
})

describe('replay — the benchmark entry point', () => {
  const session = [
    {
      streamId: 1,
      dir: 'rx' as const,
      control: true,
      bytes: concatBytes(subscribeOkBytes(3n)),
    },
    {
      streamId: 2,
      dir: 'rx' as const,
      chunkBytes: 1200,
      bytes: subgroupBytes({
        alias: 3n,
        group: 0n,
        objects: Array.from({ length: 200 }, (_, i) => ({ id: BigInt(i), bytes: 900 })),
      }),
    },
  ]

  it('runs recorded bytes through the real decoder and reports the cost', () => {
    const stats = replayStreams(session, DRAFT20_ADAPTER)
    expect(stats.objects).toBe(200)
    expect(stats.controlFrames).toBe(1)
    expect(stats.objectPayloadBytes).toBe(200 * 900)
    expect(stats.parseFailures).toBe(0)
    // Every replayed byte is accounted for: the subgroup stream's own bytes plus
    // the control frame.
    expect(stats.objectHeaderBytes + stats.objectPayloadBytes + stats.controlBytes).toBe(
      stats.bytes,
    )
    expect(stats.elapsedMs).toBeGreaterThanOrEqual(0)
    expect(Number.isFinite(stats.megabytesPerSecond)).toBe(true)
  })

  it('replays the same events repeatedly for a warm measurement', () => {
    const stats = replayStreams(session, DRAFT20_ADAPTER, { repeat: 3 })
    expect(stats.objects).toBe(600)
  })

  it('decodes and discards fast enough to be worth measuring', () => {
    // Not a benchmark — a floor with three orders of magnitude of headroom, so
    // it fails only if parse-and-discard has become quadratic in something.
    // the real number comes from running `replay` against a capture.
    const stats = replayStreams(session, DRAFT20_ADAPTER, { repeat: 5 })
    expect(stats.objects).toBe(1000)
    expect(stats.elapsedMs).toBeLessThan(2000)
  })

  it('accepts a hand-built event stream, datagrams included', () => {
    const events = [
      ...recordedStreamEvents({
        streamId: 1,
        dir: 'rx',
        bytes: subgroupBytes({ alias: 1n, group: 0n, objects: [{ id: 0n, bytes: 5 }] }),
      }),
      {
        type: 'datagram' as const,
        chunk: {
          sessionId: 'replay',
          direction: 'rx' as const,
          data: datagramBytes({ alias: 1n, group: 1n, id: 0n, bytes: 6 }),
          at: 2,
        },
      },
    ]
    const stats = replay(events, DRAFT20_ADAPTER)
    expect(stats.objects).toBe(2)
    expect(stats.objectPayloadBytes).toBe(11)
  })

  it('chunks a recorded stream the way a transport would', () => {
    const bytes = subgroupBytes({ alias: 1n, group: 0n, objects: [{ id: 0n, bytes: 50 }] })
    const events = recordedStreamEvents({ streamId: 1, dir: 'rx', bytes, chunkBytes: 7 })
    // Every chunk, plus the close event.
    expect(events).toHaveLength(Math.ceil(bytes.length / 7) + 1)
    expect(events.at(-1)).toEqual({ type: 'close', streamId: 1 })
  })
})

describe('the bucket cap over a long session', () => {
  it('frees a fetch bucket when its stream closes', () => {
    // Request ids are never reused within a session (draft-20 §10.1), so a
    // session that fetches for an hour opens an hour's worth of buckets. Without
    // release, its finished fetches crowd out its live tracks.
    const sink = new Recorder()
    const keys = new TrackKeys({ maxBuckets: 2 })
    const d = new StreamDispatcher(DRAFT20_ADAPTER, keys, sink)
    for (let i = 0; i < 20; i++) {
      d.onStreamData(
        chunk({
          streamId: i + 1,
          data: fetchBytes(BigInt(i), [{ group: 0n, id: 0n, bytes: 3, flags: 0x0c }]),
        }),
      )
      d.onStreamClose(i + 1)
    }
    expect(sink.objects).toHaveLength(20)
    expect(keys.bucketsRefused).toBe(0)
    expect(keys.bucketCount).toBe(0)
  })

  it('does not free an alias bucket, which the epoch map still owns', () => {
    const sink = new Recorder()
    const keys = new TrackKeys()
    const d = new StreamDispatcher(DRAFT20_ADAPTER, keys, sink)
    d.onStreamData(
      chunk({
        streamId: 1,
        data: subgroupBytes({ alias: 1n, group: 0n, objects: [{ id: 0n, bytes: 2 }] }),
      }),
    )
    d.onStreamClose(1)
    expect(keys.bucketCount).toBe(1)
  })
})
