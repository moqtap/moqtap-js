/**
 * Compressed segments.
 *
 * A probe gzips what it forwards and its page seals that behind a batch frame
 * it writes itself, without inflating anything. What ingest receives must
 * still be **one** gzip member whose trailer checks out: `DecompressionStream`
 * in workerd stops at the first member, and a wrong CRC fails the whole body.
 */

import {
  constants,
  deflateRawSync,
  gunzipSync,
  inflateRawSync,
  crc32 as nodeCrc32,
} from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { BODY_PREAMBLE_BYTES, readPreamble } from '../../envelope/body.js'
import {
  crc32,
  crc32Combine,
  deflateSegment,
  FrameWriter,
  joinSegment,
  joinSegments,
  readFrames,
  splitFrames,
} from '../../envelope/index.js'
import { openSegment } from '../../envelope/open-segment.js'
import { FlushQueue } from '../../flush/index.js'
import { compress } from '../../flush/queue.js'

/** A deterministic byte soup: compressible in places, not in others. */
function bytes(n: number, seed: number): Uint8Array {
  const out = new Uint8Array(n)
  let a = seed >>> 0
  for (let i = 0; i < n; i += 1) {
    a = (Math.imul(a, 1664525) + 1013904223) >>> 0
    out[i] = i % 7 === 0 ? a >>> 24 : (i >> 4) & 0xff
  }
  return out
}

/** The member's deflate data ends exactly at its trailer, and the trailer is right. */
function expectOneMember(z: Uint8Array, plain: Uint8Array): void {
  expect([z[0], z[1], z[2]]).toEqual([0x1f, 0x8b, 8])
  const { buffer, engine } = inflateRawSync(z.subarray(10), { info: true }) as unknown as {
    buffer: Buffer
    engine: { bytesWritten: number }
  }
  expect(engine.bytesWritten).toBe(z.byteLength - 18)
  expect(same(buffer, plain)).toBe(true)
  const view = new DataView(z.buffer, z.byteOffset, z.byteLength)
  expect(view.getUint32(z.byteLength - 8, true)).toBe(nodeCrc32(plain))
  expect(view.getUint32(z.byteLength - 4, true)).toBe(plain.byteLength)
}

async function platformGunzip(z: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream('gzip')
  const out = new Response(new Blob([z as unknown as BlobPart]).stream().pipeThrough(ds))
  return new Uint8Array(await out.arrayBuffer())
}

/** Byte equality without a deep diff over hundreds of kilobytes. */
const same = (a: Uint8Array, b: Uint8Array): boolean => Buffer.compare(a, b) === 0

const concat = (a: Uint8Array, b: Uint8Array): Uint8Array => {
  const out = new Uint8Array(a.byteLength + b.byteLength)
  out.set(a)
  out.set(b, a.byteLength)
  return out
}

describe('crc32', () => {
  it.each([0, 1, 7, 255, 4096, 70_001])('agrees with zlib over %i bytes', (n) => {
    const b = bytes(n, n + 1)
    expect(crc32(b)).toBe(nodeCrc32(b))
  })

  it.each([
    [0, 10],
    [10, 0],
    [3, 5],
    [300, 70_000],
    [65_535, 65_537],
  ])('combines %i and %i bytes into the CRC of both', (na, nb) => {
    const a = bytes(na, 3)
    const b = bytes(nb, 5)
    expect(crc32Combine(crc32(a), crc32(b), nb)).toBe(nodeCrc32(concat(a, b)))
  })
})

describe('a segment joined behind a stored prefix', () => {
  it.each([
    [1, 10],
    [400, 200_000],
    [70_000, 3_000],
    [140_000, 1],
  ])('is one gzip member: %i bytes stored, %i compressed', async (np, ns) => {
    const prefix = bytes(np, 11)
    const tail = bytes(ns, 13)
    const segment = await deflateSegment(tail)
    expect(segment.size).toBe(ns)
    expect(segment.crc).toBe(nodeCrc32(tail))
    const z = joinSegment(prefix, segment)
    const plain = concat(prefix, tail)
    expectOneMember(z, plain)
    expect(same(gunzipSync(z), plain)).toBe(true)
    expect(same(await platformGunzip(z), plain)).toBe(true)
  })
})

