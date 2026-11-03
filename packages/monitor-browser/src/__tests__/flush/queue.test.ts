/**
 * Sealing — the schedule, and keying at the seal.
 *
 * Every assertion below is a durability property, not a shape check:
 *
 *  - **A seal is synchronous and numbers only what it seals.** The sequence is
 *    the emitter's own, in memory, taken only when there is something to
 *    seal, so the bodies of one emitter are `0, 1, 2, …` with no gap a seal
 *    could leave, and every record's `rseq` is in exactly one body's `em`.
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
  deflateSegment,
  FrameWriter,
  idempotencyKey,
  readFrames,
  readPreamble,
} from '../../envelope/index.js'
import { openSegment } from '../../envelope/open-segment.js'
import type { Chunk as FlushChunk, FlushScheduleOptions, TimerSource } from '../../flush/index.js'
import { compress, Emitter, FlushQueue, FlushSchedule } from '../../flush/index.js'
import type { Taken } from '../../rollup/runs.js'
import type {
  BatchRecord,
  ClockSource,
  CtrlRecord,
  EnvelopeRecord,
  NoteRecord,
  SealReason,
} from '../../types.js'
import { factsOf } from '../support/runs.js'
import { afterPreamble, preambleOf } from '../support/uploads.js'

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

const queue = (
  over: Partial<ConstructorParameters<typeof FlushQueue>[0]> & { instanceId?: string } = {},
): FlushQueue =>
  new FlushQueue({ sessionId: 's1', emitter: new Emitter(over.instanceId ?? 'i1', 0), ...over })

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
  readonly head: ReturnType<typeof preambleOf>
  readonly frames: readonly { raw: boolean; payload: Uint8Array }[]
  readonly records: readonly EnvelopeRecord[]
}

/** Read a sealed body exactly as ingest would: preamble, then frames. */
const decodeBody = async (bytes: Uint8Array): Promise<DecodedBody> => {
  const preamble = readPreamble(bytes)
  if (preamble === null) throw new Error('body has no preamble')
  const raw = afterPreamble(bytes)
  const frameBytes = preamble.gzipped ? await gunzip(raw) : raw
  const frames = [...readFrames(frameBytes)]
  const decoder = new TextDecoder()
  const records = frames
    .filter((f) => !f.raw)
    .map((f) => JSON.parse(decoder.decode(f.payload)) as EnvelopeRecord)
  return { preamble, head: preambleOf(bytes), frames, records }
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
    const q = queue({ clock, level: () => 'headers', droppedRecords: () => 7 })
    q.json(note('a'))
    const chunk = q.seal() as FlushChunk
    const batch = await batchOf(chunk)
    expect(batch).toEqual({
      t: 'batch',
      v: 2,
      sessionId: 's1',
      instanceId: 'i1',
      seq: 0,
      idempotencyKey: idempotencyKey('s1', 'i1', 0),
      final: false,
      lvl: 'headers',
      clk: { base_us: 0, epoch: 0, res_us: 1_000_000 },
      tail: { last_rseq: 0, pre_drop: { records: 7, objects: 0 }, conn: [] },
      conn: [],
      trk: [],
    })
    expect(chunk).toMatchObject({ sessionId: 's1', instanceId: 'i1', seq: 0, level: 'headers' })
  })

  it('opens with the preamble: the claim, the rseq ranges and the sealed interval', async () => {
    const clock = clockAt(2_500)
    const q = queue({ clock, sealMs: () => 15_000 })
    q.json(note('a'))
    q.json(note('b'))
    const first = await decodeBody((q.seal() as FlushChunk).bytes)
    expect(first.head).toEqual({
      v: 2,
      i: 'i1',
      em: [[0, 2]],
      seal: { seq: 0, from_us: 0, through_us: 2_500_000, ms: 15_000 },
    })
    expect(first.records.slice(1).map((r) => ('rseq' in r ? r.rseq : undefined))).toEqual([0, 1])
    clock.t = 4_000
    q.json(note('c'))
    const second = await decodeBody((q.seal() as FlushChunk).bytes)
    expect(second.head.em).toEqual([[2, 1]])
    expect(second.head.seal).toEqual({
      seq: 1,
      from_us: 2_500_000,
      through_us: 4_000_000,
      ms: 15_000,
    })
  })

  it('marks the final body', async () => {
    const q = queue()
    q.json(note('a'))
    expect((await batchOf(q.seal() as FlushChunk)).final).toBe(false)
    q.json(note('b'))
    expect((await batchOf(q.seal({ final: true }) as FlushChunk)).final).toBe(true)
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

  it('buffers runs as records, each body listing only the tracks its own records name', async () => {
    const key = Object.freeze({ dir: 'rx' as const, kind: 'alias' as const, id: 4n, epoch: 0 })
    const facts: Taken = {
      runs: [
        {
          flow: '0:3:7',
          c: 0,
          key,
          path: 'sub_stream',
          g: 7n,
          sub: 0n,
          sid: 3,
          o0: 0n,
          ids: null,
          n: 2,
          last: 1n,
          osub: null,
          times: [1_000, 2_000],
          b: 10,
          tl: 2_500,
          cont: false,
          fo: false,
          foKnown: false,
          eog: false,
          end: 'open',
          rc: null,
        },
      ],
      marks: [],
      ends: [],
    }
    const e = new Emitter('i1', 0)
    e.noteConn(0, 20, 'https://relay.example')
    const q = new FlushQueue({ sessionId: 's1', emitter: e })
    q.json(note('a'))
    q.writeFacts(facts)
    const body = await decodeBody((q.seal() as FlushChunk).bytes)
    expect(body.records.map((r) => r.t as string)).toEqual(['batch', 'note', 'run'])
    expect(body.head.em).toEqual([[0, 2]])
    const batch = body.records[0] as BatchRecord
    expect(batch.clk.base_us).toBe(0)
    expect(batch.trk).toEqual([{ id: 0, key: { d: 'rx', k: 'alias', v: '4', e: 0 } }])
    expect(batch.conn).toEqual([{ c: 0, draft: 20, relay: 'https://relay.example' }])
    expect(batch.tail.conn).toEqual([[0, 2, 10]])
    // A later body with no run lists no track.
    q.json(note('b'))
    const next = await decodeBody((q.seal() as FlushChunk).bytes)
    expect((next.records[0] as BatchRecord).trk).toEqual([])
  })

  it('lists a closed connection in every body its buffered records reach, split or not', async () => {
    const key = Object.freeze({ dir: 'rx' as const, kind: 'alias' as const, id: 4n, epoch: 0 })
    const run = (g: bigint): Taken['runs'][number] => ({
      flow: `0:3:${g}`,
      c: 0,
      key,
      path: 'sub_stream',
      g,
      sub: 0n,
      sid: 3,
      o0: 0n,
      ids: null,
      n: 1,
      last: 0n,
      osub: null,
      times: [1_000],
      b: 10,
      tl: 1_000,
      cont: false,
      fo: false,
      foKnown: false,
      eog: false,
      end: 'fin',
      rc: null,
    })
    const e = new Emitter('i1', 0)
    e.noteConn(0, 20, 'https://relay.example')
    const q = new FlushQueue({ sessionId: 's1', emitter: e })
    for (let i = 0; i < 200; i++) {
      q.json({ ...ctrl(4), c: 0 } as EnvelopeRecord)
      q.raw(new Uint8Array(4))
    }
    e.noteConnClosed(0)
    q.writeFacts({ runs: [run(1n), run(2n)], marks: [], ends: [] })
    const bodies: FlushChunk[] = []
    for (let c = q.sealFront(4096); c !== null; c = q.sealFront(4096)) bodies.push(c)
    expect(bodies.length).toBeGreaterThan(1)
    for (const chunk of bodies) {
      const body = await decodeBody(chunk.bytes)
      const declared = new Set((body.records[0] as BatchRecord).conn.map((c) => c.c))
      const named = body.records.flatMap((r) => ('c' in r && typeof r.c === 'number' ? [r.c] : []))
      const { runs } = await factsOf(chunk.bytes)
      for (const c of [...named, ...runs.map((r) => r.c)]) expect(declared.has(c)).toBe(true)
    }
    // Everything sealed: the next body lists it no more.
    q.json(note('after'))
    expect((await batchOf(q.seal() as FlushChunk)).conn).toEqual([])
  })

  it('frees a track id once no buffered record names it, so ids stay small over a long page', async () => {
    const run = (id: bigint): Taken => ({
      runs: [
        {
          flow: `0:3:${id}`,
          c: 0,
          key: Object.freeze({ dir: 'tx' as const, kind: 'fetch' as const, id, epoch: 0 }),
          path: 'fetch',
          g: 1n,
          sub: null,
          sid: 3,
          o0: 0n,
          ids: null,
          n: 1,
          last: 0n,
          osub: [0n],
          times: [1_000],
          b: 1,
          tl: 1_000,
          cont: false,
          fo: false,
          foKnown: false,
          eog: false,
          end: 'fin',
          rc: null,
        },
      ],
      marks: [],
      ends: [],
    })
    const e = new Emitter('i1', 0)
    e.noteConn(0, 20, 'https://relay.example')
    const q = new FlushQueue({ sessionId: 's1', emitter: e })
    const trk = async (c: FlushChunk) => (await batchOf(c)).trk
    // Buffered together: one id per key, the same key the same id.
    q.writeFacts(run(1n))
    q.writeFacts(run(2n))
    q.writeFacts(run(1n))
    expect((await trk(q.seal() as FlushChunk)).map((t) => [t.id, t.key.v])).toEqual([
      [0, '1'],
      [1, '2'],
    ])
    let most = 0
    for (let i = 3n; i < 70_003n; i++) {
      q.writeFacts(run(i))
      const [t] = await trk(q.sealFront(1 << 20) as FlushChunk)
      most = Math.max(most, t!.id)
    }
    expect(most).toBeLessThanOrEqual(1)
  }, 30_000)

  it('cuts records at the tracks a body lists, and seals before a record would list one too many', async () => {
    const run = (id: number, c = 0): Taken['runs'][number] => ({
      flow: `${c}:3:${id}`,
      c,
      key: Object.freeze({ dir: 'rx' as const, kind: 'alias' as const, id: BigInt(id), epoch: 0 }),
      path: 'sub_stream',
      g: 1n,
      sub: 0n,
      sid: 3,
      o0: 0n,
      ids: null,
      n: 1,
      last: 0n,
      osub: null,
      times: [1_000],
      b: 1,
      tl: 1_000,
      cont: false,
      fo: false,
      foKnown: true,
      eog: false,
      end: 'fin',
      rc: null,
    })
    const take = (from: number, n: number): Taken => ({
      runs: Array.from({ length: n }, (_, i) => run(from + i)),
      marks: [],
      ends: [],
    })
    const e = new Emitter('i1', 0)
    e.noteConn(0, 20, 'https://relay.example')
    const q = new FlushQueue({ sessionId: 's1', emitter: e })
    const bodies: FlushChunk[] = []
    const full = (): void => {
      bodies.push(q.seal() as FlushChunk)
    }
    q.writeFacts(take(0, 1_000), full)
    expect(bodies).toHaveLength(0)
    q.writeFacts(take(1_000, 100), full)
    expect(bodies).toHaveLength(1)
    q.writeFacts(take(5_000, 2_100), full)
    bodies.push(q.seal() as FlushChunk)
    let total = 0
    for (const b of bodies) {
      const batch = await batchOf(b)
      expect(batch.trk.length).toBeLessThanOrEqual(1_024)
      expect(Math.max(...batch.trk.map((t) => t.id))).toBeLessThan(65_536)
      const facts = await factsOf(b.bytes)
      for (const r of facts.runs) expect(batch.trk.some((t) => t.id === r.ti)).toBe(true)
      total += facts.runs.length
    }
    expect(total).toBe(3_200)
    // 1,000; 100; then 2,100 cut into 1,024, 1,024 and 52, each past what the open body holds.
    expect(bodies.length).toBe(5)
  })

  it('lists a connection with no known draft without one, and keeps a stated draft', async () => {
    const e = new Emitter('i1', 0)
    e.noteConn(0, null, 'https://relay.example')
    const q = new FlushQueue({ sessionId: 's1', emitter: e })
    q.json({ t: 'note', ts: 0, lvl: 'baseline', name: 'a', data: null })
    expect((await batchOf(q.seal() as FlushChunk)).conn).toEqual([
      { c: 0, relay: 'https://relay.example' },
    ])
    e.noteConn(0, 14, 'https://relay.example')
    e.noteConnClosed(0)
    e.noteConn(0, null, 'https://relay.example')
    q.json({ t: 'note', ts: 0, lvl: 'baseline', name: 'b', data: null })
    expect((await batchOf(q.seal() as FlushChunk)).conn).toEqual([
      { c: 0, draft: 14, relay: 'https://relay.example' },
    ])
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

describe("FlushQueue.sealSegment with the open stream's own front", () => {
  it('seals the gzipped front as one body and keeps the frames after it for the next', async () => {
    const q = queue()
    q.json(note('a'))
    q.json(ctrl(2))
    q.raw(new Uint8Array([7, 8]))
    const front = { bytes: q.pendingBytes, count: q.frameCount }
    const segment = await deflateSegment(q.peek().slice())
    const takes = q.takes
    // Written while the front was being compressed.
    q.json(note('b'))

    const packed = q.sealSegment(segment, {}, front)
    expect(q.takes).not.toBe(takes)
    const body = await decodeBody(packed.bytes)
    expect(body.head.em).toEqual([[0, 2]])
    expect(body.preamble.gzipped).toBe(true)
    expect(body.records.map((r) => r.t)).toEqual(['batch', 'note', 'ctrl'])
    expect(body.frames.at(-1)?.raw).toBe(true)
    expect(await batchOf(packed)).toMatchObject({ seq: 0 })

    const rest = q.seal() as FlushChunk
    expect((await decodeBody(rest.bytes)).records.map(nameOf)).toEqual([undefined, 'b'])
    expect(await batchOf(rest)).toMatchObject({ seq: 1 })
  })

  it('refuses a pack that does not describe the front', async () => {
    const q = queue()
    q.json(note('a'))
    const segment = await deflateSegment(q.peek().slice())
    expect(() => q.sealSegment(segment, {}, { bytes: q.pendingBytes + 1, count: 1 })).toThrow()
    expect(() => q.sealSegment(segment, {}, { bytes: q.pendingBytes, count: 2 })).toThrow()
    expect(q.frameCount).toBe(1)
    expect(q.nextSeq).toBe(0)
  })
})

describe('FlushQueue.sealSegment with the rest stored behind the front', () => {
  it('seals the gzipped front and every frame after it as one body', async () => {
    const q = queue()
    q.json(note('a'))
    q.json(ctrl(2))
    q.raw(new Uint8Array([7, 8]))
    const front = { bytes: q.pendingBytes, count: q.frameCount }
    const segment = openSegment(await deflateSegment(q.peek().slice()))
    q.json(note('b'))
    q.json(note('c'))

    const body = q.sealSegment(segment, { final: true }, front, true)
    expect(q.frameCount).toBe(0)
    expect(q.pendingBytes).toBe(0)
    const decoded = await decodeBody(body.bytes)
    expect(decoded.preamble.gzipped).toBe(true)
    expect(decoded.records.map(nameOf)).toEqual([undefined, 'a', undefined, 'b', 'c'])
    expect(await batchOf(body)).toMatchObject({ seq: 0, final: true })
    expect(q.seal()).toBeNull()
  })

  it('refuses a front longer than the stream, taking nothing', async () => {
    const q = queue()
    q.json(note('a'))
    const segment = openSegment(await deflateSegment(q.peek().slice()))
    expect(() =>
      q.sealSegment(segment, {}, { bytes: q.pendingBytes + 1, count: 1 }, true),
    ).toThrow()
    expect(q.frameCount).toBe(1)
    expect(q.nextSeq).toBe(0)
  })
})

describe('FlushQueue.sealFront', () => {
  it('seals about the bytes asked for, cut in front of a record, and keeps the rest', async () => {
    const q = queue()
    for (let i = 0; i < 20; i += 1) {
      q.json(note(`n${i}`, 'x'.repeat(100)))
      q.raw(new Uint8Array(50))
    }
    const total = q.frameCount
    const first = q.sealFront(1_000) as FlushChunk
    const rest = q.frameCount
    expect(rest).toBeGreaterThan(0)
    expect(rest).toBeLessThan(total)
    const decoded = await decodeBody(first.bytes)
    expect(decoded.frames.length - 1).toBe(total - rest)
    expect(decoded.frames.at(-1)?.raw).toBe(true)
    expect(first.bytes.byteLength).toBeLessThan(1_000 + 600)

    const last = q.sealFront(1e9, { final: true }) as FlushChunk
    expect(await batchOf(last)).toMatchObject({ seq: 1, final: true })
    expect(q.frameCount).toBe(0)
    expect(q.sealFront(1_000)).toBeNull()
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

  it('drops a byte seal still queued when the caller seals on its own account first', () => {
    const timers = new FakeTimers()
    const { schedule, fired } = scheduleWith(timers, { earlyFlushesMs: [] })
    schedule.start(0)
    timers.advance(0)
    fired.length = 0

    schedule.due()
    schedule.sealed()
    timers.advance(1)
    expect(fired).toEqual([])

    // Asked again, it seals again.
    schedule.due()
    timers.advance(1)
    expect(fired).toEqual(['bytes'])
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

describe('FlushSchedule.shorten, while ingest asks for a live view', () => {
  /** Armed past the early flush, so only the interval is left. */
  function steady(): { timers: FakeTimers; schedule: FlushSchedule; fired: SealReason[] } {
    const timers = new FakeTimers()
    const { schedule, fired } = scheduleWith(timers, { earlyFlushesMs: [] })
    schedule.start(0)
    timers.advance(0)
    fired.length = 0
    return { timers, schedule, fired }
  }

  it('seals on the shorter interval for as long as asked, then on the configured one', () => {
    const { timers, schedule, fired } = steady()
    timers.advance(10_000)
    schedule.shorten(2_000, 7_000)
    timers.advance(6_999)
    expect(fired).toEqual(['interval', 'interval', 'interval'])
    timers.advance(1)
    // Its end rearms the configured interval from there.
    timers.advance(59_999)
    expect(fired).toHaveLength(3)
    timers.advance(1)
    expect(fired).toHaveLength(4)
  })

  it('holds until the later end when asked again, without restarting the beat', () => {
    const { timers, schedule, fired } = steady()
    schedule.shorten(2_000, 5_000)
    timers.advance(1_000)
    schedule.shorten(2_000, 6_000)
    timers.advance(1_000)
    expect(fired).toEqual(['interval'])
    // Past the first end, at 5 s, and up to the second, at 7 s.
    timers.advance(4_000)
    expect(fired).toHaveLength(3)
    timers.advance(2_000)
    expect(fired).toHaveLength(3)
  })

  it('never lengthens the configured interval', () => {
    const timers = new FakeTimers()
    const { schedule, fired } = scheduleWith(timers, { earlyFlushesMs: [], intervalMs: 3_000 })
    schedule.start(0)
    timers.advance(0)
    schedule.shorten(10_000, 30_000)
    timers.advance(9_000)
    expect(fired.filter((r) => r === 'interval')).toHaveLength(3)
  })

  it('does nothing once stopped, and leaves no timer behind', () => {
    const { timers, schedule } = steady()
    schedule.shorten(2_000, 60_000)
    schedule.stop()
    expect(timers.pending).toBe(0)
    schedule.shorten(2_000, 60_000)
    expect(timers.pending).toBe(0)
  })
})
