/**
 * A page load's session from its first `WebTransport` to its final body, and
 * each connection's end: the cause, who ended it and when, on the runs' clock.
 * The final body is the only one marked final and the only one with no
 * `seal.next_us`; nothing ends a session or a connection for being idle.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_UPLOAD } from '../../api/defaults.js'
import { resetDormantForTest, teardownDormant, useDormantClockForTest } from '../../api/dormant.js'
import { envelope } from '../../api/link.js'
import type { BatchRecord, CollectorConfig, EnvelopeRecord } from '../../types.js'
import { compressing } from '../support/gzip-busy.js'
import { init } from '../support/init.js'
import { until } from '../support/settle.js'
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
const HOUR = 60 * MINUTE
const EARLY = Math.max(...DEFAULT_UPLOAD.earlyFlushesMs)

/** Every page lifecycle listener, dispatched as a window does: capture listeners first. */
function lifecycle() {
  const prevAdd = g.addEventListener
  const prevRemove = g.removeEventListener
  const added: { t: string; f: (e: unknown) => void; capture: boolean }[] = []
  g.addEventListener = (t: string, f: (e: unknown) => void, capture?: unknown) => {
    added.push({ t, f, capture: capture === true })
  }
  g.removeEventListener = (t: string, f: (e: unknown) => void, capture?: unknown) => {
    const i = added.findIndex((l) => l.t === t && l.f === f && l.capture === (capture === true))
    if (i >= 0) added.splice(i, 1)
  }
  return {
    fire(t: string, e: unknown = {}): void {
      const mine = added.filter((l) => l.t === t)
      for (const l of [...mine.filter((x) => x.capture), ...mine.filter((x) => !x.capture)]) {
        if (added.includes(l)) l.f(e)
      }
    },
    restore(): void {
      g.addEventListener = prevAdd
      g.removeEventListener = prevRemove
    },
  }
}

interface Body {
  pre: ReturnType<typeof preambleOf>
  batch: BatchRecord
  records: EnvelopeRecord[]
}

async function decode(bytes: Uint8Array): Promise<Body> {
  const records = await recordsOf(bytes)
  return { pre: preambleOf(bytes), batch: records[0] as BatchRecord, records: records.slice(1) }
}

/** Each distinct body, by its key, in sequence order. */
async function distinct(bytes: readonly Uint8Array[]): Promise<Body[]> {
  const byKey = new Map<string, Body>()
  for (const b of bytes) {
    const d = await decode(b)
    byKey.set(d.batch.idempotencyKey, d)
  }
  return [...byKey.values()].sort((a, b) => a.pre.seal.seq - b.pre.seal.seq)
}

/** A page on the test's clock, its hook included, with its lifecycle and beacon in the test's hands. */
async function page() {
  const vt = virtualTime(compressing)
  useDormantClockForTest(vt.ports.clock)
  const life = lifecycle()
  const { posts, impl } = recordingFetch()
  const beaconed: Uint8Array[] = []
  const reading: Promise<void>[] = []
  const c = init(base(), {
    persist: false,
    locks: null,
    fetchImpl: impl,
    timeOrigin: 0,
    beacon: (_url, blob) => {
      reading.push(blob.arrayBuffer().then((b) => void beaconed.push(new Uint8Array(b))))
      return true
    },
    ...vt.ports,
  })
  await vt.advanceTo(0)
  const bodies = async (): Promise<Body[]> => {
    await Promise.all(reading)
    return distinct([...posts.map((p: Post) => p.body), ...beaconed])
  }
  /** The bodies once `ok` holds of them: an upload lands after the seal that made it. */
  const arrived = async (ok: (all: Body[]) => boolean): Promise<Body[]> => {
    await until(async () => ok(await bodies()), 5_000)
    return bodies()
  }
  const beacons = async (): Promise<Body[]> => {
    await Promise.all(reading)
    return distinct(beaconed)
  }
  return { vt, life, posts, beaconed, c, bodies, arrived, beacons }
}

