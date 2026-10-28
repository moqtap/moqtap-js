/**
 * Control-plane detection at the transport seam.
 *
 * **Control-plane detection is not `bidi`.** From draft-17 the MoQT control
 * plane is a *pair of unidirectional streams*, so the boolean the seam gets for
 * free — which queue the stream arrived on — misfiles the ENTIRE control plane
 * as bulk media on every draft this package supports (19 and 20). The correct
 * test is `bidi === true || opensUniControlStream(firstChunk)`, which is exactly
 * {@link isControlPlane}.
 *
 * The prefix is SETUP's message type `0x2F00` written in MoQT's own leading-ones
 * varint (draft-17 §1.4.1): `af 00`. `6f 00` is what an RFC 9000 varint would
 * produce for the same number, and reading it the wrong way round yields a
 * *plausible number* rather than an error — which is why getting this wrong is
 * silent. `extension/src/detect/uni-control-prefix.ts` hard-codes `6f 00` in an
 * untested second copy of the constant, so no draft-17+ control stream matches
 * there and the whole SETUP exchange is filed as bulk media.
 *
 * That file also opens with `if (!(data instanceof ArrayBuffer)) return false`
 * while the hook feeding it hands out `Uint8Array` (`webtransport-hook.ts`).
 * This version accepts both — and, because `instanceof` is false across realms
 * (an iframe's buffer, a page-supplied chunk), falls back to the brand checks
 * that do survive a realm boundary.
 */

/**
 * The two bytes a draft-17+ unidirectional control stream opens with: SETUP's
 * type `0x2F00` in MoQT's leading-ones varint.
 *
 * Drafts <= 16 do not need this — their control stream is bidirectional, so
 * `bidi` already identifies it and no unidirectional control stream exists.
 */
export const UNI_CONTROL_STREAM_PREFIX: readonly [0xaf, 0x00] = [0xaf, 0x00]

/**
 * A byte view over `data`, whatever flavour of buffer the page handed us.
 *
 * `instanceof` is deliberately not the only test. A chunk written by code in
 * another realm — an iframe, a same-origin window, a bundled worker shim — has
 * different `Uint8Array` and `ArrayBuffer` intrinsics, so `instanceof` is false
 * for a perfectly ordinary buffer. `ArrayBuffer.isView` is a brand check and
 * survives that; `Object.prototype.toString` reads `Symbol.toStringTag` and
 * survives it for plain `ArrayBuffer`s.
 *
 * Returns `null` rather than throwing: every argument here came from
 * page-controlled code.
 */
export function toBytes(data: unknown): Uint8Array | null {
  try {
    if (data instanceof Uint8Array) return data
    if (ArrayBuffer.isView(data)) {
      return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    }
    if (data instanceof ArrayBuffer) return new Uint8Array(data)
    if (data && typeof data === 'object' && isArrayBufferBrand(data)) {
      return new Uint8Array(data as ArrayBuffer)
    }
    return null
  } catch {
    // A detached buffer throws on view construction. Not our problem to report.
    return null
  }
}

function isArrayBufferBrand(v: object): boolean {
  const tag = Object.prototype.toString.call(v)
  return tag === '[object ArrayBuffer]' || tag === '[object SharedArrayBuffer]'
}

/**
 * Whether a stream's first bytes are a draft-17+ SETUP — that is, whether this
 * unidirectional stream is half of the control plane.
 *
 * Accepts `Uint8Array` as well as `ArrayBuffer`, which is the whole point: the
 * seam produces `Uint8Array`, and the extension's version rejects it.
 */
export function opensUniControlStream(data: Uint8Array | ArrayBuffer): boolean {
  const head = toBytes(data)
  if (!head || head.length < UNI_CONTROL_STREAM_PREFIX.length) return false
  return head[0] === UNI_CONTROL_STREAM_PREFIX[0] && head[1] === UNI_CONTROL_STREAM_PREFIX[1]
}

/**
 * The test, entire: `msg.bidi === true || opensUniControlStream(msg.data)`.
 *
 * NOT `bidi` alone. A bidirectional stream is control on every draft (07-16 put
 * the control plane there outright; 17+ open one bidi stream per request, which
 * is still control traffic and never bulk media). A unidirectional stream is
 * control only when it opens `af 00`.
 *
 * `firstChunk` must be the stream's FIRST bytes: only the first chunk may
 * decide, and a later chunk that happens to start `af 00` is object payload, not
 * a SETUP. Callers should use `StreamRegistry.classify`, which keeps that
 * decision sticky.
 */
export function isControlPlane(bidi: boolean, firstChunk: Uint8Array): boolean {
  return bidi === true || opensUniControlStream(firstChunk)
}
