/**
 * A second `init()` in the same page.
 *
 * A single-page application that tears down and re-creates its player — a route
 * change, a channel switch, a consent flow that `abort()`s and later re-inits —
 * calls `init()` twice against one document. `stop()` and `abort()` both restore
 * the original global, and `ensureDormantHook` re-installs rather than binding
 * to a global that is no longer patched.
 *
 * What makes that fragile: `CollectorRuntime.#teardown` calls `hook.uninstall()`
 * directly, which restores the page's own constructor and flips the hook's
 * `live` flag. A dormant module singleton still holding that dead hook would
 * hand it to the second `init()`, whose `setObserver` would be a no-op, and the
 * transport the second run opened would never be wrapped — a session reporting
 * a setup record and a terminal record, both from the API surface, and nothing
 * in between: no draft, no rollup, because the decoder never saw a byte.
 *
 * The assertions here are therefore about the *second* run; the first is
 * present only to establish that the difference is the re-init and not the
 * fixture.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ConfigProblem } from '../../api/config.js'
import {
  dormantState,
  ensureDormantHook,
  resetDormantForTest,
  teardownDormant,
} from '../../api/dormant.js'
import { init } from '../../api/init.js'
import { BODY_PREAMBLE_BYTES, readFrames, readPreamble } from '../../envelope/index.js'
import type { CollectorConfig, EnvelopeRecord, RollupTrackWire } from '../../types.js'
import { subgroupBytes } from '../decode/vectors.js'
import { MockWebTransport } from '../transport/mocks.js'

const g = globalThis as unknown as Record<string, unknown>
let originalWT: unknown

function recordingFetch(): { posts: Uint8Array[]; impl: typeof fetch } {
  const posts: Uint8Array[] = []
  const impl = (async (_url: string, init: RequestInit) => {
    posts.push(new Uint8Array(init.body as unknown as ArrayBufferLike as never))
    return { ok: true, status: 200, headers: { get: () => null } } as unknown as Response
  }) as unknown as typeof fetch
  return { posts, impl }
}

async function recordsOf(body: Uint8Array): Promise<EnvelopeRecord[]> {
  const pre = readPreamble(body)
  let frames = body.subarray(BODY_PREAMBLE_BYTES)
  if ((pre as { gzipped: boolean }).gzipped) {
    const ds = new DecompressionStream('gzip')
    const out = new Response(new Blob([frames as unknown as BlobPart]).stream().pipeThrough(ds))
    frames = new Uint8Array(await out.arrayBuffer())
  }
  const decoder = new TextDecoder()
  const out: EnvelopeRecord[] = []
  for (const f of readFrames(frames)) {
    if (!f.raw) out.push(JSON.parse(decoder.decode(f.payload)) as EnvelopeRecord)
  }
  return out
}

const settle = async (times = 40): Promise<void> => {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve()
    await new Promise((r) => setTimeout(r, 0))
  }
}

const base = (over: Partial<CollectorConfig> = {}): CollectorConfig => ({
  apiKey: 'pk_test',
  endpoint: 'https://ingest.test/v1/ingest',
  // Pinned, so the decoder chunk is loaded eagerly and no dynamic import races
  // the first frames.
  drafts: [20],
  metrics: { intervalMs: 100 },
  ...over,
})

/**
 * One session's worth of traffic, opened through whatever is on the global.
 *
 * Constructed through `g.WebTransport` rather than `MockWebTransport` on
 * purpose: the whole defect is about *which* constructor the page reaches, and
 * naming the mock directly would bypass the patch and prove nothing.
 */
async function runSession(): Promise<void> {
  const wt = new (g.WebTransport as new (u: string) => MockWebTransport)('https://relay.test/moq')
  await wt.open('moqt-20')
  await settle(5)
  const send = await wt.createUnidirectionalStream()
  const writer = (send as WritableStream<unknown>).getWriter()
  await writer.write(subgroupBytes({ alias: 4n, group: 0n, objects: [{ id: 0n, bytes: 8 }] }))
  await writer.close()
  await settle()
}

