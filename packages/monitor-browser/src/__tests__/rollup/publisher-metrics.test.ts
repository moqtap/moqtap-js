/**
 * The three measurements a publisher's session yields and a consumer cannot.
 *
 * Ingest already decodes every control frame — that decode is where track names
 * come from — so anything the control plane carries is derivable server-side and
 * has no business being computed on a customer's device. These three are what is
 * left over:
 *
 *  - `grp.openMs` is built from per-object arrival times, which reach ingest
 *    only inside `hdr`, and `hdr` is elevated-only and droppable.
 *  - `pub.blockedMs` is `writer.ready` timing: a local scheduling fact that no
 *    byte on the wire records.
 *  - `pub.ackedBytes` lives in the QUIC stack between the two peers and never
 *    appears in a payload.
 *
 * What is asserted here is the wire row, not the bucket's internals.
 */

import { describe, expect, it } from 'vitest'
import { RollupEngine, type RollupEngineOptions } from '../../rollup/interval.js'
import type {
  BucketKey,
  ClockSource,
  EnvelopeRecord,
  Mono,
  ObjectSample,
  RecordSink,
  RollupRecord,
  RollupTrackWire,
} from '../../types.js'

class Recorder implements RecordSink {
  readonly records: EnvelopeRecord[] = []
  json(r: EnvelopeRecord): void {
    this.records.push(r)
  }
  raw(): void {}
  rollups(): RollupRecord[] {
    return this.records.filter((r): r is RollupRecord => r.t === 'rollup')
  }
  lastRollup(): RollupRecord {
    const all = this.rollups()
    const last = all[all.length - 1]
    if (last === undefined) throw new Error('no rollup record was emitted')
    return last
  }
}

class FakeClock implements ClockSource {
  mono = 0
  now(): Mono {
    return this.mono
  }
  wall(): number {
    return 1_700_000_000_000
  }
}

function setup(o: Partial<RollupEngineOptions> = {}) {
  const sink = new Recorder()
  const clock = new FakeClock()
  const engine = new RollupEngine({ intervalMs: 1_000, maxBuckets: 8, clock, sink, ...o })
  return { engine, sink }
}

const TX: BucketKey = { dir: 'tx', kind: 'alias', id: 7n, epoch: 0 }
const RX: BucketKey = { dir: 'rx', kind: 'alias', id: 9n, epoch: 0 }

function obj(at: Mono, o: Partial<ObjectSample> = {}): ObjectSample {
  return { key: TX, groupId: 0n, objectId: 0n, headerBytes: 4, payloadBytes: 100, at, ...o }
}

function rowFor(r: RollupRecord, k: BucketKey): RollupTrackWire {
  const t = r.tracks.find((x) => x.key.v === k.id.toString() && x.key.d === k.dir)
  if (t === undefined) throw new Error(`no row for ${k.dir}/${k.id}`)
  return t
}

/** The duration ladder is 2^i, so index i covers [2^i, 2^(i+1)). */
const bucketOf = (ms: number): number => (ms < 1 ? 0 : Math.floor(Math.log2(ms)))

describe('grp.openMs — how long a group stayed open', () => {
  it('measures first object to last object of the same group', () => {
    const { engine, sink } = setup()
    engine.onObject(obj(100, { groupId: 0n }))
    engine.onObject(obj(180, { groupId: 0n, objectId: 1n }))
    // Group 1 starting is what closes group 0: MoQT has no end-of-group marker.
    engine.onObject(obj(200, { groupId: 1n }))
    engine.tick(1_000)

    const h = rowFor(sink.lastRollup(), TX).hist.groupOpenMs
    expect(h?.n).toBe(1)
    expect(h?.sum).toBe(80)
    expect(h?.i).toEqual([bucketOf(80)])
  })

  it('never reports the group that is still open', () => {
    // The last group of a track has not closed, and reporting it at the drain
    // boundary would report the interval's own edge as the group's duration.
    const { engine, sink } = setup()
    engine.onObject(obj(100, { groupId: 0n }))
    engine.onObject(obj(180, { groupId: 0n, objectId: 1n }))
    engine.tick(1_000)
    expect(rowFor(sink.lastRollup(), TX).hist.groupOpenMs).toBeUndefined()
  })

  it('reports a group that straddled a drain in the interval it closed in', () => {
    // The whole span, not the part that fell inside one interval: a group is
    // one thing and half of it is not a shorter group.
    const { engine, sink } = setup()
    engine.onObject(obj(900, { groupId: 0n }))
    engine.tick(1_000)
    expect(rowFor(sink.lastRollup(), TX).hist.groupOpenMs).toBeUndefined()

    engine.onObject(obj(1_100, { groupId: 0n, objectId: 1n }))
    engine.onObject(obj(1_200, { groupId: 1n }))
    engine.tick(2_000)

    const h = rowFor(sink.lastRollup(), TX).hist.groupOpenMs
    expect(h?.n).toBe(1)
    expect(h?.sum).toBe(200)
  })

  it('does not let a late object reopen a group that already closed', () => {
    // Reopening would make the histogram depend on arrival order, and the
    // lateness is already counted as `outOfOrder`.
    const { engine, sink } = setup()
    engine.onObject(obj(100, { groupId: 0n }))
    engine.onObject(obj(150, { groupId: 0n, objectId: 1n }))
    engine.onObject(obj(200, { groupId: 1n }))
    engine.onObject(obj(900, { groupId: 0n, objectId: 2n }))
    engine.onObject(obj(950, { groupId: 2n }))
    engine.tick(1_000)

    const t = rowFor(sink.lastRollup(), TX)
    expect(t.outOfOrder).toBe(1)
    // Group 0 = 50 ms, group 1 = 0 ms. The 900 ms straggler contributes to
    // neither, and in particular group 0 is not 800 ms.
    expect(t.hist.groupOpenMs?.n).toBe(2)
    expect(t.hist.groupOpenMs?.sum).toBe(50)
  })

  it('records an instant group as zero rather than dropping it', () => {
    // A one-object group is real and its span is 0. Skipping it would bias the
    // distribution towards slow groups exactly where a publisher looks.
    const { engine, sink } = setup()
    engine.onObject(obj(100, { groupId: 0n }))
    engine.onObject(obj(200, { groupId: 1n }))
    engine.onObject(obj(300, { groupId: 2n }))
    engine.tick(1_000)

    const h = rowFor(sink.lastRollup(), TX).hist.groupOpenMs
    expect(h?.n).toBe(2)
    expect(h?.sum).toBe(0)
    expect(h?.i).toEqual([0])
  })

  it('keeps both directions, because a subscriber has group spans too', () => {
    const { engine, sink } = setup()
    for (const k of [TX, RX]) {
      engine.onObject(obj(100, { key: k, groupId: 0n }))
      engine.onObject(obj(140, { key: k, groupId: 0n, objectId: 1n }))
      engine.onObject(obj(200, { key: k, groupId: 1n }))
    }
    engine.tick(1_000)
    const r = sink.lastRollup()
    expect(rowFor(r, TX).hist.groupOpenMs?.sum).toBe(40)
    expect(rowFor(r, RX).hist.groupOpenMs?.sum).toBe(40)
  })
})