const connect = (url = 'https://relay.test/moq') =>
  new (g.WebTransport as new (u: string) => MockWebTransport)(url)

const records = (all: readonly Body[]) => all.flatMap((b) => b.records)

/** The body that carries `r`. */
const bodyOf = (all: readonly Body[], r: EnvelopeRecord): Body =>
  all.find((b) => b.records.includes(r)) as Body

/**
 * One instance's bodies: numbered from 0 with no gap, each sealed from the
 * one before it, every one but the last stating its next seal at or after
 * its own end, and the last marked final, naming itself in its `end` record
 * and stating none.
 */
function expectWhole(all: readonly Body[], reason: string): void {
  expect(all.map((b) => b.pre.seal.seq)).toEqual(all.map((_, i) => i))
  const instances = new Set(all.map((b) => `${b.batch.sessionId} ${b.batch.instanceId}`))
  expect(instances.size).toBe(1)
  for (let i = 0; i < all.length; i++) {
    const { pre, batch } = all[i] as Body
    expect(pre.seal.from_us).toBeLessThanOrEqual(pre.seal.through_us)
    if (i > 0) expect(pre.seal.from_us).toBe((all[i - 1] as Body).pre.seal.through_us)
    const last = i === all.length - 1
    expect(batch.final === true, `body ${i} final`).toBe(last)
    if (last) {
      expect(pre.seal).not.toHaveProperty('next_us')
    } else {
      expect(pre.seal.next_us, `body ${i} next_us`).toBeGreaterThanOrEqual(pre.seal.through_us)
    }
  }
  const last = all.at(-1) as Body
  expect(of(records(all), 'end')).toEqual([
    expect.objectContaining({ reason, finalSeq: last.pre.seal.seq }),
  ])
  expect(of(last.records, 'end')).toHaveLength(1)
}

describe('the session begins at the first WebTransport', () => {
  it('sends its first body at once, with the connection, and states the early seal', async () => {
    const p = await page()
    // A page load that waits before playing sends nothing while it waits.
    await p.vt.advanceTo(10 * MINUTE)
    expect(p.posts).toHaveLength(0)

    const at = p.vt.now
    const wt = connect()
    await p.vt.advanceTo(at)
    const [first] = await p.arrived((b) => b.length > 0)
    expect(first?.pre.seal).toMatchObject({
      seq: 0,
      through_us: at * 1000,
      next_us: (at + EARLY) * 1000,
    })
    expect(first?.batch.final).toBeFalsy()
    expect(first?.records.map((r) => r.t)).toEqual(['setup', 'ident', 'conn-open'])
    expect(of(first?.records ?? [], 'conn-open')[0]).toMatchObject({ at_us: at * 1000 })
    expect(of(first?.records ?? [], 'conn-open')[0]).not.toHaveProperty('ready_us')

    await p.vt.advanceTo(at + 2_000)
    await wt.open('moqt-20')
    await p.vt.advanceTo(at + 2_000)
    const opens = of(
      records(await p.arrived((b) => of(records(b), 'conn-open').length > 1)),
      'conn-open',
    )
    expect(opens.at(-1)).toMatchObject({ at_us: at * 1000, ready_us: (at + 2_000) * 1000 })
    await p.c.end()
    p.life.restore()
  }, 60_000)
})

