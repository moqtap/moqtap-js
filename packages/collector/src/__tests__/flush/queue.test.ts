/**
 * Sealing — the schedule, and keying at the seal.
 *
 * Every assertion below is a durability property, not a shape check:
 *
 *  - **A seal is synchronous and numbers only what it seals.** The sequence is
 *    the instance's own, in memory, taken only when there are frames, so the
 *    bodies of one instance are `0, 1, 2, …` with no gap a seal could leave.
 *  - **The key is derived at the seal.** `sha256(sessionId:instanceId:seq)`,
 *    on the batch frame of the body it names, so a retry from any page load
 *    sends the same key.
 *  - **A `ctrl` record and its raw frame live or die together.** A raw
 *    frame is unreadable without the record that names it (`RecordSink.raw`),
 *    and each POST is a complete self-contained frame stream, so the
 *    pair may never be split by a drop.
 *  - **The schedule's cadence is fixed.** "A crash loses at most 60 seconds" is
 *    only true if nothing — congestion included — can stretch it.
 *
 * The bodies are read back through the envelope module's own reader rather than
 * by inspecting the queue's internals: what ingest can parse is the only thing
 * that matters here.
 */

import { describe, expect, it } from 'vitest'
import {
  BODY_PREAMBLE_BYTES,
  type BodyPreamble,
  FrameWriter,
  idempotencyKey,
  readFrames,
  readPreamble,
} from '../../envelope/index.js'
import type { Chunk as FlushChunk, FlushScheduleOptions, TimerSource } from '../../flush/index.js'
import { compress, FlushQueue, FlushSchedule } from '../../flush/index.js'
import type {
  BatchRecord,
  ClockSource,
  CtrlRecord,
  EnvelopeRecord,
  NoteRecord,
  SealReason,
} from '../../types.js'

/* ── helpers ─────────────────────────────────────────────────────────────── */

const clockAt = (start = 1_000): ClockSource & { t: number } => {
  const c = {
    t: start,
    now: () => c.t,
    wall: () => 1_700_000_000_000 + c.t,
  }
  return c
}

const note = (name: string, data: unknown = 'x'): NoteRecord => ({
  t: 'note',
  ts: 0,
  lvl: 'baseline',
  name,
  data,
})

const ctrl = (n: number): CtrlRecord => ({
  t: 'ctrl',
  conn: 'c-1',
  ts: 0,
  lvl: 'baseline',
  dir: 'rx',
  streamId: 1,
  n,
  decoded: true,
})

const queue = (over: Partial<ConstructorParameters<typeof FlushQueue>[0]> = {}): FlushQueue =>
  new FlushQueue({ sessionId: 's1', instanceId: 'i1', ...over })

const gunzip = async (input: Uint8Array): Promise<Uint8Array> => {
  const ds = new DecompressionStream('gzip')
  const writer = ds.writable.getWriter()
  const written = (async () => {
    await writer.write(input as unknown as BufferSource)
    await writer.close()
  })()
  written.catch(() => {})
  const reader = ds.readable.getReader()
  const parts: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value !== undefined) {
      parts.push(value)
      total += value.length
    }
  }
  await written
  const out = new Uint8Array(total)
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

interface DecodedBody {
  readonly preamble: BodyPreamble
  readonly frames: readonly { raw: boolean; payload: Uint8Array }[]
  readonly records: readonly EnvelopeRecord[]
}

/** Read a sealed body exactly as ingest would: preamble, then frames. */
const decodeBody = async (bytes: Uint8Array): Promise<DecodedBody> => {
  const preamble = readPreamble(bytes)
  if (preamble === null) throw new Error('body has no preamble')
  const raw = bytes.subarray(BODY_PREAMBLE_BYTES)
  const frameBytes = preamble.gzipped ? await gunzip(raw) : raw
  const frames = [...readFrames(frameBytes)]
  const decoder = new TextDecoder()
  const records = frames
    .filter((f) => !f.raw)
    .map((f) => JSON.parse(decoder.decode(f.payload)) as EnvelopeRecord)
  return { preamble, frames, records }
}

const nameOf = (r: EnvelopeRecord): string | undefined => (r.t === 'note' ? r.name : undefined)

const batchOf = async (c: FlushChunk): Promise<BatchRecord> =>
  (await decodeBody(c.bytes)).records[0] as BatchRecord

/* ── the sealed body ─────────────────────────────────────────────────────── */

