import type { BatchClock } from '../types.js'

/**
 * The device's wall clock against ingest's, from the four-timestamp exchange
 * every `fetch()` upload makes: `t1` device send, `t2` ingest receive, `t3`
 * ingest send, `t4` device receive.
 *
 * ```
 * offset = ((t2 − t1) + (t3 − t4)) / 2
 * delay  = (t4 − t1) − (t3 − t2)
 * ```
 */

/** The assumed drift between the device and ingest clocks: 100 ppm. */
export const DRIFT = 100e-6

/** How long a sample stays a candidate, ms. */
export const CLOCK_WINDOW_MS = 10 * 60 * 1000

/**
 * How far wall minus monotonic time moves with neither clock stepping, ms:
 * `Date.now()` reads whole milliseconds, and so may a coarsened
 * `performance.now()`.
 */
export const CLOCK_TICK_MS = 2

interface Sample {
  /** Offset, ms. */
  readonly o: number
  /** Round trip, ms. */
  readonly r: number
  /** Monotonic time at `t4`, ms. */
  readonly m: number
}

/**
 * The samples of the last ten minutes. A body carries the one with the
 * smallest bound `rtt / 2 + DRIFT × age`.
 */
export class ClockSync {
  private _samples: Sample[] = []
  /** Wall minus monotonic time when last checked, and the monotonic time of that check. */
  private _anchor: { readonly skew: number; readonly mono: number } | undefined

  /**
   * Fold one exchange in, with monotonic time read at `t4`. A sample that
   * cannot be true (non-finite, or a negative round trip) is ignored.
   */
  sample(t1: number, t2: number, t3: number, t4: number, mono: number): void {
    if (![t1, t2, t3, t4, mono].every(Number.isFinite)) return
    this._step(t4, mono)
    const r = t4 - t1 - (t3 - t2)
    if (!(r >= 0)) return
    this._samples.push({ o: (t2 - t1 + (t3 - t4)) / 2, r, m: mono })
    this._expire(mono)
  }

  /** The clock for a body sealed now, or `undefined` with no usable sample. */
  best(wall: number, mono: number): BatchClock | undefined {
    this._step(wall, mono)
    this._expire(mono)
    let best: Sample | undefined
    let bound = Number.POSITIVE_INFINITY
    for (const s of this._samples) {
      const b = s.r / 2 + DRIFT * Math.max(0, mono - s.m)
      if (b < bound) {
        best = s
        bound = b
      }
    }
    if (best === undefined) return undefined
    return {
      o: round3(best.o),
      r: round3(best.r),
      n: this._samples.length,
      a: round3(Math.max(0, mono - best.m) / 1000),
    }
  }

  /** Samples in the window. */
  get samples(): number {
    return this._samples.length
  }

  /**
   * A wall-clock step empties the window: wall minus monotonic time moving by
   * more than the best round trip, {@link CLOCK_TICK_MS} and the drift since.
   */
  private _step(wall: number, mono: number): void {
    const skew = wall - mono
    const a = this._anchor
    if (a !== undefined) {
      let bestRtt = Number.POSITIVE_INFINITY
      for (const s of this._samples) bestRtt = Math.min(bestRtt, s.r)
      const allowed = bestRtt + CLOCK_TICK_MS + DRIFT * Math.abs(mono - a.mono)
      if (Math.abs(skew - a.skew) > allowed) this._samples = []
    }
    this._anchor = { skew, mono }
  }

  private _expire(mono: number): void {
    const s = this._samples
    while (s.length > 0 && mono - s[0]!.m > CLOCK_WINDOW_MS) s.shift()
  }
}

/** To 0.001, halves away from zero. */
function round3(v: number): number {
  return (Math.sign(v) * Math.round(Math.abs(v) * 1000)) / 1000 || 0
}
