/**
 * One track's interval state.
 *
 * **Parse an object header, update counters, discard it.** Nothing here retains
 * an {@link ObjectSample}, no structure grows with the number of objects, and
 * every field is either a counter, a fixed-boundary histogram or a fixed-size
 * window, so a bucket costs about 1 KB whether the track carried ten objects or
 * ten million.
 *
 * Two kinds of state live here and they have **different lifetimes**, which is
 * the one thing in this file that is easy to get wrong:
 *
 *  - **Interval state** — counters, histograms, `firstSeen`/`lastSeen`. Reset
 *    by {@link TrackBucket.drain}, once per rollup interval.
 *  - **Track state** — the sliding median, the last arrival time, the highest
 *    group seen, the duplicate window. **Survives `drain()`.** Resetting the
 *    median every interval would un-warm the cadence trigger once a minute
 *    forever, and resetting `lastAt` would silently drop one inter-arrival
 *    sample per interval boundary — the largest ones, since a boundary is more
 *    likely to fall inside a long gap than a short one.
 */

import type {
  BucketKey,
  HistogramKind,
  HistogramWire,
  Mono,
  ObjectSample,
  RollupTrackWire,
} from '../types.js'
import { Histogram } from './histogram.js'

/**
 * Samples in the inter-arrival median window.
 *
 * Odd, so the median is an observed value rather than an average of two. 31 is
 * about two seconds of a 60 fps per-frame track and about a minute of a 2 s
 * GOP: long enough that one late object does not move it, short enough that a
 * genuine cadence change re-warms within a few groups rather than being
 * averaged away for the rest of the session.
 */
export const MEDIAN_WINDOW = 31

/**
 * Samples before {@link TrackBucket.medianIntervalMs} reports anything.
 *
 * Until the median is established, nothing is judged against it. This is the
 * module's own floor; the trigger engine applies its own `cadence.minSamples` on
 * top, which is why {@link TrackBucket.intervalSamples} is exposed.
 */
export const MEDIAN_MIN_SAMPLES = 5

/**
 * Entries in the duplicate-detection window. A power of two — the index is a
 * mask, not a modulo.
 */
export const DUPLICATE_WINDOW = 32

/**
 * Stall threshold, as a multiple of the track's own observed median interval.
 *
 * The same self-calibrating form the cadence trigger uses, and for the same
 * reason: an absolute millisecond figure is wrong on every track whose GOP the
 * customer did not tell us about. A self-calibrating threshold needs no field
 * data to be correct — it needs a warm-up.
 */
export const STALL_MULTIPLE = 3

/**
 * Floor under the stall threshold, in ms, once the median is warm.
 *
 * It exists because 3× the median of a 60 fps per-frame track is 50 ms, and
 * nothing at 50 ms is a stall anyone would act on.
 *
 * It is **not** a fallback for a cold median. Judging gaps against a bare floor
 * during warm-up reports five stalls on every 2 s-GOP track at the start of
 * every session — wrong in the direction that alerts. Until the median is
 * established, nothing is judged.
 */
export const STALL_FLOOR_MS = 100

/**
 * A single group-id discontinuity larger than this is counted as one gap, not
 * as millions.
 *
 * Group ids are vi64 and a publisher may restart, wrap or randomise them; a raw
 * subtraction would put `2^62` into a counter that merges by addition and make
 * every fleet aggregate it touches useless. A discontinuity this large is a
 * re-keying, not a loss run.
 */
export const MAX_GAP_RUN = 1_000_000

/**
 * Exact median over a fixed sliding window, O(1) memory, no allocation.
 *
 * The one piece of per-track state that genuinely **cannot** move server-side.
 * The cadence trigger must fire against a ring that is continuously
 * overwritten, and the rollup does not reach ingest for up to 60 s — longer
 * under exactly the congestion a trigger signals. By the time a server could
 * compute this median, the bytes it would have opened a capture window over are
 * gone.
 *
 * A histogram-interpolated median is cheaper and not good enough: the ladders
 * are 2×-spaced, so a 250 ms cadence estimates as 128 ms or 256 ms and
 * `{ multiple: 3 }` fires at 384 ms or 768 ms depending on which. Insertion into
 * a 31-entry sorted array is ~31 element moves per object against a parse that
 * costs far more, and the read is `sorted[15]`.
 */
