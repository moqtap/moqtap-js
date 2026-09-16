/**
 * The detail dial: the one place `#level` is written. Every change emits an
 * {@link EscalationRecord} carrying `by` — manual with the caller's reason, or
 * the trigger kind and the track it fired on.
 *
 * A **capture window** is the period the level sits above the session's
 * configured floor — above the floor, not above baseline, because
 * `detail: 'headers'` is a whole-session setting and closing the window back to
 * baseline would silently un-configure it.
 *
 * Four things close a window, and only four:
 *
 * | closes on | here |
 * | --- | --- |
 * | the application calling `resolve()` | {@link EscalationController.resolve} |
 * | the ring filling | {@link EscalationControllerOptions.ring}, checked in `tick` |
 * | the page reloading or unloading | `session.ts`, on `pagehide`, through `resolve()` |
 * | the post-event timeout elapsing | `flightRecorder.windowMs`, checked in `tick` |
 *
 * There is deliberately no "the fault recovered" close. That is a player-level
 * judgement and the collector lacks the player's semantics — it sees objects
 * arriving, not a rebuffer ending — so it would close early on a stall still
 * happening and hold open through one that had ended.
 *
 * The timeout and the ring bound only *trigger*-opened windows: a manual
 * `escalate()` is the customer's own toggle, which no automatic deadline may
 * end, and the ring is the flight recorder's axis, which a manual raise never
 * reads.
 */

import type {
  BucketKey,
  ClockAnchor,
  ClockSource,
  DetailLevel,
  EscalationRecord,
  Mono,
  RecordSink,
  RollupTrackWire,
  TriggerKind,
  WindowClose,
} from '../types.js'
import { bucketKeyString } from '../types.js'
import { BASELINE, isElevated, levelIndex } from './defaults.js'
import type { UsageMeter } from './meter.js'

/**
 * The level a fired trigger raises to. A guess, pending field data: nothing
 * names it, and `headers` is the lowest level that ships anything a trigger's
 * dump can be read against.
 *
 * The next level up is not a guess: `headers+data` carries the customer's end
 * users' media content, SPEC requires it be off by default, and no automatic
 * mechanism may cross it on its own.
 */
export const TRIGGER_CAPTURE_LEVEL: DetailLevel = 'headers'

/** What raised or lowered the dial. Mirrors {@link EscalationRecord.by}. */
export type EscalationCause =
  | { readonly kind: 'manual'; readonly reason?: string }
  | { readonly kind: 'trigger'; readonly trigger: TriggerKind; readonly key?: BucketKey }
  | { readonly kind: 'ceiling' }
  | { readonly kind: 'window'; readonly closed: WindowClose; readonly reason?: string }

/**
 * "The ring filling", as the two numbers deciding it needs.
 *
 * Not the `ByteRing` itself: this module has no business reaching into the
 * recorder's buffer, and a session that never armed the recorder supplies no
 * ring at all — which is why the condition then never fires.
 */
export interface RingPressure {
  /** The ring's whole configured depth in bytes (`flightRecorder.depth`). */
  readonly capacityBytes: number
  /** Bytes evicted under overwrite pressure, monotonic for the ring's life. */
  evictedBytes(): number
}

export interface EscalationControllerOptions {
  /** `CollectorConfig.detail` — where the session sits with nothing raising it. */
  readonly configured: DetailLevel
  readonly ceilingMinutes: number
  /** How long a *trigger*-opened window stays elevated. Manual windows ignore it. */
  readonly windowMs: number
  readonly meter: UsageMeter
  readonly clock: ClockSource
  readonly anchor: ClockAnchor
  readonly sink: RecordSink
  /** The flight recorder's ring, when one is armed. Absent means the ring never closes a window. */
  readonly ring?: RingPressure
  /** Called after every accepted change, so the session can re-level its writers. */
  readonly onLevelChange?: (level: DetailLevel) => void
  /**
   * A trigger window opened and closes at `deadlineMono` unless something else
   * closes it first.
   *
   * `tick()` is driven by the rollup interval, which defaults to 10 s and is a
   * customer setting, so on its own it would close a 15 s window at 20 s. The
   * session answers by scheduling a one-shot `tick` on the deadline. Optional:
   * `tick()` alone is sufficient for correctness, this only lands on time.
   */
  readonly onWindowOpen?: (deadlineMono: Mono) => void
}

/** An open capture window. Present exactly while the level is above `configured`. */
interface OpenWindow {
  readonly openedMono: Mono
  /** The post-event timeout. `undefined` on a manual window, which has no event. */
  readonly deadline: Mono | undefined
  /** `RingPressure.evictedBytes()` when the window opened. `undefined`: not ring-bounded. */
  readonly ringEvictedAtOpen: number | undefined
}

