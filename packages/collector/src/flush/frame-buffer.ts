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
  readonly #maxPending: number
  readonly #onError: ((err: unknown) => void) | undefined

  #writer = new FrameWriter()
  #droppedRecords = 0
  #skipRaw = false

  constructor(opts: FrameBufferOptions = {}) {
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

  /** Records refused because the buffer was already at its cap. */
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

  /** The frames so far, as a view the next write may overwrite. Nothing is reset. */
  peek(): Uint8Array {
    return this.#writer.peek()
  }

  /**
   * The buffered frames and how many there are, unsealed and unnumbered, and
   * reset. A worker's probe hands these to its page, which seals them.
   */
  takeFrames(): { readonly frames: Uint8Array; readonly count: number } {
    const count = this.#writer.frameCount
    return { frames: this.#writer.take(), count }
  }

  /** The buffer behind frames {@link takeFrames} returned, which nothing reads any more. */
  recycle(frames: Uint8Array): void {
    this.#writer.recycle(frames)
  }
}
