/**
 * The triggers — what opens a capture window, and what must never open one.
 *
 * {@link import('../types.js').TriggerConfig} is **one object keyed by trigger
 * kind, where absent means off**, so automated mode ships off by construction:
 * `{}` is the default and it fires nothing.
 *
 * ── Why the cadence threshold is a multiple and not a millisecond figure.
 *
 * `{ multiple: 3 }` fires at 6,000 ms on a 2 s GOP and at 750 ms on a 250 ms
 * one, from one config key, without the customer knowing their own GOP length.
 * A self-calibrating threshold needs no field data to be correct — it needs a
 * warm-up, which {@link TriggerEngine.warm} enforces. The median comes from the
 * rollup's sliding window; before it is established *every* interval looks
 * anomalous against an empty sample, so a recorder that fired during warm-up
 * would open a window on every session start — the one moment every session has
 * in common.
 *
 * ── Why a stall needs a steady track, and a live one.
 *
 * A gap means "stalled" only on a track that was flowing faster than the gap.
 * A catalog that published once, a finished FETCH, the rendition an ABR switch
 * just left and every track of a closed connection all go quiet for good, and
 * each of them would otherwise open a capture window, which counts toward
 * recording minutes, on the next tick. So the stall trigger waits for the same
 * warm-up as the cadence trigger, and for a median shorter than `afterMs`; and
 * a track whose subscription, fetch or connection has ended is forgotten (see
 * {@link TriggerEngineOptions.liveness}). A track no observed request stands
 * behind may have ended unseen, so its silence opens nothing either; only a
 * late object can show it was a gap.
 *
 * This engine decides *that* a window should open, never what it costs or how
 * long it stays open; that is the api module's escalation ledger. Firing is
 * rate-limited here rather than there, because the cost of a fire is a re-parse
 * plus the largest record this collector sends, and a flapping track can produce
 * one per object gap.
 */

import {
  type BucketKey,
  bucketKeyString,
  type Mono,
  type ObjectSample,
  type TrackLiveness,
  type TriggerConfig,
  type TriggerKind,
} from '../types.js'

/** What fired, when, and against which track. */
export interface TriggerEvent {
  readonly kind: TriggerKind
  readonly atMono: Mono
  /** Absent only for a trigger with no track of its own. */
  readonly key?: BucketKey
  /**
   * Why it fired, in words, with the numbers that decided it. Reaches the
   * operator through `EscalationRecord.by`; no window opens without one.
   */
  readonly detail: string
}

/**
 * The live per-track median, as the rollup engine has it.
 *
 * Declared here rather than imported so this module depends on `types.ts` and
 * nothing else at runtime: the rollup's own `MedianSource` is structurally
 * identical, so `RollupEngine` satisfies this with no adapter and no import edge
 * between the two modules.
 *
 * `medianFor` runs on the engine's identity cache and allocates nothing, which
 * is why {@link TriggerEngine.tick} may call it per track per tick.
 */
export interface MedianSource {
  /** Median observed inter-arrival for a track, or `undefined` while cold. */
  medianFor(k: BucketKey): number | undefined
  /** Inter-arrival samples seen for a track — the warm-up counter. */
  medianSamplesFor(k: BucketKey): number
}

/**
 * Shortest interval between two capture windows, per track **and** session-wide.
 *
 * A fire is expensive twice: it re-parses the ring and it emits the largest
 * record of the session, at the moment the network is worst. Two fires inside
 * one cooldown also carry substantially the *same* window — the ring is
 * session-wide and a few seconds of it has barely turned over — so the second
 * dump is mostly a second copy of the first.
 *
 * 30 s is well under the 60 s rollup interval, so a genuinely broken session
 * still produces a dump per minute; it is well over a stall's own duration, so
 * one stall cannot produce a burst.
 */
export const DEFAULT_TRIGGER_COOLDOWN_MS = 30_000

/**
 * Tracks the engine keeps gap state for.
 *
 * The same cap and the same reason as the decoder's `DEFAULT_MAX_BUCKETS`: far
 * above any real session, far below what a flapping relay or a fuzzing peer can
 * invent. Past it the least recently active track is dropped rather than the new
 * one refused — a track that has produced nothing for minutes cannot be the one
 * about to stall.
 */
export const DEFAULT_MAX_TRACKED = 1024

/**
 * Inter-arrival samples a track needs before the stall trigger may fire on it,
 * when no `cadence.minSamples` is configured. The same figure as the cadence
 * trigger's default warm-up, for the same reason: one sample is not a cadence.
 */
export const DEFAULT_STALL_MIN_SAMPLES = 20

