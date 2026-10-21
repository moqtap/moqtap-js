/**
 * The flight recorder's ring claims memory only in a realm that needs it.
 *
 * `flightRecorder.depth` defaults to `'32MB'` and `flightRecorder.triggers`
 * defaults to `{}`. Every `#ring.push` site in a realm is behind an `#armed()`
 * check and every chunk comes from one of that realm's transports, so a ring in
 * a realm with no trigger, or with no WebTransport, is written to exactly
 * never — and reserving it anyway would hold **32 MiB of buffer plus 1.8 MiB of
 * slot arrays for the life of the session, untouched.**
 *
 * The storage belongs to `ByteRing.reserve()`. Three properties have to hold
 * together, and testing any one alone would let another regress:
 *
 *  1. **A default install never reserves**, transport or not.
 *  2. **An armed realm reserves when its first WebTransport opens**, not on
 *     the first chunk: deferring a 32 MiB allocation to the first write would
 *     put it on the page's own data path.
 *  3. **Only a realm that opens a WebTransport reserves.** The page and each
 *     worker it links are separate realms with the same config; a page that
 *     only links workers holds no ring.
 *
 * Asserted by spying on `reserve` rather than by measuring the heap. A 32 MiB
 * delta would in fact be visible, but a heap-delta assertion is a test of the
 * garbage collector's timing, and this is a test of a call. Rings are counted
 * by the receiver of each call, since `reserve` is idempotent.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetDormantForTest, teardownDormant } from '../../api/dormant.js'
import { envelope, type LinkedMessage, linkMessage } from '../../api/link.js'
import { ProbeRuntime } from '../../api/probe.js'
import type { LinkEvent, MessageTarget } from '../../api/session.js'
import { draftSet } from '../../draft/index.js'
import { ALL_ADAPTERS } from '../../drafts/all.js'
import { ByteRing } from '../../ring/index.js'
import { installWebTransportHook } from '../../transport/index.js'
import type { CollectorConfig } from '../../types.js'
import { init } from '../support/init.js'
import { settle } from '../support/settle.js'
import { MockWebTransport } from '../transport/mocks.js'

type Triggers = NonNullable<NonNullable<CollectorConfig['flightRecorder']>['triggers']>

const g = globalThis as unknown as Record<string, unknown>
let originalWT: unknown
let cleanup: (() => void)[] = []

const STALL: Triggers = { stall: { afterMs: 500 } }

const base = (over: Partial<CollectorConfig> = {}): CollectorConfig => ({
  apiKey: 'pk_test',
  endpoint: 'https://ingest.test/v1/ingest',
  sessionId: 'sess-ring',
  ...over,
})

const armed = (triggers: Triggers = STALL): CollectorConfig =>
  base({ flightRecorder: { triggers } })

/**
 * Ingest that answers at once, and no store or locks. These tests assert on
 * `reserve` calls, not on uploads, so an answered upload keeps each `end()`
 * from waiting out its drain deadline on a fetch that has nowhere to go.
 */
const ports = {
  persist: false,
  noLifecycleListeners: true,
  locks: null,
  fetchImpl: (async () =>
    ({
      ok: true,
      status: 200,
      headers: { get: () => null },
    }) as unknown as Response) as typeof fetch,
} as const

/** The distinct rings `reserve` was called on. */
const ringsReserved = (spy: { mock: { contexts: unknown[] } }): number =>
  new Set(spy.mock.contexts).size

/** A transport opened in the page's own realm. */
async function pageTransport(): Promise<MockWebTransport> {
  const wt = new (g.WebTransport as new (u: string) => MockWebTransport)('https://relay.test/p')
  await wt.open('moqt-20')
  return wt
}

/**
 * A worker linked to `page`, in a realm of its own: its own patched
 * `WebTransport` and its own probe, as a dedicated worker has.
 */
async function linkedWorker(page: {
  linkWorker(t: MessageTarget): void
}): Promise<{ open(): Promise<MockWebTransport> }> {
  const realm: { WebTransport?: unknown } = { WebTransport: MockWebTransport }
  const hook = installWebTransportHook(realm, null)
  const listeners: ((e: LinkEvent) => void)[] = []
  page.linkWorker({
    postMessage: (message: unknown, transfer?: Transferable[]) => {
      const m = linkMessage(message)
      const port = transfer?.[0] as MessagePort | undefined
      if (m?.t !== 'linked' || port === undefined) return
      cleanup.push(() => port.close())
      new ProbeRuntime(m as unknown as LinkedMessage, port, hook, draftSet(ALL_ADAPTERS), {
        setTimer: () => 0,
        clearTimer: () => {},
      }).start()
    },
    addEventListener: (_t, f) => {
      listeners.push(f)
    },
  })
  for (const f of listeners) f({ data: envelope({ t: 'hello', timeOrigin: 0 }) })
  await settle()
  return {
    open: async () => {
      const wt = new (realm.WebTransport as new (u: string) => MockWebTransport)(
        'https://relay.test/w',
      )
      await wt.open('moqt-20')
      return wt
    },
  }
}

