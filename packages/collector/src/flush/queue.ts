import {
  BODY_PREAMBLE_BYTES,
  BODY_VERSION,
  encodeBody,
  FrameWriter,
  idempotencyKey,
  writePreamble,
} from '../envelope/index.js'
import type { BatchRecord, ClockSource, DetailLevel, EnvelopeRecord, RecordSink } from '../types.js'
import type { Chunk } from './idb.js'

/**
 * The flush buffer and the thing that seals it: records go in as frames, and a
 * **chunk** comes out — one self-contained, keyed body.
 *
 * Sealing is not releasing. This class and `schedule.ts` decide only *when* a
 * chunk is sealed; `pacer.ts` decides how fast sealed chunks leave. If pressure
 * could stretch the sealing interval instead, the "a crash loses at most 60
 * seconds" bound would fail exactly when congestion makes a crash likely.
 *
 * **A seal is synchronous.** It takes the frames, takes the next sequence
 * number only if there were frames, derives the key, and returns the chunk, all
 * in one turn. Compression and the IndexedDB copy come after, on the chunk that
 * already exists, so there is no moment at which a number is taken and the body
 * it names exists nowhere: the page can die at any `await` and every number it
 * handed out belongs to a body in its outbox.
 *
 * The sequence is this instance's own and lives in memory. Every reload or tab
 * is a new instance with a new id, so the key `sha256(sessionId:instanceId:seq)`
 * cannot repeat without anything being persisted or reserved.
 */

export interface FlushQueueOptions {
  readonly sessionId: string
  readonly instanceId: string
  /**
   * Session-relative monotonic time and wall time. `now()` must already be
   * relative to the session anchor: every `ts` in the envelope is
   * `ClockAnchor.originMono`-relative and nothing downstream re-bases it.
   */
  readonly clock?: ClockSource
  /** The level a record was produced at, for `BatchRecord.lvl`. Default `baseline`. */
  readonly level?: () => DetailLevel
  /**
   * Hard cap on the unsealed frame stream. Without it the buffer is unbounded
   * between seals, and a session whose seals are failing grows until the tab
   * dies, taking the page with it. Over the cap it drops and says so.
   * Default: eight times the 32 KB threshold.
   */
  readonly maxPendingBytes?: number
  readonly onInternalError?: (err: unknown) => void
}

/** What a seal stamps on the batch frame besides the key. */
export interface SealOptions {
  /** The instance's last body. */
  readonly final?: boolean
  /** Bodies of this instance known never to arrive. */
  readonly lost?: readonly number[]
  /** Records dropped on the device so far. */
  readonly dropped?: number
}

const DEFAULT_MAX_PENDING = 8 * 32 * 1024

const platformClock: ClockSource = {
  now: () => performance.now(),
  wall: () => Date.now(),
}

export class FlushQueue implements RecordSink {
  readonly #sessionId: string
  readonly #instanceId: string
  readonly #clock: ClockSource
  readonly #level: () => DetailLevel
  readonly #maxPending: number
  readonly #onError: ((err: unknown) => void) | undefined

  #writer = new FrameWriter()
  #seq = 0
  #droppedRecords = 0
  #skipRaw = false

  constructor(opts: FlushQueueOptions) {
    this.#sessionId = opts.sessionId
    this.#instanceId = opts.instanceId
    this.#clock = opts.clock ?? platformClock
    this.#level = opts.level ?? (() => 'baseline')
    this.#maxPending = Math.max(1024, opts.maxPendingBytes ?? DEFAULT_MAX_PENDING)
    this.#onError = opts.onInternalError
  }

  /** Bytes buffered in the open frame stream, not counting the batch frame. */
  get pendingBytes(): number {
    return this.#writer.byteLength
  }

  get frameCount(): number {
    return this.#writer.frameCount
  }

  /** The number the next seal with frames will take. Bodies so far are `0 … nextSeq - 1`. */
  get nextSeq(): number {
    return this.#seq
  }