describe('FlushQueue.seal', () => {
  it('produces a body ingest can read: preamble, batch frame first, then the records in order', async () => {
    const q = queue()
    q.json(note('a'))
    q.json(note('b'))
    const chunk = q.seal() as FlushChunk
    const body = await decodeBody(chunk.bytes)
    expect(body.preamble.gzipped).toBe(false)
    expect(body.records.map((r) => r.t)).toEqual(['batch', 'note', 'note'])
    expect(body.records.map(nameOf)).toEqual([undefined, 'a', 'b'])
  })

  it('returns the chunk in the same turn, keyed, with nothing awaited', () => {
    const q = queue()
    q.json(note('a'))
    const chunk = q.seal()
    // Not a promise: the page can die at the next `await` and the body exists.
    expect(chunk).not.toBeInstanceOf(Promise)
    expect(chunk?.idempotencyKey).toBe(idempotencyKey('s1', 'i1', 0))
  })

  it('carries a v2 batch frame naming the session, the instance, the number and the key', async () => {
    const clock = clockAt(2_500)
    const q = queue({ clock, level: () => 'headers' })
    q.json(note('a'))
    const chunk = q.seal({ dropped: 7 }) as FlushChunk
    const batch = await batchOf(chunk)
    expect(batch).toEqual({
      t: 'batch',
      ts: 2_500,
      lvl: 'headers',
      v: 2,
      sessionId: 's1',
      instanceId: 'i1',
      seq: 0,
      idempotencyKey: idempotencyKey('s1', 'i1', 0),
      wall: 1_700_000_002_500,
      dropped: 7,
    })
    expect(chunk).toMatchObject({ sessionId: 's1', instanceId: 'i1', seq: 0, level: 'headers' })
  })

  it('marks the final body and lists lost bodies only when there are any', async () => {
    const q = queue()
    q.json(note('a'))
    const plain = await batchOf(q.seal() as FlushChunk)
    expect(plain).not.toHaveProperty('final')
    expect(plain).not.toHaveProperty('lost')

    q.json(note('b'))
    const last = await batchOf(q.seal({ final: true, lost: [0] }) as FlushChunk)
    expect(last.final).toBe(true)
    expect(last.lost).toEqual([0])
  })

  it('returns null and takes no number when there is nothing to seal', () => {
    const q = queue()
    expect(q.seal()).toBeNull()
    expect(q.seal()).toBeNull()
    expect(q.nextSeq).toBe(0)
    q.json(note('a'))
    expect(q.seal()?.seq).toBe(0)
  })

  it('numbers bodies 0, 1, 2 … with no gap and never repeats a key', () => {
    const q = queue()
    const keys = new Set<string>()
    for (let i = 0; i < 5; i++) {
      q.json(note(`n${i}`))
      const c = q.seal() as FlushChunk
      expect(c.seq).toBe(i)
      keys.add(c.idempotencyKey)
      // An empty seal in between takes nothing.
      expect(q.seal()).toBeNull()
    }
    expect(keys.size).toBe(5)
    expect(q.nextSeq).toBe(5)
  })

  it('keys two instances of one session apart', () => {
    const a = queue({ instanceId: 'tab-a' })
    const b = queue({ instanceId: 'tab-b' })
    a.json(note('a'))
    b.json(note('b'))
    expect(a.seal()?.idempotencyKey).not.toBe(b.seal()?.idempotencyKey)
  })

  it('stamps the wall clock the body was sealed at', () => {
    const clock = clockAt(10)
    const q = queue({ clock })
    q.json(note('a'))
    clock.t = 99
    expect(q.seal()?.createdWallMs).toBe(1_700_000_000_099)
  })
})

describe('compress', () => {
  it('swaps in the gzipped body when it is smaller, under the same key', async () => {
    const q = queue()
    for (let i = 0; i < 50; i++) q.json(note('repetitive', 'x'.repeat(200)))
    const chunk = q.seal() as FlushChunk
    const key = chunk.idempotencyKey
    const before = await decodeBody(chunk.bytes)
    await compress(chunk)
    const after = await decodeBody(chunk.bytes)
    expect(after.preamble.gzipped).toBe(true)
    expect(chunk.bytes.byteLength).toBeLessThan(BODY_PREAMBLE_BYTES + 50 * 200)
    expect(chunk.idempotencyKey).toBe(key)
    // The same frames either way, so whichever form an upload sends, ingest
    // decodes the same body.
    expect(after.records).toEqual(before.records)
  })

  it('never makes a body larger', async () => {
    const q = queue()
    q.json(ctrl(256))
    q.raw(crypto.getRandomValues(new Uint8Array(256)))
    const chunk = q.seal() as FlushChunk
    const before = chunk.bytes.byteLength
    await compress(chunk)
    expect(chunk.bytes.byteLength).toBeLessThanOrEqual(before)
  })
})

