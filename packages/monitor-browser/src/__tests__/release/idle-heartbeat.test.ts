/**
 * An open connection with no traffic stays open in the records, and each due
 * seal brings a body stating so: with only the batch record, at the time the
 * body before it stated, with its tail and connection list unchanged.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_UPLOAD } from '../../api/defaults.js'
import { resetDormantForTest, teardownDormant } from '../../api/dormant.js'
import type { CollectorConfig, EnvelopeRecord } from '../../types.js'
import { compressing } from '../support/gzip-busy.js'
import { init } from '../support/init.js'
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

const MINUTE = 60_000
const LAST_EARLY = Math.max(...DEFAULT_UPLOAD.earlyFlushesMs)
type WT = new (u: string) => MockWebTransport

function start(upload?: CollectorConfig['upload']) {
  const vt = virtualTime(compressing)
  const { posts, impl } = recordingFetch()
  const c = init(
    {
      apiKey: 'pk_test',
      endpoint: 'https://ingest.test/v1/ingest',
      ...(upload !== undefined ? { upload } : {}),
    },
    {
      persist: false,
      locks: null,
      fetchImpl: impl,
      noLifecycleListeners: true,
      timeOrigin: 0,
      ...vt.ports,
    },
  )
  return { vt, posts, c }
}

interface Body {
  pre: ReturnType<typeof preambleOf>
  records: EnvelopeRecord[]
  batch: Extract<EnvelopeRecord, { t: 'batch' }>
}

async function bodies(posts: readonly Post[]): Promise<Body[]> {
  const out: Body[] = []
  for (const p of posts) {
    const records = await recordsOf(p.body)
    const [batch] = of(records, 'batch')
    if (batch === undefined) throw new Error('body without a batch record')
    out.push({ pre: preambleOf(p.body), records, batch })
  }
  return out
}

/** Contiguous seq, each body from the one before, never past the seal it stated. */
function expectChain(all: readonly Body[]): void {
  expect(all[0]?.pre.seal.seq).toBe(0)
  for (let i = 1; i < all.length; i++) {
    const prev = (all[i - 1] as Body).pre.seal
    const seal = (all[i] as Body).pre.seal
    expect(seal.seq).toBe(prev.seq + 1)
    expect(seal.from_us).toBe(prev.through_us)
    expect(prev.next_us).toBeDefined()
    expect(seal.through_us).toBeLessThanOrEqual(prev.next_us as number)
  }
}

/** Every body from `from` sealed exactly at the time the one before it stated. */
function expectOnTime(all: readonly Body[], from: number): void {
  for (let i = Math.max(1, from); i < all.length; i++) {
    expect((all[i] as Body).pre.seal.through_us).toBe((all[i - 1] as Body).pre.seal.next_us)
  }
}

function expectBatchOnly(b: Body): void {
  expect(b.records.map((r) => r.t)).toEqual(['batch'])
  expect(b.pre.em).toEqual([])
  expect(b.batch.final).not.toBe(true)
}

/** Move the clock on its spot until `n` `conn-close` records have been posted. */
async function closesPosted(
  vt: ReturnType<typeof virtualTime>,
  posts: readonly Post[],
  n: number,
): Promise<void> {
  const until = performance.now() + 5_000
  for (;;) {
    await vt.advanceTo(vt.now)
    const all = await bodies(posts)
    if (all.flatMap((x) => of(x.records, 'conn-close')).length >= n) return
    if (performance.now() > until) throw new Error(`${n} conn-close records not posted`)
  }
}

const listed = (b: Body) => b.batch.conn.map((x) => x.c).sort((x, y) => x - y)
const tailConns = (b: Body) => b.batch.tail.conn.map((x) => x[0]).sort((x, y) => x - y)

