/**
 * The data a session uploads, field by field against what crossed the page:
 * frames the codec encodes, delivered at known times on the page's clock, and
 * every body read back with the suite's own reader. Set `MONITOR_BODIES_DIR`
 * to keep the bodies for a reader outside this package.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as d14 from '@moqtap/codec/draft14'
import * as d23 from '@moqtap/codec/draft23'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetDormantForTest, teardownDormant, useDormantClockForTest } from '../../api/dormant.js'
import { rseqRanges } from '../../envelope/contract.js'
import { idempotencyKey } from '../../envelope/idempotency.js'
import type {
  BatchRecord,
  ConnOpenRecord,
  CtrlRecord,
  EnvelopeRecord,
  RollupTrackWire,
} from '../../types.js'
import {
  datagramBytes,
  encodeControl,
  fetchBytes,
  filled,
  subgroupBytes,
  subscribeBytes,
  subscribeOkBytes,
} from '../decode/vectors.js'
import { compressing } from '../support/gzip-busy.js'
import { init } from '../support/init.js'
import { type BodyFacts, factsOf } from '../support/runs.js'
import {
  framesOf,
  of,
  type Post,
  preambleOf,
  recordingFetch,
  recordsOf,
} from '../support/uploads.js'
import { virtualTime } from '../support/virtual-time.js'
import { MockWebTransport } from '../transport/mocks.js'

vi.mock('../../envelope/gzip.js', async (original) =>
  (await import('../support/gzip-busy.js')).meteredGzip(original),
)

const g = globalThis as unknown as Record<string, unknown>
let originalWT: unknown

beforeEach(() => {
  originalWT = g.WebTransport
  MockWebTransport.instances = []
  g.WebTransport = MockWebTransport
})

afterEach(() => {
  useDormantClockForTest(undefined)
  teardownDormant()
  resetDormantForTest()
  g.WebTransport = originalWT
})

interface Bidi {
  readonly readable: ReadableStream<Uint8Array>
  readonly writable: WritableStream<Uint8Array>
  readonly inbound: { push(b: Uint8Array): void; close(): void }
}

type Chunks = readonly (readonly [ms: number, bytes: Uint8Array])[]

/** A page whose clock and timers the test moves, uploading to a recording fetch. */
async function page() {
  const vt = virtualTime(compressing)
  // Arrivals are stamped on the page's clock.
  useDormantClockForTest(vt.ports.clock)
  const { posts, impl } = recordingFetch()
  const c = init(
    { apiKey: 'pk_test', endpoint: 'https://ingest.test/v1/ingest' },
    {
      persist: false,
      locks: null,
      noLifecycleListeners: true,
      fetchImpl: impl,
      timeOrigin: 0,
      ...vt.ports,
    },
  )
  await vt.advanceTo(0)
  return { vt, posts, c, at: (ms: number) => vt.advanceTo(ms) }
}
type Page = Awaited<ReturnType<typeof page>>

