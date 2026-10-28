/**
 * The deadline primitive, and the two things it is easy to get wrong.
 *
 * > **Ingest being down, slow, or tarpitted must never affect the customer's
 * > playback or publishing.**
 *
 * The non-interference harness found the violation this module closes: `fetch` has no
 * timeout, so a blackholed endpoint pinned `stop()` forever. That is asserted
 * end to end in `../harness/non-interference.test.ts` against a real socket.
 * What is pinned down *here* is the mechanism, at millisecond timescales:
 *
 *  1. **The fallback is exercised.** `AbortSignal.timeout` is ~2023 (Safari
 *     16.4), and this package supports older engines. Node has it, so the
 *     fallback path would never run in CI unless a test takes it away — which
 *     is exactly how a fallback rots. One `stubGlobal` below runs every
 *     assertion against both implementations.
 *  2. **The timer is cleared.** A collector that claims non-interference and
 *     leaks a timer per upload has only moved the defect, and a leak is
 *     invisible in a passing suite. The proof used here is behavioural rather
 *     than a spy: after `clear()`, wait past the deadline and the signal must
 *     still not be aborted — which can only be true if the timer went.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { deadlineSignal, NO_DEADLINE, sleepUntil } from '../../flush/index.js'

const wait = (ms: number): Promise<void> =>
  new Promise((r) => {
    setTimeout(r, ms)
  })

/** Long enough for a timer to have fired if it was going to. */
const PAST_IT = 80
const SOON = 15

afterEach(() => {
  vi.unstubAllGlobals()
})

/**
 * Run a body twice: once as the platform provides `AbortSignal`, once with
 * `AbortSignal.timeout` removed so the raced-`AbortController` fallback runs.
 */
function bothImplementations(name: string, body: () => Promise<void>): void {
  it(`${name} (platform AbortSignal.timeout)`, body)
  it(`${name} (raced-AbortController fallback)`, async () => {
    const real = globalThis.AbortSignal
    // A stand-in with everything the module reads except `timeout`. `new
    // AbortController()` still hands back a real signal, so only the choice of
    // timer changes.
    const shim = Object.create(real) as typeof AbortSignal
    Object.defineProperty(shim, 'timeout', { value: undefined, configurable: true })
    vi.stubGlobal('AbortSignal', shim)
    expect((globalThis.AbortSignal as { timeout?: unknown }).timeout).toBeUndefined()
    await body()
  })
}

describe('deadlineSignal', () => {
  bothImplementations('aborts once the deadline passes', async () => {
    const d = deadlineSignal(SOON)
    expect(d.signal?.aborted).toBe(false)
    await wait(PAST_IT)
    expect(d.signal?.aborted).toBe(true)
    d.clear()
  })

  bothImplementations('clear() disarms it, so a settled request leaves no timer', async () => {
    const d = deadlineSignal(SOON)
    d.clear()
    await wait(PAST_IT)
    // If the timer had survived `clear()` it would have fired by now. This is
    // the leak assertion; there is no spy that would be more convincing.
    expect(d.signal?.aborted).toBe(false)
  })

  bothImplementations('clear() is idempotent', async () => {
    const d = deadlineSignal(SOON)
    d.clear()
    d.clear()
    await wait(PAST_IT)
    expect(d.signal?.aborted).toBe(false)
  })

  bothImplementations('an outer signal aborts it immediately', async () => {
    const outer = new AbortController()
    const d = deadlineSignal(60_000, outer.signal)
    expect(d.signal?.aborted).toBe(false)
    outer.abort(new Error('drain deadline'))
    expect(d.signal?.aborted).toBe(true)
    expect((d.signal?.reason as Error).message).toBe('drain deadline')
    d.clear()
  })

  bothImplementations('an already-aborted outer signal is honoured at construction', async () => {
    const outer = new AbortController()
    outer.abort()
    const d = deadlineSignal(60_000, outer.signal)
    expect(d.signal?.aborted).toBe(true)
    d.clear()
  })

  bothImplementations('clear() unsubscribes from the outer signal', async () => {
    const outer = new AbortController()
    const d = deadlineSignal(60_000, outer.signal)
    d.clear()
    outer.abort()
    expect(d.signal?.aborted).toBe(false)
  })

  it('owns nothing when asked for nothing', () => {
    expect(deadlineSignal(0)).toBe(NO_DEADLINE)
    expect(deadlineSignal(Number.POSITIVE_INFINITY)).toBe(NO_DEADLINE)
    expect(NO_DEADLINE.signal).toBeUndefined()
    // Still callable. A caller in a `finally` must not have to check.
    NO_DEADLINE.clear()
  })

  it('passes an outer signal through where the platform has no AbortController', () => {
    const outer = new globalThis.AbortController()
    vi.stubGlobal('AbortController', undefined)
    const d = deadlineSignal(SOON, outer.signal)
    // No engine has ever shipped `fetch` without `AbortController`, so this is
    // the branch where there is no upload to bound anyway. What must not happen
    // is the caller's own deadline being silently dropped.
    expect(d.signal).toBe(outer.signal)
    expect(deadlineSignal(SOON).signal).toBeUndefined()
  })
})

describe('sleepUntil', () => {
  it('resolves after the delay', async () => {
    const t0 = Date.now()
    await sleepUntil(SOON)
    expect(Date.now() - t0).toBeGreaterThanOrEqual(SOON - 5)
  })

  it('resolves early when the signal aborts, and does not wait out the backoff', async () => {
    const c = new AbortController()
    setTimeout(() => c.abort(), SOON)
    const t0 = Date.now()
    await sleepUntil(60_000, c.signal)
    // Without this the retry backoff would outlive `stop()`'s whole deadline,
    // and the bound would apply to the fetches only.
    expect(Date.now() - t0).toBeLessThan(2_000)
  })

  it('returns at once for a signal that has already aborted', async () => {
    const c = new AbortController()
    c.abort()
    const t0 = Date.now()
    await sleepUntil(60_000, c.signal)
    expect(Date.now() - t0).toBeLessThan(2_000)
  })
})
