/**
 * The four-timestamp clock handshake.
 *
 * `t1` client send, `t2` edge receive, `t3` edge send, `t4` client receive:
 *
 * ```
 * offset = ((t2 − t1) + (t3 − t4)) / 2
 * delay  = (t4 − t1) − (t3 − t2)
 * ```
 *
 * Chosen over `cf.clientTcpRtt`, which is absent on HTTP/3 ("Only present when
 * the client connected over TCP"); this exchange needs no transport-specific
 * field, only that the client **reads the response** — true of `fetch()`, false
 * of `sendBeacon()`. So it runs on the upload path (see `uploader.ts`) and every
 * later beacon inherits the pinned offset without sampling.
 *
 * Keeping the lowest-delay sample rather than averaging is the standard NTP
 * trick: queueing delay is one-sided and unbounded above, so the mean of noisy
 * samples is biased and the minimum is not.
 */

/**
 * A pinned clock offset, refined by the lowest-round-trip sample seen.
 *
 * Never applies a correction: the device's wall clock is stored alongside the
 * offset, never instead of it, because someone comparing our timeline against
 * their own logs from the same de-synced device needs our uncorrected numbers
 * to line up with theirs. This class *reports* an offset and nothing else.
 */
export class ClockSync {
  #offsetMs: number | undefined
  #bestRttMs: number | undefined
  #samples = 0

  /**
   * Fold one exchange in. Ignores a sample that cannot be true — a non-finite
   * timestamp, or a negative round trip, which means one of the two clocks
   * stepped mid-exchange (`performance.now()` may not advance while the device
   * is suspended; `Date.now()` may jump when NTP corrects it).
   */
  sample(t1: number, t2: number, t3: number, t4: number): void {
    if (
      !Number.isFinite(t1) ||
      !Number.isFinite(t2) ||
      !Number.isFinite(t3) ||
      !Number.isFinite(t4)
    ) {
      return
    }
    const rtt = t4 - t1 - (t3 - t2)
    if (!(rtt >= 0)) return
    this.#samples += 1
    if (this.#bestRttMs === undefined || rtt < this.#bestRttMs) {
      this.#bestRttMs = rtt
      this.#offsetMs = (t2 - t1 + (t3 - t4)) / 2
    }
  }

  /** Estimated `serverWall − clientWall`. `undefined` until one sample lands. */
  get offsetMs(): number | undefined {
    return this.#offsetMs
  }

  /** The round trip of the sample the offset came from — its uncertainty. */
  get bestRttMs(): number | undefined {
    return this.#bestRttMs
  }

  /** How many usable exchanges have been folded in. */
  get samples(): number {
    return this.#samples
  }
}