async function connect(p: Page, protocol: string, url = 'https://relay.test/moq') {
  const wt = new (g.WebTransport as new (u: string) => MockWebTransport)(url)
  await wt.open(protocol)
  await p.at(p.vt.now)
  const uni = wt.incomingUnidirectionalStreams.getReader()
  const dgrams = wt.datagrams.readable.getReader()
  return {
    wt,
    /** A bidirectional stream the page opens and writes `tx` on; the peer answers `rx` at `at`. */
    async request(tx: Uint8Array, rx?: { at: number; bytes: Uint8Array }) {
      const b = (await wt.createBidirectionalStream()) as unknown as Bidi
      const w = b.writable.getWriter()
      await w.write(tx)
      const reader = b.readable.getReader()
      if (rx !== undefined) {
        await p.at(rx.at)
        b.inbound.push(rx.bytes)
        await reader.read()
      }
      await p.at(p.vt.now)
      return { b, w, reader }
    },
    /** A receive stream, each chunk delivered at its time, then ended as `end` says. */
    async receive(chunks: Chunks, end: 'fin' | { reset: number } | 'open' = 'fin') {
      let src: ReturnType<MockWebTransport['deliverUniStream']> | undefined
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
      for (const [ms, bytes] of chunks) {
        await p.at(ms)
        if (src === undefined) {
          src = wt.deliverUniStream([bytes])
          reader = ((await uni.read()).value as ReadableStream<Uint8Array>).getReader()
        } else src.push(bytes)
        await reader?.read()
      }
      const s = src as NonNullable<typeof src>
      const rd = reader as NonNullable<typeof reader>
      const finish = async (e: 'fin' | { reset: number }): Promise<void> => {
        if (e === 'fin') {
          s.close()
          await rd.read()
        } else {
          s.error(Object.assign(new Error('reset'), { source: 'stream', streamErrorCode: e.reset }))
          await rd.read().catch(() => {})
        }
        await p.at(p.vt.now)
      }
      if (end !== 'open') await finish(end)
      return { src: s, reader: rd, finish }
    },
    async datagram(ms: number, bytes: Uint8Array): Promise<void> {
      await p.at(ms)
      wt.datagramsIn.push(bytes)
      await dgrams.read()
    },
    /** A send stream the page writes, each chunk at its time, then closes. */
    async send(chunks: Chunks): Promise<void> {
      const w = ((await wt.createUnidirectionalStream()) as WritableStream<unknown>).getWriter()
      for (const [ms, bytes] of chunks) {
        await p.at(ms)
        await w.write(bytes)
      }
      await w.close()
      await p.at(p.vt.now)
    },
  }
}

interface Body {
  readonly pre: ReturnType<typeof preambleOf>
  readonly batch: BatchRecord
  readonly records: readonly EnvelopeRecord[]
  readonly facts: BodyFacts
  /** Each `ctrl` record with the raw frame after it. */
  readonly ctrl: readonly (CtrlRecord & { readonly raw: Uint8Array })[]
}

/**
 * Every body, decoded, after checking what holds of every body whatever the
 * session did: the seal chain, `em` against the records' rseqs, the key, and
 * that each body lists every connection and track it refers to and every
 * connection open in its interval.
 */
async function uploaded(name: string, posts: readonly Post[]): Promise<Body[]> {
  keep(name, posts)
  const out: Body[] = []
  let last = -1
  const open = new Set<number>()
  const decoder = new TextDecoder()
  for (const [i, post] of posts.entries()) {
    const pre = preambleOf(post.body)
    const records = await recordsOf(post.body)
    const batch = records[0] as BatchRecord
    const facts = await factsOf(post.body)
    const frames = await framesOf(post.body)
    const ctrl: (CtrlRecord & { raw: Uint8Array })[] = []
    for (const [j, f] of frames.entries()) {
      if (f.raw) continue
      const r = JSON.parse(decoder.decode(f.payload)) as EnvelopeRecord
      if (r.t === 'ctrl')
        ctrl.push({ ...r, raw: (frames[j + 1] as { payload: Uint8Array }).payload })
    }

    expect(pre.v).toBe(2)
    expect(batch.t).toBe('batch')
    expect([pre.seal.seq, batch.seq]).toEqual([i, i])
    expect(batch.instanceId).toBe(pre.i)
    expect(batch.idempotencyKey).toBe(idempotencyKey(batch.sessionId, batch.instanceId, i))
    if (i > 0) expect(pre.seal.from_us).toBe(out[i - 1]?.pre.seal.through_us)
    expect(pre.seal.through_us).toBeGreaterThanOrEqual(pre.seal.from_us)
    expect(batch.final).toBe(i === posts.length - 1)
    if (batch.final) expect(pre.seal).not.toHaveProperty('next_us')
    else expect(pre.seal.next_us).toBeGreaterThanOrEqual(pre.seal.through_us)

    const rseqs = records.slice(1).map((r) => (r as { rseq: number }).rseq)
    for (const r of rseqs) expect(Number.isSafeInteger(r)).toBe(true)
    expect(pre.em).toEqual(rseqRanges(rseqs))
    // Nothing was lost, so the numbering runs on from body to body.
    expect(rseqs).toEqual(rseqs.map((_, k) => last + 1 + k))
    last += rseqs.length
    expect(batch.tail.last_rseq).toBe(last)

    const listed = new Set(batch.conn.map((c) => c.c))
    const named = [
      ...facts.runs.map((r) => r.c),
      ...facts.marks.map((m) => m.c),
      ...facts.ends.map((e) => e.c),
      ...facts.bw.map((b) => b.c),
      ...facts.runEnds.map((e) => e.c),
      ...records.flatMap((r) =>
        r.t === 'ctrl' || r.t === 'conn-open' || r.t === 'conn-close' ? [r.c as number] : [],
      ),
    ]
    for (const c of of(records, 'conn-open')) open.add(c.c)
    for (const c of [...named, ...open]) expect(listed.has(c), `body ${i} lists c ${c}`).toBe(true)
    for (const c of of(records, 'conn-close')) open.delete(c.c)
    const tracks = new Set(batch.trk.map((t) => t.id))
    for (const ti of [...facts.runs, ...facts.marks, ...facts.ends].map((x) => x.ti)) {
      expect(tracks.has(ti), `body ${i} lists track ${ti}`).toBe(true)
    }
    out.push({ pre, batch, records, facts, ctrl })
  }
  return out
}

