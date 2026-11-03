import {
  batchJson,
  CONTRACT_BODY_VERSION,
  preambleFrame,
  preambleFrameLength,
  rseqRanges,
} from '../envelope/contract.js'
import {
  BODY_PREAMBLE_BYTES,
  type DeflateSegment,
  FrameWriter,
  gzip,
  gzipSupported,
  idempotencyKey,
  joinSegment,
  readPreamble,
  splitFrames,
  writePreamble,
} from '../envelope/index.js'
import type { Taken } from '../rollup/runs.js'
import type { ClockSource, DetailLevel } from '../types.js'
import { type Emitter, encodeFacts, RECORD_BASE_US } from './emitter.js'
import { FrameBuffer, type FrameBufferOptions } from './frame-buffer.js'
import type { Chunk } from './idb.js'

/**
 * The flush buffer and the thing that seals it: records go in as frames, and a
 * **chunk** comes out — one self-contained, keyed v2 body.
 *
 * Sealing is not releasing. This class and `schedule.ts` decide only *when* a
 * chunk is sealed; `pacer.ts` decides how fast sealed chunks leave. If pressure
 * could stretch the sealing interval instead, the "a crash loses at most 60
 * seconds" bound would fail exactly when congestion makes a crash likely.
 *
 * **A seal is synchronous.** It takes the frames, takes the emitter's next
 * body number, derives the key, and returns the chunk, all in one turn. Compression and the IndexedDB copy come after, on
 * the chunk that already exists, so there is no moment at which a number is
 * taken and the body it names exists nowhere.
 *
 * A body is the 8-byte header, the uncompressed preamble `{v: 2, i, em, seal}`,
 * then the batch record and the buffered records, `run` and `mark` among
 * them, gzipped once that pays. The numbers are the emitter's, so a new
 * session continues them.
 */

export interface FlushQueueOptions extends Omit<FrameBufferOptions, 'rseq' | 'onRelease'> {
  readonly sessionId: string
  readonly emitter: Emitter
  /** The page's raw monotonic clock, ms, and wall time. */
  readonly clock?: ClockSource
  /** The level a record was produced at, for the batch record's `lvl`. Default `baseline`. */
  readonly level?: () => DetailLevel
  /** The seal interval in force, ms. */
  readonly sealMs?: () => number
  /** Records dropped on the device before encoding, cumulative. */
  readonly droppedRecords?: () => number
}

/** What a seal stamps on the batch frame besides the key. */
export interface SealOptions {
  /** The instance's last body. */
  readonly final?: boolean
}

/** The first `count` frames of the open stream, `bytes` long. */
export interface PackedFront {
  readonly bytes: number
  readonly count: number
}

/** The open stream's front, gzipped into `segment`. */
export interface PackedFrames extends PackedFront {
  readonly segment: DeflateSegment
}

const platformClock: ClockSource = {
  now: () => performance.now(),
  wall: () => Date.now(),
}

/** A body's preamble and its frames before the buffered ones. */
interface Head {
  readonly seq: number
  readonly key: string
  readonly preamble: Uint8Array
  readonly frames: Uint8Array
}

export class FlushQueue extends FrameBuffer {
  private readonly _sessionId: string
  private readonly _emitter: Emitter
  private readonly _clock: ClockSource
  private readonly _level: () => DetailLevel
  private readonly _sealMs: () => number
  private readonly _dropped: () => number

  constructor(opts: FlushQueueOptions) {
    super({
      ...opts,
      rseq: () => opts.emitter.takeRseq(),
      onRelease: (r) => opts.emitter.releaseTracks(r.ti),
    })
    this._sessionId = opts.sessionId
    this._emitter = opts.emitter
    this._clock = opts.clock ?? platformClock
    this._level = opts.level ?? (() => 'baseline')
    this._sealMs = opts.sealMs ?? (() => 60_000)
    this._dropped = opts.droppedRecords ?? (() => this.droppedRecords)
  }

  /** The number the next seal will take. Bodies so far are `0 … nextSeq - 1`. */
  get nextSeq(): number {
    return this._emitter.nextSeq
  }

  get instanceId(): string {
    return this._emitter.instanceId
  }

  /** Buffer runs and marks as records, numbered now. */
  writeFacts(t: Taken): void {
    if (t.runs.length === 0 && t.marks.length === 0) return
    this._emitter.noteTotals(t.runs)
    const f = encodeFacts(this._emitter, t)
    for (const r of f.records) this._emitter.retainTracks(r.refs.ti)
    this.facts(f)
  }

  /**
   * Seal the open frame stream into a keyed chunk, or return `null` when
   * there is nothing to seal, in which case no number is taken.
   *
   * The body is uncompressed and complete. It can be uploaded or beaconed as
   * it stands; {@link compress} replaces it with a smaller one when gzip pays.
   */
  seal(o: SealOptions = {}): Chunk | null {
    if (this.frameCount === 0) return null
    // Everything that could throw runs before the frames are taken, so a
    // failure leaves them buffered for the next seal rather than gone.
    const head = this._head(o, this.records)
    const { frames } = this.takeFrames()
    this._emitter.sweepClosed()
    return this._chunk(head, false, head.frames, frames)
  }

