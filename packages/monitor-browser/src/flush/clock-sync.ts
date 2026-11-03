/**
 * The device's monotonic clock against ingest's, from four-timestamp
 * exchanges: `t1` device send and `t4` device receive on the monotonic clock,
 * `t2` ingest receive and `t3` ingest send on ingest's.
 *
 * ```
 * offset = ((t2 − t1) + (t3 − t4)) / 2    (server − mono)
 * delay  = (t4 − t1) − (t3 − t2)
 * ```
 *
 * Every body carries the epoch's latest sample; the backend chooses among
 * them. A clock break, `wall − mono` jumping by more than {@link B_BREAK_US}
 * beyond what tick and drift explain, raises the epoch and drops every
 * sample: the monotonic clock may have stopped while the device slept. Wall
 * time only detects a break; it never maps a time.
 */

/** The assumed drift between the device and ingest clocks: 100 ppm. */
export const DRIFT = 100e-6

/** A `wall − mono` jump past tick and drift above this is a clock break, µs. */
export const B_BREAK_US = 10_000

/** `Date.now()` reads whole milliseconds. */
const WALL_TICK_US = 1_000

/**
 * The resolution reported before any two distinct clock reads were seen: an
 * upper bound on every coarsened `performance.now()`.
 */
export const RES_UNKNOWN_US = 1_000_000

/** Reads the resolution spin makes at most. */
const RES_SPIN_READS = 20_000

export interface ClockSample {
  /** Server − mono, µs. */
  readonly oUs: number
  /** Round trip, µs. */
  readonly rUs: number
  /** Mono µs at `t4`. */
  readonly atUs: number
  /** The ingest PoP that stamped `t2`/`t3`. */
  readonly pop?: string
}

const POP = /^[A-Za-z0-9-]{1,16}$/

/** The break check alone: what a worker's probe runs on its own captures. */
export class BreakCheck {
  protected _resUs = RES_UNKNOWN_US
  /** Wall − mono at the last check, µs, and the mono time of that check. */
  private _last: { readonly skew: number; readonly mono: number } | undefined
  private _lastMono: number | undefined

  /** The smallest non-zero tick seen, µs: never below the clock's true resolution. */
  get resUs(): number {
    return this._resUs
  }

  /**
   * Check a captured time: `wall` and `mono` ms read together. True when
   * `wall − mono` moved by more than tick, drift and {@link B_BREAK_US} since
   * the last check: the caller seals, then raises the epoch.
   */
  check(wall: number, mono: number): boolean {
    this._tick(mono)
    const skew = (wall - mono) * 1000
    const last = this._last
    this._last = { skew, mono }
    if (last === undefined) return false
    const allowed =
      WALL_TICK_US + this._resUs + DRIFT * Math.abs(mono - last.mono) * 1000 + B_BREAK_US
    return Math.abs(skew - last.skew) > allowed
  }

  /** A distinct read narrows the resolution: two distinct reads differ by a tick at least. */
  protected _tick(mono: number, prev = this._lastMono): void {
    this._lastMono = mono
    if (prev === undefined || mono === prev) return
    const d = Math.ceil(Math.abs(mono - prev) * 1000 - 1e-6)
    if (d >= 1 && d < this._resUs) this._resUs = d
  }
}

export class ClockSync extends BreakCheck {
  private _epoch = 0
  private _latest: ClockSample | undefined

  /** Raised at every clock break. */
  get epoch(): number {
    return this._epoch
  }

  /** The epoch's latest sample, or `undefined` when it has none yet. */
  latest(): ClockSample | undefined {
    return this._latest
  }

  /**
   * Fold one exchange in: `t1`, `t4` monotonic ms, `t2`, `t3` ingest ms.
   * `epoch` is the epoch at `t1`; an exchange that spans a break is dropped,
   * as is one that cannot be true.
   */
  sample(t1: number, t2: number, t3: number, t4: number, epoch: number, pop?: string | null): void {
    if (![t1, t2, t3, t4].every(Number.isFinite) || epoch !== this._epoch) return
    const r = t4 - t1 - (t3 - t2)
    if (!(r >= 0)) return
    const o = (t2 - t1 + (t3 - t4)) / 2
    this._latest = {
      oUs: Math.floor(o * 1000),
      rUs: Math.round(r * 1000),
      atUs: Math.floor(t4 * 1000),
      ...(pop != null && POP.test(pop) ? { pop } : {}),
    }
  }

  /** A break: a new epoch, with no sample until an exchange completes. */
  raise(): void {
    this._epoch += 1
    this._latest = undefined
  }

  /** Read the clock until it ticks twice, a bounded number of times. */
  measure(now: () => number): void {
    let prev = now()
    let changes = 0
    for (let i = 0; i < RES_SPIN_READS && changes < 2; i++) {
      const v = now()
      if (v !== prev) {
        this._tick(v, prev)
        prev = v
        changes += 1
      }
    }
  }
}
