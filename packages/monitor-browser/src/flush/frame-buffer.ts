import { withRseq } from '../envelope/contract.js'
import { FrameWriter } from '../envelope/frame-writer.js'
import {
  type EnvelopeRecord,
  FRAME_LENGTH_MASK,
  FRAME_RAW_FLAG,
  type RecordSink,
} from '../types.js'
import type { EncodedFacts, RecordRefs } from './emitter.js'

/**
 * A capped, unsealed frame stream: records go in as frames and come out as
 * bytes, unsealed and unkeyed.
 *
 * In the page every record is numbered as it goes in: `rseq` is its last
 * field, taken from the emitter, and its bytes never change after. A worker's
 * probe buffers its records unnumbered; the page numbers them as it appends
 * them. Keying a body means SHA-256, and a worker entry that reached the seal
 * would ship the hash to every worker that never uses it, so sealing lives in
 * `queue.ts`.
 */

export interface FrameBufferOptions {
  /**
   * Hard cap on the unsealed frame stream. Without it the buffer is unbounded
   * between takes, and a session whose seals are failing grows until the tab
   * dies, taking the page with it. Over the cap it drops and says so.
   * Default: eight times the 32 KB threshold. A function is read at every
   * write, for a buffer whose cap follows the detail level.
   */
  readonly maxPendingBytes?: number | (() => number)
  readonly onInternalError?: (err: unknown) => void
  /** Numbers each record. Absent in a worker's probe, whose page numbers them. */
  readonly rseq?: () => number
  /** A `run` or `mark` record left the buffer. */
  readonly onRelease?: (refs: RecordRefs) => void
}

const DEFAULT_MAX_PENDING = 8 * 32 * 1024

export class FrameBuffer implements RecordSink {
  private readonly _maxPending: () => number
  private readonly _onError: ((err: unknown) => void) | undefined
  private readonly _rseq: (() => number) | undefined
  private readonly _onRelease: ((refs: RecordRefs) => void) | undefined

  private _writer = new FrameWriter()
  private _droppedRecords = 0
  private _skipRaw = false
  private _takes = 0
  /** The rseq of each buffered record, in order. */
  private _rseqs: number[] = []
  /** The tracks and connections each buffered `run` or `mark` names; `null` for any other record. */
  private _refs: (RecordRefs | null)[] = []

  constructor(opts: FrameBufferOptions = {}) {
    const cap = opts.maxPendingBytes ?? DEFAULT_MAX_PENDING
    this._maxPending =
      typeof cap === 'number' ? () => Math.max(1024, cap) : () => Math.max(1024, cap())
    this._onError = opts.onInternalError
    this._rseq = opts.rseq
    this._onRelease = opts.onRelease
  }

  /** Bytes buffered in the open frame stream, not counting the batch frame. */
  get pendingBytes(): number {
    return this._writer.byteLength
  }

  get frameCount(): number {
    return this._writer.frameCount
  }

  /**
   * How many times frames have left the front of the buffer. A copy of the
   * frames is still the buffer's front while this is unchanged.
   */
  get takes(): number {
    return this._takes
  }

  /** Records refused because the buffer was already at its cap. */
  get droppedRecords(): number {
    return this._droppedRecords
  }

  json(r: EnvelopeRecord): void {
    if (this._writer.byteLength >= this._maxPending()) {
      this._droppedRecords += 1
      // A `ctrl` record is meaningless without the raw frame that follows it,
      // and the raw frame is unreadable without the record. Dropping one means
      // dropping the pair.
      this._skipRaw = r.t === 'ctrl'
      return
    }
    this._skipRaw = false
    try {
      if (this._rseq === undefined) this._writer.json(r)
      else {
        const rseq = this._rseq()
        this._writer.json({ ...r, rseq } as EnvelopeRecord)
        this._rseqs.push(rseq)
        this._refs.push(null)
      }
    } catch (err) {
      this._droppedRecords += 1
      this._onError?.(err)
    }
  }

  raw(bytes: Uint8Array): void {
    if (this._skipRaw) {
      this._skipRaw = false
      this._droppedRecords += 1
      return
    }
    try {
      this._writer.raw(bytes)
    } catch (err) {
      this._droppedRecords += 1
      this._onError?.(err)
    }
  }

