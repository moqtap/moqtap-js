/**
 * The batch record's `clock`: the device's wall clock against ingest's, from
 * the upload exchanges of the last ten minutes.
 *
 * `../rollup/fixtures/group-arrivals.json` holds, for each run of exchanges,
 * the `clock` a body sealed after them carries and what it reads as; a produced body must carry that field exactly.
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { BODY_PREAMBLE_BYTES, readFrames } from '../../envelope/index.js'
import {
  CLOCK_TICK_MS,
  CLOCK_WINDOW_MS,
  ClockSync,
  DRIFT,
  FlushQueue,
  RECV_HEADER,
  SEND_HEADER,
  Uploader,
} from '../../flush/index.js'
import type { BatchClock, BatchRecord, ClockSource, NoteRecord } from '../../types.js'

interface Exchange {
  readonly t1: number
  readonly t2: number
  readonly t3: number
  readonly t4: number
  readonly mono: number
}

interface GoldenClock {
  readonly name: string
  readonly note: string
  readonly exchanges: readonly Exchange[]
  readonly seal: { readonly wall: number; readonly mono: number }
  readonly clock: BatchClock | null
  readonly read: BatchClock | null
}

const golden = JSON.parse(
  readFileSync(new URL('../rollup/fixtures/group-arrivals.json', import.meta.url), 'utf8'),
) as { clocks: GoldenClock[] }

const note: NoteRecord = { t: 'note', ts: 0, lvl: 'baseline', name: 'n', data: 'x' }

/** The batch record of a body sealed with `serverClock`. */
function sealedBatch(serverClock: () => BatchClock | undefined): BatchRecord {
  const q = new FlushQueue({ sessionId: 's1', instanceId: 'i1', serverClock })
  q.json(note)
  const bytes = q.seal()!.bytes
  const [first] = readFrames(bytes.subarray(BODY_PREAMBLE_BYTES))
  return JSON.parse(new TextDecoder().decode(first!.payload)) as BatchRecord
}

describe('clock against the expected fields', () => {
  it('has cases', () => {
    expect(golden.clocks.length).toBeGreaterThan(0)
  })

  for (const c of golden.clocks) {
    it(`${c.name}: ${c.note}`, async () => {
      // Each exchange through the uploader: wall at t1 and t4, monotonic at t4.
      const walls = c.exchanges.flatMap((e) => [e.t1, e.t4])
      const monos = c.exchanges.map((e) => e.mono)
      const clock: ClockSource = { now: () => monos.shift()!, wall: () => walls.shift()! }
      let n = 0
      const fetchImpl = (async () => {
        const e = c.exchanges[n++]!
        return new Response(null, {
          status: 202,
          headers: { [RECV_HEADER]: String(e.t2), [SEND_HEADER]: String(e.t3) },
        })
      }) as typeof fetch
      const u = new Uploader({ endpoint: 'https://ingest.example', apiKey: 'k', fetchImpl, clock })
      for (let i = 0; i < c.exchanges.length; i++) {
        const out = await u.send({
          sessionId: 's1',
          instanceId: 'i1',
          seq: i,
          idempotencyKey: `key-${i}`,
          createdWallMs: 0,
          bytes: new Uint8Array([1]),
          level: 'baseline',
          attempts: 0,
        })
        expect(out.ok).toBe(true)
      }

      const batch = sealedBatch(() => u.clockSync.best(c.seal.wall, c.seal.mono))
      if (c.clock === null) {
        expect(batch).not.toHaveProperty('clock')
      } else {
        expect(batch.clock).toEqual(c.clock)
      }
      expect(batch.clock ?? null).toEqual(c.read)
    })
  }
})

