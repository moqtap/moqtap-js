/**
 * Several WebTransports in one page load: at once on the same relay and path,
 * and in a linked worker beside the page. Each connection keeps its own
 * ordinal, id, `conn[]` entry, runs, control frames, bytes and end.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetDormantForTest, teardownDormant } from '../../api/dormant.js'
import { CONN_SPACE, envelope, type LinkedMessage, linkMessage } from '../../api/link.js'
import { ProbeRuntime } from '../../api/probe.js'
import type { LinkEvent } from '../../api/session.js'
import { installWebTransportHook } from '../../transport/index.js'
import type { CollectorConfig, ConnOpenRecord, EnvelopeRecord } from '../../types.js'
import { subgroupBytes, subscribeBytes, subscribeOkBytes } from '../decode/vectors.js'
import { init, workerBuild } from '../support/init.js'
import { allFacts, type DecodedBw, factsOf } from '../support/runs.js'
import { settle, until } from '../support/settle.js'
import { allRecords, of, type Post, recordingFetch } from '../support/uploads.js'
import { MockWebTransport } from '../transport/mocks.js'

const g = globalThis as unknown as Record<string, unknown>
let originalWT: unknown

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

const config: CollectorConfig = { apiKey: 'pk_test', endpoint: 'https://ingest.test/v1/ingest' }
const quiet = { persist: false, noLifecycleListeners: true, locks: null } as const

type Ctor = new (url: string) => MockWebTransport

interface Conn {
  readonly wt: MockWebTransport
  readonly uni: ReadableStreamDefaultReader<ReadableStream<Uint8Array>>
}

async function openOn(glob: { WebTransport?: unknown }, url: string): Promise<Conn> {
  const wt = new (glob.WebTransport as Ctor)(url)
  await wt.open('moqt-20')
  await settle(5)
  return { wt, uni: wt.incomingUnidirectionalStreams.getReader() }
}

const open = (url: string) => openOn(g, url)

async function subscribe(c: Conn, name: string, alias: bigint): Promise<void> {
  const bidi = (await c.wt.createBidirectionalStream()) as unknown as {
    readable: ReadableStream<Uint8Array>
    writable: WritableStream<Uint8Array>
    inbound: { push(b: Uint8Array): void }
  }
  await bidi.writable.getWriter().write(subscribeBytes(0n, name))
  bidi.inbound.push(subscribeOkBytes(alias))
  await bidi.readable.getReader().read()
  await settle(5)
}

/** Start a subgroup stream of `n` objects on `c`, read its bytes; the returned call ends it. */
async function startGroup(
  c: Conn,
  alias: bigint,
  group: bigint,
  n: number,
): Promise<() => Promise<void>> {
  const objects = Array.from({ length: n }, (_, i) => ({ id: BigInt(i), bytes: 10 }))
  const src = c.wt.deliverUniStream([subgroupBytes({ alias, group, objects })])
  const arrived = await c.uni.read()
  const reader = (arrived.value as ReadableStream<Uint8Array>).getReader()
  await reader.read()
  await settle(2)
  return async () => {
    src.close()
    for (;;) if ((await reader.read()).done) break
    await settle(2)
  }
}

/** What ingest would merge each connection's `conn-open` records into, by ordinal. */
function opened(all: readonly EnvelopeRecord[]): Map<number, ConnOpenRecord> {
  const out = new Map<number, ConnOpenRecord>()
  for (const r of of(all, 'conn-open')) out.set(r.c, { ...out.get(r.c), ...r })
  return out
}

/** Each ordinal's relay, from every body's `conn[]`, failing on two relays for one ordinal. */
function listed(all: readonly EnvelopeRecord[]): Map<number, string> {
  const out = new Map<number, string>()
  for (const b of of(all, 'batch')) {
    for (const e of b.conn) {
      const was = out.get(e.c)
      if (was !== undefined) expect(e.relay).toBe(was)
      out.set(e.c, e.relay)
    }
  }
  return out
}

/** `[c, group, objects]` of every run, sorted. */
async function runsOf(posts: readonly Post[]): Promise<[number, bigint, number][]> {
  const { runs } = await allFacts(posts.map((p) => p.body))
  return runs.map((r) => [r.c, r.g, r.ids.length] as [number, bigint, number]).sort()
}

/** Received bytes per ordinal, summed over every `bw` entry. */
async function receivedBytes(posts: readonly Post[]): Promise<Map<number, number>> {
  const bw: DecodedBw[] = []
  for (const p of posts) bw.push(...(await factsOf(p.body)).bw)
  const out = new Map<number, number>()
  for (const e of bw) {
    if (e.sent) continue
    const n = e.pre + e.secs.reduce((s, [, b]) => s + b, 0)
    out.set(e.c, (out.get(e.c) ?? 0) + n)
  }
  return out
}

