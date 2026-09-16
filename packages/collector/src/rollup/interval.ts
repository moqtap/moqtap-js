/**
 * The interval rollup engine.
 *
 * `detail` and `metrics.interval` are decoupled: the rollup is computed at every
 * detail level, including the cheapest, and reports per-track object rate,
 * bitrate, group cadence, gaps, duplicates, out-of-order arrivals, stall
 * duration and control-exchange latencies.
 *
 * This class is the {@link CountingSink} the counting decoder writes into, and
 * the two modules meet here and share no file. Everything it emits goes out
 * through a {@link RecordSink}; it knows nothing about framing, compression,
 * persistence or upload.
 *
 * **Nothing here computes a percentile**. Fixed-boundary buckets go on the wire
 * and merge by elementwise addition; a device-side p95 could never be merged
 * with another device's.
 */

import {
  type BucketKey,
  bucketKeyString,
  type ClockSource,
  type ControlFrameEvent,
  type CountingSink,
  type DetailLevel,
  type ExchangeKind,
  type Mono,
  type ObjectSample,
  type ParseFailureReason,
  type RecordSink,
  type RollupRecord,
  type RollupTrackWire,
} from '../types.js'
import { TrackBucket, type TrackBucketOptions } from './bucket.js'
import type { CustomMetrics } from './custom-metrics.js'
import { flattenHistogram, Histogram } from './histogram.js'

/**
 * Intervals a silent bucket is kept before eviction.
 *
 * It cannot be zero, and the reason is the trigger rather than the wire: a
 * stalled track produces no objects, and evicting it would destroy the very
 * median the stall and cadence triggers need to notice the stall. Five
 * intervals is five minutes at the default 60 s.
 */
export const IDLE_EVICT_INTERVALS = 5

/**
 * Monotonic/wall divergence over one interval that counts as "the device
 * slept" ({@link RollupRecord.suspended}).
 *
 * An explanation, not an error: the two clocks are both captured, both
 * sent, and never silently corrected. One second is far above ordinary timer
 * jitter and far below any real suspend.
 */
export const SUSPEND_TOLERANCE_MS = 1_000

/**
 * Live median lookup, for the trigger engine.
 *
 * The interface lives here because {@link RollupEngine} is the only thing that
 * has the medians. The trigger engine declares its own structurally identical
 * interface, which TypeScript accepts, so there is no import edge between them.
 */
export interface MedianSource {
  /** Median observed inter-arrival for a track, or `undefined` while cold. */
  medianFor(k: BucketKey): number | undefined
  /** Inter-arrival samples seen for a track — the caller's own warm-up test. */
  medianSamplesFor(k: BucketKey): number
}

export interface RollupEngineOptions extends TrackBucketOptions {
  /** Nominal ms between {@link RollupEngine.tick}s. The engine owns no timer. */
  readonly intervalMs: number
  /** Second, independent cap on bucket count. See {@link RollupEngine.onObject}. */
  readonly maxBuckets: number
  readonly clock: ClockSource
  readonly sink: RecordSink
  /**
   * Session origin. Every {@link Mono} the engine emits is relative to
   * it, as {@link import('../types.js').RecordBase.ts} requires. Defaults to 0,
   * which passes the seam's raw `performance.now()` values through unchanged.
   */
  readonly originMono?: Mono
  /** Customer metrics, drained into each rollup record. */
  readonly custom?: CustomMetrics
  readonly idleEvictIntervals?: number
  readonly suspendToleranceMs?: number
}

interface CachedBucket {
  readonly bucket: TrackBucket
  readonly gen: number
}

/**
 * The interval-per-track rollup.
 *
 * O(1) memory per track and O(1) work per object, with no allocation on the
 * object path: {@link onObject} resolves a bucket through an identity cache,
 * folds the sample into counters and fixed histograms, and returns.
 */