function wireKey(k: BucketKey): RollupTrackWire['key'] {
  return { d: k.dir, k: k.kind, v: k.id.toString(), e: k.epoch }
}

/**
 * A cause, with the bucket key reduced to its wire form.
 *
 * `EscalationRecord.by` carries `RollupTrackWire['key']`, whose `v` is the id as
 * a **decimal string**: the id is a bigint and `JSON.stringify` throws on one,
 * while a `number` would silently lose precision past 2^53.
 */
function toWireCause(by: EscalationCause): EscalationRecord['by'] {
  if (by.kind !== 'trigger') return by
  if (by.key === undefined) return { kind: 'trigger', trigger: by.trigger }
  return { kind: 'trigger', trigger: by.trigger, key: wireKey(by.key) }
}

export class EscalationController {
  readonly #o: EscalationControllerOptions
  #level: DetailLevel
  /** The open capture window, or `undefined` when the level is at the configured floor. */
  #window: OpenWindow | undefined
  #ceilingHit = false
  #refused = 0
  #elevations = 0

  constructor(o: EscalationControllerOptions) {
    this.#o = o
    this.#level = o.configured
    o.meter.setLevel(o.configured)
  }

  get level(): DetailLevel {
    return this.#level
  }

  /** True while a capture window is open — i.e. while the dial sits above `configured`. */
  get windowOpen(): boolean {
    return this.#window !== undefined
  }

  /** True once the customer's own ceiling has been reached at least once. */
  get ceilingReached(): boolean {
    return this.#ceilingHit
  }

  /** Elevations refused because the ceiling had been reached. Counted, never silent. */
  get refused(): number {
    return this.#refused
  }

  /** Accepted elevations, session-lifetime. Feeds `usage()` and the terminal record. */
  get elevations(): number {
    return this.#elevations
  }

  /**
   * A manual `escalate()`. Also the way *down*: `escalate('baseline')` is the
   * customer's toggle closing their own window, recorded like any other change.
   */
  escalate(to: DetailLevel, reason?: string): void {
    this.#apply(to, reason === undefined ? { kind: 'manual' } : { kind: 'manual', reason })
    // A manual raise is the customer's own toggle and is not on a timer,
    // and it takes over a window a trigger opened rather than opening a second
    // one: an automatic deadline may not close a window a person deliberately
    // reached into, and the ring may not either.
    const w = this.#window
    if (w !== undefined) {
      this.#window = { openedMono: w.openedMono, deadline: undefined, ringEvictedAtOpen: undefined }
    }
  }

  /**
   * The application says the incident is over.
   *
   * The **primary** way a window closes; the post-event timeout is the backstop
   * for a developer who never calls this. Returns the dial to the configured
   * level, so a session running statically at `headers` is not silently
   * un-configured by an error handler.
   *
   * **A no-op when no window is open**, deliberately not a throw: this is called
   * from `catch` blocks and `onerror` handlers, often more than once per
   * incident and often for one that never escalated. A debugging tool that threw
   * out of an error handler would replace the customer's fault with its own.
   */
  resolve(reason?: string): void {
    if (this.#window === undefined) return
    this.#apply(
      this.#o.configured,
      reason === undefined
        ? { kind: 'window', closed: 'resolve' }
        : { kind: 'window', closed: 'resolve', reason },
    )
  }

