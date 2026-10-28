import { describe, expect, it } from 'vitest'
import {
  decodeObjectProperties as decode09,
  encodeObjectProperties as encode09,
} from '../drafts/draft09/data-streams.js'
import {
  decodeObjectProperties as decode14,
  encodeObjectProperties as encode14,
} from '../drafts/draft14/data-streams.js'
import {
  decodeObjectProperties as decode22,
  encodeObjectProperties as encode22,
} from '../drafts/draft22/data-streams.js'
import { bytesToHex, hexToBytes } from './helpers.js'

describe('decodeObjectProperties', () => {
  it('reports each property with its offset and length in the block', () => {
    // 0x0d (odd, 2 bytes cafe), then 0x3c = 2 as delta 0x2f
    const r = decode22(hexToBytes('0d02cafe2f02'))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.map((p) => [p.type, p.offset, p.length])).toEqual([
      [0x0dn, 0, 4],
      [0x3cn, 4, 2],
    ])
    expect(bytesToHex(r.value[0]!.bytes!)).toBe('cafe')
    expect(r.value[1]!.value).toBe(2n)
  })

  it('returns an odd value as a view into the block, not a copy', () => {
    const block = hexToBytes('0d02cafe')
    const r = decode22(block)
    if (!r.ok) throw r.error
    expect(r.value[0]!.bytes!.buffer).toBe(block.buffer)
  })

  it('keeps a repeated type as two entries', () => {
    const r = decode22(hexToBytes('0d01aa0001bb'))
    if (!r.ok) throw r.error
    expect(r.value.map((p) => bytesToHex(p.bytes!))).toEqual(['aa', 'bb'])
  })

  it('decodes Immutable Properties with offsets from the outer block', () => {
    const r = decode22(hexToBytes('0b023c02'))
    if (!r.ok) throw r.error
    const [imm] = r.value
    expect(imm!.type).toBe(0x0bn)
    expect(imm!.properties).toEqual([{ type: 0x3cn, offset: 2, length: 2, value: 2n }])
  })

  it('refuses Immutable Properties inside Immutable Properties', () => {
    expect(decode22(hexToBytes('0b020b00')).ok).toBe(false)
  })

  it('refuses a property that runs past the block', () => {
    const r = decode22(hexToBytes('0d05ca'))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('CONSTRAINT_VIOLATION')
  })

  it('refuses a block cut inside a varint', () => {
    // 0x3c with a two-byte varint value of which only the first byte is present
    const r = decode22(hexToBytes('3c80'))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('CONSTRAINT_VIOLATION')
  })

  it('refuses a value longer than 2^16-1 bytes where the draft caps it', () => {
    // Length 65536 as a MoQT varint: 0xc1 0x00 0x00. No value bytes follow; the
    // length is refused before the block's end is.
    const r = decode22(hexToBytes('0dc10000'))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.message).toMatch(/more than the 65535 allowed/)
  })

  it('refuses a delta that carries the type past 2^64 - 1', () => {
    // 0x3c = 1, then a nine-byte delta of 2^64 - 1
    const r = decode22(hexToBytes('3c01ffffffffffffffffff01'))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.message).toMatch(/exceeds 2\^64 - 1/)
  })

  it('reads types as absolute before draft-16', () => {
    // Two properties of type 0x3c: under delta encoding the second would be 0x78.
    const r = decode14(hexToBytes('3c013c02'))
    if (!r.ok) throw r.error
    expect(r.value.map((p) => p.type)).toEqual([0x3cn, 0x3cn])
  })

  it('has no Immutable Extensions before draft-14', () => {
    const r = decode09(hexToBytes('0b023c02'))
    if (!r.ok) throw r.error
    expect(r.value[0]!.properties).toBeUndefined()
    expect(bytesToHex(r.value[0]!.bytes!)).toBe('3c02')
  })

  it('accepts an empty block', () => {
    expect(decode22(new Uint8Array(0))).toEqual({ ok: true, value: [], bytesRead: 0 })
  })
})

describe('encodeObjectProperties', () => {
  it('writes what decodeObjectProperties reads, odd and repeated types included', () => {
    const hex = '0b023c020d01aa0001bb1005'
    const r = decode22(hexToBytes(hex))
    if (!r.ok) throw r.error
    expect(bytesToHex(encode22(r.value))).toBe(hex)
  })

  it('encodes nested properties when no bytes are given', () => {
    const block = encode22([{ type: 0x0bn, properties: [{ type: 0x3cn, value: 2n }] }])
    expect(bytesToHex(block)).toBe('0b023c02')
  })

  it('keeps the original bytes of Immutable Properties over re-encoding them', () => {
    // A non-minimal 2-byte varint 2 (0x8002) inside: it must survive untouched.
    const bytes = hexToBytes('3c8002')
    const block = encode22([{ type: 0x0bn, bytes, properties: [{ type: 0x3cn, value: 2n }] }])
    expect(bytesToHex(block)).toBe('0b033c8002')
  })

  it('refuses descending types under delta encoding', () => {
    expect(() =>
      encode22([
        { type: 0x3cn, value: 1n },
        { type: 0x0dn, bytes: new Uint8Array(0) },
      ]),
    ).toThrow(/must ascend/)
  })

  it('writes absolute types before draft-16, in any order', () => {
    expect(
      bytesToHex(
        encode14([
          { type: 0x3cn, value: 1n },
          { type: 0x0dn, bytes: hexToBytes('aa') },
        ]),
      ),
    ).toBe('3c010d01aa')
    expect(bytesToHex(encode09([{ type: 0x02n, value: 7n }]))).toBe('0207')
  })
})
