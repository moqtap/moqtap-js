/**
 * The frame stream, with bit 31 of the length prefix as the type tag the
 * spec never supplied.
 *
 * These are behaviour tests on the wire format itself: what a reader at the far
 * end of a POST can recover from the bytes. The format has three properties the
 * rest of the package silently depends on, and each one is a way the collector
 * can lie quietly rather than fail loudly, so each is tested directly:
 *
 *  - a reader can tell a raw frame from a JSON one, including when the payload
 *    is empty (a zero-length sentinel would not have worked);
 *  - `raw()` copies, because `StreamChunk.data` is a borrowed view onto the
 *    page's buffer and a retained view rewrites already-encoded history;
 *  - two frame streams concatenate, which is what lets the flush module put the
 *    mandatory first `BatchRecord` frame in front of an already-encoded batch
 *    once `crypto.subtle` finally produces the key.
 */

import { describe, expect, it } from 'vitest'
import { BODY_VERSION, writePreamble } from '../../envelope/body.js'
import { FrameWriter, readFrames } from '../../envelope/index.js'
import { type BatchRecord, type CtrlRecord, FRAME_RAW_FLAG, type NoteRecord } from '../../types.js'

const DECODER = new TextDecoder()

const batch: BatchRecord = {
  t: 'batch',
  ts: 0,
  lvl: 'baseline',
  sessionId: 'sess-1',
  segmentSeq: 3,
  idempotencyKey: '0'.repeat(64),
  wall: 1_700_000_000_000,
  v: 1,
}

const ctrl: CtrlRecord = {
  t: 'ctrl',
  ts: 412,
  lvl: 'baseline',
  dir: 'tx',
  streamId: 2,
  n: 5,
  decoded: true,
}

function frames(body: Uint8Array): { raw: boolean; payload: Uint8Array }[] {
  return [...readFrames(body)]
}

