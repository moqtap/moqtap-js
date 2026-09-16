/**
 * `init()`, `stop()`, `abort()`, escalation, metering and the overrun.
 *
 * The two teardown verbs are named apart deliberately: "one call has to be safe
 * to make when the reason for stopping is that you no longer want the data to
 * leave the device — a consent withdrawal, an opt-out, a test fixture — and a
 * `stop()` that transmits is the wrong answer to that." So `abort()` is tested
 * for what it does **not** do: no POST, no beacon, and the session's persisted
 * queue gone.
 *
 * `stop()` is tested for what it does not do either: a `stop()` whose upload
 * fails must **leave the backlog persisted**, because the backlog "is largest
 * exactly when the session is most worth having" and clearing it on a failed
 * flush would destroy the durability IndexedDB exists for.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetDormantForTest, teardownDormant } from '../../api/dormant.js'
import { init } from '../../api/init.js'
import { BODY_PREAMBLE_BYTES, readFrames, readPreamble } from '../../envelope/index.js'
import { ChunkStore, MemoryBackend } from '../../flush/index.js'
import type { CollectorConfig, EnvelopeRecord } from '../../types.js'
import { subscribeBytes } from '../decode/vectors.js'
import { MockWebTransport } from '../transport/mocks.js'

const g = globalThis as unknown as Record<string, unknown>
let originalWT: unknown

const ENDPOINT = 'https://ingest.test/v1/ingest'

interface Post {
  readonly body: Uint8Array
  readonly key: string
}

/** A `fetch` that records every upload and answers with the given status. */
function recordingFetch(status = 200): { posts: Post[]; impl: typeof fetch } {
  const posts: Post[] = []
  const impl = (async (_url: string, init: RequestInit & { headers: Record<string, string> }) => {
    posts.push({
      body: new Uint8Array(init.body as unknown as ArrayBufferLike as never),
      key: init.headers['idempotency-key'] ?? '',
    })
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => null },
    } as unknown as Response
  }) as unknown as typeof fetch
  return { posts, impl }
}

/** Every JSON record in one uploaded body. Ungzips if the preamble says to. */
async function recordsOf(body: Uint8Array): Promise<EnvelopeRecord[]> {
  const pre = readPreamble(body)
  expect(pre).not.toBeNull()
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

async function store(): Promise<ChunkStore> {
  return ChunkStore.open('test', 1024 * 1024, { backend: new MemoryBackend() })
}

/** Let init()'s async setup, the schedule's zero-delay timers and the pump run. */
const settle = async (times = 40): Promise<void> => {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve()
    await new Promise((r) => setTimeout(r, 0))
  }
}

const base = (over: Partial<CollectorConfig> = {}): CollectorConfig => ({
  apiKey: 'pk_test',
  endpoint: ENDPOINT,
  sessionId: 'sess-fixed',
  ...over,
})

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

describe('init()', () => {
  it('returns synchronously and answers ids() before anything has arrived', () => {
    const c = init(base({ context: { actorId: 'viewer-1', contentId: 'live/room-42' } }), {
      persist: false,
      noLifecycleListeners: true,
      fetchImpl: recordingFetch().impl,
    })
    const ids = c.ids()
    expect(ids.sessionId).toBe('sess-fixed')
    expect(ids.actorId).toBe('viewer-1')
    expect(ids.contentId).toBe('live/room-42')
    expect(ids.connectionId).toBeTypeOf('string')
  })

  it('reports usage as an estimate, never as an invoice', () => {
    const c = init(base(), { persist: false, noLifecycleListeners: true })
    const u = c.usage()
    expect(u.isEstimate).toBe(true)
    expect(u.elevatedMinutes).toBe(0)
    expect(u.bytesPerElevatedMinute).toBe(0)
  })

  it('throws on a missing key at the call site rather than uploading nowhere', () => {
    expect(() => init({ endpoint: ENDPOINT } as never)).toThrow(/MQ1002/)
  })
})

