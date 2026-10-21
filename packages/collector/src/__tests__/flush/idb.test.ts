/**
 * The stored copies of sealed bodies.
 *
 * > A page closed or reloaded mid-trickle is the ordinary case, not an edge one:
 * > the pacer deliberately releases slowly, so there is almost always a backlog, and
 * > on a bad connection the backlog is largest exactly when the session is most
 * > worth having.
 *
 * Four properties are load-bearing and each is tested against behaviour a
 * caller can observe:
 *
 *  1. **A body is stored under the key it was sealed with**, and comes back
 *     byte for byte, so a later page load that sends it dedupes against any
 *     copy that already arrived.
 *  2. **A stored body goes only where it was going.** Rows carry the endpoint
 *     and a hash of the ingest key, and the backlog a page sweeps is filtered on
 *     both, so one project's bodies never reach another's ingest. Rows from the
 *     previous database version carry neither and are swept once, as they are.
 *  3. **The store degrades instead of failing.** IndexedDB is absent in some
 *     contexts, throws on open in private-mode and sandboxed contexts, and can
 *     reject any write with `QuotaExceededError`. Non-interference forbids any
 *     of that reaching the page.
 *  4. **Quota is enforced by FIFO eviction and counted**, because a
 *     collector that drops silently is worse than one that says so.
 *
 * The suite runs against the injectable backend rather than a fake IndexedDB:
 * both backends are production paths — which one is chosen is a property of the
 * environment, not of the test — and a hand-written IDB fake would only prove
 * the fake works.
 */

import { describe, expect, it } from 'vitest'
import type { Chunk, ChunkBackend, ChunkDestination, ChunkIndexEntry } from '../../flush/index.js'
import { ChunkStore, MemoryBackend } from '../../flush/index.js'

const DEST: ChunkDestination = { endpoint: 'https://ingest.test/v1/ingest', keyHash: 'k1' }
const OTHER: ChunkDestination = { endpoint: 'https://ingest.test/v1/ingest', keyHash: 'k2' }

const chunk = (
  sessionId: string,
  seq: number,
  size = 100,
  wallMs = 1_000 + seq,
  instanceId = 'i1',
): Chunk => ({
  sessionId,
  instanceId,
  seq,
  idempotencyKey: `${sessionId}:${instanceId}:${seq}`,
  createdWallMs: wallMs,
  bytes: new Uint8Array(size).fill(seq & 0xff),
  level: 'baseline',
  attempts: 0,
})

const MB = 1 << 20

/** One session's stored bodies, oldest first, as a sweep would load them. */
async function listOf(store: ChunkStore, sessionId: string): Promise<Chunk[]> {
  const out: Chunk[] = []
  for (const e of store.backlog(DEST)) {
    if (e.sessionId !== sessionId) continue
    const c = await store.get(e.key)
    if (c !== undefined) out.push(c)
  }
  return out
}

/** A backend that delegates, with individual operations replaced. */
const patched = (inner: ChunkBackend, over: Partial<ChunkBackend>): ChunkBackend => ({
  durable: inner.durable,
  loadIndex: () => inner.loadIndex(),
  put: (e, c) => inner.put(e, c),
  get: (k) => inner.get(k),
  remove: (k) => inner.remove(k),
  close: () => inner.close(),
  ...over,
})

