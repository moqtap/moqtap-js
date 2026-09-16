import {
  BODY_VERSION,
  encodeBody,
  FrameWriter,
  idempotencyKey,
  idempotencyKeySync,
  subtleAvailable,
  writePreamble,
} from '../envelope/index.js'
import type {
  BatchRecord,
  ClockSource,
  DetailLevel,
  EnvelopeRecord,
  RecordSink,
  SealReason,
} from '../types.js'
import type { Chunk, ChunkStore } from './idb.js'

/**
 * The flush buffer and the thing that seals it: records go in as frames, and a
 * **chunk** comes out — one self-contained frame stream, keyed and persisted
 * before the uploader sees it.
 *
 * Sealing is not releasing. This class and `schedule.ts` decide only *when* a
 * chunk is sealed; `pacer.ts` decides how fast sealed chunks leave. If pressure
 * could stretch the sealing interval instead, the "a crash loses at most 60
 * seconds" bound would fail exactly when congestion makes a crash likely.
 *
 * The order inside `seal()` is the durability requirement: take the frames,
 * allocate and *persist* the segment number, derive the key, write the batch
 * frame, encode the body, persist the chunk. A chunk keyed at creation and
 * uploaded on a later page load dedupes correctly; one keyed at upload time
 * gets a fresh key and is ingested twice.
 */

export interface FlushQueueOptions {
  readonly sessionId: string
  /** Where sealed chunks are persisted. `null` runs memory-only. */
  readonly store?: ChunkStore | null
  /**
   * Session-relative monotonic time and wall time. `now()` must already be
   * relative to the session anchor: every `ts` in the envelope is
   * `ClockAnchor.originMono`-relative and nothing downstream re-bases it.
   */
  readonly clock?: ClockSource
  /** The level a record was produced at, for `BatchRecord.lvl`. Default `baseline`. */
  readonly level?: () => DetailLevel
  /** The `CompressionStream('gzip')`. Default on. */
  readonly gzip?: boolean
  /**
   * Hard cap on the unsealed frame stream. Without it the buffer is unbounded
   * between seals, and a session whose seals are failing grows until the tab
   * dies, taking the page with it. Over the cap it drops and says so.
   * Default: eight times the 32 KB threshold.
   */
  readonly maxPendingBytes?: number
  /** Where the memory-only sequence starts when no store is configured. */
  readonly startSegmentSeq?: number
  readonly onInternalError?: (err: unknown) => void
}

const DEFAULT_MAX_PENDING = 8 * 32 * 1024

const platformClock: ClockSource = {
  now: () => performance.now(),
  wall: () => Date.now(),
}

const concat = (parts: readonly Uint8Array[]): Uint8Array => {
  let total = 0
  for (const p of parts) total += p.byteLength
  const out = new Uint8Array(total)
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.byteLength
  }
  return out
}

export class FlushQueue implements RecordSink {
  readonly #sessionId: string
  readonly #store: ChunkStore | null
  readonly #clock: ClockSource
  readonly #level: () => DetailLevel
  readonly #gzip: boolean
  readonly #maxPending: number
  readonly #onError: ((err: unknown) => void) | undefined

  #writer = new FrameWriter()
  #chain: Promise<unknown> = Promise.resolve()
  #reserved: number | undefined
  #reserving = false
  #memSeq: number
  #droppedRecords = 0
  #droppedChunks = 0
  #sealed = 0
  #skipRaw = false
  #lastSealReason: SealReason | undefined

  constructor(opts: FlushQueueOptions) {
    this.#sessionId = opts.sessionId
    this.#store = opts.store ?? null
    this.#clock = opts.clock ?? platformClock
    this.#level = opts.level ?? (() => 'baseline')
    this.#gzip = opts.gzip ?? true
    this.#maxPending = Math.max(1024, opts.maxPendingBytes ?? DEFAULT_MAX_PENDING)
    this.#onError = opts.onInternalError
    this.#memSeq = opts.startSegmentSeq ?? 0
    // Keep one allocated segment number in hand so the pagehide seal, which
    // cannot await, always has one.
    this.#prefetch()
  }

  /** Bytes buffered in the open frame stream, not counting the batch frame. */
  get pendingBytes(): number {
    return this.#writer.byteLength
  }

  get frameCount(): number {
    return this.#writer.frameCount
  }

  /**
   * Chunks that were sealed but will never reach ingest — an encode that failed
   * with records already taken out of the buffer. Feeds the terminal record's
   * `chunksDropped`; the store's own `evictedFifo` is the other half.
   */
  get droppedChunks(): number {
    return this.#droppedChunks
  }

  /** Records refused because the unsealed buffer was already at its cap. */
  get droppedRecords(): number {
    return this.#droppedRecords
  }

  get sealedChunks(): number {
    return this.#sealed
  }

  get lastSealReason(): SealReason | undefined {
    return this.#lastSealReason
  }

  json(r: EnvelopeRecord): void {
    if (this.#writer.byteLength >= this.#maxPending) {
      this.#droppedRecords += 1
      // A `ctrl`/`hdr` record is meaningless without the raw frame that follows
      // it, and the raw frame is unreadable without the record. Dropping one
      // means dropping the pair.
      this.#skipRaw = r.t === 'ctrl' || r.t === 'hdr'
      return
    }
    this.#skipRaw = false
    try {
      this.#writer.json(r)
    } catch (err) {
      this.#droppedRecords += 1
      this.#onError?.(err)
    }
  }

  raw(bytes: Uint8Array): void {
    if (this.#skipRaw) {
      this.#skipRaw = false
      this.#droppedRecords += 1
      return
    }
    try {
      this.#writer.raw(bytes)
    } catch (err) {
      this.#droppedRecords += 1
      this.#onError?.(err)
    }
  }

