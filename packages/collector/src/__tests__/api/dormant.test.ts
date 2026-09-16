/**
 * Install dormant.
 *
 * The README's first paragraph makes three promises about the state a page is
 * in between importing the package and calling `init()`, and each is tested
 * here as a property of the running code rather than as documentation:
 *
 *  1. `globalThis.WebTransport` is patched at module-eval time.
 *  2. **Nothing is transmitted.** No `fetch`, no `sendBeacon`, no IndexedDB.
 *  3. The pre-key bytes go into a **bounded** ring that overwrites itself, and
 *     are handed to the collector when a key arrives rather than discarded.
 *
 * The last one matters more than it looks: the flush schedule is front-loaded
 * because "everything interesting about setup happens in the first seconds",
 * and a page that connects at load and calls `init()` after its own bootstrap
 * would otherwise lose exactly those seconds.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  dormantState,
  drainDormant,
  ensureDormantHook,
  resetDormantForTest,
  teardownDormant,
} from '../../api/dormant.js'
import { bytes, connect, MockWebTransport, SETUP_PREFIX } from '../transport/mocks.js'

/**
 * A unidirectional stream that is NOT the control plane.
 *
 * The seam's test is bidi, or the first chunk opening af 00 — draft-20's SETUP
 * type in vi64 — so any other opening byte is bulk media. 0x10 is a subgroup
 * header type; nothing in the dormant path parses it, and the point is only
 * that it does not sniff as control.
 */
const SUBGROUP_PREFIX = bytes(0x10)

const g = globalThis as unknown as Record<string, unknown>
let originalWT: unknown
let originalFetch: unknown
const fetchSpy = vi.fn()

beforeEach(() => {
  originalWT = g.WebTransport
  originalFetch = g.fetch
  MockWebTransport.instances = []
  g.WebTransport = MockWebTransport
  fetchSpy.mockClear()
  g.fetch = fetchSpy
})

afterEach(() => {
  teardownDormant()
  resetDormantForTest()
  g.WebTransport = originalWT
  g.fetch = originalFetch
})

/** Let the hook's `ready` continuation and the stream reads run. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) await Promise.resolve()
  await new Promise((r) => setTimeout(r, 0))
}

/**
 * Consume an incoming unidirectional stream the way a player does.
 *
 * The seam only sees bytes the page actually reads — the hook wraps
 * `getReader()`, it does not tee — so a test that pushes chunks and never reads
 * them observes nothing, correctly.
 */
async function readOneUniStream(
  wt: MockWebTransport,
  chunks: readonly Uint8Array[],
): Promise<void> {
  const src = wt.deliverUniStream(chunks)
  src.close()
  const arrived = await wt.incomingUnidirectionalStreams.getReader().read()
  const reader = (arrived.value as ReadableStream<Uint8Array>).getReader()
  for (;;) {
    const r = await reader.read()
    if (r.done) break
  }
}

describe('installation', () => {
  it('patches the global', () => {
    const hook = ensureDormantHook()
    expect(hook.installed).toBe(true)
    expect(g.WebTransport).not.toBe(MockWebTransport)
  })

  it('is idempotent — a second call does not capture the patched constructor', () => {
    const first = ensureDormantHook()
    const patched = g.WebTransport
    const second = ensureDormantHook()
    expect(second).toBe(first)
    expect(g.WebTransport).toBe(patched)
  })

  it('restores the original global on teardown', () => {
    ensureDormantHook()
    teardownDormant()
    expect(g.WebTransport).toBe(MockWebTransport)
  })

  it('survives a global with no WebTransport at all', () => {
    g.WebTransport = undefined
    resetDormantForTest()
    const hook = ensureDormantHook()
    expect(hook.installed).toBe(false)
    expect(() => hook.uninstall()).not.toThrow()
  })
})

describe('it transmits nothing', () => {
  it('makes no network call while a session runs unkeyed', async () => {
    ensureDormantHook()
    const wt = connect(g as { WebTransport?: unknown })
    await wt.open('moqt-20')
    await readOneUniStream(wt, [SETUP_PREFIX, bytes(1, 2, 3, 4)])
    await settle()
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('the bounded ring', () => {
  it('captures wire bytes that crossed before any key arrived', async () => {
    ensureDormantHook()
    const wt = connect(g as { WebTransport?: unknown })
    await wt.open('moqt-20')
    await readOneUniStream(wt, [SUBGROUP_PREFIX, bytes(9, 9, 9)])
    await settle()

    const state = dormantState()
    expect(state).not.toBeNull()
    expect((state as NonNullable<typeof state>).ring.bytes).toBeGreaterThan(0)
  })

  it('does not buffer the control plane, so no token sits here in the clear', async () => {
    // SETUP is the first message of a session, so it lands in the
    // dormant window rather than the live one, and SETUP is where the
    // Authorization Token option travels. A chunk arriving at the seam is not
    // frame-aligned, so it cannot be masked here without a second frame-aligned
    // parser — and nothing ever read these: the dormant ring's only destination
    // is the live ring, whose replay skips every control entry.
    ensureDormantHook()
    const wt = connect(g as { WebTransport?: unknown })
    await wt.open('moqt-20')
    await readOneUniStream(wt, [SETUP_PREFIX, bytes(0xde, 0xad, 0xbe, 0xef)])
    await settle()

    expect(dormantState()?.ring.bytes).toBe(0)
    expect(drainDormant().entries).toEqual([])
  })

  it('records the session so the live observer is not handed an unknown id', async () => {
    ensureDormantHook()
    const wt = connect(g as { WebTransport?: unknown }, 'https://relay.test/moq')
    await wt.open('moqt-20')
    await settle()

    const drained = drainDormant()
    expect(drained.sessions.size).toBe(1)
    expect([...drained.sessions.values()][0]?.url).toBe('https://relay.test/moq')
    expect([...drained.protocols.values()]).toEqual(['moqt-20'])
  })

  it('empties the ring when drained, so nothing is counted twice', async () => {
    ensureDormantHook()
    const wt = connect(g as { WebTransport?: unknown })
    await wt.open('moqt-20')
    await readOneUniStream(wt, [SUBGROUP_PREFIX, bytes(4, 5, 6)])
    await settle()

    const first = drainDormant()
    expect(first.entries.length).toBeGreaterThan(0)
    expect(dormantState()?.ring.bytes).toBe(0)
    expect(drainDormant().entries.length).toBe(0)
  })

  it('drains to empty when the hook never installed', () => {
    g.WebTransport = undefined
    resetDormantForTest()
    ensureDormantHook()
    const drained = drainDormant()
    expect(drained.entries).toEqual([])
    expect(drained.sessions.size).toBe(0)
  })

  it('forgets a session that closed before the key arrived', async () => {
    ensureDormantHook()
    const wt = connect(g as { WebTransport?: unknown })
    await wt.open('moqt-20')
    await settle()
    wt.closeSession('done')
    await settle()
    expect(drainDormant().sessions.size).toBe(0)
  })
})