  /** Records refused because the unsealed buffer was already at its cap. */
  get droppedRecords(): number {
    return this.#droppedRecords
  }

  json(r: EnvelopeRecord): void {
    if (this.#writer.byteLength >= this.#maxPending) {
      this.#droppedRecords += 1
      // A `ctrl` record is meaningless without the raw frame that follows it,
      // and the raw frame is unreadable without the record. Dropping one means
      // dropping the pair.
      this.#skipRaw = r.t === 'ctrl'
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
   * Whole frames a worker encoded, appended without parsing.
   *
   * Refused whole when they would take the buffer past its cap: splitting them
   * could separate a `ctrl` record from its raw frame. Returns whether they
   * were taken, so the caller can count the refused records as dropped.
   */
  append(frames: Uint8Array, count: number): boolean {
    if (count === 0) return true
    if (this.#writer.byteLength + frames.byteLength > this.#maxPending) return false
    this.#writer.append(frames, count)
    return true
  }

  /**
   * The buffered frames and how many there are, unsealed and unnumbered, and
   * reset. A worker's probe hands these to its page, which seals them.
   */
  takeFrames(): { readonly frames: Uint8Array; readonly count: number } {
    const count = this.#writer.frameCount
    return { frames: this.#writer.take(), count }
  }

  /**
   * Seal the open frame stream into a keyed chunk, or return `null` when there
   * is nothing to seal, in which case no number is taken.
   *
   * The body is uncompressed and complete: preamble, batch frame, records. It
   * can be uploaded or beaconed as it stands; {@link compress} replaces it with
   * a smaller one when gzip pays.
   */
  seal(o: SealOptions = {}): Chunk | null {
    if (this.#writer.frameCount === 0) return null
    const seq = this.#seq
    // Everything that could throw runs before the frames are taken, so a
    // failure leaves them buffered for the next seal rather than gone.
    const key = idempotencyKey(this.#sessionId, this.#instanceId, seq)
    const head = new FrameWriter({ initialBytes: 512 })
    head.json(this.#batch(seq, key, o))
    const batch = head.take()
    const frames = this.#writer.take()
    this.#seq = seq + 1
    const bytes = new Uint8Array(BODY_PREAMBLE_BYTES + batch.byteLength + frames.byteLength)
    bytes.set(writePreamble({ version: BODY_VERSION, gzipped: false }), 0)
    bytes.set(batch, BODY_PREAMBLE_BYTES)
    bytes.set(frames, BODY_PREAMBLE_BYTES + batch.byteLength)
    return {
      sessionId: this.#sessionId,
      instanceId: this.#instanceId,
      seq,
      idempotencyKey: key,
      createdWallMs: this.#clock.wall(),
      bytes,
      level: this.#level(),
      attempts: 0,
    }
  }

  #batch(seq: number, key: string, o: SealOptions): BatchRecord {
    const base = {
      t: 'batch',
      ts: this.#clock.now(),
      lvl: this.#level(),
      v: 2,
      sessionId: this.#sessionId,
      instanceId: this.#instanceId,
      seq,
      idempotencyKey: key,
      wall: this.#clock.wall(),
      dropped: o.dropped ?? 0,
    } as const
    // Present only when set, so an ordinary body carries no bytes for either.
    return {
      ...base,
      ...(o.final === true ? { final: true as const } : {}),
      ...(o.lost !== undefined && o.lost.length > 0 ? { lost: [...o.lost] } : {}),
    }
  }
}

/**
 * Replace a sealed chunk's body with its gzipped form when that is smaller.
 *
 * After the seal, never inside it: `CompressionStream` is asynchronous, and the
 * chunk is already numbered, keyed and in the outbox. Both forms carry the same
 * frames under the same key, so whichever one an upload happens to send, ingest
 * decodes the same body. Never rejects.
 */
export async function compress(chunk: Chunk): Promise<void> {
  const encoded = await encodeBody(chunk.bytes.subarray(BODY_PREAMBLE_BYTES))
  if (encoded.gzipped) chunk.bytes = encoded.bytes
}