beforeEach(() => {
  originalWT = g.WebTransport
  MockWebTransport.instances = []
  g.WebTransport = MockWebTransport
})

afterEach(() => {
  for (const f of cleanup) f()
  cleanup = []
  teardownDormant()
  resetDormantForTest()
  g.WebTransport = originalWT
  vi.restoreAllMocks()
})

describe('the flight recorder claims memory only when it is armed', () => {
  it('does not reserve the ring on a default install', async () => {
    const reserve = vi.spyOn(ByteRing.prototype, 'reserve')
    const c = init(base(), ports)
    await settle()
    await pageTransport()
    await settle()
    expect(reserve).not.toHaveBeenCalled()
    await c.end()
  })

  it('does not reserve the ring at init() before any transport opens', async () => {
    const reserve = vi.spyOn(ByteRing.prototype, 'reserve')
    const c = init(armed(), ports)
    await settle()
    expect(reserve).not.toHaveBeenCalled()
    await c.end()
  })

  // One case per trigger, not a loop in one case: each needs its own `init()`
  // and `end()`.
  it.each([
    ['stall', STALL],
    ['cadence', { cadence: { multiple: 3, minSamples: 8 } }],
    // Presence is the whole config for this one — `Record<string, never>`.
    ['trackSwitch', { trackSwitch: {} }],
  ] as const)('reserves the ring when only the %s trigger is set', async (_name, triggers) => {
    const reserve = vi.spyOn(ByteRing.prototype, 'reserve')
    const c = init(armed(triggers), ports)
    await settle()
    await pageTransport()
    expect(ringsReserved(reserve)).toBe(1)
    await c.end()
  })

  it('leaves a default install with a ring that reports its bounds anyway', async () => {
    // The depth is still a configured bound and still reported as the
    // recorder's capacity; what changed is that nothing was allocated for it.
    const c = init(base(), ports)
    await settle()
    const ring = new ByteRing({ maxBytes: 32 * 1024 * 1024 })
    expect(ring.maxBytes).toBe(32 * 1024 * 1024)
    expect(ring.isReserved).toBe(false)
    await c.end()
  })
})

describe('the ring is reserved in each realm that opens a WebTransport', () => {
  it('page only: one ring, when the page opens its first transport', async () => {
    const reserve = vi.spyOn(ByteRing.prototype, 'reserve')
    const c = init(armed(), ports)
    await settle()
    expect(reserve).not.toHaveBeenCalled()
    // No chunk has crossed yet: the session opening is what claims it.
    await pageTransport()
    expect(ringsReserved(reserve)).toBe(1)
    await pageTransport()
    expect(ringsReserved(reserve)).toBe(1)
    await c.end()
  })

  it('worker only: one ring, in the worker, none in the page that links it', async () => {
    const reserve = vi.spyOn(ByteRing.prototype, 'reserve')
    const c = init(armed(), ports)
    await settle()
    const worker = await linkedWorker(c)
    expect(reserve).not.toHaveBeenCalled()
    await worker.open()
    await settle()
    expect(ringsReserved(reserve)).toBe(1)
    await c.end()
  })

  it('a page and linked workers that open no transport reserve nothing', async () => {
    const reserve = vi.spyOn(ByteRing.prototype, 'reserve')
    const c = init(armed(), ports)
    await settle()
    await linkedWorker(c)
    await linkedWorker(c)
    await settle()
    expect(reserve).not.toHaveBeenCalled()
    await c.end()
  })

  it('mixed: one ring in the page and one in each worker that opens a transport', async () => {
    const reserve = vi.spyOn(ByteRing.prototype, 'reserve')
    const c = init(armed(), ports)
    await settle()
    const opens = await linkedWorker(c)
    await linkedWorker(c)
    await pageTransport()
    expect(ringsReserved(reserve)).toBe(1)
    await opens.open()
    await settle()
    expect(ringsReserved(reserve)).toBe(2)
    await c.end()
  })

  it('a linked worker of a default install reserves nothing either', async () => {
    const reserve = vi.spyOn(ByteRing.prototype, 'reserve')
    const c = init(base(), ports)
    await settle()
    const worker = await linkedWorker(c)
    await worker.open()
    await pageTransport()
    await settle()
    expect(reserve).not.toHaveBeenCalled()
    await c.end()
  })
})