  /**
   * Seal the open stream's first frames, gzipped into `segment` and described
   * by `front`, into one keyed chunk, already compressed. The frames after
   * them stay open for the next seal, or with `rest` follow them in the body
   * uncompressed, which takes an {@link DeflateSegment.open | open} segment.
   */
  sealSegment(segment: DeflateSegment, o: SealOptions, front: PackedFront, rest = false): Chunk {
    if (!(front.bytes <= this.pendingBytes && front.count <= this.frameCount)) {
      throw new RangeError('front')
    }
    const head = this._head(o, rest ? this.records : this.recordsIn(front.bytes, front.count))
    const member = joinSegment(
      head.frames,
      segment,
      rest ? this.peek().subarray(front.bytes) : undefined,
    )
    if (rest) this.drop(this.pendingBytes, this.frameCount)
    else this.drop(front.bytes, front.count)
    if (this.frameCount === 0) this._emitter.sweepClosed()
    return this._chunk(head, true, member)
  }

  /**
   * Seal the stream's first frames, up to about `most` bytes, cut in front of
   * a JSON frame, like {@link seal}; the rest stay open. `null` when there is
   * nothing to seal.
   */
  sealFront(most: number, o: SealOptions = {}): Chunk | null {
    if (this.pendingBytes <= most) return this.seal(o)
    const span = splitFrames(this.peek(), this.frameCount, most, 1)[0]
    if (span === undefined || span.count === this.frameCount) return this.seal(o)
    const n = span.bytes.byteLength
    const head = this._head(o, this.recordsIn(n, span.count))
    const chunk = this._chunk(head, false, head.frames, span.bytes)
    this.drop(n, span.count)
    if (this.frameCount === 0) this._emitter.sweepClosed()
    return chunk
  }

  /** Number and key a body of the first `records` buffered records, and build its preamble and batch. */
  private _head(o: SealOptions, records: number): Head {
    const e = this._emitter
    const fromUs = e.throughUs
    const throughUs = Math.max(fromUs, Math.floor(this._clock.now() * 1000))
    const refs = this.refsOf(records)
    e.sealThrough(throughUs)
    const seq = e.takeSeq()
    const key = idempotencyKey(this._sessionId, e.instanceId, seq)
    const sample = e.clock.latest()
    const w = new FrameWriter({ initialBytes: 512 })
    w.json(
      batchJson({
        sessionId: this._sessionId,
        instanceId: e.instanceId,
        seq,
        idempotencyKey: key,
        final: o.final === true,
        lvl: this._level(),
        clk: {
          baseUs: RECORD_BASE_US,
          epoch: e.clock.epoch,
          resUs: e.clock.resUs,
          ...(sample !== undefined ? { sample } : {}),
        },
        tail: {
          ...(e.lastRseq !== undefined ? { lastRseq: e.lastRseq } : {}),
          preDrop: { records: this._dropped(), objects: e.droppedObjects },
          conn: e.tailConns(),
        },
        conn: e.bodyConns(refs.c),
        trk: e.bodyTracks(refs.ti),
      }),
    )
    const preamble = preambleFrame({
      i: e.instanceId,
      em: rseqRanges(this.rseqsOf(records)),
      seal: { seq, fromUs, throughUs, ms: this._sealMs() },
    })
    return { seq, key, preamble, frames: w.take() }
  }

  private _chunk(head: Head, gzipped: boolean, ...parts: Uint8Array[]): Chunk {
    let length = BODY_PREAMBLE_BYTES + head.preamble.byteLength
    for (const p of parts) length += p.byteLength
    const bytes = new Uint8Array(length)
    bytes.set(writePreamble({ version: CONTRACT_BODY_VERSION, gzipped }), 0)
    let at = BODY_PREAMBLE_BYTES
    bytes.set(head.preamble, at)
    at += head.preamble.byteLength
    for (const p of parts) {
      bytes.set(p, at)
      at += p.byteLength
    }
    return {
      sessionId: this._sessionId,
      instanceId: this._emitter.instanceId,
      seq: head.seq,
      idempotencyKey: head.key,
      createdWallMs: this._clock.wall(),
      bytes,
      level: this._level(),
      attempts: 0,
    }
  }
}

/**
 * Replace a sealed chunk's body with its gzipped form when that is smaller.
 * The preamble stays uncompressed; a body sealed already compressed is left
 * as it is.
 *
 * After the seal, never inside it: `CompressionStream` is asynchronous, and the
 * chunk is already numbered, keyed and in the outbox. Both forms carry the same
 * frames under the same key, so whichever one an upload happens to send, ingest
 * decodes the same body. Never rejects.
 */
export async function compress(chunk: Chunk): Promise<void> {
  const head = readPreamble(chunk.bytes)
  if (head === null || head.gzipped || !gzipSupported()) return
  const pre = preambleFrameLength(chunk.bytes, BODY_PREAMBLE_BYTES)
  if (pre < 0) return
  const at = BODY_PREAMBLE_BYTES + pre
  const frames = chunk.bytes.subarray(at)
  let z: Uint8Array
  try {
    z = await gzip(frames)
  } catch {
    return
  }
  if (z.byteLength >= frames.byteLength) return
  const out = new Uint8Array(at + z.byteLength)
  out.set(chunk.bytes.subarray(0, at), 0)
  out.set(writePreamble({ version: head.version, gzipped: true }), 0)
  out.set(z, at)
  chunk.bytes = out
}