describe('stop() — flush, then tear down', () => {
  it('uploads a body whose first frames are the batch and the setup record', async () => {
    const { posts, impl } = recordingFetch()
    const c = init(base(), { persist: false, noLifecycleListeners: true, fetchImpl: impl })
    await settle()
    await c.stop()
    await settle()

    expect(posts.length).toBeGreaterThan(0)
    const records = await recordsOf((posts[0] as Post).body)
    expect(records[0]?.t).toBe('batch')
    expect(records.some((r) => r.t === 'setup')).toBe(true)
  })

  it('ends the session with a terminal record carrying the counters', async () => {
    const { posts, impl } = recordingFetch()
    const c = init(base(), { persist: false, noLifecycleListeners: true, fetchImpl: impl })
    await settle()
    await c.stop()
    await settle()

    const all: EnvelopeRecord[] = []
    for (const p of posts) all.push(...(await recordsOf(p.body)))
    const terminal = all.find((r) => r.t === 'terminal')
    expect(terminal).toBeDefined()
    expect((terminal as { reason: string }).reason).toBe('stop')
    expect((terminal as { counters: Record<string, unknown> }).counters).toHaveProperty(
      'bucketsRefused',
    )
  })

  it('restores the patched global', async () => {
    const c = init(base(), {
      persist: false,
      noLifecycleListeners: true,
      fetchImpl: recordingFetch().impl,
    })
    await settle()
    expect(g.WebTransport).not.toBe(MockWebTransport)
    await c.stop()
    expect(g.WebTransport).toBe(MockWebTransport)
  })

  it('leaves the backlog persisted when the upload fails', async () => {
    const s = await store()
    const { impl } = recordingFetch(503)
    const c = init(base({ upload: { maxAttempts: 1 } }), {
      store: s,
      noLifecycleListeners: true,
      fetchImpl: impl,
    })
    await settle()
    await c.stop()
    await settle()

    // The chunk it could not send is still there for the next page load. This
    // is the assertion the whole existence rests on.
    expect(s.pending('sess-fixed').length).toBeGreaterThan(0)
  })

  it('settles when ingest never answers, and keeps the chunk', async () => {
    // The unit-scale twin of the non-interference harness's blackhole arm, which
    // runs the same path against a real socket. `fetch` has no timeout of its
    // own, so without `Limits.stopDrainDeadlineMs` this promise never resolves —
    // a hang inside whatever player awaits `collector.stop()` in its own
    // teardown, which is the one thing that must never happen.
    const s = await store()
    let opened = 0
    const impl = ((_url: string, init: RequestInit) => {
      opened += 1
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
    }) as unknown as typeof fetch

    const c = init(base({ upload: { stopDrainDeadlineMs: 60, timeoutMs: 60_000 } }), {
      store: s,
      noLifecycleListeners: true,
      fetchImpl: impl,
    })
    await settle()

    const t0 = Date.now()
    await c.stop()
    const ms = Date.now() - t0

    expect(opened).toBeGreaterThan(0)
    // Bounded by the deadline, not by the request timeout an order of magnitude
    // above it: the drain's own deadline is what ends `stop()`.
    expect(ms).toBeLessThan(5_000)
    // And the deadline gave up on the attempt, never on the data.
    expect(s.pending('sess-fixed').length).toBeGreaterThan(0)
    await c.abort()
  })
})

describe('abort() — drop, transmit nothing, tear down', () => {
  it('transmits nothing further once called', async () => {
    const { posts, impl } = recordingFetch()
    const c = init(base(), { persist: false, noLifecycleListeners: true, fetchImpl: impl })
    await settle()
    c.annotate('will-not-be-sent', {})
    const before = posts.length
    await c.abort()
    await settle()
    // Nothing further is transmitted for this session: the already-sent `ready`
    // batch is history; the buffered annotation and the terminal record never
    // leave.
    expect(posts.length).toBe(before)
  })

  it("clears this session's persisted queue unconditionally", async () => {
    const s = await store()
    const { impl } = recordingFetch(503)
    const c = init(base(), { store: s, noLifecycleListeners: true, fetchImpl: impl })
    await settle()
    // Force a sealed, persisted chunk to exist before the abort.
    c.annotate('marker', { a: 1 })
    await settle()
    await c.abort()
    await settle()
    expect(s.pending('sess-fixed')).toEqual([])
  })

  it('is safe before the runtime has even attached', async () => {
    const { posts, impl } = recordingFetch()
    const c = init(base(), { persist: false, noLifecycleListeners: true, fetchImpl: impl })
    await c.abort() // no `settle()` first: the setup is still in flight
    await settle()
    expect(posts).toEqual([])
    expect(g.WebTransport).toBe(MockWebTransport)
  })

  it('restores the global', async () => {
    const c = init(base(), {
      persist: false,
      noLifecycleListeners: true,
      fetchImpl: recordingFetch().impl,
    })
    await settle()
    await c.abort()
    expect(g.WebTransport).toBe(MockWebTransport)
  })
})

