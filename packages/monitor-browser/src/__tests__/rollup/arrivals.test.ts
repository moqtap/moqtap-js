/**
 * First-object arrival per group: the `ga` field of a receive track's rollup
 * row, and the `rq` beside it.
 *
 * `fixtures/group-arrivals.json` holds the expected `ga` and `rq` fields for
 * its objects, and the arrival each group reads back as; a produced body must
 * carry those fields exactly. `bun run fixtures <dir>` copies it in;
 * `bun run fixtures --check <dir>` fails when it differs.
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { BODY_PREAMBLE_BYTES, encodeBody, FrameWriter, readFrames } from '../../envelope/index.js'
import {
  GA_MAX_K,
  GA_RATE_WINDOW_SECS,
  GA_SEEN_WINDOW,
  GA_TARGET_GROUPS_PER_SEC,
  newRateWindow,
  rateAdd,
  rateAdvance,
  rateKept,
  rateRoundUp,
} from '../../rollup/arrivals.js'
import { RollupEngine, type RollupEngineOptions } from '../../rollup/interval.js'
import type {
  BucketKey,
  ClockSource,
  EnvelopeRecord,
  GroupArrivalsWire,
  Mono,
  ObjectSample,
  RecordSink,
  RequestLinkWire,
  RollupRecord,
  RollupTrackWire,
} from '../../types.js'

/** A track's rate window, as both monitors keep it. */
class GroupRate {
  private readonly w = newRateWindow()
  private head = -1
  advance(at: number): boolean {
    const h = this.head
    this.head = rateAdvance(this.w, h, at)
    return this.head > h && h >= 0
  }
  add(g: bigint): void {
    rateAdd(this.w, this.head, g)
  }
  kept(k: number): number {
    return rateKept(this.w, this.head, k)
  }
  roundUp(): number {
    return rateRoundUp(this.w, this.head)
  }
}

interface GoldenCase {
  readonly name: string
  readonly note: string
  readonly intervalMs: number
  readonly origin: number
  readonly start: number
  readonly objects: readonly { readonly g: string; readonly o: string; readonly at: number }[]
  readonly ga: GroupArrivalsWire
  readonly read: {
    readonly arrivals: readonly { readonly group: string; readonly sinceStartMs: number }[]
  }
}

const golden = JSON.parse(
  readFileSync(new URL('./fixtures/group-arrivals.json', import.meta.url), 'utf8'),
) as { cases: GoldenCase[]; rq: { wire: RequestLinkWire }[] }

class Sink implements RecordSink {
  readonly records: EnvelopeRecord[] = []
  json(r: EnvelopeRecord): void {
    this.records.push(r)
  }
  raw(): void {}
  rollups(): RollupRecord[] {
    return this.records.filter((r): r is RollupRecord => r.t === 'rollup')
  }
}

class Clock implements ClockSource {
  mono = 0
  now(): Mono {
    return this.mono
  }
  wall(): number {
    return 1_700_000_000_000 + this.mono
  }
}

const RX: BucketKey = { dir: 'rx', kind: 'alias', id: 7n, epoch: 0 }
const BOUND: RequestLinkWire = { d: 'tx', v: '4' }

function setup(o: Partial<RollupEngineOptions> = {}) {
  const sink = new Sink()
  const clock = new Clock()
  const engine = new RollupEngine({
    intervalMs: 10_000,
    maxBuckets: 64,
    clock,
    sink,
    requestOf: () => BOUND,
    ...o,
  })
  return { engine, sink, clock }
}

function obj(at: Mono, group: bigint, object = 0n, key: BucketKey = RX): ObjectSample {
  return { key, groupId: group, objectId: object, headerBytes: 4, payloadBytes: 100, at }
}

function rows(sink: Sink, key: BucketKey = RX): RollupTrackWire[] {
  return sink
    .rollups()
    .flatMap((r) => r.tracks)
    .filter((t) => t.key.d === key.dir && t.key.k === key.kind && t.key.v === String(key.id))
}

/** The groups a `ga` field lists, in wire order. */
function groupsOf(ga: GroupArrivalsWire): bigint[] {
  let g = BigInt(ga.g)
  return ga.at.map((_, i) => {
    if (i > 0) g += ga.dg === undefined ? 1n : BigInt(ga.dg[i]!)
    return g
  })
}

