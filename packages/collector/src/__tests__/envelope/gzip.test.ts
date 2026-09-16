/**
 * Compression and the self-describing body.
 *
 * The tail adds a delivery path, `sendBeacon`, that cannot set
 * `Content-Encoding` — or any other header. The eight-byte preamble is the
 * resolution, and these tests cover the properties ingest relies on:
 *
 *  - the flags byte always tells the truth about the bytes behind it, on every
 *    path through `encodeBody` including the failure paths;
 *  - `encodeBody` never throws, because compression is an optimisation and losing
 *    a batch to it would trade a measurement for a compression ratio;
 *  - the preamble reads without decompressing, which is the only reason a
 *    beacon body is decodable at all.
 *
 * The concurrency test is not incidental. A `TransformStream` has a
 * one-chunk writable queue and a zero-high-water-mark readable, so
 * `await write(); await close()` before reading a byte deadlocks on any input
 * large enough to produce output mid-transform — and a seal happens at ~32 KB.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BODY_MAGIC,
  BODY_PREAMBLE_BYTES,
  BODY_VERSION,
  encodeBody,
  FrameWriter,
  gzip,
  gzipSupported,
  readFrames,
  readPreamble,
  writePreamble,
} from '../../envelope/index.js'
import type { CtrlRecord, RollupRecord } from '../../types.js'

const ENCODER = new TextEncoder()
const DECODER = new TextDecoder()

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream('gzip')
  const writer = ds.writable.getWriter()
  const written = (async () => {
    // Copied into a buffer this helper owns: a WebIDL `BufferSource` is not
    // `[AllowShared]`, and the copy keeps the check that matters — that the
    // bytes `encodeBody` produced decompress — independent of how they were
    // viewed.
    await writer.write(new Uint8Array(bytes))
    await writer.close()
  })()
  written.catch(() => {})
  const reader = ds.readable.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value !== undefined) {
      chunks.push(value)
      total += value.length
    }
  }
  await written
  const out = new Uint8Array(total)
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.length
  }
  return out
}

/** A body that looks like a real rollup stream: repetitive JSON, which is what the ratio rests on. */
function rollupFrames(intervals: number): Uint8Array {
  const w = new FrameWriter()
  for (let seq = 0; seq < intervals; seq++) {
    const rollup: RollupRecord = {
      t: 'rollup',
      v: 1,
      ts: seq * 1000,
      lvl: 'baseline',
      seq,
      startMono: seq * 1000,
      endMono: (seq + 1) * 1000,
      tracks: [
        {
          key: { d: 'rx', k: 'alias', v: '2', e: 0 },
          firstSeen: seq * 1000,
          lastSeen: (seq + 1) * 1000,
          objects: 30,
          payloadBytes: 240_000,
          headerBytes: 360,
          groups: 1,
          groupGaps: 0,
          outOfOrder: 0,
          duplicates: 0,
          statusObjects: 0,
          parseFailures: 0,
          hist: { interArrivalMs: { i: [4, 5], c: [28, 2], n: 30, sum: 990 } },
        },
      ],
      session: { streamsOpened: 2, controlFrames: 4 },
    }
    w.json(rollup)
  }
  return w.take()
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('gzip', () => {
  it('is available in this environment', () => {
    expect(gzipSupported()).toBe(true)
  })

  it('emits a real gzip member, not a raw deflate stream', async () => {
    const out = await gzip(ENCODER.encode('hello hello hello'))
    expect(out[0]).toBe(0x1f)
    expect(out[1]).toBe(0x8b)
    expect(out[2]).toBe(0x08)
  })

  it('round-trips arbitrary bytes', async () => {
    const input = ENCODER.encode(JSON.stringify({ t: 'note', name: 'ページ ✅', data: [1, 2, 3] }))
    const back = await gunzip(await gzip(input))
    expect([...back]).toEqual([...input])
  })

  it('round-trips an empty input', async () => {
    const back = await gunzip(await gzip(new Uint8Array(0)))
    expect(back).toHaveLength(0)
  })

  it('actually compresses a rollup stream', async () => {
    const frames = rollupFrames(40)
    const out = await gzip(frames)
    expect(out.length).toBeLessThan(frames.length / 5)
    expect([...(await gunzip(out))]).toEqual([...frames])
  })

  it('does not deadlock on an input larger than the stream queues', async () => {
    // The deadlock the implementation is written against is a property of the
    // OUTPUT: draining the writer before reading hangs once the compressor
    // emits more than one internal chunk. Measured on this workspace's Node
    // (v24), the naive form completes at 16,000 B of incompressible input and
    // hangs at 16,384 B. This 1 MB LCG stream compresses about 50x — to
    // ~20.6 KB — which is comfortably past the 16 KB boundary, so a writer
    // drained before the reader started would hang here rather than fail.
    const input = new Uint8Array(1 << 20)
    let x = 123456789
    for (let i = 0; i < input.length; i++) {
      x = (x * 1103515245 + 12345) & 0x7fffffff
      input[i] = x >>> 16
    }
    const back = await gunzip(await gzip(input))
    expect(back.length).toBe(input.length)
    expect(back[0]).toBe(input[0])
    expect(back[input.length - 1]).toBe(input[input.length - 1])
  })

  it('compresses a 32 KB seal of incompressible bytes', async () => {
    // The realistic worst case for a seal: one carrying raw control and
    // object-header frames, which do not compress. 32 KB in produces ~32 KB
    // out — twice the 16 KB chunk boundary — and it must still complete and
    // round-trip.
    const input = new Uint8Array(32 * 1024)
    crypto.getRandomValues(input)
    const out = await gzip(input)
    expect(out.length).toBeGreaterThan(16 * 1024)
    expect([...(await gunzip(out))]).toEqual([...input])
  })

  it('accepts a SharedArrayBuffer-backed view, which the platform compressor refuses', async () => {
    // WebIDL `BufferSource` is not `[AllowShared]`: handing the compressor a
    // view onto shared memory is a TypeError (`The "chunk" argument must be an
    // instance of ArrayBuffer, Buffer, TypedArray, or DataView`). Nothing in
    // this package allocates one, but `gzip` is exported and a cross-origin
    // isolated page could pass one in, so it is copied rather than thrown at.
    const shared = new Uint8Array(new SharedArrayBuffer(4096))
    shared.fill(0x41)
    const out = await gzip(shared)
    expect([...(await gunzip(out))]).toEqual([...shared])
  })

  it('rejects rather than silently returning the input when CompressionStream is missing', async () => {
    vi.stubGlobal('CompressionStream', undefined)
    expect(gzipSupported()).toBe(false)
    await expect(gzip(ENCODER.encode('x'))).rejects.toThrow(/MQ2201/)
  })
})

describe('the body preamble', () => {
  it('is eight bytes: magic, version, flags, two reserved', () => {
    const p = writePreamble({ version: BODY_VERSION, gzipped: true })
    expect(p).toHaveLength(BODY_PREAMBLE_BYTES)
    expect([...p.subarray(0, 4)]).toEqual([...BODY_MAGIC])
    expect(DECODER.decode(p.subarray(0, 4))).toBe('MQTC')
    expect(p[4]).toBe(BODY_VERSION)
    expect(p[5]).toBe(1)
    expect(p[6]).toBe(0)
    expect(p[7]).toBe(0)
  })

  it('round-trips the gzip flag in both states', () => {
    for (const gzipped of [true, false]) {
      expect(readPreamble(writePreamble({ version: BODY_VERSION, gzipped }))).toEqual({
        version: BODY_VERSION,
        gzipped,
      })
    }
  })

  it('returns null for anything that is not a collector body', () => {
    expect(readPreamble(new Uint8Array(0))).toBeNull()
    expect(readPreamble(new Uint8Array(7))).toBeNull()
    expect(readPreamble(ENCODER.encode('NOPE1234'))).toBeNull()
    // A bare frame stream is the near miss that matters: it is our own bytes,
    // just without the preamble, and it must not read as version 0.
    const frames = rollupFrames(1)
    expect(readPreamble(frames)).toBeNull()
  })

  it('reports an unknown version rather than rejecting it', () => {
    // "Not ours" and "ours, newer than I am" are different incidents: a
    // misrouted request against a rolling client upgrade.
    const p = writePreamble({ version: 7, gzipped: false })
    expect(readPreamble(p)).toEqual({ version: 7, gzipped: false })
  })

  it('ignores the reserved bytes, so a later version can claim them', () => {
    const p = writePreamble({ version: BODY_VERSION, gzipped: true })
    p[6] = 0xff
    p[7] = 0x01
    expect(readPreamble(p)).toEqual({ version: BODY_VERSION, gzipped: true })
  })
})

describe('encodeBody', () => {
  it('compresses, and says so, and the frames come back out', async () => {
    const frames = rollupFrames(20)
    const { bytes, gzipped } = await encodeBody(frames)
    expect(gzipped).toBe(true)
    expect(bytes.length).toBeLessThan(frames.length)

    const preamble = readPreamble(bytes)
    expect(preamble).toEqual({ version: BODY_VERSION, gzipped: true })
    const back = await gunzip(bytes.subarray(BODY_PREAMBLE_BYTES))
    expect([...back]).toEqual([...frames])
    expect([...readFrames(back)]).toHaveLength(20)
  })

  it('honours gzip:false and leaves the frames byte-for-byte', async () => {
    const frames = rollupFrames(3)
    const { bytes, gzipped } = await encodeBody(frames, { gzip: false })
    expect(gzipped).toBe(false)
    expect(readPreamble(bytes)?.gzipped).toBe(false)
    expect([...bytes.subarray(BODY_PREAMBLE_BYTES)]).toEqual([...frames])
  })

  it('declines compression when it would make the body bigger', async () => {
    // A gzip member costs ~20 bytes of header and trailer, and the point is to
    // put as few bytes as possible into a network the player is already fighting.
    const tiny = new FrameWriter()
    tiny.raw(Uint8Array.from([0xaf, 0x00, 0x03]))
    const frames = tiny.take()
    const { bytes, gzipped } = await encodeBody(frames)
    expect(gzipped).toBe(false)
    expect(readPreamble(bytes)?.gzipped).toBe(false)
    expect(bytes.length).toBe(BODY_PREAMBLE_BYTES + frames.length)
    expect([...readFrames(bytes.subarray(BODY_PREAMBLE_BYTES))]).toHaveLength(1)
  })

  it('never throws when CompressionStream is absent — it costs bytes, not the batch', async () => {
    vi.stubGlobal('CompressionStream', undefined)
    const frames = rollupFrames(10)
    const { bytes, gzipped } = await encodeBody(frames)
    expect(gzipped).toBe(false)
    expect(readPreamble(bytes)?.gzipped).toBe(false)
    expect([...bytes.subarray(BODY_PREAMBLE_BYTES)]).toEqual([...frames])
  })

  it('never throws when CompressionStream exists but fails', async () => {
    vi.stubGlobal(
      'CompressionStream',
      class {
        constructor() {
          throw new Error('compression unavailable in this sandbox')
        }
      },
    )
    expect(gzipSupported()).toBe(true)
    const frames = rollupFrames(10)
    const { bytes, gzipped } = await encodeBody(frames)
    expect(gzipped).toBe(false)
    expect([...readFrames(bytes.subarray(BODY_PREAMBLE_BYTES))]).toHaveLength(10)
  })

  it('encodes an empty batch without inventing a body', async () => {
    const { bytes, gzipped } = await encodeBody(new Uint8Array(0))
    expect(gzipped).toBe(false)
    expect(bytes).toHaveLength(BODY_PREAMBLE_BYTES)
    expect(readPreamble(bytes)).toEqual({ version: BODY_VERSION, gzipped: false })
  })

  it('survives the whole path a beacon takes: write, seal, read back with headers unavailable', async () => {
    const w = new FrameWriter()
    const ctrl: CtrlRecord = {
      t: 'ctrl',
      ts: 9,
      lvl: 'baseline',
      dir: 'rx',
      streamId: 1,
      n: 4,
      decoded: true,
    }
    w.json(ctrl)
    w.raw(Uint8Array.from([0xaf, 0x00, 0x03, 0x1f]))

    const { bytes } = await encodeBody(w.take())
    // Everything below is what ingest can do with a beacon body and no headers.
    const preamble = readPreamble(bytes)
    expect(preamble).not.toBeNull()
    const frameBytes = preamble?.gzipped
      ? await gunzip(bytes.subarray(BODY_PREAMBLE_BYTES))
      : bytes.subarray(BODY_PREAMBLE_BYTES)
    const got = [...readFrames(frameBytes)]
    expect(got.map((f) => f.raw)).toEqual([false, true])
    expect(JSON.parse(DECODER.decode((got[0] as { payload: Uint8Array }).payload))).toEqual(ctrl)
    expect([...(got[1] as { payload: Uint8Array }).payload]).toEqual([0xaf, 0x00, 0x03, 0x1f])
  })
})