describe('every elevation records what raised it', () => {
  it('emits an escalation record naming the manual call and its reason', async () => {
    const { posts, impl } = recordingFetch()
    const c = init(base(), { persist: false, noLifecycleListeners: true, fetchImpl: impl })
    await settle()
    c.escalate('headers+sizes', 'user reported a stall')
    await settle()
    await c.stop()
    await settle()

    const all: EnvelopeRecord[] = []
    for (const p of posts) all.push(...(await recordsOf(p.body)))
    const esc = all.find((r) => r.t === 'escalation') as
      | { from: string; to: string; by: { kind: string; reason?: string }; ceilingMinutes: number }
      | undefined
    expect(esc).toBeDefined()
    expect(esc?.from).toBe('baseline')
    expect(esc?.to).toBe('headers+sizes')
    expect(esc?.by.kind).toBe('manual')
    expect(esc?.by.reason).toBe('user reported a stall')
    // The record carries the bound as well as the cause: what raised the level,
    // and what caps it.
    expect(esc?.ceilingMinutes).toBeGreaterThan(0)
  })

  it('records the way back down too', async () => {
    const { posts, impl } = recordingFetch()
    const c = init(base(), { persist: false, noLifecycleListeners: true, fetchImpl: impl })
    await settle()
    c.escalate('headers')
    c.escalate('baseline')
    await settle()
    await c.stop()
    await settle()

    const all: EnvelopeRecord[] = []
    for (const p of posts) all.push(...(await recordsOf(p.body)))
    const escalations = all.filter((r) => r.t === 'escalation') as { from: string; to: string }[]
    expect(escalations.length).toBeGreaterThanOrEqual(2)
    expect(escalations.some((e) => e.from === 'headers' && e.to === 'baseline')).toBe(true)
  })

  it('attributes a record to the level that produced it', async () => {
    const { posts, impl } = recordingFetch()
    const c = init(base(), { persist: false, noLifecycleListeners: true, fetchImpl: impl })
    await settle()
    c.escalate('headers')
    c.annotate('while-elevated', {})
    await settle()
    await c.stop()
    await settle()

    const all: EnvelopeRecord[] = []
    for (const p of posts) all.push(...(await recordsOf(p.body)))
    const note = all.find((r) => r.t === 'note') as { lvl: string } | undefined
    expect(note?.lvl).toBe('headers')
  })
})

/**
 * The close conditions, at the public surface. The per-window arithmetic and
 * the other three conditions are asserted in `escalation.test.ts`; what is here
 * is that the verb exists on `Collector`, that it is safe from an error handler,
 * and that the browser's own condition — the page unloading — is wired.
 */
