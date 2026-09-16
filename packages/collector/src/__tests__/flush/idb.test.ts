/**
 * Deferred durability.
 *
 * > A page closed or reloaded mid-trickle is the ordinary case, not an edge one:
 * > the pacer deliberately releases slowly, so there is almost always a backlog, and
 * > on a bad connection the backlog is largest exactly when the session is most
 * > worth having.
 *
 * Four properties are load-bearing and each is tested against behaviour a
 * caller can observe:
 *
 *  1. **The segment counter outlives the chunks it numbered.** Allocating from
 *     the chunks that happen to be present would reissue a number the moment an
 *     upload succeeded and its chunk was deleted — and ingest dedupes *exactly*
 *     on `sha256(sessionId:segmentSeq)`, so the second body under a reissued key
 *     is discarded in silence. The counter is its own record, pruned by TTL.
 *  2. **Records are session-scoped.** Origin storage is shared by every tab, so
 *     one tab's `clearSession` must not destroy another's backlog. The *quota*
 *     is still shared — bounded, not solved.
 *  3. **The store degrades instead of failing.** IndexedDB is absent in some
 *     workers, throws on open in private-mode and sandboxed contexts, and can
 *     reject any write with `QuotaExceededError`. Non-interference forbids any of that
 *     reaching the page.
 *  4. **Quota is enforced by FIFO eviction and counted**, because a
 *     collector that drops silently is worse than one that says so.
 *
 * The suite runs against the injectable backend rather than a fake IndexedDB:
 * both backends are production paths — which one is chosen is a property of the
 * environment, not of the test — and a hand-written IDB fake would only prove
 * the fake works.
 */

import { describe, expect, it } from 'vitest'
import type { Chunk, ChunkBackend } from '../../flush/index.js'
import { ChunkStore, MemoryBackend } from '../../flush/index.js'

const chunk = (sessionId: string, seq: number, size = 100, wallMs = 1_000 + seq): Chunk => ({
  sessionId,
  segmentSeq: seq,
  idempotencyKey: `${sessionId}:${seq}`,
  createdWallMs: wallMs,
  bytes: new Uint8Array(size).fill(seq & 0xff),
  level: 'baseline',
  attempts: 0,
})

const MB = 1 << 20

/** A backend that delegates, with individual operations replaced. */
const patched = (inner: ChunkBackend, over: Partial<ChunkBackend>): ChunkBackend => ({
  durable: inner.durable,
  loadIndex: () => inner.loadIndex(),
  put: (e, c) => inner.put(e, c),
  get: (k) => inner.get(k),
  remove: (k) => inner.remove(k),
  getMeta: (id) => inner.getMeta(id),
  setMeta: (m) => inner.setMeta(m),
  listMeta: () => inner.listMeta(),
  removeMeta: (id) => inner.removeMeta(id),
  close: () => inner.close(),
  ...over,
})

describe('ChunkStore, the backlog', () => {
  it('stores a chunk under the key it arrived with and hands it back byte for byte', async () => {
    const store = await ChunkStore.open('db', MB, { backend: new MemoryBackend() })
    const c = chunk('s1', 0)
    await store.put(c)

    const back = await store.list('s1')
    expect(back).toHaveLength(1)
    expect(back[0]?.idempotencyKey).toBe('s1:0')
    expect(back[0]?.bytes).toEqual(c.bytes)
    expect(back[0]?.level).toBe('baseline')
  })

  it('lists one session oldest-segment-first and shows no other session its chunks', async () => {
    const store = await ChunkStore.open('db', MB, { backend: new MemoryBackend() })
    await store.put(chunk('s1', 2))
    await store.put(chunk('s2', 0))
    await store.put(chunk('s1', 0))
    await store.put(chunk('s1', 1))

    expect((await store.list('s1')).map((c) => c.segmentSeq)).toEqual([0, 1, 2])
    expect((await store.list('s2')).map((c) => c.segmentSeq)).toEqual([0])
  })

  it('survives a reload with the backlog intact — that is the whole point', async () => {
    const backend = new MemoryBackend()
    const before = await ChunkStore.open('db', MB, { backend })
    await before.put(chunk('s1', 0))
    await before.put(chunk('s1', 1))

    const after = await ChunkStore.open('db', MB, { backend })
    expect((await after.list('s1')).map((c) => c.idempotencyKey)).toEqual(['s1:0', 's1:1'])
    expect(after.bytes).toBe(200)
  })

  it('deletes by idempotency key, which is what an ingest confirmation names', async () => {
    const store = await ChunkStore.open('db', MB, { backend: new MemoryBackend() })
    await store.put(chunk('s1', 0))
    await store.put(chunk('s1', 1))

    await store.delete('s1:0')
    expect((await store.list('s1')).map((c) => c.segmentSeq)).toEqual([1])
    expect(store.bytes).toBe(100)
  })

  it('names the backlog without reading a single body, so a release loop can page it', async () => {
    let bodyReads = 0
    const backend = new MemoryBackend()
    const counted = patched(backend, {
      get: (k) => {
        bodyReads += 1
        return backend.get(k)
      },
    })
    const store = await ChunkStore.open('db', MB, { backend: counted })
    await store.put(chunk('s1', 1))
    await store.put(chunk('s1', 0))
    await store.put(chunk('s2', 0))

    expect(store.pending('s1').map((e) => e.segmentSeq)).toEqual([0, 1])
    expect(bodyReads).toBe(0)

    const first = await store.get('s1:0')
    expect(first?.segmentSeq).toBe(0)
    expect(bodyReads).toBe(1)
  })

  it('reports a body that is no longer there rather than a stale row', async () => {
    const store = await ChunkStore.open('db', MB, { backend: new MemoryBackend() })
    await store.put(chunk('s1', 0))
    await store.delete('s1:0')
    expect(await store.get('s1:0')).toBeUndefined()
  })

  it('re-persisting the same chunk does not charge the quota twice', async () => {
    const store = await ChunkStore.open('db', MB, { backend: new MemoryBackend() })
    await store.put(chunk('s1', 0))
    await store.put(chunk('s1', 0))
    expect(store.chunks).toBe(1)
    expect(store.bytes).toBe(100)
  })
})

