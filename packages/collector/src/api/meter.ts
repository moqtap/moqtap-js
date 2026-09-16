/**
 * The collector meters itself, and its number is not the invoice: the billable
 * meter is what actually arrives at ingest. So {@link UsageReport.isEstimate} is
 * a literal `true` in the shared types and cannot be unset.
 *
 * Elevated time is counted in whole seconds, rounded down, with a one-second
 * minimum, and both halves are **per window** — which is what cannot be applied
 * to a session total afterwards: two 200 ms windows are two billable seconds,
 * not one, and ten 4.9 s windows are 40 s rather than the 49 a summed float
 * would report. So the quantity accrues one {@link billableSeconds} call per
 * window, as the window closes, and the raw millisecond total is kept beside it
 * for reporting only.
 *
 * While the device is asleep the rule is wall-clock elevated time, cross-checked
 * against the monotonic clock, with the smaller of the two counted and the
 * divergence reported. A suspended device is not doing anything the customer
 * would recognise as capture; the divergence is reported rather than hidden,
 * because a session that slept for an hour is a different session from one that
 * did not, and {@link UsageReport} would otherwise be quietly wrong in exactly
 * the case a customer would query.
 */

import type { ClockSource, DetailLevel, UsageReport } from '../types.js'
import { DETAIL_LEVELS, type Mono, type Wall } from '../types.js'
import { BASELINE, isElevated } from './defaults.js'

/**
 * Mono/wall divergence beyond which the device is taken to have slept.
 *
 * **Provenance: guess, pending field data**. It matches the rollup
 * module's own `SUSPEND_TOLERANCE_MS` so the two subsystems agree about what
 * "suspended" means; disagreeing would put a `suspended` flag on a rollup record
 * whose interval the meter had billed in full.
 */
export const SUSPEND_TOLERANCE_MS = 1_000

/**
 * The increment, applied to **one** window's measured length.
 *
 * Whole seconds, rounded down, with a one-second minimum. The caller decides
 * whether a window opened at all — "a window that never opened bills nothing" —
 * and this decides what an opened one costs, so a window that opened and closed
 * inside the same millisecond still bills the second it did the work of
 * opening.
 */
export function billableSeconds(windowMs: number): number {
  if (!Number.isFinite(windowMs)) return 1
  return Math.max(1, Math.floor(Math.max(0, windowMs) / 1000))
}

function emptyByLevel(): Record<DetailLevel, number> {
  const out = {} as Record<DetailLevel, number>
  for (const l of DETAIL_LEVELS) out[l] = 0
  return out
}

/**
 * The self-meter. One per collector, and the source of both `usage()` and the
 * `elevatedMinutesUsed` on every escalation record.
 */
export class UsageMeter {
  readonly #clock: ClockSource
  readonly #bytes: Record<DetailLevel, number> = emptyByLevel()

  #level: DetailLevel = BASELINE
  /** True while a window is accruing. Not `isElevated(#level)`: see {@link closeWindow}. */
  #open = false
  #sinceMono: Mono
  #sinceWall: Wall
  /** Whole seconds, per the increment, for windows that have closed. */
  #billableSec = 0
  /** The same windows unrounded. Reporting only — never the billed quantity. */
  #elevatedMs = 0
  #windowCount = 0
  #suspendedMs = 0

  constructor(clock: ClockSource) {
    this.#clock = clock
    this.#sinceMono = clock.now()
    this.#sinceWall = clock.wall()
  }

  /** The level time is currently accruing at. */
  get level(): DetailLevel {
    return this.#level
  }

  /**
   * Billable seconds so far, **including the open window**.
   *
   * A getter rather than a field because the ceiling check in `escalation.ts`
   * has to see the *current* window's time — a ceiling that only noticed on
   * transition would let a single unbroken elevated window run forever, which
   * is precisely the runaway the spend ceiling exists to prevent.
   *
   * The open window is billed by the same rule as a closed one, so a window
   * open for 200 ms already reads as its one-second minimum rather than
   * climbing through a fraction of a second nobody will ever be charged.
   */
  get billableSeconds(): number {
    return this.#billableSec + (this.#open ? billableSeconds(this.#openMs()) : 0)
  }

  /**
   * Measured elevated milliseconds, including the open window.
   *
   * **Not the billed quantity** — {@link UsageMeter.billableSeconds} is. This is
   * what the clocks actually saw, kept so that "elevated for 4.9 s, billed 4 s"
   * is answerable rather than a discrepancy nobody can reconstruct.
   */
  get elevatedMs(): number {
    return this.#elevatedMs + (this.#open ? this.#openMs() : 0)
  }

  /** Windows opened so far, the open one included. Diagnosis, not billing. */
  get windows(): number {
    return this.#windowCount
  }