/** Keeps the bodies where `MONITOR_BODIES_DIR` names. */
function keep(name: string, posts: readonly Post[]): void {
  const dir = process.env.MONITOR_BODIES_DIR
  if (dir === undefined || dir === '') return
  mkdirSync(dir, { recursive: true })
  for (const [i, p] of posts.entries()) writeFileSync(join(dir, `${name}-${i}.bin`), p.body)
}

const keyOf = (b: Body, ti: number) => b.facts.trk.find((t) => t.id === ti)?.key
const runsOf = (bodies: readonly Body[]) =>
  bodies.flatMap((b) => b.facts.runs.map((r) => ({ ...r, key: keyOf(b, r.ti) })))
const marksOf = (bodies: readonly Body[]) =>
  bodies.flatMap((b) => b.facts.marks.map((m) => ({ ...m, key: keyOf(b, m.ti) })))
const recordsIn = (bodies: readonly Body[]) => bodies.flatMap((b) => [...b.records])

/** Bytes per second of device time, by connection and direction, summed over every body. */
function seconds(bodies: readonly Body[]): Record<string, [number, number][]> {
  const sum = new Map<string, Map<number, number>>()
  for (const b of bodies) {
    for (const e of b.facts.bw) {
      const k = `${e.c}:${e.sent ? 'tx' : 'rx'}`
      const m = sum.get(k) ?? new Map<number, number>()
      for (const [s, n] of e.secs) m.set(s, (m.get(s) ?? 0) + n)
      expect(e.pre).toBe(0)
      sum.set(k, m)
    }
  }
  return Object.fromEntries(
    [...sum].sort().map(([k, m]) => [k, [...m].sort((x, y) => x[0] - y[0])]),
  )
}

/** Each connection's `conn-open` fields, the latest by rseq, `roles` by union. */
function connections(bodies: readonly Body[]): Map<number, ConnOpenRecord> {
  const out = new Map<number, ConnOpenRecord>()
  for (const r of of(recordsIn(bodies), 'conn-open')) {
    const was = out.get(r.c)
    const roles = [...new Set([...(was?.roles ?? []), ...(r.roles ?? [])])].sort()
    out.set(r.c, { ...was, ...r, ...(roles.length > 0 ? { roles } : {}) } as ConnOpenRecord)
  }
  return out
}

const rollupTracks = (bodies: readonly Body[]): RollupTrackWire[] =>
  of(recordsIn(bodies), 'rollup').flatMap((r) => r.tracks)