describe('connections at once in the page', () => {
  it('to the same relay and path, with the same alias and groups, interleaved, keep apart', async () => {
    const { posts, impl } = recordingFetch()
    const m = init(config, { ...quiet, fetchImpl: impl })
    await settle()
    const url = 'https://relay.test/moq'
    const conns = [await open(url), await open(url), await open(url)]
    for (const c of conns) await subscribe(c, 'video', 4n)
    // Group 0 open on every connection at once, each a different size.
    const ends: (() => Promise<void>)[] = []
    for (const [i, c] of conns.entries()) ends.push(await startGroup(c, 4n, 0n, i + 1))
    for (const end of ends.reverse()) await end()
    await (await startGroup(conns[1]!, 4n, 1n, 4))()
    const ids = conns.map((c) => m.connectionIdOf(c.wt as unknown as WebTransport))
    await m.end()

    const all = await allRecords(posts)
    const conn = opened(all)
    expect([...conn.keys()].sort()).toEqual([0, 1, 2])
    expect(new Set(ids).size).toBe(3)
    // The ordinal the page constructed in order, and the id connectionIdOf() gave it.
    expect([0, 1, 2].map((c) => conn.get(c)?.conn)).toEqual(ids)
    expect([...listed(all)].sort()).toEqual([
      [0, url],
      [1, url],
      [2, url],
    ])
    expect(await runsOf(posts)).toEqual(
      [
        [0, 0n, 1],
        [1, 0n, 2],
        [1, 1n, 4],
        [2, 0n, 3],
      ].sort(),
    )
    // Every control frame names the connection it crossed, by id and ordinal.
    const ctrl = of(all, 'ctrl')
    expect(ctrl).toHaveLength(6)
    for (const r of ctrl) expect(conn.get(r.c ?? -1)?.conn).toBe(r.conn)
    expect(ctrl.map((r) => [r.c, r.dir]).sort()).toEqual(
      [0, 1, 2].flatMap((c) => [
        [c, 'rx'],
        [c, 'tx'],
      ]),
    )
    // Received bytes per connection grow with the objects it carried.
    const rx = await receivedBytes(posts)
    expect(rx.get(1)!).toBeGreaterThan(rx.get(2)!)
    expect(rx.get(2)!).toBeGreaterThan(rx.get(0)!)
  })

  it('end each on its own: relay close, page close, failure, and one left open', async () => {
    const { posts, impl } = recordingFetch()
    const m = init(config, { ...quiet, fetchImpl: impl })
    await settle()
    const urls = [
      'https://relay-a.test/moq',
      'https://relay-a.test/moq',
      'https://relay-b.test/live',
      'https://relay-b.test/live',
    ]
    const conns: Conn[] = []
    for (const u of urls) conns.push(await open(u))
    conns[2]!.wt.errorSession(new Error('network lost'))
    await settle()
    conns[0]!.wt.closeSession('draining', 3)
    await settle()
    conns[1]!.wt.close({ closeCode: 7, reason: 'source switch' })
    await settle()
    // Still open on its relay while the others end.
    await (await startGroup(conns[3]!, 9n, 2n, 2))()
    const state = new Map(m.connections().map((s) => [s.id, s.state]))
    expect(
      conns.map((c) => state.get(m.connectionIdOf(c.wt as unknown as WebTransport) ?? '')),
    ).toEqual(['closed', 'closed', 'closed', 'open'])
    await m.end()

    const all = await allRecords(posts)
    const conn = opened(all)
    const closes = of(all, 'conn-close')
    expect(closes.map((r) => [r.c, r.cause, r.by, r.code, r.reason])).toEqual([
      [2, 'failed', 'local', undefined, undefined],
      [0, 'closed', 'relay', 3, 'draining'],
      [1, 'closed', 'client', 7, 'source switch'],
    ])
    for (const r of closes) expect(r.conn).toBe(conn.get(r.c)?.conn)
    expect([...listed(all)].sort()).toEqual(urls.map((u, i) => [i, u]))
    expect(await runsOf(posts)).toEqual([[3, 2n, 2]])
  })
})

