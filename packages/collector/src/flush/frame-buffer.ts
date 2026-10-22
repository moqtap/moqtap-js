import { FrameWriter } from '../envelope/frame-writer.js'
import type { EnvelopeRecord, RecordSink } from '../types.js'

/**
 * A capped, unsealed frame stream: records go in as frames and come out as
 * bytes, unnumbered and unkeyed.
 *
 * This is all a worker's probe needs, so it lives apart from the sealing in
 * `queue.ts`. Keying a body means SHA-256, and a worker entry that reached
 * the seal would ship the hash to every worker that never uses it.
 */

export interface FrameBufferOptions {
  /**
   * Hard cap on the unsealed frame stream. Without it the buffer is unbounded
   * between takes, and a session whose seals are failing grows until the tab
   * dies, taking the page with it. Over the cap it drops and says so.
   * Default: eight times the 32 KB threshold.
   */
  readonly maxPendingBytes?: number
  readonly onInternalError?: (err: unknown) => void
}

const DEFAULT_MAX_PENDING = 8 * 32 * 1024

export class FrameBuffer implements RecordSink {
  private readonly _maxPending: number
  private readonly _onError: ((err: unknown) => void) | undefined

  private _writer = new FrameWriter()
  private _droppedRecords = 0
  private _skipRaw = false

  constructor(opts: FrameBufferOptions = {}) {
    this._maxPending = Math.max(1024, opts.maxPendingBytes ?? DEFAULT_MAX_PENDING)
    this._onError = opts.onInternalError
  }

  /** Bytes buffered in the open frame stream, not counting the batch frame. */
  get pendingBytes(): number {
    return this._writer.byteLength
  }

  get frameCount(): number {
    return this._writer.frameCount
  }

  /** Records refused because the buffer was already at its cap. */
  get droppedRecords(): number {
    return this._droppedRecords
  }

  json(r: EnvelopeRecord): void {
    if (this._writer.byteLength >= this._maxPending) {
      this._droppedRecords += 1
      // A `ctrl` record is meaningless without the raw frame that follows it,
      // and the raw frame is unreadable without the record. Dropping one means
      // dropping the pair.
      this._skipRaw = r.t === 'ctrl'
      return
    }
    this._skipRaw = false
    try {
      this._writer.json(r)
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
   * Whole frames a worker encoded, appended without parsing.
   *
   * Refused whole when they would take the buffer past its cap: splitting them
   * could separate a `ctrl` record from its raw frame. Returns whether they
   * were taken, so the caller can count the refused records as dropped.
   */
  append(frames: Uint8Array, count: number): boolean {
    if (count === 0) return true
    if (this._writer.byteLength + frames.byteLength > this._maxPending) return false
    this._writer.append(frames, count)
    return true
  }

  /** The frames so far, as a view the next write may overwrite. Nothing is reset. */
  peek(): Uint8Array {
    return this._writer.peek()
  }

  /**
   * The buffered frames and how many there are, unsealed and unnumbered, and
   * reset. A worker's probe hands these to its page, which seals them.
   */
  takeFrames(): { readonly frames: Uint8Array; readonly count: number } {
    const count = this._writer.frameCount
    return { frames: this._writer.take(), count }
  }

  /** The buffer behind frames {@link takeFrames} returned, which nothing reads any more. */
  recycle(frames: Uint8Array): void {
    this._writer.recycle(frames)
  }
}
