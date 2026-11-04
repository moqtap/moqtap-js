/**
 * A body's `cont`: whether it continues the emitter's previous body, with no
 * scheduled seal between them that found nothing to send. Ingest joins the
 * two bodies' records only then, so a silence is never counted as recorded
 * time and the time between two bodies of an unbroken stream always is.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetDormantForTest, teardownDormant } from '../../api/dormant.js'
import type { BatchRecord, CollectorConfig } from '../../types.js'
import { attempt, init } from '../support/init.js'
import { settle, until } from '../support/settle.js'
import { recordingFetch, recordsOf } from '../support/uploads.js'
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
})
