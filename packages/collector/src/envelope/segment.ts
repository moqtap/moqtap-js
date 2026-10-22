/**
 * Compressed segments: frames gzipped in one realm and sealed in another.
 *
 * A linked worker compresses what it forwards, so its page only appends,
 * stores and uploads. But the body the page seals must open with a batch
 * frame only the page can write, ingest reads every body as **one** gzip
 * member (`DecompressionStream` in browsers and workerd stops at the first),
 * and `CompressionStream` always ends its output with a final block. So the
 * worker's output can only ever be the last thing in a body.
 *
 * {@link joinSegment} builds that body's single member around it: a gzip
 * header, the page's own bytes as stored (uncompressed) deflate blocks, which
 * end on a byte boundary and are not final, then the worker's deflate data
 * verbatim, then a trailer whose CRC-32 is combined from the two halves'. No
 * byte is inflated or recompressed on the page.
 */

import { gzip } from './gzip.js'

/** A deflate stream ending in a final block, with what the gzip trailer needs. */
export interface DeflateSegment {
  /** Raw deflate data: no gzip header, no trailer. */
  readonly deflate: Uint8Array
  /** CRC-32 of the uncompressed bytes. */
  readonly crc: number
  /** Length of the uncompressed bytes. */
  readonly size: number
}

/**
 * Gzip `input` and take the gzip framing off again.
 *
 * Rejects when compression is unavailable or fails, or when the platform's
 * output is not the plain gzip member expected; the caller then sends the
 * frames as they are.
 */
export async function deflateSegment(input: Uint8Array): Promise<DeflateSegment> {
  const z = await gzip(input)
  // Every engine's `CompressionStream` writes the bare ten-byte header: no
  // name, comment or extra field. Anything else is refused rather than parsed.
  if (z.byteLength < 18 || z[0] !== 0x1f || z[1] !== 0x8b || z[2] !== 8 || z[3] !== 0) {
    throw new RangeError('gzip header')
  }
  const view = new DataView(z.buffer, z.byteOffset, z.byteLength)
  if (view.getUint32(z.byteLength - 4, true) !== input.byteLength >>> 0) {
    throw new RangeError('gzip size')
  }
  return {
    deflate: z.subarray(10, z.byteLength - 8),
    crc: view.getUint32(z.byteLength - 8, true),
    size: input.byteLength,
  }
}

/** Largest payload of one stored deflate block. */
const STORED_MAX = 0xffff

/**
 * One gzip member: `prefix` stored, then `segment`'s deflate data.
 *
 * `prefix` must be non-empty; a seal always has its batch frame.
 */
export function joinSegment(prefix: Uint8Array, segment: DeflateSegment): Uint8Array {
  const blocks = Math.max(1, Math.ceil(prefix.byteLength / STORED_MAX))
  const out = new Uint8Array(10 + prefix.byteLength + 5 * blocks + segment.deflate.byteLength + 8)
  // ID1 ID2 CM=deflate FLG=0 MTIME=0 XFL=0 OS=255 (unknown): nothing ingest reads.
  out.set([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 0xff], 0)
  let at = 10
  for (let i = 0; i < blocks; i += 1) {
    const part = prefix.subarray(i * STORED_MAX, (i + 1) * STORED_MAX)
    // BFINAL=0 BTYPE=00, then padding to the byte boundary, LEN and its complement.
    out[at] = 0
    out[at + 1] = part.byteLength & 0xff
    out[at + 2] = part.byteLength >>> 8
    out[at + 3] = ~part.byteLength & 0xff
    out[at + 4] = (~part.byteLength >>> 8) & 0xff
    out.set(part, at + 5)
    at += 5 + part.byteLength
  }
  out.set(segment.deflate, at)
  at += segment.deflate.byteLength
  const view = new DataView(out.buffer)
  view.setUint32(at, crc32Combine(crc32(prefix), segment.crc, segment.size), true)
  view.setUint32(at + 4, (prefix.byteLength + segment.size) >>> 0, true)
  return out
}

/* ── CRC-32 (IEEE 802.3, reflected), as gzip uses it ─────────────────────── */

const POLY = 0xedb88320

const TABLE: Uint32Array = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? POLY ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

export function crc32(bytes: Uint8Array, crc = 0): number {
  let c = ~crc
  for (let i = 0; i < bytes.length; i += 1) {
    c = (TABLE[(c ^ (bytes[i] as number)) & 0xff] as number) ^ (c >>> 8)
  }
  return ~c >>> 0
}

/** `a * b` modulo the CRC polynomial, both reflected. */
function multModP(a: number, b: number): number {
  let m = 0x80000000
  let p = 0
  for (;;) {
    if ((a & m) !== 0) {
      p ^= b
      if ((a & (m - 1)) === 0) break
    }
    m >>>= 1
    b = b & 1 ? (b >>> 1) ^ POLY : b >>> 1
  }
  return p >>> 0
}

/** `x^(2^k)` modulo the polynomial, for k = 0 … 31. */
const X2N: Uint32Array = (() => {
  const t = new Uint32Array(32)
  let p = 0x40000000
  t[0] = p
  for (let n = 1; n < 32; n += 1) {
    p = multModP(p, p)
    t[n] = p
  }
  return t
})()

/** `x^(n * 2^k)` modulo the polynomial. */
function x2nModP(n: number, k: number): number {
  let p = 0x80000000
  while (n > 0) {
    if (n & 1) p = multModP(X2N[k & 31] as number, p)
    n = Math.floor(n / 2)
    k += 1
  }
  return p
}

/** The CRC-32 of `A ++ B`, from the CRC-32 of each and the length of `B`. */
export function crc32Combine(crcA: number, crcB: number, lengthB: number): number {
  return (multModP(x2nModP(lengthB, 3), crcA) ^ crcB) >>> 0
}
