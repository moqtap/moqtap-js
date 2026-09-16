/**
 * Overwriting Authorization Token values at the point of parse.
 *
 * A collector that ships a customer's control plane verbatim is useful — the
 * control plane is the part of a session a player library cannot misreport —
 * right up until it also ships the bearer token sitting in a SETUP option or a
 * SUBSCRIBE parameter. At that point a debugging tool has become a
 * credential-exfiltration path.
 *
 * The fix has to happen **where the parse happens**, not on the way out. Bytes
 * that were merely *masked before upload* still sat in memory in a form a later
 * feature — a dump, an export, a bug — could reach. So this module hangs off
 * the decoders themselves: the one pass that reads a Token Value is the pass
 * that records where it was, and the value is overwritten before the frame is
 * handed to anything that retains it.
 *
 * ── What is overwritten, and what deliberately is not
 *
 * Only the **Token Value** (draft-20 Section 10.2.2, Figure 5). The Alias Type,
 * the Token Alias and the Token Type all stay:
 *
 *  - the parameter's *presence* distinguishes a session that failed to
 *    authenticate from one that never tried, and losing that distinction blinds
 *    the tool at exactly the moment it is most wanted;
 *  - the Token Alias is how you see the same credential being reused across
 *    messages, which is a real debugging signal and is not itself a secret;
 *  - `USE_ALIAS` and `DELETE` carry no value at all, so those frames pass
 *    through untouched and it is visible that they did.
 *
 * The overwrite is **length-preserving**. That is not an aesthetic choice: a
 * control frame carries a fixed 16-bit Message Length, and every offset a
 * caller has already computed into the frame stays valid only if the frame does
 * not change size. Preserving the length also preserves the fact that a token
 * of *some* size was sent.
 *
 * ── Why a span sink and not a return value
 *
 * A Token Value is read in `decodeParams` and `decodeSetupOptions`, which sit
 * under a dozen per-message payload decoders per draft. Threading a redaction
 * channel out through all of them would mean changing every one of those
 * signatures, in every draft, to carry something almost none of them use.
 *
 * The sink is module state, which is safe here for one specific reason and it
 * is worth being explicit about it: **decoding is synchronous and single
 * threaded, and no decoder re-enters the redactor.** {@link redactWith} opens
 * the capture, runs one decode to completion, and closes it in a `finally`.
 * There is no `await` between those points, so no second capture can interleave
 * with the first.
 *
 * Spec of record: `wt-logging-1-collector.md` Section 1.6.
 */

/**
 * The byte written over a redacted Token Value.
 *
 * Zero, so that a redacted frame is obviously not a token rather than
 * plausibly one. A caller who needs to tell "redacted" from "the peer really
 * sent zeros" has {@link AuthRedaction.redacted}, which counts what was
 * overwritten.
 */
export const REDACTION_FILL = 0x00

/**
 * The result of a redaction pass over one control frame.
 */
export interface AuthRedaction {
  /**
   * The frame with every Token Value overwritten, exactly as long as the input.
   *
   * When nothing needed redacting this is the **same reference** as the input,
   * so the common case costs no copy. Callers that retain it must copy for the
   * same reason they would have had to copy the input.
   */
  readonly bytes: Uint8Array
  /** How many Token Values were overwritten. */
  readonly redacted: number
  /**
   * A span was recorded that could not be applied to the frame.
   *
   * This means the offset arithmetic and the frame disagree, which is a defect
   * rather than a wire condition. **A caller must not treat {@link bytes} as
   * clean when this is set** — the safe response is to drop the frame's raw
   * bytes rather than ship them, because the one thing that is certain is that
   * a token was seen and its position is not trusted.
   */
  readonly incomplete: boolean
  /**
   * Whether the message parsed all the way through.
   *
   * A frame can be perfectly legitimate and still not decode: an unknown or
   * extension message codepoint is something a peer is allowed to send, and a
   * collector ships those raw on purpose rather than losing the whole control
   * plane over one of them. But a message that cannot be parsed is a message
   * whose parameters cannot be walked, so `redacted === 0` on such a frame
   * means "nothing was found", not "there is nothing there".
   *
   * That residual is narrow and it is real, and the only dishonest thing to do
   * with it is hide it. Count the frames where this is false, so the gap in the
   * guarantee is a number somebody can look at.
   */
  readonly decoded: boolean
}

/**
 * Payload-relative `[start, length]` pairs, flat. `null` when not capturing —
 * which is the state every ordinary decode runs in, so the recording hook costs
 * one null check on a path that is otherwise untouched.
 */
let spans: number[] | null = null

/**
 * Record that a Token Value occupies `length` bytes at `start`, measured from
 * the beginning of the **payload** the current decoder is reading.
 *
 * Called from the draft decoders. A zero-length value records nothing: there is
 * nothing to overwrite, and a zero-length span would only inflate the count.
 */
export function recordAuthValueSpan(start: number, length: number): void {
  if (spans === null || length <= 0) return
  spans.push(start, length)
}

/**
 * Run `decode` with span capture suspended.
 *
 * For decoders that read a parameter block out of a **nested** buffer — draft-20's
 * `FILL_PARAMETERS` is the case that exists today. Offsets recorded inside a
 * nested reader are relative to that reader, and applying them to the outer
 * payload would overwrite unrelated bytes: not a failed redaction but a
 * corrupted frame, and a silent one. Scope rules already forbid an
 * AUTHORIZATION_TOKEN inside FILL_PARAMETERS, so this guards against a future
 * nesting rather than a present one — which is exactly when it is cheap to add.
 */
export function withoutAuthValueSpans<T>(decode: () => T): T {
  const saved = spans
  spans = null
  try {
    return decode()
  } finally {
    spans = saved
  }
}

/**
 * Decode `frame` once, capturing Token Value spans, and return the frame with
 * those values overwritten.
 *
 * `payloadStart` is where the message payload begins inside the frame; the
 * spans the decoders record are payload-relative, and this is what makes them
 * frame-relative. `decode` may fail — a malformed message decodes partially and
 * throws or returns an error — and **spans recorded before it failed are still
 * applied**, because a value that was read is a value that was exposed
 * regardless of what happened afterwards.
 *
 * `decode` reports whether it parsed the whole message; a throw counts as no.
 */
export function redactWith(
  frame: Uint8Array,
  payloadStart: number,
  decode: () => boolean,
): AuthRedaction {
  const outer = spans
  spans = []
  let captured: number[]
  let decoded = false
  try {
    decoded = decode()
  } catch {
    // The caller's decoder threw. Whatever it recorded before it did is real.
  } finally {
    captured = spans
    spans = outer
  }

  if (captured.length === 0) return { bytes: frame, redacted: 0, incomplete: false, decoded }

  let out: Uint8Array | null = null
  let redacted = 0
  let incomplete = false
  for (let i = 0; i < captured.length; i += 2) {
    const start = payloadStart + (captured[i] as number)
    const length = captured[i + 1] as number
    if (payloadStart < 0 || start < 0 || start + length > frame.length) {
      incomplete = true
      continue
    }
    if (out === null) out = frame.slice()
    out.fill(REDACTION_FILL, start, start + length)
    redacted++
  }
  return { bytes: out ?? frame, redacted, incomplete, decoded }
}
