/**
 * `init()`, `flush()`, `end()`, `discard()`, worker links, escalation,
 * metering and the overrun, at the public surface.
 *
 * The page is the only part of the collector that numbers, seals, stores or
 * uploads, so most assertions here read what actually left the page — every
 * body, decoded — and check the properties the server relies on:
 *
 *  - an instance's bodies are numbered `0, 1, 2 …` with no gap, and the last
 *    one is marked `final` and named by the `end` record it carries;
 *  - a body that fails to upload is retried in the same page until ingest
 *    answers, so a network drop never leaves a hole;
 *  - a body the page could not send is swept by a later page load once its
 *    instance is gone, and never while it is alive;
 *  - `discard()` is tested for what it does **not** do: no POST, no beacon,
 *    and the session's stored bodies gone.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveConfig } from '../../api/config.js'
import {
  dormantState,
  ensureDormantHook,
  resetDormantForTest,
  teardownDormant,
} from '../../api/dormant.js'
import { EARLY_CONTROL_CONNECTION_BYTES } from '../../api/early.js'
import {
  envelope,
  FORWARD_INTERVAL_MS,
  type ForwardMessage,
  type LinkedMessage,
  linkMessage,
} from '../../api/link.js'
import { initWorkerWith } from '../../api/worker.js'
import {
  BODY_PREAMBLE_BYTES,
  FrameWriter,
  readFrames,
  readPreamble,
  sha256Hex,
} from '../../envelope/index.js'
import { type Chunk, ChunkStore, type LockManagerLike, MemoryBackend } from '../../flush/index.js'
import type {
  BatchRecord,
  CollectorConfig,
  ConnCloseRecord,
  ConnOpenRecord,
  EndRecord,
  EnvelopeRecord,
  LinkRecord,
  RollupRecord,
} from '../../types.js'
import { chunks, concatBytes, encodeControl, subscribeBytes } from '../decode/vectors.js'
import { attempt, init, workerBuild } from '../support/init.js'
import { settle, until } from '../support/settle.js'
import { MockWebTransport } from '../transport/mocks.js'

const g = globalThis as unknown as Record<string, unknown>
let originalWT: unknown

const ENDPOINT = 'https://ingest.test/v1/ingest'

interface Post {
  readonly url: string
  readonly body: Uint8Array
}

/** A `fetch` that records every upload and answers with the given status, or a script of them. */
function recordingFetch(status: number | (() => number) = 200): {
  posts: Post[]
  impl: typeof fetch
} {
  const posts: Post[] = []
  const impl = (async (url: string, init: RequestInit) => {
    const body =
      init.body instanceof Blob
        ? new Uint8Array(await init.body.arrayBuffer())
        : new Uint8Array(init.body as unknown as ArrayBufferLike as never)
    const code = typeof status === 'number' ? status : status()
    if (code === 0) throw new TypeError('network down')
    posts.push({ url, body })
    return {
      ok: code >= 200 && code < 300,
      status: code,
      headers: { get: () => null },
    } as unknown as Response
  }) as unknown as typeof fetch
  return { posts, impl }
}

/** One uploaded body's frames, ungzipped if the preamble says so. */
async function framesOf(body: Uint8Array): Promise<Uint8Array> {
  const pre = readPreamble(body)
  expect(pre).not.toBeNull()
  const frames = body.subarray(BODY_PREAMBLE_BYTES)
  if (!(pre as { gzipped: boolean }).gzipped) return frames
  const ds = new DecompressionStream('gzip')
  const out = new Response(new Blob([frames as unknown as BlobPart]).stream().pipeThrough(ds))
  return new Uint8Array(await out.arrayBuffer())
}

/** Every JSON record in one uploaded body. */
async function recordsOf(body: Uint8Array): Promise<EnvelopeRecord[]> {
  const frames = await framesOf(body)
  const decoder = new TextDecoder()
  const out: EnvelopeRecord[] = []
  for (const f of readFrames(frames)) {
    if (!f.raw) out.push(JSON.parse(decoder.decode(f.payload)) as EnvelopeRecord)
  }
  return out
}

async function allRecords(posts: readonly { body: Uint8Array }[]): Promise<EnvelopeRecord[]> {
  const all: EnvelopeRecord[] = []
  for (const p of posts) all.push(...(await recordsOf(p.body)))
  return all
}

/** The batch frame of every distinct body that arrived, by key, in sequence order. */
async function batchesOf(posts: readonly Post[]): Promise<BatchRecord[]> {
  const byKey = new Map<string, BatchRecord>()
  for (const p of posts) {
    const batch = (await recordsOf(p.body))[0] as BatchRecord
    byKey.set(batch.idempotencyKey, batch)
  }
  return [...byKey.values()].sort((a, b) => a.seq - b.seq)
}

/** What ingest would merge the `conn-open` records of one connection into. */
function connections(all: readonly EnvelopeRecord[]): Map<string, ConnOpenRecord> {
  const out = new Map<string, ConnOpenRecord>()
  for (const r of all) {
    if (r.t !== 'conn-open') continue
    out.set(r.conn, { ...out.get(r.conn), ...r })
  }
  return out
}

const of = <T extends EnvelopeRecord['t']>(all: readonly EnvelopeRecord[], t: T) =>
  all.filter((r) => r.t === t) as Extract<EnvelopeRecord, { t: T }>[]

async function store(): Promise<ChunkStore> {
  return ChunkStore.open('test', 1024 * 1024, { backend: new MemoryBackend() })
}

const base = (over: Partial<CollectorConfig> = {}): CollectorConfig => ({
  apiKey: 'pk_test',
  endpoint: ENDPOINT,
  sessionId: 'sess-fixed',
  ...over,
})

/** Every page the suite builds runs without the platform's locks unless a test supplies some. */
const quiet = { persist: false, noLifecycleListeners: true, locks: null } as const

async function openTransport(protocol = 'moqt-20'): Promise<MockWebTransport> {
  const wt = new (g.WebTransport as new (u: string) => MockWebTransport)(
    'https://user:secret@relay.test:4433/moq?token=abc',
  )
  await wt.open(protocol)
  await settle(5)
  return wt
}

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

/** Intercepts the page lifecycle events; everything else still reaches the real global. */
function captureLifecycle(): {
  fire: (type: string, e?: unknown) => void
  restore: () => void
} {
  const gg = globalThis as unknown as Record<string, unknown>
  const prev = gg.addEventListener as
    | ((t: string, f: (e?: unknown) => void, ...rest: unknown[]) => void)
    | undefined
  const handlers = new Map<string, (e?: unknown) => void>()
  const captured = new Set(['pagehide', 'pageshow', 'visibilitychange', 'online'])
  gg.addEventListener = (t: string, f: (e?: unknown) => void, ...rest: unknown[]): void => {
    if (captured.has(t)) {
      handlers.set(t, f)
      return
    }
    prev?.call(globalThis, t, f, ...rest)
  }
  return {
    fire: (type, e) => {
      const h = handlers.get(type)
      expect(h).toBeDefined()
      h?.(e ?? {})
    },
    restore: () => {
      gg.addEventListener = prev
    },
  }
}