const hex = (h: string): Uint8Array =>
  Uint8Array.from(h.match(/../g) ?? [], (b) => Number.parseInt(b, 16))

/** CLIENT_SETUP offering drafts 13 and 14, and SERVER_SETUP picking 14. */
const CLIENT_SETUP_13_14 = hex('20001202c0000000ff00000dc0000000ff00000e00')
const SERVER_SETUP_14 = hex('210009c0000000ff00000e00')

const object = (id: bigint, n: number, status?: bigint) => ({
  type: 'object' as const,
  byteOffset: 0,
  payloadByteOffset: 0,
  objectId: id,
  payloadLength: n,
  payload: filled(n),
  extensionData: new Uint8Array(0),
  ...(status === undefined ? {} : { status }),
})

const KEY = (d: 'rx' | 'tx', k: 'alias' | 'fetch', v: string) => ({ d, k, v, e: 0 })

describe('a subscription on draft-20', () => {
  it('records its control frames, each object’s start, end and size, its flags and its bandwidth', async () => {
    const p = await page()
    const k = await connect(p, 'moqt-20')
    await p.at(100)
    const subscribe = subscribeBytes(1n, 'video')
    const ok = subscribeOkBytes(4n)
    await k.request(subscribe, { at: 120, bytes: ok })
    // FIRST_OBJECT and END_OF_GROUP: draft-20 Section 11.4.2 SUBGROUP_HEADER Type bits 0x40 and 0x08.
    const sg = subgroupBytes({
      alias: 4n,
      group: 7n,
      headerType: 0x58,
      objects: [
        { id: 0n, bytes: 100 },
        { id: 1n, bytes: 200 },
      ],
    })
    // Object 1's header is in the first chunk and its payload ends in the third.
    await k.receive([
      [2_000, sg.subarray(0, 120)],
      [2_010, sg.subarray(120, 200)],
      [2_025, sg.subarray(200)],
    ])
    k.wt.closeSession('bye', 7)
    await p.at(3_000)
    await p.c.end()
    await p.at(3_000)

    const bodies = await uploaded('d20-subscribe', p.posts)
    const ctrl = bodies.flatMap((b) => b.ctrl)
    expect(ctrl.map((r) => [r.c, r.dir, r.at_us, r.decoded, r.n, r.sid === r.streamId])).toEqual([
      [0, 'tx', 100_000, true, subscribe.length, true],
      [0, 'rx', 120_000, true, ok.length, true],
    ])
    expect(ctrl.map((r) => [...r.raw])).toEqual([[...subscribe], [...ok]])

    const runs = runsOf(bodies)
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({
      key: KEY('rx', 'alias', '4'),
      c: 0,
      path: 'sub_stream',
      g: 7n,
      sub: 0n,
      ids: [0n, 1n],
      fo: true,
      foKnown: true,
      eog: true,
      end: 'fin',
      cont: false,
      t0Us: 2_000_000,
      dt: [0],
      // 25 ms after its start, in 100 µs.
      de: [0, 250],
      os: [100, 200],
      b: 300,
    })
    // The data stream is numbered apart from the request stream.
    expect(runs[0]?.sid).not.toBe(BigInt(ctrl[0]?.sid ?? -1))

    expect(seconds(bodies)).toEqual({
      '0:rx': [
        [0, ok.length],
        [2, sg.length],
      ],
      '0:tx': [[0, subscribe.length]],
    })
    const last = bodies.at(-1)?.batch as BatchRecord
    expect(last.tail.conn).toEqual([[0, 2, 300]])
    expect(last.tail.pre_drop).toEqual({ records: 0, objects: 0 })

    const conn = connections(bodies).get(0)
    expect(conn).toMatchObject({
      at_us: 0,
      ready_us: 0,
      draft: 20,
      protocol: 'moqt-20',
      roles: ['subscriber'],
      realm: 'page',
    })
    expect(bodies.flatMap((b) => b.batch.conn)).toContainEqual({
      c: 0,
      draft: 20,
      relay: 'https://relay.test/moq',
    })
    expect(of(recordsIn(bodies), 'conn-close')).toEqual([
      expect.objectContaining({
        c: 0,
        conn: conn?.conn,
        at_us: 2_025_000,
        cause: 'closed',
        by: 'relay',
        code: 7,
        reason: 'bye',
      }),
    ])
    // The alias is bound to the SUBSCRIBE its SUBSCRIBE_OK answered.
    expect(rollupTracks(bodies).map((t) => [t.key, t.rq])).toEqual([
      [KEY('rx', 'alias', '4'), { d: 'tx', v: '1' }],
    ])
  })

  it('records datagrams in arrival order, and a status datagram as a mark, not an arrival', async () => {
    const p = await page()
    const k = await connect(p, 'moqt-20')
    const d3 = datagramBytes({ alias: 4n, group: 8n, id: 3n, bytes: 30 })
    const d1 = datagramBytes({ alias: 4n, group: 8n, id: 1n, bytes: 10 })
    // The STATUS Type bit with status 0x3, End of Group: draft-20 Section 11.3.1.
    const eog = datagramBytes({ alias: 4n, group: 8n, id: 4n, type: 0x20, status: 3n })
    await k.datagram(1_030, d3)
    await k.datagram(1_040, d1)
    await k.datagram(1_041, eog)
    await p.c.end()
    await p.at(p.vt.now)

    const bodies = await uploaded('d20-datagrams', p.posts)
    const runs = runsOf(bodies)
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({
      key: KEY('rx', 'alias', '4'),
      path: 'datagram',
      g: 8n,
      sub: null,
      sid: null,
      ids: [3n, 1n],
      end: 'na',
      foKnown: false,
      eog: false,
      t0Us: 1_030_000,
      dt: [100],
      de: [0, 0],
      os: [30, 10],
    })
    expect(marksOf(bodies).map((m) => [m.kind, m.key, m.g, m.o, m.tUs, m.path, m.sid])).toEqual([
      ['eog', KEY('rx', 'alias', '4'), 8n, 4n, 1_041_000, 'datagram', null],
    ])
    expect(seconds(bodies)['0:rx']).toEqual([[1, d3.length + d1.length + eog.length]])
    expect(bodies.at(-1)?.batch.tail.conn).toEqual([[0, 2, 40]])
  })
})