/** A worker realm of its own: its own hooked `WebTransport` and probe, linked to the page. */
async function spawnWorker(page: ReturnType<typeof init>): Promise<{
  realm: { WebTransport?: unknown }
  terminate: () => void
  close: () => void
}> {
  const realm: { WebTransport?: unknown } = { WebTransport: MockWebTransport }
  const listeners: ((e: LinkEvent) => void)[] = []
  const ports: MessagePort[] = []
  let probe: ProbeRuntime | undefined
  const worker = {
    postMessage: (message: unknown, transfer?: Transferable[]) => {
      const msg = linkMessage(message)
      const port = transfer?.[0] as MessagePort | undefined
      if (msg?.t !== 'linked' || port === undefined) return
      ports.push(port)
      probe = new ProbeRuntime(
        msg as unknown as LinkedMessage,
        port,
        installWebTransportHook(realm, null),
        workerBuild,
        {},
      )
      probe.start()
    },
    addEventListener: (_t: 'message', f: (e: LinkEvent) => void) => {
      listeners.push(f)
    },
    terminate: () => {},
  }
  page.linkWorker(worker)
  for (const f of listeners) f({ data: envelope({ t: 'hello', timeOrigin: 0 }) })
  await until(() => probe !== undefined)
  return {
    realm,
    terminate: () => worker.terminate(),
    close: () => {
      for (const p of ports) p.close()
    },
  }
}

describe('a connection in a worker beside one in the page', () => {
  it('each with its own ordinal range, relay path, runs, control frames and bytes', async () => {
    const { posts, impl } = recordingFetch()
    const m = init(config, { ...quiet, fetchImpl: impl })
    await settle()
    const pageConn = await open('https://relay.test/page/moq')
    const w = await spawnWorker(m)
    const workerConn = await openOn(w.realm, 'https://relay.test/worker/moq')
    await subscribe(pageConn, 'video', 4n)
    await subscribe(workerConn, 'audio', 4n)
    const endPage = await startGroup(pageConn, 4n, 0n, 2)
    const endWorker = await startGroup(workerConn, 4n, 0n, 5)
    await endWorker()
    await endPage()
    await until(() => m.connections().length === 2, 3_000)
    // Forwarded on the probe's own tick.
    await settle(10, 600)
    await m.end()

    const all = await allRecords(posts)
    const conn = opened(all)
    const W = CONN_SPACE
    expect([...conn.keys()].sort((a, b) => a - b)).toEqual([0, W])
    expect(conn.get(0)).toMatchObject({ realm: 'page' })
    expect(conn.get(W)).toMatchObject({ realm: 'worker' })
    expect(conn.get(0)?.conn).toBe(m.connectionIdOf(pageConn.wt as unknown as WebTransport))
    expect(conn.get(0)?.conn).not.toBe(conn.get(W)?.conn)
    expect([...listed(all)].sort((a, b) => a[0] - b[0])).toEqual([
      [0, 'https://relay.test/page/moq'],
      [W, 'https://relay.test/worker/moq'],
    ])
    expect(await runsOf(posts)).toEqual([
      [0, 0n, 2],
      [W, 0n, 5],
    ])
    const ctrl = of(all, 'ctrl')
    expect(ctrl.map((r) => [r.c, r.dir]).sort()).toEqual([
      [0, 'rx'],
      [0, 'tx'],
      [W, 'rx'],
      [W, 'tx'],
    ])
    for (const r of ctrl) expect(conn.get(r.c ?? -1)?.conn).toBe(r.conn)
    const rx = await receivedBytes(posts)
    expect(rx.get(W)!).toBeGreaterThan(rx.get(0)!)
    // One instance and one numbering for both realms.
    const batches = of(all, 'batch')
    expect(new Set(batches.map((b) => b.instanceId)).size).toBe(1)
    w.close()
  })

  it('ends each on its own: the worker’s by the relay, the page’s left open, then worker-gone', async () => {
    const { posts, impl } = recordingFetch()
    const m = init(config, { ...quiet, fetchImpl: impl })
    await settle()
    const pageConn = await open('https://relay.test/page/moq')
    const w = await spawnWorker(m)
    const first = await openOn(w.realm, 'https://relay.test/worker/a')
    await openOn(w.realm, 'https://relay.test/worker/b')
    await until(() => m.connections().length === 3, 3_000)
    first.wt.closeSession('bye', 5)
    await until(async () => of(await allRecords(posts), 'conn-close').length === 1, 3_000)
    w.terminate()
    await until(async () => of(await allRecords(posts), 'conn-close').length === 2, 3_000)
    await (await startGroup(pageConn, 9n, 0n, 1))()
    await m.end()

    const all = await allRecords(posts)
    const conn = opened(all)
    const W = CONN_SPACE
    expect([...conn.keys()].sort((a, b) => a - b)).toEqual([0, W, W + 1])
    expect(of(all, 'conn-close').map((r) => [r.c, r.cause, r.by, r.code])).toEqual([
      [W, 'closed', 'relay', 5],
      [W + 1, 'worker-gone', undefined, undefined],
    ])
    for (const r of of(all, 'conn-close')) expect(r.conn).toBe(conn.get(r.c)?.conn)
    // The page's connection outlived the worker, carried data and has no end.
    expect(await runsOf(posts)).toEqual([[0, 0n, 1]])
    expect(of(all, 'end').map((e) => e.reason)).toEqual(['app'])
    w.close()
  })

  it('two workers and the page, each connection in its own ordinal range', async () => {
    const { posts, impl } = recordingFetch()
    const m = init(config, { ...quiet, fetchImpl: impl })
    await settle()
    await open('https://relay.test/page')
    const w1 = await spawnWorker(m)
    const w2 = await spawnWorker(m)
    const a = await openOn(w1.realm, 'https://relay.test/w1')
    const b = await openOn(w2.realm, 'https://relay.test/w2')
    await subscribe(a, 'video', 4n)
    await subscribe(b, 'video', 4n)
    await (await startGroup(a, 4n, 3n, 2))()
    await (await startGroup(b, 4n, 3n, 3))()
    await until(() => m.connections().length === 3, 3_000)
    await settle(10, 600)
    await m.end()

    const all = await allRecords(posts)
    const conn = opened(all)
    const ords = [...conn.keys()].sort((x, y) => x - y)
    expect(ords).toHaveLength(3)
    expect(ords[0]).toBe(0)
    const [, o1, o2] = ords as [number, number, number]
    // Each worker's ordinals come from its own range, never the page's or the other's.
    expect(Math.floor(o1 / CONN_SPACE)).not.toBe(Math.floor(o2 / CONN_SPACE))
    expect(o1 % CONN_SPACE).toBe(0)
    expect(o2 % CONN_SPACE).toBe(0)
    const relays = listed(all)
    expect([relays.get(0), relays.get(o1), relays.get(o2)]).toEqual([
      'https://relay.test/page',
      'https://relay.test/w1',
      'https://relay.test/w2',
    ])
    expect(await runsOf(posts)).toEqual(
      [
        [o1, 3n, 2],
        [o2, 3n, 3],
      ].sort(),
    )
    expect(new Set([...conn.values()].map((c) => c.conn)).size).toBe(3)
    w1.close()
    w2.close()
  })
})

