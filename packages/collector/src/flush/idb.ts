import type { DetailLevel } from '../types.js'

/**
 * IndexedDB persists the flush buffer: the queue of encoded chunks the collector
 * has decided to send and has not yet managed to. A page closed or reloaded
 * mid-trickle is the ordinary case — the pacer releases slowly, so there is
 * almost always a backlog, largest exactly when the session is most worth having.
 *
 * 1. **The ring is never stored here.** It holds media payloads; persisting it
 *    would put the customer's end users' media into origin storage on their
 *    device. What is stored is encoded envelope records: derived counts, timings
 *    and control-plane bytes.
 *
 * 2. **Chunks arrive already keyed**, at creation and before persistence. This
 *    store never derives a key; it uses the one it is handed as the primary key.
 *    A chunk keyed at upload time instead would get a fresh key after a reload
 *    and be counted twice.
 *
 * 3. **Records are session-scoped.** The origin's storage is shared by every tab,
 *    so `clearSession` deletes one session's chunks and touches no other's. The
 *    *quota* is still shared and one heavy session can still starve another —
 *    bounded, not solved.
 *
 * The store degrades rather than fails. IndexedDB is absent in some workers,
 * throws on open in private-mode and sandboxed-iframe contexts, and can reject
 * any write with `QuotaExceededError`. None of that may take the session's
 * telemetry down with it, so an unavailable backend falls back to memory and
 * {@link ChunkStore.durable} says so.
 */

/**
 * One sealed body, keyed and ready to upload.
 *
 * `bytes` is the complete request body — preamble, batch frame, records — as the
 * envelope module encoded it. It is stored and uploaded verbatim so a retry
 * after a reload sends byte-identical content under the identical key.
 */
export interface Chunk {
  readonly sessionId: string
  readonly segmentSeq: number
  /** Stamped at CREATION, before persistence. Never at upload time. */
  readonly idempotencyKey: string
  readonly createdWallMs: number
  readonly bytes: Uint8Array
  readonly level: DetailLevel
  /** Mutable: the uploader counts attempts against `Limits.uploadMaxAttempts`. */
  attempts: number
}

/** The small record the store keeps in memory for every persisted chunk. */
export interface ChunkIndexEntry {
  readonly key: string
  readonly sessionId: string
  readonly segmentSeq: number
  readonly createdWallMs: number
  /** Byte length of the stored body — the quota is accounted on this. */
  readonly size: number
}

/** Per-session segment allocation. Outlives the chunks it numbered. */
export interface SeqMeta {
  readonly sessionId: string
  /** The next unallocated `segmentSeq` for this session. */
  readonly nextSeq: number
  /** Wall time of the last allocation, for TTL pruning. */
  readonly at: number
}

/**
 * The persistence seam.
 *
 * Exists because IndexedDB is unavailable in Node — where this package's suite
 * runs — and unreliable in several real browser contexts. Both backends are
 * production paths: which one is chosen is a property of the environment, not of
 * the test.
 */
export interface ChunkBackend {
  /** False for the memory backend: a reload loses the backlog. */
  readonly durable: boolean
  loadIndex(): Promise<ChunkIndexEntry[]>
  put(entry: ChunkIndexEntry, chunk: Chunk): Promise<void>
  get(key: string): Promise<Chunk | undefined>
  remove(key: string): Promise<void>
  getMeta(sessionId: string): Promise<SeqMeta | undefined>
  setMeta(meta: SeqMeta): Promise<void>
  listMeta(): Promise<SeqMeta[]>
  removeMeta(sessionId: string): Promise<void>
  close(): void
}

export interface ChunkStoreOptions {
  /**
   * The IndexedDB implementation to use. Defaults to `globalThis.indexedDB`;
   * `null` forces the memory backend.
   */
  readonly factory?: IDBFactory | null
  /** Inject a backend outright. Used by the suite and by hosts with their own storage. */
  readonly backend?: ChunkBackend
  readonly onInternalError?: (err: unknown) => void
  /** Wall clock, for segment-meta TTL pruning. Defaults to `Date.now`. */
  readonly now?: () => number
}

const CHUNKS = 'chunks'
/**
 * The small per-chunk index, kept in its own object store.
 *
 * IndexedDB has no projection: a cursor over `chunks` yields whole rows, payload
 * included, so reading the backlog's *sizes* by reading the backlog would pull
 * the entire quota — megabytes — into memory on every page load. Index rows are
 * tens of bytes and are written in the same transaction as the body they
 * describe.
 */
