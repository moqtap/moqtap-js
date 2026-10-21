/**
 * Object headers while detail is raised.
 *
 * Raising detail is metered and spends the device's elevated minutes, so what
 * it buys has to arrive: one `hdr` record per object counted inside the
 * window, naming its connection, and nothing outside it. The levels differ by
 * exactly what the dial says: `headers` carries no size, `headers+sizes` adds
 * it, and `headers+data` ships the same record, never a payload byte.
 *
 * `hdr` is droppable: when the buffer nears its cap, headers give way and the
 * records that explain them stay whole.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveConfig } from '../../api/config.js'
import { resetDormantForTest, teardownDormant } from '../../api/dormant.js'
import { envelope, type ForwardMessage, type LinkedMessage, linkMessage } from '../../api/link.js'
import { initWorkerWith } from '../../api/worker.js'
import { draftSet } from '../../draft/index.js'
import { ALL_ADAPTERS } from '../../drafts/all.js'
import { BODY_PREAMBLE_BYTES, readFrames, readPreamble } from '../../envelope/index.js'
import type {
  BatchRecord,
  CollectorConfig,
  DetailLevel,
  EndRecord,
  EnvelopeRecord,
  HdrRecord,
} from '../../types.js'
import { datagramBytes, subgroupBytes, subscribeBytes } from '../decode/vectors.js'
import { init } from '../support/init.js'
import { settle } from '../support/settle.js'
import { MockWebTransport } from '../transport/mocks.js'

const g = globalThis as unknown as Record<string, unknown>
let originalWT: unknown

interface Post {
  readonly body: Uint8Array
}

function recordingFetch(): { posts: Post[]; impl: typeof fetch } {
  const posts: Post[] = []
  const impl = (async (_url: string, init: RequestInit) => {
    const body =
      init.body instanceof Blob
        ? new Uint8Array(await init.body.arrayBuffer())
        : new Uint8Array(init.body as unknown as ArrayBufferLike as never)
    posts.push({ body })
    return { ok: true, status: 200, headers: { get: () => null } } as unknown as Response
  }) as unknown as typeof fetch
  return { posts, impl }
}

interface Frames {
  readonly records: EnvelopeRecord[]
  /** The type of the JSON record each raw frame followed. */
  readonly rawAfter: string[]
}

async function framesOf(posts: readonly Post[]): Promise<Frames> {
  const decoder = new TextDecoder()
  const records: EnvelopeRecord[] = []
  const rawAfter: string[] = []
  for (const p of posts) {
    const pre = readPreamble(p.body) as { gzipped: boolean }
    let frames = p.body.subarray(BODY_PREAMBLE_BYTES)
    if (pre.gzipped) {
      const ds = new DecompressionStream('gzip')
      const out = new Response(new Blob([frames as unknown as BlobPart]).stream().pipeThrough(ds))
      frames = new Uint8Array(await out.arrayBuffer())
    }
    for (const f of readFrames(frames)) {
      if (f.raw) rawAfter.push(records.at(-1)?.t ?? '')
      else records.push(JSON.parse(decoder.decode(f.payload)) as EnvelopeRecord)
    }
  }
  return { records, rawAfter }
}

const of = <T extends EnvelopeRecord['t']>(all: readonly EnvelopeRecord[], t: T) =>
  all.filter((r) => r.t === t) as Extract<EnvelopeRecord, { t: T }>[]

const base = (over: Partial<CollectorConfig> = {}): CollectorConfig => ({
  apiKey: 'pk_test',
  endpoint: 'https://ingest.test/v1/ingest',
  sessionId: 'sess-fixed',
  ...over,
})

const quiet = { persist: false, noLifecycleListeners: true, locks: null } as const

interface Peer {
  readonly wt: MockWebTransport
  /** Deliver one receive stream carrying `bytes` and let the page read all of it. */
  stream(bytes: Uint8Array): Promise<void>
  datagram(bytes: Uint8Array): Promise<void>
}

async function connect(): Promise<Peer> {
  const wt = new (g.WebTransport as new (u: string) => MockWebTransport)('https://relay.test/moq')
  await wt.open('moqt-20')
  await settle(5)
  const uni = wt.incomingUnidirectionalStreams.getReader()
  const dgrams = wt.datagrams.readable.getReader()
  return {
    wt,
    async stream(bytes) {
      const src = wt.deliverUniStream([bytes])
      src.close()
      const arrived = await uni.read()
      const reader = (arrived.value as ReadableStream<Uint8Array>).getReader()
      for (;;) if ((await reader.read()).done) break
      await settle(2)
    },
    async datagram(bytes) {
      wt.datagramsIn.push(bytes)
      await dgrams.read()
      await settle(2)
    },
  }
}

