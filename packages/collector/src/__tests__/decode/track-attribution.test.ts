/**
 * `StreamDispatcher.trackForStream` — the only bridge from a stream id to a
 * track.
 *
 * The transport seam knows stream ids and nothing else: `writer.ready` pressure
 * and `bytesAcknowledged` both arrive naming a stream. The rollup keys
 * everything by `BucketKey`. Without this lookup the two send-side metrics can
 * only ever be session-wide, which is the difference between "this publisher is
 * blocked" and "this *track* is blocked" — the second being the one that says
 * which encoder ladder rung to look at.
 *
 * The lookup reads state the decoder has already built. It must never parse,
 * never allocate, and never treat a miss as an error: a miss is the ordinary
 * state of every stream before its first header lands.
 */

import { describe, expect, it } from 'vitest'
import { StreamDispatcher } from '../../decode/dispatch.js'
import { TrackKeys } from '../../decode/track-key.js'
import type { StreamChunk } from '../../types.js'
import { DRAFT20_ADAPTER, fetchBytes, Recorder, subgroupBytes, subscribeBytes } from './vectors.js'

function chunk(over: Partial<StreamChunk> & { data: Uint8Array }): StreamChunk {
  return {
    sessionId: 's',
    streamId: over.streamId ?? 1,
    direction: over.direction ?? 'tx',
    bidi: over.bidi ?? false,
    control: over.control ?? false,
    data: over.data,
    at: over.at ?? 1,
  }
}

function dispatcher() {
  const sink = new Recorder()
  return { sink, d: new StreamDispatcher(DRAFT20_ADAPTER, new TrackKeys(), sink) }
}

describe('trackForStream', () => {
  it('names the track once the subgroup header has been read', () => {
    const { d } = dispatcher()
    d.onStreamData(
      chunk({
        streamId: 7,
        direction: 'tx',
        data: subgroupBytes({ alias: 4n, group: 0n, objects: [{ id: 0n, bytes: 8 }] }),
      }),
    )
    expect(d.trackForStream(7, 'tx')).toMatchObject({ dir: 'tx', kind: 'alias', id: 4n })
  })

  it('resolves a fetch stream too, by request id', () => {
    const { d } = dispatcher()
    d.onStreamData(
      chunk({
        streamId: 8,
        direction: 'tx',
        data: fetchBytes(6n, [{ group: 1n, id: 0n, bytes: 9, flags: 0x0c }]),
      }),
    )
    expect(d.trackForStream(8, 'tx')).toMatchObject({ kind: 'fetch', id: 6n })
  })

  it('returns null for a stream that has sent nothing yet', () => {
    // The ordinary case at the moment `writer.ready` first resolves: the page
    // is awaiting capacity to write the very header that would name the track.
    const { d } = dispatcher()
    expect(d.trackForStream(7, 'tx')).toBeNull()
  })

  it('returns null for a control stream, which carries no track', () => {
    const { d } = dispatcher()
    d.onStreamData(chunk({ streamId: 3, control: true, data: subscribeBytes(0n) }))
    expect(d.trackForStream(3, 'tx')).toBeNull()
  })

  it('keeps the two directions of one stream id apart', () => {
    // `slot()` is `streamId * 2 + dirBit`. Attributing a send-side stat to the
    // receive half of the same id would credit a publisher's bytes to a track
    // it is subscribed to.
    const { d } = dispatcher()
    d.onStreamData(
      chunk({
        streamId: 5,
        direction: 'rx',
        data: subgroupBytes({ alias: 2n, group: 0n, objects: [{ id: 0n, bytes: 4 }] }),
      }),
    )
    expect(d.trackForStream(5, 'rx')).toMatchObject({ dir: 'rx', id: 2n })
    expect(d.trackForStream(5, 'tx')).toBeNull()
  })

  it('forgets the stream once it closes', () => {
    const { d } = dispatcher()
    d.onStreamData(
      chunk({
        streamId: 7,
        direction: 'tx',
        data: subgroupBytes({ alias: 4n, group: 0n, objects: [{ id: 0n, bytes: 8 }] }),
      }),
    )
    expect(d.trackForStream(7, 'tx')).not.toBeNull()
    d.onStreamClose(7)
    // A `getStats()` promise resolving after the close has nothing to attribute
    // to, and must not resurrect a decoder entry to find out.
    expect(d.trackForStream(7, 'tx')).toBeNull()
  })

  it('parses nothing — it only reads what the decoder already resolved', () => {
    // If this ever started parsing, it would run on the page's own data path
    // via the pressure callback, which the seam's contract forbids.
    const { d, sink } = dispatcher()
    d.onStreamData(
      chunk({
        streamId: 7,
        direction: 'tx',
        data: subgroupBytes({ alias: 4n, group: 0n, objects: [{ id: 0n, bytes: 8 }] }),
      }),
    )
    const before = sink.objects.length
    for (let i = 0; i < 50; i++) d.trackForStream(7, 'tx')
    expect(sink.objects).toHaveLength(before)
    expect(sink.reasons).toEqual([])
  })
})
