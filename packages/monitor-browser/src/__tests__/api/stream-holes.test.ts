/**
 * The ways a session's upload stream can be left with a hole, each driven
 * through the page and its links and checked against what ingest derives:
 * an instance's bodies numbered `0 … n` with none missing, each under the one
 * key `sha256(sessionId:instanceId:seq)`, and nothing declared lost that was
 * not.
 *
 *  1. a worker's records uploaded through the page, then an unload whose
 *     beacon is taken or refused;
 *  2. a worker's hello that arrives while the page is still starting;
 *  3. two pages of the same session numbering at the same moment;
 *  4. a worker terminated while its records are on their way;
 *  5. an upload that fails while the page lives on;
 *  6. the page unloading while a seal is still being stored.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetDormantForTest, teardownDormant } from '../../api/dormant.js'
import { envelope } from '../../api/link.js'
import type { LinkEvent } from '../../api/session.js'
import { initWorkerWith } from '../../api/worker.js'
import {
  BODY_PREAMBLE_BYTES,
  FrameWriter,
  readFrames,
  readPreamble,
  sha256Hex,
} from '../../envelope/index.js'
import { type ChunkBackend, ChunkStore, MemoryBackend } from '../../flush/index.js'
import type {
  BatchRecord,
  CollectorConfig,
  EndRecord,
  EnvelopeRecord,
  LinkRecord,
} from '../../types.js'
import { attempt, init, workerBuild } from '../support/init.js'
import { settle } from '../support/settle.js'
import { MockWebTransport } from '../transport/mocks.js'

const g = globalThis as unknown as Record<string, unknown>
const MB = 1024 * 1024
let originalWT: unknown

/** One body as ingest received it. */
interface Received {
  readonly via: 'fetch' | 'beacon'
  readonly key: string
  readonly records: EnvelopeRecord[]
}

async function recordsOf(body: Uint8Array): Promise<EnvelopeRecord[]> {
  const pre = readPreamble(body)
  expect(pre).not.toBeNull()
  let frames = body.subarray(BODY_PREAMBLE_BYTES)
  if ((pre as { gzipped: boolean }).gzipped) {
    const ds = new DecompressionStream('gzip')
    const out = new Response(new Blob([frames as unknown as BlobPart]).stream().pipeThrough(ds))
    frames = new Uint8Array(await out.arrayBuffer())
  }
  const text = new TextDecoder()
  const out: EnvelopeRecord[] = []
  for (const f of readFrames(frames)) if (!f.raw) out.push(JSON.parse(text.decode(f.payload)))
  return out
}

/** An ingest that records every body and fails while `down()` says so. */
function ingest(down: () => boolean = () => false): {
  received: Received[]
  fetchImpl: typeof fetch
  beacon: (url: string, blob: Blob) => boolean
  settled: () => Promise<void>
} {
  const received: Received[] = []
  const pending: Promise<void>[] = []
  const take = (via: Received['via'], url: string, bytes: Promise<Uint8Array>): void => {
    pending.push(
      bytes.then(async (b) => {
        const key = new URL(url).searchParams.get('ik') ?? ''
        received.push({ via, key, records: await recordsOf(b) })
      }),
    )
  }
  return {
    received,
    fetchImpl: (async (url: string, req: RequestInit) => {
      if (down()) throw new TypeError('network down')
      const body = req.body
      take(
        'fetch',
        url,
        body instanceof Blob
          ? body.arrayBuffer().then((b) => new Uint8Array(b))
          : Promise.resolve(new Uint8Array(body as unknown as ArrayBufferLike as never)),
      )
      return { ok: true, status: 202, headers: { get: () => null } } as unknown as Response
    }) as unknown as typeof fetch,
    beacon: (url, blob) => {
      if (down()) return false
      take(
        'beacon',
        url,
        blob.arrayBuffer().then((b) => new Uint8Array(b)),
      )
      return true
    },
    settled: async () => {
      await Promise.all(pending)
    },
  }
}

/**
 * What ingest derives for each instance: the bodies it holds, by key, and the
 * numbers missing below the highest one it has seen.
 */
function view(
  received: readonly Received[],
): Map<
  string,
  { seqs: number[]; missing: number[]; final: number | undefined; end: EndRecord | undefined }
