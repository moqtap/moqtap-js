/**
 * The detail dial: the one place `_level` is written. Every change emits an
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
 * | the page reloading or unloading, or the session ending | `session.ts`, through {@link EscalationController.unload} and {@link EscalationController.close} |
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
 *
 * A **remote** window is one ingest asked for, for a capture window someone
 * opened on the session's release, user or content. It ends at the time it was
 * asked for, and `resolve()` leaves it alone: the page's incident being over
 * says nothing about the capture someone else is running. Unload, the ceiling
 * and a manual `escalate()` end it as they end any window.
 *
 * A **hold** is ingest keeping the session at `baseline` until a time it names,
 * once the workspace's recording minutes for the month are used up. Like the
 * ceiling it is baseline literally: it ends any open window, remote ones
 * included, and every raise is refused while it lasts. Unlike the ceiling it
 * ends, and the session returns to its configured level.
 */

import type {
  BucketKey,
  ClockAnchor,
  ClockSource,
  DetailLevel,
  EscalationRecord,
  Mono,
  RecordSink,
  TriggerKind,
  WindowClose,
} from '../types.js'
import { bucketKeyString, bucketKeyWire } from '../types.js'
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
  | { readonly kind: 'hold' }
  | { readonly kind: 'remote'; readonly reason?: string }
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
   * {@link EscalationController.capped} changed. A linked worker raises its own
   * level on a trigger before the page has answered, so it has to know
   * beforehand whether the page would refuse the raise.
   */
  readonly onCapChange?: (capped: boolean) => void
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
  /** Ingest asked for it; `deadline` is the end it asked for. */
  readonly remote?: true
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
  return { kind: 'trigger', trigger: by.trigger, key: bucketKeyWire(by.key) }
}

export class EscalationController {
  private readonly _o: EscalationControllerOptions
  private _level: DetailLevel
  /** The open capture window, or `undefined` when the level is at the configured floor. */
  private _window: OpenWindow | undefined
  private _ceilingHit = false
  /** The end of ingest's hold on the page's clock, or `undefined` when none is in force. */
  private _holdUntil: Mono | undefined
  private _refused = 0
  private _elevations = 0
  /** {@link capped} as `onCapChange` last reported it. */
  private _capReported = false

  constructor(o: EscalationControllerOptions) {
    this._o = o
    this._level = o.configured
    o.meter.setLevel(o.configured)
  }

  get level(): DetailLevel {
    return this._level
  }

  /** True while a capture window is open — i.e. while the dial sits above `configured`. */
  get windowOpen(): boolean {
    return this._window !== undefined
  }

  /** True once the customer's own ceiling has been reached at least once. */
  get ceilingReached(): boolean {
    return this._ceilingHit
  }

  /**
   * True while every raise is refused: a hold is in force, or the ceiling has
   * been reached.
   */
  get capped(): boolean {
    return this._ceilingHit || this._held()
  }

  /** The end of the hold in force. `undefined`: none is. */
  get holdUntil(): Mono | undefined {
    return this._held() ? this._holdUntil : undefined
  }

  /** Elevations refused at the ceiling or under a hold. Counted, never silent. */
  get refused(): number {
    return this._refused
  }

  /** Accepted elevations, session-lifetime. Feeds `usage()`. */
  get elevations(): number {
    return this._elevations
  }

