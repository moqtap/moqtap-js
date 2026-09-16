/**
 * The one place a deadline is turned into an `AbortSignal`.
 *
 * `fetch` has no timeout. A blackholed or tarpitted endpoint accepts the socket
 * and answers nobody, so a request against one stays pending for the life of
 * the page — and `CollectorRuntime.stop()` awaits that request, which would
 * hang the teardown of someone else's video player. The end-to-end assertion
 * lives in `src/__tests__/harness/non-interference.test.ts`.
 *
 * Two deadlines, deliberately **one mechanism** rather than two racing timers:
 *
 *  - `Limits.uploadTimeoutMs` bounds one request. A timed-out request is
 *    *transient*, so it retries and the chunk stays queued.
 *  - `Limits.stopDrainDeadlineMs` bounds the whole of `stop()`'s drain, because
 *    `uploadMaxAttempts` requests at `uploadTimeoutMs` each plus backoff is
 *    minutes. `stop()` makes one signal and {@link Uploader.send} composes it
 *    with its own per-request timer, so the fetch and the backoff sleep between
 *    attempts both end when it fires.
 *
 * {@link Deadline.clear} is idempotent, runs in a `finally`, removes every
 * listener it added and clears its own `setTimeout` — a leaked timer per upload
 * would just move the interference. `AbortSignal.timeout` is used where the
 * platform has it (Safari shipped it in 16.4 and this package supports older),
 * and the fallback is an `AbortController` raced by a timer of our own.
 */

import { MQ5002 } from '../codes.js'

const noop = (): void => {}

export interface Deadline {
  /**
   * Hand to `fetch`. `undefined` only where the platform has no
   * `AbortController` at all, in which case there was nothing to compose.
   */
  readonly signal: AbortSignal | undefined
  /** Idempotent. Call it when the guarded operation settles, in a `finally`. */
  clear(): void
}

/** A deadline that never fires and owns nothing. */
export const NO_DEADLINE: Deadline = /*#__PURE__*/ Object.freeze({ signal: undefined, clear: noop })

/**
 * A signal that aborts after `ms`, or as soon as `outer` does, whichever is
 * first.
 *
 * `ms <= 0` or a non-finite `ms` means "no timer of my own", which is how a
 * caller asks for nothing but the composition with `outer`.
 */
export function deadlineSignal(ms: number, outer?: AbortSignal): Deadline {
  const g = globalThis as {
    AbortController?: typeof AbortController
    AbortSignal?: typeof AbortSignal & { timeout?: (ms: number) => AbortSignal }
  }
  const Controller = g.AbortController
  const timed = Number.isFinite(ms) && ms > 0
  if (Controller === undefined) {
    // No `AbortController` means no `fetch` either — they shipped together on
    // every engine — so this is the branch where the upload is not happening
    // anyway. `outer` is passed through rather than silently dropped.
    return outer === undefined ? NO_DEADLINE : { signal: outer, clear: noop }
  }
  if (!timed && outer === undefined) return NO_DEADLINE

  const ctl = new Controller()
  const undo: (() => void)[] = []

  if (outer !== undefined) {
    if (outer.aborted) {
      ctl.abort(outer.reason)
    } else {
      const onOuter = (): void => ctl.abort(outer.reason)
      outer.addEventListener('abort', onOuter, { once: true })
      undo.push(() => outer.removeEventListener('abort', onOuter))
    }
  }

  if (timed && !ctl.signal.aborted) {
    const platform = g.AbortSignal?.timeout
    if (typeof platform === 'function') {
      // Held by the closures below for as long as the deadline lives: Node's
      // implementation keeps only a weak reference to the signal it returns, so
      // dropping it here would be a timer that may never fire.
      const t = platform.call(g.AbortSignal, ms)
      const onTimeout = (): void => ctl.abort(t.reason)
      t.addEventListener('abort', onTimeout, { once: true })
      undo.push(() => t.removeEventListener('abort', onTimeout))
    } else {
      const id = setTimeout(() => {
        ctl.abort(new Error(`${MQ5002}: ${ms}`))
      }, ms)
      // Node only; a browser's handle is a number. A deadline must never be the
      // reason a process or a test runner refuses to exit.
      ;(id as unknown as { unref?: () => void }).unref?.()
      undo.push(() => clearTimeout(id))
    }
  }

  let cleared = false
  return {
    signal: ctl.signal,
    clear: (): void => {
      if (cleared) return
      cleared = true
      for (const f of undo) f()
      undo.length = 0
    },
  }
}

/**
 * Resolve when `ms` has passed or when `signal` aborts, whichever is first.
 *
 * The backoff sleep between upload attempts goes through here. Without it a
 * drain that has already blown its deadline still sits out a 30 s backoff, and
 * the deadline would be a deadline on the fetches only rather than on `stop()`.
 * The timer is cleared on either path.
 */
export function sleepUntil(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) return Promise.resolve()
  return new Promise<void>((resolve) => {
    let done = false
    let id: ReturnType<typeof setTimeout> | undefined
    const finish = (): void => {
      if (done) return
      done = true
      if (id !== undefined) clearTimeout(id)
      signal?.removeEventListener('abort', finish)
      resolve()
    }
    id = setTimeout(finish, ms)
    signal?.addEventListener('abort', finish, { once: true })
  })
}