async function decodeBody(records: readonly EnvelopeRecord[]): Promise<EnvelopeRecord[]> {
  const w = new FrameWriter()
  for (const r of records) w.json(r)
  const { bytes } = await encodeBody(w.take(), { gzip: false })
  const text = new TextDecoder()
  return [...readFrames(bytes.subarray(BODY_PREAMBLE_BYTES))].map(
    (f) => JSON.parse(text.decode(f.payload)) as EnvelopeRecord,
  )
}

describe('ga against the expected fields', () => {
  for (const c of golden.cases) {
    it(`${c.name}: ${c.note}`, async () => {
      const rq: RequestLinkWire = { d: 'tx', v: '4' }
      const { engine, sink } = setup({
        intervalMs: c.intervalMs,
        originMono: c.origin,
        requestOf: () => rq,
      })
      engine.tick(c.start)
      for (const o of c.objects) engine.onObject(obj(o.at, BigInt(o.g), BigInt(o.o)))
      engine.tick(c.start + c.intervalMs)

      const [rollup] = (await decodeBody(sink.records)).filter(
        (r): r is RollupRecord => r.t === 'rollup',
      )
      const t = rollup!.tracks[0]!
      expect(t.ga).toEqual(c.ga)
      expect(t.rq).toEqual(rq)

      // Every listed group reads back, each on its rounded arrival.
      expect(c.read.arrivals.map((a) => BigInt(a.group))).toEqual(
        groupsOf(t.ga!).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
      )
      const start = Math.round(rollup!.startMono)
      const firsts = new Map<string, number>()
      for (const o of c.objects) if (!firsts.has(o.g)) firsts.set(o.g, o.at)
      for (const a of c.read.arrivals) {
        expect(start + a.sinceStartMs).toBe(Math.round(firsts.get(a.group)! - c.origin))
      }
    })
  }

  it('carries each expected request link', async () => {
    for (const { wire } of golden.rq) {
      const { engine, sink } = setup({ requestOf: () => wire })
      engine.onObject(obj(1, 0n))
      engine.tick(10)
      const [rollup] = (await decodeBody(sink.records)).filter(
        (r): r is RollupRecord => r.t === 'rollup',
      )
      expect(rollup!.tracks[0]!.rq).toEqual(wire)
    }
  })
})

