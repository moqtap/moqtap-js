/**
 * Every body is sealed at one detail level over its whole sealed interval:
 * a change of level seals what came before at the old level, so the
 * interval from the change on is the next body's.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetDormantForTest, teardownDormant } from '../../api/dormant.js'
import type { BatchRecord, CollectorConfig, EnvelopeRecord } from '../../types.js'
import { subgroupBytes } from '../decode/vectors.js'
import { attempt, init } from '../support/init.js'
import { factsOf } from '../support/runs.js'
import { settle } from '../support/settle.js'
import { type Post, preambleOf, recordingFetch, recordsOf } from '../support/uploads.js'
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

const base = (): CollectorConfig => ({
  apiKey: 'pk_test',
  endpoint: 'https://ingest.test/v1/ingest',
  upload: { intervalMs: 60_000, earlyFlushesMs: [] },
})

const quiet = { persist: false, noLifecycleListeners: true, locks: null } as const

describe('a change of detail', () => {
  it('seals what came before at the old level, and the next body starts at the change', async () => {
    const { posts, impl } = recordingFetch()
    const c = init(base(), { ...quiet, fetchImpl: impl })
    await settle()
    attempt()
    await settle()
    c.annotate('a')
    c.escalate('headers')
    c.annotate('b')
    c.resolve()
    c.annotate('c')
    await c.flush()
    await c.end()

    const bodies = await bodiesOf(posts)
    const [a, b, cc] = ['a', 'b', 'c'].map((name) => bodies.of(name))
    expect([a?.batch.lvl, b?.batch.lvl, cc?.batch.lvl]).toEqual(['baseline', 'headers', 'baseline'])
    expect(b?.seal.seq).toBe((a?.seal.seq ?? 0) + 1)
    expect(b?.seal.from_us).toBe(a?.seal.through_us)
    expect(cc?.seal.from_us).toBe(b?.seal.through_us)
  })

  it('seals the raised records at their level when the session ends', async () => {
    const { posts, impl } = recordingFetch()
    const c = init(base(), { ...quiet, fetchImpl: impl })
    await settle()
    attempt()
    await settle()
    c.escalate('headers')
    c.annotate('a')
    await c.end()

    const bodies = await bodiesOf(posts)
    expect(bodies.of('a')?.batch.lvl).toBe('headers')
  })

  it('seals a raise in bodies of the usual size, not beacon-sized pieces', async () => {
    const { posts, impl } = recordingFetch()
    const c = init(
      { ...base(), upload: { ...base().upload, beaconMaxBytes: 1024 } },
      { ...quiet, fetchImpl: impl },
    )
    await settle()
    attempt()
    await settle()
    for (let i = 0; i < 100; i++) c.annotate(`before-${i}`, { pad: 'x'.repeat(40) })
    c.escalate('headers')
    await c.end()

    const bodies = await bodiesOf(posts)
    expect(bodies.with('before-0')).toBe(bodies.with('before-99'))
  })
})

describe('the page going away at raised detail', () => {
  /** A raised session with a run still open in the packer when `pagehide` fires. */
  async function goneRaised(persisted: boolean) {
    const life = captureLifecycle()
    try {
      const { posts, impl } = recordingFetch()
      const beaconed: Uint8Array[] = []
      const blobs: Blob[] = []
      const c = init(base(), {
        persist: false,
        locks: null,
        fetchImpl: impl,
        beacon: (_url, blob) => {
          blobs.push(blob)
          return true
        },
      })
      await settle()
      const wt = new (g.WebTransport as new (u: string) => MockWebTransport)(
        'https://relay.test/moq',
      )
      await wt.open('moqt-20')
      await settle(5)
      await c.flush()
      c.escalate('headers')
      await deliver(wt, 1n, 3)
      life.fire('pagehide', { persisted })
      for (const b of blobs) beaconed.push(new Uint8Array(await b.arrayBuffer()))
      if (persisted) {
        life.fire('pageshow', { persisted: true })
        c.annotate('after')
        await c.end()
      } else await c.discard()
      return { beaconed, posts }
    } finally {
      life.restore()
    }
  }

  /** Each distinct body by seq, a body sent twice counted once. */
  async function decode(bodies: readonly Uint8Array[]) {
    const decoded: {
      batch: BatchRecord
      seal: ReturnType<typeof preambleOf>['seal']
      runs: number
    }[] = []
    for (const body of bodies) {
      const records = await recordsOf(body)
      if (records[0]?.t !== 'batch') continue
      if (decoded.some((b) => b.seal.seq === preambleOf(body).seal.seq)) continue
      decoded.push({
        batch: records[0] as BatchRecord,
        seal: preambleOf(body).seal,
        runs: (await factsOf(body)).runs.length,
      })
    }
    return decoded.sort((a, b) => a.seal.seq - b.seal.seq)
  }

  it('beacons the open run at its raised level on unload, then only the end body', async () => {
    const { beaconed } = await goneRaised(false)
    const bodies = await decode(beaconed)
    const run = bodies.find((b) => b.runs > 0)
    expect(run?.batch.lvl).toBe('headers')
    const after = bodies.filter((b) => b.seal.seq > (run?.seal.seq ?? 0))
    expect(after.map((b) => b.batch.final)).toEqual([true])
    expect(after[0]?.seal.from_us).toBe(run?.seal.through_us)
  })

  it('beacons the open run at its raised level entering the back/forward cache, and no more', async () => {
    const { beaconed, posts } = await goneRaised(true)
    const sealed = await decode(beaconed)
    const run = sealed.find((b) => b.runs > 0)
    expect(run?.batch.lvl).toBe('headers')
    expect(sealed.filter((b) => b.seal.seq > (run?.seal.seq ?? 0))).toEqual([])
    const next = (await decode(posts.map((p) => p.body))).find(
      (b) => b.seal.seq === (run?.seal.seq ?? 0) + 1,
    )
    expect(next?.batch.lvl).toBe('baseline')
    expect(next?.seal.from_us).toBe(run?.seal.through_us)
  })
})