export class SlidingMedian {
  private readonly window: Float64Array
  private readonly sorted: Float64Array
  private filled = 0
  private head = 0
  private seen = 0

  constructor(private readonly capacity: number = MEDIAN_WINDOW) {
    this.window = new Float64Array(capacity)
    this.sorted = new Float64Array(capacity)
  }

  /** Lifetime sample count — the warm-up counter, not the window occupancy. */
  get samples(): number {
    return this.seen
  }

  /**
   * Evict then insert, and `filled` is the count of live entries at every point
   * in between — never a slot index, and never adjusted by two owners.
   *
   * That invariant is the whole of this method's correctness, and getting it
   * wrong is silent: a `filled` that doubles as a slot index lets the sorted
   * array keep values the ring no longer holds and drop ones it does, which
   * still agrees with a brute-force median during warm-up and on a
   * constant-cadence track. It diverges only on a track whose cadence varies —
   * exactly the track the cadence trigger exists for.
   */
  push(v: number): void {
    if (!Number.isFinite(v)) return
    this.seen++
    if (this.filled === this.capacity) this.removeSorted(this.window[this.head] ?? 0)
    this.window[this.head] = v
    this.head = (this.head + 1) % this.capacity
    this.insertSorted(v)
  }

  /** `undefined` until the window holds anything at all. */
  median(): number | undefined {
    const n = this.filled
    if (n === 0) return undefined
    if (n % 2 === 1) return this.sorted[(n - 1) >> 1]
    const a = this.sorted[n / 2 - 1] ?? 0
    const b = this.sorted[n / 2] ?? 0
    return (a + b) / 2
  }

  /** Insertion sort of one element into `sorted[0 .. filled)`, then `filled++`. */
  private insertSorted(v: number): void {
    const s = this.sorted
    let i = this.filled
    while (i > 0 && (s[i - 1] ?? 0) > v) {
      s[i] = s[i - 1] ?? 0
      i--
    }
    s[i] = v
    this.filled++
  }

  private removeSorted(v: number): void {
    const s = this.sorted
    let i = 0
    while (i < this.filled && s[i] !== v) i++
    // `v` came out of the window, so it is in `sorted` — but a corrupted state
    // must degrade to a wrong median, never to an out-of-bounds shift.
    if (i >= this.filled) return
    for (let k = i; k < this.filled - 1; k++) s[k] = s[k + 1] ?? 0
    this.filled--
  }
}

export interface TrackBucketOptions {
  /**
   * Session origin. Subtracted from `firstSeen`/`lastSeen` on drain, so
   * every {@link Mono} on the wire is relative to the anchor as
   * {@link import('../types.js').RecordBase.ts} requires. Defaults to 0.
   */
  readonly origin?: Mono
  readonly medianWindow?: number
  readonly medianMinSamples?: number
  readonly stallMultiple?: number
  readonly stallFloorMs?: number
}

/** The histograms a track carries. See {@link TrackBucket.drain}. */
const TRACK_HISTOGRAMS = [
  'interArrivalMs',
  'objectSizeBytes',
  'groupCadenceMs',
  'groupOpenMs',
  'stallMs',
] as const satisfies readonly HistogramKind[]

type TrackHistogramKind = (typeof TRACK_HISTOGRAMS)[number]

/**
 * One rollup bucket: the counters and distributions for one
 * {@link BucketKey} over one interval, plus the cross-interval track state the
 * cadence trigger reads.
 */
export class TrackBucket {
  readonly key: BucketKey

  private readonly hist: Record<TrackHistogramKind, Histogram>
  private readonly medianWindow: SlidingMedian
  private readonly medianMinSamples: number
  private readonly stallMultiple: number
  private readonly stallFloorMs: number
  private readonly origin: Mono