/** One subgroup stream of group 7: two objects with payloads, then an end-of-group status. */
const GROUP_7 = subgroupBytes({
  alias: 4n,
  group: 7n,
  objects: [
    { id: 0n, bytes: 120 },
    { id: 1n, bytes: 64 },
    { id: 2n, bytes: 0, status: 3n },
  ],
})

async function sessionAt(level: DetailLevel): Promise<{ records: Frames; conn: string }> {
  const { posts, impl } = recordingFetch()
  const c = init(base(), { ...quiet, fetchImpl: impl })
  await settle()
  const peer = await connect()
  if (level !== 'baseline') c.escalate(level)
  await peer.stream(GROUP_7)
  const conn = c.connections()[0]?.id as string
  await c.end()
  return { records: await framesOf(posts), conn }
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

describe('object headers follow the detail level', () => {
  it('writes none at baseline', async () => {
    const { records } = await sessionAt('baseline')
    expect(of(records.records, 'hdr')).toEqual([])
    // The objects were counted all the same.
    const rows = of(records.records, 'rollup').flatMap((r) => r.tracks)
    expect(rows.reduce((n, t) => n + t.objects, 0)).toBe(3)
  })

  it('writes one per object at headers, with its connection, stream, group and object, and no size', async () => {
    const { records, conn } = await sessionAt('headers')
    const hdr = of(records.records, 'hdr')
    expect(hdr).toHaveLength(3)
    const streamId = hdr[0]?.streamId
    expect(typeof streamId).toBe('number')
    expect(hdr).toEqual([
      {
        t: 'hdr',
        ts: expect.any(Number),
        lvl: 'headers',
        conn,
        key: { d: 'rx', k: 'alias', v: '4', e: expect.any(Number) },
        streamId,
        group: '7',
        object: '0',
      },
      expect.objectContaining({ group: '7', object: '1' }),
      expect.objectContaining({ group: '7', object: '2', status: 3 }),
    ])
    for (const h of hdr) expect(h).not.toHaveProperty('size')
    // Decoded fields only: the raw frames in the upload are the control plane's.
    expect(records.rawAfter.every((t) => t === 'ctrl')).toBe(true)
  })

  it('adds the payload size at headers+sizes', async () => {
    const { records } = await sessionAt('headers+sizes')
    const hdr = of(records.records, 'hdr')
    expect(hdr.map((h) => [h.lvl, h.object, h.size])).toEqual([
      ['headers+sizes', '0', 120],
      ['headers+sizes', '1', 64],
      ['headers+sizes', '2', 0],
    ])
  })

  it('writes the same record at headers+data, and no payload byte', async () => {
    const sizes = of((await sessionAt('headers+sizes')).records.records, 'hdr')
    const { records } = await sessionAt('headers+data')
    const hdr = of(records.records, 'hdr')
    const strip = (h: HdrRecord) => {
      const { lvl: _lvl, ts: _ts, conn: _conn, ...rest } = h
      return rest
    }
    expect(hdr.map((h) => h.lvl)).toEqual(['headers+data', 'headers+data', 'headers+data'])
    expect(hdr.map(strip)).toEqual(sizes.map(strip))
    expect(records.rawAfter.every((t) => t === 'ctrl')).toBe(true)
  })

  it('stops when the window closes', async () => {
    const { posts, impl } = recordingFetch()
    const c = init(base(), { ...quiet, fetchImpl: impl })
    await settle()
    const peer = await connect()
    c.escalate('headers', 'stall')
    await peer.stream(subgroupBytes({ alias: 4n, group: 1n, objects: [{ id: 0n, bytes: 10 }] }))
    c.resolve()
    await peer.stream(subgroupBytes({ alias: 4n, group: 2n, objects: [{ id: 0n, bytes: 10 }] }))
    await c.end()

    const hdr = of((await framesOf(posts)).records, 'hdr')
    expect(hdr.map((h) => h.group)).toEqual(['1'])
  })

  it('writes a datagram’s header with no stream', async () => {
    const { posts, impl } = recordingFetch()
    const c = init(base(), { ...quiet, fetchImpl: impl })
    await settle()
    const peer = await connect()
    c.escalate('headers+sizes')
    await peer.datagram(datagramBytes({ alias: 9n, group: 3n, id: 5n, bytes: 40 }))
    await c.end()

    const hdr = of((await framesOf(posts)).records, 'hdr')
    expect(hdr).toEqual([
      expect.objectContaining({
        key: expect.objectContaining({ d: 'rx', v: '9' }),
        group: '3',
        object: '5',
        size: 40,
      }),
    ])
    expect(hdr[0]).not.toHaveProperty('streamId')
  })
})

describe('object headers give way when the buffer nears its cap', () => {
  it('drops headers and says so, and keeps the control plane and the counts whole', async () => {
    const { posts, impl } = recordingFetch()
    // A small threshold puts the droppable gate at 6 KB; one arriving chunk of
    // 600 objects writes far past it before the seal it triggers can run.
    const c = init(base({ upload: { byteThreshold: 1024 } }), { ...quiet, fetchImpl: impl })
    await settle()
    const peer = await connect()
    c.escalate('headers+sizes')
    const objects = Array.from({ length: 600 }, (_, i) => ({ id: BigInt(i), bytes: 1 }))
    await peer.stream(subgroupBytes({ alias: 4n, group: 0n, objects }))
    // A control frame after the burst still arrives with its bytes.
    const bidi = peer.wt.deliverBidiStream([subscribeBytes(1n, 'video')])
    bidi.inbound.close()
    const arrived = await peer.wt.incomingBidirectionalStreams.getReader().read()
    const reader = (arrived.value as { readable: ReadableStream<Uint8Array> }).readable.getReader()
    for (;;) if ((await reader.read()).done) break
    await settle()
    await c.end()

    const { records, rawAfter } = await framesOf(posts)
    const hdr = of(records, 'hdr')
    expect(hdr.length).toBeGreaterThan(0)
    expect(hdr.length).toBeLessThan(600)
    const end = of(records, 'end')[0] as EndRecord
    expect(end.counters.sampledTypes).toContain('hdr')
    const last = of(records, 'batch').at(-1) as BatchRecord
    expect(last.dropped).toBeGreaterThanOrEqual(600 - hdr.length)
    // Non-droppable records stay whole.
    const rows = of(records, 'rollup').flatMap((r) => r.tracks)
    expect(rows.reduce((n, t) => n + t.objects, 0)).toBe(600)
    const ctrl = of(records, 'ctrl')
    expect(ctrl).toHaveLength(1)
    expect(rawAfter).toEqual(['ctrl'])
  })
})

describe('a linked worker writes object headers and forwards them', () => {
  it('follows the level the page sends, on the worker’s own connection', async () => {
    // The worker's realm alone; the test plays the page.
    const channel = new MessageChannel()
    const probe = initWorkerWith(draftSet(ALL_ADAPTERS), channel.port2, { timeOrigin: 0 })
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
      config: { metrics, flightRecorder, limits, privacy, upload, context },
    }
    channel.port1.postMessage(envelope(linked), [page.port2])
    expect(await probe.linked).toBe(true)

    const peer = await connect()
    await peer.stream(subgroupBytes({ alias: 4n, group: 1n, objects: [{ id: 0n, bytes: 10 }] }))
    page.port1.postMessage(envelope({ t: 'level', level: 'headers+sizes' }))
    await settle(5)
    await peer.stream(subgroupBytes({ alias: 4n, group: 2n, objects: [{ id: 0n, bytes: 10 }] }))
    page.port1.postMessage(envelope({ t: 'forward' }))
    await settle(10)

    const decoder = new TextDecoder()
    const all: EnvelopeRecord[] = []
    for (const f of forwards) {
      if (f.frames === undefined) continue
      for (const frame of readFrames(new Uint8Array(f.frames, 0, f.byteLength))) {
        if (!frame.raw) all.push(JSON.parse(decoder.decode(frame.payload)) as EnvelopeRecord)
      }
    }
    const conn = of(all, 'conn-open')[0]
    expect(conn?.realm).toBe('worker')
    expect(of(all, 'hdr')).toEqual([
      expect.objectContaining({ lvl: 'headers+sizes', conn: conn?.conn, group: '2', size: 10 }),
    ])

    page.port1.postMessage(envelope({ t: 'unlinked' }))
    await settle(5)
    channel.port1.close()
    page.port1.close()
  })
})
