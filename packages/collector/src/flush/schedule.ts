import { DEFAULT_UPLOAD } from '../api/defaults.js'
import type { Mono, SealReason } from '../types.js'

/**
 * The sealing schedule, front-loaded then backing off: at `ready`, then +45 s,
 * then every 60 s or every 32 KB accumulated, whichever comes first. The
 * `ready` seal carries setup and the handshake, so a session that dies during
 * establishment is not lost, and +45 s lands its first rollups before the
 * steady interval. A steady session carries little new information per
 * interval, so there is one early seal, not several. No gap between seals
 * exceeds 60 s, so a 12-hour channel stays visible throughout and a crash loses
 * at most 60 seconds.
 *
 * Decides only when a chunk is *sealed*, never when it is released — that is
 * `pacer.ts`. If pressure could stretch the sealing interval, the "at most 60
 * seconds" bound would fail exactly when congestion makes a crash likely.
 *
 * Timers are injected so the schedule can be tested as the state machine it is,
 * without fake timers or wall-clock sleeps in the suite.
 */

/** The timer surface the schedule needs. Defaults to the platform's. */
export interface TimerSource {
  setTimer(fn: () => void, ms: number): unknown
  clearTimer(handle: unknown): void
}

export interface FlushScheduleOptions {
  /**
   * Called with the reason a seal is due. Must not throw; a throw here is the
   * schedule's own failure path and is routed to `onInternalError`.
   */
  readonly onFlush: (reason: SealReason) => void
  /** The 32 KB. A byte count, so `Limits.flushByteThreshold` carries it. */
  readonly byteThreshold: number
  /** The front-loaded offsets from `ready`. Default `DEFAULT_UPLOAD.earlyFlushesMs`. */
  readonly earlyFlushesMs?: readonly number[]
  /** The steady interval once the early phase is over. Default `DEFAULT_UPLOAD.intervalMs`. */
  readonly intervalMs?: number
  readonly timers?: TimerSource
  readonly onInternalError?: (err: unknown) => void
}

const platformTimers: TimerSource = {
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (h) => {
    clearTimeout(h as ReturnType<typeof setTimeout>)
  },
}

export class FlushSchedule {
  private readonly _onFlush: (reason: SealReason) => void
  private readonly _onError: ((err: unknown) => void) | undefined
  private readonly _threshold: number
  private readonly _early: readonly number[]
  private readonly _intervalMs: number
  private readonly _timers: TimerSource

  private _handles: unknown[] = []
  private _intervalHandle: unknown
  private _byteHandle: unknown
  /** A shorter interval ingest asked for, until its timer ends it. */
  private _shortMs: number | undefined
  private _shortHandle: unknown
  private _bytes = 0
  private _started = false
  private _stopped = false
  private _readied = false
  private _startedAt: Mono = 0

  constructor(o: FlushScheduleOptions) {
    this._onFlush = o.onFlush
    this._onError = o.onInternalError
    this._threshold = Math.max(1, o.byteThreshold)
    this._early = (o.earlyFlushesMs ?? DEFAULT_UPLOAD.earlyFlushesMs)
      .filter((n) => n > 0)
      .sort((a, b) => a - b)
    this._intervalMs = Math.max(1, o.intervalMs ?? DEFAULT_UPLOAD.intervalMs)
    this._timers = o.timers ?? platformTimers
  }

  /** Monotonic time the schedule was armed. Every offset below is relative to it. */
  get startedAt(): Mono {
    return this._startedAt
  }

  /** Bytes accumulated since the last seal of any kind. */
  get pendingBytes(): number {
    return this._bytes
  }

  /**
   * Arm the schedule. The opening `ready` flush is emitted on a zero-delay
   * timer rather than synchronously, so `start()` never re-enters its caller's
   * stack.
   */
  start(nowMono: Mono): void {
    if (this._started || this._stopped) return
    this._started = true
    this._arm(nowMono)
  }