> {
  const byKey = new Map<string, Received>()
  for (const r of received) {
    const batch = r.records[0] as BatchRecord
    expect(batch.t).toBe('batch')
    expect(r.key).toBe(batch.idempotencyKey)
    expect(batch.idempotencyKey).toBe(
      sha256Hex(`${batch.sessionId}:${batch.instanceId}:${batch.seq}`),
    )
    expect(batch.lost ?? []).toEqual([])
    const first = byKey.get(r.key)
    if (first === undefined) byKey.set(r.key, r)
    else expect(r.records).toEqual(first.records)
  }
  const out = new Map<
    string,
    { seqs: number[]; missing: number[]; final: number | undefined; end: EndRecord | undefined }
  >()
  for (const r of byKey.values()) {
    const batch = r.records[0] as BatchRecord
    const v = out.get(batch.instanceId) ?? {
      seqs: [],
      missing: [],
      final: undefined,
      end: undefined,
    }
    v.seqs.push(batch.seq)
    if (batch.final === true) v.final = batch.seq
    v.end ??= r.records.find((x): x is EndRecord => x.t === 'end')
    out.set(batch.instanceId, v)
  }
  for (const v of out.values()) {
    v.seqs.sort((a, b) => a - b)
    const have = new Set(v.seqs)
    for (let i = 0; i <= Math.max(-1, ...v.seqs); i += 1) if (!have.has(i)) v.missing.push(i)
  }
  return out
}

/** Every record of one type, across every body. */
const all = <T extends EnvelopeRecord['t']>(received: readonly Received[], t: T) =>
  received.flatMap((r) => r.records.filter((x) => x.t === t)) as Extract<EnvelopeRecord, { t: T }>[]

const base = (over: Partial<CollectorConfig> = {}): CollectorConfig => ({
  apiKey: 'pk_test',
  endpoint: 'https://ingest.test/v1/ingest',
  sessionId: 'sess-holes',
  ...over,
})

/** The page's `pagehide`, captured so the test can fire it. */
function lifecycle(): { fire(persisted: boolean): void; restore(): void } {
  const prev = g.addEventListener
  let pagehide: ((e: unknown) => void) | undefined
  g.addEventListener = (t: string, f: (e: unknown) => void) => {
    if (t === 'pagehide') pagehide = f
  }
  return {
    fire: (persisted) => pagehide?.({ persisted }),
    restore: () => {
      g.addEventListener = prev
    },
  }
}

/**
 * A `Worker` as the page sees it, spoken for by the test: `hello()` is the
 * worker's first message, and `forward()` posts what a probe would forward
 * over the private channel the page hands back.
 */