export class RollupEngine implements CountingSink, MedianSource {
  private readonly buckets = new Map<string, TrackBucket>()
  /**
   * Identity cache in front of {@link buckets}.
   *
   * The module contract requires {@link medianFor} to allocate nothing, and
   * {@link bucketKeyString} allocates a string on every call. The decoder hands
   * back the same {@link BucketKey} object for a given track, so a `WeakMap`
   * keyed on that object turns the repeat case into a pointer lookup while the
   * string map stays canonical — two different key objects for one logical key
   * must still find one bucket. `gen` invalidates entries an eviction removed.
   */
  private readonly keyCache = new WeakMap<BucketKey, CachedBucket>()
  private gen = 0

  private readonly opts: RollupEngineOptions
  private readonly bucketOpts: TrackBucketOptions
  private readonly origin: Mono
  private readonly idleEvictMs: number
  private readonly suspendToleranceMs: number

  private session: Record<string, number> = {}
  private readonly controlLatency = new Map<ExchangeKind, Histogram>()
  private readonly writerReady = new Histogram('writerReadyMs')

  private seq = 0
  /**
   * When the open interval began.
   *
   * The **session anchor** for the first interval, and the previous `tick`'s
   * `nowMono` thereafter — never the first object's arrival. Ingest divides
   * counts by `endMono - startMono` to get `obj.rate` and `obj.bitrate`
   * so starting the first interval at its first object would
   * overstate the rate of exactly the interval that contains connection setup,
   * and would do it silently.
   */
  private startMono: Mono
  private lastTickMono: Mono | undefined
  private lastTickWall = 0
  private refused = 0
  private failures = 0

  constructor(opts: RollupEngineOptions) {
    this.opts = opts
    this.bucketOpts = {
      origin: opts.originMono ?? 0,
      ...(opts.medianWindow !== undefined ? { medianWindow: opts.medianWindow } : {}),
      ...(opts.medianMinSamples !== undefined ? { medianMinSamples: opts.medianMinSamples } : {}),
      ...(opts.stallMultiple !== undefined ? { stallMultiple: opts.stallMultiple } : {}),
      ...(opts.stallFloorMs !== undefined ? { stallFloorMs: opts.stallFloorMs } : {}),
    }
    this.origin = opts.originMono ?? 0
    this.startMono = this.origin
    this.idleEvictMs = (opts.idleEvictIntervals ?? IDLE_EVICT_INTERVALS) * opts.intervalMs
    this.suspendToleranceMs = opts.suspendToleranceMs ?? SUSPEND_TOLERANCE_MS
  }

  /** Live buckets. Falls as idle tracks are evicted. */
  get bucketCount(): number {
    return this.buckets.size
  }

  /**
   * Buckets this engine refused for want of capacity, session-lifetime. Feeds
   * {@link import('../types.js').TerminalRecord} alongside
   * the resolver's own count — the two are different refusals and ingest is
   * given both.
   */
  get bucketsRefused(): number {
    return this.refused
  }

  /** Parse failures, session-lifetime. Feeds the terminal record's counters. */
  get parseFailures(): number {
    return this.failures
  }

  /* ── CountingSink ─────────────────────────────────────────────────────── */

  onObject(s: ObjectSample): void {
    const b = this.bucketFor(s.key)
    if (b === undefined) return
    b.onObject(s)
  }

  /**
   * A control frame: counted, and shipped raw at baseline.
   *
   * The `ctrl` record is immediately followed by exactly one raw frame carrying
   * its bytes, in that order and in the same body — a raw frame is unreadable
   * without the record that names it. Shipping the bytes whether or not they
   * decoded is what lets every track name, namespace and reason phrase stay off
   * the device: ingest reparses them server-side.
   *
   * `e.bytes` is a borrowed view and is passed straight through: the frame
   * writer behind {@link RecordSink.raw} copies. Copying here as well would
   * double the cost of the one path rate-limited at 5,000 frames/s.
   */
  onControlFrame(e: ControlFrameEvent): void {
    const n = e.bytes.length
    this.bump(`ctrl.${e.dir}.frames`, 1)
    this.bump(`ctrl.${e.dir}.bytes`, n)
    const decoded = e.message !== null
    if (!decoded) this.bump('ctrl.undecoded', 1)
    this.opts.sink.json({
      t: 'ctrl',
      ts: e.at - this.origin,
      lvl: BASELINE,
      dir: e.dir,
      streamId: e.streamId,
      n,
      decoded,
    })
    this.opts.sink.raw(e.bytes)
  }