describe('each connection ends once, with its cause, who ended it and when', () => {
  const ENDS: [string, (wt: MockWebTransport) => void, object, string[]][] = [
    [
      'the relay closes it',
      (wt) => wt.closeSession('bye', 7),
      { cause: 'closed', by: 'relay', code: 7, reason: 'bye' },
      [],
    ],
    [
      'the page closes it',
      (wt) => wt.close({ closeCode: 3, reason: 'done' }),
      { cause: 'closed', by: 'client', code: 3, reason: 'done' },
      [],
    ],
    [
      'it is reset or lost',
      (wt) => wt.errorSession(new Error('connection reset')),
      { cause: 'failed', by: 'local' },
      ['code', 'reason'],
    ],
    [
      'the page closes it and it errors',
      (wt) => {
        wt.failOnClose = new Error('aborted')
        wt.close()
      },
      { cause: 'failed', by: 'client' },
      ['code', 'reason'],
    ],
  ]

  for (const [name, end, expected, absent] of ENDS) {
    it(`when ${name}, sealed at once`, async () => {
      const p = await page()
      const wt = connect()
      await wt.open('moqt-20')
      await p.vt.advanceTo(5_000)
      end(wt)
      // A second end reported for the same transport changes nothing.
      wt.closeSession('again', 9)
      await p.vt.advanceTo(5_000)

      const all = await p.arrived((b) => of(records(b), 'conn-close').length > 0)
      const closes = of(records(all), 'conn-close')
      expect(closes).toEqual([expect.objectContaining({ ...expected, at_us: 5_000_000 })])
      for (const k of absent) expect(closes[0]).not.toHaveProperty(k)
      // Sealed by the close, not at the next scheduled seal.
      expect(bodyOf(all, closes[0] as EnvelopeRecord).pre.seal.through_us).toBe(5_000_000)
      expect(p.c.connections()[0]).toMatchObject({ state: 'closed' })
      await p.c.end()
      expectWhole(await p.bodies(), 'app')
      p.life.restore()
    }, 60_000)
  }

  it('when it never connects, with no ready time', async () => {
    const p = await page()
    const wt = connect()
    await p.vt.advanceTo(4_000)
    wt.failToOpen(new Error('handshake refused'))
    await p.vt.advanceTo(4_000)
    const all = await p.arrived((b) => of(records(b), 'conn-close').length > 0)
    expect(of(records(all), 'conn-close')).toEqual([
      expect.objectContaining({ cause: 'failed', by: 'local', at_us: 4_000_000 }),
    ])
    expect(of(records(all), 'conn-open').some((r) => r.ready_us !== undefined)).toBe(false)
    await p.c.end()
    p.life.restore()
  }, 60_000)

  it('when the page terminates the worker hosting it, at that time', async () => {
    const p = await page()
    let listener: ((e: { data?: unknown }) => void) | undefined
    let port: MessagePort | undefined
    const worker = {
      postMessage: (_m: unknown, transfer?: Transferable[]) => {
        port = transfer?.[0] as MessagePort | undefined
      },
      addEventListener: (_t: 'message', f: (e: { data?: unknown }) => void) => {
        listener = f
      },
      terminate: () => undefined,
    }
    p.c.linkWorker(worker)
    await p.vt.advanceTo(0)
    listener?.({ data: envelope({ t: 'hello', timeOrigin: 0 }) })
    port?.postMessage(envelope({ t: 'open' }))
    port?.postMessage(
      envelope({
        t: 'fwd',
        n: 0,
        dropped: 0,
        ready: true,
        conns: [
          {
            conn: {
              id: 'w-conn',
              realm: 'worker',
              origin: 'https://relay.test',
              draft: 20,
              state: 'open',
            },
            relay: 'https://relay.test/moq',
            rollup: null,
            counters: { parseFailures: 0, bucketsRefused: 0 },
          },
        ],
      }),
    )
    await p.vt.advanceTo(6_000)
    expect(p.c.connections()).toEqual([expect.objectContaining({ id: 'w-conn', state: 'open' })])
    worker.terminate()
    await p.vt.advanceTo(6_000)
    const closes = of(
      records(await p.arrived((b) => of(records(b), 'conn-close').length > 0)),
      'conn-close',
    )
    expect(closes).toEqual([
      expect.objectContaining({ conn: 'w-conn', cause: 'worker-gone', at_us: 6_000_000 }),
    ])
    expect(closes[0]).not.toHaveProperty('by')
    port?.close()
    await p.c.end()
    p.life.restore()
  }, 60_000)
})