  /**
   * The page is going away. Its own entry point rather than a `resolve()` with a
   * magic string, so the record's `closed` field can say which one it was.
   */
  unload(): void {
    if (this.#window === undefined) return
    this.#apply(this.#o.configured, { kind: 'window', closed: 'unload' })
  }

  /**
   * A trigger fired: open a capture window.
   *
   * The flight-recorder dump is this window's first record rather than a
   * separate event — it covers the moments before the window opened — so the
   * caller fires the recorder and calls this in the same turn.
   *
   * A trigger only ever raises. Dropping a session already at `headers+sizes`
   * to {@link TRIGGER_CAPTURE_LEVEL} would lower detail in the middle of the
   * incident, and under the window rule could close a window a person opened.
   */
  onTrigger(kind: TriggerKind, atMono: Mono, key?: BucketKey): void {
    if (levelIndex(this.#level) >= levelIndex(TRIGGER_CAPTURE_LEVEL)) return
    const cause: EscalationCause =
      key === undefined
        ? { kind: 'trigger', trigger: kind }
        : { kind: 'trigger', trigger: kind, key }
    const opened = this.#apply(TRIGGER_CAPTURE_LEVEL, cause)
    const w = this.#window
    if (!opened || w === undefined) return
    const deadline = atMono + this.#o.windowMs
    this.#window = {
      openedMono: w.openedMono,
      deadline,
      ringEvictedAtOpen: this.#o.ring?.evictedBytes(),
    }
    this.#o.onWindowOpen?.(deadline)
  }

  /**
   * Time passed.
   *
   * Three jobs that must run on a timer rather than on a transition: the
   * post-event timeout, the ring the window was opened to explain filling, and
   * the ceiling, which has to be able to fire *during* an unbroken elevated
   * window. A ceiling checked only on a level change would never fire on the one
   * shape it exists to stop — a session that escalated once and stayed there.
   */
  tick(nowMono: Mono): void {
    this.#enforceCeiling()
    const w = this.#window
    if (w === undefined || !isElevated(this.#level)) return
    // Neither condition is a person, so both are `window` closes, not `manual`;
    // `closed` says which of the two ended it.
    if (this.#ringFilled(w)) {
      this.#apply(this.#o.configured, { kind: 'window', closed: 'ring' })
      return
    }
    if (w.deadline !== undefined && nowMono >= w.deadline) {
      this.#apply(this.#o.configured, { kind: 'window', closed: 'timeout' })
    }
  }

  /**
   * Return to the configured level at teardown, and stop the meter.
   *
   * The meter is closed explicitly rather than left to the level change: on a
   * session configured statically at `headers` the dial never leaves elevation,
   * so nothing else would end the window and `usage()` would climb with wall
   * time for as long as the page held a reference to it.
   */
  close(): void {
    this.#window = undefined
    if (this.#level !== this.#o.configured) this.#apply(this.#o.configured, { kind: 'manual' })
    this.#o.meter.closeWindow()
  }

  /**
   * "The ring filling", measured from the moment the window opened.
   *
   * The ring is a fixed-size overwrite buffer, so "full" is not a state it has;
   * turnover is. Once it has evicted its whole capacity since the window opened,
   * nothing it held when the trigger fired survives, and the reason for holding
   * the window open has gone. The bound is one turnover of the ring's own
   * `flightRecorder.depth`, so there is no new threshold to name.
   */
  #ringFilled(w: OpenWindow): boolean {
    const ring = this.#o.ring
    if (ring === undefined || w.ringEvictedAtOpen === undefined) return false
    if (!(ring.capacityBytes > 0)) return false
    return ring.evictedBytes() - w.ringEvictedAtOpen >= ring.capacityBytes
  }

  /**
   * On reaching the ceiling, fall back to baseline, **record it**, and
   * keep collecting.
   *
   * Baseline literally, not the configured level: the ceiling is denominated in
   * elevated minutes, and returning to a configured level that is itself
   * elevated would leave the meter running past it. Baseline is the only level
   * that stops the meter, so a session configured statically at
   * `detail: 'headers'` drops to baseline on reaching its ceiling — recorded, so
   * it is visible rather than mysterious.
   */
  #enforceCeiling(): void {
    const ceiling = this.#o.ceilingMinutes
    if (!(ceiling > 0)) return
    if (this.#o.meter.elevatedMinutes < ceiling) return
    if (!this.#ceilingHit) {
      this.#ceilingHit = true
      this.#window = undefined
      if (isElevated(this.#level)) this.#apply(BASELINE, { kind: 'ceiling' })
    }
  }

  /** The one place `#level` is written. Returns whether anything changed. */
  #apply(to: DetailLevel, by: EscalationCause): boolean {
    if (levelIndex(to) < 0) return false
    // A raise past a reached ceiling is refused and counted, never silent, and
    // not recorded as an escalation, because it did not happen.
    if (this.#ceilingHit && levelIndex(to) > levelIndex(BASELINE)) {
      this.#refused += 1
      return false
    }
    if (to === this.#level) return false

    const from = this.#level
    this.#level = to
    this.#o.meter.setLevel(to)
    if (levelIndex(to) > levelIndex(from)) this.#elevations += 1

    // The window is the period above the configured floor. Opened here, with no
    // deadline and no ring mark: `onTrigger` adds both to the window it opened,
    // and a manual raise gets neither.
    if (levelIndex(to) > levelIndex(this.#o.configured)) {
      this.#window ??= {
        openedMono: this.#o.clock.now(),
        deadline: undefined,
        ringEvictedAtOpen: undefined,
      }
    } else {
      this.#window = undefined
    }

    const record: EscalationRecord = {
      t: 'escalation',
      ts: this.#o.clock.now() - this.#o.anchor.originMono,
      // The level the raise moved TO, so the record that opens a window is
      // attributed to that window rather than to the level it left.
      lvl: to,
      from,
      to,
      by: toWireCause(by),
      elevatedMinutesUsed: this.#o.meter.elevatedMinutes,
      ceilingMinutes: this.#o.ceilingMinutes,
    }
    this.#o.sink.json(record)
    this.#o.onLevelChange?.(to)
    return true
  }
}

/** Exported for the terminal record's `detail` string on a trigger event. */
export function describeKey(k: BucketKey): string {
  return bucketKeyString(k)
}
