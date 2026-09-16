/**
 * The interval rollup and the per-track state under it.
 *
 * Behaviour tests against the two seams the rest of the package sees: the
 * {@link CountingSink} the decoder writes into and the {@link RecordSink} the
 * flush queue reads out of. What a bucket keeps internally is not asserted —
 * what is asserted is that the wire numbers are the ones the interval
 * contained, that they survive `JSON.stringify`, and that per-interval counters
 * and the cross-interval median each live exactly as long as they must.
 */

import { describe, expect, it } from 'vitest'
import { SlidingMedian } from '../../rollup/bucket.js'
import { CustomMetrics } from '../../rollup/custom-metrics.js'
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
  /** `after` is the record count at the moment the frame was written. */
  readonly frames: { after: number; bytes: Uint8Array }[] = []

  json(r: EnvelopeRecord): void {
    this.records.push(r)
  }

  raw(bytes: Uint8Array): void {
    this.frames.push({ after: this.records.length, bytes })
  }

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
  wallMs = 1_700_000_000_000

  now(): Mono {
    return this.mono
  }

  wall(): number {
    return this.wallMs
  }
}

function setup(o: Partial<RollupEngineOptions> = {}) {
  const sink = new Recorder()
  const clock = new FakeClock()
  const engine = new RollupEngine({
    intervalMs: 1_000,
    maxBuckets: 8,
    clock,
    sink,
    ...o,
  })
  return { engine, sink, clock }
}

const key = (o: Partial<BucketKey> = {}): BucketKey => ({
  dir: 'rx',
  kind: 'alias',
  id: 7n,
  epoch: 0,
  ...o,
})

const K = key()

function obj(at: Mono, o: Partial<ObjectSample> = {}): ObjectSample {
  return { key: K, groupId: 0n, objectId: 0n, headerBytes: 4, payloadBytes: 100, at, ...o }
}

function track(r: RollupRecord, i = 0): RollupTrackWire {
  const t = r.tracks[i]
  if (t === undefined) throw new Error(`no track row at index ${i}`)
  return t
}

describe('SlidingMedian', () => {
  it('has no median before it has a sample', () => {
    expect(new SlidingMedian(5).median()).toBeUndefined()
  })

  it('reports an observed value for an odd window', () => {
    const m = new SlidingMedian(5)
    for (const v of [9, 1, 7, 3, 5]) m.push(v)
    expect(m.median()).toBe(5)
  })

  it('averages the middle pair for an even occupancy', () => {
    const m = new SlidingMedian(4)
    for (const v of [1, 2, 3, 4]) m.push(v)
    expect(m.median()).toBe(2.5)
  })

  it('slides: only the last N samples count, so a cadence change re-warms', () => {
    const m = new SlidingMedian(5)
    for (const v of [1000, 1000, 1000, 1000, 1000]) m.push(v)
    expect(m.median()).toBe(1000)
    for (const v of [40, 40, 40, 40, 40]) m.push(v)
    expect(m.median()).toBe(40)
  })

  it('counts every sample it ever saw, not the window occupancy', () => {
    const m = new SlidingMedian(3)
    for (let i = 0; i < 10; i++) m.push(i)
    expect(m.samples).toBe(10)
  })

  it('survives repeated equal values, which a per-frame track produces constantly', () => {
    const m = new SlidingMedian(3)
    for (let i = 0; i < 20; i++) m.push(16)
    expect(m.median()).toBe(16)
  })

  it('ignores a non-finite sample rather than sorting NaN into the window', () => {
    const m = new SlidingMedian(3)
    m.push(10)
    m.push(Number.NaN)
    m.push(Number.POSITIVE_INFINITY)
    expect(m.median()).toBe(10)
    expect(m.samples).toBe(1)
  })

  it('is exact against a brute-force median for hundreds of laps of the window', () => {
    // The only check that catches an off-by-one between the evict and the
    // insert, which leaves values in the sorted array the ring no longer holds:
    // warm-up and a constant cadence agree anyway, and only a varying cadence
    // diverges — which is the track the cadence trigger is for. Deterministic
    // LCG, so a failure is reproducible rather than a flake.
    const brute = (xs: readonly number[]): number => {
      const s = [...xs].sort((a, b) => a - b)
      const n = s.length
      return n % 2 === 1
        ? (s[(n - 1) >> 1] as number)
        : ((s[n / 2 - 1] as number) + (s[n / 2] as number)) / 2
    }
    for (const [cap, spread] of [
      [1, 1_000],
      [2, 1_000],
      [4, 1_000],
      [5, 7],
      [31, 1_000],
      [31, 3],
    ] as const) {
      let state = 12_345
      const m = new SlidingMedian(cap)
      const window: number[] = []
      for (let i = 0; i < 400; i++) {
        state = (state * 1_103_515_245 + 12_345) % 2_147_483_648
        const v = state % spread
        m.push(v)
        window.push(v)
        if (window.length > cap) window.shift()
        expect(m.median()).toBe(brute(window))
      }
    }
  })
})