describe('a FETCH on draft-20', () => {
  it('records its objects under its Request ID, a run per group, each with its subgroup', async () => {
    const p = await page()
    const k = await connect(p, 'moqt-20')
    const fetch = encodeControl({
      type: 'fetch',
      request_id: 2n,
      track_namespace: ['moqtap', 'test'],
      track_name: 'video',
      parameters: {},
    })
    const fetchOk = encodeControl({
      type: 'fetch_ok',
      end_of_track: 0,
      end_group: 4n,
      end_object: 0n,
      parameters: {},
      track_properties: {},
    })
    await k.request(fetch, { at: 20, bytes: fetchOk })
    // Serialization Flags, draft-20 Section 11.4.4.1: 0x08 Group ID Delta, 0x04 Object ID
    // Delta, 0x03 an explicit Subgroup ID, 0x40 an object sent as a datagram, with none.
    const fb = fetchBytes(2n, [
      { group: 3n, id: 0n, bytes: 10 },
      { group: 3n, id: 1n, bytes: 20, flags: 0x04 },
      { group: 4n, id: 0n, bytes: 30, flags: 0x0f, subgroup: 6n },
      { group: 4n, id: 1n, bytes: 5, flags: 0x44 },
    ])
    await k.receive([
      [30, fb.subarray(0, 20)],
      [35, fb.subarray(20)],
    ])
    await p.c.end()
    await p.at(p.vt.now)

    const bodies = await uploaded('d20-fetch', p.posts)
    const runs = runsOf(bodies).sort((a, b) => Number(a.g - b.g))
    expect(
      runs.map((r) => [r.key, r.path, r.g, r.ids, r.osub, r.t0Us, r.dt, r.de, r.os, r.end]),
    ).toEqual([
      [
        KEY('rx', 'fetch', '2'),
        'fetch',
        3n,
        [0n, 1n],
        [0n, 0n],
        30_000,
        [0],
        [0, 50],
        [10, 20],
        'open',
      ],
      [
        KEY('rx', 'fetch', '2'),
        'fetch',
        4n,
        [0n, 1n],
        [6n, null],
        35_000,
        [0],
        [0, 0],
        [30, 5],
        'fin',
      ],
    ])
    expect(runs[0]?.sid).not.toBeNull()
    expect(runs[1]?.sid).toBe(runs[0]?.sid)
    expect(bodies.at(-1)?.batch.tail.conn).toEqual([[0, 4, 65]])
    expect(bodies.flatMap((b) => b.ctrl).map((r) => [r.dir, [...r.raw]])).toEqual([
      ['tx', [...fetch]],
      ['rx', [...fetchOk]],
    ])
  })
})