describe('FlushQueue.append and takeFrames', () => {
  it('appends frames another queue wrote, verbatim, counted as frames', async () => {
    const worker = queue()
    worker.json(ctrl(3))
    worker.raw(new Uint8Array([1, 2, 3]))
    const { frames, count } = worker.takeFrames()
    expect(count).toBe(2)
    expect(worker.frameCount).toBe(0)

    const page = queue()
    page.json(note('page'))
    expect(page.append(frames, count)).toBe(true)
    expect(page.frameCount).toBe(3)
    const body = await decodeBody((page.seal() as FlushChunk).bytes)
    expect(body.records.map((r) => r.t)).toEqual(['batch', 'note', 'ctrl'])
    expect(body.frames.at(-1)?.raw).toBe(true)
  })

  it('refuses a forward whole when it would pass the cap, so no pair is split', () => {
    const page = queue({ maxPendingBytes: 1024 })
    const w = new FrameWriter()
    w.json(note('big', 'x'.repeat(2048)))
    expect(page.append(w.take(), 1)).toBe(false)
    expect(page.frameCount).toBe(0)
  })
})

describe('FlushQueue under its own cap', () => {
  it('drops a ctrl record and its raw frame together, never the frame alone', async () => {
    const q = queue({ maxPendingBytes: 1024 })
    while (q.pendingBytes < 1024) q.json(note('filler', 'x'.repeat(64)))
    const framesBefore = q.frameCount

    q.json(ctrl(4))
    q.raw(new Uint8Array([9, 9, 9, 9]))

    expect(q.frameCount).toBe(framesBefore)
    expect(q.droppedRecords).toBe(2)

    const chunk = q.seal() as FlushChunk
    const body = await decodeBody(chunk.bytes)
    expect(body.frames.some((f) => f.raw)).toBe(false)
  })

  it('accepts records again once a seal has emptied the buffer', async () => {
    const q = queue({ maxPendingBytes: 1024 })
    while (q.pendingBytes < 1024) q.json(note('filler', 'x'.repeat(64)))
    q.json(note('refused'))
    expect(q.droppedRecords).toBe(1)

    q.seal()
    q.json(note('accepted'))
    const chunk = q.seal() as FlushChunk
    expect((await decodeBody(chunk.bytes)).records.map(nameOf)).toEqual([undefined, 'accepted'])
  })
})

/* ── the schedule ────────────────────────────────────────────── */

class FakeTimers implements TimerSource {
  now = 0
  #next = 1
  readonly #timers = new Map<number, { at: number; fn: () => void }>()

  setTimer(fn: () => void, ms: number): unknown {
    const id = this.#next++
    this.#timers.set(id, { at: this.now + ms, fn })
    return id
  }

  clearTimer(handle: unknown): void {
    this.#timers.delete(handle as number)
  }

  get pending(): number {
    return this.#timers.size
  }

  advance(ms: number): void {
    const target = this.now + ms
    for (;;) {
      let bestId: number | undefined
      let bestAt = Number.POSITIVE_INFINITY
      for (const [id, t] of this.#timers) {
        if (t.at <= target && t.at < bestAt) {
          bestId = id
          bestAt = t.at
        }
      }
      if (bestId === undefined) break
      const timer = this.#timers.get(bestId) as { at: number; fn: () => void }
      this.#timers.delete(bestId)
      this.now = timer.at
      timer.fn()
    }
    this.now = target
  }
}

const scheduleWith = (
  timers: FakeTimers,
  extra?: Partial<FlushScheduleOptions>,
): { schedule: FlushSchedule; fired: SealReason[] } => {
  const fired: SealReason[] = []
  const schedule = new FlushSchedule({
    onFlush: (r) => fired.push(r),
    byteThreshold: 32 * 1024,
    timers,
    ...extra,
  })
  return { schedule, fired }
}