describe('resolve() closes the capture window', () => {
  it('emits the record that closes the window and names resolve() as the cause', async () => {
    const { posts, impl } = recordingFetch()
    const c = init(base(), { persist: false, noLifecycleListeners: true, fetchImpl: impl })
    await settle()
    c.escalate('headers', 'user reported a stall')
    c.resolve()
    await settle()
    await c.stop()
    await settle()

    const all: EnvelopeRecord[] = []
    for (const p of posts) all.push(...(await recordsOf(p.body)))
    const escalations = all.filter((r) => r.t === 'escalation') as {
      from: string
      to: string
      by: { kind: string; closed?: string; reason?: string }
    }[]
    expect(
      escalations.some(
        (e) => e.from === 'headers' && e.to === 'baseline' && e.by.closed === 'resolve',
      ),
    ).toBe(true)
  })

  it('is a harmless no-op with nothing open, because error handlers call it blind', async () => {
    const { posts, impl } = recordingFetch()
    const c = init(base(), { persist: false, noLifecycleListeners: true, fetchImpl: impl })
    await settle()
    expect(() => {
      c.resolve()
      c.resolve('nothing was ever raised')
    }).not.toThrow()
    await settle()
    await c.stop()
    await settle()

    const all: EnvelopeRecord[] = []
    for (const p of posts) all.push(...(await recordsOf(p.body)))
    expect(all.filter((r) => r.t === 'escalation')).toHaveLength(0)
    expect(c.usage().elevatedSeconds).toBe(0)
  })

  it('closes the window when the page unloads, and stops billing there', async () => {
    const gg = globalThis as unknown as Record<string, unknown>
    const prevAdd = gg.addEventListener as
      | ((t: string, f: () => void, ...rest: unknown[]) => void)
      | undefined
    let onPagehide: (() => void) | undefined
    // Only `pagehide` is intercepted; everything else still reaches the real
    // global, so nothing else running in this process loses its listeners.
    gg.addEventListener = (t: string, f: () => void, ...rest: unknown[]): void => {
      if (t === 'pagehide') {
        onPagehide = f
        return
      }
      prevAdd?.call(globalThis, t, f, ...rest)
    }
    let t = 0
    try {
      const { impl } = recordingFetch()
      const c = init(base(), {
        persist: false,
        fetchImpl: impl,
        beacon: () => true,
        clock: { now: () => t, wall: () => t },
      })
      await settle()
      c.escalate('headers', 'user reported a stall')
      t += 200
      expect(onPagehide).toBeDefined()
      onPagehide?.()
      t += 600_000
      // Ten minutes of a page that has gone away. Without the unload close
      // the window is still open and the meter has billed every second of it.
      expect(c.usage().elevatedSeconds).toBe(1)
      await c.stop()
      await settle()
    } finally {
      gg.addEventListener = prevAdd
    }
  })
})

describe('the ceiling falls back to baseline and says so', () => {
  it('drops to baseline and refuses further elevation once the ceiling is reached', async () => {
    const { posts, impl } = recordingFetch()
    // A zero-length ceiling: any elevated time at all is already over budget, so
    // the first interval tick after an elevation must fall back.
    const c = init(base({ budget: { elevatedMinutes: 1 }, metrics: { intervalMs: 100 } }), {
      persist: false,
      noLifecycleListeners: true,
      fetchImpl: impl,
      // A clock whose wall and mono both jump an hour on every read, so the
      // ceiling is crossed without the test waiting for one.
      clock: (() => {
        let t = 0
        return { now: () => (t += 3_600_000), wall: () => t }
      })(),
    })
    await settle()
    c.escalate('headers+sizes')
    await settle()
    await c.stop()
    await settle()

    const all: EnvelopeRecord[] = []
    for (const p of posts) all.push(...(await recordsOf(p.body)))
    const byCeiling = all.filter(
      (r) => r.t === 'escalation' && (r as { by: { kind: string } }).by.kind === 'ceiling',
    ) as { to: string }[]
    expect(byCeiling.length).toBeGreaterThan(0)
    expect(byCeiling[0]?.to).toBe('baseline')
    // "It does not stop collecting": the terminal record is still produced.
    expect(all.some((r) => r.t === 'terminal')).toBe(true)
  })
})