  /**
   * Seal the open frame stream into a keyed, persisted chunk.
   *
   * Serialised: two seals racing (the 60 s interval landing on a `stop()`, say)
   * must never be handed the same segment number, because two different bodies
   * under one idempotency key means ingest keeps one and silently discards the
   * other.
   *
   * Resolves `null` when there was nothing to seal.
   */
  seal(reason: SealReason): Promise<Chunk | null> {
    const run = this.#chain.then(
      () => this.#seal(reason),
      () => this.#seal(reason),
    )
    this.#chain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /**
   * The `pagehide` seal. The page may not survive a single `await`, so this
   * path takes no promise at all: the key comes from the synchronous fallback
   * (flagged `keyFallback`, because a fallback key has different collision
   * properties and ingest dedupes exactly) and the body is written
   * uncompressed, since `CompressionStream` is asynchronous by construction.
   *
   * Does not persist. There is no time to, and the bytes are going out now.
   */
  sealSync(reason: SealReason): Chunk | null {
    if (this.#writer.frameCount === 0) return null
    try {
      const frames = this.#writer.take()
      const seq = this.#allocSeqSync()
      const key = idempotencyKeySync(this.#sessionId, seq)
      const head = new FrameWriter()
      head.json(this.#batch(seq, key, true))
      const bytes = concat([
        writePreamble({ version: BODY_VERSION, gzipped: false }),
        head.take(),
        frames,
      ])
      this.#sealed += 1
      this.#lastSealReason = reason
      return {
        sessionId: this.#sessionId,
        segmentSeq: seq,
        idempotencyKey: key,
        createdWallMs: this.#clock.wall(),
        bytes,
        level: this.#level(),
        attempts: 0,
      }
    } catch (err) {
      this.#droppedChunks += 1
      this.#onError?.(err)
      return null
    }
  }

  async #seal(reason: SealReason): Promise<Chunk | null> {
    if (this.#writer.frameCount === 0) return null
    // Taken synchronously, before any await: records produced while the key is
    // being derived belong to the next chunk, not this one.
    const frames = this.#writer.take()
    try {
      const seq = await this.#allocSeq()
      const useSubtle = subtleAvailable()
      let key: string
      let fallback = false
      if (useSubtle) {
        try {
          key = await idempotencyKey(this.#sessionId, seq)
        } catch (err) {
          this.#onError?.(err)
          key = idempotencyKeySync(this.#sessionId, seq)
          fallback = true
        }
      } else {
        key = idempotencyKeySync(this.#sessionId, seq)
        fallback = true
      }
      const head = new FrameWriter()
      head.json(this.#batch(seq, key, fallback))
      const body = concat([head.take(), frames])
      const encoded = await encodeBody(body, { gzip: this.#gzip })
      const chunk: Chunk = {
        sessionId: this.#sessionId,
        segmentSeq: seq,
        idempotencyKey: key,
        createdWallMs: this.#clock.wall(),
        bytes: encoded.bytes,
        level: this.#level(),
        attempts: 0,
      }
      // Keyed, then persisted: the order that lets a reload dedupe rather than
      // deliver the same chunk twice.
      if (this.#store !== null) await this.#store.put(chunk)
      this.#sealed += 1
      this.#lastSealReason = reason
      return chunk
    } catch (err) {
      this.#droppedChunks += 1
      this.#onError?.(err)
      return null
    }
  }

  #batch(seq: number, key: string, fallback: boolean): BatchRecord {
    const base = {
      t: 'batch',
      ts: this.#clock.now(),
      lvl: this.#level(),
      sessionId: this.#sessionId,
      segmentSeq: seq,
      idempotencyKey: key,
      wall: this.#clock.wall(),
      v: 1,
    } as const
    // `exactOptionalPropertyTypes`: the flag is present only when true, so a
    // baseline body never carries a byte saying "not a fallback".
    return fallback ? { ...base, keyFallback: true } : base
  }

  async #allocSeq(): Promise<number> {
    const reserved = this.#reserved
    if (reserved !== undefined) {
      this.#reserved = undefined
      this.#memSeq = Math.max(this.#memSeq, reserved + 1)
      this.#prefetch()
      return reserved
    }
    if (this.#store !== null) {
      const seq = await this.#store.nextSegmentSeq(this.#sessionId)
      this.#memSeq = Math.max(this.#memSeq, seq + 1)
      this.#prefetch()
      return seq
    }
    return this.#memSeq++
  }

  #allocSeqSync(): number {
    const reserved = this.#reserved
    if (reserved !== undefined) {
      this.#reserved = undefined
      this.#memSeq = Math.max(this.#memSeq, reserved + 1)
      this.#prefetch()
      return reserved
    }
    const seq = this.#memSeq++
    // No reservation in hand and no time to await one. Push the persisted
    // counter past this number so a reload cannot reissue it; monotonic, so a
    // call that lands late is still safe.
    if (this.#store !== null) {
      void this.#store
        .raiseSegmentSeq(this.#sessionId, seq + 1)
        .catch((err: unknown) => this.#onError?.(err))
    }
    return seq
  }

  #prefetch(): void {
    if (this.#store === null || this.#reserved !== undefined || this.#reserving) return
    this.#reserving = true
    this.#store
      .nextSegmentSeq(this.#sessionId)
      .then((seq) => {
        this.#reserved = seq
        this.#memSeq = Math.max(this.#memSeq, seq + 1)
      })
      .catch((err: unknown) => this.#onError?.(err))
      .finally(() => {
        this.#reserving = false
      })
  }
}
