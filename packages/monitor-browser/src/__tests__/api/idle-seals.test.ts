/**
 * While a connection is open, every due seal makes a body, with only its batch
 * record when nothing is buffered, at the time the body before it stated. With
 * none open, a seal with nothing to send makes no body.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_UPLOAD } from '../../api/defaults.js'
import { resetDormantForTest, teardownDormant } from '../../api/dormant.js'
import { CONN_SPACE, FORWARD_INTERVAL_MS } from '../../api/link.js'
import { initWorkerWith } from '../../api/worker.js'
import { DIRECTIVE_HEADER, RECV_HEADER, SEND_HEADER } from '../../flush/index.js'
import type { CollectorConfig, Directive } from '../../types.js'
import { compressing } from '../support/gzip-busy.js'
import { init, workerBuild } from '../support/init.js'
import { of, type Post, preambleOf, recordingFetch, recordsOf } from '../support/uploads.js'
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
  teardownDormant()
  resetDormantForTest()
  g.WebTransport = originalWT
})

const base = (over: Partial<CollectorConfig> = {}): CollectorConfig => ({
  apiKey: 'pk_test',
  endpoint: 'https://ingest.test/v1/ingest',
  ...over,
})

const MINUTE = 60_000
const LAST_EARLY = Math.max(...DEFAULT_UPLOAD.earlyFlushesMs)

/** The server's wall clock in every answer. */
const SERVER_NOW = 5_000_000_000_000

/**
 * A page on the test's clock with one connection open, in the page or in a
 * worker it links, and every upload recorded. `directive` answers each upload.
 */
async function openPage(
  realm: 'page' | 'worker',
  directive: (n: number) => Directive | null = () => null,
) {
  const vt = virtualTime(compressing)
  const { posts, impl } = recordingFetch((n) => {
    const d = directive(n)
    return {
      [RECV_HEADER]: String(SERVER_NOW + vt.now),
      [SEND_HEADER]: String(SERVER_NOW + vt.now),
      ...(d !== null ? { [DIRECTIVE_HEADER]: JSON.stringify(d) } : {}),
    }
  })
  const c = init(base(), {
    persist: false,
    locks: null,
    fetchImpl: impl,
    noLifecycleListeners: true,
    timeOrigin: 0,
    ...vt.ports,
  })
  await vt.advanceTo(0)
  if (realm === 'worker') {
    const channel = new MessageChannel()
    c.linkWorker(channel.port1)
    await vt.advanceTo(0)
    const probe = initWorkerWith(workerBuild, channel.port2, { timeOrigin: 0, ...vt.ports })
    expect(await probe.linked).toBe(true)
  }
  const wt = new (g.WebTransport as new (u: string) => MockWebTransport)('https://relay.test/moq')
  await wt.open('moqt-20')
  await vt.advanceTo(realm === 'worker' ? FORWARD_INTERVAL_MS : 0)
  return { vt, posts, c, wt, readyAt: vt.now }
}

/** Each body's seal, records and listed connections, in upload order. */
async function bodies(posts: readonly Post[]) {
  const out = []
  for (const p of posts) {
    const records = await recordsOf(p.body)
    const [batch] = of(records, 'batch')
    out.push({ pre: preambleOf(p.body), records, conns: batch?.conn.map((x) => x.c) ?? [] })
  }
  return out
}

/**
 * One chain of bodies: each sealed from the one before it and never past the
 * next seal that one stated.
 */
function expectChain(all: Awaited<ReturnType<typeof bodies>>): void {
  for (let i = 1; i < all.length; i++) {
    const prev = (all[i - 1] as (typeof all)[number]).pre.seal
    const seal = (all[i] as (typeof all)[number]).pre.seal
    expect(seal.seq).toBe(prev.seq + 1)
    expect(seal.from_us).toBe(prev.through_us)
    expect(seal.through_us).toBeLessThanOrEqual(prev.next_us as number)
  }
}

/** Bodies sealed by the schedule alone: each exactly at the next seal the one before it stated. */
function expectOnTime(all: Awaited<ReturnType<typeof bodies>>, from: number): void {
  for (let i = Math.max(1, from); i < all.length; i++) {
    const prev = (all[i - 1] as (typeof all)[number]).pre.seal
    expect((all[i] as (typeof all)[number]).pre.seal.through_us).toBe(prev.next_us)
  }
}