describe('the page going away', () => {
  it('ends every connection with the page, and sends a final body that states no next seal', async () => {
    const p = await page()
    const open = connect('https://relay.test/a')
    await open.open('moqt-20')
    const closed = connect('https://relay.test/b')
    await closed.open('moqt-20')
    await p.vt.advanceTo(2_000)
    closed.closeSession('bye')
    await p.vt.advanceTo(3_000)
    // Still connecting when the page goes.
    connect('https://relay.test/c')
    await p.vt.advanceTo(EARLY + 30_000)
    p.c.annotate('in-the-tail')
    p.life.fire('pagehide', { persisted: false })

    const all = await p.bodies()
    expectWhole(all, 'unload')
    const ends = of(records(all), 'conn-close')
    expect(ends.map((e) => e.cause)).toEqual(['closed', 'page-end', 'page-end'])
    for (const e of ends.slice(1)) {
      expect(e).toMatchObject({ at_us: (EARLY + 30_000) * 1000 })
      expect(e).not.toHaveProperty('by')
      expect(e).not.toHaveProperty('code')
    }
    // Each connection ends once, and the final body carries the page's ends.
    expect(new Set(ends.map((e) => e.c)).size).toBe(3)
    const final = all.at(-1) as Body
    expect(final.records.map((r) => r.t)).toEqual(['conn-close', 'conn-close', 'end'])
    expect(final.pre.seal.through_us).toBe((EARLY + 30_000) * 1000)
    expect(of(records(all), 'note').map((n) => n.name)).toEqual(['in-the-tail'])

    // Nothing after the final body: no seal, no connection, no second end.
    const sent = p.posts.length + p.beaconed.length
    connect('https://relay.test/d')
    p.life.fire('pagehide', { persisted: false })
    await p.vt.advanceTo(p.vt.now + 10 * MINUTE)
    expect(p.posts.length + p.beaconed.length).toBe(sent)
    p.life.restore()
  }, 60_000)

  it('ends nothing when the page enters the back/forward cache, and carries on when it is restored', async () => {
    const p = await page()
    const wt = connect()
    await wt.open('moqt-20')
    await p.vt.advanceTo(10_000)
    p.c.annotate('before-freeze')
    p.life.fire('pagehide', { persisted: true })
    const frozen = await p.bodies()
    expect(frozen.length).toBeGreaterThan(0)
    for (const b of frozen) {
      expect(b.batch.final).toBeFalsy()
      expect(b.pre.seal.next_us).toBeGreaterThanOrEqual(b.pre.seal.through_us)
    }
    expect(of(records(frozen), 'conn-close')).toEqual([])
    expect(of(records(frozen), 'end')).toEqual([])
    expect(of(records(frozen), 'life').map((l) => l.ev)).toEqual(['frozen'])

    await p.vt.advanceTo(40_000)
    p.life.fire('pageshow', { persisted: true })
    expect(p.c.connections()).toEqual([expect.objectContaining({ state: 'open' })])
    await p.vt.advanceTo(40_000 + 3 * MINUTE)
    wt.closeSession('bye')
    await p.vt.advanceTo(p.vt.now)
    await p.c.end()

    const all = await p.bodies()
    expectWhole(all, 'app')
    expect(of(records(all), 'life').map((l) => [l.ev, l.gapMs])).toEqual([
      ['frozen', undefined],
      ['resumed', 30_000],
    ])
    expect(of(records(all), 'conn-close')).toEqual([expect.objectContaining({ cause: 'closed' })])
    p.life.restore()
  }, 60_000)

  it('sends again by fetch every body it only beaconed, once the page is restored', async () => {
    const p = await page()
    const wt = connect()
    await wt.open('moqt-20')
    await p.vt.advanceTo(10_000)
    p.c.annotate('before-freeze')
    p.life.fire('pagehide', { persisted: true })
    const beaconed = await p.beacons()
    expect(beaconed.length).toBeGreaterThan(0)

    p.life.fire('pageshow', { persisted: true })
    await p.vt.advanceTo(10_000 + 2 * MINUTE)
    const fetched = new Set(
      (await distinct(p.posts.map((x) => x.body))).map((b) => b.batch.idempotencyKey),
    )
    for (const b of beaconed) {
      expect(fetched.has(b.batch.idempotencyKey), `body ${b.pre.seal.seq} sent by fetch`).toBe(true)
    }
    wt.close()
    await p.c.end()
    p.life.restore()
  }, 60_000)

  it('ends the instance at end() with no close for a connection still open', async () => {
    const p = await page()
    const wt = connect()
    await wt.open('moqt-20')
    await p.vt.advanceTo(EARLY + 2 * MINUTE + 500)
    await p.c.end()
    const all = await p.bodies()
    expectWhole(all, 'app')
    expect(of(records(all), 'conn-close')).toEqual([])
    expect((all.at(-1) as Body).pre.seal.through_us).toBe((EARLY + 2 * MINUTE + 500) * 1000)
    // A transport that closes after the end is not recorded.
    wt.closeSession('late')
    await p.vt.advanceTo(p.vt.now + 5 * MINUTE)
    expect(of(records(await p.bodies()), 'conn-close')).toEqual([])
    p.life.restore()
  }, 60_000)
})