export interface TriggerEngineOptions {
  readonly config: TriggerConfig
  readonly medians: MedianSource
  /**
   * Whether a track is still an open subscription or fetch on an open
   * connection. A track it reports `ended` is forgotten on the next tick, and
   * one it reports `unbound` is kept but never judged by its silence, so only a
   * track somebody is known to be waiting on can be stalled. Absent, every
   * track counts as `open`.
   */
  readonly liveness?: (k: BucketKey) => TrackLiveness
  /**
   * Whether a window opened against this track now would have a dump behind
   * it. When it says no, the fire is dropped before it counts, latches or
   * starts a cooldown. Absent, every fire can.
   */
  readonly canFire?: (k: BucketKey) => boolean
  readonly onFire: (e: TriggerEvent) => void
  /** See {@link DEFAULT_TRIGGER_COOLDOWN_MS}. `0` disables rate limiting. */
  readonly cooldownMs?: number
  readonly maxTracked?: number
}

interface TrackState {
  readonly key: BucketKey
  /** Arrival of the most recent object on this track. */
  lastAt: Mono
  /** A fire is latched until the track produces an object at a normal gap. */
  latched: boolean
  lastFireAt: Mono
}

/** One evaluated threshold. */
interface Verdict {
  readonly kind: TriggerKind
  readonly threshold: number
}

export class TriggerEngine {
  private readonly config: TriggerConfig
  private readonly medians: MedianSource
  private readonly liveness: ((k: BucketKey) => TrackLiveness) | undefined
  private readonly canFire: ((k: BucketKey) => boolean) | undefined
  private readonly onFire: (e: TriggerEvent) => void
  private readonly cooldownMs: number
  private readonly maxTracked: number

  private readonly tracks = new Map<string, TrackState>()
  private lastFireAt = Number.NEGATIVE_INFINITY
  private fires = 0
  private suppressed = 0
  private evictedTracks = 0

  constructor(o: TriggerEngineOptions) {
    this.config = o.config
    this.medians = o.medians
    this.liveness = o.liveness
    this.canFire = o.canFire
    this.onFire = o.onFire
    this.cooldownMs = o.cooldownMs ?? DEFAULT_TRIGGER_COOLDOWN_MS
    this.maxTracked =
      o.maxTracked !== undefined && o.maxTracked > 0 ? o.maxTracked : DEFAULT_MAX_TRACKED
  }

  /** Capture windows this engine has opened. */
  get capturesFired(): number {
    return this.fires
  }

  /**
   * Fires the cooldown swallowed.
   *
   * Reported rather than hidden: a session whose suppressed count dwarfs its
   * fired count was continuously broken, which is a different story from one
   * that broke twice.
   */
  get capturesSuppressed(): number {
    return this.suppressed
  }

  /** Tracks dropped to stay under {@link DEFAULT_MAX_TRACKED}. */
  get tracksEvicted(): number {
    return this.evictedTracks
  }

  /** Tracks currently holding gap state. */
  get trackedCount(): number {
    return this.tracks.size
  }

  /** True when nothing in the config can ever fire (the default). */
  get idle(): boolean {
    return this.config.stall === undefined && this.config.cadence === undefined
  }

  /**
   * **True only once the track's median is established.**
   *
   * The warm-up is both halves of the condition — a median value *and* enough
   * samples behind it — because the rollup's sliding median reports a value from
   * its first sample onward and one sample is not a cadence.
   */
  warm(k: BucketKey): boolean {
    const m = this.medians.medianFor(k)
    if (m === undefined || !(m > 0)) return false
    return this.medians.medianSamplesFor(k) >= (this.config.cadence?.minSamples ?? 0)
  }

  /**
   * One counted object arrived.
   *
   * Cheap by construction: one map lookup, one subtraction and — only when the
   * cadence trigger is configured — one allocation-free median lookup. The
   * engine holds no per-object history of its own.
   */
  onObject(s: ObjectSample): void {
    if (this.config.stall === undefined && this.config.cadence === undefined) return
    const st = this.stateFor(s.key, s.at)
    if (st === undefined) return

    const gap = s.at - st.lastAt
    if (gap > 0) {
      const v = this.verdict(st.key, gap)
      if (v === undefined) {
        // A normal interval ends the episode: the next anomaly may fire again.
        st.latched = false
      } else if (!st.latched) {
        this.fire(v.kind, st, s.at, describeGap(v, gap))
      }
    }
    st.lastAt = s.at
  }

