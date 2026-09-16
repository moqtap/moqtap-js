/**
 * Customer metrics — `defineMetric()` and `observe()`.
 *
 * The promise this file has to keep is economic, not numeric: an observation
 * costs **per rollup interval regardless of sample count**, which is the whole
 * difference between `observe()` and `annotate()` and the reason a customer can
 * call it once per group, thousands of times a session. So the tests here are
 * about what reaches the wire and what it costs — one row per touched series
 * per interval, a declared aggregation, and hard bounds on both series count
 * and error reporting.
 *
 * The other promise is that **no pre-computed percentile can enter the system**
 * There is no `percentile` aggregation to declare, so the refusal
 * is structural; the test below checks it survives a caller who casts past the
 * type, since a JavaScript customer has no types to stop them.
 */

import { describe, expect, it } from 'vitest'
import {
  CustomMetrics,
  MAX_ERROR_REPORTS,
  MAX_LABEL_VALUE_LENGTH,
} from '../../rollup/custom-metrics.js'
import type { CustomMetricWire, MetricDefinition } from '../../types.js'

const byName = (rows: readonly CustomMetricWire[], name: string): CustomMetricWire[] =>
  rows.filter((r) => r.name === name)

const one = (rows: readonly CustomMetricWire[]): CustomMetricWire => {
  if (rows.length !== 1) throw new Error(`expected exactly one row, got ${rows.length}`)
  return rows[0] as CustomMetricWire
}

describe('registration is mandatory', () => {
  it('drops an observation with no registration, counts it, and says so once', () => {
    const errors: string[] = []
    const m = new CustomMetrics({ onError: (e) => errors.push(e) })
    m.observe('decode.queueDepth', 3)
    expect(m.drain()).toEqual([])
    expect(m.unregisteredObservations).toBe(1)
    expect(errors.length).toBe(1)
    expect(errors[0]).toContain('decode.queueDepth')
  })

  it('refuses a pre-computed percentile even from a caller who casts past the type', () => {
    // One device's p95 cannot be merged with another's at any later
    // point, so there is no such aggregation to declare. A JavaScript customer
    // has no types to stop them, which is why this is also a runtime refusal.
    const errors: string[] = []
    const m = new CustomMetrics({ onError: (e) => errors.push(e) })
    m.defineMetric('latency', { unit: 'ms', agg: 'percentile' } as unknown as MetricDefinition)
    expect(m.metricCount).toBe(0)
    m.observe('latency', 95)
    expect(m.drain()).toEqual([])
    expect(errors.length).toBe(2)
  })

  it('refuses a nameless metric', () => {
    const m = new CustomMetrics()
    m.defineMetric('', { unit: 'count', agg: 'sum' })
    expect(m.metricCount).toBe(0)
  })

  it('accepts an identical re-registration and refuses a conflicting one', () => {
    const errors: string[] = []
    const m = new CustomMetrics({ onError: (e) => errors.push(e) })
    m.defineMetric('q', { unit: 'count', agg: 'sum' })
    m.defineMetric('q', { unit: 'count', agg: 'sum' })
    expect(errors).toEqual([])

    // Changing a live metric's aggregation mid-session produces a series whose
    // meaning changes halfway through, which no downstream merge can repair.
    m.defineMetric('q', { unit: 'count', agg: 'gauge' })
    expect(errors.length).toBe(1)
    m.observe('q', 2)
    m.observe('q', 3)
    expect(one(m.drain()).value).toBe(5)
  })
})