describe('nothing ends for being idle', () => {
  it('keeps an idle open connection and its session for hours, reporting each interval', async () => {
    const p = await page()
    const first = p.c.ids()
    const wt = connect()
    await wt.open('moqt-20')
    await p.vt.advanceTo(3 * HOUR)
    expect(p.c.connections()).toEqual([expect.objectContaining({ state: 'open' })])
    expect(p.c.ids()).toEqual(first)
    // The first body, the early seal, then one an interval.
    const expected = 2 + Math.floor((3 * HOUR - EARLY) / MINUTE)
    const all = await p.arrived((b) => b.length >= expected)
    expect(of(records(all), 'conn-close')).toEqual([])
    expect(of(records(all), 'end')).toEqual([])
    expect(all).toHaveLength(expected)
    for (const b of all) expect(b.batch.final).toBeFalsy()
    wt.closeSession('bye')
    await p.vt.advanceTo(p.vt.now)
    await p.c.end()
    expectWhole(await p.bodies(), 'app')
    p.life.restore()
  }, 120_000)

  it('keeps the session through hours with no connection, and the next one joins it', async () => {
    const p = await page()
    const first = p.c.ids()
    const wt = connect()
    await wt.open('moqt-20')
    await p.vt.advanceTo(1_000)
    wt.closeSession('bye')
    await p.arrived((b) => of(records(b), 'conn-close').length > 0)
    const quiet = p.posts.length
    await p.vt.advanceTo(3 * HOUR)
    expect(p.posts).toHaveLength(quiet)
    expect(p.c.ids()).toEqual(first)

    const again = connect()
    await again.open('moqt-20')
    await p.vt.advanceTo(3 * HOUR + MINUTE)
    // The new connection is reported within one interval of its open.
    const sofar = await p.arrived((b) => of(records(b), 'conn-open').some((r) => r.c === 1))
    const reported = of(records(sofar), 'conn-open').find((r) => r.c === 1)
    expect(reported).toBeDefined()
    expect(bodyOf(sofar, reported as EnvelopeRecord).pre.seal.through_us).toBeLessThanOrEqual(
      (3 * HOUR + MINUTE) * 1000,
    )
    again.closeSession('bye again')
    await p.vt.advanceTo(p.vt.now)
    await p.c.end()
    const all = await p.bodies()
    expectWhole(all, 'app')
    expect(of(records(all), 'setup')).toHaveLength(1)
    expect(of(records(all), 'conn-close').map((x) => x.c)).toEqual([0, 1])
    p.life.restore()
  }, 120_000)
})