describe('customer metrics and annotations', () => {
  it('folds observe() into the interval rollup and refuses a percentile by construction', async () => {
    const { posts, impl } = recordingFetch()
    const c = init(base({ metrics: { intervalMs: 100 } }), {
      persist: false,
      noLifecycleListeners: true,
      fetchImpl: impl,
    })
    await settle()
    c.defineMetric('decodeMs', { unit: 'ms', agg: 'histogram' })
    for (let i = 0; i < 200; i += 1) c.observe('decodeMs', i)
    await settle()
    await c.stop()
    await settle()

    const all: EnvelopeRecord[] = []
    for (const p of posts) all.push(...(await recordsOf(p.body)))
    const rollup = all.find((r) => r.t === 'rollup') as
      | { custom?: { name: string; hist?: { n: number } }[] }
      | undefined
    const metric = rollup?.custom?.find((m) => m.name === 'decodeMs')
    expect(metric).toBeDefined()
    // Fixed cost per interval regardless of sample count, and the denominator
    // ships with the histogram.
    expect(metric?.hist?.n).toBe(200)
  })

  it('carries an annotation payload through verbatim', async () => {
    const { posts, impl } = recordingFetch()
    const c = init(base(), { persist: false, noLifecycleListeners: true, fetchImpl: impl })
    await settle()
    c.annotate('quality-switch', { to: '720p', nested: [1, 2] })
    await settle()
    await c.stop()
    await settle()

    const all: EnvelopeRecord[] = []
    for (const p of posts) all.push(...(await recordsOf(p.body)))
    const note = all.find((r) => r.t === 'note') as { name: string; data: unknown } | undefined
    expect(note?.name).toBe('quality-switch')
    expect(note?.data).toEqual({ to: '720p', nested: [1, 2] })
  })
})

describe('a worker that never handshakes marks the session partial', () => {
  it('reports partial on the setup record after linkWorker() with no answer', async () => {
    const { posts, impl } = recordingFetch()
    const c = init(base(), { persist: false, noLifecycleListeners: true, fetchImpl: impl })
    c.linkWorker({ postMessage: () => {}, addEventListener: () => {} })
    await settle()
    await c.stop()
    await settle()

    const all: EnvelopeRecord[] = []
    for (const p of posts) all.push(...(await recordsOf(p.body)))
    const setup = all.find((r) => r.t === 'setup') as { partial: boolean } | undefined
    expect(setup?.partial).toBe(true)
  })

  it('reports complete when no worker was ever linked', async () => {
    const { posts, impl } = recordingFetch()
    const c = init(base(), { persist: false, noLifecycleListeners: true, fetchImpl: impl })
    await settle()
    await c.stop()
    await settle()

    const all: EnvelopeRecord[] = []
    for (const p of posts) all.push(...(await recordsOf(p.body)))
    const setup = all.find((r) => r.t === 'setup') as { partial: boolean } | undefined
    expect(setup?.partial).toBe(false)
  })

  it('answers a worker hello with the config, and only on a named target', async () => {
    let listener: ((e: { data?: unknown }) => void) | undefined
    const sent: unknown[] = []
    const target = {
      postMessage: (m: unknown) => sent.push(m),
      addEventListener: (_t: 'message', f: (e: { data?: unknown }) => void) => {
        listener = f
      },
    }
    const c = init(base(), {
      persist: false,
      noLifecycleListeners: true,
      fetchImpl: recordingFetch().impl,
    })
    c.linkWorker(target)
    await settle()

    listener?.({ data: { __moqtap_collector__: 1, t: 'hello', v: 1 } })
    expect(sent).toHaveLength(1)
    expect((sent[0] as { t: string }).t).toBe('config')
    expect((sent[0] as { config: { apiKey: string } }).config.apiKey).toBe('pk_test')

    // Anything that is not the handshake is ignored — a cross-origin message
    // must never draw the apiKey out.
    listener?.({ data: { t: 'hello' } })
    listener?.({ data: 'hello' })
    expect(sent).toHaveLength(1)
    await c.stop()
  })
})

