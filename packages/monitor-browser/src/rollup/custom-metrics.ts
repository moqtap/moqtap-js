/**
 * Customer-defined metrics — `defineMetric()` and `observe()`.
 *
 * What separates this from `annotate()`: an annotation is a discrete event and
 * ships one wire row each, while an observation is a numeric sample folded into
 * the rollup and ships one row per interval regardless of sample count. A
 * customer sampling decode queue depth thousands of times a session still costs
 * one row per interval. That folding is this file.
 *
 * Registration is mandatory because the aggregation has to be declared before
 * the samples: a pre-computed p95 is a number nobody can re-aggregate. Raw
 * samples are taken and folded here, and a percentile is refused by
 * construction — {@link MetricDefinition.agg} has no `percentile` member, so
 * there is nothing to reject at runtime.
 */

import { MQ4001, MQ4002, MQ4003, MQ4004, MQ4005, MQ4006, MQ4007, MQ4008 } from '../codes.js'
import type { CustomMetricWire, MetricDefinition } from '../types.js'
import { DEFAULT_CUSTOM_BOUNDARIES, Histogram } from './histogram.js'

/** Distinct metric names one session may register. */
export const MAX_METRICS = 64

/**
 * Distinct label combinations per metric.
 *
 * Every combination is a series and every series is a wire row per interval, so
 * an unbounded label — a request id, a timestamp, an object id — would turn a
 * fixed-cost metric into a per-event one. The cap refuses the excess and counts
 * it rather than growing.
 */
export const MAX_SERIES_PER_METRIC = 32

/** Labels per observation, and the length of a label value. */
export const MAX_LABELS = 8
export const MAX_LABEL_VALUE_LENGTH = 64

/**
 * Messages one session hands to `onError` before it goes quiet.
 *
 * `observe()` is called per group, per object, per frame, while the mistake it
 * reports (an unregistered name) is per call site — so an uncapped report is one
 * console line per object on the page's own data path. The counters
 * ({@link CustomMetrics.unregisteredObservations},
 * {@link CustomMetrics.refusedSeries}) keep counting after the cap, so nothing
 * is hidden — only repeated.
 */
export const MAX_ERROR_REPORTS = 20

interface Series {
  readonly labels?: Readonly<Record<string, string>>
  sum: number
  gauge: number
  hist?: Histogram
  touched: boolean
}

interface Metric {
  readonly def: MetricDefinition
  readonly boundaries: readonly number[]
  readonly series: Map<string, Series>
  refusedSeries: number
}

export interface CustomMetricsOptions {
  readonly maxMetrics?: number
  readonly maxSeriesPerMetric?: number
  /**
   * Where a rejected definition or observation is reported. An unregistered
   * name or a label explosion is silent on the wire and must not also be silent
   * to the developer.
   */
  readonly onError?: (message: string) => void
}

/**
 * Folds customer samples to fixed cost per interval.
 *
 * Drained by the rollup engine into {@link RollupRecord.custom}.
 */
export class CustomMetrics {
  private readonly metrics = new Map<string, Metric>()
  private readonly maxMetrics: number
  private readonly maxSeries: number
  private readonly onError: ((m: string) => void) | undefined

  /** Observations dropped for want of a registration. */
  private unregistered = 0
  /** Observations dropped by the series cap. */
  private refused = 0
  /** Messages already handed to `onError`. See {@link MAX_ERROR_REPORTS}. */
  private reported = 0

  constructor(opts: CustomMetricsOptions = {}) {
    this.maxMetrics = opts.maxMetrics ?? MAX_METRICS
    this.maxSeries = opts.maxSeriesPerMetric ?? MAX_SERIES_PER_METRIC
    this.onError = opts.onError
  }

  get unregisteredObservations(): number {
    return this.unregistered
  }

  get refusedSeries(): number {
    return this.refused
  }

  get metricCount(): number {
    return this.metrics.size
  }

  /**
   * Register a metric. Mandatory before {@link observe}.
   *
   * A second registration of the same name is accepted only when identical:
   * changing a live metric's aggregation mid-session produces a series whose
   * meaning changes halfway through, which no downstream merge can detect.
   */
  defineMetric(name: string, d: MetricDefinition): void {
    if (typeof name !== 'string' || name.length === 0) {
      this.fail(MQ4001)
      return
    }
    if (d.agg !== 'sum' && d.agg !== 'gauge' && d.agg !== 'histogram') {
      this.fail(`${MQ4002}: ${name}`)
      return
    }
    const existing = this.metrics.get(name)
    if (existing !== undefined) {
      if (existing.def.agg !== d.agg || existing.def.unit !== d.unit) {
        this.fail(`${MQ4003}: ${name} ${existing.def.agg}/${existing.def.unit}`)
      }
      return
    }
    if (this.metrics.size >= this.maxMetrics) {
      this.fail(`${MQ4004}: ${name} ${this.maxMetrics}`)
      return
    }
    const boundaries = normaliseBoundaries(d.buckets)
    if (d.agg === 'histogram' && d.buckets !== undefined && boundaries === null) {
      this.fail(`${MQ4005}: ${name}`)
      return
    }
    this.metrics.set(name, {
      def: d,
      boundaries: boundaries ?? DEFAULT_CUSTOM_BOUNDARIES,
      series: new Map(),
      refusedSeries: 0,
    })
  }