describe('the interval record', () => {
  it('emits nothing at all when the interval was empty', () => {
    const { engine, sink } = setup()
    engine.tick(1_000)
    engine.tick(2_000)
    expect(sink.records).toEqual([])
  })

  it('carries one row per track with the interval its objects actually spanned', () => {
    const { engine, sink } = setup()
    const b = key({ id: 9n })
    engine.onObject(obj(10))
    engine.onObject(obj(20, { objectId: 1n }))
    engine.onObject(obj(30, { key: b, payloadBytes: 50, headerBytes: 2 }))
    engine.tick(1_000)

    const r = sink.lastRollup()
    expect(r.t).toBe('rollup')
    expect(r.v).toBe(1)
    expect(r.seq).toBe(0)
    expect(r.startMono).toBe(0)
    expect(r.endMono).toBe(1_000)
    expect(r.tracks.length).toBe(2)

    const a = track(r, 0)
    expect(a.key).toEqual({ d: 'rx', k: 'alias', v: '7', e: 0 })
    expect(a.objects).toBe(2)
    expect(a.payloadBytes).toBe(200)
    expect(a.headerBytes).toBe(8)
    expect(a.firstSeen).toBe(10)
    expect(a.lastSeen).toBe(20)
    expect(track(r, 1).objects).toBe(1)
  })

  it('stamps every record baseline, because the rollup is produced at every level', () => {
    // Detail and metrics.interval are decoupled: the rollup is produced at
    // every level, so this record would have been sent regardless.
    const { engine, sink } = setup()
    engine.onObject(obj(1))
    engine.tick(1_000)
    expect(sink.lastRollup().lvl).toBe('baseline')
  })

  it('survives JSON.stringify — the id is a bigint and would throw as a number', () => {
    const { engine, sink } = setup()
    const big = key({ id: 2n ** 62n })
    engine.onObject(obj(1, { key: big }))
    engine.tick(1_000)
    const r = sink.lastRollup()
    expect(track(r).key.v).toBe('4611686018427387904')
    expect(() => JSON.stringify(r)).not.toThrow()
  })

  it('numbers the intervals and resets the counters between them', () => {
    const { engine, sink } = setup()
    engine.onObject(obj(10))
    engine.tick(1_000)
    engine.onObject(obj(1_100))
    engine.tick(2_000)
    const rs = sink.rollups()
    expect(rs.map((r) => r.seq)).toEqual([0, 1])
    expect(track(rs[1] as RollupRecord).objects).toBe(1)
    expect(rs[1]?.startMono).toBe(1_000)
  })

  it('reports every Mono relative to the session anchor', () => {
    const { engine, sink } = setup({ originMono: 500 })
    engine.onObject(obj(600))
    engine.tick(1_500)
    const r = sink.lastRollup()
    expect(r.ts).toBe(1_000)
    // The first interval starts at the anchor, not at its first object: ingest
    // divides by endMono - startMono to get obj.rate, and starting at the first
    // object would overstate the rate of the interval containing setup.
    expect(r.startMono).toBe(0)
    expect(r.endMono).toBe(1_000)
    expect(track(r).firstSeen).toBe(100)
  })

  it('omits a track that saw nothing this interval rather than shipping an empty row', () => {
    const { engine, sink } = setup()
    engine.onObject(obj(10))
    engine.tick(1_000)
    engine.onObject(obj(1_100, { key: key({ id: 42n }) }))
    engine.tick(2_000)
    const r = sink.lastRollup()
    expect(r.tracks.length).toBe(1)
    expect(track(r).key.v).toBe('42')
  })
})