/** A lock manager with `query`, holding whatever the test says is alive. */
function fakeLocks(alive: string[] = []): LockManagerLike & { held: Set<string> } {
  const held = new Set(alive.map((id) => `moqtap:${id}`))
  return {
    held,
    request(name: string, callback: (lock: unknown) => Promise<unknown> | unknown) {
      held.add(name)
      return Promise.resolve(callback({ name })).finally(() => held.delete(name))
    },
    query: async () => ({ held: [...held].map((name) => ({ name })) }),
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

describe('init()', () => {
  it('returns synchronously and answers ids() before anything has arrived', () => {
    const c = init(base({ context: { actorId: 'viewer-9' } }), { ...quiet, instanceId: 'inst-1' })
    expect(c.ids()).toEqual({ sessionId: 'sess-fixed', instanceId: 'inst-1', actorId: 'viewer-9' })
    expect(c.connections()).toEqual([])
  })

  it('mints a new instance for every init() of the same supplied session id', () => {
    const a = init(base(), quiet).ids()
    const b = init(base(), quiet).ids()
    expect(a.sessionId).toBe(b.sessionId)
    expect(a.instanceId).not.toBe(b.instanceId)
  })

  it('reports usage as an estimate, never as an invoice', () => {
    const c = init(base(), quiet)
    expect(c.usage().isEstimate).toBe(true)
  })

  it('throws on a missing key at the call site rather than uploading nowhere', () => {
    expect(() => init({ apiKey: '' } as CollectorConfig, quiet)).toThrow()
  })

  it('sends nothing at all from a page that records nothing', async () => {
    const { posts, impl } = recordingFetch()
    init(base(), { ...quiet, fetchImpl: impl })
    await settle()
    expect(posts).toEqual([])
  })
})

describe('end() — the instance is done', () => {
  it('opens its first body with the batch frame, then the setup record', async () => {
    const { posts, impl } = recordingFetch()
    const c = init(base(), { ...quiet, fetchImpl: impl, instanceId: 'inst-1' })
    attempt()
    await settle()
    await c.end()

    const records = await recordsOf((posts[0] as Post).body)
    expect(records[0]).toMatchObject({
      t: 'batch',
      v: 2,
      sessionId: 'sess-fixed',
      instanceId: 'inst-1',
      seq: 0,
    })
    expect(records[1]).toMatchObject({
      t: 'setup',
      identity: { sessionId: 'sess-fixed', instanceId: 'inst-1' },
      idSource: 'supplied',
    })
  })

  it('says whether the session id was supplied or minted', async () => {
    const { posts, impl } = recordingFetch()
    const { sessionId: _omit, ...minted } = base()
    const c = init(minted, { ...quiet, fetchImpl: impl })
    attempt()
    await settle()
    await c.end()
    expect(of(await allRecords(posts), 'setup')[0]?.idSource).toBe('minted')
  })

  it('ends with an end record in the final body, which names that body', async () => {
    const { posts, impl } = recordingFetch()
    const c = init(base(), { ...quiet, fetchImpl: impl })
    attempt()
    // The session's first body, sent as it began.
    await c.flush()
    c.annotate('a')
    await c.flush()
    c.annotate('b')
    await c.end()

    // The session's first upload as it began, `flush()`'s body, what was
    // buffered at `end()`, and the end record's own.
    const batches = await batchesOf(posts)
    expect(batches.map((b) => b.seq)).toEqual([0, 1, 2, 3])
    expect(batches.map((b) => b.final)).toEqual([undefined, undefined, undefined, true])
    const end = of(await allRecords(posts), 'end')
    expect(end).toHaveLength(1)
    expect(end[0]).toMatchObject({ reason: 'app', finalSeq: 3 })
    expect(end[0]?.counters).toHaveProperty('bucketsRefused')
  })

  it('reports the connections still open as closed by the session end', async () => {
    const { posts, impl } = recordingFetch()
    const c = init(base(), { ...quiet, fetchImpl: impl })
    await settle()
    await openTransport()
    await c.end()

    const all = await allRecords(posts)
    const [conn] = connections(all).values()
    expect(of(all, 'conn-close')).toEqual([
      expect.objectContaining({ conn: conn?.conn, cause: 'session-end' }),
    ])
  })

  it('writes the open rollup interval of each connection it closes', async () => {
    const { posts, impl } = recordingFetch()
    const c = init(base(), { ...quiet, fetchImpl: impl })
    await settle()
    const wt = await openTransport()
    await deliverControl(wt, [subscribeBytes(1n, 'video')])
    // Well inside the first metrics interval, so only the close can write it.
    await c.end()

    const rollups = of(await allRecords(posts), 'rollup')
    expect(rollups.reduce((n, r) => n + (r.session['ctrl.rx.frames'] ?? 0), 0)).toBe(1)
  })

  it('restores the patched global', async () => {
    const c = init(base(), { ...quiet, fetchImpl: recordingFetch().impl })
    await settle()
    expect(g.WebTransport).not.toBe(MockWebTransport)
    await c.end()
    expect(g.WebTransport).toBe(MockWebTransport)
  })

  it('keeps the stored copy of a body ingest did not take', async () => {
    const s = await store()
    const { impl } = recordingFetch(503)
    const c = init(base({ upload: { maxAttempts: 1 } }), {
      ...quiet,
      persist: true,
      store: s,
      fetchImpl: impl,
    })
    attempt()
    await settle()
    await c.end()
    // The bodies it could not send, the begin's and the end's, are still
    // there for the next page load.
    expect(s.backlog({ endpoint: ENDPOINT, keyHash: sha256Hex('pk_test') }).length).toBe(2)
  })

  it('settles when ingest never answers, and keeps the body', async () => {
    // `fetch` has no timeout of its own, so without `upload.drainDeadlineMs`
    // this promise never resolves — a hang inside whatever player awaits
    // `collector.end()` in its own teardown.
    const s = await store()
    let opened = 0
    const impl = ((_url: string, init: RequestInit) => {
      opened += 1
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
    }) as unknown as typeof fetch

    const c = init(base({ upload: { drainDeadlineMs: 60, timeoutMs: 60_000 } }), {
      ...quiet,
      store: s,
      fetchImpl: impl,
    })
    attempt()
    await settle()

    const t0 = Date.now()
    await c.end()
    expect(opened).toBeGreaterThan(0)
    expect(Date.now() - t0).toBeLessThan(5_000)
    // The begin's body and the end's.
    expect(s.chunks).toBe(2)
  })

  it('is safe to call twice', async () => {
    const { posts, impl } = recordingFetch()
    const c = init(base(), { ...quiet, fetchImpl: impl })
    attempt()
    await settle()
    await Promise.all([c.end(), c.end()])
    expect(of(await allRecords(posts), 'end')).toHaveLength(1)
  })
})

describe('flush() — send now, end nothing', () => {
  it('uploads what was recorded and keeps the session going', async () => {
    const { posts, impl } = recordingFetch()
    const c = init(base(), { ...quiet, fetchImpl: impl })
    attempt()
    // The session's first body, sent as it began.
    await c.flush()
    c.annotate('before')
    await c.flush()
    // The session's first upload as it began, and the flush's.
    expect(posts).toHaveLength(2)
    expect(of(await allRecords(posts), 'end')).toHaveLength(0)

    c.annotate('after')
    await c.end()
    expect(of(await allRecords(posts), 'note').map((n) => n.name)).toEqual(['before', 'after'])
  })
})

describe('discard() — drop, transmit nothing, tear down', () => {
  it('transmits nothing further once called', async () => {
    const { posts, impl } = recordingFetch()
    const c = init(base(), { ...quiet, fetchImpl: impl })
    await settle()
    c.annotate('will-not-be-sent', {})
    await c.discard()
    await settle()
    expect(posts).toEqual([])
  })

  it("deletes this session's stored bodies", async () => {
    const s = await store()
    const { impl } = recordingFetch(503)
    const c = init(base({ upload: { maxAttempts: 1 } }), { ...quiet, store: s, fetchImpl: impl })
    attempt()
    // The session's first body, sent as it began.
    await c.flush()
    c.annotate('marker', { a: 1 })
    await c.flush()
    await until(() => s.chunks === 2)
    expect(s.chunks).toBe(2)
    await c.discard()
    expect(s.chunks).toBe(0)
  })

  it('is safe before the runtime has even attached', async () => {
    const { posts, impl } = recordingFetch()
    const c = init(base(), { ...quiet, fetchImpl: impl })
    await c.discard() // no `settle()` first: the setup is still in flight
    await settle()
    expect(posts).toEqual([])
    expect(g.WebTransport).toBe(MockWebTransport)
  })
})

describe('an upload that fails is retried in the same page', () => {
  it('delivers every body with no hole once the network is back', async () => {
    let up = false
    const { posts, impl } = recordingFetch(() => (up ? 200 : 0))
    const c = init(base({ upload: { maxAttempts: 1 } }), {
      ...quiet,
      fetchImpl: impl,
      // Timers run fast, so the backoff comes round inside the test.
      setTimer: (fn, ms) => setTimeout(fn, Math.min(ms, 20)),
      clearTimer: (h) => clearTimeout(h as never),
    })
    attempt()
    await settle()
    c.annotate('during-the-drop')
    await c.flush()
    expect(posts).toEqual([])

    up = true
    await settle()
    c.annotate('after')
    await c.end()

    const seqs = (await batchesOf(posts)).map((b) => b.seq)
    expect(seqs[0]).toBe(0)
    expect(seqs).toEqual(seqs.map((_, i) => i))
    expect(of(await allRecords(posts), 'note').map((n) => n.name)).toContain('during-the-drop')
  })

  it('retries when the browser says it is online again', async () => {
    const life = captureLifecycle()
    try {
      let up = false
      const { posts, impl } = recordingFetch(() => (up ? 200 : 0))
      const c = init(base({ upload: { maxAttempts: 1 } }), {
        persist: false,
        locks: null,
        fetchImpl: impl,
      })
      attempt()
      // The session's first body, sent as it began.
      await c.flush()
      c.annotate('queued')
      await c.flush()
      expect(posts).toEqual([])
      up = true
      life.fire('online')
      await until(() => posts.length === 2)
      // The begin's body and the flush's.
      expect(posts).toHaveLength(2)
      await c.end()
    } finally {
      life.restore()
    }
  })

  it('lists a body ingest refused for good as lost, on the next body', async () => {
    let first = true
    const { posts, impl } = recordingFetch(() => {
      if (!first) return 200
      first = false
      return 400
    })
    const c = init(base(), { ...quiet, fetchImpl: impl })
    attempt()
    await settle()
    c.annotate('refused')
    await c.flush()
    c.annotate('accepted')
    await c.end()

    const batches = await batchesOf(posts)
    expect(batches.at(-1)?.lost).toEqual([0])
  })
})

describe('stored bodies of a gone instance are swept by the next page load', () => {
  const dest = { endpoint: ENDPOINT, keyHash: sha256Hex('pk_test') }
  const stored = (instanceId: string, seq: number, wall = Date.now()): Chunk => ({
    sessionId: 'earlier',
    instanceId,
    seq,
    idempotencyKey: `key-${instanceId}-${seq}`,
    createdWallMs: wall,
    bytes: new Uint8Array([0x4d, 0x51, 0x54, 0x43, 1, 0, 0, 0]),
    level: 'baseline',
    attempts: 0,
  })

  it('sends a dead instance’s bodies from any session, and leaves a live one’s alone', async () => {
    const s = await store()
    await s.put(stored('dead', 0), dest)
    await s.put(stored('alive', 0), dest)
    await s.put(stored('elsewhere', 0), { endpoint: ENDPOINT, keyHash: sha256Hex('pk_other') })
    const { posts, impl } = recordingFetch()
    const c = init(base(), { ...quiet, store: s, fetchImpl: impl, locks: fakeLocks(['alive']) })
    attempt()
    await settle()

    const swept = posts.filter((p) => new URL(p.url).searchParams.get('i') !== c.ids().instanceId)
    expect(swept.map((p) => new URL(p.url).searchParams.get('ik'))).toEqual(['key-dead-0'])
    expect(new URL((swept[0] as Post).url).searchParams.get('i')).toBe('dead')
    expect(s.has('key-dead-0')).toBe(false)
    expect(s.has('key-alive-0')).toBe(true)
    expect(s.has('key-elsewhere-0')).toBe(true)
    await c.discard()
  })

  it('without Web Locks, takes only bodies older than three upload intervals', async () => {
    const s = await store()
    await s.put(stored('old', 0, Date.now() - 10 * 60_000), dest)
    await s.put(stored('recent', 0, Date.now()), dest)
    const { posts, impl } = recordingFetch()
    const c = init(base(), { ...quiet, store: s, fetchImpl: impl })
    attempt()
    await settle()

    const swept = posts.filter((p) => new URL(p.url).searchParams.get('i') !== c.ids().instanceId)
    expect(swept.map((p) => new URL(p.url).searchParams.get('ik'))).toEqual(['key-old-0'])
    await c.discard()
  })

  it('holds its own instance lock while it lives', async () => {
    const locks = fakeLocks()
    const c = init(base(), { ...quiet, locks, instanceId: 'me', fetchImpl: recordingFetch().impl })
    attempt()
    await settle()
    expect(locks.held.has('moqtap:me')).toBe(true)
    await c.end()
    await settle(5)
    expect(locks.held.has('moqtap:me')).toBe(false)
  })
})

describe('connections', () => {
  it('reports each transport as a connection, with an origin that carries no secret', async () => {
    const { posts, impl } = recordingFetch()
    const c = init(base(), { ...quiet, fetchImpl: impl })
    await settle()
    const wt = await openTransport()
    await deliverControl(wt, [subscribeBytes(1n, 'video')])
    expect(c.connections()).toEqual([
      expect.objectContaining({ realm: 'page', state: 'open', draft: 20 }),
    ])
    await c.end()

    const all = await allRecords(posts)
    const [conn] = connections(all).values()
    expect(conn).toMatchObject({
      realm: 'page',
      origin: 'https://relay.test:4433',
      draft: 20,
      protocol: 'moqt-20',
    })
    // Every connection-scoped record names its connection.
    const ctrl = of(all, 'ctrl')
    expect(ctrl.length).toBeGreaterThan(0)
    expect(ctrl.every((r) => r.conn === conn?.conn)).toBe(true)
    expect(ctrl[0]?.decoded).toBe(true)
  })

  it('reports a close with its code and reason, and seals at once', async () => {
    const { posts, impl } = recordingFetch()
    const c = init(base(), { ...quiet, fetchImpl: impl })
    await settle()
    const wt = await openTransport()
    wt.closeSession('bye', 7)
    await until(async () => of(await allRecords(posts), 'conn-close').length > 0)

    // Sealed by the close itself, not by the schedule or the end.
    const close = of(await allRecords(posts), 'conn-close')
    expect(close).toEqual([expect.objectContaining({ cause: 'closed', code: 7, reason: 'bye' })])
    expect(c.connections()[0]).toMatchObject({ state: 'closed', closeCause: 'closed' })
    await c.end()
  })

  it('reports a transport that failed as failed', async () => {
    const { posts, impl } = recordingFetch()
    const c = init(base(), { ...quiet, fetchImpl: impl })
    await settle()
    const wt = new (g.WebTransport as new (u: string) => MockWebTransport)('https://relay.test/')
    wt.failToOpen(new Error('handshake refused'))
    await settle()
    await c.end()
    const all = await allRecords(posts)
    expect(of(all, 'conn-close')[0]?.cause).toBe('failed')
    // Never ready, so no record says it was.
    expect(of(all, 'conn-open').some((r) => r.readyTs !== undefined)).toBe(false)
  })

  it('sends the connection again when the transport is ready, saying when', async () => {
    const { posts, impl } = recordingFetch()
    const c = init(base(), { ...quiet, fetchImpl: impl })
    await settle()
    await openTransport()
    await c.end()

    const opens = of(await allRecords(posts), 'conn-open')
    expect(opens[0]?.readyTs).toBeUndefined()
    const ready = opens.find((r) => r.readyTs !== undefined)
    expect(ready).toMatchObject({ draft: 20 })
    expect(ready?.readyTs).toBeGreaterThanOrEqual(opens[0]?.ts as number)
  })

  it('reports the drafts the page offered, from the protocols it passed', async () => {
    const { posts, impl } = recordingFetch()
    const c = init(base(), { ...quiet, fetchImpl: impl })
    await settle()
    const wt = new (g.WebTransport as new (u: string, o: unknown) => MockWebTransport)(
      'https://relay.test/moq',
      { protocols: ['moqt-23', 'moqt-22', 'moq-00', 'moqt-22', 'h3'], allowPooling: true },
    )
    await wt.open('moqt-22')
    await settle(5)
    await c.end()

    const opens = of(await allRecords(posts), 'conn-open')
    expect(opens[0]?.offered).toEqual([23, 22])
    expect(opens[0]?.options).toEqual({ allowPooling: true })
    const [conn] = connections(opens).values()
    expect(conn).toMatchObject({ draft: 22, offered: [23, 22] })
  })
})

describe('every elevation records what raised it', () => {
  it('emits an escalation record naming the manual call and its reason', async () => {
    const { posts, impl } = recordingFetch()
    const c = init(base(), { ...quiet, fetchImpl: impl })
    attempt()
    await settle()
    c.escalate('headers+sizes', 'user reported a stall')
    await c.end()

    const esc = of(await allRecords(posts), 'escalation')[0]
    expect(esc).toMatchObject({
      from: 'baseline',
      to: 'headers+sizes',
      by: { kind: 'manual', reason: 'user reported a stall' },
    })
    // The record carries the bound as well as the cause.
    expect(esc?.ceilingMinutes).toBeGreaterThan(0)
  })

  it('attributes a record to the level that produced it', async () => {
    const { posts, impl } = recordingFetch()
    const c = init(base(), { ...quiet, fetchImpl: impl })
    attempt()
    await settle()
    c.escalate('headers')
    c.annotate('while-elevated', {})
    await c.end()
    expect(of(await allRecords(posts), 'note')[0]?.lvl).toBe('headers')
  })

  it('closes the window with resolve(), and resolve() with nothing open is harmless', async () => {
    const { posts, impl } = recordingFetch()
    const c = init(base(), { ...quiet, fetchImpl: impl })
    attempt()
    await settle()
    expect(() => c.resolve('nothing was ever raised')).not.toThrow()
    c.escalate('headers', 'user reported a stall')
    c.resolve()
    await c.end()

    const escalations = of(await allRecords(posts), 'escalation')
    expect(escalations.map((e) => [e.from, e.to])).toEqual([
      ['baseline', 'headers'],
      ['headers', 'baseline'],
    ])
    expect(escalations[1]?.by).toEqual({ kind: 'window', closed: 'resolve' })
  })

  it('drops to baseline at the ceiling and keeps collecting', async () => {
    const { posts, impl } = recordingFetch()
    const c = init(base({ budget: { elevatedMinutes: 1 }, metrics: { intervalMs: 100 } }), {
      ...quiet,
      fetchImpl: impl,
      // Wall and mono both jump an hour on every read, so the ceiling is
      // crossed without the test waiting for one.
      clock: (() => {
        let t = 0
        return { now: () => (t += 3_600_000), wall: () => t }
      })(),
    })
    attempt()
    await settle()
    c.escalate('headers+sizes')
    // The ceiling is checked on the metrics interval, so one has to run.
    await settle(40, 100)
    await c.end()

    const all = await allRecords(posts)
    const byCeiling = of(all, 'escalation').filter((e) => e.by.kind === 'ceiling')
    expect(byCeiling[0]?.to).toBe('baseline')
    expect(of(all, 'end')).toHaveLength(1)
  })
})

describe('customer metrics and annotations', () => {
  it('folds observe() into a rollup of their own, which belongs to no connection', async () => {
    const { posts, impl } = recordingFetch()
    const c = init(base({ metrics: { intervalMs: 100 } }), { ...quiet, fetchImpl: impl })
    attempt()
    await settle()
    c.defineMetric('decodeMs', { unit: 'ms', agg: 'histogram' })
    for (let i = 0; i < 200; i += 1) c.observe('decodeMs', i)
    await settle()
    await c.end()

    const rollup = of(await allRecords(posts), 'rollup').find((r) => r.custom !== undefined)
    expect(rollup?.conn).toBe('')
    expect(rollup?.custom?.find((m) => m.name === 'decodeMs')?.hist?.n).toBe(200)
  })

  it('carries an annotation payload through verbatim', async () => {
    const { posts, impl } = recordingFetch()
    const c = init(base(), { ...quiet, fetchImpl: impl })
    attempt()
    await settle()
    c.annotate('quality-switch', { to: '720p', nested: [1, 2] })
    await c.end()
    expect(of(await allRecords(posts), 'note')[0]).toMatchObject({
      name: 'quality-switch',
      data: { to: '720p', nested: [1, 2] },
    })
  })
})

describe('worker links', () => {
  it('answers a hello on the named target only, with no credential', async () => {
    let listener: ((e: { data?: unknown }) => void) | undefined
    const sent: { message: unknown; transfer?: Transferable[] }[] = []
    const target = {
      postMessage: (message: unknown, transfer?: Transferable[]) => {
        sent.push(transfer === undefined ? { message } : { message, transfer })
      },
      addEventListener: (_t: 'message', f: (e: { data?: unknown }) => void) => {
        listener = f
      },
    }
    const c = init(base(), { ...quiet, fetchImpl: recordingFetch().impl, instanceId: 'inst-1' })
    c.linkWorker(target)
    await settle(5)

    // A hello from an older collector, and anything outside the namespace, is
    // ignored.
    listener?.({ data: { __moqtap_collector__: 1, t: 'hello', v: 1 } })
    listener?.({ data: { t: 'hello' } })
    listener?.({ data: 'hello' })
    expect(sent).toEqual([])

    listener?.({ data: { __moqtap_collector__: 5, t: 'hello', timeOrigin: 0 } })
    expect(sent).toHaveLength(1)
    const linked = sent[0]?.message as Record<string, unknown>
    expect(linked).toMatchObject({ t: 'linked', sessionId: 'sess-fixed', instanceId: 'inst-1' })
    expect(JSON.stringify(linked)).not.toContain('pk_test')
    expect(sent[0]?.transfer?.[0]).toBeInstanceOf(MessagePort)
    await c.end()
  })

  it('records a link that is never answered as a timeout, per link', async () => {
    const { posts, impl } = recordingFetch()
    const c = init(base({ limits: { linkTimeoutMs: 20 } }), { ...quiet, fetchImpl: impl })
    attempt()
    c.linkWorker({ postMessage: () => {}, addEventListener: () => {} })
    c.linkWorker({ postMessage: () => {}, addEventListener: () => {} })
    await settle(40, 20)
    await c.end()

    const links = of(await allRecords(posts), 'link')
    expect(links.map((l: LinkRecord) => [l.link, l.ev])).toEqual([
      ['w1', 'timeout'],
      ['w2', 'timeout'],
    ])
  })

  it('carries a worker’s transports in the page’s own stream, rebased onto the page clock', async () => {
    const { posts, impl } = recordingFetch()
    const channel = new MessageChannel()
    const c = init(base(), { ...quiet, fetchImpl: impl, timeOrigin: 1_000 })
    c.linkWorker(channel.port1)
    await settle(5)

    // The worker half, in this realm: it claims the hook the page installed,
    // which makes the transports below the worker's. Its clock started three
    // seconds after the page's, so its own readings are three seconds behind.
    const probe = initWorkerWith(workerBuild, channel.port2, { timeOrigin: 4_000 })
    expect(await probe.linked).toBe(true)
    expect(probe.ids()).toEqual({ sessionId: c.ids().sessionId, instanceId: c.ids().instanceId })
    // The worker's connection begins the session; its calls count from then.
    const wt = await openTransport()
    probe.annotate('from-the-worker')
    await deliverControl(wt, [subscribeBytes(1n, 'video')])
    // Forwarded on the probe's own tick, with nothing asking for it.
    await settle(40, FORWARD_INTERVAL_MS)
    expect(c.connections()).toEqual([expect.objectContaining({ realm: 'worker', state: 'open' })])
    await c.end()

    const all = await allRecords(posts)
    expect(of(all, 'link')).toEqual([expect.objectContaining({ link: 'w1', ev: 'linked' })])
    const [conn] = connections(all).values()
    expect(conn).toMatchObject({ realm: 'worker', draft: 20 })
    // On the page's timeline: the worker's readings plus the three seconds,
    // less the moment the page took to hear of the attempt that began it.
    const opened = of(all, 'conn-open')[0] as ConnOpenRecord
    expect(opened.ts).toBeGreaterThan(2_900)
    expect(opened.ts).toBeLessThan(13_000)
    expect(of(all, 'ctrl').every((r) => r.conn === conn?.conn)).toBe(true)
    expect(of(all, 'note').map((n) => n.name)).toContain('from-the-worker')
    // Every body is the page's: one instance, numbered without a gap.
    const seqs = (await batchesOf(posts)).map((b) => b.seq)
    expect(seqs).toEqual(seqs.map((_, i) => i))
    channel.port1.close()
    channel.port2.close()
  })

  it('reports a terminated worker’s connections closed as worker-gone, at once', async () => {
    const { posts, impl } = recordingFetch()
    let listener: ((e: { data?: unknown }) => void) | undefined
    let port: MessagePort | undefined
    let terminated = 0
    const worker = {
      postMessage: (_m: unknown, transfer?: Transferable[]) => {
        port = transfer?.[0] as MessagePort | undefined
      },
      addEventListener: (_t: 'message', f: (e: { data?: unknown }) => void) => {
        listener = f
      },
      terminate: () => {
        terminated += 1
      },
    }
    const c = init(base(), { ...quiet, fetchImpl: impl })
    c.linkWorker(worker)
    await settle(5)
    listener?.({ data: { __moqtap_collector__: 5, t: 'hello', timeOrigin: 0 } })
    // Speak for the worker over the port the page handed it: it attempted a
    // connection, which begins the session, and that connection is open in
    // its last forward.
    port?.postMessage({ __moqtap_collector__: 5, t: 'open' })
    port?.postMessage({
      __moqtap_collector__: 5,
      t: 'fwd',
      n: 0,
      dropped: 0,
      ready: true,
      conns: [
        {
          conn: {
            id: 'w-conn',
            realm: 'worker',
            origin: 'https://relay.test',
            draft: 20,
            state: 'open',
          },
          rollup: null,
          counters: { parseFailures: 2, bucketsRefused: 0 },
        },
      ],
    })
    await settle(5)
    expect(c.connections()).toEqual([expect.objectContaining({ id: 'w-conn', realm: 'worker' })])

    worker.terminate()
    // The worker's own `terminate` still ran: the wrapper only observes.
    expect(terminated).toBe(1)
    await settle(5)
    // Sealed by the close, before anything ends the session.
    const all = await allRecords(posts)
    expect(of(all, 'link').map((l) => l.ev)).toEqual(['linked', 'gone'])
    expect(of(all, 'conn-close')).toEqual([
      expect.objectContaining({
        conn: 'w-conn',
        cause: 'worker-gone',
        counters: { parseFailures: 2, bucketsRefused: 0 },
      }),
    ])
    port?.close()
    await c.end()
  })
})

describe('a linked worker whose control plane outran it', () => {
  it('ends the page’s instance, with the worker’s own where and why', async () => {
    const { posts, impl } = recordingFetch()
    let listener: ((e: { data?: unknown }) => void) | undefined
    let port: MessagePort | undefined
    const target = {
      postMessage: (_m: unknown, transfer?: Transferable[]) => {
        port = transfer?.[0] as MessagePort | undefined
      },
      addEventListener: (_t: 'message', f: (e: { data?: unknown }) => void) => {
        listener = f
      },
    }
    const c = init(base(), { ...quiet, fetchImpl: impl })
    c.linkWorker(target)
    await settle(5)
    listener?.({ data: { __moqtap_collector__: 5, t: 'hello', timeOrigin: 0 } })
    port?.postMessage({ __moqtap_collector__: 5, t: 'open' })
    port?.postMessage({
      __moqtap_collector__: 5,
      t: 'overrun',
      at: 1_234,
      signal: 'control-plane rate exceeded 1/s',
    })
    await until(async () => of(await allRecords(posts), 'end').length > 0)

    const end = of(await allRecords(posts), 'end')[0] as EndRecord
    expect(end.reason).toBe('overrun')
    expect(end.counters).toMatchObject({
      overrunAt: 1_234,
      overrunSignal: 'control-plane rate exceeded 1/s',
    })
    port?.close()
    await c.end()
  })
})

describe('a linked worker that forwards more than the page buffers', () => {
  it('seals what the page holds and takes the rest, dropping nothing', async () => {
    const { posts, impl } = recordingFetch()
    let listener: ((e: { data?: unknown }) => void) | undefined
    let port: MessagePort | undefined
    const target = {
      postMessage: (_m: unknown, transfer?: Transferable[]) => {
        port = transfer?.[0] as MessagePort | undefined
      },
      addEventListener: (_t: 'message', f: (e: { data?: unknown }) => void) => {
        listener = f
      },
    }
    const c = init(base(), { ...quiet, fetchImpl: impl })
    c.linkWorker(target)
    await settle(5)
    listener?.({ data: { __moqtap_collector__: 5, t: 'hello', timeOrigin: 0 } })
    port?.postMessage({ __moqtap_collector__: 5, t: 'open' })
    await settle(5)
    // Ten frames parts of ~30 KB in one forward: more than the page's eight
    // thresholds of buffer before any byte seal has had a turn to run.
    const parts = Array.from({ length: 10 }, (_, i) => {
      const w = new FrameWriter()
      w.json({ t: 'note', ts: i, lvl: 'baseline', name: `big-${i}`, data: 'x'.repeat(30_000) })
      const frames = w.take().slice()
      return { frames: frames.buffer, byteLength: frames.byteLength, n: 1 }
    })
    port?.postMessage({
      __moqtap_collector__: 5,
      t: 'fwd',
      parts,
      n: parts.length,
      dropped: 0,
      ready: true,
      conns: [],
    })
    await settle(10)
    await c.end()

    const all = await allRecords(posts)
    expect(of(all, 'note').map((n) => n.name)).toEqual(parts.map((_, i) => `big-${i}`))
    expect((of(all, 'end')[0] as EndRecord).counters.chunksDropped).toBe(0)
    port?.close()
  })
})

describe('a linked worker that falls silent', () => {
  it('is counted gone after ten seconds of silence, and linked again when it speaks', async () => {
    const { posts, impl } = recordingFetch()
    let t = 0
    let listener: ((e: { data?: unknown }) => void) | undefined
    let port: MessagePort | undefined
    const target = {
      postMessage: (_m: unknown, transfer?: Transferable[]) => {
        port = transfer?.[0] as MessagePort | undefined
      },
      addEventListener: (_t: 'message', f: (e: { data?: unknown }) => void) => {
        listener = f
      },
    }
    const c = init(base(), {
      ...quiet,
      fetchImpl: impl,
      clock: { now: () => t, wall: () => t },
      // Only the once-a-second silence check runs fast.
      setTimer: (fn, ms) => setTimeout(fn, ms === 1_000 ? 10 : ms),
      clearTimer: (h) => clearTimeout(h as never),
    })
    c.linkWorker(target)
    await settle(5)
    listener?.({ data: { __moqtap_collector__: 5, t: 'hello', timeOrigin: 0 } })
    port?.postMessage({ __moqtap_collector__: 5, t: 'open' })
    await settle(5)
    t += 11_000
    // The heartbeat runs every 10 ms here; let one see the silence.
    await settle(10, 20)
    port?.postMessage({
      __moqtap_collector__: 5,
      t: 'fwd',
      n: 0,
      dropped: 0,
      ready: false,
      conns: [],
    })
    await settle(10)
    await c.end()

    const links = of(await allRecords(posts), 'link').map((l) => l.ev)
    expect(links).toEqual(['linked', 'gone', 'linked'])
    port?.close()
  })
  /**
   * A worker's rollup for `w-conn`: one track, `objects` objects of 10 bytes
   * each, and as many of every other additive count.
   */
  const rollup = (seq: number, objects: number, endMono = 0): RollupRecord =>
    ({
      t: 'rollup',
      v: 1,
      conn: 'w-conn',
      ts: endMono,
      lvl: 'baseline',
      seq,
      startMono: 0,
      endMono,
      tracks: [
        {
          key: { d: 'rx', k: 'alias', v: '1', e: 0 },
          firstSeen: 0,
          lastSeen: 0,
          objects,
          payloadBytes: objects * 10,
          headerBytes: 0,
          groups: objects,
          groupGaps: objects,
          outOfOrder: 0,
          duplicates: 0,
          statusObjects: 0,
          parseFailures: 0,
          gapRanges: Array.from({ length: objects }, (_, i) => [`${2 * i}`, `${2 * i}`]),
          resets: { '7': objects },
          hist: { stallMs: { i: [12], c: [objects], n: objects, sum: objects * 300 } },
        },
      ],
      session: { 'ctrl.rx.frames': objects },
    }) as unknown as RollupRecord

  /** `w-conn` open, its interval `seq` holding `objects` so far. */
  const open = (seq: number, objects: number | null) => ({
    conn: {
      id: 'w-conn',
      realm: 'worker',
      origin: 'https://relay.test',
      draft: 20,
      state: 'open',
    },
    rollup: objects === null ? null : rollup(seq, objects),
    counters: { parseFailures: 0, bucketsRefused: 0 },
  })

  /** A page with one linked worker whose messages the test writes, on a clock it moves. */
  async function silentWorker(): Promise<{
    posts: Post[]
    c: ReturnType<typeof init>
    port: () => MessagePort | undefined
    advance: (ms: number) => void
    terminate: () => void
  }> {
    const { posts, impl } = recordingFetch()
    let t = 0
    let listener: ((e: { data?: unknown }) => void) | undefined
    let port: MessagePort | undefined
    const target = {
      postMessage: (_m: unknown, transfer?: Transferable[]) => {
        port = transfer?.[0] as MessagePort | undefined
      },
      addEventListener: (_t: 'message', f: (e: { data?: unknown }) => void) => {
        listener = f
      },
      terminate: () => {},
    }
    const c = init(base(), {
      ...quiet,
      fetchImpl: impl,
      clock: { now: () => t, wall: () => t },
      setTimer: (fn, ms) => setTimeout(fn, ms === 1_000 ? 10 : ms),
      clearTimer: (h) => clearTimeout(h as never),
    })
    c.linkWorker(target)
    await settle(5)
    listener?.({ data: { __moqtap_collector__: 5, t: 'hello', timeOrigin: 0 } })
    port?.postMessage({ __moqtap_collector__: 5, t: 'open' })
    return {
      posts,
      c,
      port: () => port,
      advance: (ms) => {
        t += ms
      },
      terminate: () => target.terminate(),
    }
  }

  /** A forward with the intervals the worker `closed` since the last, and its open `conns`. */
  function forward(
    port: MessagePort | undefined,
    closed: readonly RollupRecord[],
    conns: readonly unknown[],
  ): void {
    port?.postMessage({
      __moqtap_collector__: 5,
      t: 'fwd',
      n: 0,
      dropped: 0,
      ready: true,
      ...(closed.length > 0 ? { rollups: closed } : {}),
      conns,
    })
  }

  /** The totals of `w-conn`'s rollups, each count apart. */
  const totalsOf = (all: readonly EnvelopeRecord[]) => {
    const sum = { objects: 0, payloadBytes: 0, groups: 0, gaps: 0, resets: 0, stalls: 0, frames: 0 }
    for (const r of of(all, 'rollup')) {
      if (r.conn !== 'w-conn') continue
      sum.frames += r.session['ctrl.rx.frames'] ?? 0
      for (const tr of r.tracks) {
        sum.objects += tr.objects
        sum.payloadBytes += tr.payloadBytes
        sum.groups += tr.groups
        sum.gaps += tr.groupGaps
        sum.gaps += tr.gapRanges?.length ?? 0
        sum.resets += Object.values(tr.resets ?? {}).reduce((a, b) => a + b, 0)
        sum.stalls += (tr.hist.stallMs?.c ?? []).reduce((a, b) => a + b, 0)
      }
    }
    return sum
  }

  /** Every total, for `n` objects' worth of each count. */
  const counted = (n: number) => ({
    objects: n,
    payloadBytes: n * 10,
    groups: n,
    gaps: 2 * n,
    resets: n,
    stalls: n,
    frames: n,
  })

  it('writes the interval it falls silent in at once, in a body of its own', async () => {
    const w = await silentWorker()
    forward(w.port(), [], [open(0, 5)])
    await settle(5)
    w.advance(11_000)
    await settle(10, 20)

    // Sealed and sent when it was counted gone, with the session still running.
    const sent = await allRecords(w.posts)
    expect(of(sent, 'link').map((l) => l.ev)).toEqual(['linked', 'gone'])
    expect(totalsOf(sent)).toEqual(counted(5))
    await w.c.end()

    expect(totalsOf(await allRecords(w.posts))).toEqual(counted(5))
    w.port()?.close()
  })

  it('counts the interval it was silent in once when it resumes and closes it', async () => {
    const w = await silentWorker()
    // Five objects into interval 0 as of the last forward before the freeze.
    forward(w.port(), [], [open(0, 5)])
    await settle(5)
    w.advance(11_000)
    await settle(10, 20)
    expect(totalsOf(await allRecords(w.posts))).toEqual(counted(5))
    // Resumed: it closes interval 0 with all eight of its objects, and opens 1.
    forward(w.port(), [rollup(0, 8, 12_000)], [open(1, null)])
    await settle(10)
    await w.c.end()

    const all = await allRecords(w.posts)
    expect(of(all, 'link').map((l) => l.ev)).toEqual(['linked', 'gone', 'linked'])
    expect(of(all, 'conn-close')[0]).toMatchObject({ conn: 'w-conn', cause: 'worker-gone' })
    expect(totalsOf(all)).toEqual(counted(8))
    w.port()?.close()
  })

  it('counts an interval it fell silent in twice once', async () => {
    const w = await silentWorker()
    forward(w.port(), [], [open(0, 5)])
    await settle(5)
    w.advance(11_000)
    await settle(10, 20)
    // Back for a moment, interval 0 still open, then silent again.
    forward(w.port(), [], [open(0, 6)])
    await settle(5)
    w.advance(11_000)
    await settle(10, 20)
    expect(totalsOf(await allRecords(w.posts))).toEqual(counted(6))
    forward(w.port(), [rollup(0, 9)], [open(1, 1)])
    await settle(10)
    await w.c.end()

    const all = await allRecords(w.posts)
    expect(of(all, 'link').map((l) => l.ev)).toEqual(['linked', 'gone', 'linked', 'gone', 'linked'])
    expect(totalsOf(all)).toEqual(counted(10))
    w.port()?.close()
  })

  it('counts the interval once when it resumes and the session ends before it closes it', async () => {
    const w = await silentWorker()
    forward(w.port(), [], [open(0, 5)])
    await settle(5)
    w.advance(11_000)
    await settle(10, 20)
    forward(w.port(), [], [open(0, 7)])
    await settle(10)
    await w.c.end()

    expect(totalsOf(await allRecords(w.posts))).toEqual(counted(7))
    w.port()?.close()
  })

  it('writes a terminated worker’s interval at once, and what it posted before dying once', async () => {
    const w = await silentWorker()
    forward(w.port(), [], [open(0, 5)])
    await settle(5)
    w.terminate()
    await settle(10)
    expect(totalsOf(await allRecords(w.posts))).toEqual(counted(5))
    // Posted before it died: interval 0 closed with seven objects, and two in 1.
    forward(w.port(), [rollup(0, 7)], [open(1, 2)])
    await settle(10)
    await w.c.end()

    const all = await allRecords(w.posts)
    expect(of(all, 'link').map((l) => l.ev)).toEqual(['linked', 'gone'])
    expect(totalsOf(all)).toEqual(counted(9))
    w.port()?.close()
  })
})

describe('the collector never throws into the page', () => {
  it('reports a bad option instead of propagating', async () => {
    const errors: unknown[] = []
    const c = init(
      base({ onInternalError: (e: unknown) => errors.push(e), metrics: { maxTracks: -1 } }),
      { ...quiet, fetchImpl: recordingFetch().impl },
    )
    await settle()
    expect(errors.length).toBeGreaterThan(0)
    await expect(c.end()).resolves.toBeUndefined()
  })

  it('survives an upload endpoint that rejects every request', async () => {
    const impl = (async () => {
      throw new TypeError('blackholed')
    }) as unknown as typeof fetch
    const c = init(base({ upload: { maxAttempts: 1 } }), { ...quiet, fetchImpl: impl })
    await settle()
    c.annotate('still-here', {})
    await expect(c.flush()).resolves.toBeUndefined()
    await expect(c.end()).resolves.toBeUndefined()
  })
})

/* ── drafts before -15 ───────────────────────────────────────────────────── */

/** Draft-14 `client-setup/two-versions` and `server-setup/basic` from `@moqtap/test-vectors`. */
const hex = (h: string): Uint8Array =>
  Uint8Array.from(h.match(/../g) ?? [], (b) => Number.parseInt(b, 16))
const CLIENT_SETUP_TWO_VERSIONS = hex('20001202c0000000ff00000dc0000000ff00000e00')
const SERVER_SETUP_14 = hex('210009c0000000ff00000e00')

/** The client's half of a pre-15 handshake: open the control stream, offer, read the pick. */
async function legacyHandshake(wt: MockWebTransport): Promise<void> {
  const bidi = (await wt.createBidirectionalStream()) as unknown as {
    readable: ReadableStream<Uint8Array>
    writable: WritableStream<Uint8Array>
    inbound: { push(b: Uint8Array): void; close(): void }
  }
  const writer = bidi.writable.getWriter()
  await writer.write(CLIENT_SETUP_TWO_VERSIONS)
  bidi.inbound.push(SERVER_SETUP_14)
  bidi.inbound.close()
  const reader = bidi.readable.getReader()
  for (;;) {
    const r = await reader.read()
    if (r.done) break
  }
}

describe('a pre-15 session over WebTransport', () => {
  it("reads the draft off the server's SETUP when no protocol was negotiated", async () => {
    const { posts, impl } = recordingFetch()
    const c = init(base(), { ...quiet, fetchImpl: impl })
    await settle()
    const wt = await openTransport('')
    await legacyHandshake(wt)
    await settle()
    await c.end()

    const [conn] = connections(await allRecords(posts)).values()
    expect(conn?.draft).toBe(14)
    expect(conn?.protocol).toBeNull()
    expect(conn?.degraded).toBeUndefined()
  })

  it('uploads as soon as the draft is known, not at the next scheduled seal', async () => {
    const { posts, impl } = recordingFetch()
    const c = init(base(), { ...quiet, fetchImpl: impl })
    await settle()
    const wt = await openTransport('')
    await legacyHandshake(wt)
    const draftOf = async (): Promise<number | null | undefined> =>
      [...connections(await allRecords(posts)).values()][0]?.draft
    await until(async () => (await draftOf()) === 14)

    expect(await draftOf()).toBe(14)
    await c.end()
  })

  it('keeps the draft of a handshake that crossed before init()', async () => {
    const { posts, impl } = recordingFetch()
    ensureDormantHook()
    const wt = new (g.WebTransport as new (u: string) => MockWebTransport)('https://relay.test/moq')
    await wt.open('')
    await legacyHandshake(wt)
    await settle(5)

    const c = init(base(), { ...quiet, fetchImpl: impl })
    await settle()
    await c.end()

    const all = await allRecords(posts)
    const [conn] = connections(all).values()
    expect(conn?.draft).toBe(14)
    expect(conn?.offered).toEqual([13, 14])
    // And the handshake itself: CLIENT_SETUP out, SERVER_SETUP in.
    expect(of(all, 'ctrl').map((r) => [r.dir, r.decoded])).toEqual([
      ['tx', true],
      ['rx', true],
    ])
  })

  it('sends the connection again when the transport is ready, before SETUP names the draft', async () => {
    const { posts, impl } = recordingFetch()
    const c = init(base(), { ...quiet, fetchImpl: impl })
    await settle()
    await openTransport('')
    await c.end()

    const opens = of(await allRecords(posts), 'conn-open')
    expect(opens.length).toBeGreaterThanOrEqual(2)
    expect(opens[0]?.readyTs).toBeUndefined()
    expect(opens[1]).toMatchObject({ draft: null, protocol: null })
    expect(opens[1]?.readyTs).toBeGreaterThanOrEqual(opens[0]?.ts as number)
  })

  it('reports the drafts offered in CLIENT_SETUP when the page passed no protocols', async () => {
    const { posts, impl } = recordingFetch()
    const c = init(base(), { ...quiet, fetchImpl: impl })
    await settle()
    const wt = await openTransport('')
    await legacyHandshake(wt)
    await settle()
    await c.end()

    const [conn] = connections(await allRecords(posts)).values()
    expect(conn).toMatchObject({ draft: 14, offered: [13, 14] })
  })

  it('leaves a connection that closes before SERVER_SETUP undegraded, with what it offered', async () => {
    const { posts, impl } = recordingFetch()
    const c = init(base(), { ...quiet, fetchImpl: impl })
    await settle()
    const wt = await openTransport('')
    const bidi = (await wt.createBidirectionalStream()) as unknown as {
      writable: WritableStream<Uint8Array>
    }
    await bidi.writable.getWriter().write(CLIENT_SETUP_TWO_VERSIONS)
    await settle()
    wt.closeSession()
    await settle()
    await c.end()

    const [conn] = connections(await allRecords(posts)).values()
    expect(conn?.draft).toBeNull()
    expect(conn?.degraded).toBeUndefined()
    expect(conn?.offered).toEqual([13, 14])
    expect(typeof conn?.readyTs).toBe('number')
  })

  it('says so when SERVER_SETUP selects a version this build cannot read', async () => {
    const { posts, impl } = recordingFetch()
    const c = init(base(), { ...quiet, fetchImpl: impl })
    await settle()
    const wt = await openTransport('')
    const bidi = (await wt.createBidirectionalStream()) as unknown as {
      readable: ReadableStream<Uint8Array>
      inbound: { push(b: Uint8Array): void; close(): void }
    }
    // SERVER_SETUP selecting draft-06.
    bidi.inbound.push(hex('210009c0000000ff00000600'))
    bidi.inbound.close()
    const reader = bidi.readable.getReader()
    while (!(await reader.read()).done) {}
    await settle()
    await c.end()

    const [conn] = connections(await allRecords(posts)).values()
    expect(conn?.draft).toBeNull()
    expect(conn?.degraded).toBe('unsupported-protocol')
  })
})

describe('the overrun policy', () => {
  it('stops collecting, ends the instance saying where, and still sends what it sealed', async () => {
    const { posts, impl } = recordingFetch()
    // One control frame per second is the whole budget, so the second frame in
    // the same second is the "fuzzing peer / relay flapping thousands of
    // streams" case, compressed into a test.
    const c = init(base({ limits: { controlRatePerSec: 1 } }), { ...quiet, fetchImpl: impl })
    await settle()
    const wt = await openTransport()
    const queue = wt.incomingBidirectionalStreams.getReader()
    await deliverControl(
      wt,
      [subscribeBytes(1n, 'video'), subscribeBytes(2n, 'audio'), subscribeBytes(3n, 'text')],
      queue,
    )
    await settle()

    const all = await allRecords(posts)
    const end = of(all, 'end')[0] as EndRecord
    expect(end.reason).toBe('overrun')
    expect(end.counters.overrunSignal).toMatch(/control-plane rate exceeded 1\/s/)
    expect((await batchesOf(posts)).at(-1)?.final).toBe(true)

    // Nothing further is collected.
    const before = of(all, 'ctrl').length
    await deliverControl(wt, [subscribeBytes(5n, 'ignored')], queue)
    await settle()
    expect(of(await allRecords(posts), 'ctrl').length).toBe(before)
    await c.end()
  })
})

/* ── the page going away ─────────────────────────────────────────────────── */

describe('the page going away', () => {
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

  /** Every body the beacon was handed at `pagehide`, in order. */
  async function beaconed(
    persisted: boolean,
    before?: (c: ReturnType<typeof init>) => void,
  ): Promise<{ urls: string[]; bodies: EnvelopeRecord[][] }> {
    const life = captureLifecycle()
    try {
      const urls: string[] = []
      const blobs: Blob[] = []
      const c = init(base(), {
        persist: false,
        locks: null,
        fetchImpl: recordingFetch().impl,
        beacon: (url, blob) => {
          urls.push(url)
          blobs.push(blob)
          return true
        },
      })
      attempt()
      // The session's first body goes out as it begins, before the page goes.
      await c.flush()
      before?.(c)
      life.fire('pagehide', { persisted })
      const bodies: EnvelopeRecord[][] = []
      for (const b of blobs) bodies.push(await recordsOf(new Uint8Array(await b.arrayBuffer())))
      await c.discard()
      return { urls, bodies }
    } finally {
      life.restore()
    }
  }

  it('beacons the end record first, in a small body of its own, then the tail', async () => {
    const { bodies } = await beaconed(false, (c) => c.annotate('in-the-tail'))
    // The session's first body went out as it began; these two follow it.
    expect(bodies).toHaveLength(2)
    const [endBody, tail] = bodies
    // The connection still being attempted is closed by the end.
    expect(endBody?.map((r) => r.t)).toEqual(['batch', 'conn-close', 'end'])
    expect(endBody?.[2]).toMatchObject({ reason: 'unload', finalSeq: 2 })
    expect(endBody?.[0]).toMatchObject({ seq: 2, final: true })
    expect(tail?.[0]).toMatchObject({ seq: 1 })
    expect(tail?.some((r) => r.t === 'note')).toBe(true)
  })

  it('beacons a body whose upload is under way after the ones never sent', async () => {
    const life = captureLifecycle()
    try {
      const blobs: Blob[] = []
      let sent = 0
      // The session's first body is uploaded; the next one's upload never ends.
      const hanging = ((_url: string, _init: RequestInit) => {
        sent += 1
        return sent === 1
          ? Promise.resolve(new Response(null, { status: 200 }))
          : new Promise(() => {})
      }) as unknown as typeof fetch
      const c = init(base(), {
        persist: false,
        locks: null,
        fetchImpl: hanging,
        beacon: (_url, blob) => {
          blobs.push(blob)
          return true
        },
      })
      attempt()
      await c.flush()
      c.annotate('in-flight')
      void c.flush()
      await settle()
      expect(sent).toBe(2)
      c.annotate('never-sent')
      life.fire('pagehide', { persisted: false })

      const seqs: number[] = []
      for (const b of blobs) {
        const [batch] = await recordsOf(new Uint8Array(await b.arrayBuffer()))
        seqs.push((batch as BatchRecord).seq)
      }
      // The end's body, the tail, then the one already on its way.
      expect(seqs).toEqual([3, 2, 1])
      await c.discard()
    } finally {
      life.restore()
    }
  })

  it('carries the ingest credential, the key and the instance in the URL', async () => {
    const { urls, bodies } = await beaconed(false)
    const url = new URL(urls[0] as string)
    expect(url.searchParams.get('k')).toBe('pk_test')
    expect(url.searchParams.get('ik')).toBe((bodies[0]?.[0] as BatchRecord).idempotencyKey)
    expect(url.searchParams.get('i')).toBe((bodies[0]?.[0] as BatchRecord).instanceId)
  })

  it('does not end the instance when the page enters the back/forward cache', async () => {
    const { bodies } = await beaconed(true, (c) => c.annotate('before-freeze'))
    const all = bodies.flat()
    expect(all.some((r) => r.t === 'end')).toBe(false)
    expect(of(all, 'life').map((l) => l.ev)).toEqual(['frozen'])
  })

  it('marks the gap when a frozen page is restored', async () => {
    const life = captureLifecycle()
    try {
      const { posts, impl } = recordingFetch()
      const c = init(base(), { persist: false, locks: null, fetchImpl: impl, beacon: () => true })
      attempt()
      await settle()
      life.fire('pagehide', { persisted: true })
      life.fire('pageshow', { persisted: true })
      await c.end()
      const resumed = of(await allRecords(posts), 'life').find((l) => l.ev === 'resumed')
      expect(resumed?.gapMs).toBeGreaterThanOrEqual(0)
    } finally {
      life.restore()
    }
  })

  it('still delivers the tail when a blocker has removed or stubbed sendBeacon', async () => {
    const life = captureLifecycle()
    try {
      const { calls, impl } = tailFetch()
      const c = init(base(), { persist: false, locks: null, fetchImpl: impl, beacon: () => false })
      attempt()
      // The session's first body, sent as it began.
      await c.flush()
      const before = calls.length
      life.fire('pagehide', { persisted: false })
      const tail = calls.slice(before)
      expect(tail).toHaveLength(1)
      expect(tail[0]?.init.keepalive).toBe(true)
      expect(new URL(tail[0]?.url ?? '').searchParams.get('k')).toBe('pk_test')
      await c.discard()
    } finally {
      life.restore()
    }
  })

  it('reports the loss when nothing takes it, and keeps the stored copy', async () => {
    const life = captureLifecycle()
    const gf = globalThis as { fetch?: typeof fetch | undefined }
    const savedFetch = gf.fetch
    try {
      const errors: unknown[] = []
      gf.fetch = undefined
      const s = await store()
      const c = init(base({ onInternalError: (e) => errors.push(e) }), {
        store: s,
        locks: null,
        beacon: () => false,
      })
      attempt()
      await settle()
      life.fire('pagehide', { persisted: false })
      await settle(5)

      // The end's body, and the begin's, which no upload could take either.
      expect(errors.map(String).filter((e) => /MQ5001/.test(e))).toHaveLength(2)
      // The next page load on the origin sends them.
      expect(s.chunks).toBe(2)
      await c.discard()
    } finally {
      gf.fetch = savedFetch
      life.restore()
    }
  })

  it('meters a tail that left, and not one that nothing accepted', async () => {
    const run = async (accepted: boolean): Promise<number> => {
      const life = captureLifecycle()
      const gf = globalThis as { fetch?: typeof fetch | undefined }
      const savedFetch = gf.fetch
      try {
        gf.fetch = undefined
        const c = init(base({ onInternalError: () => undefined }), {
          persist: false,
          locks: null,
          beacon: () => accepted,
        })
        attempt()
        // The session's first body, sent as it began.
        await c.flush()
        const before = c.usage().bytesByLevel.baseline
        life.fire('pagehide', { persisted: false })
        const bytes = c.usage().bytesByLevel.baseline - before
        await c.discard()
        return bytes
      } finally {
        gf.fetch = savedFetch
        life.restore()
      }
    }
    expect(await run(true)).toBeGreaterThan(0)
    expect(await run(false)).toBe(0)
  })

  it('closes the capture window when the page unloads, and stops billing there', async () => {
    const life = captureLifecycle()
    let t = 0
    try {
      const c = init(base(), {
        persist: false,
        locks: null,
        fetchImpl: recordingFetch().impl,
        beacon: () => true,
        clock: { now: () => t, wall: () => t },
      })
      attempt()
      await settle()
      c.escalate('headers', 'user reported a stall')
      t += 200
      life.fire('pagehide', { persisted: false })
      t += 600_000
      // Ten minutes of a page that has gone away. Without the unload close
      // the window is still open and the meter has billed every second of it.
      expect(c.usage().elevatedSeconds).toBe(1)
    } finally {
      life.restore()
    }
  })

  it('records the page being hidden, and sends what it holds', async () => {
    const life = captureLifecycle()
    const doc = globalThis as { document?: unknown }
    const savedDoc = doc.document
    try {
      const { posts, impl } = recordingFetch()
      let t = 0
      const c = init(base(), {
        persist: false,
        locks: null,
        fetchImpl: impl,
        clock: { now: () => t, wall: () => t },
      })
      attempt()
      await settle()
      c.annotate('before-hide')
      t += 10_000
      doc.document = { visibilityState: 'hidden' }
      life.fire('visibilitychange')
      await until(async () => of(await allRecords(posts), 'life').length > 0)
      const all = await allRecords(posts)
      expect(of(all, 'life').map((l) => l.ev)).toEqual(['hidden'])
      expect(of(all, 'note').map((n) => n.name)).toEqual(['before-hide'])
      doc.document = { visibilityState: 'visible' }
      life.fire('visibilitychange')
      await c.end()
      expect(of(await allRecords(posts), 'life').map((l) => l.ev)).toEqual(['hidden', 'visible'])
    } finally {
      doc.document = savedDoc
      life.restore()
    }
  })

  /**
   * Every `pagehide` listener, dispatched the way a window does: capture
   * listeners first, then the rest, each in the order added, and one removed
   * during the dispatch is skipped.
   */
  function pagehideListeners(): {
    added: { capture: boolean }[]
    fire(e: { persisted: boolean }): void
    restore(): void
  } {
    const gg = globalThis as unknown as Record<string, unknown>
    const prevAdd = gg.addEventListener
    const prevRemove = gg.removeEventListener
    const added: { f: (e: unknown) => void; capture: boolean }[] = []
    gg.addEventListener = (t: string, f: (e: unknown) => void, capture?: boolean) => {
      if (t === 'pagehide') added.push({ f, capture: capture === true })
    }
    gg.removeEventListener = (t: string, f: (e: unknown) => void, capture?: boolean) => {
      if (t !== 'pagehide') return
      const i = added.findIndex((l) => l.f === f && l.capture === (capture === true))
      if (i >= 0) added.splice(i, 1)
    }
    return {
      added,
      fire: (e) => {
        const order = [...added.filter((l) => l.capture), ...added.filter((l) => !l.capture)]
        for (const l of order) if (added.includes(l)) l.f(e)
      },
      restore: () => {
        gg.addEventListener = prevAdd
        gg.removeEventListener = prevRemove
      },
    }
  }

  it('listens for pagehide in the capture phase first, then twice', async () => {
    const life = pagehideListeners()
    try {
      const c = init(base(), { persist: false, locks: null, beacon: () => true })
      await settle()
      expect(life.added.map((l) => l.capture)).toEqual([true, false, false])
      await c.discard()
      expect(life.added).toEqual([])
    } finally {
      life.restore()
    }
  })

  /**
   * Firefox stops a `pagehide` listener at a call when it closes the tab. A
   * clock that throws on its `stopAt`-th reading after the close stands in
   * for that, at each of the seven points the unload reads it; the eighth run
   * is not stopped, and the second listener must then send nothing more.
   */
  it('finishes an unload stopped part-way, from the second listener', async () => {
    for (let stopAt = 1; stopAt <= 8; stopAt++) {
      const life = pagehideListeners()
      try {
        let armed = false
        let reads = 0
        const clock = {
          now: () => {
            if (armed && ++reads === stopAt) throw new Error('stopped')
            return performance.now()
          },
          wall: () => Date.now(),
        }
        const blobs: Blob[] = []
        const c = init(base(), {
          persist: false,
          locks: null,
          clock,
          fetchImpl: recordingFetch().impl,
          beacon: (_url, blob) => {
            blobs.push(blob)
            return true
          },
        })
        attempt()
        await settle()
        c.annotate('in-the-tail')
        armed = true
        life.fire({ persisted: false })
        const bodies: EnvelopeRecord[][] = []
        for (const b of blobs) bodies.push(await recordsOf(new Uint8Array(await b.arrayBuffer())))
        const all = bodies.flat()
        expect(of(all, 'end')[0], `stopped at read ${stopAt}`).toMatchObject({ reason: 'unload' })
        expect(
          of(all, 'note').map((n) => n.name),
          `stopped at read ${stopAt}`,
        ).toContain('in-the-tail')
        expect(bodies.some((b) => (b[0] as BatchRecord).final === true)).toBe(true)
        // Each body is handed over once.
        const keys = bodies.map((b) => (b[0] as BatchRecord).idempotencyKey)
        expect(new Set(keys).size).toBe(keys.length)
        await c.discard()
      } finally {
        life.restore()
      }
    }
  }, 30_000)
})

describe('conn-close carries its counters', () => {
  it('reports the connection’s parse failures and refused buckets', async () => {
    const { posts, impl } = recordingFetch()
    const c = init(base(), { ...quiet, fetchImpl: impl })
    await settle()
    const wt = await openTransport()
    wt.closeSession()
    await settle()
    await c.end()
    const close = of(await allRecords(posts), 'conn-close')[0] as ConnCloseRecord
    expect(close.counters).toEqual({ parseFailures: 0, bucketsRefused: 0 })
  })
})

/* ── one page, several sessions ──────────────────────────────────────────── */

/** Every record that arrived, grouped by the session its body belongs to. */
async function bySession(posts: readonly Post[]): Promise<Map<string, EnvelopeRecord[]>> {
  const out = new Map<string, EnvelopeRecord[]>()
  const seen = new Set<string>()
  for (const p of posts) {
    const records = await recordsOf(p.body)
    const batch = records[0] as BatchRecord
    if (seen.has(batch.idempotencyKey)) continue
    seen.add(batch.idempotencyKey)
    out.set(batch.sessionId, [...(out.get(batch.sessionId) ?? []), ...records])
  }
  return out
}

describe('newSession() — the next playback in the same page', () => {
  it('ends the first session in a final body and numbers the second from zero', async () => {
    const { posts, impl } = recordingFetch()
    const c = init(base(), { ...quiet, fetchImpl: impl })
    attempt()
    await settle()
    c.annotate('first')
    const first = c.ids()
    const second = c.newSession({ contentId: 'movie-2' })
    expect(second.sessionId).not.toBe(first.sessionId)
    expect(second.instanceId).not.toBe(first.instanceId)
    expect(second.contentId).toBe('movie-2')
    expect(c.ids()).toEqual(second)
    c.annotate('second')
    await c.end()

    const sessions = await bySession(posts)
    const a = sessions.get(first.sessionId) ?? []
    const b = sessions.get(second.sessionId) ?? []
    expect(of(a, 'end').map((e) => e.reason)).toEqual(['new-session'])
    expect(of(a, 'note').map((n) => n.name)).toEqual(['first'])
    expect(of(b, 'end').map((e) => e.reason)).toEqual(['app'])
    expect(of(b, 'note').map((n) => n.name)).toEqual(['second'])
    const setup = of(b, 'setup')[0]
    expect(setup?.identity).toMatchObject({
      sessionId: second.sessionId,
      instanceId: second.instanceId,
      contentId: 'movie-2',
    })
    expect(setup?.idSource).toBe('minted')
    // The second session runs on the first one's clock, from where it began.
    expect(of(a, 'setup')[0]?.startTs).toBeUndefined()
    expect(setup?.startTs).toBeGreaterThanOrEqual(0)
    expect(setup?.startTs).toBeLessThanOrEqual(of(b, 'end')[0]?.ts as number)
    for (const records of [a, b]) {
      const batches = of(records, 'batch')
      expect(batches.map((x) => x.seq)).toEqual(batches.map((_, i) => i))
      expect(batches.at(-1)?.final).toBe(true)
    }
  })

  it('keeps observing: a transport still open continues in the new session', async () => {
    const { posts, impl } = recordingFetch()
    const c = init(base(), { ...quiet, fetchImpl: impl })
    await settle()
    const wt = await openTransport()
    const conn = c.connectionIdOf(wt as unknown as WebTransport)
    const first = c.ids()
    const second = c.newSession()
    await settle(5)
    expect(g.WebTransport).not.toBe(MockWebTransport)
    await c.end()

    const sessions = await bySession(posts)
    const closed = of(sessions.get(first.sessionId) ?? [], 'conn-close')
    expect(closed).toEqual([expect.objectContaining({ conn, cause: 'session-end' })])
    const reopened = connections(sessions.get(second.sessionId) ?? [])
    expect([...reopened.keys()]).toEqual([conn])
    expect(reopened.get(conn as string)).toMatchObject({ draft: 20 })
  })

  it('takes a supplied session id, and mints one in place of an id ingest cannot store', async () => {
    const errors: unknown[] = []
    const c = init(base({ onInternalError: (e) => errors.push(e) }), {
      ...quiet,
      fetchImpl: recordingFetch().impl,
    })
    await settle()
    expect(c.newSession({ sessionId: 'playback-7' }).sessionId).toBe('playback-7')
    const minted = c.newSession({ sessionId: 'x'.repeat(200) })
    expect(minted.sessionId).not.toBe('x'.repeat(200))
    expect(String(errors[0])).toContain('MQ1113')
    await c.end()
  })

  it('works before setup has finished, in the order the calls were made', async () => {
    const { posts, impl } = recordingFetch()
    const c = init(base(), { ...quiet, fetchImpl: impl })
    attempt()
    c.annotate('first')
    const second = c.newSession()
    c.annotate('second')
    expect(c.ids()).toEqual(second)
    await settle()
    expect(c.ids()).toEqual(second)
    await c.end()

    const sessions = await bySession(posts)
    expect(of(sessions.get('sess-fixed') ?? [], 'note').map((n) => n.name)).toEqual(['first'])
    expect(of(sessions.get(second.sessionId) ?? [], 'note').map((n) => n.name)).toEqual(['second'])
  })

  it('starts nothing once the collector has ended', async () => {
    const { posts, impl } = recordingFetch()
    const c = init(base(), { ...quiet, fetchImpl: impl })
    await settle()
    await c.end()
    const before = posts.length
    expect(c.newSession()).toEqual(c.ids())
    await settle()
    expect(posts.length).toBe(before)
  })

  it('sends the first session’s unsent bodies from the second', async () => {
    let up = false
    const { posts, impl } = recordingFetch(() => (up ? 200 : 0))
    const c = init(base({ upload: { maxAttempts: 1 } }), { ...quiet, fetchImpl: impl })
    attempt()
    await settle()
    c.annotate('offline')
    const first = c.ids()
    await c.flush()
    c.newSession()
    up = true
    await c.flush()
    await c.end()

    const notes = of((await bySession(posts)).get(first.sessionId) ?? [], 'note')
    expect(notes.map((n) => n.name)).toEqual(['offline'])
  })

  it('deletes every stored body on discard(), the earlier sessions’ included', async () => {
    const s = await store()
    const dest = { endpoint: ENDPOINT, keyHash: sha256Hex('pk_test') }
    const { impl } = recordingFetch(0)
    const c = init(base({ upload: { maxAttempts: 1 } }), { ...quiet, store: s, fetchImpl: impl })
    attempt()
    await settle()
    c.annotate('first')
    await c.flush()
    c.newSession()
    c.annotate('second')
    await c.flush()
    const sessions = (): number => new Set(s.backlog(dest).map((e) => e.sessionId)).size
    await until(() => sessions() === 2)
    expect(sessions()).toBe(2)
    await c.discard()
    expect(s.backlog(dest)).toEqual([])
  })

  it('takes a linked worker along, with its open connections', async () => {
    const { posts, impl } = recordingFetch()
    const channel = new MessageChannel()
    const c = init(base(), { ...quiet, fetchImpl: impl, timeOrigin: 1_000 })
    c.linkWorker(channel.port1)
    await settle(5)
    const probe = initWorkerWith(workerBuild, channel.port2, { timeOrigin: 1_000 })
    expect(await probe.linked).toBe(true)
    const wt = await openTransport()
    const conn = probe.connectionIdOf(wt as unknown as WebTransport)
    expect(conn).toBeDefined()
    // The page learns of the worker's connection from its next forward.
    await settle(40, FORWARD_INTERVAL_MS)

    const first = c.ids()
    const second = c.newSession()
    await settle()
    expect(probe.ids()).toEqual({ sessionId: second.sessionId, instanceId: second.instanceId })
    probe.annotate('after', undefined, conn)
    await settle(40, FORWARD_INTERVAL_MS)
    await c.end()

    const sessions = await bySession(posts)
    const a = sessions.get(first.sessionId) ?? []
    const b = sessions.get(second.sessionId) ?? []
    expect(of(a, 'conn-close')).toEqual([expect.objectContaining({ conn, cause: 'session-end' })])
    expect(of(b, 'link')).toEqual([expect.objectContaining({ link: 'w1', ev: 'linked' })])
    expect(connections(b).get(conn as string)).toMatchObject({ realm: 'worker', draft: 20 })
    expect(of(b, 'note')).toEqual([expect.objectContaining({ name: 'after', conn })])
    channel.port1.close()
    channel.port2.close()
  })
})

describe('setContext(), connectionIdOf() and scoped annotations', () => {
  it('stamps connections opened after setContext() with the new content id', async () => {
    const { posts, impl } = recordingFetch()
    const c = init(base({ context: { contentId: 'movie-1' } }), { ...quiet, fetchImpl: impl })
    await settle()
    const one = await openTransport()
    c.setContext({ contentId: 'movie-2', actorId: 'viewer-3' })
    expect(c.ids()).toMatchObject({ contentId: 'movie-2', actorId: 'viewer-3' })
    const two = await openTransport()
    await c.end()

    const conns = connections(await allRecords(posts))
    const idOf = (wt: MockWebTransport): string =>
      c.connectionIdOf(wt as unknown as WebTransport) as string
    expect(conns.get(idOf(one))?.contentId).toBe('movie-1')
    expect(conns.get(idOf(two))?.contentId).toBe('movie-2')
  })

  it('answers connectionIdOf() with the id the records carry, and nothing for a stranger', async () => {
    const { posts, impl } = recordingFetch()
    const c = init(base(), { ...quiet, fetchImpl: impl })
    await settle()
    const wt = await openTransport()
    const id = c.connectionIdOf(wt as unknown as WebTransport)
    expect(c.connections().map((x) => x.id)).toEqual([id])
    expect(c.connectionIdOf({} as WebTransport)).toBeUndefined()
    c.annotate('stall', { ms: 800 }, id)
    await c.end()

    const all = await allRecords(posts)
    expect([...connections(all).keys()]).toEqual([id])
    expect(of(all, 'note')).toEqual([
      expect.objectContaining({ name: 'stall', conn: id, data: { ms: 800 } }),
    ])
  })
})

/* ── before the session attaches ─────────────────────────────────────────── */

/** A recognisable token, and a SUBSCRIBE carrying it as a USE_VALUE Authorization Token. */
const SECRET = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0xca, 0xfe, 0xba, 0xbe])

