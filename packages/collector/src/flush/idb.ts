import type { DetailLevel } from '../types.js'

/**
 * IndexedDB keeps a copy of every sealed body until ingest confirms it, so a
 * body the page could not send — offline, refused at unload, killed mid-upload
 * — is sent by the next page load on the origin.
 *
 * 1. **The ring is never stored here.** It holds media payloads; persisting it
 *    would put the customer's end users' media into origin storage on their
 *    device. What is stored is encoded envelope records: derived counts, timings
 *    and control-plane bytes.
 *
 * 2. **Chunks arrive already keyed**, at seal time. This store never derives a
 *    key; it uses the one it is handed as the primary key, and it numbers
 *    nothing: the sequence belongs to the instance that sealed the body, in
 *    memory, so there is no counter here to lose, race or reissue.
 *
 * 3. **Rows say where they were going.** Each carries the endpoint and a hash of
 *    the ingest key it was sealed for, so a later page load sends a stored body
 *    only to the ingest and project it belongs to. The key itself is never
 *    stored.
 *
 * The store degrades rather than fails. IndexedDB is absent in some contexts,
 * throws on open in private-mode and sandboxed-iframe contexts, and can reject
 * any write with `QuotaExceededError`. None of that may take the session's
 * telemetry down with it, so an unavailable backend falls back to memory and
 * {@link ChunkStore.durable} says so.
 */

/**
 * One sealed body, keyed and ready to upload.
 *
 * `bytes` is the complete request body — preamble, batch frame, records. It is
 * replaced once, by its gzipped form, after the seal; both forms carry the same
 * frames under the same key, so either one dedupes against the other.
 */
export interface Chunk {
  readonly sessionId: string
  /** `''` for a body stored by a collector that predates instances. */
  readonly instanceId: string
  readonly seq: number
  /** Stamped at the seal. Never at upload time. */
  readonly idempotencyKey: string
  readonly createdWallMs: number
  bytes: Uint8Array
  readonly level: DetailLevel
  /** Mutable: the uploader counts attempts. */
  attempts: number
}

/** Where a stored body is to be sent. */
export interface ChunkDestination {
  readonly endpoint: string
  /** `sha256` of the ingest key, hex. */
  readonly keyHash: string
}

/** The small record the store keeps in memory for every persisted chunk. */
export interface ChunkIndexEntry extends ChunkDestination {
  readonly key: string
  readonly sessionId: string
  readonly instanceId: string
  readonly seq: number
  readonly createdWallMs: number
  /** Byte length of the stored body — the quota is accounted on this. */
  readonly size: number
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
}

/**
 * Version 2 rows carry their instance and destination. The version-1 counter
 * store is deleted on upgrade.
 */
const DB_VERSION = 2

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
/** The version-1 per-session counter store, deleted on upgrade. */
const LEGACY_META = 'meta'

/**
 * A row as read back, from either version of the database.
 *
 * Version-1 rows carry `segmentSeq` and no instance or destination. They are
 * read as instance `''` with an empty destination, which the sweep takes to
 * mean "sent to wherever the page that finds them sends", once, under the key
 * they were stored with.
 */
type StoredRow = Partial<ChunkIndexEntry> & {
  readonly key: string
  readonly segmentSeq?: number
}

function normalise(row: StoredRow, size: number): ChunkIndexEntry {
  return {
    key: row.key,
    sessionId: row.sessionId ?? '',
    instanceId: row.instanceId ?? '',
    seq: row.seq ?? row.segmentSeq ?? 0,
    createdWallMs: row.createdWallMs ?? 0,
    size,
    endpoint: row.endpoint ?? '',
    keyHash: row.keyHash ?? '',
  }
}

/** In-memory backend. The fallback when IndexedDB is unavailable or refuses to open. */
export class MemoryBackend implements ChunkBackend {
  readonly durable = false
  readonly #chunks = new Map<string, Chunk>()
  readonly #index = new Map<string, ChunkIndexEntry>()

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

/** IndexedDB backend. Two object stores: chunk bodies and a small index. */
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
        req = factory.open(dbName, DB_VERSION)
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)))
        return
      }
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(CHUNKS)) db.createObjectStore(CHUNKS, { keyPath: 'key' })
        if (!db.objectStoreNames.contains(INDEX)) db.createObjectStore(INDEX, { keyPath: 'key' })
        // Version-1 rows stay: they are swept once under their own keys.
        if (db.objectStoreNames.contains(LEGACY_META)) db.deleteObjectStore(LEGACY_META)
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
      instanceId: chunk.instanceId,
      seq: chunk.seq,
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
    const row = await request<(Partial<StoredChunk> & { segmentSeq?: number }) | undefined>(
      tx.objectStore(CHUNKS).get(key) as IDBRequest<
        (Partial<StoredChunk> & { segmentSeq?: number }) | undefined
      >,
    )
    if (row === undefined || row.bytes === undefined) return undefined
    return {
      sessionId: row.sessionId ?? '',
      instanceId: row.instanceId ?? '',
      seq: row.seq ?? row.segmentSeq ?? 0,
      idempotencyKey: row.idempotencyKey ?? key,
      createdWallMs: row.createdWallMs ?? 0,
      bytes: row.bytes,
      level: row.level ?? 'baseline',
      attempts: row.attempts ?? 0,
    }
  }

  remove(key: string): Promise<void> {
    const tx = this.#db.transaction([CHUNKS, INDEX], 'readwrite')
    return Promise.all([
      request(tx.objectStore(CHUNKS).delete(key)),
      request(tx.objectStore(INDEX).delete(key)),
    ]).then(() => undefined)
  }

  close(): void {
    this.#db.close()
  }
}

