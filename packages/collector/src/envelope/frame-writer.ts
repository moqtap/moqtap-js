/**
 * The frame stream, and the type tag the envelope format forgot.
 *
 * The spec interleaves JSON records and raw byte records, each framed as
 * `[u32 len][payload]`, with **no way for a reader to tell which is which**. The
 * `n` field on the JSON record is never defined and its uses in the sketch are
 * not consistent with any single reading, so it cannot be the discriminator.
 *
 * **Resolved: bit 31 of the length prefix. Set = raw bytes, clear = JSON.** The
 * flag lives in `types.ts` as {@link FRAME_RAW_FLAG} so the writer here and every
 * reader elsewhere cannot drift. Frame lengths are `< 2^31` by construction — a
 * batch seals at ~32 KB and a beacon caps near 64 KB — so bit 31 was free. A
 * length-of-zero sentinel would not have worked: an empty raw frame is legal and
 * must stay distinguishable from an empty JSON one.
 *
 * The prefix is **big-endian**, matching MoQT's own control framing (`varint
 * type` + `uint16 BE length`) so nothing in this codebase has to remember which
 * of two endiannesses applies where.
 *
 * Two properties the rest of the package leans on, both tested:
 *
 *  - **Frame streams concatenate.** `take() ++ take()` parses as one stream,
 *    which is what lets the flush module prepend the mandatory first
 *    `BatchRecord` frame at seal time — when the idempotency key finally exists,
 *    `crypto.subtle` being async — with a `Uint8Array.set` instead of a
 *    re-encode.
 *  - **Raw frames are copies.** `StreamChunk.data` is a borrowed view onto the
 *    page's own buffer, valid only for the duration of the callback; the page
 *    may write through the same `ArrayBuffer` on its next frame. A retained view
 *    would silently rewrite already-encoded history.
 *
 * Never base64: it inflates 33% before compression and gzip cannot recover it on
 * high-entropy header bytes.
 */

import { MQ2001, MQ2002, MQ2003, MQ2004 } from '../codes.js'
import { type EnvelopeRecord, FRAME_LENGTH_MASK, FRAME_RAW_FLAG } from '../types.js'
import { BODY_MAGIC } from './body.js'

/** Bytes of the big-endian `u32` length-and-flag prefix in front of every frame. */
const PREFIX_BYTES = 4

/**
 * Largest payload one frame can carry, since bit 31 is the type tag. Nothing in
 * this package approaches it: a seal happens at ~32 KB and the beacon caps near
 * 64 KB. The guard turns a bug elsewhere into a throw rather than a frame whose
 * length silently reads as `raw`.
 */
const MAX_FRAME_BYTES = FRAME_LENGTH_MASK

const DEFAULT_INITIAL_BYTES = 4096

const ENCODER = new TextEncoder()

/**
 * Accumulates frames into one contiguous buffer.
 *
 * Not a stream: streaming request bodies are refused on every browser, so
 * a body is always built whole and then handed to `encodeBody`. Growth is
 * amortised doubling, which for a 32 KB seal from a 4 KB start is three
 * reallocations per batch.
 */
export class FrameWriter {
  #buf: Uint8Array
  #view: DataView
  #len = 0
  #frames = 0
  readonly #initialBytes: number

  constructor(opts?: { initialBytes?: number }) {
    const requested = opts?.initialBytes
    this.#initialBytes =
      requested !== undefined && requested > 0 ? Math.ceil(requested) : DEFAULT_INITIAL_BYTES
    this.#buf = new Uint8Array(this.#initialBytes)
    this.#view = new DataView(this.#buf.buffer)
  }

  /** Bytes written so far — prefixes included, so it is directly comparable to the 32 KB. */
  get byteLength(): number {
    return this.#len
  }

  get frameCount(): number {
    return this.#frames
  }

  /**
   * One JSON frame. Length prefix has bit 31 **clear**.
   *
   * Throws — atomically — if the record cannot be stringified. `JSON.stringify`
   * throws on a `bigint`, which is why `RollupTrackWire.key.v` is a decimal
   * string and not a number, and a half-written frame would desynchronise every
   * byte after it. The payload is encoded completely before the buffer is
   * touched, so a throw leaves the writer byte for byte as it was and the caller
   * can carry on with the frames already accumulated.
   */
  json(record: EnvelopeRecord): void {
    const payload = ENCODER.encode(JSON.stringify(record))
    this.#frame(payload, false)
  }