describe('objects the page sends', () => {
  it('are runs under their sent key, counted in sent bandwidth and in no received total', async () => {
    const p = await page()
    const k = await connect(p, 'moqt-20')
    const sg = subgroupBytes({
      alias: 9n,
      group: 1n,
      objects: [
        { id: 0n, bytes: 50 },
        { id: 1n, bytes: 70 },
      ],
    })
    await k.send([
      [40, sg.subarray(0, 60)],
      [55, sg.subarray(60)],
    ])
    await p.c.end()
    await p.at(p.vt.now)

    const bodies = await uploaded('d20-send', p.posts)
    expect(
      runsOf(bodies).map((r) => [r.key, r.path, r.g, r.ids, r.t0Us, r.dt, r.de, r.os, r.end]),
    ).toEqual([
      // Object 1's header and first byte are in the first write; its last byte in the second.
      [KEY('tx', 'alias', '9'), 'sub_stream', 1n, [0n, 1n], 40_000, [0], [0, 150], [50, 70], 'fin'],
    ])
    expect(seconds(bodies)).toEqual({ '0:tx': [[0, sg.length]] })
    for (const [, objects, bytes] of bodies.at(-1)?.batch.tail.conn ?? []) {
      expect([objects, bytes]).toEqual([0, 0])
    }
    expect(connections(bodies).get(0)?.roles).toEqual(['publisher'])
  })
})

describe('an object still arriving at a seal', () => {
  it('states its last byte so far, then its real end in a run-end for that run', async () => {
    const p = await page()
    const k = await connect(p, 'moqt-20')
    const sg = subgroupBytes({ alias: 4n, group: 5n, objects: [{ id: 0n, bytes: 1000 }] })
    const s = await k.receive([[100, sg.subarray(0, 500)]], 'open')
    await p.at(120)
    s.src.push(sg.subarray(500, 800))
    await s.reader.read()
    await p.c.flush()
    await p.at(150)
    s.src.push(sg.subarray(800))
    await s.reader.read()
    await p.at(160)
    await p.c.flush()
    await s.finish('fin')
    await p.c.end()
    await p.at(p.vt.now)

    const bodies = await uploaded('d20-run-end', p.posts)
    const sealed = bodies.findIndex((b) => b.facts.runs.length > 0)
    const run = bodies[sealed]?.facts.runs[0]
    // Its size is the payload length its header states; its end so far is the last chunk's.
    expect(run).toMatchObject({
      g: 5n,
      ids: [0n],
      t0Us: 100_000,
      de: [200],
      os: [1000],
      end: 'open',
    })
    const rseq = bodies[sealed]?.facts.runRecords[0]?.rseq
    expect(bodies.slice(sealed + 1).flatMap((b) => b.facts.runEnds)).toEqual([
      { c: 0, r: rseq, j: 0, eUs: 150_000 },
    ])
    const ends = bodies.slice(sealed + 1).flatMap((b) => b.facts.ends)
    expect(ends.map((e) => [e.end, e.g, e.o, e.tUs, e.sid])).toEqual([
      ['fin', 5n, 0n, 160_000, run?.sid],
    ])
  })
})