describe('which groups are reported', () => {
  it('reports a group once, in the interval of its first arrival', () => {
    const { engine, sink } = setup()
    engine.onObject(obj(10, 1n))
    engine.onObject(obj(20, 2n))
    engine.tick(100)
    // Later subgroups of both groups, and a new one.
    engine.onObject(obj(110, 1n, 5n))
    engine.onObject(obj(120, 2n, 3n))
    engine.onObject(obj(130, 3n))
    engine.tick(200)
    const [a, b] = rows(sink)
    expect(groupsOf(a!.ga!)).toEqual([1n, 2n])
    expect(groupsOf(b!.ga!)).toEqual([3n])
    expect(b!.ga!.ob).toBeUndefined()
  })

  it('leaves the field off an interval with no first arrival', () => {
    const { engine, sink } = setup()
    engine.onObject(obj(10, 1n))
    engine.tick(100)
    engine.onObject(obj(110, 1n, 1n))
    engine.tick(200)
    expect(rows(sink)[1]!.ga).toBeUndefined()
  })

  it('reports nothing for a send track or a fetch', () => {
    const tx: BucketKey = { ...RX, dir: 'tx' }
    const fetch: BucketKey = { dir: 'rx', kind: 'fetch', id: 3n, epoch: 0 }
    const { engine, sink } = setup()
    engine.onObject(obj(10, 1n, 0n, tx))
    engine.onObject(obj(10, 1n, 0n, fetch))
    engine.tick(100)
    expect(rows(sink, tx)[0]!.ga).toBeUndefined()
    expect(rows(sink, fetch)[0]!.ga).toBeUndefined()
  })

  it('remembers what it reported when an idle track is evicted and opened again', () => {
    const { engine, sink } = setup()
    engine.onObject(obj(10, 5n))
    engine.tick(10_000)
    for (let i = 2; i <= 8; i++) engine.tick(i * 10_000)
    expect(engine.bucketCount).toBe(0)
    engine.onObject(obj(80_500, 5n, 3n))
    engine.tick(90_000)
    const [first, again] = rows(sink)
    expect(first!.ga).toEqual({ g: '5', at: [10] })
    expect(again!.ga).toBeUndefined()
  })

  it('reports for the request that binds a track what arrived before it did', () => {
    let rq: RequestLinkWire | undefined
    const { engine, sink } = setup({ requestOf: () => rq })
    engine.onObject(obj(10, 1n))
    engine.tick(100)
    rq = { d: 'rx', v: '2' }
    engine.onObject(obj(110, 1n, 1n))
    engine.onObject(obj(120, 2n))
    engine.tick(200)
    const [unbound, bound] = rows(sink)
    expect(unbound!.ga).toBeUndefined()
    expect(bound!.rq).toEqual(rq)
    expect(bound!.ga).toEqual({ g: '1', at: [10, 10], ob: [[0, '1']] })
  })

  it('counts a group older than every remembered one as late, and does not report it', () => {
    const { engine, sink } = setup()
    for (let g = 0; g <= GA_SEEN_WINDOW; g++) engine.onObject(obj(g, BigInt(g + 10)))
    engine.tick(1000)
    engine.onObject(obj(1001, 5n))
    engine.onObject(obj(1002, 5n, 1n))
    engine.tick(2000)
    const [, second] = sink.rollups()
    expect(second!.tracks[0]!.ga).toBeUndefined()
    expect(second!.session['ga.late']).toBe(1)
  })

  it("counts as late only a group in sample at the interval's k", () => {
    const { engine, sink } = setup({ intervalMs: 1000 })
    for (let g = 10; g < 75; g++) engine.onObject(obj(g, BigInt(g)))
    engine.tick(1000)
    for (let g = 100; g < 140; g++) engine.onObject(obj(1000 + g, BigInt(g)))
    engine.onObject(obj(1500, 5n))
    engine.onObject(obj(1501, 8n))
    engine.tick(2000)
    const [, second] = sink.rollups()
    expect(second!.tracks[0]!.ga!.k).toBe(2)
    expect(second!.session['ga.late']).toBe(1)
  })

  it('stays exact past 2^53', () => {
    const { engine, sink } = setup()
    const g = 2n ** 60n
    engine.onObject(obj(1, g))
    engine.onObject(obj(2, g + 1n))
    engine.tick(100)
    expect(groupsOf(rows(sink)[0]!.ga!)).toEqual([g, g + 1n])
  })
})

describe('sampling', () => {
  it('keeps at most ten groups a second a track, as every group 0 mod 2^k', () => {
    // 1 s interval, groups 1 to 100: k = 3 would keep 12, so k = 4 keeps 6.
    const { engine, sink } = setup({ intervalMs: 1000 })
    for (let g = 1; g <= 100; g++) engine.onObject(obj(g * 10, BigInt(g)))
    engine.tick(1000)
    const ga = rows(sink)[0]!.ga!
    expect(ga.k).toBe(4)
    expect(groupsOf(ga)).toEqual([16n, 32n, 48n, 64n, 80n, 96n])
  })

  it('chooses k per interval, from 0 again when the rate falls', () => {
    const { engine, sink } = setup({ intervalMs: 1000 })
    for (let g = 0; g < 40; g++) engine.onObject(obj(g * 20, BigInt(g)))
    engine.tick(1000)
    for (let g = 40; g < 45; g++) engine.onObject(obj(1000 + g, BigInt(g)))
    engine.tick(2000)
    const [a, b] = rows(sink)
    expect(a!.ga!.k).toBe(2)
    expect(b!.ga!.k).toBeUndefined()
    expect(groupsOf(b!.ga!)).toEqual([40n, 41n, 42n, 43n, 44n])
  })

  it('samples each track on its own, however many a connection has', () => {
    // 20 tracks at 10 groups a second: every group of every track.
    const { engine, sink } = setup({ intervalMs: 1000 })
    for (let t = 0; t < 20; t++) {
      const key: BucketKey = { ...RX, id: BigInt(t) }
      for (let g = 0; g < 10; g++) engine.onObject(obj(t * 40 + g, BigInt(g), 0n, key))
    }
    engine.tick(1000)
    const [r] = sink.rollups()
    expect(r!.tracks).toHaveLength(20)
    for (const t of r!.tracks) {
      expect(t.ga!.k).toBeUndefined()
      expect(groupsOf(t.ga!)).toEqual([0n, 1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n, 9n])
    }
    expect(r!.session['ga.dropped']).toBeUndefined()
  })

  it('keeps a minute of two fast tracks within one 32 KiB upload', () => {
    // Two tracks at 1,000 groups a second, six 10 s intervals.
    const { engine, sink } = setup({ requestOf: () => ({ d: 'tx', v: '1' }) })
    const keys: BucketKey[] = [RX, { ...RX, id: 8n }]
    let g = 0
    for (let i = 0; i < 6; i++) {
      for (let ms = 0; ms < 10_000; ms++) {
        const at = i * 10_000 + ms + 0.37
        for (const k of keys) engine.onObject(obj(at, BigInt(g), 0n, k))
        g++
      }
      engine.tick((i + 1) * 10_000)
    }
    const bytes = sink.rollups().reduce((n, r) => n + JSON.stringify(r).length, 0)
    expect(bytes).toBeLessThan(32 * 1024)
    for (const r of sink.rollups())
      for (const t of r.tracks) expect(t.ga!.at.length).toBeLessThanOrEqual(100)
  })
})

