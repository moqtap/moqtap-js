/**
 * Fixed-boundary histograms.
 *
 * The encoding is fixed: **log-spaced boundaries identical for every emitter**,
 * so merging two histograms is elementwise addition and a fleet-wide p95 is
 * exact to one bucket width.
 *
 * **No percentile is ever computed on the device.** A device-side p95 cannot be
 * merged with another device's p95 at any later point — no weighting recovers
 * it — so the boundaries are the contract and the buckets are what ships. This
 * file has no `percentile()` and must never grow one; the only quantile
 * anywhere in this module is {@link SlidingMedian} in `bucket.ts`, which exists
 * for the cadence *trigger* and never reaches the wire.
 *
 * **Every mean ships its denominator.** {@link HistogramWire} carries `n` and
 * `sum` alongside the buckets: a per-session mean averaged across sessions
 * without weighting lets short broken sessions dominate the fleet number.
 */

import type { HistogramKind, HistogramWire } from '../types.js'

/**
 * Durations: 17 buckets, 2× spacing, 1 ms → 65 s. `2^0 … 2^16`.
 */
export const DURATION_BOUNDARIES: readonly number[] = /*#__PURE__*/ Object.freeze(
  Array.from({ length: 17 }, (_, i) => 2 ** i),
)

/** Sizes: 20 buckets, 2× spacing, 1 B → 512 KB. `2^0 … 2^19`. */
export const SIZE_BOUNDARIES: readonly number[] = /*#__PURE__*/ Object.freeze(
  Array.from({ length: 20 }, (_, i) => 2 ** i),
)

/**
 * The boundary table, keyed by {@link HistogramKind}.
 *
 * A required-key mapped type: adding a kind to the union without adding its
 * ladder here is a compile error, which is the point — an emitter with a
 * different ladder for the same metric silently corrupts every merge it
 * participates in, and nothing downstream can detect it.
 */
export const BOUNDARIES: { readonly [k in HistogramKind]: readonly number[] } =
  /*#__PURE__*/ Object.freeze({
    interArrivalMs: DURATION_BOUNDARIES,
    deliveryMs: DURATION_BOUNDARIES,
    objectSizeBytes: SIZE_BOUNDARIES,
    groupCadenceMs: DURATION_BOUNDARIES,
    groupOpenMs: DURATION_BOUNDARIES,
    stallMs: DURATION_BOUNDARIES,
    controlLatencyMs: DURATION_BOUNDARIES,
    writerReadyMs: DURATION_BOUNDARIES,
  })

/**
 * Default ladder for a customer histogram that declares no `buckets`
 * The size ladder, because it spans 1 → 524,288 and so covers
 * counts, bytes and milliseconds alike without the customer choosing.
 */
export const DEFAULT_CUSTOM_BOUNDARIES: readonly number[] = SIZE_BOUNDARIES

/**
 * Bucket counts are u16, and a bucket saturates here rather than wrapping. `n`
 * stays exact, so a saturated histogram is detectable at ingest (`n > Σc`)
 * instead of reporting a smaller count than it saw.
 */
export const HISTOGRAM_COUNT_MAX = 0xffff

/**
 * The bucket a value falls in: the highest index whose boundary is `<= v`,
 * or 0 for anything below the first boundary.
 *
 * So with the duration ladder, index `i` covers `[2^i, 2^(i+1))` and index 0
 * additionally absorbs everything under 1 ms (including 0 and sub-millisecond
 * gaps, which are ordinary at high object rates). The top index absorbs the
 * tail — there is no unbounded overflow bucket, because a bucket count that
 * merges by addition must have the same meaning on every emitter and "greater
 * than the largest boundary" already does.
 *
 * Linear-scanned from the top: the ladders are 17 and 20 entries, and a scan
 * over a monomorphic `readonly number[]` beats a binary search's branches at
 * that size. Custom ladders go through the same function, which
 * is why it takes the boundaries rather than assuming powers of two.
 */
export function bucketIndex(boundaries: readonly number[], v: number): number {
  for (let i = boundaries.length - 1; i > 0; i--) {
    const b = boundaries[i]
    if (b !== undefined && v >= b) return i
  }
  return 0
}