function fakeWorker(): {
  target: {
    postMessage(m: unknown, transfer?: Transferable[]): void
    addEventListener(t: 'message', f: (e: LinkEvent) => void): void
    terminate(): void
  }
  hello(): void
  forward(...names: string[]): void
  close(): void
} {
  let listener: ((e: LinkEvent) => void) | undefined
  let port: MessagePort | undefined
  return {
    target: {
      postMessage: (_m, transfer) => {
        port = transfer?.[0] as MessagePort | undefined
      },
      addEventListener: (_t, f) => {
        listener = f
      },
      terminate: () => {},
    },
    hello: () => listener?.({ data: envelope({ t: 'hello', timeOrigin: 0 }) }),
    forward: (...names) => {
      const w = new FrameWriter()
      for (const name of names) w.json({ t: 'note', ts: 0, lvl: 'baseline', name, data: null })
      const frames = w.take()
      port?.postMessage(
        envelope({
          t: 'fwd',
          parts: [{ frames: frames.buffer, byteLength: frames.byteLength, n: names.length }],
          n: names.length,
          dropped: 0,
          ready: true,
          conns: [],
        }),
        [frames.buffer],
      )
    },
    close: () => port?.close(),
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

describe('a worker’s records uploaded through the page, then an unload', () => {
  async function run(beaconOk: boolean) {
    const backend = new MemoryBackend()
    let down = false
    const net = ingest(() => down)
    const life = lifecycle()
    try {
      const page = init(base({ upload: { intervalMs: 80, earlyFlushesMs: [] } }), {
        store: await ChunkStore.open('db', MB, { backend }),
        locks: null,
        fetchImpl: net.fetchImpl,
        beacon: net.beacon,
      })
      attempt()
      const channel = new MessageChannel()
      page.linkWorker(channel.port1)
      const probe = initWorkerWith(workerBuild, channel.port2)
      expect(await probe.linked).toBe(true)
      for (let i = 0; i < 5; i += 1) {
        probe.annotate('tick', { i })
        await settle(40, 120)
      }
      await net.settled()
      const live = view(net.received)
      page.annotate('in-the-tail')
      down = !beaconOk
      life.fire(false)
      await settle()
      channel.port1.close()

      // The next page load on the origin sends what the unload could not.
      down = false
      const next = init(base(), {
        store: await ChunkStore.open('db', MB, { backend }),
        persist: false,
        noLifecycleListeners: true,
        locks: null,
        clock: { now: () => performance.now(), wall: () => Date.now() + 600_000 },
        fetchImpl: net.fetchImpl,
      })
      // It sends them once a session begins there.
      attempt()
      await settle()
      await next.end()
      await net.settled()
      return { live, page: page.ids().instanceId, after: view(net.received) }
    } finally {
      life.restore()
    }
  }

  it('leaves no hole while the page lives', async () => {
    const { live, page } = await run(true)
    expect(live.get(page)?.seqs.length).toBeGreaterThan(1)
    expect(live.get(page)?.missing).toEqual([])
  })

  it('ends the instance with every body, the beacon taken', async () => {
    const { after, page } = await run(true)
    const v = after.get(page)
    expect(v?.missing).toEqual([])
    expect(v?.final).toBe(v?.seqs.at(-1))
    expect(v?.end).toMatchObject({ reason: 'unload', finalSeq: v?.final })
  })

  it('ends the instance with every body, the beacon refused', async () => {
    const { after, page } = await run(false)
    const v = after.get(page)
    expect(v?.missing).toEqual([])
    expect(v?.end).toMatchObject({ reason: 'unload', finalSeq: v?.seqs.at(-1) })
  })
})

describe('a worker’s hello that arrives while the page is still starting', () => {
  it('links the worker', async () => {
    const net = ingest()
    // No store supplied: opening one is asynchronous, so the page is not
    // running yet when the worker answers.
    const page = init(base(), {
      noLifecycleListeners: true,
      locks: null,
      fetchImpl: net.fetchImpl,
    })
    attempt()
    const w = fakeWorker()
    page.linkWorker(w.target)
    w.hello()
    await settle()
    w.forward('from-the-worker')
    await settle()
    await page.end()
    await net.settled()

    const links = all(net.received, 'link').map((l: LinkRecord) => [l.link, l.ev])
    expect(links).toEqual([['w1', 'linked']])
    expect(all(net.received, 'note').map((n) => n.name)).toEqual(['from-the-worker'])
    w.close()
  })

  it('links a replacement worker as well as the first', async () => {
    const net = ingest()
    const page = init(base(), { noLifecycleListeners: true, locks: null, fetchImpl: net.fetchImpl })
    attempt()
    const a = fakeWorker()
    page.linkWorker(a.target)
    await settle()
    a.hello()
    const b = fakeWorker()
    page.linkWorker(b.target)
    b.hello()
    await page.end()
    await net.settled()

    expect(all(net.received, 'link').map((l) => [l.link, l.ev])).toEqual([
      ['w1', 'linked'],
      ['w2', 'linked'],
    ])
    for (const r of net.received) expect((r.records[0] as BatchRecord).dropped).toBe(0)
    a.close()
    b.close()
  })
})

describe('two pages of the same session numbering at the same moment', () => {
  it('number independently, under keys that never collide', async () => {
    const backend = new MemoryBackend()
    const net = ingest()
    const open = async () =>
      init(base(), {
        store: await ChunkStore.open('db', MB, { backend }),
        noLifecycleListeners: true,
        locks: null,
        fetchImpl: net.fetchImpl,
      })
    // One realm has one hook, so the first page begins before the second
    // takes the hook over; the second begins on the connection still open.
    const a = await open()
    attempt()
    const b = await open()
    // Each session's first body, sent as it began.
    await Promise.all([a.flush(), b.flush()])
    a.annotate('a')
    b.annotate('b')
    await Promise.all([a.end(), b.end()])
    await net.settled()

    const v = view(net.received)
    expect([...v.keys()].sort()).toEqual([a.ids().instanceId, b.ids().instanceId].sort())
    // Each: the connection's first upload, the annotation, and the end.
    for (const instance of v.values()) {
      expect(instance.seqs).toEqual([0, 1, 2])
      expect(instance.missing).toEqual([])
    }
    expect(new Set(net.received.map((r) => r.key)).size).toBe(6)
  })
})

describe('a worker terminated while its records are on their way', () => {
  it('leaves no hole, and the next worker continues the same stream', async () => {
    const net = ingest()
    const page = init(base(), {
      persist: false,
      noLifecycleListeners: true,
      locks: null,
      fetchImpl: net.fetchImpl,
    })
    attempt()
    const a = fakeWorker()
    page.linkWorker(a.target)
    a.hello()
    a.forward('a-1')
    await settle()
    await page.flush()
    // Posted, then terminated before the page has read it.
    a.forward('a-2')
    a.target.terminate()
    const b = fakeWorker()
    page.linkWorker(b.target)
    b.hello()
    b.forward('b-1')
    await settle()
    await page.end()
    await net.settled()

    const v = view(net.received).get(page.ids().instanceId)
    expect(v?.missing).toEqual([])
    expect(v?.end?.finalSeq).toBe(v?.seqs.at(-1))
    expect(all(net.received, 'note').map((n) => n.name)).toEqual(['a-1', 'a-2', 'b-1'])
    a.close()
    b.close()
  })
})

describe('an upload that fails while the page lives on', () => {
  it('is sent again by the same page, ahead of the bodies after it', async () => {
    let calls = 0
    const net = ingest(() => ++calls === 1)
    const page = init(base({ upload: { maxAttempts: 1 } }), {
      persist: false,
      noLifecycleListeners: true,
      locks: null,
      fetchImpl: net.fetchImpl,
    })
    attempt()
    for (let i = 0; i < 3; i += 1) {
      page.annotate('tick', { i })
      await page.flush()
    }
    await net.settled()

    const v = view(net.received).get(page.ids().instanceId)
    expect(v?.seqs).toEqual([0, 1, 2])
    expect(net.received.map((r) => (r.records[0] as BatchRecord).seq)).toEqual([0, 1, 2])
    await page.end()
  })
})

describe('the page unloading while a seal is still being stored', () => {
  it('numbers the tail and the end after it, each under its own key', async () => {
    const backend = new MemoryBackend()
    const slow: ChunkBackend = Object.create(backend)
    slow.put = async (entry, chunk) => {
      await new Promise((r) => setTimeout(r, 200))
      return backend.put(entry, chunk)
    }
    const net = ingest()
    const life = lifecycle()
    try {
      const page = init(base(), {
        store: await ChunkStore.open('db', MB, { backend: slow }),
        locks: null,
        fetchImpl: net.fetchImpl,
        beacon: net.beacon,
      })
      attempt()
      const w = fakeWorker()
      page.linkWorker(w.target)
      w.hello()
      w.forward('w-1', 'w-2', 'w-3')
      await settle()
      page.annotate('sealing')
      void page.flush()
      w.forward('w-4')
      await settle()
      page.annotate('in-the-tail')
      life.fire(false)
      await settle(40, 400)
      await net.settled()

      const v = view(net.received).get(page.ids().instanceId)
      expect(v?.seqs.length).toBeGreaterThanOrEqual(3)
      expect(v?.missing).toEqual([])
      expect(v?.final).toBe(v?.seqs.at(-1))
      expect(v?.end).toMatchObject({ reason: 'unload', finalSeq: v?.final })
      expect(new Set(all(net.received, 'note').map((n) => n.name))).toEqual(
        new Set(['w-1', 'w-2', 'w-3', 'w-4', 'sealing', 'in-the-tail']),
      )
      w.close()
    } finally {
      life.restore()
    }
  })
})
