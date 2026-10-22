import {
  BODY_PREAMBLE_BYTES,
  BODY_VERSION,
  type DeflateSegment,
  encodeBody,
  FrameWriter,
  idempotencyKey,
  joinSegment,
  readPreamble,
  writePreamble,
} from '../envelope/index.js'
import type { BatchRecord, ClockSource, DetailLevel } from '../types.js'
import { FrameBuffer, type FrameBufferOptions } from './frame-buffer.js'
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

export interface FlushQueueOptions extends FrameBufferOptions {
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

const platformClock: ClockSource = {
  now: () => performance.now(),
  wall: () => Date.now(),
}

export class FlushQueue extends FrameBuffer {
  readonly #sessionId: string
  readonly #instanceId: string
  readonly #clock: ClockSource
  readonly #level: () => DetailLevel

  #seq = 0

  constructor(opts: FlushQueueOptions) {
    super(opts)
    this.#sessionId = opts.sessionId
    this.#instanceId = opts.instanceId
    this.#clock = opts.clock ?? platformClock
    this.#level = opts.level ?? (() => 'baseline')
  }

  /** The number the next seal with frames will take. Bodies so far are `0 … nextSeq - 1`. */
  get nextSeq(): number {
    return this.#seq
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
    if (this.frameCount === 0) return null
    const seq = this.#seq
    // Everything that could throw runs before the frames are taken, so a
    // failure leaves them buffered for the next seal rather than gone.
    const key = idempotencyKey(this.#sessionId, this.#instanceId, seq)
    const head = new FrameWriter({ initialBytes: 512 })
    head.json(this.#batch(seq, key, o))
    const batch = head.take()
    const { frames } = this.takeFrames()
    this.#seq = seq + 1
    const bytes = new Uint8Array(BODY_PREAMBLE_BYTES + batch.byteLength + frames.byteLength)
    bytes.set(writePreamble({ version: BODY_VERSION, gzipped: false }), 0)
    bytes.set(batch, BODY_PREAMBLE_BYTES)
    bytes.set(frames, BODY_PREAMBLE_BYTES + batch.byteLength)
    return this.#chunk(seq, key, bytes)
  }

  /**
   * Seal the open frame stream and `segment` behind it into one keyed chunk,
   * already compressed. `segment` is frames another realm gzipped, so the
   * body ends with them; the open frames go in uncompressed, and the caller
   * keeps them few. Always takes a number: the segment is never empty.
   */
  sealSegment(segment: DeflateSegment, o: SealOptions = {}): Chunk {
    const seq = this.#seq
    const key = idempotencyKey(this.#sessionId, this.#instanceId, seq)
    const head = new FrameWriter({ initialBytes: 512 + this.pendingBytes })
    head.json(this.#batch(seq, key, o))
    head.append(this.peek(), this.frameCount)
    const member = joinSegment(head.take(), segment)
    this.takeFrames()
    this.#seq = seq + 1
    const bytes = new Uint8Array(BODY_PREAMBLE_BYTES + member.byteLength)
    bytes.set(writePreamble({ version: BODY_VERSION, gzipped: true }), 0)
    bytes.set(member, BODY_PREAMBLE_BYTES)
    return this.#chunk(seq, key, bytes)
  }

  #chunk(seq: number, key: string, bytes: Uint8Array): Chunk {
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
 * A body sealed already compressed is left as it is.
 *
 * After the seal, never inside it: `CompressionStream` is asynchronous, and the
 * chunk is already numbered, keyed and in the outbox. Both forms carry the same
 * frames under the same key, so whichever one an upload happens to send, ingest
 * decodes the same body. Never rejects.
 */
export async function compress(chunk: Chunk): Promise<void> {
  if (readPreamble(chunk.bytes)?.gzipped === true) return
  const encoded = await encodeBody(chunk.bytes.subarray(BODY_PREAMBLE_BYTES))
  if (encoded.gzipped) chunk.bytes = encoded.bytes
}
