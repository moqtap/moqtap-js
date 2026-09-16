import type { PressureSample } from '../types.js'

/**
 * Shaped release — "do not upload into congestion; gather, buffer,
 * release slowly".
 *
 * ── Why this is a separate object from the flush schedule.
 *
 * Three release policies were specified and none was named as governing. They
 * are reconciled by splitting the two verbs that were used interchangeably:
 *
 *  - **Sealing** is the flush schedule (`schedule.ts`): `ready`, +5 s, +15 s,
 *    +45 s, then every 60 s or 32 KB. It decides when a chunk is *built, keyed
 *    and persisted*.
 *  - **Release** is this file. It decides only how fast sealed chunks leave the
 *    device, and it can only *slow* release — never seal less often.
 *
 * That split is the only reading under which the "a crash loses at most 60
 * seconds" stays true: if pressure could stretch the sealing interval, an hour
 * of congestion would leave an hour of unkeyed, unpersisted records in memory,
 * and the crash that congestion makes likely would take all of it.
 *
 * ── Why arrival rate, and why slowing down is the *non-interference* answer.
 *
 * This is the sharpest form of the promise. Flight-recorder mode raises our
 * output at the exact moment the network is worst — the trigger *is* a
 * network-trouble signal — so releasing on trigger does two harms: our upload
 * competes with the media and makes the user's stall worse, **and the
 * measurement is biased by the act of measuring**, because we would be recording
 * a degradation we are contributing to.
 *
 * The signal is **object arrival rate**. It is already computed for the
 * rollup, needs no probe of our own, and measures the bottleneck the player
 * actually cares about rather than one we invent.
 */

/** Where a pacer sits between its two configured bounds. */
export interface ReleasePacerOptions {
  /** Delay between releases when the session looks healthy. */
  readonly minIntervalMs: number
  /** Delay at full pressure. Never exceeded, whatever the signal says. */
  readonly maxIntervalMs: number
}

/**
 * Arrival rate at or above this fraction of the session's established rate is
 * "healthy": zero pressure. Slightly below 1 because object rate is jittery at
 * any GOP boundary and a pacer that reacted to jitter would oscillate.
 */
const HEALTHY_RATIO = 0.9

/** At or below this fraction of the established rate, pressure is total. */
const FLOOR_RATIO = 0.25

/** Pressure below this is treated as zero — a deadband, so release does not flap. */
const DEADBAND = 0.1

/** Weight of the newest sample in the fast EWMA. */
const FAST_ALPHA = 0.5

/**
 * Per-sample decay of the established rate.
 *
 * The baseline rises instantly (more throughput is unambiguously healthier) and
 * falls slowly, so a track that legitimately drops to a lower steady rate stops
 * being read as congestion after a while instead of throttling release forever.
 */
const BASELINE_DECAY = 0.98

/** `writer.ready` latency at or below this is unloaded — the publish-only floor. */
const READY_GOOD_MS = 5

/** `writer.ready` latency at or above this is full pressure for a publisher. */
const READY_BAD_MS = 250

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v)

/**
 * Turns pressure samples into a release delay.
 *
 * Stateful and cheap: two floating-point accumulators and no allocation, so it
 * can be fed from the rollup's per-interval tick without adding to the
 * per-object budget.
 */
export class ReleasePacer {
  readonly #min: number
  readonly #max: number
  #recent: number | undefined
  #baseline: number | undefined
  #ready: number | undefined
  #samples = 0
  #sawObjects = false

  constructor(o: ReleasePacerOptions) {
    this.#min = Math.max(0, o.minIntervalMs)
    this.#max = Math.max(this.#min, o.maxIntervalMs)
  }

  /**
   * Fold in one observation of the session's pressure.
   *
   * `objectsPerSec` is the pressure signal. `writerReadyMs` is this package's
   * fallback for **publish-only** sessions, which have no arriving objects at
   * all — publisher backpressure has no subscriber-side analogue. That fallback
   * is this package's decision rather than the spec's, and is unvalidated. It
   * engages only when no object has ever been seen, so a subscriber that
   * momentarily stalls is never silently re-paced off a send-side signal.
   */
  notePressure(p: PressureSample): void {
    if (typeof p.writerReadyMs === 'number' && Number.isFinite(p.writerReadyMs)) {
      this.#ready =
        this.#ready === undefined
          ? p.writerReadyMs
          : this.#ready + FAST_ALPHA * (p.writerReadyMs - this.#ready)
    }
    const rate = p.objectsPerSec
    if (!Number.isFinite(rate) || rate < 0) return
    this.#samples += 1
    if (rate > 0) this.#sawObjects = true
    if (this.#recent === undefined || this.#baseline === undefined) {
      this.#recent = rate
      this.#baseline = rate
      return
    }
    this.#recent += FAST_ALPHA * (rate - this.#recent)
    this.#baseline = Math.max(this.#recent, this.#baseline * BASELINE_DECAY)
  }

  /**
   * 0 = healthy, 1 = the arrival rate this session established has collapsed.
   *
   * Exposed because the api module puts it in the terminal record's session
   * counters: "we released slowly" is otherwise indistinguishable at ingest from
   * "we had nothing to send".
   */
  get pressure(): number {
    // Warm-up. One sample establishes a baseline and cannot yet show a change
    // from it, so nothing is inferred and release runs at full speed.
    if (this.#samples < 2) return 0

    if (!this.#sawObjects) {
      // Publish-only fallback. Absent even a writer sample there is no
      // signal at all, and inventing pressure from silence would throttle every
      // idle session.
      if (this.#ready === undefined) return 0
      const p = (this.#ready - READY_GOOD_MS) / (READY_BAD_MS - READY_GOOD_MS)
      return clamp01(p) < DEADBAND ? 0 : clamp01(p)
    }

    const baseline = this.#baseline
    const recent = this.#recent
    if (baseline === undefined || recent === undefined || baseline <= 0) return 0
    const ratio = recent / baseline
    const p = clamp01((HEALTHY_RATIO - ratio) / (HEALTHY_RATIO - FLOOR_RATIO))
    return p < DEADBAND ? 0 : p
  }

  /**
   * How long to wait before releasing the next sealed chunk.
   *
   * Geometric between the two bounds, because release intervals compose
   * multiplicatively: halfway between 1 s and 60 s should be ~8 s, not 30 s. A
   * linear ramp spends most of its range in intervals long enough to matter and
   * reaches them on mild pressure.
   */
  nextReleaseDelayMs(): number {
    const p = this.pressure
    if (p <= 0) return this.#min
    if (this.#min <= 0) return Math.round(this.#max * p)
    return Math.round(this.#min * (this.#max / this.#min) ** p)
  }
}
