/**
 * What a session's records say about each connection and its tracks, beyond
 * the counts: the relay and the options it was opened with, who closed it and
 * how, which groups never arrived, and which streams were reset with what code.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetDormantForTest, teardownDormant } from '../../api/dormant.js'
import type { CollectorConfig, ConnOpenRecord, RollupTrackWire } from '../../types.js'
import { subgroupBytes } from '../decode/vectors.js'
import { init } from '../support/init.js'
import { allFacts } from '../support/runs.js'
import { settle } from '../support/settle.js'
import { allRecords, of, preambleOf, recordingFetch } from '../support/uploads.js'
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

const base = (over: Partial<CollectorConfig> = {}): CollectorConfig => ({
  apiKey: 'pk_test',
  endpoint: 'https://ingest.test/v1/ingest',
  sessionId: 'sess-fixed',
  ...over,
})

const quiet = { persist: false, noLifecycleListeners: true, locks: null } as const

type Ctor = new (url: string, o?: Record<string, unknown>) => MockWebTransport

async function open(url = 'https://relay.test/moq', o?: Record<string, unknown>) {
  const wt = new (g.WebTransport as Ctor)(url, o)
  await wt.open('moqt-20')
  await settle(5)
  return wt
}

/** Deliver a receive stream carrying `bytes`, read it, and end it as `end` says. */
async function receive(
  wt: MockWebTransport,
  uni: ReadableStreamDefaultReader<ReadableStream<Uint8Array>>,
  bytes: Uint8Array,
  end: 'close' | { reset: number },
): Promise<void> {
  const src = wt.deliverUniStream([bytes])
  const arrived = await uni.read()
  const reader = (arrived.value as ReadableStream<Uint8Array>).getReader()
  await reader.read()
  if (end === 'close') {
    src.close()
    await reader.read()
  } else {
    src.error(Object.assign(new Error('reset'), { source: 'stream', streamErrorCode: end.reset }))
    await reader.read().catch(() => {})
  }
  await settle(2)
}

const merged = (all: Parameters<typeof of>[0]): ConnOpenRecord[] => {
  const out = new Map<string, ConnOpenRecord>()
  for (const r of of(all, 'conn-open')) out.set(r.conn, { ...out.get(r.conn), ...r })
  return [...out.values()]
}

const rows = (all: Parameters<typeof of>[0]): RollupTrackWire[] =>
  of(all, 'rollup').flatMap((r) => r.tracks)

describe('a connection says where it went and how it was opened', () => {
  it('names the relay by scheme, host and port, never a path, query or credential', async () => {
    const { posts, impl } = recordingFetch()
    const c = init(base(), { ...quiet, fetchImpl: impl })
    await settle()
    await open('https://user:secret@Relay.test:4433/moq?token=abc', {
      protocols: ['moqt-20', 'moqt-19'],
      congestionControl: 'low-latency',
      allowPooling: false,
      serverCertificateHashes: [{ algorithm: 'sha-256', value: new Uint8Array(32) }, {}],
    })
    await c.end()

    const records = of(await allRecords(posts), 'conn-open')
    expect(records.length).toBeGreaterThan(1)
    for (const r of records) {
      expect(r.relay).toBe('https://Relay.test:4433')
      expect(r.options).toEqual({
        congestionControl: 'low-latency',
        allowPooling: false,
        serverCertificateHashes: 2,
      })
    }
    expect(JSON.stringify(records)).not.toMatch(/secret|token|moqt-19/)
  })

  it('leaves the options off a connection opened without any', async () => {
    const { posts, impl } = recordingFetch()
    const c = init(base(), { ...quiet, fetchImpl: impl })
    await settle()
    await open('https://relay.test/moq', { protocols: ['moqt-20'] })
    await c.end()
    const [conn] = merged(await allRecords(posts))
    expect(conn?.relay).toBe('https://relay.test')
    expect(conn).not.toHaveProperty('options')
  })
})