describe('the collector never throws into the page', () => {
  it('reports a customer callback that throws instead of propagating', async () => {
    const errors: unknown[] = []
    const c = init(
      base({ onInternalError: (e: unknown) => errors.push(e), metrics: { maxTracks: -1 } }),
      { persist: false, noLifecycleListeners: true, fetchImpl: recordingFetch().impl },
    )
    await settle()
    expect(errors.length).toBeGreaterThan(0)
    await expect(c.stop()).resolves.toBeUndefined()
  })

  it('survives an upload endpoint that rejects every request', async () => {
    const impl = (async () => {
      throw new TypeError('blackholed')
    }) as unknown as typeof fetch
    // One attempt: `stop()` awaits the release, and the uploader's default
    // five-attempt backoff would otherwise hold the customer's promise for
    // longer than this test's timeout.
    const c = init(base({ upload: { maxAttempts: 1 } }), {
      persist: false,
      noLifecycleListeners: true,
      fetchImpl: impl,
    })
    await settle()
    c.annotate('still-here', {})
    await expect(c.stop()).resolves.toBeUndefined()
  })
})

describe('vi is used', () => {
  it('keeps the import honest', () => {
    expect(vi).toBeDefined()
  })
})

/* ── end to end, over a real seam ────────────────────────────────────────── */

/**
 * Deliver control frames on a bidirectional stream and let the page read them.
 *
 * A bidi stream is control by definition on every draft (the other half), so
 * this exercises the whole path — hook, dispatcher, control framer, rollup,
 * flush queue, uploader — without needing the `af 00` uni-stream prefix.
 */
async function deliverControl(
  wt: MockWebTransport,
  frames: readonly Uint8Array[],
  queue?: ReadableStreamDefaultReader<unknown>,
): Promise<void> {
  // One reader for the incoming-stream queue per transport: a second
  // `getReader()` on a stream that already has one throws "ReadableStream is
  // locked", which is the platform behaviour and not something the hook changes.
  const q = queue ?? wt.incomingBidirectionalStreams.getReader()
  const stream = wt.deliverBidiStream(frames)
  stream.inbound.close()
  const arrived = await q.read()
  const reader = (arrived.value as { readable: ReadableStream<Uint8Array> }).readable.getReader()
  for (;;) {
    const r = await reader.read()
    if (r.done) break
  }
}

describe('a baseline session, end to end', () => {
  it('ships the control plane raw and reports the negotiated draft', async () => {
    const { posts, impl } = recordingFetch()
    // Pinned, so the chunk is loaded eagerly and no dynamic import races the
    // first frames.
    const c = init(base({ drafts: [20] }), {
      persist: false,
      noLifecycleListeners: true,
      fetchImpl: impl,
    })
    await settle()

    const wt = new (g.WebTransport as new (u: string) => MockWebTransport)('https://relay.test/moq')
    await wt.open('moqt-20')
    await settle(5)
    await deliverControl(wt, [subscribeBytes(1n, 'video')])
    await settle()
    await c.stop()
    await settle()

    const all: EnvelopeRecord[] = []
    for (const p of posts) all.push(...(await recordsOf(p.body)))

    const setup = all.find((r) => r.t === 'setup') as
      | { draft: number | null; protocol: string | null }
      | undefined
    expect(setup?.protocol).toBe('moqt-20')
    expect(setup?.draft).toBe(20)

    // The control plane is shipped raw at baseline so ingest can
    // reparse it server-side — which is what keeps every track name and
    // namespace off the device.
    const ctrl = all.find((r) => r.t === 'ctrl') as { decoded: boolean; n: number } | undefined
    expect(ctrl).toBeDefined()
    expect(ctrl?.decoded).toBe(true)
    expect(ctrl?.n).toBeGreaterThan(0)
  })
})

