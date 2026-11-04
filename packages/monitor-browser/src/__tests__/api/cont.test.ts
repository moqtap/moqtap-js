/**
 * A body's `cont`: whether it continues the emitter's previous body, with
 * nothing between them that showed capture stopped: a scheduled seal that
 * found nothing to send, a frozen page, a clock break, a connection's close,
 * or detail back at baseline. Ingest joins the two bodies' records only then,
 * so a silence is never counted as recorded time and the time between two
 * bodies of an unbroken stream always is.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetDormantForTest, teardownDormant } from '../../api/dormant.js'
import { FORWARD_INTERVAL_MS } from '../../api/link.js'
import { initWorkerWith } from '../../api/worker.js'
import type { BatchRecord, CollectorConfig, EnvelopeRecord } from '../../types.js'
import { attempt, init, workerBuild } from '../support/init.js'
import { settle, until } from '../support/settle.js'
import { type Post, recordingFetch, recordsOf } from '../support/uploads.js'
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

const INTERVAL_MS = 60_000

const base = (): CollectorConfig => ({
  apiKey: 'pk_test',
  endpoint: 'https://ingest.test/v1/ingest',
  sessionId: 'sess-cont',
  upload: { intervalMs: INTERVAL_MS, earlyFlushesMs: [] },
})

/** The page's timers, the seal interval's held until the test runs it. */
function timers() {
  const held: { fn: () => void; live: boolean }[] = []
  return {
    /** Run the seal interval's pending timer, as if it fired. */
    interval() {
      const t = [...held].reverse().find((h) => h.live)
      if (t === undefined) throw new Error('no interval timer pending')
      t.live = false
      t.fn()
    },
    ports: {
      setTimer: (fn: () => void, ms: number): unknown => {
        if (ms !== INTERVAL_MS) return setTimeout(fn, ms)
        const h = { fn, live: true }
        held.push(h)
        return h
      },
      clearTimer: (h: unknown) => {
        if (typeof h === 'object' && h !== null && 'live' in h)
          (h as { live: boolean }).live = false
        else clearTimeout(h as never)
      },
    },
  }
}

const quiet = { persist: false, noLifecycleListeners: true, locks: null } as const

