/**
 * The back/forward cache, at the public surface.
 *
 * A real browser restores a page only when its cache takes it, so here the
 * lifecycle events are fired by hand: a page goes in with one body ingest has
 * not confirmed and one record buffered, comes back, and goes on.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetDormantForTest, teardownDormant } from '../../api/dormant.js'
import type { BatchRecord, CollectorConfig, EnvelopeRecord } from '../../types.js'
import { attempt, init } from '../support/init.js'
import { until } from '../support/settle.js'
import { clockProbe, preambleOf, recordsOf } from '../support/uploads.js'
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

/** Intercepts the page lifecycle events; every listener of a type is kept. */
function captureLifecycle(): { fire: (type: string, e?: unknown) => void; restore: () => void } {
  const gg = globalThis as unknown as Record<string, unknown>
  const prev = gg.addEventListener as
    | ((t: string, f: (e?: unknown) => void, ...rest: unknown[]) => void)
    | undefined
  const handlers = new Map<string, ((e?: unknown) => void)[]>()
  const captured = new Set(['pagehide', 'pageshow', 'visibilitychange', 'freeze', 'online'])
  gg.addEventListener = (t: string, f: (e?: unknown) => void, ...rest: unknown[]): void => {
    if (captured.has(t)) {
      handlers.set(t, [...(handlers.get(t) ?? []), f])
      return
    }
    prev?.call(globalThis, t, f, ...rest)
  }
  return {
    fire: (type, e) => {
      for (const h of handlers.get(type) ?? []) h(e ?? {})
    },
    restore: () => {
      gg.addEventListener = prev
    },
  }
}

interface Sent {
  readonly by: 'fetch' | 'beacon'
  readonly body: Uint8Array
}

async function decoded(s: Sent): Promise<{ batch: BatchRecord; records: EnvelopeRecord[] }> {
  const records = await recordsOf(s.body)
  return { batch: records[0] as BatchRecord, records }
}

const noted = (records: EnvelopeRecord[], name: string): boolean =>
  records.some((r) => r.t === 'note' && (r as { name?: string }).name === name)

describe('the back/forward cache', () => {
  it('beacons what it holds, sends it again by fetch once restored, and keeps one unbroken chain', async () => {
    const life = captureLifecycle()
    try {
      const sent: Sent[] = []
      let down = false
      const fetchImpl = (async (url: string, init: RequestInit) => {
        const clock = clockProbe(url)
        if (clock !== undefined) return clock
        const body =
          init.body instanceof Blob
            ? new Uint8Array(await init.body.arrayBuffer())
            : new Uint8Array(init.body as unknown as ArrayBufferLike as never)
        sent.push({ by: 'fetch', body })
        const status = down ? 503 : 200
        return { ok: !down, status, headers: { get: () => null } } as unknown as Response
      }) as unknown as typeof fetch
      const c = init(base(), {
        persist: false,
        locks: null,
        fetchImpl,
        beacon: (_url, blob) => {
          void blob.arrayBuffer().then((b) => sent.push({ by: 'beacon', body: new Uint8Array(b) }))
          return true
        },
      })
      attempt()
      await c.flush()

      // One body ingest has not taken, and one record still buffered.
      down = true
      c.annotate('unconfirmed', null)
      await c.flush()
      c.annotate('buffered', null)
      life.fire('pagehide', { persisted: true })
      const beaconed = () => Promise.all(sent.filter((s) => s.by === 'beacon').map(decoded))
      await until(async () => (await beaconed()).some((d) => noted(d.records, 'buffered')), 5000)

      const atFreeze = await beaconed()
      expect(atFreeze.some((d) => noted(d.records, 'unconfirmed'))).toBe(true)
      expect(atFreeze.some((d) => noted(d.records, 'buffered'))).toBe(true)
      expect(atFreeze.flatMap((d) => d.records).some((r) => r.t === 'end')).toBe(false)

      down = false
      const before = sent.length
      life.fire('pageshow', { persisted: true })
      c.annotate('after', null)
      await c.flush()
      // Each body the beacon took at the freeze went again by fetch, under its own key.
      const fetched = () =>
        Promise.all(
          sent
            .slice(before)
            .filter((s) => s.by === 'fetch')
            .map(decoded),
        )
      const again = (r: Awaited<ReturnType<typeof fetched>>) =>
        atFreeze.every((d) => r.some((x) => x.batch.idempotencyKey === d.batch.idempotencyKey))
      await until(async () => again(await fetched()), 5000).catch(() => {})
      const resent = await fetched()
      for (const d of atFreeze) {
        expect(
          resent.some((r) => r.batch.idempotencyKey === d.batch.idempotencyKey),
          `seq ${d.batch.seq} sent by fetch after the restore`,
        ).toBe(true)
      }

      await c.end()
      const all = await Promise.all(sent.map(decoded))
      const bySeq = new Map<number, { batch: BatchRecord; body: Uint8Array }>()
      for (const [i, d] of all.entries()) {
        const first = bySeq.get(d.batch.seq)
        if (first !== undefined) {
          expect(d.batch.idempotencyKey).toBe(first.batch.idempotencyKey)
          continue
        }
        bySeq.set(d.batch.seq, { batch: d.batch, body: (sent[i] as Sent).body })
      }
      const seqs = [...bySeq.keys()].sort((a, b) => a - b)
      expect(seqs).toEqual(seqs.map((_, i) => i))
      for (let s = 1; s < seqs.length; s++) {
        const prev = preambleOf((bySeq.get(s - 1) as { body: Uint8Array }).body).seal
        const cur = preambleOf((bySeq.get(s) as { body: Uint8Array }).body).seal
        expect(cur.from_us).toBe(prev.through_us)
      }
      const records = all.flatMap((d) => d.records)
      const lifeEvents = records.filter((r) => r.t === 'life').map((r) => (r as { ev: string }).ev)
      expect(lifeEvents).toEqual(expect.arrayContaining(['frozen', 'resumed']))
      const ends = records.filter((r) => r.t === 'end')
      expect(ends.length).toBeGreaterThanOrEqual(1)
      expect(ends.every((e) => (e as { reason?: string }).reason !== 'unload')).toBe(true)
      expect(noted(records, 'after')).toBe(true)
    } finally {
      life.restore()
    }
  })
})