describe('a connection says who closed it', () => {
  it('the relay, with its code and reason', async () => {
    const { posts, impl } = recordingFetch()
    const c = init(base(), { ...quiet, fetchImpl: impl })
    await settle()
    const wt = await open()
    wt.closeSession('draining', 3)
    await settle()
    await c.end()
    expect(of(await allRecords(posts), 'conn-close')).toEqual([
      expect.objectContaining({ cause: 'closed', by: 'relay', code: 3, reason: 'draining' }),
    ])
  })

  it('the page, when it called close()', async () => {
    const { posts, impl } = recordingFetch()
    const c = init(base(), { ...quiet, fetchImpl: impl })
    await settle()
    const wt = await open()
    wt.close({ closeCode: 0, reason: 'source switch' })
    await settle()
    await c.end()
    expect(of(await allRecords(posts), 'conn-close')).toEqual([
      expect.objectContaining({ cause: 'closed', by: 'client', code: 0, reason: 'source switch' }),
    ])
  })

  it('the browser, when the transport failed on its own', async () => {
    const { posts, impl } = recordingFetch()
    const c = init(base(), { ...quiet, fetchImpl: impl })
    await settle()
    const wt = await open()
    wt.errorSession(new Error('network lost'))
    await settle()
    await c.end()
    const [close] = of(await allRecords(posts), 'conn-close')
    expect(close).toMatchObject({ cause: 'failed', by: 'local' })
    expect(close).not.toHaveProperty('code')
  })

  it('nobody, when the session ended with the connection open', async () => {
    const { posts, impl } = recordingFetch()
    const c = init(base(), { ...quiet, fetchImpl: impl })
    await settle()
    await open()
    await c.end()
    const [close] = of(await allRecords(posts), 'conn-close')
    expect(close?.cause).toBe('session-end')
    expect(close).not.toHaveProperty('by')
  })
})

describe('a receive track arrives as runs, and nothing infers the groups between', () => {
  it('one run per group, and no row counts a gap', async () => {
    const { posts, impl } = recordingFetch()
    const c = init(base(), { ...quiet, fetchImpl: impl })
    await settle()
    const wt = await open()
    const uni = wt.incomingUnidirectionalStreams.getReader()
    for (const group of [1n, 4n, 6n]) {
      const bytes = subgroupBytes({ alias: 4n, group, objects: [{ id: 0n, bytes: 10 }] })
      await receive(wt, uni, bytes, 'close')
    }
    await c.end()

    const { runs } = await allFacts(posts.map((p) => p.body))
    expect(runs.map((r) => [r.g, r.ids, r.b, r.end])).toEqual([
      [1n, [0n], 10, 'fin'],
      [4n, [0n], 10, 'fin'],
      [6n, [0n], 10, 'fin'],
    ])
    for (const t of rows(await allRecords(posts))) {
      expect(t).not.toHaveProperty('groupGaps')
      expect(t).not.toHaveProperty('gapRanges')
    }
  })

  it('a stream the relay reset ends its run with the code', async () => {
    const { posts, impl } = recordingFetch()
    const c = init(base(), { ...quiet, fetchImpl: impl })
    await settle()
    const wt = await open()
    const uni = wt.incomingUnidirectionalStreams.getReader()
    const bytes = subgroupBytes({ alias: 4n, group: 2n, objects: [{ id: 0n, bytes: 10 }] })
    await receive(wt, uni, bytes, { reset: 7 })
    await c.end()

    const { runs } = await allFacts(posts.map((p) => p.body))
    expect(runs.map((r) => [r.g, r.end, r.rc])).toEqual([[2n, 'reset', 7n]])
  })
})

describe('a track row says which streams were reset, by code', () => {
  it('a receive stream the relay reset', async () => {
    const { posts, impl } = recordingFetch()
    const c = init(base(), { ...quiet, fetchImpl: impl })
    await settle()
    const wt = await open()
    const uni = wt.incomingUnidirectionalStreams.getReader()
    const one = (group: bigint) =>
      subgroupBytes({ alias: 4n, group, objects: [{ id: 0n, bytes: 10 }] })
    await receive(wt, uni, one(1n), { reset: 7 })
    await receive(wt, uni, one(2n), { reset: 7 })
    await receive(wt, uni, one(3n), { reset: 2 })
    await c.end()

    const resets: Record<string, number> = {}
    for (const t of rows(await allRecords(posts))) {
      if (t.key.d !== 'rx' || t.key.v !== '4') continue
      for (const [code, n] of Object.entries(t.resets ?? {})) resets[code] = (resets[code] ?? 0) + n
    }
    expect(resets).toEqual({ '7': 2, '2': 1 })
  })

  it('a send stream the page aborted', async () => {
    const { posts, impl } = recordingFetch()
    const c = init(base(), { ...quiet, fetchImpl: impl })
    await settle()
    const wt = await open()
    const writer = (await wt.createUnidirectionalStream()).getWriter()
    await writer.write(subgroupBytes({ alias: 9n, group: 1n, objects: [{ id: 0n, bytes: 10 }] }))
    await writer.abort(Object.assign(new Error('dropped'), { streamErrorCode: 5 }))
    await settle()
    await c.end()

    const tx = rows(await allRecords(posts)).filter((t) => t.key.d === 'tx' && t.key.v === '9')
    expect(tx.flatMap((t) => Object.entries(t.resets ?? {}))).toEqual([['5', 1]])
  })

  it('a stream reset before its header named a track, on the connection', async () => {
    const { posts, impl } = recordingFetch()
    const c = init(base(), { ...quiet, fetchImpl: impl })
    await settle()
    const wt = await open()
    const writer = (await wt.createUnidirectionalStream()).getWriter()
    await writer.abort()
    await settle()
    await c.end()

    const all = await allRecords(posts)
    expect(rows(all).some((t) => t.resets !== undefined)).toBe(false)
    const untracked = of(all, 'rollup').reduce(
      (n, r) => n + (r.session['resets.untracked'] ?? 0),
      0,
    )
    expect(untracked).toBe(1)
  })
})