  onParseFailure(key: BucketKey | null, reason: ParseFailureReason): void {
    this.failures++
    this.bump(`parse.${reason}`, 1)
    if (key === null) return
    const b = this.bucketFor(key)
    if (b !== undefined) b.onParseFailure(this.opts.clock.now())
  }

  /* ── the trigger's median source ───────────────────────────────── */

  medianFor(k: BucketKey): number | undefined {
    return this.peek(k)?.medianIntervalMs()
  }

  medianSamplesFor(k: BucketKey): number {
    return this.peek(k)?.intervalSamples ?? 0
  }

  /* ── control-plane and send-side observations ─────────────────────────── */

  /**
   * One control exchange's request→response latency.
   *
   * Keyed on an **abstract exchange kind**, never on wire message names:
   * draft-20 unifies `request_ok`/`request_error` where earlier drafts have
   * per-request-type responses, so a metric keyed on message names fragments
   * across fourteen drafts and cannot be compared.
   *
   * It is a separate entry point rather than something derived inside
   * {@link onControlFrame} because {@link ControlFrameEvent} carries neither a
   * kind nor a latency, and the `streamId → pending request` map that resolves
   * both lives in the decoder's `TrackKeys`.
   */
  observeControlLatency(kind: ExchangeKind, ms: number): void {
    let h = this.controlLatency.get(kind)
    if (h === undefined) {
      h = new Histogram('controlLatencyMs')
      this.controlLatency.set(kind, h)
    }
    h.observe(ms)
    this.bump(`ctl.${kind}.count`, 1)
  }

  /** `writer.ready` latency — a publish-only session's only pressure signal. */
  observeWriterReady(ms: number): void {
    this.writerReady.observe(ms)
  }

  /**
   * The same pressure, attributed to the track whose stream blocked.
   *
   * Deliberately a second call rather than a `key` parameter on
   * {@link observeWriterReady}: the session histogram must count *every*
   * episode, including the ones that arrive before the stream's subgroup header
   * has been written and so have no track yet. Folding them together would make
   * the session total silently depend on how early the page blocks, and the one
   * number a publisher checks first would stop being a total.
   */
  observeWriterBlocked(k: BucketKey, ms: number, at: Mono): void {
    this.bucketFor(k)?.onWriterBlocked(ms, at)
  }

  /**
   * A `bytesAcknowledged` delta for one track. Chromium-only; see
   * {@link RollupTrackWire.ackedBytes}.
   */
  observeAckedBytes(k: BucketKey, deltaBytes: number, at: Mono): void {
    this.bucketFor(k)?.onAcked(deltaBytes, at)
  }

  /**
   * Two concurrent subscriptions share this alias.
   *
   * Set from the control plane. {@link BucketKey} has no `shared` field and
   * {@link ObjectSample} carries none either, so there is no channel from the
   * decoder's epoch map to the wire row without this call.
   */
  markShared(k: BucketKey): void {
    this.bucketFor(k)?.markShared()
  }

  /* ── the interval ─────────────────────────────────────────────────────── */