  /**
   * One raw frame. Length prefix has bit 31 **set**. The bytes are copied.
   *
   * Raw and never base64. Must be preceded in the same body by the JSON
   * record that describes it (`ctrl`, `hdr`) — a raw frame alone is unreadable
   * — which is `RecordSink`'s contract, not something this writer can check.
   */
  raw(bytes: Uint8Array): void {
    this.#frame(bytes, true)
  }

  /**
   * The frames, with no preamble, and reset.
   *
   * The returned view owns its buffer outright: the writer allocates a fresh
   * one, so later frames cannot rewrite bytes a caller is still holding — or
   * still compressing, since `encodeBody` reads asynchronously.
   *
   * It is a view, not a trimmed copy, so the buffer behind it may be up to twice
   * as long as the frames. Deliberate: what gets persisted and uploaded is
   * `encodeBody`'s output, allocated at exactly the body's size, so nothing pays
   * for the slack in IndexedDB or on the wire.
   */
  take(): Uint8Array {
    const out = this.#buf.subarray(0, this.#len)
    this.#buf = new Uint8Array(this.#initialBytes)
    this.#view = new DataView(this.#buf.buffer)
    this.#len = 0
    this.#frames = 0
    return out
  }

  #frame(payload: Uint8Array, raw: boolean): void {
    if (payload.length > MAX_FRAME_BYTES) {
      throw new RangeError(`${MQ2001}: ${payload.length}`)
    }
    this.#reserve(PREFIX_BYTES + payload.length)
    // `>>> 0` because JavaScript's bitwise operators coerce to int32: with bit 31
    // set, `payload.length | FRAME_RAW_FLAG` is negative and `setUint32` would be
    // handed a negative number. It writes the same four bytes only by accident,
    // and every reader has to do the same to get the length back out.
    const prefix = raw ? (payload.length | FRAME_RAW_FLAG) >>> 0 : payload.length
    this.#view.setUint32(this.#len, prefix, false)
    this.#buf.set(payload, this.#len + PREFIX_BYTES)
    this.#len += PREFIX_BYTES + payload.length
    this.#frames++
  }

  #reserve(n: number): void {
    const need = this.#len + n
    if (need <= this.#buf.length) return
    let cap = this.#buf.length || DEFAULT_INITIAL_BYTES
    while (cap < need) cap *= 2
    const next = new Uint8Array(cap)
    next.set(this.#buf.subarray(0, this.#len))
    this.#buf = next
    this.#view = new DataView(next.buffer)
  }
}

/**
 * Walk a frame stream.
 *
 * `body` is the **decompressed frames**, with no preamble — what
 * `FrameWriter.take()` produced, or what is left of a POST body after
 * `readPreamble` and, if its flag says so, gunzip.
 *
 * `payload` is a **view** into `body`, not a copy: a reader that keeps one past
 * the iteration must copy it. Nothing on the collector's own path reads frames
 * back — this is the reference decoder ingest, the tests and anyone debugging a
 * body share, and it lives beside the writer so the two ends of a format with a
 * one-bit tag cannot drift apart.
 *
 * Throws on a truncated or malformed stream rather than yielding what it has.
 * Each POST is a complete, self-contained frame stream, so a frame never
 * straddles a body and a partial one means the body is damaged: discardable
 * whole, and quietly returning its readable prefix would let damaged data
 * through.
 */
export function* readFrames(body: Uint8Array): Generator<{ raw: boolean; payload: Uint8Array }> {
  if (startsWithBodyMagic(body)) {
    throw new RangeError(MQ2002)
  }
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength)
  let i = 0
  while (i < body.length) {
    if (body.length - i < PREFIX_BYTES) {
      throw new RangeError(`${MQ2003}: ${i} ${body.length - i}`)
    }
    const prefix = view.getUint32(i, false)
    const raw = (prefix & FRAME_RAW_FLAG) !== 0
    const length = (prefix & FRAME_LENGTH_MASK) >>> 0
    i += PREFIX_BYTES
    if (body.length - i < length) {
      throw new RangeError(`${MQ2004}: ${i} ${length} ${body.length - i}`)
    }
    yield { raw, payload: body.subarray(i, i + length) }
    i += length
  }
}

/**
 * A frame stream can never begin with the body magic: `4d 51 54 43` reads as a
 * JSON frame 1,297,175,619 B long, orders of magnitude past anything this
 * package seals. So the check is unambiguous, and it turns the one mistake a
 * reader of this format will actually make — passing a body with its preamble
 * still on — into a diagnosis.
 */
function startsWithBodyMagic(body: Uint8Array): boolean {
  if (body.length < BODY_MAGIC.length) return false
  for (let i = 0; i < BODY_MAGIC.length; i++) {
    if (body[i] !== BODY_MAGIC[i]) return false
  }
  return true
}