  /**
   * Fold one sample. Cheap enough to call per group, per object, per frame.
   *
   * Non-finite values are dropped: a `NaN` reaching `sum` poisons the metric for
   * the rest of the session and no later value repairs it.
   */
  observe(name: string, value: number, labels?: Record<string, string>): void {
    const m = this.metrics.get(name)
    if (m === undefined) {
      this.unregistered++
      this.fail(`${MQ4006}: ${name}`)
      return
    }
    if (!Number.isFinite(value)) return
    const norm = normaliseLabels(labels)
    if (norm === null) {
      this.refused++
      this.fail(`${MQ4007}: ${name} ${MAX_LABELS}`)
      return
    }
    let s = m.series.get(norm.key)
    if (s === undefined) {
      if (m.series.size >= this.maxSeries) {
        this.refused++
        m.refusedSeries++
        return
      }
      s = {
        ...(norm.labels !== undefined ? { labels: norm.labels } : {}),
        sum: 0,
        gauge: 0,
        ...(m.def.agg === 'histogram' ? { hist: new Histogram(m.boundaries) } : {}),
        touched: false,
      }
      m.series.set(norm.key, s)
    }
    s.touched = true
    if (m.def.agg === 'sum') s.sum += value
    else if (m.def.agg === 'gauge') s.gauge = value
    else s.hist?.observe(value)
  }

  /**
   * One wire row per touched series, and a reset.
   *
   * A series untouched since the last drain emits nothing — a gauge keeps its
   * value but does not re-ship it every interval. One row per interval is the
   * maximum, not a floor.
   */
  drain(): CustomMetricWire[] {
    const out: CustomMetricWire[] = []
    for (const [name, m] of this.metrics) {
      for (const s of m.series.values()) {
        if (!s.touched) continue
        s.touched = false
        const base = {
          name,
          unit: m.def.unit,
          agg: m.def.agg,
          ...(s.labels !== undefined ? { labels: s.labels } : {}),
        }
        if (m.def.agg === 'histogram') {
          const w = s.hist?.encode()
          if (w === null || w === undefined) continue
          out.push({ ...base, hist: w })
          s.hist?.reset()
        } else {
          out.push({ ...base, value: m.def.agg === 'sum' ? s.sum : s.gauge })
          s.sum = 0
        }
      }
    }
    return out
  }

  private fail(message: string): void {
    if (this.reported >= MAX_ERROR_REPORTS) return
    this.reported++
    this.onError?.(this.reported === MAX_ERROR_REPORTS ? `${message} ${MQ4008}` : message)
  }
}

/**
 * A canonical series key: labels sorted, so `{a, b}` and `{b, a}` are one
 * series rather than two rows that never merge.
 *
 * Length-prefixed, not delimited: a label value is a customer string and may
 * contain any character a delimiter could use, NUL included, and two label sets
 * that collide into one key merge two series into one row with nothing
 * downstream able to detect it.
 */
function normaliseLabels(
  labels: Record<string, string> | undefined,
): { key: string; labels?: Readonly<Record<string, string>> } | null {
  if (labels === undefined) return { key: '' }
  const names = Object.keys(labels).sort()
  if (names.length === 0) return { key: '' }
  if (names.length > MAX_LABELS) return null
  const out: Record<string, string> = {}
  let key = ''
  for (const n of names) {
    const raw = labels[n]
    const v = (typeof raw === 'string' ? raw : String(raw)).slice(0, MAX_LABEL_VALUE_LENGTH)
    out[n] = v
    key += `${n.length}:${n}${v.length}:${v}`
  }
  return { key, labels: out }
}

/** `null` when there is no usable ladder — none given, or one that is unusable. */
function normaliseBoundaries(b: readonly number[] | undefined): readonly number[] | null {
  if (b === undefined) return null
  if (b.length === 0) return null
  let prev = Number.NEGATIVE_INFINITY
  for (const v of b) {
    if (!Number.isFinite(v) || v <= prev) return null
    prev = v
  }
  return b
}