const INDEX = 'index'
const META = 'meta'

/**
 * How long a session's segment counter outlives its last chunk.
 *
 * The counter is deliberately **not** deleted with the chunks it numbered:
 * `sha256(sessionId:segmentSeq)` must never be reissued for different bytes,
 * because ingest dedupes exactly and would discard the second body **silently**.
 * Seven days bounds the accumulation without making a same-day reload reuse a
 * number.
 */
const META_TTL_MS = 7 * 24 * 60 * 60 * 1000

/** In-memory backend. The fallback when IndexedDB is unavailable or refuses to open. */
export class MemoryBackend implements ChunkBackend {
  readonly durable = false
  readonly #chunks = new Map<string, Chunk>()
  readonly #index = new Map<string, ChunkIndexEntry>()
  readonly #meta = new Map<string, SeqMeta>()

  loadIndex(): Promise<ChunkIndexEntry[]> {
    return Promise.resolve([...this.#index.values()])
  }

  put(entry: ChunkIndexEntry, chunk: Chunk): Promise<void> {
    this.#index.set(entry.key, entry)
    this.#chunks.set(entry.key, { ...chunk, bytes: chunk.bytes.slice() })
    return Promise.resolve()
  }

  get(key: string): Promise<Chunk | undefined> {
    const c = this.#chunks.get(key)
    return Promise.resolve(c === undefined ? undefined : { ...c, bytes: c.bytes.slice() })
  }

  remove(key: string): Promise<void> {
    this.#chunks.delete(key)
    this.#index.delete(key)
    return Promise.resolve()
  }

  getMeta(sessionId: string): Promise<SeqMeta | undefined> {
    return Promise.resolve(this.#meta.get(sessionId))
  }

  setMeta(meta: SeqMeta): Promise<void> {
    this.#meta.set(meta.sessionId, meta)
    return Promise.resolve()
  }

  listMeta(): Promise<SeqMeta[]> {
    return Promise.resolve([...this.#meta.values()])
  }

  removeMeta(sessionId: string): Promise<void> {
    this.#meta.delete(sessionId)
    return Promise.resolve()
  }

  close(): void {
    // Nothing to release. Records stay so a reopened store in the same page
    // sees the same backlog, which is what the IndexedDB backend does too.
  }
}

const request = <T>(req: IDBRequest<T>): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('idb request failed'))
  })

/** IndexedDB backend. Three object stores: chunk bodies, a small index, and segment meta. */
export class IdbBackend implements ChunkBackend {
  readonly durable = true
  readonly #db: IDBDatabase

  private constructor(db: IDBDatabase) {
    this.#db = db
  }

  static open(dbName: string, factory: IDBFactory): Promise<IdbBackend> {
    return new Promise<IdbBackend>((resolve, reject) => {
      let req: IDBOpenDBRequest
      try {
        req = factory.open(dbName, 1)
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)))
        return
      }
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(CHUNKS)) db.createObjectStore(CHUNKS, { keyPath: 'key' })
        if (!db.objectStoreNames.contains(INDEX)) db.createObjectStore(INDEX, { keyPath: 'key' })
        if (!db.objectStoreNames.contains(META))
          db.createObjectStore(META, { keyPath: 'sessionId' })
      }
      req.onsuccess = () => resolve(new IdbBackend(req.result))
      req.onerror = () => reject(req.error ?? new Error('indexedDB.open failed'))
      req.onblocked = () => reject(new Error('indexedDB.open blocked'))
    })
  }

  loadIndex(): Promise<ChunkIndexEntry[]> {
    const tx = this.#db.transaction(INDEX, 'readonly')
    return request<ChunkIndexEntry[]>(
      tx.objectStore(INDEX).getAll() as IDBRequest<ChunkIndexEntry[]>,
    )
  }

  put(entry: ChunkIndexEntry, chunk: Chunk): Promise<void> {
    const tx = this.#db.transaction([CHUNKS, INDEX], 'readwrite')
    const row: StoredChunk = {
      key: entry.key,
      sessionId: chunk.sessionId,
      segmentSeq: chunk.segmentSeq,
      idempotencyKey: chunk.idempotencyKey,
      createdWallMs: chunk.createdWallMs,
      level: chunk.level,
      attempts: chunk.attempts,
      bytes: chunk.bytes,
    }
    // One transaction, so a body never outlives its index row or the reverse.
    return Promise.all([
      request(tx.objectStore(CHUNKS).put(row)),
      request(tx.objectStore(INDEX).put(entry)),
    ]).then(() => undefined)
  }

  async get(key: string): Promise<Chunk | undefined> {
    const tx = this.#db.transaction(CHUNKS, 'readonly')
    const row = await request<StoredChunk | undefined>(
      tx.objectStore(CHUNKS).get(key) as IDBRequest<StoredChunk | undefined>,
    )
    if (row === undefined) return undefined
    return {
      sessionId: row.sessionId,
      segmentSeq: row.segmentSeq,
      idempotencyKey: row.idempotencyKey,
      createdWallMs: row.createdWallMs,
      bytes: row.bytes,
      level: row.level,
      attempts: row.attempts,
    }
  }

  remove(key: string): Promise<void> {
    const tx = this.#db.transaction([CHUNKS, INDEX], 'readwrite')
    return Promise.all([
      request(tx.objectStore(CHUNKS).delete(key)),
      request(tx.objectStore(INDEX).delete(key)),
    ]).then(() => undefined)
  }

  getMeta(sessionId: string): Promise<SeqMeta | undefined> {
    const tx = this.#db.transaction(META, 'readonly')
    return request<SeqMeta | undefined>(
      tx.objectStore(META).get(sessionId) as IDBRequest<SeqMeta | undefined>,
    )
  }

  setMeta(meta: SeqMeta): Promise<void> {
    const tx = this.#db.transaction(META, 'readwrite')
    return request(tx.objectStore(META).put(meta)).then(() => undefined)
  }

  listMeta(): Promise<SeqMeta[]> {
    const tx = this.#db.transaction(META, 'readonly')
    return request<SeqMeta[]>(tx.objectStore(META).getAll() as IDBRequest<SeqMeta[]>)
  }

  removeMeta(sessionId: string): Promise<void> {
    const tx = this.#db.transaction(META, 'readwrite')
    return request(tx.objectStore(META).delete(sessionId)).then(() => undefined)
  }

  close(): void {
    this.#db.close()
  }
}

