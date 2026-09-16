/**
 * Sealing — the schedule, and keying at creation.
 *
 * Every assertion below is a durability property, not a shape check:
 *
 *  - **The key is stamped before persistence.** A chunk built, keyed, persisted
 *    and then uploaded on the next page load dedupes correctly; one keyed at
 *    upload time gets a fresh key and is ingested twice. So the tests reload the
 *    store and check the key that comes back, not the key the queue computed.
 *  - **A segment number is never reissued.** Ingest dedupes exactly on
 *    `sha256(sessionId:segmentSeq)`, so two different bodies under one key means
 *    one is silently discarded — data lost with no error anywhere.
 *  - **A `ctrl`/`hdr` record and its raw frame live or die together.** A raw
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
  idempotencyKey,
  idempotencyKeySync,
  readFrames,
  readPreamble,
  subtleAvailable,
} from '../../envelope/index.js'
import type {
  ChunkBackend,
  Chunk as FlushChunk,
  FlushScheduleOptions,
  TimerSource,
} from '../../flush/index.js'
import { ChunkStore, FlushQueue, FlushSchedule, MemoryBackend } from '../../flush/index.js'
import type {
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
  ts: 0,
  lvl: 'baseline',
  dir: 'rx',
  streamId: 1,
  n,
  decoded: true,
})

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

const expectedKey = async (sessionId: string, seq: number): Promise<string> =>
  subtleAvailable() ? await idempotencyKey(sessionId, seq) : idempotencyKeySync(sessionId, seq)

/** Delegates to a real backend, with one hook. Used to make a seal observably slow. */
const gatedBackend = (inner: ChunkBackend, gate: () => Promise<void>): ChunkBackend => ({
  durable: inner.durable,
  loadIndex: () => inner.loadIndex(),
  put: (e, c) => inner.put(e, c),
  get: (k) => inner.get(k),
  remove: (k) => inner.remove(k),
  getMeta: async (id) => {
    await gate()
    return inner.getMeta(id)
  },
  setMeta: (m) => inner.setMeta(m),
  listMeta: () => inner.listMeta(),
  removeMeta: (id) => inner.removeMeta(id),
  close: () => inner.close(),
})

/* ── the sealed body ─────────────────────────────────────────────────────── */

describe('FlushQueue.seal', () => {
  it('produces a body ingest can read: preamble, batch frame first, then the records in order', async () => {
    const q = new FlushQueue({ sessionId: 's1', clock: clockAt(), gzip: false })
    q.json(note('one'))
    q.json(ctrl(3))
    q.raw(new Uint8Array([1, 2, 3]))
    q.json(note('two'))

    const chunk = await q.seal('interval')
    expect(chunk).not.toBeNull()
    const body = await decodeBody((chunk as FlushChunk).bytes)

    expect(body.preamble.version).toBe(1)
    expect(body.frames.map((f) => f.raw)).toEqual([false, false, false, true, false])
    expect(body.records.map((r) => r.t)).toEqual(['batch', 'note', 'ctrl', 'note'])
    expect(body.frames[3]?.payload).toEqual(new Uint8Array([1, 2, 3]))
  })

  it('carries the idempotency key in the first frame, because sendBeacon cannot set a header', async () => {
    const q = new FlushQueue({ sessionId: 'sess-1', clock: clockAt(), gzip: false })
    q.json(note('one'))
    const chunk = (await q.seal('interval')) as FlushChunk
    const body = await decodeBody(chunk.bytes)

    expect(body.records[0]).toMatchObject({
      t: 'batch',
      sessionId: 'sess-1',
      segmentSeq: 0,
      idempotencyKey: chunk.idempotencyKey,
      v: 1,
    })
    expect(chunk.idempotencyKey).toBe(await expectedKey('sess-1', 0))
  })

  it('returns null when there is nothing to seal, rather than an empty keyed body', async () => {
    const q = new FlushQueue({ sessionId: 's1', gzip: false })
    expect(await q.seal('interval')).toBeNull()
    expect(q.sealedChunks).toBe(0)
  })

  it('gzips the frames and says so in the preamble, which is how the beacon path announces it', async () => {
    const q = new FlushQueue({ sessionId: 's1', clock: clockAt(), gzip: true })
    for (let i = 0; i < 200; i++) {
      q.json(note(`repeated-name-${i % 3}`, 'the same compressible payload'))
    }
    const chunk = (await q.seal('interval')) as FlushChunk
    const body = await decodeBody(chunk.bytes)

    expect(body.preamble.gzipped).toBe(true)
    expect(body.records).toHaveLength(201)
    expect(body.records[0]?.t).toBe('batch')
  })

  it('numbers segments consecutively in memory and never repeats a key', async () => {
    const q = new FlushQueue({ sessionId: 's1', gzip: false })
    const keys: string[] = []
    for (let i = 0; i < 3; i++) {
      q.json(note(`n${i}`))
      const c = (await q.seal('interval')) as FlushChunk
      expect(c.segmentSeq).toBe(i)
      keys.push(c.idempotencyKey)
    }
    expect(new Set(keys).size).toBe(3)
  })

  it('stamps the level and the wall clock the chunk was created at', async () => {
    const clock = clockAt(500)
    const q = new FlushQueue({
      sessionId: 's1',
      clock,
      gzip: false,
      level: () => 'headers+data',
    })
    q.json(note('n'))
    const c = (await q.seal('bytes')) as FlushChunk
    expect(c.level).toBe('headers+data')
    expect(c.createdWallMs).toBe(clock.wall())
    expect(q.lastSealReason).toBe('bytes')
  })
})