describe('ClockSync', () => {
  it('computes offset and round trip from the four timestamps', () => {
    const s = new ClockSync()
    // Device 5 s behind ingest, 20 ms each way, 2 ms at ingest.
    s.sample(1_000, 6_020, 6_022, 1_042, 1_042)
    expect(s.best(1_042, 1_042)).toEqual({ o: 5_000, r: 40, n: 1, a: 0 })
  })

  it('keeps the smallest bound, not the smallest round trip', () => {
    const s = new ClockSync()
    s.sample(0, 5, 5, 10, 10)
    const later = 10 + 9 * 60_000
    s.sample(later - 30, later - 10, later - 10, later, later)
    // Bounds: 5 + 54 ms against 15 ms, so the newer one.
    expect(s.best(later, later)).toMatchObject({ r: 30, n: 2, a: 0 })

    const fresh = new ClockSync()
    fresh.sample(0, 5, 5, 10, 10)
    fresh.sample(10, 25, 25, 40, 40)
    expect(fresh.best(40, 40)?.r).toBe(10)
  })

  it('uses 100 ppm for the drift', () => {
    expect(DRIFT).toBe(100e-6)
  })

  it('expires samples older than ten minutes', () => {
    const s = new ClockSync()
    s.sample(0, 5, 5, 10, 10)
    const t = 10 + CLOCK_WINDOW_MS
    expect(s.best(t, t)?.n).toBe(1)
    expect(s.best(t + 1, t + 1)).toBeUndefined()
  })

  it('empties the window on a wall-clock step', () => {
    const s = new ClockSync()
    s.sample(0, 5, 5, 10, 10)
    // The wall clock jumps 2 s ahead of monotonic time.
    expect(s.best(2_020, 20)).toBeUndefined()
    expect(s.samples).toBe(0)
  })

  it('takes drift within the bound for drift, not a step', () => {
    const s = new ClockSync()
    // A 2 ms round trip, then a minute in which the wall clock gains 1.2 ms
    // on monotonic time: under 2 + 2 + 6 ms.
    s.sample(0, 1, 1, 2, 2)
    const later = 2 + 60_000
    expect(s.best(later + 1.2, later)?.n).toBe(1)
    // 11 ms in the next minute is past it.
    expect(s.best(later + 60_000 + 12.2, later + 60_000)).toBeUndefined()
  })

  it('takes a whole-millisecond wall clock for a clock, not a step', () => {
    const s = new ClockSync()
    // A round trip that reads 0 ms, the wall clock in whole ms against a
    // fractional monotonic one.
    s.sample(1_000, 1_000, 1_000, 1_000, 0.9)
    s.sample(1_001, 1_001, 1_001, 1_001, 2.1)
    expect(s.best(1_003, 2.95)?.n).toBe(2)
    expect(CLOCK_TICK_MS).toBe(2)
  })

  it('ignores an exchange that cannot be true', () => {
    const s = new ClockSync()
    // A negative round trip: one of the clocks stepped mid-exchange.
    s.sample(0, 50, 60, 5, 5)
    s.sample(Number.NaN, 1, 2, 3, 3)
    s.sample(0, 1, 2, Number.POSITIVE_INFINITY, 3)
    s.sample(0, 1, 2, 3, Number.NaN)
    expect(s.samples).toBe(0)
    expect(s.best(5, 5)).toBeUndefined()
  })

  it('rounds to 0.001, halves away from zero', () => {
    const s = new ClockSync()
    // Offset -1.0625 ms, exact in binary, so the half is a real half.
    s.sample(0, -0.9375, -0.9375, 0.25, 0)
    expect(s.best(0.25, 0)).toEqual({ o: -1.063, r: 0.25, n: 1, a: 0 })
  })
})

describe('FlushQueue, the clock on the batch record', () => {
  it('carries the clock when there is one, and no field when there is none', () => {
    const clock = { o: -41.5, r: 18, n: 6, a: 37 }
    expect(sealedBatch(() => clock).clock).toEqual(clock)
    expect(sealedBatch(() => undefined)).not.toHaveProperty('clock')
  })
})