/** The row shape written to the `chunks` object store. */
interface StoredChunk {
  readonly key: string
  readonly sessionId: string
  readonly segmentSeq: number
  readonly idempotencyKey: string
  readonly createdWallMs: number
  readonly level: DetailLevel
  readonly attempts: number
  readonly bytes: Uint8Array
}

/**
 * The persisted flush buffer.
 *
 * Bounded by a byte quota with **FIFO eviction**, session-scoped reads and
 * clears, and a segment allocator that survives the reload it exists for. Never
 * throws out of a write: a storage failure degrades durability, and taking the
 * page's telemetry down to report it would be the worse trade.
 */
export class ChunkStore {
  readonly #backend: ChunkBackend
  readonly #quota: number
  readonly #onError: ((err: unknown) => void) | undefined
  readonly #now: () => number
  readonly #index = new Map<string, ChunkIndexEntry>()
  #bytes = 0
  #evictedFifo = 0
  #refused = 0
  #writeFailures = 0
  #metaChain: Promise<unknown> = Promise.resolve()

  private constructor(
    backend: ChunkBackend,
    quotaBytes: number,
    onError: ((err: unknown) => void) | undefined,
    now: () => number,
  ) {
    this.#backend = backend
    this.#quota = Math.max(0, quotaBytes)
    this.#onError = onError
    this.#now = now
  }

  /**
   * Open the store, choosing a backend and loading the index of what a previous
   * page load left behind.
   *
   * Never rejects. An IndexedDB that is missing, blocked, or refuses to open
   * yields a memory-backed store with `durable === false`.
   */
  static async open(
    dbName: string,
    quotaBytes: number,
    options?: ChunkStoreOptions,
  ): Promise<ChunkStore> {
    const onError = options?.onInternalError
    const now = options?.now ?? Date.now
    let backend = options?.backend
    if (backend === undefined) {
      const factory =
        options?.factory === undefined
          ? ((globalThis as { indexedDB?: IDBFactory }).indexedDB ?? null)
          : options.factory
      if (factory !== null) {
        try {
          backend = await IdbBackend.open(dbName, factory)
        } catch (err) {
          onError?.(err)
          backend = undefined
        }
      }
    }
    const store = new ChunkStore(backend ?? new MemoryBackend(), quotaBytes, onError, now)
    await store.#load()
    return store
  }