interface Reported {
  readonly draft: number | null | undefined
  readonly tracks: RollupTrackWire[]
}

/** What a run's uploads actually said: the negotiated draft, and every track row. */
async function reported(posts: readonly Uint8Array[]): Promise<Reported> {
  const all: EnvelopeRecord[] = []
  for (const p of posts) all.push(...(await recordsOf(p)))
  const setup = all.find((r) => r.t === 'setup') as { draft?: number | null } | undefined
  return {
    draft: setup?.draft,
    tracks: all
      .filter((r): r is EnvelopeRecord & { tracks: RollupTrackWire[] } => r.t === 'rollup')
      .flatMap((r) => r.tracks),
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
})

describe('init() after the previous collector was stopped', () => {
  it('wraps the second run transport and reports it as fully as the first', async () => {
    const first = recordingFetch()
    const a = init(base({ sessionId: 'sess-a' }), {
      persist: false,
      noLifecycleListeners: true,
      fetchImpl: first.impl,
    })
    await settle()
    await runSession()
    await a.stop()
    await settle()

    // `stop()` restored the page's own constructor. That part always worked,
    // and it is the precondition for the assertion below.
    expect(g.WebTransport).toBe(MockWebTransport)

    const second = recordingFetch()
    const b = init(base({ sessionId: 'sess-b' }), {
      persist: false,
      noLifecycleListeners: true,
      fetchImpl: second.impl,
    })
    await settle()

    // The second `init()` has to have re-patched the global; a collector bound
    // to an unpatched constructor cannot see a byte no matter what follows.
    expect(g.WebTransport).not.toBe(MockWebTransport)

    await runSession()
    await b.stop()
    await settle()

    const one = await reported(first.posts)
    const two = await reported(second.posts)

    expect(one.draft).toBe(20)
    expect(one.tracks.length).toBeGreaterThan(0)

    expect(two.draft).toBe(20)
    expect(two.tracks.length).toBeGreaterThan(0)
    expect(two.tracks.filter((t) => t.key.d === 'tx' && t.key.v === '4').length).toBeGreaterThan(0)
  })

  it('does the same after abort(), which withdraws consent rather than ending a run', async () => {
    const a = init(base({ sessionId: 'sess-a' }), {
      persist: false,
      noLifecycleListeners: true,
      fetchImpl: recordingFetch().impl,
    })
    await settle()
    await runSession()
    await a.abort()
    await settle()

    const second = recordingFetch()
    const b = init(base({ sessionId: 'sess-b' }), {
      persist: false,
      noLifecycleListeners: true,
      fetchImpl: second.impl,
    })
    await settle()
    expect(g.WebTransport).not.toBe(MockWebTransport)

    await runSession()
    await b.stop()
    await settle()

    const two = await reported(second.posts)
    expect(two.draft).toBe(20)
    expect(two.tracks.length).toBeGreaterThan(0)
  })

  it('survives an abort() taken before the runtime ever attached', async () => {
    // The other teardown path: `PendingCollector.abort()` tears the dormant
    // hook down itself, with no runtime at all, because the customer withdrew
    // consent while the asynchronous setup was still in flight.
    const a = init(base({ sessionId: 'sess-a' }), {
      persist: false,
      noLifecycleListeners: true,
      fetchImpl: recordingFetch().impl,
    })
    await a.abort()
    await settle()

    const second = recordingFetch()
    const b = init(base({ sessionId: 'sess-b' }), {
      persist: false,
      noLifecycleListeners: true,
      fetchImpl: second.impl,
    })
    await settle()
    await runSession()
    await b.stop()
    await settle()

    const two = await reported(second.posts)
    expect(two.draft).toBe(20)
    expect(two.tracks.length).toBeGreaterThan(0)
  })
})

