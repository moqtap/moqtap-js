/**
 * The browsing-session id lives in the tab's sessionStorage, so the page
 * loads of one tab share it; every body says where it came from. Each
 * connection's bytes are reported per second, each way.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ensureDormantHook, resetDormantForTest, teardownDormant } from '../../api/dormant.js'
import {
  forgetTabSession,
  isMintedId,
  peekTabSession,
  TAB_SESSION_KEY,
  tabSession,
} from '../../api/tab-session.js'
import type { CollectorConfig } from '../../types.js'
import { subgroupBytes } from '../decode/vectors.js'
import { init } from '../support/init.js'
import { type DecodedBw, factsOf } from '../support/runs.js'
import { settle } from '../support/settle.js'
import { allRecords, of, recordingFetch } from '../support/uploads.js'
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

const UUID = '0b6a3b3e-6f7a-4d5e-9c1a-2b3c4d5e6f70'

function tab(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial))
  const reads = { n: 0 }
  return {
    items,
    reads,
    sessionStorage: {
      getItem: (k: string) => {
        reads.n += 1
        return items.get(k) ?? null
      },
      setItem: (k: string, v: string) => void items.set(k, v),
      removeItem: (k: string) => void items.delete(k),
    },
  }
}

const throwing = {
  get sessionStorage(): never {
    throw Object.assign(new Error('blocked'), { name: 'SecurityError' })
  },
}

describe('the tab id', () => {
  it('is read when stored in the minted form', () => {
    const t = tab({ [TAB_SESSION_KEY]: UUID })
    expect(tabSession(t, () => 'unused')).toEqual({ id: UUID, ss: 'stored' })
    expect(peekTabSession(t)).toBe(UUID)
  })

  it('is minted and written when none is stored', () => {
    const t = tab()
    expect(tabSession(t, () => UUID)).toEqual({ id: UUID, ss: 'new' })
    expect(t.items.get(TAB_SESSION_KEY)).toBe(UUID)
  })

  it('replaces a value the monitor did not mint', () => {
    const t = tab({ [TAB_SESSION_KEY]: 'planted-by-the-page' })
    expect(peekTabSession(t)).toBeNull()
    expect(tabSession(t, () => UUID)).toEqual({ id: UUID, ss: 'new' })
    expect(t.items.get(TAB_SESSION_KEY)).toBe(UUID)
  })

  it('covers the page load only when storage throws or is absent', () => {
    expect(tabSession(throwing, () => UUID)).toEqual({ id: UUID, ss: 'page' })
    expect(tabSession({}, () => UUID)).toEqual({ id: UUID, ss: 'page' })
    const full = tab()
    full.sessionStorage.setItem = () => {
      throw Object.assign(new Error('full'), { name: 'QuotaExceededError' })
    }
    expect(tabSession(full, () => UUID)).toEqual({ id: UUID, ss: 'page' })
  })

  it('takes both minted forms', () => {
    expect(isMintedId(UUID)).toBe(true)
    expect(isMintedId('s-18f2a3b4c5d-0123456789abcdef01234567')).toBe(true)
    expect(isMintedId(UUID.toUpperCase())).toBe(false)
    expect(isMintedId('')).toBe(false)
  })

  it('is forgotten only when it is the one stored', () => {
    const t = tab({ [TAB_SESSION_KEY]: UUID })
    forgetTabSession('another', t)
    expect(t.items.get(TAB_SESSION_KEY)).toBe(UUID)
    forgetTabSession(UUID, t)
    expect(t.items.has(TAB_SESSION_KEY)).toBe(false)
  })
})

const base = (over: Partial<CollectorConfig> = {}): CollectorConfig => ({
  apiKey: 'pk_test',
  endpoint: 'https://ingest.test/v1/ingest',
  ...over,
})

const quiet = { persist: false, noLifecycleListeners: true, locks: null } as const

type Ctor = new (url: string) => MockWebTransport

async function open(url = 'https://relay.test/moq'): Promise<MockWebTransport> {
  const wt = new (g.WebTransport as Ctor)(url)
  await wt.open('moqt-20')
  await settle(5)
  return wt
}

describe('a page load of a tab', () => {
  it('touches no storage until its first WebTransport, then joins the tab: reloads share the id', async () => {
    const t = tab()
    const first = recordingFetch()
    const a = init(base(), { ...quiet, fetchImpl: first.impl, sessionStorageOf: t })
    await settle()
    expect(t.reads.n).toBe(0)
    expect(t.items.size).toBe(0)
    const provisional = a.ids().sessionId
    await open()
    await a.end()
    const one = of(await allRecords(first.posts), 'batch')
    expect(one.length).toBeGreaterThan(0)
    expect(one.every((b) => b.ss === 'new')).toBe(true)
    const id = t.items.get(TAB_SESSION_KEY)
    expect(one.every((b) => b.sessionId === id)).toBe(true)
    expect(id).toBe(provisional)
    expect(a.ids().sessionId).toBe(id)

    teardownDormant()
    resetDormantForTest()
    const second = recordingFetch()
    const b = init(base(), { ...quiet, fetchImpl: second.impl, sessionStorageOf: t })
    await settle()
    t.reads.n = 0
    expect(b.ids().sessionId).not.toBe(id)
    expect(t.reads.n).toBe(0)
    await open()
    expect(b.ids().sessionId).toBe(id)
    await b.end()
    const two = of(await allRecords(second.posts), 'batch')
    expect(two.every((x) => x.ss === 'stored' && x.sessionId === id)).toBe(true)
    expect(two[0]?.instanceId).not.toBe(one[0]?.instanceId)
  })

  it('reads and writes nothing in a page load that opens no WebTransport', async () => {
    const t = tab({ [TAB_SESSION_KEY]: UUID })
    const c = init(base(), { ...quiet, fetchImpl: recordingFetch().impl, sessionStorageOf: t })
    await settle()
    c.ids()
    await c.end()
    expect(t.reads.n).toBe(0)
    expect(t.items.get(TAB_SESSION_KEY)).toBe(UUID)
  })

  it('says page when the tab has no storage it can use', async () => {
    const { posts, impl } = recordingFetch()
    const c = init(base(), { ...quiet, fetchImpl: impl, sessionStorageOf: throwing })
    await settle()
    await open()
    await c.end()
    const batches = of(await allRecords(posts), 'batch')
    expect(batches.every((b) => b.ss === 'page')).toBe(true)
  })

  it('states no source for an id the integrator supplied', async () => {
    const t = tab()
    const { posts, impl } = recordingFetch()
    const c = init(base({ sessionId: 'mine' }), { ...quiet, fetchImpl: impl, sessionStorageOf: t })
    await settle()
    await open()
    await c.end()
    const batches = of(await allRecords(posts), 'batch')
    expect(batches.every((b) => b.sessionId === 'mine' && !('ss' in b))).toBe(true)
    expect(t.items.size).toBe(0)
  })

  it('forgets the tab id on discard()', async () => {
    const t = tab()
    const c = init(base(), { ...quiet, fetchImpl: recordingFetch().impl, sessionStorageOf: t })
    await settle()
    await open()
    expect(t.items.has(TAB_SESSION_KEY)).toBe(true)
    await c.discard()
    expect(t.items.has(TAB_SESSION_KEY)).toBe(false)
  })

  it('forgets the tab id on discard() before any WebTransport', async () => {
    const t = tab({ [TAB_SESSION_KEY]: UUID })
    const c = init(base(), { ...quiet, fetchImpl: recordingFetch().impl, sessionStorageOf: t })
    await settle()
    await c.discard()
    expect(t.items.has(TAB_SESSION_KEY)).toBe(false)
  })
})

describe('bandwidth', () => {
  it('counts the bytes a connection carried before init()', async () => {
    const { posts, impl } = recordingFetch()
    ensureDormantHook()
    const wt = new (g.WebTransport as Ctor)('https://relay.test/moq')
    await wt.open('moqt-20')
    const uni = wt.incomingUnidirectionalStreams.getReader()
    const bytes = subgroupBytes({ alias: 4n, group: 1n, objects: [{ id: 0n, bytes: 12 }] })
    const src = wt.deliverUniStream([bytes])
    const reader = ((await uni.read()).value as ReadableStream<Uint8Array>).getReader()
    await reader.read()
    src.close()
    await reader.read()
    await settle(2)
    const c = init(base(), { ...quiet, fetchImpl: impl })
    await settle()
    await c.end()

    const bw: DecodedBw[] = []
    for (const p of posts) bw.push(...(await factsOf(p.body)).bw)
    const received = bw
      .filter((e) => !e.sent)
      .reduce((n, e) => n + e.pre + e.secs.reduce((m, [, b]) => m + b, 0), 0)
    expect(received).toBe(bytes.byteLength)
  })

  it('counts every byte each way per connection and second, control streams included', async () => {
    const { posts, impl } = recordingFetch()
    const c = init(base(), { ...quiet, fetchImpl: impl })
    await settle()
    const wt = await open()
    const uni = wt.incomingUnidirectionalStreams.getReader()
    const bytes = subgroupBytes({ alias: 4n, group: 1n, objects: [{ id: 0n, bytes: 10 }] })
    const src = wt.deliverUniStream([bytes])
    const arrived = await uni.read()
    const reader = (arrived.value as ReadableStream<Uint8Array>).getReader()
    await reader.read()
    src.close()
    await reader.read()
    const out = await wt.createUnidirectionalStream()
    const writer = (out as unknown as WritableStream<Uint8Array>).getWriter()
    await writer.write(new Uint8Array(7))
    await settle(2)
    await c.end()

    const bw: DecodedBw[] = []
    for (const p of posts) bw.push(...(await factsOf(p.body)).bw)
    const total = (sent: boolean) =>
      bw
        .filter((e) => e.sent === sent)
        .reduce((n, e) => n + e.pre + e.secs.reduce((m, [, b]) => m + b, 0), 0)
    expect(total(false)).toBe(bytes.byteLength)
    expect(total(true)).toBe(7)
    for (const e of bw) {
      expect(e.c).toBe(0)
      const seconds = e.secs.map(([i]) => i)
      expect(seconds).toEqual([...seconds].sort((x, y) => x - y))
      for (const [i] of e.secs) expect(i).toBe(Math.floor(i))
    }
  })
})