  /** The billed quantity, in the unit the meter and the ceiling both use. */
  get elevatedMinutes(): number {
    return this.billableSeconds / 60
  }

  /** Milliseconds the device is believed to have been suspended while elevated. */
  get suspendedMs(): number {
    return this.#suspendedMs
  }

  /** Bytes sealed at each level, all levels including baseline. */
  bytesAt(level: DetailLevel): number {
    return this.#bytes[level]
  }

  /**
   * A sealed chunk's bytes, attributed to the level it was produced at.
   *
   * Attribution comes from `Chunk.level`, stamped by the flush queue at seal
   * time, rather than from the level now: a chunk sealed during a capture window
   * and uploaded after it closed is elevated volume, and reading the live level
   * at upload time would credit it to baseline.
   */
  noteBytes(level: DetailLevel, n: number): void {
    if (!(n > 0)) return
    const known = (DETAIL_LEVELS as readonly string[]).includes(level) ? level : BASELINE
    this.#bytes[known] += n
  }

  /**
   * Follow the dial.
   *
   * A window opens on the step **into** elevation and closes on the step out of
   * it; a move between two elevated levels leaves it open. `headers` →
   * `headers+sizes` → `baseline` inside one second is one window billing one
   * second, not two windows billing two — otherwise a caller changing their mind
   * would multiply the invoice by the per-window minimum, once per change.
   *
   * Idempotent for a no-change call, so a caller need not check first.
   */
  setLevel(next: DetailLevel): void {
    const was = this.#open
    const now = isElevated(next)
    this.#level = next
    if (was === now) return
    const nowMono = this.#clock.now()
    const nowWall = this.#clock.wall()
    if (was) {
      this.#accrue(nowMono, nowWall)
      return
    }
    this.#open = true
    this.#windowCount += 1
    this.#sinceMono = nowMono
    this.#sinceWall = nowWall
  }

  /**
   * Close the open window without moving the dial.
   *
   * Teardown calls this: after `stop()` the session is over, and a meter left
   * accruing makes `usage()` climb with wall time for as long as the page holds
   * a reference to it — on a session configured statically at `headers`,
   * forever. The level is left where it is, because the terminal record is
   * written after this and still has to say what the session ended at.
   */
  closeWindow(): void {
    if (!this.#open) return
    this.#accrue(this.#clock.now(), this.#clock.wall())
  }

  /**
   * The report `usage()` returns.
   *
   * `bytesPerElevatedMinute` is `0` when no elevated time has accrued rather
   * than `Infinity` or `NaN`: this number goes into a customer's own dashboard,
   * and a baseline-only session — the default, and the majority — must not
   * render as a divide-by-zero.
   */
  report(): UsageReport {
    const minutes = this.elevatedMinutes
    let elevatedBytes = 0
    for (const l of DETAIL_LEVELS) if (isElevated(l)) elevatedBytes += this.#bytes[l]
    return {
      bytesByLevel: { ...this.#bytes },
      elevatedSeconds: this.billableSeconds,
      elevatedMinutes: minutes,
      bytesPerElevatedMinute: minutes > 0 ? elevatedBytes / minutes : 0,
      isEstimate: true,
    }
  }

  /** Fold the open window into the totals and mark it closed. */
  #accrue(nowMono: Mono, nowWall: Wall): void {
    const mono = Math.max(0, nowMono - this.#sinceMono)
    const wall = Math.max(0, nowWall - this.#sinceWall)
    // Recorded once, as the window closes. Accruing it from the getters instead
    // grows `suspendedMs` by one divergence per *read*, and the ceiling check
    // reads on every tick.
    if (Math.abs(wall - mono) > SUSPEND_TOLERANCE_MS) this.#suspendedMs += Math.abs(wall - mono)
    const ms = Math.min(mono, wall)
    this.#elevatedMs += ms
    this.#billableSec += billableSeconds(ms)
    this.#open = false
  }

  #openMs(): number {
    return this.#sliceMs(this.#clock.now(), this.#clock.wall())
  }

  /**
   * The open window's length so far, in the smaller of the two clocks.
   *
   * The monotonic clock is authoritative for duration but stops or slows
   * on a suspended device on some platforms while the wall clock does not, so
   * the smaller value is what is billed. Both are floored at zero: a wall clock
   * corrected backwards mid-window must not produce negative elevated minutes.
   * Pure, because the getters above call it once per read and a read must not
   * move any counter.
   */
  #sliceMs(nowMono: Mono, nowWall: Wall): number {
    const mono = Math.max(0, nowMono - this.#sinceMono)
    const wall = Math.max(0, nowWall - this.#sinceWall)
    return Math.min(mono, wall)
  }
}
