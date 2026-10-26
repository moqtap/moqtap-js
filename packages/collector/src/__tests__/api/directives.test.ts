/**
 * What ingest asks of the page on an upload's answer, and how far the page
 * goes: a shorter seal interval while someone watches the session, raised
 * detail while a capture window covers it, and detail held at baseline once the
 * workspace's recording minutes are used up, each within its bounds, each only
 * for the instance the answered body came from.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetDormantForTest, teardownDormant } from '../../api/dormant.js'
import {
  DIRECTIVE_ELEVATE_MAX_SPAN_MS,
  DIRECTIVE_FLUSH_MAX_SPAN_MS,
  DIRECTIVE_FLUSH_MIN_MS,
  DIRECTIVE_HEADER,
  DIRECTIVE_HOLD_MAX_SPAN_MS,
  RECV_HEADER,
  SEND_HEADER,
} from '../../flush/index.js'
import type { CollectorConfig, Directive } from '../../types.js'
import { subgroupBytes } from '../decode/vectors.js'
import { attempt, init } from '../support/init.js'
import { settle, until } from '../support/settle.js'
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

const base = (over: Partial<CollectorConfig> = {}): CollectorConfig => ({
  apiKey: 'pk_test',
  endpoint: 'https://ingest.test/v1/ingest',
  sessionId: 'sess-fixed',
  ...over,
})

const quiet = { persist: false, noLifecycleListeners: true, locks: null } as const

/** The server's wall clock in every answer. Far from the device's, which the page must not read it against. */
const SERVER_NOW = 5_000_000_000_000

/** Answer every upload with `directive`, stamped with the server's clock. */
function answering(directive: (url: string) => Directive | null) {
  const f = recordingFetch((n) => {
    const d = directive(f.posts[n]?.url ?? '')
    return {
      [RECV_HEADER]: String(SERVER_NOW),
      [SEND_HEADER]: String(SERVER_NOW),
      ...(d !== null ? { [DIRECTIVE_HEADER]: JSON.stringify(d) } : {}),
    }
  })
  return f
}

/**
 * The page's timers, with every delay it asked for recorded. `fast` maps a
 * delay to the one actually waited, so a test can let one beat run.
 */
function timers(fast: (ms: number) => number = (ms) => ms) {
  const asked: number[] = []
  return {
    asked,
    ports: {
      setTimer: (fn: () => void, ms: number) => {
        asked.push(ms)
        return setTimeout(fn, fast(ms))
      },
      clearTimer: (h: unknown) => clearTimeout(h as never),
    },
  }
}

/** A delay asked against the page's own clock, read a moment after the deadline was set. */
const near = (ms: number, want: number): boolean => ms > want - 1_000 && ms <= want

describe('flushMs: someone is watching the session', () => {
  it('seals and uploads on the asked interval, with no flush() call', async () => {
    const { posts, impl } = answering(() => ({ flushMs: 2_000, until: SERVER_NOW + 5_000 }))
    const t = timers((ms) => (ms === 2_000 ? 10 : ms))
    const c = init(base(), { ...quiet, fetchImpl: impl, ...t.ports })
    await settle()
    attempt()
    c.annotate('first')
    await c.flush()
    expect(posts).toHaveLength(1)
    // The interval asked for, and its end read against the server's own clock.
    expect(t.asked).toContain(2_000)
    expect(t.asked).toContain(5_000)

    c.annotate('second')
    await until(() => posts.length === 2)
    expect(of(await allRecords(posts), 'note').map((n) => n.name)).toEqual(['first', 'second'])
    await c.end()
  })

  it('stays within bounds: no faster than a second, for no longer than ten minutes', async () => {
    const { impl } = answering(() => ({ flushMs: 50, until: SERVER_NOW + 3_600_000 }))
    const t = timers()
    const c = init(base(), { ...quiet, fetchImpl: impl, ...t.ports })
    await settle()
    attempt()
    c.annotate('x')
    await c.flush()
    expect(t.asked).toContain(DIRECTIVE_FLUSH_MIN_MS)
    expect(t.asked).toContain(DIRECTIVE_FLUSH_MAX_SPAN_MS)
    expect(t.asked).not.toContain(50)
    expect(t.asked).not.toContain(3_600_000)
    await c.end()
  })

  it('does nothing with an end already past', async () => {
    const { impl } = answering(() => ({ flushMs: 2_000, until: SERVER_NOW - 1 }))
    const t = timers()
    const c = init(base(), { ...quiet, fetchImpl: impl, ...t.ports })
    await settle()
    attempt()
    c.annotate('x')
    await c.flush()
    expect(t.asked).not.toContain(2_000)
    await c.end()
  })
})