  /**
   * A manual `escalate()`. Also the way *down*: `escalate('baseline')` is the
   * customer's toggle closing their own window, recorded like any other change.
   */
  escalate(to: DetailLevel, reason?: string): void {
    this._apply(to, reason === undefined ? { kind: 'manual' } : { kind: 'manual', reason })
    // A manual raise is the customer's own toggle and is not on a timer,
    // and it takes over a window a trigger opened rather than opening a second
    // one: an automatic deadline may not close a window a person deliberately
    // reached into, and the ring may not either.
    const w = this._window
    if (w !== undefined) {
      this._window = { openedMono: w.openedMono, deadline: undefined, ringEvictedAtOpen: undefined }
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
    if (this._window === undefined || this._window.remote === true) return
    this._apply(
      this._o.configured,
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
    if (this._window === undefined) return
    this._apply(this._o.configured, { kind: 'window', closed: 'unload' })
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
    if (levelIndex(this._level) >= levelIndex(TRIGGER_CAPTURE_LEVEL)) return
    const cause: EscalationCause =
      key === undefined
        ? { kind: 'trigger', trigger: kind }
        : { kind: 'trigger', trigger: kind, key }
    const opened = this._apply(TRIGGER_CAPTURE_LEVEL, cause)
    const w = this._window
    if (!opened || w === undefined) return
    const deadline = atMono + this._o.windowMs
    this._window = {
      openedMono: w.openedMono,
      deadline,
      ringEvictedAtOpen: this._o.ring?.evictedBytes(),
    }
    this._o.onWindowOpen?.(deadline)
  }

  /**
   * Ingest asked for detail raised to `to` until `deadlineMono`.
   *
   * Asked again while its window is open, as it is on every upload, it holds
   * until the later end. A level the session already sits at or above, by its
   * configuration or a window the page or a trigger opened, is left as it is.
   * The ceiling refuses it like any other raise.
   */
  remote(to: DetailLevel, deadlineMono: Mono, reason?: string): void {
    if (levelIndex(to) <= levelIndex(BASELINE)) return
    const w = this._window
    if (w?.remote === true && levelIndex(this._level) >= levelIndex(to)) {
      if (w.deadline !== undefined && deadlineMono > w.deadline) {
        this._window = { ...w, deadline: deadlineMono }
        this._o.onWindowOpen?.(deadlineMono)
      }
      return
    }
    if (levelIndex(this._level) >= levelIndex(to)) return
    const opened = this._apply(
      to,
      reason === undefined || reason === '' ? { kind: 'remote' } : { kind: 'remote', reason },
    )
    const now = this._window
    if (!opened || now === undefined) return
    this._window = {
      openedMono: now.openedMono,
      deadline: deadlineMono,
      ringEvictedAtOpen: undefined,
      remote: true,
    }
    this._o.onWindowOpen?.(deadlineMono)
  }

  /**
   * Ingest asked for detail kept at `baseline` until `untilMono`.
   *
   * Asked again, as it is on every upload, the latest answer stands. A raised
   * level is lowered by `tick`, so a window open now ends at the next interval.
   */
  hold(untilMono: Mono): void {
    this._holdUntil = untilMono
    this._noteCap()
  }

  /**
   * Time passed.
   *
   * Four jobs that must run on a timer rather than on a transition: the
   * post-event timeout, the ring the window was opened to explain filling, the
   * ceiling, which has to be able to fire *during* an unbroken elevated window,
   * and ingest's hold, which lowers a level raised before it arrived. A ceiling checked only on a level change would never fire on the one
   * shape it exists to stop — a session that escalated once and stayed there.
   */
  tick(nowMono: Mono): void {
    this._enforceCeiling()
    this._enforceHold(nowMono)
    this._noteCap()
    const w = this._window
    if (w === undefined || !isElevated(this._level)) return
    // Neither condition is a person, so both are `window` closes, not `manual`;
    // `closed` says which of the two ended it.
    if (this._ringFilled(w)) {
      this._apply(this._o.configured, { kind: 'window', closed: 'ring' })
      return
    }
    if (w.deadline !== undefined && nowMono >= w.deadline) {
      this._apply(this._o.configured, { kind: 'window', closed: 'timeout' })
    }
  }

  /**
   * Close any open window at teardown, and stop the meter.
   *
   * The session ending is the instance going away, as an unload is, so the
   * close is recorded as one: nobody chose it. A level held below the
   * configured one stays there, since teardown is no reason to raise.
   *
   * The meter is closed explicitly rather than left to the level change: on a
   * session configured statically at `headers` the dial never leaves elevation,
   * so nothing else would end the window and `usage()` would climb with wall
   * time for as long as the page held a reference to it.
   */
  close(): void {
    if (this._window !== undefined) {
      this._apply(this._o.configured, { kind: 'window', closed: 'unload' })
    }
    this._window = undefined
    this._o.meter.closeWindow()
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
  private _ringFilled(w: OpenWindow): boolean {
    const ring = this._o.ring
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
  private _enforceCeiling(): void {
    const ceiling = this._o.ceilingMinutes
    if (!(ceiling > 0)) return
    if (this._o.meter.elevatedMinutes < ceiling) return
    if (!this._ceilingHit) {
      this._ceilingHit = true
      this._window = undefined
      if (isElevated(this._level)) this._apply(BASELINE, { kind: 'ceiling' })
    }
  }

  /**
   * Down to baseline while the hold lasts; back to the configured level once
   * it ends, unless the ceiling has since been reached.
   */
  private _enforceHold(nowMono: Mono): void {
    const until = this._holdUntil
    if (until === undefined) return
    if (nowMono < until) {
      if (isElevated(this._level)) this._apply(BASELINE, { kind: 'hold' })
      return
    }
    this._holdUntil = undefined
    if (!this._ceilingHit && this._window === undefined) {
      this._apply(this._o.configured, { kind: 'hold' })
    }
  }

  private _held(): boolean {
    return this._holdUntil !== undefined && this._o.clock.now() < this._holdUntil
  }

  private _noteCap(): void {
    const capped = this.capped
    if (capped === this._capReported) return
    this._capReported = capped
    this._o.onCapChange?.(capped)
  }

  /** The one place `_level` is written. Returns whether anything changed. */
  private _apply(to: DetailLevel, by: EscalationCause): boolean {
    if (levelIndex(to) < 0) return false
    // A raise past a reached ceiling or under a hold is refused and counted,
    // never silent, and not recorded as an escalation, because it did not happen.
    if (this.capped && levelIndex(to) > levelIndex(BASELINE)) {
      this._refused += 1
      return false
    }
    if (to === this._level) return false

    const from = this._level
    this._level = to
    this._o.meter.setLevel(to)
    if (levelIndex(to) > levelIndex(from)) this._elevations += 1

    // The window is the period above the configured floor. Opened here, with no
    // deadline and no ring mark: `onTrigger` adds both to the window it opened,
    // and a manual raise gets neither.
    if (levelIndex(to) > levelIndex(this._o.configured)) {
      this._window ??= {
        openedMono: this._o.clock.now(),
        deadline: undefined,
        ringEvictedAtOpen: undefined,
      }
    } else {
      this._window = undefined
    }

    const record: EscalationRecord = {
      t: 'escalation',
      ts: this._o.clock.now() - this._o.anchor.originMono,
      // The level the raise moved TO, so the record that opens a window is
      // attributed to that window rather than to the level it left.
      lvl: to,
      from,
      to,
      by: toWireCause(by),
      elevatedMinutesUsed: this._o.meter.elevatedMinutes,
      ceilingMinutes: this._o.ceilingMinutes,
    }
    this._o.sink.json(record)
    this._o.onLevelChange?.(to)
    return true
  }
}

/** A bucket key in its canonical string form, for messages naming a trigger's track. */
export function describeKey(k: BucketKey): string {
  return bucketKeyString(k)
}
