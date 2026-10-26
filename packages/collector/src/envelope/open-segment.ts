/**
 * A closed deflate stream made open, so more can follow it in the same gzip
 * member: its final block marked not final, and an empty stored block put
 * after it, which ends the data on a byte boundary.
 *
 * Where the final block starts and where it ends are found by walking the
 * stream's blocks: every Huffman code is decoded, nothing is written out.
 * The walk also checks the stream is whole, so a segment that would make a
 * body ingest cannot read is refused here, before it is sealed.
 */

import type { DeflateSegment } from './segment.js'

/** A canonical Huffman code: codes of each length, and the symbols in code order. */
interface Code {
  readonly count: Uint16Array
  readonly symbol: Uint16Array
}

const bad = (what: string): never => {
  throw new RangeError(`deflate: ${what}`)
}

function code(lengths: ArrayLike<number>, from: number, n: number): Code {
  const count = new Uint16Array(16)
  const symbol = new Uint16Array(n)
  for (let i = 0; i < n; i += 1) {
    const len = lengths[from + i] as number
    count[len] = (count[len] as number) + 1
  }
  const offs = new Uint16Array(16)
  let left = 1
  for (let len = 1; len < 16; len += 1) {
    left = (left << 1) - (count[len] as number)
    if (left < 0) bad('code')
    if (len < 15) offs[len + 1] = (offs[len] as number) + (count[len] as number)
  }
  for (let i = 0; i < n; i += 1) {
    const len = lengths[from + i] as number
    if (len === 0) continue
    const at = offs[len] as number
    symbol[at] = i
    offs[len] = at + 1
  }
  return { count, symbol }
}

/** Order the code length code's lengths come in. */
const ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]

/** Extra bits of a length symbol (minus 257) and of a distance symbol. */
const lengthExtra = (s: number): number => (s < 8 || s === 28 ? 0 : (s >> 2) - 1)
const distanceExtra = (s: number): number => (s < 2 ? 0 : (s >> 1) - 1)

/** Base values, built from the extra bits: each base follows the previous range. */
const LENGTH_BASE: number[] = []
const DISTANCE_BASE: number[] = []
for (let s = 0, b = 3; s < 29; s += 1) {
  LENGTH_BASE.push(s === 28 ? 258 : b)
  b += 1 << lengthExtra(s)
}
for (let s = 0, b = 1; s < 30; s += 1) {
  DISTANCE_BASE.push(b)
  b += 1 << distanceExtra(s)
}

let fixed: [Code, Code] | undefined

/**
 * `segment`, opened. Throws `RangeError` when its data is not one whole
 * deflate stream of `segment.size` bytes ending exactly where the data does.
 */
export function openSegment(segment: DeflateSegment): DeflateSegment {
  const data = segment.deflate
  const end = data.byteLength * 8
  let pos = 0
  let out = 0

  const bits = (n: number): number => {
    if (pos + n > end) bad('short')
    let v = 0
    for (let i = 0; i < n; i += 1, pos += 1)
      v |= (((data[pos >> 3] as number) >> (pos & 7)) & 1) << i
    return v
  }
  const decode = (h: Code): number => {
    let c = 0
    let first = 0
    let index = 0
    for (let len = 1; len < 16; len += 1) {
      c |= bits(1)
      const count = h.count[len] as number
      if (c - count < first) return h.symbol[index + c - first] as number
      index += count
      first = (first + count) << 1
      c <<= 1
    }
    return bad('symbol')
  }
  const codes = (lit: Code, dist: Code): void => {
    for (;;) {
      let s = decode(lit)
      if (s < 256) out += 1
      else if (s === 256) return
      else {
        s -= 257
        if (s >= 29) bad('length')
        const len = (LENGTH_BASE[s] as number) + bits(lengthExtra(s))
        const d = decode(dist)
        if (d >= 30) bad('distance')
        if ((DISTANCE_BASE[d] as number) + bits(distanceExtra(d)) > out) bad('distance')
        out += len
      }
    }
  }

  let head: number
  for (;;) {
    head = pos
    const last = bits(1)
    const type = bits(2)
    if (type === 0) {
      pos = (pos + 7) & ~7
      const len = bits(16)
      if (bits(16) !== (len ^ 0xffff)) bad('stored')
      if (pos + len * 8 > end) bad('short')
      pos += len * 8
      out += len
    } else if (type === 1) {
      if (fixed === undefined) {
        const l = new Uint8Array(318)
        l.fill(8, 0, 144).fill(9, 144, 256).fill(7, 256, 280).fill(8, 280, 288).fill(5, 288)
        fixed = [code(l, 0, 288), code(l, 288, 30)]
      }
      codes(fixed[0], fixed[1])
    } else if (type === 2) {
      const nlen = bits(5) + 257
      const ndist = bits(5) + 1
      const ncode = bits(4) + 4
      if (nlen > 286 || ndist > 30) bad('counts')
      const l = new Uint8Array(nlen + ndist)
      const cl = new Uint8Array(19)
      for (let i = 0; i < ncode; i += 1) cl[ORDER[i] as number] = bits(3)
      const lc = code(cl, 0, 19)
      for (let i = 0; i < l.length; ) {
        const s = decode(lc)
        if (s < 16) {
          l[i++] = s
          continue
        }
        let v = 0
        let rep: number
        if (s === 16) {
          if (i === 0) bad('repeat')
          v = l[i - 1] as number
          rep = 3 + bits(2)
        } else rep = s === 17 ? 3 + bits(3) : 11 + bits(7)
        if (i + rep > l.length) bad('repeat')
        l.fill(v, i, i + rep)
        i += rep
      }
      if (l[256] === 0) bad('end code')
      codes(code(l, 0, nlen), code(l, nlen, ndist))
    } else bad('block type')
    if (last === 1) break
  }
  if ((pos + 7) >> 3 !== data.byteLength) bad('trailing data')
  if (out !== segment.size) bad('size')

  // The final bit cleared, the padding after the last block zeroed, then an
  // empty stored block: three zero bits, the padding, LEN 0 and NLEN 0xffff.
  const at = (pos + 3 + 7) >> 3
  const deflate = new Uint8Array(at + 4)
  deflate.set(data)
  deflate[head >> 3] = (deflate[head >> 3] as number) & ~(1 << (head & 7))
  deflate[pos >> 3] = (deflate[pos >> 3] as number) & ((1 << (pos & 7)) - 1)
  deflate.set([0, 0, 0xff, 0xff], at)
  return { deflate, crc: segment.crc, size: segment.size, open: true }
}