describe('elevate: a capture window covers the session', () => {
  it('raises detail as escalate() would, billed as remote, until the end asked for', async () => {
    const { posts, impl } = answering(() => ({
      elevate: { level: 'headers', until: SERVER_NOW + 60_000, reason: 'release 4.2 regressed' },
    }))
    const t = timers()
    const c = init(base(), { ...quiet, fetchImpl: impl, ...t.ports })
    await settle()
    const wt = new (g.WebTransport as new (u: string) => MockWebTransport)('https://relay.test/moq')
    await wt.open('moqt-20')
    await settle(5)
    await c.flush()
    // The window closes on its own timer, on time.
    expect(t.asked.some((ms) => near(ms, 60_000))).toBe(true)

    const uni = wt.incomingUnidirectionalStreams.getReader()
    const src = wt.deliverUniStream([
      subgroupBytes({ alias: 4n, group: 1n, objects: [{ id: 0n, bytes: 10 }] }),
    ])
    src.close()
    const reader = ((await uni.read()).value as ReadableStream<Uint8Array>).getReader()
    for (;;) if ((await reader.read()).done) break
    await settle(2)
    await c.end()

    const all = await allRecords(posts)
    expect(of(all, 'escalation')[0]).toMatchObject({
      from: 'baseline',
      to: 'headers',
      lvl: 'headers',
      by: { kind: 'remote', reason: 'release 4.2 regressed' },
    })
    expect(of(all, 'hdr')).toEqual([expect.objectContaining({ lvl: 'headers', group: '1' })])
  })

  it('raises no higher than headers+sizes, and for no longer than thirty minutes', async () => {
    const { posts, impl } = answering(() => ({
      elevate: { level: 'headers+data', until: SERVER_NOW + 24 * 3_600_000, reason: '' },
    }))
    const t = timers()
    const c = init(base(), { ...quiet, fetchImpl: impl, ...t.ports })
    await settle()
    attempt()
    c.annotate('x')
    await c.flush()
    expect(t.asked.some((ms) => near(ms, DIRECTIVE_ELEVATE_MAX_SPAN_MS))).toBe(true)
    await c.end()
    const [raise] = of(await allRecords(posts), 'escalation')
    expect(raise).toMatchObject({ to: 'headers+sizes', by: { kind: 'remote' } })
    expect(raise?.by).not.toHaveProperty('reason')
  })

  it('is not obeyed for a body of an earlier instance', async () => {
    let failing = true
    let firstInstance = ''
    const { posts, impl: ok } = answering((url) =>
      firstInstance !== '' && url.includes(`i=${firstInstance}`)
        ? { elevate: { level: 'headers', until: SERVER_NOW + 60_000, reason: 'old' } }
        : null,
    )
    const impl = ((url: string, i: RequestInit) => {
      if (failing) return Promise.reject(new TypeError('offline'))
      return ok(url, i)
    }) as unknown as typeof fetch
    const c = init(base({ upload: { maxAttempts: 1 } }), { ...quiet, fetchImpl: impl })
    firstInstance = c.ids().instanceId
    await settle()
    attempt()
    c.annotate('kept for later')
    await c.flush()
    failing = false
    c.newSession()
    // The second session sends the first one's body, and hears its answer.
    await until(() => posts.some((p) => p.url.includes(`i=${firstInstance}`)))
    await settle()
    c.annotate('second session')
    await c.end()
    expect(of(await allRecords(posts), 'escalation')).toEqual([])
  })
})

describe('hold: the recording minutes for the month are used up', () => {
  const HOLD = { hold: { until: SERVER_NOW + 3_600_000 } }

  it('refuses escalate() and a capture window in the same answer', async () => {
    const { posts, impl } = answering(() => ({
      ...HOLD,
      elevate: { level: 'headers', until: SERVER_NOW + 60_000, reason: 'capture' },
    }))
    const c = init(base(), { ...quiet, fetchImpl: impl })
    await settle()
    attempt()
    c.annotate('x')
    await c.flush()
    c.escalate('headers', 'mine')
    await c.end()
    expect(of(await allRecords(posts), 'escalation')).toEqual([])
  })

  it('ends a window already open at the next interval', async () => {
    const { posts, impl } = answering(() => HOLD)
    const t = timers((ms) => (ms === 1_234 ? 10 : ms))
    const c = init(base({ metrics: { intervalMs: 1_234 } }), {
      ...quiet,
      fetchImpl: impl,
      ...t.ports,
    })
    await settle()
    attempt()
    c.escalate('headers', 'mine')
    await c.flush()
    // One beat after the answer that carried the hold.
    const beats = t.asked.filter((ms) => ms === 1_234).length
    await until(() => t.asked.filter((ms) => ms === 1_234).length > beats)
    await c.end()
    const all = of(await allRecords(posts), 'escalation')
    expect(all.map((r) => [r.to, r.by.kind])).toEqual([
      ['headers', 'manual'],
      ['baseline', 'hold'],
    ])
  })

  it('lapses within its bound once ingest stops sending it', async () => {
    // A plan raised mid-month: the first answer holds, the rest do not.
    const { posts, impl } = answering(() => (posts.length <= 1 ? HOLD : null))
    let t = 1_000
    const c = init(base(), { ...quiet, fetchImpl: impl, clock: { now: () => t, wall: () => t } })
    await settle()
    attempt()
    c.annotate('x')
    await c.flush()
    c.escalate('headers', 'held')
    t += DIRECTIVE_HOLD_MAX_SPAN_MS
    c.escalate('headers', 'lapsed')
    await c.end()
    expect(of(await allRecords(posts), 'escalation').map((r) => r.by)).toEqual([
      { kind: 'manual', reason: 'lapsed' },
      { kind: 'window', closed: 'unload' },
    ])
  })

  it('is ignored with an end already past', async () => {
    const { posts, impl } = answering(() => ({ hold: { until: SERVER_NOW - 1 } }))
    const c = init(base(), { ...quiet, fetchImpl: impl })
    await settle()
    attempt()
    c.annotate('x')
    await c.flush()
    c.escalate('headers')
    await c.end()
    expect(of(await allRecords(posts), 'escalation')[0]).toMatchObject({ to: 'headers' })
  })
})
