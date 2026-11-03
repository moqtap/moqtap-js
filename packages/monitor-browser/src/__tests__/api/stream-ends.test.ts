/**
 * What the page records about a stream beyond its objects: an end that comes
 * after its last run was sealed, a stream that carried no object, a stream
 * open across `newSession()`, a connection whose draft is not known yet, and
 * the integrator's own UTC clock.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetDormantForTest, teardownDormant } from '../../api/dormant.js'
import type { CollectorConfig } from '../../types.js'
import { subgroupBytes } from '../decode/vectors.js'
import { init } from '../support/init.js'
import { allFacts } from '../support/runs.js'
import { settle } from '../support/settle.js'
import { allRecords, of, recordingFetch } from '../support/uploads.js'
import { type ManualSource, MockWebTransport } from '../transport/mocks.js'

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

async function open(protocol = 'moqt-20') {
  const wt = new (g.WebTransport as Ctor)('https://relay.test:4443/moq')
  await wt.open(protocol)
  await settle(5)
  return { wt, uni: wt.incomingUnidirectionalStreams.getReader() }
}

/** A receive stream carrying `first`, read; the source and the page's reader stay open. */
async function stream(
  wt: MockWebTransport,
  uni: ReadableStreamDefaultReader<ReadableStream<Uint8Array>>,
  first: Uint8Array,
): Promise<{ src: ManualSource<Uint8Array>; reader: ReadableStreamDefaultReader<Uint8Array> }> {
  const src = wt.deliverUniStream([first])
  const arrived = await uni.read()
  const reader = (arrived.value as ReadableStream<Uint8Array>).getReader()
  await reader.read()
  await settle(2)
  return { src, reader }
}

async function fin(s: Awaited<ReturnType<typeof stream>>): Promise<void> {
  s.src.close()
  await s.reader.read()
  await settle(2)
}

const one = subgroupBytes({ alias: 4n, group: 1n, objects: [{ id: 0n, bytes: 10 }] })
const two = subgroupBytes({
  alias: 4n,
  group: 1n,
  objects: [
    { id: 0n, bytes: 10 },
    { id: 1n, bytes: 10 },
  ],
})

describe('a stream’s end that no run carries', () => {
  it('is recorded alone when it comes after the stream’s last run was sealed', async () => {
    const { posts, impl } = recordingFetch()
    const c = init(base(), { ...quiet, fetchImpl: impl })
    await settle()
    const { wt, uni } = await open()
    const s = await stream(wt, uni, one)
    await c.flush()
    await fin(s)
    await c.end()

    const { runs, ends } = await allFacts(posts.map((p) => p.body))
    expect(runs.map((r) => [r.g, r.ids, r.end])).toEqual([[1n, [0n], 'open']])
    expect(ends.map((e) => [e.end, e.eog, e.path, e.g, e.o, e.key])).toEqual([
      ['fin', false, 'sub_stream', 1n, 0n, 'rx:alias:4:0'],
    ])
  })

  it('is recorded for a stream that carried no object, with its header’s group', async () => {
    const { posts, impl } = recordingFetch()
    const c = init(base(), { ...quiet, fetchImpl: impl })
    await settle()
    const { wt, uni } = await open()
    const empty = subgroupBytes({ alias: 4n, group: 102n, headerType: 0x18, objects: [] })
    await fin(await stream(wt, uni, empty))
    await c.end()

    const { runs, ends } = await allFacts(posts.map((p) => p.body))
    expect(runs).toEqual([])
    expect(ends.map((e) => [e.end, e.eog, e.g, e.o])).toEqual([['fin', true, 102n, null]])
  })
})

describe('a stream open across newSession()', () => {
  it('goes on in the next session: its objects continue the run, and its FIN ends it', async () => {
    const { posts, impl } = recordingFetch()
    const c = init(base(), { ...quiet, fetchImpl: impl })
    await settle()
    const { wt, uni } = await open()
    const s = await stream(wt, uni, one)
    const first = c.ids()
    const second = c.newSession({ sessionId: 'sess-second' })
    await settle()
    s.src.push(two.subarray(one.byteLength))
    await s.reader.read()
    await settle(2)
    await fin(s)
    await c.end()

    const { runs, ends } = await allFacts(posts.map((p) => p.body))
    expect(runs.map((r) => [r.g, r.ids, r.cont, r.end, r.c])).toEqual([
      [1n, [0n], false, 'open', 0],
      [1n, [1n], true, 'fin', 0],
    ])
    expect(ends).toEqual([])
    const sessions = of(await allRecords(posts), 'batch').map((b) => b.sessionId)
    expect(new Set(sessions)).toEqual(new Set([first.sessionId, second.sessionId]))
    const parse = of(await allRecords(posts), 'conn-close').map((r) => r.counters.parseFailures)
    expect(parse.every((n) => n === 0)).toBe(true)
  })
})

describe('a connection whose draft is not known', () => {
  it('is listed without one until SETUP names it', async () => {
    const { posts, impl } = recordingFetch()
    const c = init(base(), { ...quiet, fetchImpl: impl })
    await settle()
    await open('moq-00')
    c.annotate('waiting for SETUP')
    await c.flush()
    await c.end()
    const batches = of(await allRecords(posts), 'batch')
    expect(batches[0]?.conn).toEqual([{ c: 0, relay: 'https://relay.test:4443/moq' }])
  })
})

describe('CollectorConfig.clock', () => {
  it('puts its offset to UTC, its bound and when it was read on every body', async () => {
    const { posts, impl } = recordingFetch()
    const c = init(
      base({
        clock: () => ({ nowMs: performance.timeOrigin + performance.now() + 250, errorMs: 1.5 }),
      }),
      { ...quiet, fetchImpl: impl },
    )
    await settle()
    await open()
    c.annotate('x')
    await c.end()
    const batches = of(await allRecords(posts), 'batch')
    expect(batches.length).toBeGreaterThan(0)
    for (const b of batches) {
      const app = b.clk.app
      expect(app).toBeDefined()
      expect(app?.e_us).toBe(1_500)
      expect(Number.isSafeInteger(app?.o_us)).toBe(true)
      expect(Number.isSafeInteger(app?.at_us)).toBe(true)
      // `o_us + at_us` is UTC µs at the reading, a quarter second ahead of the page's own.
      const utc = (app?.o_us ?? 0) + (app?.at_us ?? 0)
      expect(
        Math.abs(utc - (performance.timeOrigin + (app?.at_us ?? 0) / 1000 + 250) * 1000),
      ).toBeLessThan(5_000)
    }
  })

  it('leaves a body without one when the clock throws or has no reading', async () => {
    const { posts, impl } = recordingFetch()
    const errors: unknown[] = []
    let calls = 0
    const c = init(
      base({
        onInternalError: (e) => errors.push(e),
        clock: () => {
          calls += 1
          if (calls === 1) throw new Error('clock down')
          return null
        },
      }),
      { ...quiet, fetchImpl: impl },
    )
    await settle()
    await open()
    c.annotate('x')
    await c.flush()
    c.annotate('y')
    await c.end()
    for (const b of of(await allRecords(posts), 'batch')) expect(b.clk).not.toHaveProperty('app')
    expect(errors.map(String)).toContain('Error: clock down')
  })
})