/* ── keyed before persistence ────────────────────────────────── */

describe('FlushQueue with a store', () => {
  it('persists the chunk under the key it was stamped with, before it is ever uploaded', async () => {
    const backend = new MemoryBackend()
    const store = await ChunkStore.open('db', 1 << 20, { backend })
    const q = new FlushQueue({ sessionId: 's1', store, gzip: false })
    q.json(note('one'))
    const chunk = (await q.seal('interval')) as FlushChunk

    const persisted = await store.list('s1')
    expect(persisted).toHaveLength(1)
    expect(persisted[0]?.idempotencyKey).toBe(chunk.idempotencyKey)
    expect(persisted[0]?.segmentSeq).toBe(chunk.segmentSeq)
    expect(persisted[0]?.bytes).toEqual(chunk.bytes)
  })

  it('keeps a persisted chunk keyed across a reload, and never reissues its number', async () => {
    const backend = new MemoryBackend()
    const before = await ChunkStore.open('db', 1 << 20, { backend })
    const q1 = new FlushQueue({ sessionId: 's1', store: before, gzip: false })
    q1.json(note('before-reload'))
    const first = (await q1.seal('interval')) as FlushChunk

    // The page reloads: same origin storage, brand new store and queue.
    const after = await ChunkStore.open('db', 1 << 20, { backend })
    const backlog = await after.list('s1')
    expect(backlog).toHaveLength(1)
    expect(backlog[0]?.idempotencyKey).toBe(first.idempotencyKey)
    expect(backlog[0]?.bytes).toEqual(first.bytes)

    const q2 = new FlushQueue({ sessionId: 's1', store: after, gzip: false })
    q2.json(note('after-reload'))
    const second = (await q2.seal('interval')) as FlushChunk
    expect(second.segmentSeq).toBeGreaterThan(first.segmentSeq)
    expect(second.idempotencyKey).not.toBe(first.idempotencyKey)
  })

  it('gives two overlapping seals two different segment numbers', async () => {
    const backend = new MemoryBackend()
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => {
      release = r
    })
    let gated = false
    const store = await ChunkStore.open('db', 1 << 20, {
      backend: gatedBackend(backend, async () => {
        if (gated) await gate
      }),
    })
    const q = new FlushQueue({ sessionId: 's1', store, gzip: false })

    gated = true
    q.json(note('first'))
    const p1 = q.seal('interval')
    await Promise.resolve()
    // The first seal has taken its frames and is waiting on its allocation.
    q.json(note('second'))
    const p2 = q.seal('interval')
    release()

    const [a, b] = (await Promise.all([p1, p2])) as [FlushChunk, FlushChunk]
    expect(a.segmentSeq).not.toBe(b.segmentSeq)
    expect(a.idempotencyKey).not.toBe(b.idempotencyKey)

    expect((await decodeBody(a.bytes)).records.map(nameOf)).toEqual([undefined, 'first'])
    expect((await decodeBody(b.bytes)).records.map(nameOf)).toEqual([undefined, 'second'])
  })

  it('never throws out of seal when the store refuses the write', async () => {
    const backend = new MemoryBackend()
    const failing: ChunkBackend = {
      ...gatedBackend(backend, () => Promise.resolve()),
      put: () => Promise.reject(new Error('QuotaExceededError')),
    }
    const errors: unknown[] = []
    const store = await ChunkStore.open('db', 1 << 20, {
      backend: failing,
      onInternalError: (e) => errors.push(e),
    })
    const q = new FlushQueue({ sessionId: 's1', store, gzip: false })
    q.json(note('one'))
    const chunk = await q.seal('interval')

    // The chunk is still returned: durability was lost, the telemetry was not.
    expect(chunk).not.toBeNull()
    expect(q.droppedChunks).toBe(0)
    expect(errors.length).toBeGreaterThan(0)
  })
})