describe('per-track counting', () => {
  it('counts a group the first time its id exceeds every id seen', () => {
    const { engine, sink } = setup()
    engine.onObject(obj(1, { groupId: 0n }))
    engine.onObject(obj(2, { groupId: 1n }))
    engine.onObject(obj(3, { groupId: 1n, objectId: 1n }))
    engine.tick(1_000)
    expect(track(sink.lastRollup()).groups).toBe(2)
  })

  it('counts the group ids that never arrived', () => {
    const { engine, sink } = setup()
    engine.onObject(obj(1, { groupId: 0n }))
    engine.onObject(obj(2, { groupId: 3n }))
    engine.tick(1_000)
    const t = track(sink.lastRollup())
    expect(t.groups).toBe(2)
    expect(t.groupGaps).toBe(2)
  })

  it('clamps an absurd group-id discontinuity, which merges by addition downstream', () => {
    const { engine, sink } = setup()
    engine.onObject(obj(1, { groupId: 0n }))
    engine.onObject(obj(2, { groupId: 2n ** 60n }))
    engine.tick(1_000)
    expect(track(sink.lastRollup()).groupGaps).toBe(1_000_000)
  })

  it('counts a group below the highest seen as late, not as new', () => {
    const { engine, sink } = setup()
    engine.onObject(obj(1, { groupId: 0n }))
    engine.onObject(obj(2, { groupId: 1n }))
    engine.onObject(obj(3, { groupId: 0n, objectId: 1n }))
    engine.tick(1_000)
    const t = track(sink.lastRollup())
    expect(t.outOfOrder).toBe(1)
    expect(t.groups).toBe(2)
  })

  it('does not call interleaved subgroups of one group out of order', () => {
    // Object ids ascend per subgroup, not per group, and the counting decoder
    // carries no subgroup id — so within-group ordering is deliberately not
    // judged. The resulting under-report is documented in bucket.ts.
    const { engine, sink } = setup()
    for (const id of [0n, 5n, 1n, 6n, 2n]) engine.onObject(obj(1, { groupId: 0n, objectId: id }))
    engine.tick(1_000)
    expect(track(sink.lastRollup()).outOfOrder).toBe(0)
  })

  it('counts a repeated group/object pair as a duplicate', () => {
    const { engine, sink } = setup()
    engine.onObject(obj(1, { groupId: 3n, objectId: 4n }))
    engine.onObject(obj(2, { groupId: 3n, objectId: 4n }))
    engine.onObject(obj(3, { groupId: 3n, objectId: 5n }))
    engine.tick(1_000)
    const t = track(sink.lastRollup())
    expect(t.duplicates).toBe(1)
    expect(t.objects).toBe(3)
  })

  it('counts status objects, which carry no payload', () => {
    const { engine, sink } = setup()
    engine.onObject(obj(1, { payloadBytes: 0, status: 3n }))
    engine.onObject(obj(2, { objectId: 1n }))
    engine.tick(1_000)
    expect(track(sink.lastRollup()).statusObjects).toBe(1)
  })

  it('histograms object size with its denominator', () => {
    const { engine, sink } = setup()
    engine.onObject(obj(1, { payloadBytes: 100 }))
    engine.onObject(obj(2, { objectId: 1n, payloadBytes: 200 }))
    engine.tick(1_000)
    const h = track(sink.lastRollup()).hist.objectSizeBytes
    expect(h?.n).toBe(2)
    expect(h?.sum).toBe(300)
  })

  it('ships no histogram at all for a distribution with no samples', () => {
    const { engine, sink } = setup()
    engine.onObject(obj(1))
    engine.tick(1_000)
    const h = track(sink.lastRollup()).hist
    expect(h.interArrivalMs).toBeUndefined()
    expect(h.stallMs).toBeUndefined()
  })

  it('flags a shared alias only when the control plane says so', () => {
    const { engine, sink } = setup()
    engine.onObject(obj(1))
    engine.tick(1_000)
    expect(track(sink.lastRollup()).shared).toBeUndefined()

    engine.markShared(K)
    engine.onObject(obj(1_100))
    engine.tick(2_000)
    expect(track(sink.lastRollup()).shared).toBe(true)
  })
})

