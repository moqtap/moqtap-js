/**
 * The control plane, framed by hand.
 *
 * Every message on a control or request stream is
 * `Message Type + Message Length + Message Body` in every draft this package
 * supports, the Length a varint in 07-10, 16 bits in 11-22 (draft-20 §10,
 * Figure 3) and a vi64 from draft-23 (Section 9, Figure 6). **That shape is
 * the entire reason this file exists**: the framer can measure a frame it
 * cannot decode, so an unknown or extension codepoint is counted, shipped raw
 * and skipped rather than ending the control plane for the session.
 *
 * The codec's own `createStreamDecoder` cannot do that: it calls
 * `controller.error()` on `UNKNOWN_MESSAGE_TYPE` (`drafts/draft20/codec.ts`),
 * which permanently kills control-plane decoding for the connection. Control
 * bytes are the *only* thing ingest reparses to recover track names, namespaces
 * and statuses, so losing the control plane loses every name in the session —
 * over one codepoint a peer is allowed to send.
 *
 * A control stream carries no stream-type prefix of its own. draft-20 §3.3: each
 * peer opens one unidirectional control stream "beginning with a SETUP message",
 * and a request stream "begins with one of these seven message types" — so byte
 * zero of both is already the first message's Type field. (SETUP's `0x2F00` is
 * `af 00` in MoQT's vi64, which is what the seam sniffs a uni control stream by;
 * `6f 00` is what RFC 9000 would produce for the same number, and reading it the
 * wrong way round yields a plausible number rather than an error.)
 *
 * One framer per stream **per direction**: a bidirectional request stream has
 * two independent byte streams under one stream id, and feeding both into one
 * framer desynchronises it on the first response.
 */

import type { ControlRedaction, CountingSink, Direction, DraftAdapter, Mono } from '../types.js'
import { NEED } from '../types.js'

/**
 * The largest frame the wire can express through draft-22, and therefore the
 * buffering bound.
 *
 * The Message Length field is a fixed **16 bits**, so a frame is at most
 * `9 (the longest vi64 type) + 2 + 65535` bytes, and the format itself bounds
 * the buffering. Unlike a data stream's payload, a control frame may be held —
 * it has to be, since ingest needs the exact bytes and a partial frame is not a
 * frame.
 */
export const MAX_CONTROL_FRAME_BYTES = 9 + 2 + 0xffff

/**
 * From draft-23 the receiver's MAX_CONTROL_MESSAGE_SIZE bounds the body
 * instead. draft-23 Section 9.1.8: "The value is encoded as a variable-length
 * integer and MUST be at least 65535. If not present, the default value is
 * 65535." Shared by the framers of one direction, and raised by the dispatcher
 * when the receiving endpoint's SETUP states more.
 */
export interface ControlLimit {
  maxBodyBytes: number
}

/** A vi64 type, a vi64 length, and the body. */
const frameBound = (l: ControlLimit) => 9 + 9 + l.maxBodyBytes

/**
 * Hand-rolled control framing over an arriving byte stream.
 *
 * Every complete frame is handed to the sink as its exact bytes — type field
 * through payload end — whether or not it decoded.
 */
export class ControlFramer {
  /**
   * An incomplete frame carried across a chunk boundary, and nothing else: its
   * first {@link held} bytes. Grown by doubling, and never written over once a
   * frame has been handed on from it.
   */
  private carry: Uint8Array | null = null
  private held = 0
  private dead = false
  private closed = false
  private count = 0
  private undecoded = 0
  private redacted = 0
  private unmaskable = 0
  private redactionFailed = 0

  constructor(
    private readonly dir: Direction,
    private readonly streamId: number,
    private readonly adapter: DraftAdapter,
    private readonly sink: CountingSink,
    /**
     * `privacy.maskAuthParams`. **Defaults to on when omitted**, so a caller
     * that forgets to thread the config through gets the safe behaviour rather
     * than the leaky one.
     */
    private readonly mask = true,
    /** Present from draft-23, for frames travelling in `dir`. */
    private readonly limit?: ControlLimit,
  ) {}

  /** Frames completed on this stream so far. */
  get frameCount(): number {
    return this.count
  }

  /** Frames that were counted and skipped rather than decoded. */
  get undecodedCount(): number {
    return this.undecoded
  }

  /** Authorization Token values overwritten on this stream. */
  get redactedCount(): number {
    return this.redacted
  }

  /**
   * Frames the mask could not check, because the message did not parse.
   *
   * Not a failure: an unknown or extension codepoint is something a peer may
   * send, and this file exists precisely so one of those does not end the
   * control plane. But its parameters were never walked, so its bytes went out
   * unexamined. Counted so the residual in the masking guarantee is a number.
   */
  get unmaskableCount(): number {
    return this.unmaskable
  }

  /** Frames dropped because the mask reported a span it could not apply. */
  get redactionFailureCount(): number {
    return this.redactionFailed
  }

  /** Bytes held across a chunk boundary: never above the frame bound. */
  get bufferedBytes(): number {
    return this.carry === null ? 0 : this.held
  }