function jsonOf(frame: { payload: Uint8Array }): unknown {
  return JSON.parse(DECODER.decode(frame.payload))
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

describe('FrameWriter + readFrames', () => {
  it('round-trips interleaved JSON and raw frames in order, each tagged', () => {
    const w = new FrameWriter()
    w.json(batch)
    w.json(ctrl)
    w.raw(Uint8Array.from([0xaf, 0x00, 0x03, 0x1f, 0x20]))
    w.json({ t: 'note', ts: 5, lvl: 'baseline', name: 'seek', data: { to: 12 } })
    w.raw(Uint8Array.from([1, 2, 3]))

    const got = frames(w.take())
    expect(got.map((f) => f.raw)).toEqual([false, false, true, false, true])
    expect(jsonOf(got[0] as { payload: Uint8Array })).toEqual(batch)
    expect(jsonOf(got[1] as { payload: Uint8Array })).toEqual(ctrl)
    expect([...(got[2] as { payload: Uint8Array }).payload]).toEqual([0xaf, 0x00, 0x03, 0x1f, 0x20])
    expect([...(got[4] as { payload: Uint8Array }).payload]).toEqual([1, 2, 3])
  })

  it('sets bit 31 on a raw frame and leaves it clear on a JSON one', () => {
    const w = new FrameWriter()
    w.raw(Uint8Array.from([9, 9, 9, 9, 9]))
    const rawBody = w.take()
    const rawPrefix = new DataView(rawBody.buffer, rawBody.byteOffset).getUint32(0, false)
    expect((rawPrefix & FRAME_RAW_FLAG) !== 0).toBe(true)
    // The length still reads back exactly, which is the whole point of using a
    // spare bit rather than a separate tag byte.
    expect((rawPrefix & ~FRAME_RAW_FLAG) >>> 0).toBe(5)

    const w2 = new FrameWriter()
    w2.json(ctrl)
    const jsonBody = w2.take()
    const jsonPrefix = new DataView(jsonBody.buffer, jsonBody.byteOffset).getUint32(0, false)
    expect((jsonPrefix & FRAME_RAW_FLAG) !== 0).toBe(false)
    expect(jsonPrefix).toBe(jsonBody.length - 4)
  })

  it('keeps an empty raw frame distinguishable from an empty JSON one', () => {
    const w = new FrameWriter()
    w.raw(new Uint8Array(0))
    w.json({ t: 'note', ts: 1, lvl: 'baseline', name: '', data: null })
    const got = frames(w.take())
    expect(got).toHaveLength(2)
    expect(got[0]?.raw).toBe(true)
    expect(got[0]?.payload).toHaveLength(0)
    expect(got[1]?.raw).toBe(false)
  })

  it('copies raw bytes, so mutating the caller-s buffer afterwards changes nothing', () => {
    // StreamChunk.data is explicitly a borrowed view onto the page's own
    // ArrayBuffer, valid only for the duration of the callback.
    const borrowed = Uint8Array.from([1, 2, 3, 4])
    const w = new FrameWriter()
    w.raw(borrowed)
    borrowed.fill(0xff)
    const got = frames(w.take())
    expect([...(got[0] as { payload: Uint8Array }).payload]).toEqual([1, 2, 3, 4])
  })

  it('take() resets, and later frames cannot rewrite bytes already handed out', () => {
    const w = new FrameWriter({ initialBytes: 16 })
    w.raw(Uint8Array.from([1, 1, 1]))
    const first = w.take()
    expect(w.byteLength).toBe(0)
    expect(w.frameCount).toBe(0)

    w.raw(Uint8Array.from([2, 2, 2]))
    const second = w.take()
    expect([...(frames(first)[0] as { payload: Uint8Array }).payload]).toEqual([1, 1, 1])
    expect([...(frames(second)[0] as { payload: Uint8Array }).payload]).toEqual([2, 2, 2])
    expect(frames(second)).toHaveLength(1)
  })

  it('reports byteLength including the 4-byte prefix of every frame', () => {
    const w = new FrameWriter()
    expect(w.byteLength).toBe(0)
    w.raw(new Uint8Array(3))
    expect(w.byteLength).toBe(7)
    w.json(ctrl)
    expect(w.byteLength).toBe(w.take().length)
    expect(w.frameCount).toBe(0)
  })

  it('measures a frame in UTF-8 bytes, not in characters', () => {
    const name = 'ページ切替 ✅'
    const w = new FrameWriter()
    w.json({ t: 'note', ts: 1, lvl: 'baseline', name, data: null })
    const body = w.take()
    const got = frames(body)
    expect(got).toHaveLength(1)
    expect((jsonOf(got[0] as { payload: Uint8Array }) as NoteRecord).name).toBe(name)
    // If the prefix had been written from string length the frame would be
    // short and the stream would desynchronise on the next frame.
    expect((got[0] as { payload: Uint8Array }).payload.length).toBeGreaterThan(
      JSON.stringify({ t: 'note', ts: 1, lvl: 'baseline', name, data: null }).length,
    )
  })

  it('grows past its initial buffer without corrupting earlier frames', () => {
    const w = new FrameWriter({ initialBytes: 8 })
    for (let i = 0; i < 40; i++) w.raw(new Uint8Array(i).fill(i & 0xff))
    const got = frames(w.take())
    expect(got).toHaveLength(40)
    for (let i = 0; i < 40; i++) {
      const f = got[i] as { raw: boolean; payload: Uint8Array }
      expect(f.raw).toBe(true)
      expect(f.payload).toHaveLength(i)
      expect(f.payload.every((b) => b === (i & 0xff))).toBe(true)
    }
  })

  it('concatenates: two frame streams parse as one, which is how the batch frame gets prepended', () => {
    const head = new FrameWriter()
    head.json(batch)
    const tail = new FrameWriter()
    tail.json(ctrl)
    tail.raw(Uint8Array.from([0xaf, 0x00]))

    const got = frames(concat(head.take(), tail.take()))
    expect(got.map((f) => f.raw)).toEqual([false, false, true])
    expect((jsonOf(got[0] as { payload: Uint8Array }) as BatchRecord).t).toBe('batch')
    expect((jsonOf(got[1] as { payload: Uint8Array }) as CtrlRecord).t).toBe('ctrl')
  })

  it('json() is atomic: an unstringifiable record leaves the writer exactly as it was', () => {
    const w = new FrameWriter()
    w.json(ctrl)
    const before = w.byteLength
    // JSON.stringify throws on a bigint. That is why RollupTrackWire.key.v is a
    // decimal string, and it is the failure this atomicity guard exists for:
    // half a frame would desynchronise every byte behind it.
    const bad: NoteRecord = { t: 'note', ts: 2, lvl: 'baseline', name: 'alias', data: 7n }
    expect(() => w.json(bad)).toThrow(TypeError)
    expect(w.byteLength).toBe(before)
    expect(w.frameCount).toBe(1)

    const got = frames(w.take())
    expect(got).toHaveLength(1)
    expect((jsonOf(got[0] as { payload: Uint8Array }) as CtrlRecord).t).toBe('ctrl')
  })
})

describe('readFrames rejects a damaged stream rather than yielding its readable prefix', () => {
  it('throws on a truncated payload', () => {
    const w = new FrameWriter()
    w.json(ctrl)
    w.raw(new Uint8Array(10))
    const body = w.take()
    expect(() => [...readFrames(body.subarray(0, body.length - 1))]).toThrow(/MQ2004/)
  })

  it('throws on a truncated prefix', () => {
    const w = new FrameWriter()
    w.raw(new Uint8Array(4))
    const body = w.take()
    expect(() => [...readFrames(body.subarray(0, body.length - 6))]).toThrow(/MQ2003/)
  })

  it('accepts an empty stream as zero frames', () => {
    expect(frames(new Uint8Array(0))).toEqual([])
    expect(frames(new FrameWriter().take())).toEqual([])
  })

  it('diagnoses a whole body handed over with its preamble still attached', () => {
    const w = new FrameWriter()
    w.json(ctrl)
    const body = concat(writePreamble({ version: BODY_VERSION, gzipped: false }), w.take())
    expect(() => [...readFrames(body)]).toThrow(/MQ2002/)
  })
})
