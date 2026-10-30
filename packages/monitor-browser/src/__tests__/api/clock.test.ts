/**
 * The batch record's `clock` from a running page: none before ingest has
 * answered a `fetch()`, then the device's clock against ingest's on every
 * body, kept across the page's sessions.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetDormantForTest, teardownDormant } from '../../api/dormant.js'
import { RECV_HEADER, SEND_HEADER } from '../../flush/index.js'
import type { BatchRecord, CollectorConfig } from '../../types.js'
import { attempt, init } from '../support/init.js'
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
  sessionId: 'sess-fixed',
  ...over,
})

const quiet = { persist: false, noLifecycleListeners: true, locks: null } as const

/** Ingest's clock, 5 s ahead of the device's. */
const AHEAD_MS = 5_000

const answering = () =>
  recordingFetch(() => {
    const now = String(Date.now() + AHEAD_MS)
    return { [RECV_HEADER]: now, [SEND_HEADER]: now }
  })

const batchOf = async (p: Post): Promise<BatchRecord> => of(await recordsOf(p.body), 'batch')[0]!

describe('the clock on each body', () => {
  it('is absent before an answer, then carries the offset', async () => {
    const { posts, impl } = answering()
    const c = init(base(), { ...quiet, fetchImpl: impl })
    await settle()
    attempt()
    c.annotate('first')
    await c.flush()
    c.annotate('second')
    await c.flush()
    await c.end()

    expect(posts.length).toBeGreaterThanOrEqual(2)
    expect(await batchOf(posts[0]!)).not.toHaveProperty('clock')
    const clock = (await batchOf(posts[1]!)).clock!
    expect(clock.n).toBe(1)
    expect(clock.r).toBeGreaterThanOrEqual(0)
    expect(clock.a).toBeGreaterThanOrEqual(0)
    // Ingest stamped both times between `t1` and `t4`, so the offset is
    // within half the round trip of the true one.
    expect(Math.abs(clock.o - AHEAD_MS)).toBeLessThanOrEqual(clock.r / 2 + 0.001)
  })

  it('keeps the exchanges across newSession()', async () => {
    const { posts, impl } = answering()
    const c = init(base(), { ...quiet, fetchImpl: impl })
    await settle()
    attempt()
    c.annotate('first')
    await c.flush()
    const second = c.newSession({ sessionId: 'sess-second' })
    await settle()
    c.annotate('second')
    await c.flush()
    await c.end()

    const batches = await Promise.all(posts.map(batchOf))
    const next = batches.find((b) => b.sessionId === second.sessionId)
    expect(next?.clock?.n).toBeGreaterThanOrEqual(1)
  })
})