describe('init() before the previous stop() has settled', () => {
  it('keeps the new collector alive when the old one finishes tearing down', async () => {
    // The single-page-application shape: the player is torn down and re-created
    // in the same tick. `stop()` drains and uploads before it restores the
    // global, so the old collector's teardown lands *after* the new one is
    // already running — and it must not restore the global out from under it.
    const problems: ConfigProblem[] = []
    const a = init(base({ sessionId: 'sess-a' }), {
      persist: false,
      noLifecycleListeners: true,
      fetchImpl: recordingFetch().impl,
    })
    await settle()
    await runSession()

    const stopping = a.stop()
    const second = recordingFetch()
    const b = init(base({ sessionId: 'sess-b' }), {
      persist: false,
      noLifecycleListeners: true,
      fetchImpl: second.impl,
      onConfigProblem: (p) => problems.push(p),
    })
    await stopping
    await settle()

    // Not a mistake, so not reported as one: the customer did stop the first
    // collector, they just did not await the promise.
    expect(problems.map((p) => p.code)).not.toContain('MQ1004')

    await runSession()
    await b.stop()
    await settle()

    const two = await reported(second.posts)
    expect(two.draft).toBe(20)
    expect(two.tracks.length).toBeGreaterThan(0)
  })
})

describe('ensureDormantHook', () => {
  it('replaces a hook that was uninstalled behind its back', () => {
    // The module singleton is checked rather than trusted: whoever uninstalled
    // the hook — the runtime teardown does, and so could the extension sharing
    // the patch chain — would otherwise leave this function handing out a dead
    // one for the rest of the page's life.
    const first = ensureDormantHook()
    expect(first.installed).toBe(true)
    first.uninstall()
    expect(g.WebTransport).toBe(MockWebTransport)

    const second = ensureDormantHook()
    expect(second).not.toBe(first)
    expect(second.installed).toBe(true)
    expect(g.WebTransport).not.toBe(MockWebTransport)
    // And the state that came with the dead hook went with it, rather than
    // carrying a previous session's bytes into the next one.
    expect(dormantState()?.ring.bytes).toBe(0)
    expect(dormantState()?.sessions.size).toBe(0)
  })

  it('does not retry an install on a global that has no WebTransport', () => {
    // The opposite case, and the reason the check is not `!installed` alone:
    // here the hook is inert because there is nothing to patch, forever, and a
    // re-install per call would allocate a ring each time to learn that again.
    g.WebTransport = undefined
    resetDormantForTest()
    const first = ensureDormantHook()
    expect(first.installed).toBe(false)
    expect(ensureDormantHook()).toBe(first)
  })
})

describe('init() over a collector that was never stopped', () => {
  it('names the mistake instead of handing back a collector that reports nothing', async () => {
    const problems: ConfigProblem[] = []
    const errors: unknown[] = []
    const a = init(base({ sessionId: 'sess-a' }), {
      persist: false,
      noLifecycleListeners: true,
      fetchImpl: recordingFetch().impl,
    })
    await settle()

    const second = recordingFetch()
    const b = init(
      base({
        sessionId: 'sess-b',
        onInternalError: (e) => {
          errors.push(e)
        },
      }),
      {
        persist: false,
        noLifecycleListeners: true,
        fetchImpl: second.impl,
        onConfigProblem: (p) => problems.push(p),
      },
    )
    await settle()

    // A customer mistake rather than ours, but it has to be diagnosable: a
    // named code on the customer's own callbacks, not an empty session.
    expect(problems.map((p) => p.code)).toContain('MQ1004')
    expect(errors.map(String).join('\n')).toMatch(/MQ1004/)

    // And the newer collector is the live one, because that is the caller's
    // most recent intent.
    await runSession()
    await b.stop()
    await settle()
    const two = await reported(second.posts)
    expect(two.tracks.length).toBeGreaterThan(0)

    await a.stop()
    await settle()
  })
})