/** The row shape written to the `chunks` object store. */
interface StoredChunk {
  readonly key: string
  readonly sessionId: string
  readonly instanceId: string
  readonly seq: number
  readonly idempotencyKey: string
  readonly createdWallMs: number
  readonly level: DetailLevel
  readonly attempts: number
  readonly bytes: Uint8Array
}

/**
 * The persisted copies of sealed bodies.
 *
 * Bounded by a byte quota with **FIFO eviction**. Never throws out of a write:
 * a storage failure degrades durability, and taking the page's telemetry down
 * to report it would be the worse trade.
 */
export class ChunkStore {
  readonly #backend: ChunkBackend
  readonly #quota: number
  readonly #onError: ((err: unknown) => void) | undefined
  readonly #index = new Map<string, ChunkIndexEntry>()
  #bytes = 0
  #evictedFifo = 0
  #refused = 0
  #writeFailures = 0

  private constructor(
    backend: ChunkBackend,
    quotaBytes: number,
    onError: ((err: unknown) => void) | undefined,
  ) {
    this.#backend = backend
    this.#quota = Math.max(0, quotaBytes)
    this.#onError = onError
  }

  /**
   * Open the store, choosing a backend and loading the index of what earlier
   * page loads left behind.
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
    const store = new ChunkStore(backend ?? new MemoryBackend(), quotaBytes, onError)
    await store.#load()
    return store
  }

  /** False when the copies live only in memory — a reload loses them. */
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

  /** Whether a copy of this body is held. */
  has(key: string): boolean {
    return this.#index.has(key)
  }

  /**
   * Persist one already-keyed chunk, evicting oldest-first to stay inside the
   * quota. Resolves `true` when the copy was written.
   *
   * Eviction is FIFO **across sessions**, because the quota is a property of the
   * origin's storage and not of a session: one heavy session can crowd a quiet
   * one out, and the eviction is counted.
   */
  async put(c: Chunk, dest: ChunkDestination): Promise<boolean> {
    const size = c.bytes.byteLength
    if (size > this.#quota) {
      // Evicting the entire store still would not make room. Refuse the chunk
      // rather than empty the backlog for something that cannot fit.
      this.#refused += 1
      return false
    }
    const existing = this.#index.get(c.idempotencyKey)
    if (existing !== undefined) this.#bytes -= existing.size
    this.#evictTo(this.#quota - size, c.idempotencyKey)
    const entry: ChunkIndexEntry = {
      key: c.idempotencyKey,
      sessionId: c.sessionId,
      instanceId: c.instanceId,
      seq: c.seq,
      createdWallMs: c.createdWallMs,
      size,
      endpoint: dest.endpoint,
      keyHash: dest.keyHash,
    }
    try {
      await this.#backend.put(entry, c)
      this.#index.set(entry.key, entry)
      this.#bytes += size
      return true
    } catch (err) {
      if (existing !== undefined) this.#index.delete(existing.key)
      this.#writeFailures += 1
      this.#onError?.(err)
      return false
    }
  }

  /**
   * The stored bodies bound for `dest`, as index rows — oldest first, no
   * bodies, and synchronous, because the rows are already in memory.
   *
   * A row from a database version that recorded no destination matches every
   * destination. Walk the result and load one body at a time with
   * {@link ChunkStore.get}: after a long offline stretch the backlog is the
   * whole quota, and loading it at once would be one allocation of that size.
   */
  backlog(dest: ChunkDestination): ChunkIndexEntry[] {
    return [...this.#index.values()]
      .filter(
        (e) =>
          (e.endpoint === '' || e.endpoint === dest.endpoint) &&
          (e.keyHash === '' || e.keyHash === dest.keyHash),
      )
      .sort((a, b) => a.createdWallMs - b.createdWallMs || a.seq - b.seq)
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

  /** Drop one session's stored bodies and nothing else. */
  async clearSession(sessionId: string): Promise<void> {
    const keys = [...this.#index.values()]
      .filter((e) => e.sessionId === sessionId)
      .map((e) => e.key)
    for (const k of keys) await this.delete(k)
  }

  close(): void {
    try {
      this.#backend.close()
    } catch (err) {
      this.#onError?.(err)
    }
  }

  async #load(): Promise<void> {
    try {
      const entries = await this.#backend.loadIndex()
      for (const raw of entries) {
        const e = normalise(raw as StoredRow, raw.size ?? 0)
        this.#index.set(e.key, e)
        this.#bytes += e.size
      }
    } catch (err) {
      this.#onError?.(err)
    }
    // The quota may have been lowered since the last page load, so the backlog
    // is trimmed on open rather than only on write.
    this.#evictTo(this.#quota)
  }

  /** FIFO: oldest `createdWallMs` first, ties broken by sequence. */
  #evictTo(target: number, keep?: string): void {
    if (this.#bytes <= target) return
    const order = [...this.#index.values()].sort(
      (a, b) => a.createdWallMs - b.createdWallMs || a.seq - b.seq,
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
