/**
 * The two varint families.
 *
 * The tests that matter here are not the happy-path ones. They are:
 *
 *  - the RFC 9000 reader given a real MoQT frame **succeeds and returns a
 *    different number**, which is the entire reason a mismatch refuses rather than
 *    falls back; and
 *  - `NEED` is the symbol `types.ts` declares, not a local one, because a second
 *    `Symbol('need')` would make every `=== NEED` across a module boundary
 *    silently false and every buffered prefix read as a decoded value.
 *
 * The frame under test is produced by `@moqtap/codec/draft20`'s own
 * `encodeMessage`, not typed out here, so the vector cannot drift from the codec
 * that will actually be parsing beside it.
 */

import { encodeMessage } from '@moqtap/codec/draft20'
import { describe, expect, it } from 'vitest'
import {
  NEED,
  RFC9000_READER,
  readRfc9000,
  readVi64,
  readVi64Draft17,
  VI64_D17_READER,
  VI64_READER,
} from '../../draft/varint.js'
import { NEED as NEED_FROM_TYPES } from '../../types.js'

/** A real draft-20 SETUP frame: type `0x2F00`, uint16 length 0, empty payload. */
const SETUP_FRAME = encodeMessage({ type: 'setup', options: {} })

function bytes(...v: number[]): Uint8Array {
  return Uint8Array.from(v)
}

describe('NEED', () => {
  it('is the symbol types.ts declares, not a second one', () => {
    expect(NEED).toBe(NEED_FROM_TYPES)
  })
})

describe('readVi64 — MoQT leading-1-bits, drafts 17+', () => {
  it('reads a real codec-encoded SETUP type as 0x2F00 in two bytes', () => {
    expect(Array.from(SETUP_FRAME.subarray(0, 2))).toEqual([0xaf, 0x00])
    const r = readVi64(SETUP_FRAME, 0)
    expect(r).not.toBe(NEED)
    if (r === NEED) return
    expect(r.value).toBe(0x2f00n)
    expect(r.next).toBe(2)
  })

  it('reads all five lengths', () => {
    // 1 byte: no leading ones, so seven value bits — 0b0xxxxxxx.
    expect(readVi64(bytes(0x25), 0)).toEqual({ value: 0x25n, next: 1 })
    // 2 bytes: 0b10xxxxxx.
    expect(readVi64(bytes(0xbf, 0xff), 0)).toEqual({ value: 0x3fffn, next: 2 })
    // 4 bytes: 0b1110xxxx.
    expect(readVi64(bytes(0xe1, 0x23, 0x45, 0x67), 0)).toEqual({ value: 0x1234567n, next: 4 })
    // 8 bytes: 0b11111110 — the first byte is prefix only.
    expect(readVi64(bytes(0xfe, 1, 2, 3, 4, 5, 6, 7), 0)).toEqual({
      value: 0x01020304050607n,
      next: 8,
    })
    // 9 bytes: 0xff escapes to a full unsigned 64-bit value.
    expect(readVi64(bytes(0xff, 255, 255, 255, 255, 255, 255, 255, 255), 0)).toEqual({
      value: 2n ** 64n - 1n,
      next: 9,
    })
  })

  it('accepts the seven-byte form, which draft-18 restored', () => {
    // Legal in 18, 19 and 20, which are the drafts this reader serves. draft-17
    // is the exception and has its own reader below.
    expect(readVi64(bytes(0xfd, 1, 2, 3, 4, 5, 6), 0)).toEqual({
      value: 0x01010203040506n,
      next: 7,
    })
  })

  it('accepts non-minimal encodings, which MoQT permits', () => {
    expect(readVi64(bytes(0x00), 0)).toEqual({ value: 0n, next: 1 })
    expect(readVi64(bytes(0x80, 0x00), 0)).toEqual({ value: 0n, next: 2 })
    expect(readVi64(bytes(0xc0, 0x00, 0x00), 0)).toEqual({ value: 0n, next: 3 })
    // Which is why a first-byte sniff cannot be authoritative: the same value
    // arrives with three different first bytes.
  })

  it('returns NEED for every incomplete encoding rather than a partial value', () => {
    expect(readVi64(bytes(), 0)).toBe(NEED)
    expect(readVi64(bytes(0xbf), 0)).toBe(NEED)
    expect(readVi64(bytes(0xe1, 0x23), 0)).toBe(NEED)
    expect(readVi64(bytes(0xfe, 1, 2, 3), 0)).toBe(NEED)
    expect(readVi64(bytes(0xff, 1, 2, 3, 4, 5, 6, 7), 0)).toBe(NEED)
    expect(readVi64(bytes(0x25), 1)).toBe(NEED)
    expect(readVi64(bytes(0x25), 99)).toBe(NEED)
  })

  it('reads from an offset without copying', () => {
    const b = bytes(0xff, 0xff, 0xbf, 0xff, 0x25)
    expect(readVi64(b, 2)).toEqual({ value: 0x3fffn, next: 4 })
    expect(readVi64(b, 4)).toEqual({ value: 0x25n, next: 5 })
  })
})