  /** False when the backlog lives only in memory — a reload loses it. */
  get durable(): boolean {
    return this.#backend.durable
  }

  /** Bytes currently persisted, across every session sharing the origin. */
  get bytes(): number {
    return this.#bytes
  }

  get chunks(): number {
    return this.#index.size
  }

  /** Chunks evicted oldest-first to stay inside the quota. */
  get evictedFifo(): number {
    return this.#evictedFifo
  }

  /** Chunks refused outright because one body exceeded the whole quota. */
  get refused(): number {
    return this.#refused
  }

  /** Writes the backend rejected. Durability lost; the chunk may still upload. */
  get writeFailures(): number {
    return this.#writeFailures
  }

  /**
   * Persist one already-keyed chunk, evicting oldest-first to stay inside the
   * quota.
   *
   * Eviction is FIFO **across sessions**, because the quota is a property of the
   * origin's storage and not of a session: one tab's `clearSession` can never
   * destroy another's backlog, but one heavy session can crowd a quiet one out.
   */
  async put(c: Chunk): Promise<void> {
    const size = c.bytes.byteLength
    if (size > this.#quota) {
      // Evicting the entire store still would not make room. Refuse the chunk
      // rather than empty the backlog for something that cannot fit.
      this.#refused += 1
      return
    }
    const existing = this.#index.get(c.idempotencyKey)
    if (existing !== undefined) this.#bytes -= existing.size
    this.#evictTo(this.#quota - size, c.idempotencyKey)
    const entry: ChunkIndexEntry = {
      key: c.idempotencyKey,
      sessionId: c.sessionId,
      segmentSeq: c.segmentSeq,
      createdWallMs: c.createdWallMs,
      size,
    }
    try {
      await this.#backend.put(entry, c)
      this.#index.set(entry.key, entry)
      this.#bytes += size
    } catch (err) {
      if (existing !== undefined) this.#index.delete(existing.key)
      this.#writeFailures += 1
      this.#onError?.(err)
    }
  }