  /** True once the stream was abandoned as unframeable. */
  get failed(): boolean {
    return this.dead
  }

  push(chunk: Uint8Array, at: Mono): void {
    if (this.dead || this.closed || chunk.length === 0) return

    let carry = this.carry
    let buf: Uint8Array
    if (carry === null) {
      buf = chunk
    } else {
      const n = this.held + chunk.length
      if (n > carry.length) {
        const grown = new Uint8Array(Math.max(n, carry.length * 2))
        grown.set(carry.subarray(0, this.held), 0)
        carry = grown
        this.carry = grown
      }
      carry.set(chunk, this.held)
      buf = carry.subarray(0, n)
    }

    const bound = this.limit === undefined ? MAX_CONTROL_FRAME_BYTES : frameBound(this.limit)
    let i = 0
    while (i < buf.length) {
      // Per draft, not inline: the length field is a varint in drafts 07-10
      // and from 23, and a 16-bit big-endian field in 11-22, and reading one as
      // the other mis-frames every control message on the session rather than
      // failing.
      const end = this.adapter.controlFrameEnd(buf, i)
      if (end === NEED) break
      // Refused on its declared length, before any of it is held. draft-23
      // Section 9: "If an endpoint receives a control message with a length
      // larger than its MAX_CONTROL_MESSAGE_SIZE, it MUST close the session
      // with FIELD_LENGTH_EXCEEDED."
      if (end - i > bound) {
        this.fail()
        return
      }
      if (end > buf.length) break
      // A borrowed view, exactly as `ControlFrameEvent.bytes` documents: the
      // sink copies if it retains, and the baseline sink writes it straight
      // into a frame buffer that copies.
      this.emit(buf.subarray(i, end), at)
      i = end
    }

    if (i >= buf.length) {
      this.carry = null
      this.held = 0
      return
    }
    const tail = buf.subarray(i)
    if (tail.length > bound) {
      // Reached only by a varint length too large to read (drafts 07-10 and
      // from 23); a readable one over the bound was refused above. This is the
      // bound that stops a bad or hostile length from buffering the page to
      // death, and "bounded" has to be true of the code and not only of the
      // format.
      this.fail()
      return
    }
    if (carry !== null && i === 0) {
      // Still the one incomplete frame, already in place.
      this.held = buf.length
      return
    }
    // Copy: `chunk` is a borrowed view onto the page's own buffer and the page
    // may write through it on its next frame (`StreamChunk.data`); frames
    // already handed on from the old carry keep it unchanged.
    this.carry = tail.slice()
    this.held = tail.length
  }

  /**
   * The stream ended.
   *
   * A residue is **not** a parse failure. A reset or a close truncates a
   * perfectly well-formed frame stream, and counting that as a decode fault puts
   * a normal event in the field that exists to find real ones.
   */
  end(): void {
    this.closed = true
    this.carry = null
    this.held = 0
  }

  private emit(raw: Uint8Array, at: Mono): void {
    this.count++

    // Mask BEFORE decoding. The one pass that reads a Token Value
    // happens inside the codec and its output is thrown away; everything from
    // here on — the decoded message, the envelope, the sink — sees only the
    // redacted bytes, so no structure this package builds can contain a token.
    let frame = raw
    if (this.mask) {
      let r: ControlRedaction
      try {
        r = this.adapter.redactAuthTokens(raw)
      } catch {
        // The adapter's contract says it never throws; this is the belt to that
        // brace. Unlike the one around `decodeControl` it cannot carry on: a
        // mask that threw did not mask, and continuing would ship the frame in
        // the clear. A broken mask must lose data, never leak a token.
        r = { bytes: raw, redacted: 0, incomplete: true, decoded: false }
      }
      if (r.incomplete) {
        // Our offsets and the frame disagree — a defect here, not something the
        // peer did. A token was seen and its position is not trusted, so the
        // frame's bytes are dropped rather than shipped unvouched. Its own
        // reason code, so it cannot hide among malformed peers.
        this.redactionFailed++
        this.sink.onParseFailure(null, 'redaction-failed')
        return
      }
      frame = r.bytes
      this.redacted += r.redacted
      if (!r.decoded) this.unmaskable++
    }

    let value = null
    try {
      value = this.adapter.decodeControl(frame).value
    } catch {
      // The adapter's contract says it never throws; this is the belt to that
      // brace, because a throw here would land in the page's own stack.
      value = null
    }
    this.sink.onControlFrame({
      dir: this.dir,
      streamId: this.streamId,
      at,
      bytes: frame,
      message: value,
    })
    if (value === null) {
      this.undecoded++
      // The frame was well formed enough to measure and hand on; the *body* is
      // what failed. `DecodedControl` reports one null for both an unknown
      // codepoint and a malformed payload, so the two cannot be told apart here.
      this.sink.onParseFailure(null, 'unknown-message-type')
    }
  }

  private fail(): void {
    this.dead = true
    this.carry = null
    this.held = 0
    this.sink.onParseFailure(null, 'malformed-control')
  }
}