describe('ChunkStore, session scoping', () => {
  it('clears one session and leaves another tab’s backlog alone', async () => {
    const store = await ChunkStore.open('db', MB, { backend: new MemoryBackend() })
    await store.put(chunk('s1', 0))
    await store.put(chunk('s2', 0))

    await store.clearSession('s1')
    expect(await store.list('s1')).toHaveLength(0)
    expect(await store.list('s2')).toHaveLength(1)
  })

  it('keeps the segment counter when a session is cleared, so no number is reissued', async () => {
    const store = await ChunkStore.open('db', MB, { backend: new MemoryBackend() })
    const first = await store.nextSegmentSeq('s1')
    await store.put(chunk('s1', first))

    await store.clearSession('s1')
    expect(await store.nextSegmentSeq('s1')).toBeGreaterThan(first)
  })
})

describe('ChunkStore, segment allocation', () => {
  it('hands out consecutive numbers', async () => {
    const store = await ChunkStore.open('db', MB, { backend: new MemoryBackend() })
    expect(await store.nextSegmentSeq('s1')).toBe(0)
    expect(await store.nextSegmentSeq('s1')).toBe(1)
    expect(await store.nextSegmentSeq('s2')).toBe(0)
  })

  it('never hands the same number to two concurrent callers', async () => {
    const store = await ChunkStore.open('db', MB, { backend: new MemoryBackend() })
    const seqs = await Promise.all([
      store.nextSegmentSeq('s1'),
      store.nextSegmentSeq('s1'),
      store.nextSegmentSeq('s1'),
      store.nextSegmentSeq('s1'),
      store.nextSegmentSeq('s1'),
    ])
    expect(new Set(seqs).size).toBe(5)
  })

  it('continues the sequence across a reload rather than restarting at zero', async () => {
    const backend = new MemoryBackend()
    const before = await ChunkStore.open('db', MB, { backend })
    await before.nextSegmentSeq('s1')
    await before.nextSegmentSeq('s1')

    const after = await ChunkStore.open('db', MB, { backend })
    expect(await after.nextSegmentSeq('s1')).toBe(2)
  })

  it('raiseSegmentSeq only ever moves the counter forward', async () => {
    const store = await ChunkStore.open('db', MB, { backend: new MemoryBackend() })
    await store.raiseSegmentSeq('s1', 10)
    expect(await store.nextSegmentSeq('s1')).toBe(10)

    // A late call from the pagehide path must never hand a number back out.
    await store.raiseSegmentSeq('s1', 5)
    expect(await store.nextSegmentSeq('s1')).toBe(11)
  })

  it('prunes a segment counter no session has touched for a week', async () => {
    const backend = new MemoryBackend()
    await backend.setMeta({ sessionId: 'stale', nextSeq: 42, at: 0 })
    const eightDays = 8 * 24 * 60 * 60 * 1000
    await backend.setMeta({ sessionId: 'fresh', nextSeq: 7, at: eightDays - 1_000 })

    const store = await ChunkStore.open('db', MB, { backend, now: () => eightDays })
    expect(await store.nextSegmentSeq('stale')).toBe(0)
    expect(await store.nextSegmentSeq('fresh')).toBe(7)
  })
})