describe('ChunkStore, the backlog', () => {
  it('stores a chunk under the key it arrived with and hands it back byte for byte', async () => {
    const store = await ChunkStore.open('db', MB, { backend: new MemoryBackend() })
    const c = chunk('s1', 0)
    expect(await store.put(c, DEST)).toBe(true)

    const back = await listOf(store, 's1')
    expect(back).toHaveLength(1)
    expect(back[0]?.idempotencyKey).toBe('s1:i1:0')
    expect(back[0]?.instanceId).toBe('i1')
    expect(back[0]?.bytes).toEqual(c.bytes)
    expect(back[0]?.level).toBe('baseline')
    expect(store.has('s1:i1:0')).toBe(true)
  })

  it('orders the backlog oldest first, whatever order the copies were written in', async () => {
    const store = await ChunkStore.open('db', MB, { backend: new MemoryBackend() })
    await store.put(chunk('s1', 2), DEST)
    await store.put(chunk('s2', 0, 100, 1_500), DEST)
    await store.put(chunk('s1', 0), DEST)
    await store.put(chunk('s1', 1), DEST)

    expect(store.backlog(DEST).map((e) => e.key)).toEqual([
      's1:i1:0',
      's1:i1:1',
      's1:i1:2',
      's2:i1:0',
    ])
  })

  it('shows a destination only the bodies bound for it', async () => {
    const store = await ChunkStore.open('db', MB, { backend: new MemoryBackend() })
    await store.put(chunk('s1', 0), DEST)
    await store.put(chunk('s2', 0), OTHER)
    await store.put(chunk('s3', 0), { endpoint: 'https://elsewhere.test/', keyHash: 'k1' })

    expect(store.backlog(DEST).map((e) => e.sessionId)).toEqual(['s1'])
    expect(store.backlog(OTHER).map((e) => e.sessionId)).toEqual(['s2'])
  })

  it('survives a reload with the backlog intact — that is the whole point', async () => {
    const backend = new MemoryBackend()
    const before = await ChunkStore.open('db', MB, { backend })
    await before.put(chunk('s1', 0), DEST)
    await before.put(chunk('s1', 1), DEST)

    const after = await ChunkStore.open('db', MB, { backend })
    expect((await listOf(after, 's1')).map((c) => c.idempotencyKey)).toEqual(['s1:i1:0', 's1:i1:1'])
    expect(after.bytes).toBe(200)
  })

  it('reads rows the previous database version wrote as instance "" bound anywhere', async () => {
    // Version-1 index rows carry `segmentSeq` and no instance or destination.
    const legacy = {
      key: 'old-key',
      sessionId: 's-old',
      segmentSeq: 4,
      createdWallMs: 500,
      size: 100,
    } as unknown as ChunkIndexEntry
    const backend = patched(new MemoryBackend(), { loadIndex: async () => [legacy] })
    const store = await ChunkStore.open('db', MB, { backend })

    const [row] = store.backlog(DEST)
    expect(row).toEqual({
      key: 'old-key',
      sessionId: 's-old',
      instanceId: '',
      seq: 4,
      createdWallMs: 500,
      size: 100,
      endpoint: '',
      keyHash: '',
    })
    expect(store.backlog(OTHER)).toHaveLength(1)
  })

  it('deletes by idempotency key, which is what an ingest confirmation names', async () => {
    const store = await ChunkStore.open('db', MB, { backend: new MemoryBackend() })
    await store.put(chunk('s1', 0), DEST)
    await store.put(chunk('s1', 1), DEST)

    await store.delete('s1:i1:0')
    expect((await listOf(store, 's1')).map((c) => c.seq)).toEqual([1])
    expect(store.bytes).toBe(100)
    expect(store.has('s1:i1:0')).toBe(false)
  })

  it('names the backlog without reading a single body, so a sweep can page it', async () => {
    let bodyReads = 0
    const backend = new MemoryBackend()
    const counted = patched(backend, {
      get: (k) => {
        bodyReads += 1
        return backend.get(k)
      },
    })
    const store = await ChunkStore.open('db', MB, { backend: counted })
    await store.put(chunk('s1', 1), DEST)
    await store.put(chunk('s1', 0), DEST)

    expect(store.backlog(DEST).map((e) => e.seq)).toEqual([0, 1])
    expect(bodyReads).toBe(0)

    const first = await store.get('s1:i1:0')
    expect(first?.seq).toBe(0)
    expect(bodyReads).toBe(1)
  })

  it('reports a body that is no longer there rather than a stale row', async () => {
    const store = await ChunkStore.open('db', MB, { backend: new MemoryBackend() })
    await store.put(chunk('s1', 0), DEST)
    await store.delete('s1:i1:0')
    expect(await store.get('s1:i1:0')).toBeUndefined()
  })

  it('re-persisting the same chunk does not charge the quota twice', async () => {
    const store = await ChunkStore.open('db', MB, { backend: new MemoryBackend() })
    await store.put(chunk('s1', 0), DEST)
    await store.put(chunk('s1', 0), DEST)
    expect(store.chunks).toBe(1)
    expect(store.bytes).toBe(100)
  })
})

describe('ChunkStore, session scoping', () => {
  it('clears one session and leaves another tab’s backlog alone', async () => {
    const store = await ChunkStore.open('db', MB, { backend: new MemoryBackend() })
    await store.put(chunk('s1', 0), DEST)
    await store.put(chunk('s2', 0), DEST)

    await store.clearSession('s1')
    expect(await listOf(store, 's1')).toHaveLength(0)
    expect(await listOf(store, 's2')).toHaveLength(1)
  })
})

describe('ChunkStore, the quota', () => {
  it('evicts oldest-first to stay inside the quota, and counts what it dropped', async () => {
    const store = await ChunkStore.open('db', 250, { backend: new MemoryBackend() })
    await store.put(chunk('s1', 0, 100, 1_000), DEST)
    await store.put(chunk('s1', 1, 100, 2_000), DEST)
    await store.put(chunk('s1', 2, 100, 3_000), DEST)

    expect((await listOf(store, 's1')).map((c) => c.seq)).toEqual([1, 2])
    expect(store.evictedFifo).toBe(1)
    expect(store.bytes).toBeLessThanOrEqual(250)
  })

  it('evicts across sessions, because the quota belongs to the origin and not to a session', async () => {
    const store = await ChunkStore.open('db', 150, { backend: new MemoryBackend() })
    await store.put(chunk('s1', 0, 100, 1_000), DEST)
    await store.put(chunk('s2', 0, 100, 2_000), DEST)

    expect(await listOf(store, 's1')).toHaveLength(0)
    expect(await listOf(store, 's2')).toHaveLength(1)
  })

  it('refuses a body larger than the whole quota instead of emptying the backlog for it', async () => {
    const store = await ChunkStore.open('db', 150, { backend: new MemoryBackend() })
    await store.put(chunk('s1', 0, 100, 1_000), DEST)
    expect(await store.put(chunk('s1', 1, 400, 2_000), DEST)).toBe(false)

    expect(store.refused).toBe(1)
    expect((await listOf(store, 's1')).map((c) => c.seq)).toEqual([0])
  })

  it('trims a backlog left by a page load whose quota was larger', async () => {
    const backend = new MemoryBackend()
    const generous = await ChunkStore.open('db', MB, { backend })
    for (let i = 0; i < 3; i++) await generous.put(chunk('s1', i, 100, 1_000 + i), DEST)

    const tightened = await ChunkStore.open('db', 150, { backend })
    expect(tightened.bytes).toBeLessThanOrEqual(150)
    expect(tightened.evictedFifo).toBeGreaterThanOrEqual(2)
    expect((await listOf(tightened, 's1')).map((c) => c.seq)).toEqual([2])
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
    await store.put(chunk('s1', 0), DEST)
    expect(await listOf(store, 's1')).toHaveLength(1)
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
    await store.put(chunk('s1', 0), DEST)
    expect(await listOf(store, 's1')).toHaveLength(1)
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

    await expect(store.put(chunk('s1', 0), DEST)).resolves.toBe(false)
    expect(store.writeFailures).toBe(1)
    expect(errors).toHaveLength(1)
    expect(await listOf(store, 's1')).toHaveLength(0)
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