describe("a body's cont", () => {
  it('is set on a body after one with no empty scheduled seal between, and not after one', async () => {
    const { posts, impl } = recordingFetch()
    const t = timers()
    const c = init(base(), { ...quiet, fetchImpl: impl, ...t.ports })
    await settle()
    attempt()
    await settle()
    c.annotate('a')
    await c.flush()
    c.annotate('b')
    let n = posts.length
    t.interval()
    await until(() => posts.length === n + 1)
    // The interval runs again with nothing buffered: a silence.
    n = posts.length
    t.interval()
    await settle()
    expect(posts).toHaveLength(n)
    c.annotate('c')
    t.interval()
    await until(() => posts.length === n + 1)
    c.annotate('d')
    await c.flush()
    await c.end()

    // Each note's body, by the note it carries.
    const bodies = new Map<string, BatchRecord>()
    for (const p of posts) {
      const records = await recordsOf(p.body)
      for (const r of records) if (r.t === 'note') bodies.set(r.name, records[0] as BatchRecord)
    }
    expect(['b', 'c', 'd'].map((name) => bodies.get(name)?.cont)).toEqual([true, undefined, true])
  })

  it('starts a new body at a close the page learns of on waking, with no seal in between', async () => {
    const { posts, impl } = recordingFetch()
    const t = timers()
    const c = init(base(), { ...quiet, fetchImpl: impl, ...t.ports })
    await settle()
    const wt = attempt()
    await wt.open('moqt-20')
    await settle()
    c.annotate('a')
    await c.flush()
    c.annotate('b')
    // Asleep: no interval timer runs, and the relay drops the connection.
    wt.closeSession('gone')
    await settle()
    c.annotate('c')
    await c.flush()
    await c.end()

    const bodies = await bodiesOf(posts)
    expect(bodies.cont('b')).toBe(true)
    expect(bodies.contOf((r) => r.t === 'conn-close')).toBeUndefined()
    expect(bodies.cont('c')).toBeUndefined()
  })

  it("starts a new body at a worker connection's close, and after it with none left open", async () => {
    const { posts, impl } = recordingFetch()
    const t = timers()
    const channel = new MessageChannel()
    const c = init(base(), { ...quiet, fetchImpl: impl, ...t.ports })
    c.linkWorker(channel.port1)
    await settle(5)
    const probe = initWorkerWith(workerBuild, channel.port2, {})
    expect(await probe.linked).toBe(true)
    const wt = new (g.WebTransport as new (u: string) => MockWebTransport)('https://relay.test/w')
    await wt.open('moqt-20')
    await settle(40, FORWARD_INTERVAL_MS)
    c.annotate('a')
    await c.flush()
    c.annotate('b')
    wt.closeSession('gone')
    await settle(40, FORWARD_INTERVAL_MS)
    c.annotate('c')
    await c.flush()
    await c.end()
    channel.port1.close()
    channel.port2.close()

    const bodies = await bodiesOf(posts)
    expect(bodies.cont('b')).toBe(true)
    expect(bodies.contOf((r) => r.t === 'conn-close')).toBeUndefined()
    expect(bodies.cont('c')).toBeUndefined()
  })

  it('starts a new body after a clock break the overdue seal finds on waking', async () => {
    const { posts, impl } = recordingFetch()
    const t = timers()
    let skew = 0
    const clock = { now: () => performance.now(), wall: () => Date.now() + skew }
    const c = init(base(), { ...quiet, fetchImpl: impl, clock, ...t.ports })
    await settle()
    attempt()
    await settle()
    c.annotate('a')
    await c.flush()
    c.annotate('b')
    // Asleep: the monotonic clock stood still while wall time went on.
    skew = 3_600_000
    const n = posts.length
    t.interval()
    await until(() => posts.length > n)
    c.annotate('c')
    await c.flush()
    await c.end()

    const bodies = await bodiesOf(posts)
    expect(bodies.cont('b')).toBe(true)
    expect(bodies.batch('b')?.clk.epoch).toBe(0)
    expect(bodies.cont('c')).toBeUndefined()
    expect(bodies.batch('c')?.clk.epoch).toBe(1)
  })

  it('starts a new body after the page froze', async () => {
    const { posts, impl } = recordingFetch()
    const t = timers()
    const life = captureFreeze()
    try {
      const c = init(base(), { ...quiet, noLifecycleListeners: false, fetchImpl: impl, ...t.ports })
      await settle()
      attempt()
      await settle()
      c.annotate('a')
      await c.flush()
      c.annotate('b')
      life.fire()
      await settle()
      c.annotate('c')
      await c.flush()
      await c.end()
    } finally {
      life.restore()
    }

    const bodies = await bodiesOf(posts)
    expect(bodies.cont('b')).toBe(true)
    expect(bodies.cont('c')).toBeUndefined()
  })

  it('starts a new body when detail went back to baseline with nothing sealed at it', async () => {
    const { posts, impl } = recordingFetch()
    const t = timers()
    const c = init(base(), { ...quiet, fetchImpl: impl, ...t.ports })
    await settle()
    attempt()
    await settle()
    c.escalate('headers')
    c.annotate('a')
    await c.flush()
    c.resolve()
    c.escalate('headers')
    c.annotate('b')
    await c.flush()
    await c.end()

    const bodies = await bodiesOf(posts)
    expect(bodies.batch('b')?.lvl).toBe('headers')
    expect(bodies.cont('b')).toBeUndefined()
  })
})

/** Each body's batch record, found by a record it carries. */
async function bodiesOf(posts: readonly Post[]) {
  const all: { batch: BatchRecord; records: EnvelopeRecord[] }[] = []
  for (const p of posts) {
    const records = await recordsOf(p.body)
    all.push({ batch: records[0] as BatchRecord, records })
  }
  const find = (has: (r: EnvelopeRecord) => boolean) => {
    const hits = all.filter((b) => b.records.some(has))
    expect(hits).toHaveLength(1)
    return hits[0]?.batch
  }
  const note = (name: string) => (r: EnvelopeRecord) => r.t === 'note' && r.name === name
  return {
    batch: (name: string) => find(note(name)),
    cont: (name: string) => find(note(name))?.cont,
    contOf: (has: (r: EnvelopeRecord) => boolean) => find(has)?.cont,
  }
}

/** The page's `freeze` listener, fired by the test; every other listener reaches the real global. */
function captureFreeze(): { fire: () => void; restore: () => void } {
  const gg = globalThis as unknown as Record<string, unknown>
  const prev = gg.addEventListener as
    | ((t: string, f: (e?: unknown) => void, ...rest: unknown[]) => void)
    | undefined
  let freeze: ((e?: unknown) => void) | undefined
  gg.addEventListener = (t: string, f: (e?: unknown) => void, ...rest: unknown[]): void => {
    if (t === 'freeze') freeze = f
    else if (t !== 'pagehide' && t !== 'pageshow' && t !== 'visibilitychange')
      prev?.call(globalThis, t, f, ...rest)
  }
  return {
    fire: () => {
      expect(freeze).toBeDefined()
      freeze?.({})
    },
    restore: () => {
      gg.addEventListener = prev
    },
  }
}