describe('ChunkStore, the quota', () => {
  it('evicts oldest-first to stay inside the quota, and counts what it dropped', async () => {
    const store = await ChunkStore.open('db', 250, { backend: new MemoryBackend() })
    await store.put(chunk('s1', 0, 100, 1_000))
    await store.put(chunk('s1', 1, 100, 2_000))
    await store.put(chunk('s1', 2, 100, 3_000))

    expect((await store.list('s1')).map((c) => c.segmentSeq)).toEqual([1, 2])
    expect(store.evictedFifo).toBe(1)
    expect(store.bytes).toBeLessThanOrEqual(250)
  })

  it('evicts across sessions, because the quota belongs to the origin and not to a session', async () => {
    const store = await ChunkStore.open('db', 150, { backend: new MemoryBackend() })
    await store.put(chunk('s1', 0, 100, 1_000))
    await store.put(chunk('s2', 0, 100, 2_000))

    expect(await store.list('s1')).toHaveLength(0)
    expect(await store.list('s2')).toHaveLength(1)
  })

  it('refuses a body larger than the whole quota instead of emptying the backlog for it', async () => {
    const store = await ChunkStore.open('db', 150, { backend: new MemoryBackend() })
    await store.put(chunk('s1', 0, 100, 1_000))
    await store.put(chunk('s1', 1, 400, 2_000))

    expect(store.refused).toBe(1)
    expect((await store.list('s1')).map((c) => c.segmentSeq)).toEqual([0])
  })

  it('trims a backlog left by a page load whose quota was larger', async () => {
    const backend = new MemoryBackend()
    const generous = await ChunkStore.open('db', MB, { backend })
    for (let i = 0; i < 3; i++) await generous.put(chunk('s1', i, 100, 1_000 + i))

    const tightened = await ChunkStore.open('db', 150, { backend })
    expect(tightened.bytes).toBeLessThanOrEqual(150)
    expect(tightened.evictedFifo).toBeGreaterThanOrEqual(2)
    expect((await tightened.list('s1')).map((c) => c.segmentSeq)).toEqual([2])
  })
})

describe('ChunkStore, degradation', () => {
  it('reports that a memory-backed store is not durable', async () => {
    const store = await ChunkStore.open('db', MB, { backend: new MemoryBackend() })
    expect(store.durable).toBe(false)
  })

  it('falls back to memory when there is no IndexedDB at all', async () => {
    const errors: unknown[] = []
    const store = await ChunkStore.open('db', MB, {
      factory: null,
      onInternalError: (e) => errors.push(e),
    })
    expect(store.durable).toBe(false)
    expect(errors).toEqual([])
    await store.put(chunk('s1', 0))
    expect(await store.list('s1')).toHaveLength(1)
  })

  it('falls back to memory when opening IndexedDB throws, and says why', async () => {
    const errors: unknown[] = []
    const hostile = {
      open: () => {
        throw new Error('SecurityError: sandboxed iframe')
      },
    } as unknown as IDBFactory

    const store = await ChunkStore.open('db', MB, {
      factory: hostile,
      onInternalError: (e) => errors.push(e),
    })
    expect(store.durable).toBe(false)
    expect(errors).toHaveLength(1)
    await store.put(chunk('s1', 0))
    expect(await store.list('s1')).toHaveLength(1)
  })

  it('never throws out of put() when the backend rejects the write', async () => {
    const errors: unknown[] = []
    const backend = patched(new MemoryBackend(), {
      put: () => Promise.reject(new Error('QuotaExceededError')),
    })
    const store = await ChunkStore.open('db', MB, {
      backend,
      onInternalError: (e) => errors.push(e),
    })

    await expect(store.put(chunk('s1', 0))).resolves.toBeUndefined()
    expect(store.writeFailures).toBe(1)
    expect(errors).toHaveLength(1)
    expect(await store.list('s1')).toHaveLength(0)
  })

  it('still allocates a segment number when the metadata write fails', async () => {
    const backend = patched(new MemoryBackend(), {
      setMeta: () => Promise.reject(new Error('QuotaExceededError')),
    })
    const store = await ChunkStore.open('db', MB, { backend, onInternalError: () => {} })

    // The number is returned anyway: refusing to seal would lose the records
    // outright, while a reused number is something ingest already dedupes.
    expect(await store.nextSegmentSeq('s1')).toBe(0)
    expect(store.writeFailures).toBeGreaterThan(0)
  })

  it('opens with an empty backlog when the index cannot be read', async () => {
    const errors: unknown[] = []
    const backend = patched(new MemoryBackend(), {
      loadIndex: () => Promise.reject(new Error('InvalidStateError')),
    })
    const store = await ChunkStore.open('db', MB, {
      backend,
      onInternalError: (e) => errors.push(e),
    })
    expect(store.chunks).toBe(0)
    expect(errors).toHaveLength(1)
  })

  it('never throws out of close()', async () => {
    const backend = patched(new MemoryBackend(), {
      close: () => {
        throw new Error('already closed')
      },
    })
    const errors: unknown[] = []
    const store = await ChunkStore.open('db', MB, {
      backend,
      onInternalError: (e) => errors.push(e),
    })
    expect(() => store.close()).not.toThrow()
    expect(errors).toHaveLength(1)
  })
})