  /**
   * One session's backlog as index rows — oldest segment first, no bodies.
   *
   * The rows are tens of bytes and already in memory, so this is synchronous and
   * free. **This is the method a release loop should walk**, loading one body at
   * a time with {@link ChunkStore.get}: `list()` materialises an entire session's
   * bodies at once, which on a page load after a long offline stretch is the
   * whole quota in one allocation.
   */
  pending(sessionId: string): ChunkIndexEntry[] {
    return [...this.#index.values()]
      .filter((e) => e.sessionId === sessionId)
      .sort((a, b) => a.segmentSeq - b.segmentSeq)
  }

  /** One chunk by its idempotency key. `undefined` if it was evicted meanwhile. */
  async get(key: string): Promise<Chunk | undefined> {
    if (!this.#index.has(key)) return undefined
    try {
      return await this.#backend.get(key)
    } catch (err) {
      this.#onError?.(err)
      return undefined
    }
  }

  /**
   * One session's backlog, bodies included, oldest segment first.
   *
   * Convenient for a small backlog and for the suite; prefer
   * {@link ChunkStore.pending} plus {@link ChunkStore.get} when the backlog may
   * be large.
   */
  async list(sessionId: string): Promise<Chunk[]> {
    const out: Chunk[] = []
    for (const e of this.pending(sessionId)) {
      const c = await this.get(e.key)
      if (c !== undefined) out.push(c)
    }
    return out
  }

  /**
   * Delete one chunk by its idempotency key — which is the store's primary key,
   * so an upload confirmed by ingest deletes exactly what it sent.
   */
  async delete(key: string): Promise<void> {
    const e = this.#index.get(key)
    try {
      await this.#backend.remove(key)
    } catch (err) {
      this.#onError?.(err)
      return
    }
    if (e !== undefined) {
      this.#index.delete(key)
      this.#bytes -= e.size
    }
  }

  /**
   * Drop one session's chunks and nothing else.
   *
   * The session's **segment counter is deliberately kept**: an ingest that
   * dedupes exactly would silently discard a reissued
   * `sha256(sessionId:segmentSeq)` carrying different bytes, so the counter
   * outlives the chunks it numbered and is pruned by TTL (see
   * {@link META_TTL_MS}).
   */
  async clearSession(sessionId: string): Promise<void> {
    const keys = [...this.#index.values()]
      .filter((e) => e.sessionId === sessionId)
      .map((e) => e.key)
    for (const k of keys) await this.delete(k)
  }

  /**
   * Allocate the next `segmentSeq` for a session and persist the allocation
   * before returning it.
   *
   * `segmentSeq` is persisted *with* the chunk, never held in memory: a sequence
   * that resets on reload mints a fresh key per retry, which double-counts
   * silently into non-idempotent counters. Allocating from the *chunks* that
   * happen to be present would reissue numbers as soon as an upload succeeded
   * and its chunk was deleted, so the counter is its own record.
   *
   * Serialised: two concurrent seals must never receive the same number.
   */
  nextSegmentSeq(sessionId: string): Promise<number> {
    const run = this.#metaChain.then(
      () => this.#allocate(sessionId),
      () => this.#allocate(sessionId),
    )
    this.#metaChain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /**
   * Raise a session's counter so it can never reissue `next`.
   *
   * The safety net for the synchronous `pagehide` seal, which cannot await an
   * allocation: it takes a number from memory and calls this to make the
   * persisted counter agree. Monotonic, so a late call can never hand a number
   * back out.
   */
  raiseSegmentSeq(sessionId: string, next: number): Promise<void> {
    if (!Number.isFinite(next)) return Promise.resolve()
    const run = this.#metaChain.then(
      () => this.#raise(sessionId, next),
      () => this.#raise(sessionId, next),
    )
    this.#metaChain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  close(): void {
    try {
      this.#backend.close()
    } catch (err) {
      this.#onError?.(err)
    }
  }

  async #raise(sessionId: string, next: number): Promise<void> {
    try {
      const meta = await this.#backend.getMeta(sessionId)
      const current = meta !== undefined && Number.isFinite(meta.nextSeq) ? meta.nextSeq : 0
      if (current >= next) return
      await this.#backend.setMeta({ sessionId, nextSeq: next, at: this.#now() })
    } catch (err) {
      this.#writeFailures += 1
      this.#onError?.(err)
    }
  }

  async #allocate(sessionId: string): Promise<number> {
    let current = 0
    try {
      const meta = await this.#backend.getMeta(sessionId)
      if (meta !== undefined && Number.isFinite(meta.nextSeq)) current = meta.nextSeq
    } catch (err) {
      this.#onError?.(err)
    }
    try {
      await this.#backend.setMeta({ sessionId, nextSeq: current + 1, at: this.#now() })
    } catch (err) {
      // The number is still returned. A lost persist means a reload may reuse
      // it, which ingest dedupes — the alternative, refusing to seal, loses the
      // records outright.
      this.#writeFailures += 1
      this.#onError?.(err)
    }
    return current
  }

  async #load(): Promise<void> {
    try {
      const entries = await this.#backend.loadIndex()
      for (const e of entries) {
        this.#index.set(e.key, e)
        this.#bytes += e.size
      }
    } catch (err) {
      this.#onError?.(err)
    }
    // The quota may have been lowered since the last page load, so the backlog
    // is trimmed on open rather than only on write.
    this.#evictTo(this.#quota)
    try {
      const cutoff = this.#now() - META_TTL_MS
      for (const m of await this.#backend.listMeta()) {
        if (Number.isFinite(m.at) && m.at < cutoff) await this.#backend.removeMeta(m.sessionId)
      }
    } catch (err) {
      this.#onError?.(err)
    }
  }

  /** FIFO: oldest `createdWallMs` first, ties broken by segment order. */
  #evictTo(target: number, keep?: string): void {
    if (this.#bytes <= target) return
    const order = [...this.#index.values()].sort(
      (a, b) => a.createdWallMs - b.createdWallMs || a.segmentSeq - b.segmentSeq,
    )
    for (const e of order) {
      if (this.#bytes <= target) return
      if (e.key === keep) continue
      this.#index.delete(e.key)
      this.#bytes -= e.size
      this.#evictedFifo += 1
      void this.#backend.remove(e.key).catch((err: unknown) => this.#onError?.(err))
    }
  }
}