  /* ── interval state: reset by drain() ─────────────────────────────────── */
  private objects = 0
  private payloadBytes = 0
  private headerBytes = 0
  private groups = 0
  private groupGaps = 0
  private outOfOrder = 0
  private duplicates = 0
  private statusObjects = 0
  private parseFailures = 0
  private blockedMs = 0
  private ackedBytes = 0
  private firstSeen: Mono | undefined
  private lastSeen: Mono = 0

  /* ── track state: survives drain() ────────────────────────────────────── */
  private sharedAlias = false
  private lastAt: Mono | undefined
  private maxGroup: bigint | undefined
  private lastNewGroupAt: Mono | undefined
  private lastActivity: Mono = 0
  /**
   * The open span of {@link maxGroup}: when its first object arrived, and its
   * latest. Track state rather than interval state, because a group that
   * straddles a drain must still report its whole span — the same reason
   * `lastNewGroupAt` survives, and it lands in the interval the group *closed*
   * in, which is the only interval that knows how long it was.
   */
  private curGroupFirstAt: Mono | undefined
  private curGroupLastAt: Mono = 0
  /** Direct-mapped recency window of `(group, object)` pairs. See `onObject`. */
  private readonly dupGroups = new Float64Array(DUPLICATE_WINDOW)
  private readonly dupObjects = new Float64Array(DUPLICATE_WINDOW)
  private readonly dupUsed = new Uint8Array(DUPLICATE_WINDOW)

  constructor(key: BucketKey, opts: TrackBucketOptions = {}) {
    this.key = key
    this.medianWindow = new SlidingMedian(opts.medianWindow ?? MEDIAN_WINDOW)
    this.medianMinSamples = opts.medianMinSamples ?? MEDIAN_MIN_SAMPLES
    this.stallMultiple = opts.stallMultiple ?? STALL_MULTIPLE
    this.stallFloorMs = opts.stallFloorMs ?? STALL_FLOOR_MS
    this.origin = opts.origin ?? 0
    this.hist = {
      interArrivalMs: new Histogram('interArrivalMs'),
      objectSizeBytes: new Histogram('objectSizeBytes'),
      groupCadenceMs: new Histogram('groupCadenceMs'),
      groupOpenMs: new Histogram('groupOpenMs'),
      stallMs: new Histogram('stallMs'),
    }
  }

  /**
   * Time the page spent awaiting `writer.ready` on a stream carrying this
   * track. Summed, not bucketed: the wire wants a total here, and the
   * distribution already ships once per session as `writerReadyMs`.
   */
  onWriterBlocked(ms: number, at: Mono): void {
    if (ms <= 0) return
    this.blockedMs += ms
    this.observedAt(at)
  }

  /**
   * A delta of `bytesAcknowledged`, already differenced against the stream's
   * previous reading by the caller — this class sees one track, and a track
   * spans streams, so it cannot difference a per-stream cumulative itself.
   *
   * Negative deltas are dropped rather than clamped to zero: the only way one
   * arrives is two `getStats()` promises resolving out of order, and adding a
   * corrected-downwards figure would double-count the bytes in between.
   */
  onAcked(deltaBytes: number, at: Mono): void {
    if (deltaBytes <= 0) return
    this.ackedBytes += deltaBytes
    this.observedAt(at)
  }

  /**
   * Something was observed on this track at `at`, but it was not an object.
   *
   * Bounds the interval for the same reason {@link onParseFailure} does: a row
   * whose only content is send-side pressure would otherwise report
   * `firstSeen === lastSeen ===` whatever the last object left behind, and
   * ingest could not place it in time at all.
   */
  private observedAt(at: Mono): void {
    this.lastActivity = at
    if (this.firstSeen === undefined) this.firstSeen = at
    if (at > this.lastSeen) this.lastSeen = at
  }

  /**
   * Two concurrent subscriptions share this alias. Set by the control
   * plane, never inferred from the data plane: the duplicates it explains are
   * indistinguishable from a fault by counting alone.
   */
  markShared(): void {
    this.sharedAlias = true
  }