  /**
   * Time passed with no object.
   *
   * The half that matters. A stall produces **no** objects, so an engine that
   * only evaluated on arrival would fire when the stream recovered — after the
   * ring had already overwritten the moments the dump exists to capture — or
   * never, if it did not recover. The caller ticks this from the same timer that
   * drives the rollup interval; the engine owns no timer.
   *
   * Ended tracks are dropped here rather than skipped: their silence is
   * permanent, and holding them would only bring forward the cap eviction of a
   * live one.
   */
  tick(nowMono: Mono): void {
    if (this.config.stall === undefined && this.config.cadence === undefined) return
    for (const [id, st] of this.tracks) {
      const live = this.liveness?.(st.key) ?? 'open'
      if (live === 'ended') {
        this.tracks.delete(id)
        continue
      }
      if (live === 'unbound' || st.latched) continue
      const gap = nowMono - st.lastAt
      if (!(gap > 0)) continue
      const v = this.verdict(st.key, gap)
      if (v !== undefined) this.fire(v.kind, st, nowMono, describeGap(v, gap))
    }
  }

  /** Drop all gap state. Called when the recorder is disarmed or the session ends. */
  reset(): void {
    this.tracks.clear()
    this.lastFireAt = Number.NEGATIVE_INFINITY
  }

  /* ── internals ────────────────────────────────────────────────────────── */

  /**
   * Which configured threshold this gap crossed, if any.
   *
   * When both cross, the one with the **lower** threshold is reported: it is the
   * one that crossed first in time, so it is the honest description of what
   * opened the window. Ties go to `cadence`, which carries the track's own
   * observed rhythm and is therefore the more specific statement.
   */
  private verdict(k: BucketKey, gap: number): Verdict | undefined {
    let best: Verdict | undefined

    const cadence = this.config.cadence
    if (cadence !== undefined && this.warm(k)) {
      // `warm()` has already established the median is defined and positive.
      const threshold = (this.medians.medianFor(k) as number) * cadence.multiple
      if (gap >= threshold) best = { kind: 'cadence', threshold }
    }

    const stall = this.config.stall
    if (stall !== undefined && gap >= stall.afterMs && this.steady(k, stall.afterMs)) {
      if (best === undefined || stall.afterMs < best.threshold) {
        best = { kind: 'stall', threshold: stall.afterMs }
      }
    }

    return best
  }

  /**
   * The track has an established median, and it is shorter than `afterMs`: a
   * gap of `afterMs` is then an interruption of the track's own rhythm rather
   * than the rhythm itself.
   */
  private steady(k: BucketKey, afterMs: number): boolean {
    const m = this.medians.medianFor(k)
    if (m === undefined || !(m > 0) || m >= afterMs) return false
    const need = this.config.cadence?.minSamples ?? DEFAULT_STALL_MIN_SAMPLES
    return this.medians.medianSamplesFor(k) >= need
  }

  private fire(kind: TriggerKind, st: TrackState, at: Mono, detail: string): void {
    // Both cooldowns are checked: per track, because one track flapping must not
    // monopolise the session's captures, and session-wide, because the ring is
    // session-wide and two dumps a moment apart carry the same window twice.
    if (this.cooldownMs > 0) {
      if (at - st.lastFireAt < this.cooldownMs || at - this.lastFireAt < this.cooldownMs) {
        this.suppressed++
        st.latched = true
        return
      }
    }
    // Unlatched, so the episode can still open a window once a dump can be
    // taken, if the gap is still open then.
    if (this.canFire !== undefined && !this.canFire(st.key)) return
    st.latched = true
    st.lastFireAt = at
    this.lastFireAt = at
    this.fires++
    this.onFire({ kind, atMono: at, key: st.key, detail })
  }

  private stateFor(k: BucketKey, at: Mono): TrackState | undefined {
    const id = bucketKeyString(k)
    const found = this.tracks.get(id)
    if (found !== undefined) return found
    if (this.tracks.size >= this.maxTracked && !this.evictLeastRecent()) return undefined
    const st: TrackState = {
      key: k,
      lastAt: at,
      latched: false,
      lastFireAt: Number.NEGATIVE_INFINITY,
    }
    this.tracks.set(id, st)
    return st
  }

  private evictLeastRecent(): boolean {
    let oldestId: string | undefined
    let oldestAt = Number.POSITIVE_INFINITY
    for (const [id, st] of this.tracks) {
      if (st.lastAt < oldestAt) {
        oldestAt = st.lastAt
        oldestId = id
      }
    }
    if (oldestId === undefined) return false
    this.tracks.delete(oldestId)
    this.evictedTracks++
    return true
  }
}

function describeGap(v: Verdict, gap: number): string {
  const g = Math.round(gap)
  const t = Math.round(v.threshold)
  return v.kind === 'cadence'
    ? `gap ${g}ms >= ${t}ms (multiple of the track's own median)`
    : `gap ${g}ms >= stall.afterMs ${t}ms`
}
