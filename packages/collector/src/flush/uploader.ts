import type { ClockSource, UploadOutcome } from '../types.js'
import { ClockSync } from './clock-sync.js'
import { deadlineSignal, sleepUntil } from './deadline.js'
import type { Chunk } from './idb.js'

/**
 * Chunked `fetch()` POSTs on every browser — no streaming request bodies, not
 * even as a Chromium fast path: two upload paths mean two backpressure
 * behaviours inside someone else's player, and the divergent one produces
 * Safari-only bug reports we cannot reproduce. Batches are already ~32 KB or
 * 60 s, so batch granularity paces congestion without streaming.
 *
 * Also runs the four-timestamp clock handshake — the only place that reads a
 * response, which `sendBeacon` cannot, so the offset is pinned here and
 * inherited by the beacon.
 */

/** The header carrying the edge's receive time (`t2`), in wall milliseconds. */
export const RECV_HEADER = 'x-moqtap-recv-ms'
/** The header carrying the edge's send time (`t3`), in wall milliseconds. */
export const SEND_HEADER = 'x-moqtap-send-ms'

export interface UploaderOptions {
  readonly endpoint: string
  readonly apiKey: string
  /** `Limits.uploadMaxAttempts`. Default 5. */
  readonly maxAttempts?: number
  /**
   * `Limits.uploadTimeoutMs` — how long one request may go unanswered before it
   * is abandoned. Default 10 s. `0` disables it, leaving a request to hang for
   * as long as the transport allows.
   */
  readonly timeoutMs?: number
  readonly fetchImpl?: typeof fetch
  /** Wall clock for `t1`/`t4`. Monotonic time is not comparable to the server's. */
  readonly clock?: ClockSource
  readonly sleep?: (ms: number) => Promise<void>
  readonly backoffMs?: (attempt: number) => number
  /** Share one across sessions to keep refining the offset. Default: private. */
  readonly clockSync?: ClockSync
  /**
   * How many exchanges to sample before pinning. Sampling starts on the first
   * upload of a session; the sample with the lowest round-trip delay wins.
   */
  readonly clockSamples?: number
  readonly headers?: Readonly<Record<string, string>>
  readonly onInternalError?: (err: unknown) => void
}

const DEFAULT_MAX_ATTEMPTS = 5
const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_CLOCK_SAMPLES = 3
const MAX_BACKOFF_MS = 30_000

/**
 * 4xx codes that are not the client's fault and do carry a retry: request
 * timeout, too-early, rate limiting. Every other 4xx is terminal — retrying
 * would repeat a rejection forever, and counting a drop beats spinning.
 */
const RETRYABLE_4XX = new Set([408, 425, 429])

const defaultBackoff = (attempt: number): number => {
  const base = Math.min(MAX_BACKOFF_MS, 500 * 2 ** attempt)
  // Jitter, because a relay that dropped every session's upload at once gets
  // every session's retry back at once without it.
  return Math.round(base * (0.75 + Math.random() * 0.5))
}

const platformClock: ClockSource = {
  now: () => performance.now(),
  wall: () => Date.now(),
}