describe('inter-arrival, the median, and their lifetimes', () => {
  it('measures the gap across the interval boundary, not from the boundary', () => {
    const { engine, sink } = setup()
    engine.onObject(obj(0))
    engine.onObject(obj(100, { objectId: 1n }))
    engine.tick(1_000)
    engine.onObject(obj(1_300, { objectId: 2n }))
    engine.tick(2_000)

    const first = track(sink.rollups()[0] as RollupRecord).hist.interArrivalMs
    expect(first?.n).toBe(1)
    expect(first?.sum).toBe(100)

    const second = track(sink.rollups()[1] as RollupRecord).hist.interArrivalMs
    expect(second?.n).toBe(1)
    // 1300 - 100, not 1300 - 1000: resetting `lastAt` at the boundary would
    // silently drop the longest gaps of the session.
    expect(second?.sum).toBe(1_200)
  })

  it('has no median until the track is warm, so a trigger cannot fire early', () => {
    const { engine } = setup()
    engine.onObject(obj(0))
    engine.onObject(obj(100, { objectId: 1n }))
    expect(engine.medianFor(K)).toBeUndefined()
    for (let i = 2; i < 8; i++) engine.onObject(obj(i * 100, { objectId: BigInt(i) }))
    expect(engine.medianFor(K)).toBe(100)
    expect(engine.medianSamplesFor(K)).toBe(7)
  })

  it('keeps the median across the interval reset — it must not un-warm every minute', () => {
    const { engine } = setup()
    for (let i = 0; i < 8; i++) engine.onObject(obj(i * 100, { objectId: BigInt(i) }))
    expect(engine.medianFor(K)).toBe(100)
    engine.tick(1_000)
    expect(engine.medianFor(K)).toBe(100)
    expect(engine.medianSamplesFor(K)).toBe(7)
  })

  it('reports no median for a track it has never seen, and opens no bucket asking', () => {
    const { engine } = setup()
    expect(engine.medianFor(key({ id: 999n }))).toBeUndefined()
    expect(engine.medianSamplesFor(key({ id: 999n }))).toBe(0)
    expect(engine.bucketCount).toBe(0)
  })

  it('answers a key object it has never seen before but is equal to a known one', () => {
    const { engine } = setup()
    for (let i = 0; i < 8; i++) engine.onObject(obj(i * 100, { objectId: BigInt(i) }))
    // A different object, the same logical key: the identity cache must not
    // turn one track into two.
    expect(engine.medianFor(key())).toBe(100)
    expect(engine.bucketCount).toBe(1)
  })
})