describe('readRfc9000 — RFC 9000 §16, drafts 07-16', () => {
  it('reads RFC 9000 Appendix A.1 vectors', () => {
    expect(readRfc9000(bytes(0xc2, 0x19, 0x7c, 0x5e, 0xff, 0x14, 0xe8, 0x8c), 0)).toEqual({
      value: 151288809941952652n,
      next: 8,
    })
    expect(readRfc9000(bytes(0x9d, 0x7f, 0x3e, 0x7d), 0)).toEqual({ value: 494878333n, next: 4 })
    expect(readRfc9000(bytes(0x7b, 0xbd), 0)).toEqual({ value: 15293n, next: 2 })
    expect(readRfc9000(bytes(0x25), 0)).toEqual({ value: 37n, next: 1 })
  })

  it('returns NEED for an incomplete encoding', () => {
    expect(readRfc9000(bytes(), 0)).toBe(NEED)
    expect(readRfc9000(bytes(0x9d, 0x7f), 0)).toBe(NEED)
    expect(readRfc9000(bytes(0xc2, 0x19, 0x7c), 0)).toBe(NEED)
  })
})

describe('the two families disagree on the same bytes, silently', () => {
  it('reads a real SETUP frame as a different number, with no error', () => {
    // The whole justification for withholding the adapter on a draft mismatch.
    const framed = new Uint8Array(8)
    framed.set(SETUP_FRAME, 0)
    framed.set([0xde, 0xad, 0xbe, 0xef], SETUP_FRAME.byteLength)

    const right = readVi64(framed, 0)
    const wrong = readRfc9000(framed, 0)
    expect(right).not.toBe(NEED)
    expect(wrong).not.toBe(NEED)
    if (right === NEED || wrong === NEED) return

    // Right: SETUP, two bytes consumed.
    expect(right.value).toBe(0x2f00n)
    expect(right.next).toBe(2)

    // Wrong: a plausible number, four bytes consumed — two of them belonging to
    // the length field that follows. No throw, no sentinel, nothing to detect.
    expect(wrong.value).toBe(0x2f000000n)
    expect(wrong.next).toBe(4)
    expect(wrong.value).not.toBe(right.value)
  })
})

describe('VarintReader wrappers', () => {
  it('expose the same behaviour as the free functions', () => {
    expect(VI64_READER.read(SETUP_FRAME, 0)).toEqual(readVi64(SETUP_FRAME, 0))
    expect(RFC9000_READER.read(SETUP_FRAME, 0)).toEqual(readRfc9000(SETUP_FRAME, 0))
    expect(VI64_READER.read(bytes(0xbf), 0)).toBe(NEED)
  })
})

describe('readVi64Draft17 — the one draft with no seven-byte form', () => {
  it('refuses `0b1111110x`, which draft-17 makes a protocol violation', () => {
    // draft-17 §1.4.1: "11111100 is an invalid code point. An endpoint that
    // receives this value MUST close the session with a PROTOCOL_VIOLATION."
    // draft-18 restored the length, so the same bytes are a legal 7-byte varint
    // one draft later — and the two readings differ by six bytes, which
    // desynchronises everything after it on the stream.
    expect(readVi64Draft17(bytes(0xfd, 1, 2, 3, 4, 5, 6), 0)).toBe(NEED)
    expect(readVi64Draft17(bytes(0xfc, 1, 2, 3, 4, 5, 6), 0)).toBe(NEED)
    // And the reader that serves 18-20 takes it, which is what makes the
    // refusal above a real difference rather than a stricter reading.
    expect(readVi64(bytes(0xfd, 1, 2, 3, 4, 5, 6), 0)).not.toBe(NEED)
  })

  it('agrees with the others on every length draft-17 does have', () => {
    for (const b of [
      bytes(0x25),
      bytes(0xbf, 0xff),
      bytes(0xc1, 0x23, 0x45),
      bytes(0xe1, 0x23, 0x45, 0x67),
      bytes(0xf1, 2, 3, 4, 5),
      bytes(0xf9, 1, 2, 3, 4, 5),
      bytes(0xfe, 1, 2, 3, 4, 5, 6, 7),
      bytes(0xff, 1, 2, 3, 4, 5, 6, 7, 8),
    ]) {
      expect(readVi64Draft17(b, 0)).toEqual(readVi64(b, 0))
    }
  })

  it('is what the draft-17 adapter actually carries', async () => {
    const mod = await import('../../drafts/draft17/index.js')
    expect(mod.adapter.varint).toBe(VI64_D17_READER)
    // The neighbours on either side do not, which is the point.
    const d18 = await import('../../drafts/draft18/index.js')
    expect(d18.adapter.varint).toBe(VI64_READER)
  })
})