describe('the bodies a session uploads, as one emitter', () => {
  it('number every record once, chain their intervals, and list the connections their runs name', async () => {
    const { posts, impl } = recordingFetch()
    const c = init(base(), { ...quiet, fetchImpl: impl })
    await settle()
    const wt = await open('https://relay.test:4443/moq?token=secret')
    const uni = wt.incomingUnidirectionalStreams.getReader()
    for (const group of [1n, 2n]) {
      const bytes = subgroupBytes({ alias: 4n, group, objects: [{ id: 0n, bytes: 10 }] })
      await receive(wt, uni, bytes, 'close')
      await c.flush()
    }
    await c.end()

    const heads = posts.map((p) => preambleOf(p.body))
    expect(heads.map((h) => h.seal.seq)).toEqual(heads.map((_, i) => i))
    for (let i = 1; i < heads.length; i++) {
      expect(heads[i]!.seal.from_us).toBe(heads[i - 1]!.seal.through_us)
    }
    // Every rseq the emitter handed out is in exactly one body's ranges.
    const em = heads.flatMap((h) =>
      h.em.flatMap(([f, n]) => Array.from({ length: n }, (_, k) => f + k)),
    )
    expect([...em].sort((a, b) => a - b)).toEqual(em.map((_, i) => i))
    const all = await allRecords(posts)
    const batches = of(all, 'batch')
    expect(batches.at(-1)?.tail.last_rseq).toBe(em.length - 1)
    for (const h of heads) expect(h.i).toBe(c.ids().instanceId)

    const { runs } = await allFacts(posts.map((p) => p.body))
    expect(runs.map((r) => [r.g, r.c, r.key])).toEqual([
      [1n, 0, 'rx:alias:4:0'],
      [2n, 0, 'rx:alias:4:0'],
    ])
    const listed = batches.filter((b) => b.conn.length > 0)[0]?.conn
    expect(listed).toEqual([{ c: 0, draft: 20, relay: 'https://relay.test:4443' }])
    expect(of(all, 'conn-open')[0]).toMatchObject({ c: 0 })
    expect(of(all, 'ctrl').every((r) => r.c === 0 && typeof r.at_us === 'number')).toBe(true)
  })

  it('keep a connection’s ordinal across newSession(), so its runs stay with its requests', async () => {
    const { posts, impl } = recordingFetch()
    const c = init(base(), { ...quiet, fetchImpl: impl })
    await settle()
    const first = await open('https://relay.test:4443/moq')
    const uni = first.incomingUnidirectionalStreams.getReader()
    await receive(
      first,
      uni,
      subgroupBytes({ alias: 4n, group: 1n, objects: [{ id: 0n, bytes: 10 }] }),
      'close',
    )
    c.newSession({ sessionId: 'sess-second' })
    await settle()
    await receive(
      first,
      uni,
      subgroupBytes({ alias: 4n, group: 2n, objects: [{ id: 0n, bytes: 10 }] }),
      'close',
    )
    // A connection opened after the rotation is a new one.
    await open('https://relay.test:4443/other')
    await c.end()

    const all = await allRecords(posts)
    const { runs } = await allFacts(posts.map((p) => p.body))
    expect(runs.map((r) => [r.g, r.c])).toEqual([
      [1n, 0],
      [2n, 0],
    ])
    // Each transport is one connection, in both sessions.
    expect(merged(all).map((r) => r.c)).toEqual([0, 1])
    expect(
      of(all, 'conn-open').every((r) => r.c === (r.conn === merged(all)[0]?.conn ? 0 : 1)),
    ).toBe(true)
  })
})
