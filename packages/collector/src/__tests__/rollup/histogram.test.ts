/**
 * Fixed-boundary histograms.
 *
 * The property everything downstream rests on is **mergeability**: the same
 * samples, split across any number of emitters, must merge by elementwise
 * addition into the histogram one emitter would have produced. That is the only
 * reason a fleet-wide p95 exists at all, and it is what the first test here
 * checks directly rather than by inspecting boundaries.
 */

import { describe, expect, it } from 'vitest'
import {
  BOUNDARIES,
  bucketIndex,
  DURATION_BOUNDARIES,
  flattenHistogram,
  HISTOGRAM_COUNT_MAX,
  Histogram,
  SIZE_BOUNDARIES,
} from '../../rollup/histogram.js'
import type { HistogramKind, HistogramWire } from '../../types.js'

const KINDS: readonly HistogramKind[] = [
  'interArrivalMs',
  'deliveryMs',
  'objectSizeBytes',
  'groupCadenceMs',
  'stallMs',
  'controlLatencyMs',
  'writerReadyMs',
]

/** Elementwise addition — what ingest does, written out. */
function merge(a: HistogramWire, b: HistogramWire): HistogramWire {
  const buckets = new Map<number, number>()
  for (const w of [a, b]) {
    for (let k = 0; k < w.i.length; k++) {
      const idx = w.i[k] as number
      buckets.set(idx, (buckets.get(idx) ?? 0) + (w.c[k] as number))
    }
  }
  const i = [...buckets.keys()].sort((x, y) => x - y)
  return { i, c: i.map((k) => buckets.get(k) as number), n: a.n + b.n, sum: a.sum + b.sum }
}

describe('mergeability', () => {
  it('merges by elementwise addition into what one emitter would have produced', () => {
    const samples = [0.4, 1, 3, 7, 40, 900, 2_500, 61_000, 120_000]
    const whole = new Histogram('interArrivalMs')
    for (const s of samples) whole.observe(s)

    const left = new Histogram('interArrivalMs')
    const right = new Histogram('interArrivalMs')
    for (const [k, s] of samples.entries()) {
      if (k % 2 === 0) left.observe(s)
      else right.observe(s)
    }

    expect(merge(left.encode() as HistogramWire, right.encode() as HistogramWire)).toEqual(
      whole.encode(),
    )
  })

  it('two independent histograms of one kind bucket the same sample identically', () => {
    // The merge above is only sound because this holds for every kind: the
    // ladder is a property of the metric, not of the emitter.
    for (const kind of KINDS) {
      const a = new Histogram(kind)
      const b = new Histogram(kind)
      for (const v of [0, 1, 999, 70_000, 1_048_576]) {
        a.observe(v)
        b.observe(v)
      }
      expect(a.encode()).toEqual(b.encode())
    }
  })

  it('freezes the ladders, so no consumer can shift one emitter off the others', () => {
    expect(Object.isFrozen(DURATION_BOUNDARIES)).toBe(true)
    expect(Object.isFrozen(SIZE_BOUNDARIES)).toBe(true)
    expect(Object.isFrozen(BOUNDARIES)).toBe(true)
  })
})

describe('the ladders the encoding specifies', () => {
  it('durations are 17 buckets, 2x spacing, 1 ms to 65 s', () => {
    expect(DURATION_BOUNDARIES.length).toBe(17)
    expect(DURATION_BOUNDARIES[0]).toBe(1)
    expect(DURATION_BOUNDARIES[16]).toBe(65_536)
    for (let i = 1; i < DURATION_BOUNDARIES.length; i++) {
      expect(DURATION_BOUNDARIES[i]).toBe((DURATION_BOUNDARIES[i - 1] as number) * 2)
    }
  })

  it('sizes are 20 buckets, 2x spacing, 1 B to 512 KB', () => {
    expect(SIZE_BOUNDARIES.length).toBe(20)
    expect(SIZE_BOUNDARIES[0]).toBe(1)
    expect(SIZE_BOUNDARIES[19]).toBe(512 * 1024)
  })

  it('gives every histogram kind a ladder', () => {
    for (const kind of KINDS) expect(BOUNDARIES[kind].length).toBeGreaterThanOrEqual(17)
    expect(BOUNDARIES.objectSizeBytes).toBe(SIZE_BOUNDARIES)
  })
})