/**
 * One fixed-boundary histogram.
 *
 * O(1) memory — one `Uint16Array` of at most 20 entries plus two numbers — and
 * O(ladder) per observation with no allocation on the hot path.
 */
export class Histogram {
  private readonly boundaries: readonly number[]
  private readonly counts: Uint16Array
  private n = 0
  private total = 0
  private sat = false

  /**
   * A {@link HistogramKind} takes the fixed ladder for that metric — the shape
   * the module contract names. A raw boundary array is the customer-metric
   * path, where the ladder is declared at registration.
   */
  constructor(kind: HistogramKind | readonly number[]) {
    this.boundaries = typeof kind === 'string' ? BOUNDARIES[kind] : kind
    this.counts = new Uint16Array(this.boundaries.length)
  }

  /**
   * Fold one sample.
   *
   * Non-finite values are dropped entirely rather than counted: a `NaN` in
   * `sum` poisons every mean derived from this histogram for the rest of the
   * session, and there is no value of `n` that repairs it. Negative values are
   * clamped to zero — no metric here has a meaningful negative reading, and a
   * monotonic clock cannot produce one, so a negative is a caller bug that must
   * not be allowed to drag `sum` backwards.
   */
  observe(v: number): void {
    if (!Number.isFinite(v)) return
    const value = v < 0 ? 0 : v
    const i = bucketIndex(this.boundaries, value)
    const c = this.counts[i] ?? 0
    if (c === HISTOGRAM_COUNT_MAX) this.sat = true
    else this.counts[i] = c + 1
    this.n++
    this.total += value
  }

  /** Samples folded since the last {@link reset}. */
  get count(): number {
    return this.n
  }

  /** A bucket hit `2^16 - 1` and stopped counting. `n` is still exact. */
  get saturated(): boolean {
    return this.sat
  }

  /**
   * Sparse wire form, or `null` when nothing was observed.
   *
   * `null` rather than an empty pair of arrays so an untouched histogram costs
   * **zero** bytes: at baseline most tracks never stall and never carry a status
   * object, and seven empty histograms per track per interval would dominate the
   * record.
   */
  encode(): HistogramWire | null {
    if (this.n === 0) return null
    const i: number[] = []
    const c: number[] = []
    for (let k = 0; k < this.counts.length; k++) {
      const v = this.counts[k]
      if (v !== undefined && v > 0) {
        i.push(k)
        c.push(v)
      }
    }
    return { i, c, n: this.n, sum: this.total }
  }

  reset(): void {
    this.counts.fill(0)
    this.n = 0
    this.total = 0
    this.sat = false
  }
}

/**
 * Flatten a histogram into additive `name → number` entries.
 *
 * {@link import('../types.js').RollupRecord.session} is typed
 * `Record<string, number>` and merges by addition, and the envelope has no
 * session-level `hist` field — but baseline must report **control-exchange
 * latencies**, which have to be a histogram. The two are only reconcilable by
 * encoding the histogram as flat additive keys:
 *
 * ```
 * ctl.subscribe.latencyMs.n   = 4
 * ctl.subscribe.latencyMs.sum = 231
 * ctl.subscribe.latencyMs.b5  = 3     // bucket 5, i.e. [32 ms, 64 ms)
 * ctl.subscribe.latencyMs.b6  = 1
 * ```
 *
 * Every key merges by addition, so the fleet aggregate is the same object with
 * larger numbers and the distribution survives; the repeated prefixes are the
 * most compressible bytes on the wire.
 */
export function flattenHistogram(prefix: string, h: Histogram, out: Record<string, number>): void {
  const w = h.encode()
  if (w === null) return
  out[`${prefix}.n`] = (out[`${prefix}.n`] ?? 0) + w.n
  out[`${prefix}.sum`] = (out[`${prefix}.sum`] ?? 0) + w.sum
  for (let k = 0; k < w.i.length; k++) {
    const idx = w.i[k]
    const cnt = w.c[k]
    if (idx === undefined || cnt === undefined) continue
    const key = `${prefix}.b${idx}`
    out[key] = (out[key] ?? 0) + cnt
  }
}