describe('stalls', () => {
  const steady = (engine: RollupEngine, n: number, stepMs: number, from = 0): number => {
    let at = from
    for (let i = 0; i < n; i++) {
      engine.onObject(obj(at, { objectId: BigInt(i), groupId: BigInt(i) }))
      at += stepMs
    }
    return at
  }

  it('reports no stall on a track arriving at its own steady cadence', () => {
    const { engine, sink } = setup()
    steady(engine, 12, 100)
    engine.tick(2_000)
    expect(track(sink.lastRollup()).hist.stallMs).toBeUndefined()
  })

  it("counts a gap past a multiple of the track's own median as a stall", () => {
    const { engine, sink } = setup()
    // `steady` leaves `at` one step past the last object it sent, so the gap
    // the stall measures is 5_000 + one 100 ms step.
    const at = steady(engine, 12, 100)
    engine.onObject(obj(at + 5_000, { objectId: 99n, groupId: 99n }))
    engine.tick(10_000)
    const h = track(sink.lastRollup()).hist.stallMs
    // One histogram carries stall.count (n), stall.totalMs (sum)
    // and, to a bucket, stall.maxMs.
    expect(h?.n).toBe(1)
    expect(h?.sum).toBe(5_100)
  })

  it('calibrates per track: the same gap is a stall on one track and not on another', () => {
    const { engine, sink } = setup()
    const fast = key({ id: 1n })
    const slow = key({ id: 2n })
    let a = 0
    let b = 0
    for (let i = 0; i < 12; i++) {
      engine.onObject(obj(a, { key: fast, objectId: BigInt(i) }))
      engine.onObject(obj(b, { key: slow, objectId: BigInt(i) }))
      a += 100
      b += 2_000
    }
    // 900 ms: nine times the fast track's cadence, under half the slow one's.
    engine.onObject(obj(a + 900, { key: fast, objectId: 99n }))
    engine.onObject(obj(b + 900, { key: slow, objectId: 99n }))
    engine.tick(100_000)
    const r = sink.lastRollup()
    const rows = new Map(r.tracks.map((t) => [t.key.v, t]))
    expect(rows.get('1')?.hist.stallMs?.n).toBe(1)
    expect(rows.get('2')?.hist.stallMs).toBeUndefined()
  })

  it('does not call an ordinary sub-floor gap a stall while the median is cold', () => {
    const { engine, sink } = setup()
    engine.onObject(obj(0))
    engine.onObject(obj(60, { objectId: 1n }))
    engine.tick(1_000)
    expect(track(sink.lastRollup()).hist.stallMs).toBeUndefined()
  })

  it('judges no gap at all until the median is warm, so a 2 s GOP starts clean', () => {
    // An absolute floor would call every ordinary group boundary of a 2 s-GOP
    // track a stall until the median warms — five false stalls at the start of
    // every session, on the metric closest to a QoE number MoQT has.
    const { engine, sink } = setup()
    steady(engine, 5, 2_000)
    engine.tick(20_000)
    const t = track(sink.lastRollup())
    expect(t.hist.stallMs).toBeUndefined()
    // The gaps themselves are still reported — they are just not judged.
    expect(t.hist.interArrivalMs?.n).toBe(4)
  })

  it('judges gaps once the median is warm, on the same track', () => {
    const { engine, sink } = setup()
    const at = steady(engine, 8, 2_000)
    engine.onObject(obj(at + 20_000, { objectId: 99n, groupId: 99n }))
    engine.tick(60_000)
    expect(track(sink.lastRollup()).hist.stallMs?.n).toBe(1)
  })
})

