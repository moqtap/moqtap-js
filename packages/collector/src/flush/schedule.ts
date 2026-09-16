import type { Mono, SealReason } from '../types.js'

/**
 * The sealing schedule, front-loaded then backing off: at `ready`, then +5 s,
 * +15 s, +45 s, then every 60 s or every 32 KB accumulated, whichever comes
 * first. Everything interesting about setup happens in the first seconds and a
 * session that dies during establishment must not be lost, while a steady
 * session carries almost no new information per interval — so a 12-hour channel
 * stays visible throughout and a crash loses at most 60 seconds.
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
  /** The front-loaded offsets from `ready`. Default `[5000, 15000, 45000]`. */
  readonly earlyFlushesMs?: readonly number[]
  /** The steady interval once the early phase is over. Default 60 000 ms. */
  readonly intervalMs?: number
  readonly timers?: TimerSource
  readonly onInternalError?: (err: unknown) => void
}

const DEFAULT_EARLY: readonly number[] = [5_000, 15_000, 45_000]
const DEFAULT_INTERVAL_MS = 60_000

const platformTimers: TimerSource = {
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (h) => {
    clearTimeout(h as ReturnType<typeof setTimeout>)
  },
}

export class FlushSchedule {
  readonly #onFlush: (reason: SealReason) => void
  readonly #onError: ((err: unknown) => void) | undefined
  readonly #threshold: number
  readonly #early: readonly number[]
  readonly #intervalMs: number
  readonly #timers: TimerSource

  #handles: unknown[] = []
  #intervalHandle: unknown
  #byteHandle: unknown
  #bytes = 0
  #started = false
  #stopped = false
  #startedAt: Mono = 0

  constructor(o: FlushScheduleOptions) {
    this.#onFlush = o.onFlush
    this.#onError = o.onInternalError
    this.#threshold = Math.max(1, o.byteThreshold)
    this.#early = (o.earlyFlushesMs ?? DEFAULT_EARLY).filter((n) => n > 0).sort((a, b) => a - b)
    this.#intervalMs = Math.max(1, o.intervalMs ?? DEFAULT_INTERVAL_MS)
    this.#timers = o.timers ?? platformTimers
  }

  /** Monotonic time the schedule was armed. Every offset below is relative to it. */
  get startedAt(): Mono {
    return this.#startedAt
  }

  /** Bytes accumulated since the last seal of any kind. */
  get pendingBytes(): number {
    return this.#bytes
  }

  /**
   * Arm the schedule, when the session is ready. The opening `ready` flush is
   * emitted on a zero-delay timer rather than synchronously, so `start()` never
   * re-enters its caller's stack.
   */
  start(nowMono: Mono): void {
    if (this.#started || this.#stopped) return
    this.#started = true
    this.#startedAt = nowMono
    this.#after(0, 'ready')
    for (const at of this.#early) this.#after(at, 'early')
    const lastEarly = this.#early.length > 0 ? (this.#early[this.#early.length - 1] as number) : 0
    this.#intervalHandle = this.#timers.setTimer(() => {
      this.#fire('interval')
      this.#rearmInterval()
    }, lastEarly + this.#intervalMs)
    this.#handles.push(this.#intervalHandle)
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
    if (!this.#started || this.#stopped || !(n > 0)) return
    this.#bytes += n
    if (this.#bytes < this.#threshold || this.#byteHandle !== undefined) return
    this.#byteHandle = this.#timers.setTimer(() => {
      this.#byteHandle = undefined
      this.#fire('bytes')
      // "every 60 s **or** every 32 KB accumulated, whichever comes first" —
      // a byte seal restarts the interval, or a session at the threshold would
      // seal twice in quick succession every minute.
      this.#rearmInterval()
    }, 0)
  }

  /** Idempotent. After this nothing fires, including timers already queued. */
  stop(): void {
    this.#stopped = true
    for (const h of this.#handles) this.#timers.clearTimer(h)
    this.#handles = []
    if (this.#byteHandle !== undefined) {
      this.#timers.clearTimer(this.#byteHandle)
      this.#byteHandle = undefined
    }
    this.#intervalHandle = undefined
  }

  #after(ms: number, reason: SealReason): void {
    const h = this.#timers.setTimer(() => this.#fire(reason), ms)
    this.#handles.push(h)
  }

  #rearmInterval(): void {
    if (this.#stopped) return
    if (this.#intervalHandle !== undefined) {
      this.#timers.clearTimer(this.#intervalHandle)
      this.#handles = this.#handles.filter((h) => h !== this.#intervalHandle)
    }
    this.#intervalHandle = this.#timers.setTimer(() => {
      this.#fire('interval')
      this.#rearmInterval()
    }, this.#intervalMs)
    this.#handles.push(this.#intervalHandle)
  }

  #fire(reason: SealReason): void {
    if (this.#stopped) return
    // Every seal empties the buffer, so the byte budget restarts whatever the
    // reason was.
    this.#bytes = 0
    try {
      this.#onFlush(reason)
    } catch (err) {
      this.#onError?.(err)
    }
  }
}