describe('two connections, on draft-14 and draft-23', () => {
  it('records each under its own ordinal, draft, relay and totals', async () => {
    const p = await page()
    const a = await connect(p, '')
    const ctl = await a.request(CLIENT_SETUP_13_14, { at: 5, bytes: SERVER_SETUP_14 })
    await p.at(10)
    const sub14 = d14.encodeMessage({
      type: 'subscribe',
      request_id: 0n,
      track_namespace: ['moqtap', 'test'],
      track_name: 'video',
      subscriber_priority: 1,
      group_order: 0,
      forward: 1n,
      filter_type: 2n,
      parameters: {},
    } as never)
    await ctl.w.write(sub14)
    await p.at(15)
    const ok14 = d14.encodeMessage({
      type: 'subscribe_ok',
      request_id: 0n,
      track_alias: 7n,
      expires: 0n,
      group_order: 1,
      content_exists: 0n,
      parameters: {},
    } as never)
    ctl.b.inbound.push(ok14)
    await ctl.reader.read()
    // Type 0x14 carries an explicit Subgroup ID; status 0x3 is End of Group (draft-14 Section 10.4.2).
    const sg14 = d14.encodeSubgroupStream({
      type: 'subgroup',
      headerType: 0x14,
      trackAlias: 7n,
      groupId: 2n,
      subgroupId: 5n,
      publisherPriority: 1,
      objects: [object(0n, 10), object(2n, 20), object(3n, 0, 3n)],
    } as never)
    await a.receive([[20, sg14]], { reset: 9 })

    const b = await connect(p, 'moqt-23', 'https://Relay.Test:443/x/')
    const sub23 = d23.encodeMessage({
      type: 'subscribe',
      request_id: 0n,
      track_namespace: ['moqtap', 'test'],
      track_name: 'audio',
      parameters: {},
    } as never)
    const ok23 = d23.encodeMessage({
      type: 'subscribe_ok',
      track_alias: 3n,
      parameters: {},
      track_properties: {},
    } as never)
    await b.request(sub23, { at: 30, bytes: ok23 })
    const sg23 = d23.encodeSubgroupStream({
      type: 'subgroup',
      headerType: 0x58,
      trackAlias: 3n,
      groupId: 11n,
      subgroupId: 0n,
      publisherPriority: 1,
      objects: [object(0n, 5), object(1n, 6)],
    } as never)
    await b.receive([[40, sg23]])
    // Datagram Type 0x02 sets END_OF_GROUP.
    const dg23 = d23.encodeDatagram({
      type: 'datagram',
      datagramType: 0x02,
      trackAlias: 3n,
      groupId: 12n,
      objectId: 0n,
      publisherPriority: 1,
      payloadLength: 4,
      payload: filled(4),
    } as never)
    await b.datagram(50, dg23)
    await p.at(60)
    await p.c.end()
    await p.at(60)

    const bodies = await uploaded('d14-d23', p.posts)
    const listed = new Map(bodies.flatMap((x) => x.batch.conn).map((c) => [c.c, c]))
    expect(listed.get(0)).toEqual({ c: 0, draft: 14, relay: 'https://relay.test/moq' })
    expect(listed.get(1)).toEqual({ c: 1, draft: 23, relay: 'https://relay.test/x/' })
    const conns = connections(bodies)
    expect(conns.get(0)).toMatchObject({ draft: 14, offered: [13, 14], roles: ['subscriber'] })
    expect(conns.get(0)).not.toHaveProperty('protocol')
    expect(conns.get(1)).toMatchObject({
      draft: 23,
      protocol: 'moqt-23',
      at_us: 20_000,
      roles: ['subscriber'],
    })
    expect(conns.get(0)?.conn).not.toBe(conns.get(1)?.conn)

    expect(
      bodies.flatMap((x) => x.ctrl).map((r) => [r.c, r.dir, r.at_us, r.decoded, [...r.raw]]),
    ).toEqual([
      [0, 'tx', 0, true, [...CLIENT_SETUP_13_14]],
      [0, 'rx', 5_000, true, [...SERVER_SETUP_14]],
      [0, 'tx', 10_000, true, [...sub14]],
      [0, 'rx', 15_000, true, [...ok14]],
      [1, 'tx', 20_000, true, [...sub23]],
      [1, 'rx', 30_000, true, [...ok23]],
    ])

    expect(
      runsOf(bodies).map((r) => [
        r.c,
        r.key,
        r.path,
        r.g,
        r.sub,
        r.ids,
        r.fo,
        r.foKnown,
        r.eog,
        r.end,
        r.rc,
        r.os,
      ]),
    ).toEqual([
      [
        0,
        KEY('rx', 'alias', '7'),
        'sub_stream',
        2n,
        5n,
        [0n, 2n],
        false,
        false,
        false,
        'reset',
        9n,
        [10, 20],
      ],
      [
        1,
        KEY('rx', 'alias', '3'),
        'sub_stream',
        11n,
        0n,
        [0n, 1n],
        true,
        true,
        true,
        'fin',
        null,
        [5, 6],
      ],
      [
        1,
        KEY('rx', 'alias', '3'),
        'datagram',
        12n,
        null,
        [0n],
        false,
        false,
        true,
        'na',
        null,
        [4],
      ],
    ])
    expect(marksOf(bodies).map((m) => [m.c, m.kind, m.g, m.o, m.path])).toEqual([
      [0, 'eog', 2n, 3n, 'sub_stream'],
    ])
    expect(bodies.at(-1)?.batch.tail.conn).toEqual([
      [0, 2, 30],
      [1, 3, 15],
    ])
    expect(seconds(bodies)).toEqual({
      '0:rx': [[0, SERVER_SETUP_14.length + ok14.length + sg14.length]],
      '0:tx': [[0, CLIENT_SETUP_13_14.length + sub14.length]],
      '1:rx': [[0, ok23.length + sg23.length + dg23.length]],
      '1:tx': [[0, sub23.length]],
    })
  })
})