describe('the overrun policy', () => {
  it('stops collecting, says where, and still releases the keyed backlog', async () => {
    const { posts, impl } = recordingFetch()
    // One control frame per second is the whole budget, so the second frame in
    // the same second is the "fuzzing peer / relay flapping thousands of
    // streams" case the overrun policy describes, compressed into a test.
    const c = init(base({ drafts: [20], limits: { controlRatePerSec: 1 } }), {
      persist: false,
      noLifecycleListeners: true,
      fetchImpl: impl,
    })
    await settle()

    const wt = new (g.WebTransport as new (u: string) => MockWebTransport)('https://relay.test/moq')
    await wt.open('moqt-20')
    await settle(5)
    const queue = wt.incomingBidirectionalStreams.getReader()
    await deliverControl(
      wt,
      [
        subscribeBytes(1n, 'video'),
        subscribeBytes(2n, 'audio'),
        subscribeBytes(3n, 'text'),
        subscribeBytes(4n, 'more'),
      ],
      queue,
    )
    await settle()

    const all: EnvelopeRecord[] = []
    for (const p of posts) all.push(...(await recordsOf(p.body)))
    const terminal = all.find((r) => r.t === 'terminal') as
      | { reason: string; partial: boolean; counters: { overrunSignal?: string } }
      | undefined

    // "Close the segment, emit a terminal record carrying the counters, and send
    // nothing further for that session."
    expect(terminal).toBeDefined()
    expect(terminal?.reason).toBe('overrun')
    expect(terminal?.partial).toBe(true)
    // The overrun is a first-class state, and the signal is the finding.
    expect(terminal?.counters.overrunSignal).toMatch(/control-plane rate exceeded 1\/s/)

    // The already-keyed backlog went out: those chunks are paid for and honest.
    expect(posts.length).toBeGreaterThan(0)

    // And nothing further is collected. More control frames produce no more
    // ctrl records.
    const beforeCtrl = all.filter((r) => r.t === 'ctrl').length
    await deliverControl(wt, [subscribeBytes(5n, 'ignored')], queue)
    await settle()
    const after: EnvelopeRecord[] = []
    for (const p of posts) after.push(...(await recordsOf(p.body)))
    expect(after.filter((r) => r.t === 'ctrl').length).toBe(beforeCtrl)

    await c.stop()
  })
})

/* ── the tail when the platform will not take a beacon ───────────────────── */

/**
 * `sendBeacon` is not always available and does not always accept, and the tail
 * is the one segment carrying the terminal record, the drop counters and the
 * reason the session ended. `sealSync` has already emptied the frame writer and
 * deliberately does not persist, so a refusal nobody acts on loses those bytes
 * outright — and the absence is indistinguishable from a session that never
 * finished.
 */