/** A subgroup stream of `n` objects in `group`, read to its end. */
async function deliver(wt: MockWebTransport, group: bigint, n: number): Promise<void> {
  const uni = wt.incomingUnidirectionalStreams.getReader()
  const objects = Array.from({ length: n }, (_, i) => ({ id: BigInt(i), bytes: 10 }))
  wt.deliverUniStream([subgroupBytes({ alias: 4n, group, objects })]).close()
  const reader = ((await uni.read()).value as ReadableStream<Uint8Array>).getReader()
  for (;;) if ((await reader.read()).done) break
  uni.releaseLock()
  await settle(2)
}

/** Intercepts the page lifecycle events; everything else still reaches the real global. */
function captureLifecycle(): {
  fire: (type: string, e?: unknown) => void
  restore: () => void
} {
  const prev = g.addEventListener as
    | ((t: string, f: (e?: unknown) => void, ...rest: unknown[]) => void)
    | undefined
  const handlers = new Map<string, ((e?: unknown) => void)[]>()
  const captured = new Set(['pagehide', 'pageshow', 'visibilitychange', 'online'])
  g.addEventListener = (t: string, f: (e?: unknown) => void, ...rest: unknown[]): void => {
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
      g.addEventListener = prev
    },
  }
}

/** Each body's batch record and seal, found by a note it carries. */
async function bodiesOf(posts: readonly Post[]) {
  const all: {
    batch: BatchRecord
    seal: ReturnType<typeof preambleOf>['seal']
    records: EnvelopeRecord[]
  }[] = []
  for (const p of posts) {
    const records = await recordsOf(p.body)
    if (records[0]?.t !== 'batch') continue
    all.push({ batch: records[0] as BatchRecord, seal: preambleOf(p.body).seal, records })
  }
  const hits = (name: string) =>
    all.filter((b) => b.records.some((r) => r.t === 'note' && r.name === name))
  return {
    of: (name: string) => {
      expect(hits(name)).toHaveLength(1)
      return hits(name)[0]
    },
    /** The seq of the one body carrying note `name`. */
    with: (name: string) => {
      expect(hits(name)).toHaveLength(1)
      return hits(name)[0]?.seal.seq
    },
  }
}