describe('idle WebTransport heartbeat', () => {
  it('keeps two idle connections open and listed through six intervals', async () => {
    const { vt, posts, c } = start()
    await vt.advanceTo(0)
    const a = new (g.WebTransport as WT)('https://relay.test/a')
    const b = new (g.WebTransport as WT)('https://relay.test/b')
    await a.open('moqt-20')
    await b.open('moqt-20')
    await vt.advanceTo(0)
    const opened = posts.length
    expect(opened).toBeGreaterThan(0)
    const readyAt = (await bodies(posts))[0]?.pre.seal.through_us as number

    await vt.advanceTo(readyAt / 1000 + LAST_EARLY + 6 * MINUTE)
    const all = await bodies(posts)
    const opening = all.slice(0, opened)
    const idle = all.slice(opened)
    const ids = [
      ...new Set(opening.flatMap((x) => of(x.records, 'conn-open').map((r) => r.c))),
    ].sort((x, y) => x - y)
    expect(ids).toHaveLength(2)

    // The early seal, then one an interval.
    expect(idle.map((x) => x.pre.seal.through_us / 1000 - readyAt / 1000)).toEqual([
      LAST_EARLY,
      ...[1, 2, 3, 4, 5, 6].map((k) => LAST_EARLY + k * MINUTE),
    ])
    const last = opening.at(-1) as Body
    for (const x of idle) {
      expectBatchOnly(x)
      expect(listed(x)).toEqual(ids)
      // Nothing happened: the counters and last rseq are the opening body's.
      expect(x.batch.tail).toEqual(last.batch.tail)
      expect(x.batch.conn).toEqual(last.batch.conn)
      expect(x.pre.seal.ms).toBe(DEFAULT_UPLOAD.intervalMs)
    }
    expect(all.flatMap((x) => of(x.records, 'conn-close'))).toEqual([])
    expect(all.flatMap((x) => of(x.records, 'end'))).toEqual([])
    expectChain(all)
    expectOnTime(all, opened)
    await c.end()
  }, 120_000)

  it('keeps heartbeating for the connection left open, and stops when it closes', async () => {
    const { vt, posts, c } = start()
    await vt.advanceTo(0)
    const a = new (g.WebTransport as WT)('https://relay.test/a')
    const b = new (g.WebTransport as WT)('https://relay.test/b')
    await a.open('moqt-20')
    await b.open('moqt-20')
    await vt.advanceTo(LAST_EARLY + MINUTE + 1_000)
    a.close()
    await closesPosted(vt, posts, 1)
    const closedOne = posts.length
    await vt.advanceTo(vt.now + 5 * MINUTE)
    const mid = await bodies(posts)
    const closes = mid.flatMap((x) => of(x.records, 'conn-close'))
    expect(closes).toHaveLength(1)
    const gone = closes[0]?.c as number
    const after = mid.slice(closedOne)
    expect(after.length).toBeGreaterThanOrEqual(5)
    for (const x of after) {
      expectBatchOnly(x)
      expect(listed(x)).toHaveLength(1)
      expect(listed(x)).not.toContain(gone)
    }
    expectOnTime(mid, closedOne + 1)

    b.close()
    await closesPosted(vt, posts, 2)
    const closedBoth = posts.length
    const all = await bodies(posts)
    expect(all.flatMap((x) => of(x.records, 'conn-close'))).toHaveLength(2)
    await vt.advanceTo(vt.now + 10 * MINUTE)
    expect(posts).toHaveLength(closedBoth)
    expectChain(await bodies(posts))
    await c.end()
  }, 120_000)

  it('lists each idle open connection in tail.conn', async () => {
    const { vt, posts, c } = start()
    await vt.advanceTo(0)
    const a = new (g.WebTransport as WT)('https://relay.test/a')
    await a.open('moqt-20')
    await vt.advanceTo(LAST_EARLY + 2 * MINUTE)
    const all = await bodies(posts)
    expect(all.length).toBeGreaterThanOrEqual(4)
    for (const x of all) expect(tailConns(x)).toEqual(listed(x))
    await c.end()
  }, 120_000)

  it('heartbeats for a connection still connecting', async () => {
    const { vt, posts, c } = start()
    await vt.advanceTo(0)
    ;new (g.WebTransport as WT)('https://relay.test/a')
    await vt.advanceTo(LAST_EARLY + 5 * MINUTE)
    const all = await bodies(posts)
    expect(all.length).toBeGreaterThanOrEqual(6)
    const idle = all.filter((x) => x.records.length === 1)
    expect(idle.length).toBeGreaterThanOrEqual(5)
    for (const x of idle) expect(listed(x)).toHaveLength(1)
    expect(all.flatMap((x) => of(x.records, 'conn-close'))).toEqual([])
    expectChain(all)
    await c.end()
  }, 120_000)

  it('heartbeats at a configured interval and early seal, over ten intervals', async () => {
    const { vt, posts, c } = start({ intervalMs: 5_000, earlyFlushesMs: [2_000] })
    await vt.advanceTo(0)
    const a = new (g.WebTransport as WT)('https://relay.test/a')
    await a.open('moqt-20')
    await vt.advanceTo(0)
    const opened = posts.length
    const readyAt = (await bodies(posts))[0]?.pre.seal.through_us as number
    await vt.advanceTo(readyAt / 1000 + 2_000 + 10 * 5_000)
    const all = await bodies(posts)
    const idle = all.slice(opened)
    expect(idle.map((x) => x.pre.seal.through_us / 1000 - readyAt / 1000)).toEqual([
      2_000,
      ...Array.from({ length: 10 }, (_, k) => 2_000 + (k + 1) * 5_000),
    ])
    for (const x of idle) {
      expectBatchOnly(x)
      expect(x.pre.seal.ms).toBe(5_000)
      expect(listed(x)).toHaveLength(1)
    }
    // Each stated seal is the interval on.
    for (const x of idle)
      expect((x.pre.seal.next_us as number) - x.pre.seal.through_us).toBe(5_000_000)
    expectChain(all)
    expectOnTime(all, opened)
    await c.end()
  }, 120_000)

  it('seals at ready and at +45 s by default, each stating the next', async () => {
    const { vt, posts, c } = start()
    await vt.advanceTo(0)
    const a = new (g.WebTransport as WT)('https://relay.test/a')
    await a.open('moqt-20')
    await vt.advanceTo(LAST_EARLY + MINUTE)
    const all = await bodies(posts)
    const ready = all[0] as Body
    expect(of(ready.records, 'conn-open').length).toBeGreaterThan(0)
    const t0 = ready.pre.seal.through_us
    expect(ready.pre.seal.next_us).toBe(t0 + LAST_EARLY * 1000)
    const early = all.find((x) => x.pre.seal.through_us === t0 + LAST_EARLY * 1000)
    expect(early).toBeDefined()
    expect(early?.pre.seal.next_us).toBe(t0 + (LAST_EARLY + MINUTE) * 1000)
    expectChain(all)
    await c.end()
  }, 120_000)
})