  /**
   * What happened on this track this interval. Zero means "emit nothing".
   *
   * Send-side pressure counts, even with no object to show for it: a track that
   * spent the whole interval awaiting `writer.ready` and completed nothing is
   * the *worst* case, not an empty one, and gating on `objects` alone would
   * both drop that row and carry its `blockedMs` into whichever later interval
   * did manage to send — reporting the stall at the wrong time, or, if the
   * track went idle first, evicting it unreported.
   */
  get activity(): number {
    return (
      this.objects +
      this.parseFailures +
      (this.blockedMs > 0 ? 1 : 0) +
      (this.ackedBytes > 0 ? 1 : 0)
    )
  }

  /** Last time anything at all happened on this track. Drives idle eviction. */
  get lastActivityMono(): Mono {
    return this.lastActivity
  }

  /** Lifetime inter-arrival samples — the trigger engine's warm-up counter. */
  get intervalSamples(): number {
    return this.medianWindow.samples
  }

  /**
   * Median inter-arrival in ms, or `undefined` while the track is still warming
   * up. Allocation-free: the window is kept sorted on write.
   */
  medianIntervalMs(): number | undefined {
    if (this.medianWindow.samples < this.medianMinSamples) return undefined
    return this.medianWindow.median()
  }

  onParseFailure(at: Mono): void {
    this.parseFailures++
    this.lastActivity = at
    // A parse failure is an observation on this track at a time, so it bounds
    // the interval exactly as an object does. Without this a track whose only
    // interval activity was a desync would report `firstSeen === lastSeen === 0`
    // and ingest could not place the failure anywhere.
    if (this.firstSeen === undefined) this.firstSeen = at
    this.lastSeen = at
  }

  /**
   * Fold one object. Called once per object on the page's data path, so
   * everything here is bounded work with no allocation.
   */
  onObject(s: ObjectSample): void {
    const at = s.at
    this.objects++
    this.payloadBytes += s.payloadBytes
    this.headerBytes += s.headerBytes
    this.lastActivity = at
    if (this.firstSeen === undefined) this.firstSeen = at
    this.lastSeen = at

    // `obj.sizeBytes` is the media object's size. Header bytes
    // are counted separately rather than folded in: the header is the
    // collector's overhead to reason about, not the customer's payload.
    this.hist.objectSizeBytes.observe(s.payloadBytes)

    if (s.status !== undefined) this.statusObjects++

    // Inter-arrival, and the stall it becomes past a threshold. Measured across
    // interval boundaries — `lastAt` survives drain().
    const prev = this.lastAt
    if (prev !== undefined) {
      const gap = at - prev
      if (gap >= 0) {
        // The threshold is taken from the median BEFORE this gap joins it, so a
        // stall cannot raise the bar it is being measured against. A cold
        // median judges nothing at all: see {@link STALL_FLOOR_MS}.
        const m = this.medianIntervalMs()
        this.hist.interArrivalMs.observe(gap)
        this.medianWindow.push(gap)
        if (m !== undefined) {
          const threshold = Math.max(this.stallFloorMs, m * this.stallMultiple)
          // stall.count = hist.n, stall.totalMs = hist.sum, stall.maxMs ≈ the
          // top occupied bucket: one histogram carries all three stall fields,
          // which is what fits them into a row with no stall counters of its own.
          if (gap > threshold) this.hist.stallMs.observe(gap)
        }
      }
    }
    this.lastAt = at

    // Groups. A "new group" is one above the highest seen: subgroups of one
    // group arrive on separate interleaved streams, so counting transitions
    // would count the same group repeatedly.
    const max = this.maxGroup
    if (max === undefined || s.groupId > max) {
      this.groups++
      if (max !== undefined) {
        const missing = s.groupId - max - 1n
        if (missing > 0n) this.groupGaps += clampGapRun(missing)
      }
      if (this.lastNewGroupAt !== undefined) {
        this.hist.groupCadenceMs.observe(at - this.lastNewGroupAt)
      }
      // A higher group starting is the only signal that the previous one is
      // done — MoQT has no end-of-group marker a counter can see — so the span
      // is observed here, one group behind. The last group of a track is
      // therefore never observed, which is correct: it never closed.
      if (this.curGroupFirstAt !== undefined) {
        this.hist.groupOpenMs.observe(this.curGroupLastAt - this.curGroupFirstAt)
      }
      this.curGroupFirstAt = at
      this.curGroupLastAt = at
      this.lastNewGroupAt = at
      this.maxGroup = s.groupId
    } else if (s.groupId < max) {
      // Group-level lateness only. Object-level reordering *within* a group is
      // deliberately not counted: object ids ascend per subgroup, not per
      // group, and `SubgroupHeaderInfo` carries no subgroup id, so every
      // multi-subgroup track would report continuous reordering that is not
      // happening. Under-reporting with no false positives beats the reverse
      // for a number an operator alerts on.
      this.outOfOrder++
      // Deliberately not extending any span. A late object for a group that has
      // already closed cannot reopen it without making the histogram depend on
      // arrival order, and its lateness is already counted right here.
    } else {
      // Still the open group. Its span grows until a higher group closes it.
      this.curGroupLastAt = at
    }

    // Duplicates, over a fixed recency window. Structural duplicates (a
    // shared alias — one object sent once per matching subscription) arrive
    // close together, which is what this window is sized for. A duplicate
    // separated by more than DUPLICATE_WINDOW distinct objects is missed;
    // catching those needs per-object state, which the O(1) budget forbids.
    const g = Number(s.groupId)
    const o = Number(s.objectId)
    const slot = (((g * 31 + o) | 0) >>> 0) % DUPLICATE_WINDOW
    if (this.dupUsed[slot] === 1 && this.dupGroups[slot] === g && this.dupObjects[slot] === o) {
      this.duplicates++
    } else {
      this.dupUsed[slot] = 1
      this.dupGroups[slot] = g
      this.dupObjects[slot] = o
    }
  }

