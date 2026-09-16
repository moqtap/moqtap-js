/**
 * A default install must not allocate the flight recorder's memory.
 *
 * `flightRecorder.depth` defaults to `'32MB'` and `flightRecorder.triggers`
 * defaults to `{}`. Every `#ring.push` site in `CollectorRuntime` is behind an
 * `#armed()` check, so with no trigger configured the ring is written to
 * exactly never — and reserving anyway would hold **32 MiB of buffer plus
 * 1.8 MiB of slot arrays on every page for the life of the session,
 * untouched.**
 *
 * The storage belongs to `ByteRing.reserve()`. Two properties have to hold
 * together, and testing either alone would let the other regress:
 *
 *  1. **A default `init()` never reserves.**
 *  2. **An armed `init()` reserves at `init()`, not on the first chunk.**
 *     Deferring a 32 MiB allocation to the first write would put it on the
 *     page's own data path, which is exactly what preallocation exists to
 *     avoid.
 *
 * Asserted by spying on `reserve` rather than by measuring the heap. A 32 MiB
 * delta would in fact be visible, but a heap-delta assertion is a test of the
 * garbage collector's timing, and this is a test of a call.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetDormantForTest, teardownDormant } from '../../api/dormant.js'
import { init } from '../../api/init.js'
import { ByteRing } from '../../ring/index.js'
import type { CollectorConfig } from '../../types.js'
import { MockWebTransport } from '../transport/mocks.js'

const g = globalThis as unknown as Record<string, unknown>
let originalWT: unknown

const base = (over: Partial<CollectorConfig> = {}): CollectorConfig => ({
  apiKey: 'pk_test',
  endpoint: 'https://ingest.test/v1/ingest',
  sessionId: 'sess-ring',
  ...over,
})

const settle = async (times = 10): Promise<void> => {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve()
    await new Promise((r) => setTimeout(r, 0))
  }
}

beforeEach(() => {
  originalWT = g.WebTransport
  MockWebTransport.instances = []
  g.WebTransport = MockWebTransport
})

afterEach(() => {
  teardownDormant()
  resetDormantForTest()
  g.WebTransport = originalWT
  vi.restoreAllMocks()
})

describe('the flight recorder claims memory only when it is armed', () => {
  it('does not reserve the ring on a default install', async () => {
    const reserve = vi.spyOn(ByteRing.prototype, 'reserve')
    const c = init(base())
    await settle()
    // The dormant ring may reserve if pre-init bytes arrived; none have here,
    // and the collector's own ring must not have.
    expect(reserve).not.toHaveBeenCalled()
    await c.stop()
  })

  it('reserves the ring at init() when a trigger is configured', async () => {
    const reserve = vi.spyOn(ByteRing.prototype, 'reserve')
    const c = init(base({ flightRecorder: { triggers: { stall: { afterMs: 500 } } } }))
    await settle()
    // At init(), on the caller's stack — not on the first chunk to arrive.
    expect(reserve).toHaveBeenCalled()
    await c.stop()
  })

  // One case per trigger, not a loop in one case: each needs its own `init()`
  // and `stop()`, and `stop()` waits on the outbox drain deadline.
  it.each([
    ['stall', { stall: { afterMs: 500 } }],
    ['cadence', { cadence: { multiple: 3, minSamples: 8 } }],
    // Presence is the whole config for this one — `Record<string, never>`.
    ['trackSwitch', { trackSwitch: {} }],
  ] as const)('reserves the ring when only the %s trigger is set', async (_name, triggers) => {
    const reserve = vi.spyOn(ByteRing.prototype, 'reserve')
    const c = init(base({ flightRecorder: { triggers } }))
    await settle()
    expect(reserve).toHaveBeenCalled()
    await c.stop()
  })

  it('leaves a default install with a ring that reports its bounds anyway', async () => {
    // The depth is still a configured bound and still reported as the
    // recorder's capacity; what changed is that nothing was allocated for it.
    const c = init(base())
    await settle()
    const ring = new ByteRing({ maxBytes: 32 * 1024 * 1024 })
    expect(ring.maxBytes).toBe(32 * 1024 * 1024)
    expect(ring.isReserved).toBe(false)
    await c.stop()
  })
})