  /**
   * Whole frames a worker encoded, appended and, in the page, numbered.
   *
   * Refused whole when they would take the buffer past its cap: splitting them
   * could separate a `ctrl` record from its raw frame. Returns whether they
   * were taken, so the caller can count the refused records as dropped.
   */
  append(frames: Uint8Array, count: number): boolean {
    if (count === 0) return true
    if (this._writer.byteLength + frames.byteLength > this._maxPending()) return false
    if (this._rseq === undefined) {
      this._writer.append(frames, count)
      return true
    }
    let at = 0
    const view = new DataView(frames.buffer, frames.byteOffset, frames.byteLength)
    for (let i = 0; i < count; i++) {
      const prefix = view.getUint32(at, false)
      const n = (prefix & FRAME_LENGTH_MASK) >>> 0
      const frame = frames.subarray(at, at + 4 + n)
      if ((prefix & FRAME_RAW_FLAG) !== 0) this._writer.append(frame, 1)
      else {
        const rseq = this._rseq()
        this._writer.append(numbered(frame, rseq), 1)
        this._rseqs.push(rseq)
        this._refs.push(null)
      }
      at += 4 + n
    }
    return true
  }

  /**
   * `run` and `mark` records, already numbered. Never refused for the cap:
   * the run recorder's own flow cap bounds them, and nothing stands in for
   * an arrival a dropped run would lose.
   */
  facts(f: EncodedFacts): void {
    if (f.count === 0) return
    this._writer.append(f.frames, f.count)
    for (const r of f.records) {
      this._rseqs.push(r.rseq)
      this._refs.push(r.refs)
    }
  }

  /** The frames so far, as a view the next write may overwrite. Nothing is reset. */
  peek(): Uint8Array {
    return this._writer.peek()
  }

  /** How many records the first `count` frames, `bytes` long, hold. */
  recordsIn(bytes: number, count: number): number {
    return recordsIn(this.peek().subarray(0, bytes), count)
  }

  /** The rseqs of the first `n` buffered records. */
  rseqsOf(n: number): number[] {
    return this._rseqs.slice(0, n)
  }

  /** The tracks and connections the first `n` buffered records name. */
  refsOf(n: number): { ti: Set<number>; c: Set<number> } {
    const ti = new Set<number>()
    const c = new Set<number>()
    for (let i = 0; i < n && i < this._refs.length; i++) {
      const r = this._refs[i]
      if (r == null) continue
      for (const x of r.ti) ti.add(x)
      for (const x of r.c) c.add(x)
    }
    return { ti, c }
  }

  /** How many records are buffered. */
  get records(): number {
    return this._rseqs.length
  }

  /**
   * The buffered frames and how many there are, unsealed, and reset. A
   * worker's probe hands these to its page, which seals them.
   */
  takeFrames(): { readonly frames: Uint8Array; readonly count: number } {
    const count = this._writer.frameCount
    this._takes += 1
    this._release(this._refs)
    this._rseqs = []
    this._refs = []
    return { frames: this._writer.take(), count }
  }

  /** Remove the first `count` frames, `bytes` long, which the caller has sealed. */
  protected drop(bytes: number, count: number): void {
    const records = recordsIn(this.peek().subarray(0, bytes), count)
    this._writer.drop(bytes, count)
    this._rseqs.splice(0, records)
    this._release(this._refs.splice(0, records))
    this._takes += 1
  }

  private _release(refs: readonly (RecordRefs | null)[]): void {
    const f = this._onRelease
    if (f === undefined) return
    for (const r of refs) if (r !== null) f(r)
  }

  /** The buffer behind frames {@link takeFrames} returned, which nothing reads any more. */
  recycle(frames: Uint8Array): void {
    this._writer.recycle(frames)
  }
}

/** One JSON frame with `rseq` as its record's last field. */
function numbered(frame: Uint8Array, rseq: number): Uint8Array {
  const payload = withRseq(frame.subarray(4), rseq)
  const out = new Uint8Array(4 + payload.byteLength)
  new DataView(out.buffer).setUint32(0, payload.byteLength, false)
  out.set(payload, 4)
  return out
}

/** How many of the first `count` frames of `bytes` are records rather than raw. */
function recordsIn(bytes: Uint8Array, count: number): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let at = 0
  let n = 0
  for (let i = 0; i < count && at + 4 <= bytes.byteLength; i++) {
    const prefix = view.getUint32(at, false)
    if ((prefix & FRAME_RAW_FLAG) === 0) n += 1
    at += 4 + ((prefix & FRAME_LENGTH_MASK) >>> 0)
  }
  return n
}
