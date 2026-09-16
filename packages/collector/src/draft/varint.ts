/**
 * The two varint families, hand-written.
 *
 * The two encodings **disagree on the same bytes**, so reading with the wrong
 * one does not fail loudly — it returns a plausible wrong number.
 *
 * Worked example, the one that matters here. SETUP's control message type is
 * `0x2F00`. In MoQT's leading-1-bits form that is `af 00`; in RFC 9000's
 * 2-bit-prefix form the same value is `6f 00`. Feed `af 00` to an RFC 9000
 * reader and it reads prefix `0b10` — a **four**-byte varint — swallowing two
 * bytes that belong to the next field and yielding `0x2F00xxxx`. No error, no
 * exception, just a number. That is why {@link loadDraft} refuses to hand out
 * an adapter when the pin and the negotiated protocol disagree.
 *
 * Why these are re-implemented rather than imported: `MoqtBufferReader` is
 * exported from no public `@moqtap/codec` subpath — its `exports` map has
 * entries for `.`, `./session` and `./draftNN[/session]` and nothing for
 * `./core`. The only reachable copy is behind the root entry, which statically
 * imports all fourteen drafts at 39.6 KB gz against 5.3 KB for one draft.
 * Twenty lines is the cheaper of the two.
 *
 * These readers are incremental: they take a buffer and an offset, they never
 * throw, and they return {@link NEED} — imported from `types.ts`, never
 * re-declared — when the buffer holds a legal *prefix* they cannot yet
 * complete. A partial value is never returned, because a partial value read as
 * a whole one is the same silent failure with extra steps.
 */

import { NEED, type Need, type VarintReader } from '../types.js'

export type { Need }
export { NEED }

/** A decoded varint and the offset just past it. */
export interface VarintValue {
  readonly value: bigint
  /** Offset of the first byte after the encoding. */
  readonly next: number
}

/**
 * MoQT's leading-1-bits vi64 — drafts 17 and later.
 *
 * The count of leading 1 bits in the first byte gives `length - 1`; the
 * remaining bits of that byte are the high bits of the value, and each
 * following byte contributes eight more. `0xff` is the escape: a full unsigned
 * 64-bit value in the eight bytes after it, nine bytes in total.
 *
 * Transcribed from `MoqtBufferReader.readVarInt` in
 * `packages/codec/src/core/buffer-reader.ts`. See {@link readVi64Draft17} for
 * the one draft that reads it differently.
 */
export function readVi64(b: Uint8Array, i: number): VarintValue | Need {
  return vi64(b, i, true)
}

/**
 * draft-17's vi64, which has no seven-byte form.
 *
 * draft-17 §1.4.1: *"11111100 is an invalid code point. An endpoint that
 * receives this value MUST close the session with a PROTOCOL_VIOLATION."*
 * draft-18 restored the length, and the codec models the difference as
 * `Draft17BufferReader` overriding `allowSevenByte`.
 *
 * A conforming draft-17 peer never sends one, so this exists for the peer that
 * is not conforming — and there the two readings diverge by six bytes, which
 * desynchronises the rest of the stream. Reading it as a length this draft does
 * not have would produce exactly the plausible wrong number the package refuses
 * to emit, so it returns {@link NEED} instead and the stream is declared
 * desynchronised at the caller's slack cap.
 */
export function readVi64Draft17(b: Uint8Array, i: number): VarintValue | Need {
  return vi64(b, i, false)
}

function vi64(b: Uint8Array, i: number, allowSevenByte: boolean): VarintValue | Need {
  const first = b[i]
  if (first === undefined) return NEED

  if (first === 0xff) {
    if (i + 9 > b.length) return NEED
    let value = 0n
    for (let k = 1; k < 9; k++) value = (value << 8n) | BigInt(b[i + k] as number)
    return { value, next: i + 9 }
  }

  let leadingOnes = 0
  while (leadingOnes < 8 && (first & (0x80 >> leadingOnes)) !== 0) leadingOnes++
  const length = leadingOnes + 1
  if (length === 7 && !allowSevenByte) return NEED
  if (i + length > b.length) return NEED

  let value = BigInt(first & ((1 << (8 - length)) - 1))
  for (let k = 1; k < length; k++) value = (value << 8n) | BigInt(b[i + k] as number)
  return { value, next: i + length }
}

/**
 * RFC 9000 the variable-length integer — drafts 07 through 16.
 *
 * The top two bits of the first byte are `log2(length)`; the remaining six are
 * the high bits of the value.
 *
 * Ten of the fourteen supported drafts read every field with this, and it is the
 * older half of the pair the whole refusal exists for: the two families
 * **disagree on the same bytes** and the loser returns a plausible wrong number
 * rather than an error. Transcribed from `BufferReader.readVarInt` in
 * `core/buffer-reader.ts`.
 */
export function readRfc9000(b: Uint8Array, i: number): VarintValue | Need {
  const first = b[i]
  if (first === undefined) return NEED

  const length = 1 << (first >> 6)
  if (i + length > b.length) return NEED

  let value = BigInt(first & 0x3f)
  for (let k = 1; k < length; k++) value = (value << 8n) | BigInt(b[i + k] as number)
  return { value, next: i + length }
}

/** The reader drafts 18, 19 and 20 use, as a {@link VarintReader}. */
export const VI64_READER: VarintReader = /*#__PURE__*/ Object.freeze({ read: readVi64 })

/** draft-17's reader, one length short of the others. See {@link readVi64Draft17}. */
export const VI64_D17_READER: VarintReader = /*#__PURE__*/ Object.freeze({
  read: readVi64Draft17,
})

/** The reader drafts 07-16 use. See {@link readRfc9000} for why it is here. */
export const RFC9000_READER: VarintReader = /*#__PURE__*/ Object.freeze({ read: readRfc9000 })