describe('segments opened and joined end to end', () => {
  /** Object-header-like records: what the packer gzips, in dynamic blocks. */
  const records = (n: number, seed: number): Uint8Array =>
    new TextEncoder().encode(
      Array.from(
        { length: n },
        (_, i) =>
          `{"t":"hdr","ts":${seed * 1000 + i * 3.7},"g":${i >> 5},"o":${i & 31},"n":${(i * 7919) % 1500}}`,
      ).join(''),
    )

  /** The same input through zlib, in each kind of block it writes. */
  const zlib = (input: Uint8Array, level: number, strategy?: number) => ({
    deflate: new Uint8Array(
      deflateRawSync(input, { level, ...(strategy === undefined ? {} : { strategy }) }),
    ),
    crc: nodeCrc32(input),
    size: input.byteLength,
  })

  const inputs: [string, Uint8Array][] = [
    ['empty', new Uint8Array(0)],
    ['one byte', bytes(1, 3)],
    ['mixed', bytes(5_000, 5)],
    [
      'incompressible',
      concat(
        crypto.getRandomValues(new Uint8Array(65_536)),
        crypto.getRandomValues(new Uint8Array(4_464)),
      ),
    ],
    ['records', records(4_000, 7)],
  ]

  it.each(inputs)('stays one gzip member, %s, from every kind of block', async (_, input) => {
    const parts = [
      await deflateSegment(input),
      zlib(input, 0),
      zlib(input, 9),
      zlib(input, 6, constants.Z_FIXED),
      zlib(input, 1, constants.Z_HUFFMAN_ONLY),
    ]
    for (const part of parts) {
      const opened = openSegment(part)
      expect(opened.open).toBe(true)
      const prefix = bytes(40, 1)
      const suffix = bytes(300, 2)
      const z = joinSegment(prefix, opened, suffix)
      const plain = concat(concat(prefix, input), suffix)
      expectOneMember(z, plain)
      expect(same(await platformGunzip(z), plain)).toBe(true)
    }
  })

  it('joins many into one member, with nothing compressed again', async () => {
    const pieces = [
      records(3_000, 1),
      bytes(9_000, 2),
      records(10, 3),
      new Uint8Array(0),
      records(800, 4),
    ]
    const opened = await Promise.all(pieces.map(async (p) => openSegment(await deflateSegment(p))))
    const joined = joinSegments(opened)
    expect(joined.deflate.byteLength).toBe(opened.reduce((n, o) => n + o.deflate.byteLength, 0))
    const prefix = bytes(20, 9)
    const z = joinSegment(prefix, joined)
    const plain = pieces.reduce(concat, prefix)
    expectOneMember(z, plain)
    expect(same(await platformGunzip(z), plain)).toBe(true)
  })

  it('refuses what is not one deflate stream ending where it does', async () => {
    const good = await deflateSegment(records(500, 1))
    const longer = { ...good, deflate: concat(good.deflate, new Uint8Array([0])) }
    const shorter = { ...good, deflate: good.deflate.subarray(0, good.deflate.byteLength - 1) }
    const reserved = { ...good, deflate: new Uint8Array([0x07, 0, 0]) }
    for (const bad of [longer, shorter, reserved])
      expect(() => openSegment(bad)).toThrow(RangeError)
  })

  it('refuses a closed segment anywhere but last', async () => {
    const closed = await deflateSegment(bytes(10, 1))
    expect(() => joinSegments([closed])).toThrow(RangeError)
    expect(() => joinSegment(bytes(4, 1), closed, bytes(4, 2))).toThrow(RangeError)
  })
})