describe('bucketIndex', () => {
  it('puts a value in the bucket whose boundary it reaches', () => {
    expect(bucketIndex(DURATION_BOUNDARIES, 1)).toBe(0)
    expect(bucketIndex(DURATION_BOUNDARIES, 1.5)).toBe(0)
    expect(bucketIndex(DURATION_BOUNDARIES, 2)).toBe(1)
    expect(bucketIndex(DURATION_BOUNDARIES, 3)).toBe(1)
    expect(bucketIndex(DURATION_BOUNDARIES, 4)).toBe(2)
    expect(bucketIndex(DURATION_BOUNDARIES, 1_000)).toBe(9)
  })

  it('absorbs sub-boundary values into bucket 0 — sub-ms gaps are ordinary', () => {
    expect(bucketIndex(DURATION_BOUNDARIES, 0)).toBe(0)
    expect(bucketIndex(DURATION_BOUNDARIES, 0.001)).toBe(0)
  })

  it('absorbs the tail into the top bucket rather than growing an overflow one', () => {
    expect(bucketIndex(DURATION_BOUNDARIES, 65_536)).toBe(16)
    expect(bucketIndex(DURATION_BOUNDARIES, 10_000_000)).toBe(16)
  })

  it('works on an arbitrary ascending ladder, which is the customer-metric path', () => {
    const ladder = [0, 10, 100]
    expect(bucketIndex(ladder, -5)).toBe(0)
    expect(bucketIndex(ladder, 9)).toBe(0)
    expect(bucketIndex(ladder, 10)).toBe(1)
    expect(bucketIndex(ladder, 1_000)).toBe(2)
  })
})

describe('encoding', () => {
  it('is sparse: only occupied buckets reach the wire', () => {
    const h = new Histogram('interArrivalMs')
    h.observe(1)
    h.observe(1)
    h.observe(1_000)
    const w = h.encode() as HistogramWire
    expect(w.i).toEqual([0, 9])
    expect(w.c).toEqual([2, 1])
  })

  it('ships the denominator with every mean — n and sum, always', () => {
    const h = new Histogram('objectSizeBytes')
    for (const v of [10, 20, 30]) h.observe(v)
    const w = h.encode() as HistogramWire
    expect(w.n).toBe(3)
    expect(w.sum).toBe(60)
    expect(w.sum / w.n).toBe(20)
  })

  it('costs nothing when untouched — an empty histogram encodes to null', () => {
    expect(new Histogram('stallMs').encode()).toBeNull()
  })

  it('reset clears counts, denominator and sum', () => {
    const h = new Histogram('stallMs')
    h.observe(5)
    h.reset()
    expect(h.encode()).toBeNull()
    expect(h.count).toBe(0)
  })
})

describe('values that would corrupt a merge', () => {
  it('drops non-finite samples rather than poisoning sum forever', () => {
    const h = new Histogram('interArrivalMs')
    h.observe(10)
    h.observe(Number.NaN)
    h.observe(Number.POSITIVE_INFINITY)
    const w = h.encode() as HistogramWire
    expect(w.n).toBe(1)
    expect(w.sum).toBe(10)
  })

  it('clamps a negative sample to zero rather than dragging sum backwards', () => {
    const h = new Histogram('interArrivalMs')
    h.observe(-50)
    const w = h.encode() as HistogramWire
    expect(w.n).toBe(1)
    expect(w.sum).toBe(0)
    expect(w.i).toEqual([0])
  })

  it('saturates a u16 bucket and keeps n exact, so ingest can see it happened', () => {
    const h = new Histogram('interArrivalMs')
    const total = HISTOGRAM_COUNT_MAX + 100
    for (let k = 0; k < total; k++) h.observe(1)
    const w = h.encode() as HistogramWire
    expect(w.c[0]).toBe(HISTOGRAM_COUNT_MAX)
    expect(w.n).toBe(total)
    expect(h.saturated).toBe(true)
  })
})

describe('flattenHistogram', () => {
  it('encodes a histogram as additive name-to-number entries', () => {
    const h = new Histogram('controlLatencyMs')
    h.observe(40)
    h.observe(50)
    h.observe(200)
    const out: Record<string, number> = {}
    flattenHistogram('ctl.subscribe.latencyMs', h, out)
    expect(out['ctl.subscribe.latencyMs.n']).toBe(3)
    expect(out['ctl.subscribe.latencyMs.sum']).toBe(290)
    expect(out['ctl.subscribe.latencyMs.b5']).toBe(2)
    expect(out['ctl.subscribe.latencyMs.b7']).toBe(1)
  })

  it('adds into an existing map, so two flattens merge the way ingest merges', () => {
    const out: Record<string, number> = {}
    const a = new Histogram('controlLatencyMs')
    a.observe(40)
    const b = new Histogram('controlLatencyMs')
    b.observe(40)
    flattenHistogram('x', a, out)
    flattenHistogram('x', b, out)
    expect(out['x.n']).toBe(2)
    expect(out['x.b5']).toBe(2)
  })

  it('writes nothing for an untouched histogram', () => {
    const out: Record<string, number> = {}
    flattenHistogram('x', new Histogram('controlLatencyMs'), out)
    expect(Object.keys(out)).toEqual([])
  })
})