/* ── the pagehide path ───────────────────────────────────────── */

describe('FlushQueue.sealSync', () => {
  it('keys without awaiting and never compresses, because the page may not survive one await', () => {
    const q = new FlushQueue({ sessionId: 's1', clock: clockAt(), gzip: true })
    q.json(note('tail'))
    const chunk = q.sealSync('pagehide') as FlushChunk

    expect(chunk.idempotencyKey).toBe(idempotencyKeySync('s1', chunk.segmentSeq))
    expect(readPreamble(chunk.bytes)?.gzipped).toBe(false)
  })

  it('marks keyFallback in the batch frame so ingest is told, not left to guess', async () => {
    const q = new FlushQueue({ sessionId: 's1', clock: clockAt(), gzip: true })
    q.json(note('tail'))
    const chunk = q.sealSync('pagehide') as FlushChunk
    const body = await decodeBody(chunk.bytes)
    expect(body.records[0]).toMatchObject({ t: 'batch', keyFallback: true })
    expect(body.records.map(nameOf)).toEqual([undefined, 'tail'])
  })

  it('returns null with nothing buffered', () => {
    const q = new FlushQueue({ sessionId: 's1' })
    expect(q.sealSync('pagehide')).toBeNull()
  })

  it('does not reuse a number the async path already took', async () => {
    const q = new FlushQueue({ sessionId: 's1', gzip: false })
    q.json(note('a'))
    const first = (await q.seal('interval')) as FlushChunk
    q.json(note('b'))
    const tail = q.sealSync('pagehide') as FlushChunk
    expect(tail.segmentSeq).toBeGreaterThan(first.segmentSeq)
  })

  it('raises the persisted counter so a reload cannot reissue the number it took', async () => {
    const backend = new MemoryBackend()
    const store = await ChunkStore.open('db', 1 << 20, { backend })
    const q = new FlushQueue({ sessionId: 's1', store, gzip: false })
    q.json(note('tail'))
    const tail = q.sealSync('pagehide') as FlushChunk

    // Let the fire-and-forget raise land, then reload.
    await new Promise((r) => setTimeout(r, 0))
    const after = await ChunkStore.open('db', 1 << 20, { backend })
    expect(await after.nextSegmentSeq('s1')).toBeGreaterThan(tail.segmentSeq)
  })
})

/* ── the overrun policy ───────────────────────────────────────────── */

describe('FlushQueue under its own cap', () => {
  it('drops a ctrl record and its raw frame together, never the frame alone', async () => {
    const q = new FlushQueue({ sessionId: 's1', gzip: false, maxPendingBytes: 1024 })
    while (q.pendingBytes < 1024) q.json(note('filler', 'x'.repeat(64)))
    const framesBefore = q.frameCount

    q.json(ctrl(4))
    q.raw(new Uint8Array([9, 9, 9, 9]))

    expect(q.frameCount).toBe(framesBefore)
    expect(q.droppedRecords).toBe(2)

    const chunk = (await q.seal('interval')) as FlushChunk
    const body = await decodeBody(chunk.bytes)
    expect(body.frames.some((f) => f.raw)).toBe(false)
  })

  it('accepts records again once a seal has emptied the buffer', async () => {
    const q = new FlushQueue({ sessionId: 's1', gzip: false, maxPendingBytes: 1024 })
    while (q.pendingBytes < 1024) q.json(note('filler', 'x'.repeat(64)))
    q.json(note('refused'))
    expect(q.droppedRecords).toBe(1)

    await q.seal('interval')
    q.json(note('accepted'))
    const chunk = (await q.seal('interval')) as FlushChunk
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
  it('is front-loaded then backs off: ready, +5 s, +15 s, +45 s, then every 60 s', () => {
    const timers = new FakeTimers()
    const { schedule, fired } = scheduleWith(timers)
    schedule.start(0)

    timers.advance(0)
    expect(fired).toEqual(['ready'])
    timers.advance(5_000)
    timers.advance(10_000)
    timers.advance(30_000)
    expect(fired).toEqual(['ready', 'early', 'early', 'early'])
    timers.advance(59_999)
    expect(fired).toHaveLength(4)
    timers.advance(1)
    expect(fired[4]).toBe('interval')
    timers.advance(60_000)
    expect(fired[5]).toBe('interval')
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