describe('pub.blockedMs — time the page spent awaiting writer.ready', () => {
  it('sums the interval, per track', () => {
    const { engine, sink } = setup()
    engine.onObject(obj(10))
    engine.observeWriterBlocked(TX, 12, 20)
    engine.observeWriterBlocked(TX, 30, 40)
    engine.tick(1_000)
    expect(rowFor(sink.lastRollup(), TX).blockedMs).toBe(42)
  })

  it('is absent, not zero, on a track that never blocked', () => {
    // Every rx track would otherwise carry a field that can only ever be 0.
    const { engine, sink } = setup()
    engine.onObject(obj(10, { key: RX }))
    engine.tick(1_000)
    const t = rowFor(sink.lastRollup(), RX)
    expect(t.blockedMs).toBeUndefined()
    expect('blockedMs' in t).toBe(false)
  })

  it('does not carry into the next interval', () => {
    const { engine, sink } = setup()
    engine.onObject(obj(10))
    engine.observeWriterBlocked(TX, 42, 20)
    engine.tick(1_000)
    engine.onObject(obj(1_010))
    engine.tick(2_000)
    expect(rowFor(sink.lastRollup(), TX).blockedMs).toBeUndefined()
  })

  it('emits a row for a track that only blocked and sent nothing', () => {
    // The worst interval a publisher can have — blocked throughout, nothing
    // completed — must not be the one that reports nothing. Gating the row on
    // objects alone would drop it and spill its total into a later interval.
    const { engine, sink } = setup()
    engine.observeWriterBlocked(TX, 950, 500)
    engine.tick(1_000)

    const t = rowFor(sink.lastRollup(), TX)
    expect(t.blockedMs).toBe(950)
    expect(t.objects).toBe(0)
    // And it is placeable in time, rather than bounded by whatever the last
    // object happened to leave behind.
    expect(t.firstSeen).toBe(500)
    expect(t.lastSeen).toBe(500)
  })

  it('still counts an unattributable episode in the session total', () => {
    // `writer.ready` can resolve before the subgroup header naming the track
    // has been written. Those episodes have no bucket, and the session
    // histogram has to remain a true total regardless.
    const { engine, sink } = setup()
    engine.observeWriterReady(64)
    engine.tick(1_000)
    expect(sink.lastRollup().session['wt.writerReadyMs.n']).toBe(1)
    expect(sink.lastRollup().session['wt.writerReadyMs.sum']).toBe(64)
  })
})

describe('pub.ackedBytes — what the transport confirmed', () => {
  it('sums deltas of a stat that is cumulative per stream', () => {
    const { engine, sink } = setup()
    engine.onObject(obj(10))
    engine.observeAckedBytes(TX, 1_000, 20)
    engine.observeAckedBytes(TX, 500, 30)
    engine.tick(1_000)
    expect(rowFor(sink.lastRollup(), TX).ackedBytes).toBe(1_500)
  })

  it('is absent on a track with nothing acknowledged', () => {
    const { engine, sink } = setup()
    engine.onObject(obj(10, { key: RX }))
    engine.tick(1_000)
    expect('ackedBytes' in rowFor(sink.lastRollup(), RX)).toBe(false)
  })

  it('ignores a non-positive delta rather than clamping it', () => {
    // Two getStats() promises resolving out of order is the only way one
    // arrives; folding in a corrected-downwards figure would double-count.
    const { engine, sink } = setup()
    engine.onObject(obj(10))
    engine.observeAckedBytes(TX, 1_000, 20)
    engine.observeAckedBytes(TX, -400, 30)
    engine.tick(1_000)
    expect(rowFor(sink.lastRollup(), TX).ackedBytes).toBe(1_000)
  })
})