describe('seals while a connection is open', () => {
  it('makes each body at the time the previous one stated', async () => {
    const p = await page()
    const k = await connect(p, '')
    await p.at(3)
    await k.request(CLIENT_SETUP_13_14, { at: 5, bytes: SERVER_SETUP_14 })
    await p.at(130_000)
    await p.c.end()
    await p.at(p.vt.now)

    const bodies = await uploaded('idle-open', p.posts)
    // Ready at 0, the draft read at 5 ms, then each due seal while the connection is open.
    expect(bodies.map((b) => [b.pre.seal.through_us, b.pre.seal.next_us])).toEqual([
      [0, 45_000_000],
      [5_000, 45_005_000],
      [45_005_000, 105_005_000],
      [105_005_000, 165_005_000],
      [130_000_000, undefined],
    ])
    for (const b of bodies.slice(2, 4)) {
      expect(b.pre.em).toEqual([])
      expect(b.batch.conn).toEqual([{ c: 0, draft: 14, relay: 'https://relay.test/moq' }])
    }
  })

  it('lists the open connection in tail.conn as well as in conn', async () => {
    const p = await page()
    await connect(p, 'moqt-20')
    await p.at(50_000)
    await p.c.end()
    await p.at(p.vt.now)
    for (const b of await uploaded('idle-tail', p.posts)) {
      expect(b.batch.conn.map((c) => c.c)).toEqual([0])
      expect(b.batch.tail.conn).toEqual([[0, 0, 0]])
    }
  })
})