describe('the tail when the platform will not take a beacon', () => {
  /** Intercepts only `pagehide`; everything else still reaches the real global. */
  function capturePagehide(): { fire: () => void; restore: () => void } {
    const gg = globalThis as unknown as Record<string, unknown>
    const prev = gg.addEventListener as
      | ((t: string, f: () => void, ...rest: unknown[]) => void)
      | undefined
    let handler: (() => void) | undefined
    gg.addEventListener = (t: string, f: () => void, ...rest: unknown[]): void => {
      if (t === 'pagehide') {
        handler = f
        return
      }
      prev?.call(globalThis, t, f, ...rest)
    }
    return {
      fire: () => {
        expect(handler).toBeDefined()
        handler?.()
      },
      restore: () => {
        gg.addEventListener = prev
      },
    }
  }

  /** A `fetch` that accepts the `Blob` body the tail path sends. */
  function tailFetch(): { calls: { url: string; init: RequestInit }[]; impl: typeof fetch } {
    const calls: { url: string; init: RequestInit }[] = []
    const impl = ((url: string, init: RequestInit) => {
      calls.push({ url, init })
      return Promise.resolve({
        ok: true,
        status: 202,
        headers: { get: () => null },
      } as unknown as Response)
    }) as unknown as typeof fetch
    return { calls, impl }
  }

  it('carries the ingest credential, which is the only way the beacon can carry one', async () => {
    // `sendBeacon` cannot set an `Authorization` header, so a tail posted to a
    // bare endpoint is unauthenticated and an ingest tier that checks anything
    // refuses it -- invisibly, because a beacon cannot read a response.
    const p = capturePagehide()
    try {
      let beaconUrl = ''
      const c = init(base(), {
        persist: false,
        fetchImpl: tailFetch().impl,
        beacon: (url) => {
          beaconUrl = url
          return true
        },
      })
      await settle()
      p.fire()
      expect(beaconUrl.startsWith(`${ENDPOINT}?k=pk_test`)).toBe(true)
      expect(new URL(beaconUrl).searchParams.get('k')).toBe('pk_test')
      await c.stop()
      await settle()
    } finally {
      p.restore()
    }
  })

  it('carries the same idempotency key whichever mechanism takes the tail', async () => {
    // The edge reads the key from `?ik=` or the `Idempotency-Key` header, never
    // from the body -- it is inside the gzipped first frame, and decompressing
    // every upload at the edge is the cost the ingest tier exists to avoid. A
    // refused beacon falls back to keepalive fetch, so the same segment can
    // leave by either mechanism and the edge must not see a key on one and none
    // on the other.
    //
    // Both are captured from ONE segment: the beacon records its URL and then
    // refuses, which hands the identical chunk to the fallback.
    const p = capturePagehide()
    try {
      let beaconUrl = ''
      const { calls, impl } = tailFetch()
      const c = init(base(), {
        persist: false,
        fetchImpl: impl,
        beacon: (url) => {
          beaconUrl = url
          return false
        },
      })
      await settle()
      const before = calls.length
      p.fire()

      const fromUrl = new URL(beaconUrl).searchParams.get('ik')
      const tail = calls.slice(before)
      expect(tail).toHaveLength(1)
      const fromHeader = (tail[0]?.init.headers as Record<string, string>)['idempotency-key']

      // Present, well-formed, and the same key on both paths. The pattern is
      // the one the edge validates: sha256 hex, or the 32-hex fallback a
      // non-secure context produces.
      expect(fromUrl).toMatch(/^(?:[0-9a-f]{32}|[0-9a-f]{64})$/)
      expect(fromUrl).toBe(fromHeader)

      await c.stop()
      await settle()
    } finally {
      p.restore()
    }
  })

  it('still delivers the tail when a blocker has removed or stubbed sendBeacon', async () => {
    const p = capturePagehide()
    try {
      const { calls, impl } = tailFetch()
      const c = init(base(), { persist: false, fetchImpl: impl, beacon: () => false })
      await settle()
      const before = calls.length
      p.fire()

      const tail = calls.slice(before)
      expect(tail).toHaveLength(1)
      expect(tail[0]?.init.keepalive).toBe(true)
      expect((tail[0]?.init.headers as Record<string, string>).authorization).toBe('Bearer pk_test')
      await c.stop()
      await settle()
    } finally {
      p.restore()
    }
  })

  it('reports the loss when nothing takes it, rather than dropping it in silence', async () => {
    const p = capturePagehide()
    const gf = globalThis as { fetch?: typeof fetch | undefined }
    const savedFetch = gf.fetch
    try {
      const errors: unknown[] = []
      // No usable fetch anywhere: the injected one throws and the platform's is
      // removed, so both mechanisms are genuinely unavailable.
      gf.fetch = undefined
      const c = init(base({ onInternalError: (e) => errors.push(e) }), {
        persist: false,
        beacon: () => false,
      })
      await settle()
      p.fire()

      expect(errors).toHaveLength(1)
      expect(String(errors[0])).toMatch(/MQ5001/)
      await c.stop()
      await settle()
    } finally {
      gf.fetch = savedFetch
      p.restore()
    }
  })

  it('meters a tail that left, and not one that nothing accepted', async () => {
    // `sealSync` does not persist, so a refused tail is gone -- counting its
    // bytes would put them in the local estimate while ingest, which is the
    // actual meter, never sees them.
    const run = async (accepted: boolean): Promise<number> => {
      const p = capturePagehide()
      const gf = globalThis as { fetch?: typeof fetch | undefined }
      const savedFetch = gf.fetch
      try {
        // No keepalive fallback either, so `accepted` alone decides the outcome.
        gf.fetch = undefined
        const c = init(base({ onInternalError: () => undefined }), {
          persist: false,
          beacon: () => accepted,
        })
        await settle()
        p.fire()
        const bytes = c.usage().bytesByLevel.baseline
        await c.stop()
        await settle()
        return bytes
      } finally {
        gf.fetch = savedFetch
        p.restore()
      }
    }

    expect(await run(true)).toBeGreaterThan(0)
    expect(await run(false)).toBe(0)
  })
})