describe('folding to fixed cost per interval', () => {
  it('costs one row whether the customer observed twice or ten thousand times', () => {
    const m = new CustomMetrics()
    m.defineMetric('decode.queueDepth', { unit: 'count', agg: 'histogram' })
    for (let i = 0; i < 10_000; i++) m.observe('decode.queueDepth', (i % 30) + 1)
    const rows = m.drain()
    expect(rows.length).toBe(1)
    expect(one(rows).hist?.n).toBe(10_000)
  })

  it('sums a counter and resets it between intervals', () => {
    const m = new CustomMetrics()
    m.defineMetric('bytes', { unit: 'B', agg: 'sum' })
    m.observe('bytes', 10)
    m.observe('bytes', 32)
    expect(one(m.drain())).toEqual({ name: 'bytes', unit: 'B', agg: 'sum', value: 42 })
    m.observe('bytes', 1)
    expect(one(m.drain()).value).toBe(1)
  })

  it('keeps a gauge at its last value and does not re-ship it while untouched', () => {
    const m = new CustomMetrics()
    m.defineMetric('depth', { unit: 'count', agg: 'gauge' })
    m.observe('depth', 4)
    m.observe('depth', 7)
    expect(one(m.drain()).value).toBe(7)
    // "Fixed cost per interval" is a promise about the maximum, not a
    // commitment to spend it.
    expect(m.drain()).toEqual([])
    m.observe('depth', 7)
    expect(one(m.drain()).value).toBe(7)
  })

  it('buckets a histogram on the declared ladder and ships its denominator', () => {
    const m = new CustomMetrics()
    m.defineMetric('q', { unit: 'count', agg: 'histogram', buckets: [0, 10, 100] })
    for (const v of [0, 5, 10, 400]) m.observe('q', v)
    const h = one(m.drain()).hist
    expect(h?.i).toEqual([0, 1, 2])
    expect(h?.c).toEqual([2, 1, 1])
    expect(h?.n).toBe(4)
    expect(h?.sum).toBe(415)
  })

  it('resets a histogram between intervals', () => {
    const m = new CustomMetrics()
    m.defineMetric('q', { unit: 'count', agg: 'histogram' })
    m.observe('q', 1)
    expect(one(m.drain()).hist?.n).toBe(1)
    m.observe('q', 1)
    expect(one(m.drain()).hist?.n).toBe(1)
  })

  it('falls back to a default ladder when the customer declares none', () => {
    const m = new CustomMetrics()
    m.defineMetric('q', { unit: 'count', agg: 'histogram' })
    m.observe('q', 1)
    m.observe('q', 3)
    const h = one(m.drain()).hist
    expect(h?.i).toEqual([0, 1])
    expect(h?.n).toBe(2)
  })

  it('refuses an unusable ladder rather than silently substituting one', () => {
    const errors: string[] = []
    const m = new CustomMetrics({ onError: (e) => errors.push(e) })
    m.defineMetric('a', { unit: 'count', agg: 'histogram', buckets: [10, 5] })
    m.defineMetric('b', { unit: 'count', agg: 'histogram', buckets: [Number.NaN] })
    m.defineMetric('c', { unit: 'count', agg: 'histogram', buckets: [] })
    expect(m.metricCount).toBe(0)
    expect(errors.length).toBe(3)
  })

  it('drops a non-finite sample rather than poisoning the metric for the session', () => {
    const m = new CustomMetrics()
    m.defineMetric('x', { unit: 'count', agg: 'sum' })
    m.observe('x', Number.NaN)
    m.observe('x', Number.POSITIVE_INFINITY)
    expect(m.drain()).toEqual([])
    m.observe('x', 2)
    expect(one(m.drain()).value).toBe(2)
  })
})

describe('labels', () => {
  it('is one series however the customer ordered the keys', () => {
    const m = new CustomMetrics()
    m.defineMetric('q', { unit: 'count', agg: 'sum' })
    m.observe('q', 1, { track: 'video', rung: 'hi' })
    m.observe('q', 2, { rung: 'hi', track: 'video' })
    const row = one(m.drain())
    expect(row.value).toBe(3)
    expect(row.labels).toEqual({ track: 'video', rung: 'hi' })
  })

  it('keeps label sets distinct that a delimiter-joined key would merge', () => {
    // `{a: 'x b'}` and `{a: 'x', b: ''}` join to the same string under any
    // single delimiter. Merging them would sum two unrelated series into one
    // row with nothing downstream able to notice.
    const m = new CustomMetrics()
    m.defineMetric('q', { unit: 'count', agg: 'sum' })
    m.observe('q', 1, { a: 'x b' })
    m.observe('q', 2, { a: 'x', b: '' })
    const rows = byName(m.drain(), 'q')
    expect(rows.length).toBe(2)
    expect(rows.map((r) => r.value).sort()).toEqual([1, 2])
  })

  it('separates an unlabelled series from a labelled one', () => {
    const m = new CustomMetrics()
    m.defineMetric('q', { unit: 'count', agg: 'sum' })
    m.observe('q', 1)
    m.observe('q', 2, {})
    m.observe('q', 4, { track: 'a' })
    const rows = byName(m.drain(), 'q')
    expect(rows.length).toBe(2)
    expect(rows.find((r) => r.labels === undefined)?.value).toBe(3)
    expect(rows.find((r) => r.labels !== undefined)?.value).toBe(4)
  })

  it('truncates a long label value rather than shipping it', () => {
    const m = new CustomMetrics()
    m.defineMetric('q', { unit: 'count', agg: 'sum' })
    m.observe('q', 1, { url: 'z'.repeat(500) })
    const labels = one(m.drain()).labels as Record<string, string>
    expect(labels.url?.length).toBe(MAX_LABEL_VALUE_LENGTH)
  })

  it('refuses an observation carrying more labels than the cap', () => {
    const m = new CustomMetrics()
    m.defineMetric('q', { unit: 'count', agg: 'sum' })
    const many: Record<string, string> = {}
    for (let i = 0; i < 20; i++) many[`l${i}`] = String(i)
    m.observe('q', 1, many)
    expect(m.drain()).toEqual([])
    expect(m.refusedSeries).toBe(1)
  })
})