describe('due seals while a connection is open', () => {
  for (const realm of ['page', 'worker'] as const) {
    it(`makes one body of only the batch record per interval, idle, from the ${realm}`, async () => {
      const { vt, posts, c, readyAt } = await openPage(realm)
      const opened = posts.length
      expect(opened).toBeGreaterThan(0)

      await vt.advanceTo(readyAt + LAST_EARLY + 4 * MINUTE)
      const all = await bodies(posts)
      const idle = all.slice(opened)
      // The early seal, then one an interval.
      expect(idle).toHaveLength(5)
      for (const b of idle) {
        expect(b.records.map((r) => r.t)).toEqual(['batch'])
        expect(b.pre.em).toEqual([])
        expect(b.pre.seal.next_us).toBeDefined()
        expect(b.conns).toHaveLength(1)
        if (realm === 'worker') expect(b.conns[0]).toBeGreaterThanOrEqual(CONN_SPACE)
        else expect(b.conns[0]).toBeLessThan(CONN_SPACE)
      }
      expect(idle.map((b) => b.pre.seal.through_us)).toEqual(
        [LAST_EARLY, ...[1, 2, 3, 4].map((k) => LAST_EARLY + k * MINUTE)].map(
          (ms) => (readyAt + ms) * 1000,
        ),
      )
      expectChain(all)
      expectOnTime(all, opened)
      await c.end()
    }, 60_000)

    it(`states the idle connection in tail.conn at zero, from the ${realm}`, async () => {
      const { vt, posts, c } = await openPage(realm)
      await vt.advanceTo(vt.now + LAST_EARLY + 2 * MINUTE)
      let stated = 0
      for (const p of posts) {
        const [batch] = of(await recordsOf(p.body), 'batch')
        const listed = batch?.conn.map((x) => x.c) ?? []
        expect(batch?.tail.conn).toEqual(listed.map((x) => [x, 0, 0]))
        if (listed.length > 0) stated += 1
      }
      expect(stated).toBeGreaterThanOrEqual(3)
      await c.end()
    }, 60_000)

    it(`makes no body once the connection has closed, in the ${realm}`, async () => {
      const { vt, posts, c, wt } = await openPage(realm)
      await vt.advanceTo(vt.now + 2 * MINUTE)
      wt.close()
      await vt.advanceTo(vt.now + (realm === 'worker' ? FORWARD_INTERVAL_MS : 0))
      const closed = posts.length
      expect(of((await bodies(posts)).at(-1)?.records ?? [], 'conn-close')).toHaveLength(1)

      await vt.advanceTo(vt.now + 10 * MINUTE)
      expect(posts).toHaveLength(closed)
      expectChain(await bodies(posts))
      await c.end()
    }, 60_000)
  }

  it('makes no body with no connection ever opened', async () => {
    const vt = virtualTime(compressing)
    const { posts, impl } = recordingFetch()
    const c = init(base(), {
      persist: false,
      locks: null,
      fetchImpl: impl,
      noLifecycleListeners: true,
      timeOrigin: 0,
      ...vt.ports,
    })
    await vt.advanceTo(10 * MINUTE)
    expect(posts).toHaveLength(0)
    await c.end()
  }, 60_000)

  it('seals every 2 s while watched, then at the seal the last watched body stated', async () => {
    // The first upload's answer asks for 2 s seals until 10 s.
    const { vt, posts, c, readyAt } = await openPage('page', (n) =>
      n === 0 ? { flushMs: 2_000, until: SERVER_NOW + 10_000 } : null,
    )
    expect(readyAt).toBe(0)
    await vt.advanceTo(LAST_EARLY + 2 * MINUTE)
    const all = await bodies(posts)
    expectChain(all)
    // The first 2 s seal comes before the 45 s one stated without the watch.
    expectOnTime(all, 2)
    expect(all.map((b) => b.pre.seal.through_us / 1000)).toEqual([
      0,
      2_000,
      4_000,
      6_000,
      8_000,
      10_000,
      // The early seal, and the interval restarted when the watch lapsed.
      LAST_EARLY,
      10_000 + MINUTE,
      10_000 + 2 * MINUTE,
    ])
    expect(all.slice(1, 5).map((b) => b.pre.seal.ms)).toEqual([2_000, 2_000, 2_000, 2_000])
    for (const b of all.slice(1)) expect(b.records.map((r) => r.t)).toEqual(['batch'])
    await c.end()
  }, 60_000)
})