describe('splitting a frame stream', () => {
  function stream(): { frames: Uint8Array; count: number } {
    const w = new FrameWriter()
    for (let i = 0; i < 40; i += 1) {
      w.json({ t: 'note', ts: i, lvl: 'baseline', name: `n${i}`, data: 'x'.repeat(i * 3) })
      if (i % 4 === 0) w.raw(bytes(50 + i, i))
    }
    const count = w.frameCount
    return { frames: w.take(), count }
  }

  it('cuts only in front of a JSON frame, and loses nothing', () => {
    const { frames, count } = stream()
    for (const target of [1, 64, 500, 2_000, 1e9]) {
      const spans = splitFrames(frames, count, target)
      expect(spans.reduce((n, s) => n + s.count, 0)).toBe(count)
      const joined = spans.reduce<Uint8Array>((acc, s) => concat(acc, s.bytes), new Uint8Array(0))
      expect(joined).toEqual(frames)
      for (const s of spans) {
        const first = [...readFrames(s.bytes)][0]
        expect(first?.raw).toBe(false)
        expect([...readFrames(s.bytes)]).toHaveLength(s.count)
      }
      if (target === 1e9) expect(spans).toHaveLength(1)
    }
  })

  it('keeps a raw frame with the record before it, however small the target', () => {
    const { frames, count } = stream()
    const spans = splitFrames(frames, count, 1)
    const withRaw = spans.filter((s) => [...readFrames(s.bytes)].some((f) => f.raw))
    for (const s of withRaw) {
      expect([...readFrames(s.bytes)].map((f) => f.raw)).toEqual([false, true])
    }
  })
})

describe('a recycled frame buffer', () => {
  it('takes the frames written meanwhile and carries on', () => {
    const w = new FrameWriter({ initialBytes: 16 })
    for (let i = 0; i < 100; i += 1)
      w.json({ t: 'note', ts: i, lvl: 'baseline', name: 'a', data: i })
    const taken = w.take()
    w.json({ t: 'note', ts: 1, lvl: 'baseline', name: 'b', data: null })
    w.recycle(taken)
    w.json({ t: 'note', ts: 2, lvl: 'baseline', name: 'c', data: null })
    const names = [...readFrames(w.take())].map(
      (f) => (JSON.parse(new TextDecoder().decode(f.payload)) as { name: string }).name,
    )
    expect(names).toEqual(['b', 'c'])
  })
})

describe('sealing a segment', () => {
  it('numbers it with the other seals, batch frame first, already compressed', async () => {
    const q = new FlushQueue({ sessionId: 's', instanceId: 'i' })
    q.json({ t: 'note', ts: 0, lvl: 'baseline', name: 'first', data: null })
    const plain = q.seal()
    q.json({ t: 'note', ts: 1, lvl: 'baseline', name: 'page-own', data: null })
    const w = new FrameWriter()
    for (let i = 0; i < 500; i += 1)
      w.json({ t: 'note', ts: i, lvl: 'baseline', name: 'w', data: i })
    const chunk = q.sealSegment(await deflateSegment(w.take()), { dropped: 3 })
    expect(plain?.seq).toBe(0)
    expect(chunk.seq).toBe(1)
    expect(q.nextSeq).toBe(2)
    expect(q.pendingBytes).toBe(0)

    expect(readPreamble(chunk.bytes)?.gzipped).toBe(true)
    const before = chunk.bytes
    await compress(chunk)
    expect(chunk.bytes).toBe(before)

    const frames = await platformGunzip(chunk.bytes.subarray(BODY_PREAMBLE_BYTES))
    const records = [...readFrames(frames)].map(
      (f) => JSON.parse(new TextDecoder().decode(f.payload)) as { t: string; name?: string },
    )
    expect(records[0]).toMatchObject({
      t: 'batch',
      seq: 1,
      idempotencyKey: chunk.idempotencyKey,
      dropped: 3,
    })
    expect(records[1]).toMatchObject({ t: 'note', name: 'page-own' })
    expect(records.slice(2)).toHaveLength(500)
  })
})