describe('the control plane at baseline', () => {
  it('writes the ctrl record first and exactly one raw frame after it', () => {
    const { engine, sink } = setup()
    const bytes = new Uint8Array([0x2f, 0x00, 0x01, 0x02])
    engine.onControlFrame({ dir: 'tx', streamId: 3, at: 12, bytes, message: {} })

    expect(sink.records.length).toBe(1)
    const rec = sink.records[0]
    expect(rec?.t).toBe('ctrl')
    if (rec?.t !== 'ctrl') throw new Error('expected a ctrl record')
    expect(rec.dir).toBe('tx')
    expect(rec.streamId).toBe(3)
    expect(rec.n).toBe(4)
    expect(rec.decoded).toBe(true)
    expect(rec.lvl).toBe('baseline')
    expect(rec.ts).toBe(12)

    expect(sink.frames.length).toBe(1)
    expect(sink.frames[0]?.after).toBe(1)
    expect(sink.frames[0]?.bytes).toBe(bytes)
  })

  it('ships a frame that did not decode, flagged rather than dropped', () => {
    // An unknown or extension codepoint is counted and skipped, never
    // fatal. The bytes still go, because ingest reparses server-side.
    const { engine, sink } = setup()
    engine.onControlFrame({
      dir: 'rx',
      streamId: 1,
      at: 5,
      bytes: new Uint8Array([0xff, 0xff]),
      message: null,
    })
    engine.tick(1_000)
    const rec = sink.records[0]
    if (rec?.t !== 'ctrl') throw new Error('expected a ctrl record')
    expect(rec.decoded).toBe(false)
    expect(sink.frames.length).toBe(1)
    expect(sink.lastRollup().session['ctrl.undecoded']).toBe(1)
  })

  it('counts control frames and bytes per direction', () => {
    const { engine, sink } = setup()
    const bytes = new Uint8Array(5)
    engine.onControlFrame({ dir: 'rx', streamId: 1, at: 1, bytes, message: {} })
    engine.onControlFrame({ dir: 'rx', streamId: 1, at: 2, bytes, message: {} })
    engine.onControlFrame({ dir: 'tx', streamId: 2, at: 3, bytes, message: {} })
    engine.tick(1_000)
    const s = sink.lastRollup().session
    expect(s['ctrl.rx.frames']).toBe(2)
    expect(s['ctrl.rx.bytes']).toBe(10)
    expect(s['ctrl.tx.frames']).toBe(1)
  })

  it('carries control latency as additive keys that keep the distribution', () => {
    const { engine, sink } = setup()
    engine.observeControlLatency('subscribe', 40)
    engine.observeControlLatency('subscribe', 50)
    engine.observeControlLatency('fetch', 300)
    engine.tick(1_000)
    const s = sink.lastRollup().session
    expect(s['ctl.subscribe.count']).toBe(2)
    expect(s['ctl.subscribe.latencyMs.n']).toBe(2)
    expect(s['ctl.subscribe.latencyMs.sum']).toBe(90)
    expect(s['ctl.subscribe.latencyMs.b5']).toBe(2)
    expect(s['ctl.fetch.latencyMs.n']).toBe(1)
  })

  it('resets the session counters between intervals', () => {
    const { engine, sink } = setup()
    engine.observeControlLatency('subscribe', 40)
    engine.tick(1_000)
    engine.observeControlLatency('subscribe', 40)
    engine.tick(2_000)
    expect(sink.rollups()[1]?.session['ctl.subscribe.latencyMs.n']).toBe(1)
  })

  it("carries writer.ready latency, a publish-only session's only pressure signal", () => {
    const { engine, sink } = setup()
    engine.observeWriterReady(3)
    engine.observeWriterReady(9)
    engine.tick(1_000)
    expect(sink.lastRollup().session['wt.writerReadyMs.n']).toBe(2)
  })
})

describe('parse failures', () => {
  it('attributes a failure to its track and to the session', () => {
    const { engine, sink } = setup()
    engine.onObject(obj(1))
    engine.onParseFailure(K, 'subgroup-desync')
    engine.tick(1_000)
    const r = sink.lastRollup()
    expect(track(r).parseFailures).toBe(1)
    expect(r.session['parse.subgroup-desync']).toBe(1)
    expect(engine.parseFailures).toBe(1)
  })

  it('records a failure that never reached a bucket', () => {
    const { engine, sink } = setup()
    engine.onParseFailure(null, 'malformed-control')
    engine.tick(1_000)
    const r = sink.lastRollup()
    expect(r.tracks).toEqual([])
    expect(r.session['parse.malformed-control']).toBe(1)
  })

  it('emits a row for a track whose only activity was a failure', () => {
    const { engine, sink, clock } = setup()
    clock.mono = 250
    engine.onParseFailure(K, 'fetch-desync')
    engine.tick(1_000)
    const t = track(sink.lastRollup())
    expect(t.objects).toBe(0)
    expect(t.parseFailures).toBe(1)
    expect(t.firstSeen).toBe(250)
  })
})