describe('the page unloading with several connections', () => {
  it('ends each still open as page-end, once, in the page and the worker, and no closed one again', async () => {
    const gg = globalThis as unknown as Record<string, unknown>
    const prev = gg.addEventListener as (t: string, f: unknown, ...r: unknown[]) => void
    const handlers = new Map<string, (e: unknown) => void>()
    gg.addEventListener = (t: string, f: (e: unknown) => void, ...r: unknown[]) => {
      if (['pagehide', 'pageshow', 'visibilitychange', 'online'].includes(t)) handlers.set(t, f)
      else prev?.call(globalThis, t, f, ...r)
    }
    try {
      const { posts, impl } = recordingFetch()
      const beaconed: Blob[] = []
      const m = init(config, {
        persist: false,
        locks: null,
        fetchImpl: impl,
        beacon: (_url, blob) => {
          beaconed.push(blob)
          return true
        },
      })
      await settle()
      const pageA = await open('https://relay.test/a')
      await open('https://relay.test/b')
      const w = await spawnWorker(m)
      await openOn(w.realm, 'https://relay.test/w')
      await until(() => m.connections().length === 3, 3_000)
      await settle(10, 600)
      pageA.wt.closeSession('done', 0)
      await settle()
      await m.flush()
      handlers.get('pagehide')?.({ persisted: false })
      const bodies: Post[] = [...posts]
      for (const b of beaconed)
        bodies.push({ url: '', body: new Uint8Array(await b.arrayBuffer()) })

      const all = await allRecords(bodies)
      const conn = opened(all)
      const W = CONN_SPACE
      expect([...conn.keys()].sort((a, b) => a - b)).toEqual([0, 1, W])
      expect(
        of(all, 'conn-close')
          .map((r) => [r.c, r.cause])
          .sort((a, b) => (a[0] as number) - (b[0] as number)),
      ).toEqual([
        [0, 'closed'],
        [1, 'page-end'],
        [W, 'page-end'],
      ])
      for (const r of of(all, 'conn-close')) expect(r.conn).toBe(conn.get(r.c)?.conn)
      expect(of(all, 'end').map((e) => e.reason)).toEqual(['unload'])
      await m.discard()
      w.close()
    } finally {
      gg.addEventListener = prev
    }
  })
})