  /**
   * The interval row, and a reset of the interval state.
   *
   * `key.v` is a decimal **string**: the id is a bigint (aliases and request
   * ids are vi64), `JSON.stringify` throws on a bigint, and a `number` silently
   * loses precision past 2^53.
   */
  drain(): RollupTrackWire {
    const hist: Partial<Record<HistogramKind, HistogramWire>> = {}
    for (const kind of TRACK_HISTOGRAMS) {
      const w = this.hist[kind].encode()
      if (w !== null) hist[kind] = w
      this.hist[kind].reset()
    }
    const row: RollupTrackWire = {
      key: {
        d: this.key.dir,
        k: this.key.kind,
        v: this.key.id.toString(),
        e: this.key.epoch,
      },
      ...(this.sharedAlias ? { shared: true as const } : {}),
      firstSeen: (this.firstSeen ?? this.lastSeen) - this.origin,
      lastSeen: this.lastSeen - this.origin,
      objects: this.objects,
      payloadBytes: this.payloadBytes,
      headerBytes: this.headerBytes,
      groups: this.groups,
      groupGaps: this.groupGaps,
      outOfOrder: this.outOfOrder,
      duplicates: this.duplicates,
      statusObjects: this.statusObjects,
      parseFailures: this.parseFailures,
      // Omitted rather than zero: every rx track would otherwise carry two
      // fields that can never be anything but 0, on every interval.
      ...(this.blockedMs > 0 ? { blockedMs: this.blockedMs } : {}),
      ...(this.ackedBytes > 0 ? { ackedBytes: this.ackedBytes } : {}),
      hist,
    }
    this.objects = 0
    this.payloadBytes = 0
    this.headerBytes = 0
    this.groups = 0
    this.groupGaps = 0
    this.outOfOrder = 0
    this.duplicates = 0
    this.statusObjects = 0
    this.parseFailures = 0
    this.blockedMs = 0
    this.ackedBytes = 0
    this.firstSeen = undefined
    return row
  }
}

function clampGapRun(missing: bigint): number {
  return missing > BigInt(MAX_GAP_RUN) ? MAX_GAP_RUN : Number(missing)
}