describe('FlushSchedule', () => {
  it('is front-loaded then backs off: ready, +45 s, then every 60 s', () => {
    const timers = new FakeTimers()
    const { schedule, fired } = scheduleWith(timers)
    schedule.start(0)

    timers.advance(0)
    expect(fired).toEqual(['ready'])
    timers.advance(44_999)
    expect(fired).toEqual(['ready'])
    timers.advance(1)
    expect(fired).toEqual(['ready', 'early'])
    timers.advance(59_999)
    expect(fired).toHaveLength(2)
    timers.advance(1)
    expect(fired[2]).toBe('interval')
    timers.advance(60_000)
    expect(fired[3]).toBe('interval')
  })

  it('seals a ten-minute session eleven times before its tail, and never leaves a gap over 60 s', () => {
    // The schedule's defaults are DEFAULT_UPLOAD's. A steady session carries
    // little new information per interval, and the longest gap between seals
    // is what a crash with no pagehide tail loses.
    const timers = new FakeTimers()
    const at: number[] = []
    const schedule = new FlushSchedule({
      onFlush: () => at.push(timers.now),
      byteThreshold: 32 * 1024,
      timers,
    })
    schedule.start(0)
    for (let t = 0; t < 600_000; t += 1_000) timers.advance(1_000)

    expect(at).toEqual([
      0, 45_000, 105_000, 165_000, 225_000, 285_000, 345_000, 405_000, 465_000, 525_000, 585_000,
    ])
    const gaps = at.map((t, i) => (i === 0 ? t : t - (at[i - 1] as number)))
    expect(Math.max(...gaps, 600_000 - (at[at.length - 1] as number))).toBeLessThanOrEqual(60_000)
  })

  it('runs a configured multi-offset early phase before the interval', () => {
    const timers = new FakeTimers()
    const { schedule, fired } = scheduleWith(timers, { earlyFlushesMs: [15_000, 5_000] })
    schedule.start(0)

    timers.advance(0)
    timers.advance(5_000)
    timers.advance(10_000)
    expect(fired).toEqual(['ready', 'early', 'early'])
    timers.advance(59_999)
    expect(fired).toHaveLength(3)
    timers.advance(1)
    expect(fired[3]).toBe('interval')
  })

  it('seals on the byte threshold and restarts the interval, so it does not seal twice over', () => {
    // The early flushes are absolute offsets from `ready` and fire whatever the
    // byte counter does (asserted above), so they are configured away here to
    // leave the one interaction under test: "every 60 s **or** every 32 KB
    // accumulated, whichever comes first".
    const timers = new FakeTimers()
    const { schedule, fired } = scheduleWith(timers, { earlyFlushesMs: [] })
    schedule.start(0)
    timers.advance(0)
    fired.length = 0

    schedule.noteBytes(16 * 1024)
    timers.advance(1)
    expect(fired).toEqual([])

    schedule.noteBytes(16 * 1024)
    timers.advance(1)
    expect(fired).toEqual(['bytes'])

    // 60 s from the byte seal, not from start.
    timers.advance(59_000)
    expect(fired).toEqual(['bytes'])
    timers.advance(1_000)
    expect(fired).toEqual(['bytes', 'interval'])
  })

  it('never seals inside noteBytes, because a ctrl record and its raw frame are written as a pair', () => {
    const timers = new FakeTimers()
    const { schedule, fired } = scheduleWith(timers)
    schedule.start(0)
    timers.advance(0)
    fired.length = 0

    schedule.noteBytes(64 * 1024)
    expect(fired).toEqual([])
    timers.advance(0)
    expect(fired).toEqual(['bytes'])
  })

  it('holds its cadence indefinitely: stretching it is the pacer’s business, not the schedule’s', () => {
    const timers = new FakeTimers()
    const { schedule, fired } = scheduleWith(timers, { earlyFlushesMs: [], intervalMs: 1_000 })
    schedule.start(0)
    timers.advance(0)
    for (let i = 0; i < 10; i++) timers.advance(1_000)
    expect(fired.filter((r) => r === 'interval')).toHaveLength(10)
  })

  it('stop() silences timers that were already queued', () => {
    const timers = new FakeTimers()
    const { schedule, fired } = scheduleWith(timers)
    schedule.start(0)
    schedule.stop()
    timers.advance(200_000)
    expect(fired).toEqual([])
    expect(timers.pending).toBe(0)
  })

  it('counts the early flushes from the session being ready, not from start()', () => {
    const timers = new FakeTimers()
    const { schedule, fired } = scheduleWith(timers)
    schedule.start(0)
    timers.advance(30_000)
    expect(fired).toEqual(['ready'])

    schedule.ready(30_000)
    timers.advance(0)
    expect(fired).toEqual(['ready', 'ready'])
    timers.advance(44_999)
    expect(fired).toHaveLength(2)
    timers.advance(1)
    expect(fired[2]).toBe('early')

    // Once only: a second session does not restart the schedule.
    schedule.ready(80_000)
    timers.advance(0)
    expect(fired).toHaveLength(3)
  })

  it('start() is idempotent and cannot re-arm after stop()', () => {
    const timers = new FakeTimers()
    const { schedule, fired } = scheduleWith(timers)
    schedule.start(0)
    schedule.start(0)
    timers.advance(0)
    expect(fired).toEqual(['ready'])
    schedule.stop()
    schedule.start(0)
    timers.advance(200_000)
    expect(fired).toEqual(['ready'])
  })

  it('routes a throwing onFlush to onInternalError rather than into the timer', () => {
    const timers = new FakeTimers()
    const errors: unknown[] = []
    const schedule = new FlushSchedule({
      onFlush: () => {
        throw new Error('seal failed')
      },
      byteThreshold: 1,
      timers,
      onInternalError: (e) => errors.push(e),
    })
    schedule.start(0)
    expect(() => timers.advance(0)).not.toThrow()
    expect(errors).toHaveLength(1)
  })
})