describe('bounds', () => {
  it('caps series per metric, so an unbounded label cannot turn fixed cost into per-event', () => {
    const m = new CustomMetrics({ maxSeriesPerMetric: 2 })
    m.defineMetric('q', { unit: 'count', agg: 'sum' })
    for (let i = 0; i < 50; i++) m.observe('q', 1, { requestId: String(i) })
    expect(byName(m.drain(), 'q').length).toBe(2)
    expect(m.refusedSeries).toBe(48)
  })

  it('keeps recording into the series it already has after the cap is reached', () => {
    const m = new CustomMetrics({ maxSeriesPerMetric: 1 })
    m.defineMetric('q', { unit: 'count', agg: 'sum' })
    m.observe('q', 1, { track: 'a' })
    m.observe('q', 5, { track: 'b' })
    m.observe('q', 2, { track: 'a' })
    expect(one(m.drain()).value).toBe(3)
  })

  it('caps distinct metric names', () => {
    const m = new CustomMetrics({ maxMetrics: 2 })
    for (let i = 0; i < 5; i++) m.defineMetric(`m${i}`, { unit: 'count', agg: 'sum' })
    expect(m.metricCount).toBe(2)
  })

  it('stops reporting errors after the cap while the counters keep counting', () => {
    // observe() is called on the page's own data path; one console line per
    // object is the interference non-interference promises not to cause.
    const errors: string[] = []
    const m = new CustomMetrics({ onError: (e) => errors.push(e) })
    for (let i = 0; i < 500; i++) m.observe('never.registered', 1)
    expect(errors.length).toBe(MAX_ERROR_REPORTS)
    expect(errors[MAX_ERROR_REPORTS - 1]).toContain('MQ4008')
    expect(m.unregisteredObservations).toBe(500)
  })

  it('is silent when the customer supplied no error callback', () => {
    const m = new CustomMetrics()
    expect(() => m.observe('never.registered', 1)).not.toThrow()
  })
})

describe('the wire row', () => {
  it('carries the declared unit and aggregation, so ingest never infers them', () => {
    const m = new CustomMetrics()
    m.defineMetric('decode.queueDepth', { unit: 'count', agg: 'histogram' })
    m.observe('decode.queueDepth', 3, { track: 'video' })
    const row = one(m.drain())
    expect(row.name).toBe('decode.queueDepth')
    expect(row.unit).toBe('count')
    expect(row.agg).toBe('histogram')
    expect(row.labels).toEqual({ track: 'video' })
    expect(row.value).toBeUndefined()
    expect(row.hist?.n).toBe(1)
  })

  it('survives JSON.stringify, which is how it reaches the wire', () => {
    const m = new CustomMetrics()
    m.defineMetric('q', { unit: 'ms', agg: 'histogram' })
    m.observe('q', 12)
    expect(JSON.parse(JSON.stringify(m.drain()))).toEqual([
      { name: 'q', unit: 'ms', agg: 'histogram', hist: { i: [3], c: [1], n: 1, sum: 12 } },
    ])
  })
})