  /**
   * The first session's draft is known, so there is a setup record to send.
   * Seals now and counts the early flushes from here rather than from
   * `start()`, which may have run long before the player connected. Once.
   */
  ready(nowMono: Mono): void {
    if (!this._started || this._stopped || this._readied) return
    this._readied = true
    for (const h of this._handles) this._timers.clearTimer(h)
    this._handles = []
    this._intervalHandle = undefined
    this._arm(nowMono)
  }

  private _arm(nowMono: Mono): void {
    this._startedAt = nowMono
    this._after(0, 'ready')
    for (const at of this._early) this._after(at, 'early')
    const lastEarly = this._early.length > 0 ? (this._early[this._early.length - 1] as number) : 0
    this._intervalHandle = this._timers.setTimer(() => {
      this._fire('interval')
      this._rearmInterval()
    }, lastEarly + this._intervalMs)
    this._handles.push(this._intervalHandle)
  }

  /**
   * Report bytes added to the flush buffer. Crossing the threshold seals, but
   * on a zero-delay timer, never inside the caller: a record and the raw frame
   * that describes it are written as a synchronous pair ({@link RecordSink.raw}:
   * "MUST be preceded by its describing JSON record in the same body"), so a
   * seal firing inside `noteBytes` could split the pair across two POSTs and
   * leave the raw frame unreadable.
   */
  noteBytes(n: number): void {
    if (!this._started || this._stopped || !(n > 0)) return
    this._bytes += n
    if (this._bytes < this._threshold || this._byteHandle !== undefined) return
    this._byteHandle = this._timers.setTimer(() => {
      this._byteHandle = undefined
      this._fire('bytes')
      // "every 60 s **or** every 32 KB accumulated, whichever comes first" —
      // a byte seal restarts the interval, or a session at the threshold would
      // seal twice in quick succession every minute.
      this._rearmInterval()
    }, 0)
  }

  /**
   * Seal every `ms` for the next `forMs`, then go back to the configured
   * interval. Asked again, it holds until the later end; asked for a different
   * interval, it starts over on it. Never longer than the configured interval.
   */
  shorten(ms: number, forMs: number): void {
    if (!this._started || this._stopped || !(ms > 0) || !(forMs > 0)) return
    const next = Math.min(ms, this._intervalMs)
    if (this._shortHandle !== undefined) this._timers.clearTimer(this._shortHandle)
    this._shortHandle = this._timers.setTimer(() => {
      this._shortHandle = undefined
      this._shortMs = undefined
      this._rearmInterval()
    }, forMs)
    if (next === this._shortMs) return
    this._shortMs = next
    this._rearmInterval()
  }

  /** Idempotent. After this nothing fires, including timers already queued. */
  stop(): void {
    this._stopped = true
    for (const h of this._handles) this._timers.clearTimer(h)
    this._handles = []
    if (this._shortHandle !== undefined) {
      this._timers.clearTimer(this._shortHandle)
      this._shortHandle = undefined
    }
    if (this._byteHandle !== undefined) {
      this._timers.clearTimer(this._byteHandle)
      this._byteHandle = undefined
    }
    this._intervalHandle = undefined
  }

  private _after(ms: number, reason: SealReason): void {
    const h = this._timers.setTimer(() => this._fire(reason), ms)
    this._handles.push(h)
  }

  private _rearmInterval(): void {
    if (this._stopped) return
    if (this._intervalHandle !== undefined) {
      this._timers.clearTimer(this._intervalHandle)
      this._handles = this._handles.filter((h) => h !== this._intervalHandle)
    }
    this._intervalHandle = this._timers.setTimer(() => {
      this._fire('interval')
      this._rearmInterval()
    }, this._shortMs ?? this._intervalMs)
    this._handles.push(this._intervalHandle)
  }

  private _fire(reason: SealReason): void {
    if (this._stopped) return
    // Every seal empties the buffer, so the byte budget restarts whatever the
    // reason was.
    this._bytes = 0
    try {
      this._onFlush(reason)
    } catch (err) {
      this._onError?.(err)
    }
  }
}