describe('the rate rule', () => {
  it('rounds k up from the rate over the whole seconds before the current one', () => {
    // (rate, id step, k): the smallest k keeping at most 100 of a window.
    for (const [rate, step, k] of [
      [5, 1, 0],
      [10, 1, 0],
      [15, 1, 1],
      [30, 1, 2],
      [40, 1, 2],
      [50, 1, 3],
      [1000, 1, 7],
      [30, 2, 3],
      [40, 4, 4],
    ] as const) {
      const r = new GroupRate()
      for (let i = 0; i < rate * 30; i++) {
        r.advance((i * 1000) / rate)
        r.add(BigInt(i * step))
      }
      expect([rate, step, r.roundUp()]).toEqual([rate, step, k])
      expect(r.kept(0)).toBe(rate * GA_RATE_WINDOW_SECS)
    }
  })

  it('lowers k only as the window empties after the rate falls', () => {
    // 80 a second for 30 s, then 10: the first interval after the fall still
    // holds the faster seconds in its window.
    const { engine, sink } = setup()
    let g = 0
    let next = 10_000
    for (let ms = 0; ms < 60_000; ms += ms < 30_000 ? 12.5 : 100) {
      if (ms >= next) {
        engine.tick(next)
        next += 10_000
      }
      engine.onObject(obj(ms, BigInt(g++)))
    }
    engine.tick(next)
    // The fourth interval alone would keep every group at k = 0.
    expect(rows(sink).map((t) => t.ga!.k ?? 0)).toEqual([3, 3, 3, 3, 0, 0])
  })
})

/**
 * The producer monitor's rule (`moqtap_monitor` `sampling::producer_k`): the
 * largest k keeping more than the target over the same window, lowered at
 * once and raised only past an eighth over the target.
 */
function producerK(r: GroupRate, k: number): number {
  const target = GA_TARGET_GROUPS_PER_SEC * GA_RATE_WINDOW_SECS
  const above = (n: number): number => {
    for (let j = 20; j > 0; j--) if (r.kept(j) > n) return j
    return 0
  }
  if (k > 0 && r.kept(k) <= target) return above(target)
  return Math.max(k, above(target * 1.125))
}

/** Group ids stepping by `step` and their send times, for `[groups a second, seconds]` phases. */
function schedule(
  step: number,
  phases: readonly (readonly [number, number])[],
): [bigint, number][] {
  const out: [bigint, number][] = []
  let t0 = 0
  let g = 0n
  for (const [rate, secs] of phases) {
    for (let i = 0; i < rate * secs; i++) {
      out.push([g, t0 + (i * 1000) / rate])
      g += BigInt(step)
    }
    t0 += secs * 1000
  }
  return out
}