  /**
   * Emit one rollup record and reset the interval.
   *
   * Called on the metrics interval and again at flush, so it must be cheap when
   * nothing happened: an interval with no track activity, no session counters
   * and no customer metrics emits **nothing**.
   */
  tick(nowMono: Mono): void {
    const start = this.startMono
    const tracks: RollupTrackWire[] = []
    for (const [ks, b] of this.buckets) {
      if (b.activity > 0) tracks.push(b.drain())
      else if (nowMono - b.lastActivityMono > this.idleEvictMs) {
        this.buckets.delete(ks)
        this.gen++
      }
    }

    const session = this.session
    for (const [kind, h] of this.controlLatency) {
      flattenHistogram(`ctl.${kind}.latencyMs`, h, session)
      h.reset()
    }
    flattenHistogram('wt.writerReadyMs', this.writerReady, session)
    this.writerReady.reset()

    const custom = this.opts.custom?.drain() ?? []
    const suspended = this.detectSuspend(nowMono)

    const hasSession = hasAnyKey(session)
    if (tracks.length === 0 && !hasSession && custom.length === 0) {
      this.startMono = nowMono
      return
    }

    const record: RollupRecord = {
      t: 'rollup',
      v: 1,
      ts: nowMono - this.origin,
      lvl: BASELINE,
      seq: this.seq++,
      startMono: start - this.origin,
      endMono: nowMono - this.origin,
      tracks,
      session,
      ...(suspended ? { suspended: true as const } : {}),
      ...(custom.length > 0 ? { custom } : {}),
    }
    this.opts.sink.json(record)

    this.session = {}
    this.startMono = nowMono
  }

  /* ── internals ────────────────────────────────────────────────────────── */

  /**
   * Resolve or create a bucket. `undefined` means the cap refused it — counted,
   * never silently merged into another track's row.
   *
   * The cap is deliberately a *second* one: the decoder's `TrackKeys` caps
   * bucket keys and returns `null` at its own limit. This engine
   * still enforces its own, because it accepts samples from anything holding a
   * {@link CountingSink} and unbounded memory growth must not depend on another
   * module's discipline.
   */
  private bucketFor(k: BucketKey): TrackBucket | undefined {
    const cached = this.keyCache.get(k)
    if (cached !== undefined && cached.gen === this.gen) return cached.bucket
    const ks = bucketKeyString(k)
    let b = this.buckets.get(ks)
    if (b === undefined) {
      if (this.buckets.size >= this.opts.maxBuckets) {
        this.refused++
        this.bump('buckets.refused', 1)
        return undefined
      }
      b = new TrackBucket(k, this.bucketOpts)
      this.buckets.set(ks, b)
    }
    this.keyCache.set(k, { bucket: b, gen: this.gen })
    return b
  }

  /** Lookup that never creates — the trigger asks about tracks, it does not open them. */
  private peek(k: BucketKey): TrackBucket | undefined {
    const cached = this.keyCache.get(k)
    if (cached !== undefined && cached.gen === this.gen) return cached.bucket
    const b = this.buckets.get(bucketKeyString(k))
    if (b !== undefined) this.keyCache.set(k, { bucket: b, gen: this.gen })
    return b
  }

  private bump(name: string, n: number): void {
    this.session[name] = (this.session[name] ?? 0) + n
  }

  /**
   * Monotonic and wall clocks diverging over the interval means the device
   * slept, reported as `wt.suspended`. Reported, never corrected.
   */
  private detectSuspend(nowMono: Mono): boolean {
    const wall = this.opts.clock.wall()
    const prevMono = this.lastTickMono
    const prevWall = this.lastTickWall
    this.lastTickMono = nowMono
    this.lastTickWall = wall
    if (prevMono === undefined) return false
    const dMono = nowMono - prevMono
    const dWall = wall - prevWall
    return Math.abs(dWall - dMono) > this.suspendToleranceMs
  }
}

/**
 * The level stamped on every record this engine emits.
 *
 * Always `baseline`, whatever the session's current dial position: the rollup
 * and the raw control plane are produced identically at every level, and
 * {@link RecordBase.lvl} is what ingest attributes bytes by, so an elevated
 * stamp would attribute bytes that would have been sent anyway.
 */
const BASELINE: DetailLevel = 'baseline'

function hasAnyKey(o: Record<string, number>): boolean {
  for (const _ in o) return true
  return false
}