const numberFrom = (v: string | null): number | undefined => {
  if (v === null) return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

export class Uploader {
  readonly #endpoint: string
  readonly #apiKey: string
  readonly #maxAttempts: number
  readonly #fetch: typeof fetch | undefined
  readonly #clock: ClockSource
  readonly #timeoutMs: number
  readonly #sleep: (ms: number, signal?: AbortSignal) => Promise<void>
  readonly #backoff: (attempt: number) => number
  readonly #sync: ClockSync
  readonly #clockSamples: number
  readonly #headers: Readonly<Record<string, string>>
  readonly #onError: ((err: unknown) => void) | undefined
  #terminalDrops = 0
  #retries = 0

  constructor(o: UploaderOptions) {
    this.#endpoint = o.endpoint
    this.#apiKey = o.apiKey
    this.#maxAttempts = Math.max(1, o.maxAttempts ?? DEFAULT_MAX_ATTEMPTS)
    this.#timeoutMs = Math.max(0, o.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    this.#fetch = o.fetchImpl ?? (globalThis as { fetch?: typeof fetch }).fetch
    this.#clock = o.clock ?? platformClock
    // `sleepUntil` takes the signal as a second argument and clears its own
    // timer; an injected one need not, and `#wait` races it either way.
    this.#sleep = o.sleep ?? sleepUntil
    this.#backoff = o.backoffMs ?? defaultBackoff
    this.#sync = o.clockSync ?? new ClockSync()
    this.#clockSamples = o.clockSamples ?? DEFAULT_CLOCK_SAMPLES
    this.#headers = o.headers ?? {}
    this.#onError = o.onInternalError
  }

  /** The pinned offset. The beacon path inherits it and never samples. */
  get clockOffsetMs(): number | undefined {
    return this.#sync.offsetMs
  }

  /** Round trip of the sample the offset came from — the offset's uncertainty. */
  get clockRttMs(): number | undefined {
    return this.#sync.bestRttMs
  }

  /** Chunks refused with a terminal status and dropped rather than retried. */
  get terminalDrops(): number {
    return this.#terminalDrops
  }

  get retries(): number {
    return this.#retries
  }

  /**
   * Send one sealed chunk. **Never throws into the caller** — a rejected
   * promise here would land in whatever the page is doing at the time.
   *
   * Retries transient failures with backoff up to `maxAttempts`; a terminal 4xx
   * is counted and reported so the caller deletes the chunk rather than keeping
   * a body ingest will always refuse.
   *
   * Every wait is bounded: each request carries `Limits.uploadTimeoutMs`, and
   * `signal` — the caller's overall deadline, `Limits.stopDrainDeadlineMs` for
   * `stop()` — ends the fetch, the backoff sleep and the retry loop together. A
   * deadline that expires returns a **non-terminal** failure, so the caller
   * keeps the chunk and it goes out on the next page load instead of being lost.
   */
  async send(c: Chunk, signal?: AbortSignal): Promise<UploadOutcome> {
    const doFetch = this.#fetch
    if (doFetch === undefined) {
      // No fetch at all: not transient, but not the chunk's fault either. The
      // caller keeps it, and the persistence is what makes that survivable.
      return { ok: false, terminal: false }
    }
    let lastStatus: number | undefined
    let delayMs = 0
    // A function, not `signal?.aborted` inline: the property is `readonly` and
    // the compiler will happily narrow it to `false` for the rest of the loop,
    // which would silently delete the second check.
    const outOfTime = (): boolean => signal?.aborted ?? false
    for (let attempt = 0; attempt < this.#maxAttempts; attempt += 1) {
      if (outOfTime()) break
      if (attempt > 0) {
        this.#retries += 1
        if (delayMs > 0) await this.#wait(delayMs, signal)
        if (outOfTime()) break
      }
      c.attempts += 1
      const t1 = this.#clock.wall()
      const deadline = deadlineSignal(this.#timeoutMs, signal)
      let res: Response
      try {
        res = await doFetch(this.#endpoint, {
          method: 'POST',
          headers: {
            // No `Content-Encoding`: gzip is declared by the body's own 8-byte
            // preamble, not by a header, because `sendBeacon` cannot set one and
            // both paths must produce a body ingest reads the same way.
            'content-type': 'application/octet-stream',
            authorization: `Bearer ${this.#apiKey}`,
            // the key, in a header as well as in the first frame, so ingest
            // can dedupe without decompressing.
            'idempotency-key': c.idempotencyKey,
            ...this.#headers,
          },
          body: c.bytes as unknown as BodyInit,
          ...(deadline.signal !== undefined ? { signal: deadline.signal } : {}),
        })
      } catch (err) {
        // Network failure, CORS refusal, timeout, abort. Transient by
        // assumption — a timed-out request must not be terminal, or the chunk
        // would be dropped for the endpoint's sins rather than kept.
        this.#onError?.(err)
        delayMs = this.#backoff(attempt)
        continue
      } finally {
        // The timer goes when the fetch settles, on every path out of the try:
        // a leaked timer per upload would just move the interference.
        deadline.clear()
      }
      const t4 = this.#clock.wall()
      lastStatus = res.status
      if (res.ok) {
        const serverWallMs = this.#note(res, t1, t4)
        return serverWallMs === undefined
          ? { ok: true, status: res.status, terminal: false }
          : { ok: true, status: res.status, terminal: false, serverWallMs }
      }
      if (res.status >= 400 && res.status < 500 && !RETRYABLE_4XX.has(res.status)) {
        this.#terminalDrops += 1
        return { ok: false, status: res.status, terminal: true }
      }
      // 5xx, or one of the retryable 4xx. `Retry-After` is the server telling us
      // what it wants; non-interference means we take the instruction rather than our own
      // backoff, since the server is the one under load.
      delayMs = this.#retryAfterMs(res) ?? this.#backoff(attempt)
    }
    return lastStatus === undefined
      ? { ok: false, terminal: false }
      : { ok: false, status: lastStatus, terminal: false }
  }

  /**
   * The backoff wait, bounded by the caller's deadline: without it a drain that
   * has already blown its deadline still sits out a 30 s backoff, and `stop()`
   * would be bounded on its fetches only. The injected `sleep` gets the signal
   * too ({@link sleepUntil} clears its own timer with it), but the race is what
   * makes the bound hold even when a test injects a one-argument fake.
   */
  async #wait(ms: number, signal: AbortSignal | undefined): Promise<void> {
    if (signal === undefined) {
      await this.#sleep(ms)
      return
    }
    if (signal.aborted) return
    await new Promise<void>((resolve) => {
      let done = false
      const finish = (): void => {
        if (done) return
        done = true
        signal.removeEventListener('abort', finish)
        resolve()
      }
      signal.addEventListener('abort', finish, { once: true })
      void this.#sleep(ms, signal).then(finish, finish)
    })
  }

  /** Fold this exchange into the clock estimate, and report the server's wall clock. */
  #note(res: Response, t1: number, t4: number): number | undefined {
    let t2: number | undefined
    let t3: number | undefined
    try {
      t2 = numberFrom(res.headers.get(RECV_HEADER))
      t3 = numberFrom(res.headers.get(SEND_HEADER))
      if (t2 === undefined || t3 === undefined) {
        // Fall back to the `Date` header, which every HTTP server sends. It is
        // one timestamp for both ends of the server's turnaround and has
        // one-second resolution, so it is a poor sample — which is exactly why
        // the lowest-RTT sample wins rather than the mean.
        const date = res.headers.get('date')
        const parsed = date === null ? Number.NaN : Date.parse(date)
        if (Number.isFinite(parsed)) {
          t2 = t2 ?? parsed
          t3 = t3 ?? parsed
        }
      }
    } catch (err) {
      this.#onError?.(err)
      return undefined
    }
    if (t2 === undefined || t3 === undefined) return undefined
    if (this.#sync.samples < this.#clockSamples) this.#sync.sample(t1, t2, t3, t4)
    return t3
  }

  #retryAfterMs(res: Response): number | undefined {
    try {
      const raw = res.headers.get('retry-after')
      if (raw === null) return undefined
      const seconds = Number(raw)
      if (Number.isFinite(seconds)) return Math.max(0, Math.min(MAX_BACKOFF_MS, seconds * 1000))
      const at = Date.parse(raw)
      if (!Number.isFinite(at)) return undefined
      return Math.max(0, Math.min(MAX_BACKOFF_MS, at - this.#clock.wall()))
    } catch (err) {
      this.#onError?.(err)
      return undefined
    }
  }
}