describe('the viewer sample within the producer sample', () => {
  /** The producer's sample and its k as each group started. */
  function producer(groups: readonly [bigint, number][]) {
    const r = new GroupRate()
    let k = 0
    const kept = new Set<bigint>()
    const ks: number[] = []
    for (const [g, ms] of groups) {
      if (r.advance(ms)) k = producerK(r, k)
      r.add(g)
      ks.push(k)
      if (g % (1n << BigInt(k)) === 0n) kept.add(g)
    }
    return { kept, ks }
  }

  /** This monitor's sample, on a clock `offset` ms later, and each group's interval k. */
  function viewer(groups: readonly [bigint, number][], offset: number) {
    const { engine, sink } = setup()
    let next = 10_000
    let interval = 0
    const of: number[] = []
    for (const [g, ms] of groups) {
      const at = ms + offset
      while (at >= next) {
        engine.tick(next)
        next += 10_000
        interval++
      }
      engine.onObject(obj(at, g))
      of.push(interval)
    }
    engine.tick(next)
    const byInterval = sink.rollups().map((r) => r.tracks[0]?.ga)
    expect(sink.rollups().every((r) => r.session['ga.dropped'] === undefined)).toBe(true)
    const kept = byInterval.flatMap((ga) => (ga === undefined ? [] : groupsOf(ga)))
    // An interval that kept no group reports no k: nothing of it can be missing.
    const kOf = (ga: GroupArrivalsWire | undefined) => (ga === undefined ? GA_MAX_K : (ga.k ?? 0))
    return { kept, ks: of.map((i) => kOf(byInterval[i])) }
  }

  function check(step: number, phases: readonly (readonly [number, number])[]): void {
    const groups = schedule(step, phases)
    const p = producer(groups)
    for (const offset of [50, 7_371.7, 9_999]) {
      const v = viewer(groups, offset)
      expect(v.kept.length).toBeGreaterThan(0)
      for (let i = 0; i < groups.length; i++) {
        if (p.ks[i]! > v.ks[i]!) {
          expect.fail(
            `${phases} +${offset}: group ${groups[i]![0]} producer k ${p.ks[i]} > ${v.ks[i]}`,
          )
        }
      }
      expect(v.kept.filter((g) => !p.kept.has(g))).toEqual([])
    }
  }

  it('for a steady rate', () => {
    for (const rate of [5, 12, 30, 40, 50, 300]) check(1, [[rate, 120]])
    check(2, [[30, 120]])
  })

  it('for a step in the rate', () => {
    check(1, [
      [10, 60],
      [80, 60],
      [10, 60],
    ])
    check(1, [
      [80, 60],
      [5, 60],
    ])
    check(1, [
      [40, 60],
      [160, 60],
      [20, 60],
    ])
    check(2, [
      [20, 60],
      [100, 60],
      [15, 60],
    ])
  })
})

describe('rq', () => {
  it('goes on every track the resolver binds, and not on a shared alias', () => {
    const { engine, sink } = setup({
      requestOf: (k) => (k.id === 7n ? { d: 'tx', v: '2' } : undefined),
    })
    const other: BucketKey = { ...RX, id: 9n }
    engine.onObject(obj(1, 0n))
    engine.onObject(obj(1, 0n, 0n, other))
    engine.tick(100)
    expect(rows(sink)[0]!.rq).toEqual({ d: 'tx', v: '2' })
    expect(rows(sink, other)[0]!.rq).toBeUndefined()
    engine.markShared(RX)
    engine.onObject(obj(110, 1n))
    engine.tick(200)
    expect(rows(sink)[1]!.rq).toBeUndefined()
    expect(rows(sink)[1]!.ga).toEqual({ g: '1', at: [10] })
  })

  it('is on the snapshot of an open interval, with its arrivals, which stay unreported', () => {
    const { engine, sink } = setup({ requestOf: () => ({ d: 'rx', v: '1' }) })
    engine.onObject(obj(10, 4n))
    const snap = engine.snapshot(50)!
    expect(snap.tracks[0]!.rq).toEqual({ d: 'rx', v: '1' })
    expect(snap.tracks[0]!.ga).toEqual({ g: '4', at: [10] })
    engine.tick(100)
    expect(rows(sink)[0]!.ga).toEqual({ g: '4', at: [10] })
  })
})
