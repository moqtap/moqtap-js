/**
 * The batch record's `clock` from a running page: none before ingest has
 * answered a `fetch()`, then the device's clock against ingest's on every
 * body, kept across the page's sessions.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetDormantForTest, teardownDormant } from '../../api/dormant.js'
import { FORWARD_INTERVAL_MS } from '../../api/link.js'
import { initWorkerWith } from '../../api/worker.js'
import { RECV_HEADER, SEND_HEADER } from '../../flush/index.js'
import type { BatchRecord, ClockSource, CollectorConfig } from '../../types.js'
import { subgroupBytes } from '../decode/vectors.js'
import { attempt, init, workerBuild } from '../support/init.js'
import { factsOf } from '../support/runs.js'
import { settle } from '../support/settle.js'
import { of, type Post, recordingFetch, recordsOf } from '../support/uploads.js'
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
  ...over,
})

const quiet = { persist: false, noLifecycleListeners: true, locks: null } as const

/** Ingest's clock, 5 s ahead of the device's wall clock. */
const AHEAD_MS = 5_000

/** Ingest answering the clock probe and every upload with its clock. */
function answering(): { posts: Post[]; probes: string[]; impl: typeof fetch } {
  const stamp = () => {
    const now = String(Date.now() + AHEAD_MS)
    return { [RECV_HEADER]: now, [SEND_HEADER]: now, 'x-moqtap-pop': 'TST' }
  }
  const probes: string[] = []
  const rec = recordingFetch(stamp)
  const impl = (async (url: string, init: RequestInit) => {
    if (!String(url).includes('/v1/clock')) return rec.impl(url, init)
    probes.push(String(url))
    const h = new Map(Object.entries(stamp()))
    return { ok: true, status: 204, headers: { get: (n: string) => h.get(n) ?? null } }
  }) as unknown as typeof fetch
  return { posts: rec.posts, probes, impl }
}

const batchOf = async (p: Post): Promise<BatchRecord> => of(await recordsOf(p.body), 'batch')[0]!

describe('the clock on each body', () => {
  it('has a sample from the start probe, before the first body is sealed', async () => {
    const { posts, probes, impl } = answering()
    const c = init(base(), { ...quiet, fetchImpl: impl })
    await settle()
    attempt()
    await settle()
    c.annotate('first')
    await c.flush()
    await c.end()

    expect(probes).toEqual([`https://ingest.test/v1/clock?k=pk_test&i=${c.ids().instanceId}`])
    const clk = (await batchOf(posts[0]!)).clk
    expect(clk).toMatchObject({ epoch: 0, pop: 'TST' })
    expect(clk.r_us).toBeGreaterThanOrEqual(0)
    // Server minus mono: ingest's wall clock less the page's performance.now().
    const want = (Date.now() + AHEAD_MS - performance.now()) * 1000
    expect(Math.abs((clk.o_us as number) - want)).toBeLessThan(2_000_000)
    expect(clk.res_us).toBeGreaterThanOrEqual(1)
  })

  it('raises the epoch when a worker hosting the transport sees its clock break', async () => {
    const { posts, probes, impl } = answering()
    const channel = new MessageChannel()
    const c = init(base(), { ...quiet, fetchImpl: impl })
    c.linkWorker(channel.port1)
    await settle(5)
    let skew = 0
    const clock: ClockSource = {
      now: () => performance.now(),
      wall: () => Date.now() + skew,
    }
    const probe = initWorkerWith(workerBuild, channel.port2, { clock })
    expect(await probe.linked).toBe(true)
    const wt = new (g.WebTransport as new (u: string) => MockWebTransport)('https://relay.test/w')
    await wt.open('moqt-20')
    await settle(5)
    const uni = wt.incomingUnidirectionalStreams.getReader()
    const send = async (group: bigint): Promise<void> => {
      const objects = [{ id: 0n, bytes: 1 }]
      wt.deliverUniStream([subgroupBytes({ alias: 4n, group, objects })]).close()
      const reader = ((await uni.read()).value as ReadableStream<Uint8Array>).getReader()
      for (;;) if ((await reader.read()).done) break
      await settle(40, FORWARD_INTERVAL_MS)
    }
    await send(1n)
    // Suspended: the worker's monotonic clock stood still while wall time went on.
    skew = 60_000
    await send(2n)
    await c.flush()
    await c.end()

    expect(probes).toHaveLength(2)
    const epochOf = new Map<bigint, number>()
    for (const p of posts) {
      const epoch = (await batchOf(p)).clk.epoch
      for (const r of (await factsOf(p.body)).runs) epochOf.set(r.g, epoch)
    }
    expect([...epochOf]).toEqual([
      [1n, 0],
      [2n, 1],
    ])
    channel.port1.close()
    channel.port2.close()
  })
})