function subscribeWithToken(): Uint8Array {
  return encodeControl({
    type: 'subscribe',
    request_id: 4n,
    track_namespace: ['moqtap', 'test'],
    track_name: 'video',
    parameters: {
      authorization_token: [{ alias_type: 3n, token_type: 0n, token_value: SECRET }],
    },
  } as Parameters<typeof encodeControl>[0])
}

function contains(haystack: Uint8Array, needle: Uint8Array): boolean {
  outer: for (let i = 0; i + needle.length <= haystack.length; i += 1) {
    for (let j = 0; j < needle.length; j += 1) {
      if (haystack[i + j] !== needle[j]) continue outer
    }
    return true
  }
  return false
}

/** Read a receive stream to its end in the background, as a player does. */
function readAll(stream: ReadableStream<Uint8Array>): Promise<void> {
  const reader = stream.getReader()
  return (async (): Promise<void> => {
    for (;;) {
      const r = await reader.read()
      if (r.done) break
    }
  })()
}

/** The worker's records in the forwards a page received, decoded. */
function forwardedRecords(forwards: readonly ForwardMessage[]): EnvelopeRecord[] {
  const decoder = new TextDecoder()
  const all: EnvelopeRecord[] = []
  for (const f of forwards) {
    for (const part of f.parts ?? []) {
      if (!('frames' in part)) throw new Error('a small forward arrives uncompressed')
      for (const frame of readFrames(new Uint8Array(part.frames, 0, part.byteLength))) {
        if (!frame.raw) all.push(JSON.parse(decoder.decode(frame.payload)) as EnvelopeRecord)
      }
    }
  }
  return all
}