describe('bounds', () => {
  it('refuses a bucket past the cap and counts it rather than merging tracks', () => {
    const { engine, sink } = setup({ maxBuckets: 2 })
    engine.onObject(obj(1, { key: key({ id: 1n }) }))
    engine.onObject(obj(2, { key: key({ id: 2n }) }))
    engine.onObject(obj(3, { key: key({ id: 3n }) }))
    engine.tick(1_000)
    const r = sink.lastRollup()
    expect(engine.bucketCount).toBe(2)
    expect(engine.bucketsRefused).toBe(1)
    expect(r.tracks.length).toBe(2)
    expect(r.session['buckets.refused']).toBe(1)
    expect(r.tracks.map((t) => t.key.v).sort()).toEqual(['1', '2'])
  })

  it('keeps a silent track alive long enough for a stall to be noticed', () => {
    // Eviction must not destroy the median the stall trigger reads: a
    // stalled track is, by definition, one producing no objects.
    const { engine } = setup({ idleEvictIntervals: 2 })
    for (let i = 0; i < 8; i++) engine.onObject(obj(i * 100, { objectId: BigInt(i) }))
    engine.tick(1_000)
    engine.tick(2_000)
    expect(engine.bucketCount).toBe(1)
    expect(engine.medianFor(K)).toBe(100)
  })

  it('evicts a track that has been silent past the horizon', () => {
    const { engine } = setup({ idleEvictIntervals: 2 })
    for (let i = 0; i < 8; i++) engine.onObject(obj(i * 100, { objectId: BigInt(i) }))
    engine.tick(1_000)
    engine.tick(5_000)
    expect(engine.bucketCount).toBe(0)
    expect(engine.medianFor(K)).toBeUndefined()
  })

  it('opens a fresh bucket after eviction, even for the same key object', () => {
    const { engine, sink } = setup({ idleEvictIntervals: 2 })
    engine.onObject(obj(0))
    engine.tick(1_000)
    engine.tick(5_000)
    engine.onObject(obj(5_100))
    engine.tick(6_000)
    expect(engine.bucketCount).toBe(1)
    expect(track(sink.lastRollup()).objects).toBe(1)
  })
})

describe('clocks', () => {
  it('says nothing about suspension on the first interval', () => {
    const { engine, sink } = setup()
    engine.onObject(obj(1))
    engine.tick(1_000)
    expect(sink.lastRollup().suspended).toBeUndefined()
  })

  it('reports the device sleeping as an explanation, not an error', () => {
    const { engine, sink, clock } = setup()
    engine.onObject(obj(1))
    clock.wallMs += 1_000
    engine.tick(1_000)
    engine.onObject(obj(1_100))
    // Thirty seconds of wall clock passed while one second of monotonic did.
    clock.wallMs += 30_000
    engine.tick(2_000)
    expect(sink.rollups()[0]?.suspended).toBeUndefined()
    expect(sink.rollups()[1]?.suspended).toBe(true)
  })
})

describe('customer metrics on the rollup', () => {
  it('carries a defined metric and omits the field when there is none', () => {
    const custom = new CustomMetrics()
    const { engine, sink } = setup({ custom })
    engine.onObject(obj(1))
    engine.tick(1_000)
    expect(sink.lastRollup().custom).toBeUndefined()

    custom.defineMetric('decode.queueDepth', { unit: 'count', agg: 'sum' })
    custom.observe('decode.queueDepth', 3)
    engine.onObject(obj(1_100))
    engine.tick(2_000)
    expect(sink.lastRollup().custom).toEqual([
      { name: 'decode.queueDepth', unit: 'count', agg: 'sum', value: 3 },
    ])
  })

  it('emits a rollup for customer metrics alone, with no track traffic', () => {
    const custom = new CustomMetrics()
    const { engine, sink } = setup({ custom })
    custom.defineMetric('x', { unit: 'count', agg: 'sum' })
    custom.observe('x', 1)
    engine.tick(1_000)
    expect(sink.lastRollup().tracks).toEqual([])
    expect(sink.lastRollup().custom?.length).toBe(1)
  })
})