describe('nothing before the session attaches is lost', () => {
  it('replays the control messages of a handshake that finished before init()', async () => {
    const { posts, impl } = recordingFetch()
    expect(contains(subscribeWithToken(), SECRET)).toBe(true)
    ensureDormantHook()
    const wt = await openTransport()
    await deliverControl(wt, [subscribeWithToken(), subscribeBytes(5n, 'audio')])

    const c = init(base(), { ...quiet, fetchImpl: impl })
    await settle()
    await c.end()

    const all = await allRecords(posts)
    const [conn] = connections(all).values()
    expect(conn).toMatchObject({ draft: 20 })
    const ctrl = of(all, 'ctrl')
    expect(ctrl).toHaveLength(2)
    expect(ctrl.every((r) => r.conn === conn?.conn && r.decoded)).toBe(true)
    // Masked on replay, as a live frame is.
    for (const p of posts) expect(contains(await framesOf(p.body), SECRET)).toBe(false)
    expect((of(all, 'end')[0] as EndRecord).counters.parseFailures).toBe(0)
  })

  it('replays a worker’s control messages when its link arrives after the handshake', async () => {
    // The worker's realm alone. The test plays the page, over the channel the
    // probe's hello went out on.
    const channel = new MessageChannel()
    const hellos: unknown[] = []
    channel.port1.onmessage = (e) => hellos.push(e.data)
    const probe = initWorkerWith(workerBuild, channel.port2, { timeOrigin: 0 })

    const wt = await openTransport()
    await deliverControl(wt, [subscribeBytes(1n, 'video'), subscribeBytes(2n, 'audio')])
    await settle(5)
    expect(hellos).toHaveLength(1)
    expect(dormantState()?.early.controlBytes).toBeGreaterThan(0)

    const page = new MessageChannel()
    const forwards: ForwardMessage[] = []
    page.port1.onmessage = (e) => {
      const m = linkMessage(e.data)
      if (m?.t === 'fwd') forwards.push(m as unknown as ForwardMessage)
    }
    const { metrics, flightRecorder, limits, privacy, upload, context } = resolveConfig(base())
    const linked: LinkedMessage = {
      t: 'linked',
      sessionId: 'sess-fixed',
      instanceId: 'inst-1',
      base: 0,
      level: 'baseline',
      room: 8 * 1024 * 1024,
      config: { metrics, flightRecorder, limits, privacy, upload, context },
    }
    channel.port1.postMessage(envelope(linked), [page.port2])
    expect(await probe.linked).toBe(true)
    page.port1.postMessage(envelope({ t: 'forward' }))
    await settle(10)

    const all = forwardedRecords(forwards)
    const [conn] = connections(all).values()
    expect(conn).toMatchObject({ realm: 'worker', draft: 20 })
    const ctrl = of(all, 'ctrl')
    expect(ctrl).toHaveLength(2)
    expect(ctrl.every((r) => r.conn === conn?.conn && r.decoded)).toBe(true)
    expect(dormantState()?.early.controlBytes).toBe(0)

    page.port1.postMessage(envelope({ t: 'unlinked' }))
    await settle(5)
    channel.port1.close()
    page.port1.close()
  })

  it('releases what a worker held when no page ever links it', async () => {
    let timeout: (() => void) | undefined
    const probe = initWorkerWith(workerBuild, undefined, {
      target: { postMessage: () => {}, addEventListener: () => {} },
      setTimer: (fn) => {
        timeout = fn
      },
      timeOrigin: 0,
    })
    const wt = await openTransport()
    await deliverControl(wt, [subscribeBytes(1n, 'video')])
    expect(dormantState()?.early.controlBytes).toBeGreaterThan(0)

    timeout?.()
    expect(await probe.linked).toBe(false)
    expect(dormantState()?.early.controlBytes).toBe(0)
    const later = await openTransport()
    await deliverControl(later, [subscribeBytes(2n, 'video')])
    expect(dormantState()?.early.controlBytes).toBe(0)
  })

  it('counts what overflowed as dropped, and skips the rest of a stream it cut', async () => {
    const { posts, impl } = recordingFetch()
    const frame = subscribeBytes(1n, 'v'.repeat(1000))
    const size = 4096
    const count = Math.ceil((80 * 1024) / frame.length)
    const parts = chunks(concatBytes(...Array.from({ length: count }, () => frame)), size)
    const held = EARLY_CONTROL_CONNECTION_BYTES / size
    ensureDormantHook()
    const wt = await openTransport()
    const stream = wt.deliverBidiStream(parts)
    const arrived = await wt.incomingBidirectionalStreams.getReader().read()
    const reading = readAll((arrived.value as { readable: ReadableStream<Uint8Array> }).readable)
    await settle(5)

    const c = init(base(), { ...quiet, fetchImpl: impl })
    await settle()
    // The rest of the stream the buffer cut. Decoding it would start
    // mid-frame, so it is counted instead.
    stream.inbound.push(frame)
    stream.inbound.push(frame)
    stream.inbound.close()
    await reading
    await settle()
    await c.end()

    const all = await allRecords(posts)
    expect(of(all, 'ctrl')).toHaveLength(Math.floor(EARLY_CONTROL_CONNECTION_BYTES / frame.length))
    expect((of(all, 'end')[0] as EndRecord).counters.sampledTypes).toContain('early-control')
    const last = (await batchesOf(posts)).at(-1)
    expect(last?.dropped).toBe(parts.length - held + 2)
  })

  it('counts object data from before init() on its connection, and decodes none of it', async () => {
    const { posts, impl } = recordingFetch()
    ensureDormantHook()
    const wt = await openTransport()
    const src = wt.deliverUniStream([Uint8Array.of(0x10, 1, 2, 3)])
    const arrived = await wt.incomingUnidirectionalStreams.getReader().read()
    const reading = readAll(arrived.value as ReadableStream<Uint8Array>)
    await settle(5)

    const c = init(base(), { ...quiet, fetchImpl: impl })
    await settle()
    src.push(Uint8Array.of(9, 9, 9, 9, 9))
    src.close()
    await reading
    await c.end()

    const all = await allRecords(posts)
    const counted = (name: string): number =>
      of(all, 'rollup').reduce((n, r) => n + (r.session[name] ?? 0), 0)
    expect(counted('early.dataChunks')).toBe(2)
    expect(counted('early.dataBytes')).toBe(9)
    expect((of(all, 'end')[0] as EndRecord).counters.parseFailures).toBe(0)
  })
})
