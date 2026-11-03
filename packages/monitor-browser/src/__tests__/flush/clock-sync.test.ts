/**
 * The body's `clk`: the emitter's monotonic clock against ingest's, a sample
 * per exchange, an epoch raised at every clock break, and the clock's
 * measured resolution.
 */

import { describe, expect, it } from 'vitest'
import { B_BREAK_US, ClockSync, Emitter, FlushQueue, RES_UNKNOWN_US } from '../../flush/index.js'
import type { BatchRecord, ClockSource, NoteRecord } from '../../types.js'
import { recordsOf } from '../support/uploads.js'

const note: NoteRecord = { t: 'note', ts: 0, lvl: 'baseline', name: 'n', data: 'x' }

describe('ClockSync samples', () => {
  it('maps server minus mono, in µs, from mono t1/t4 and server t2/t3', () => {
    const c = new ClockSync()
    // mono 1000 ms; the server reads 1_761_000_000_000 ms half way through a 20 ms trip.
    c.sample(1000, 1_761_000_000_010, 1_761_000_000_010, 1020, 0, 'FRA')
    expect(c.latest()).toEqual({
      oUs: (1_761_000_000_010 - 1010) * 1000,
      rUs: 20_000,
      atUs: 1_020_000,
      pop: 'FRA',
    })
  })

  it('keeps the latest sample of the epoch only, and drops a PoP that is not one', () => {
    const c = new ClockSync()
    c.sample(0, 100, 100, 10, 0)
    c.sample(20, 130, 131, 30, 0, 'not a pop!')
    expect(c.latest()).toEqual({ oUs: 105_500, rUs: 9_000, atUs: 30_000 })
  })

  it('refuses an exchange that cannot be true, or spans a break', () => {
    const c = new ClockSync()
    c.sample(0, 100, 100, Number.NaN, 0)
    c.sample(10, 100, 120, 20, 0)
    c.sample(0, 100, 100, 10, 1)
    expect(c.latest()).toBeUndefined()
  })
})

describe('ClockSync breaks', () => {
  it('does not break on drift, tick or a small step', () => {
    const c = new ClockSync()
    expect(c.check(1_000_000, 0)).toBe(false)
    expect(c.check(1_000_001, 1)).toBe(false)
    // A minute later, 6 ms of drift at 100 ppm is allowed.
    expect(c.check(1_060_007, 60_001)).toBe(false)
  })

  it('breaks when wall − mono jumps past B_BREAK', () => {
    const c = new ClockSync()
    c.sample(0, 100, 100, 10, 0)
    c.check(1_000_000, 0)
    // The device slept: mono stood still for 30 s while wall moved on.
    expect(c.check(1_030_000, 10)).toBe(true)
    expect(c.epoch).toBe(0)
    c.raise()
    expect(c.epoch).toBe(1)
    expect(c.latest()).toBeUndefined()
    expect(B_BREAK_US).toBeGreaterThan(0)
  })
})

describe('ClockSync resolution', () => {
  it('starts at the unknown bound and narrows to the smallest distinct step', () => {
    const c = new ClockSync()
    expect(c.resUs).toBe(RES_UNKNOWN_US)
    let t = 0
    const reads = [0, 0, 0, 0.1, 0.1, 0.2]
    c.measure(() => reads[Math.min(t++, reads.length - 1)] as number)
    expect(c.resUs).toBe(100)
  })

  it('never narrows below a step the clock showed', () => {
    const c = new ClockSync()
    c.measure(() => 5)
    expect(c.resUs).toBe(RES_UNKNOWN_US)
    c.check(1000, 5)
    c.check(1001, 6)
    expect(c.resUs).toBe(1000)
  })
})

describe('the body carries the clock', () => {
  const clock = (mono: number): ClockSource => ({ now: () => mono, wall: () => 1_761_000_000_000 })

  it('with no sample, clk has the base, epoch and resolution only', async () => {
    const e = new Emitter('i1', 0)
    const q = new FlushQueue({ sessionId: 's1', emitter: e, clock: clock(5) })
    q.json(note)
    const [batch] = (await recordsOf(q.seal()!.bytes)) as [BatchRecord]
    expect(batch.clk).toEqual({ base_us: 0, epoch: 0, res_us: RES_UNKNOWN_US })
  })

  it("with one, the epoch's latest sample", async () => {
    const e = new Emitter('i1', 0)
    e.clock.sample(1, 1_761_000_000_000, 1_761_000_000_000, 3, 0, 'LHR')
    const q = new FlushQueue({ sessionId: 's1', emitter: e, clock: clock(5) })
    q.json(note)
    const [batch] = (await recordsOf(q.seal()!.bytes)) as [BatchRecord]
    expect(batch.clk).toMatchObject({
      base_us: 0,
      epoch: 0,
      o_us: (1_761_000_000_000 - 2) * 1000,
      r_us: 2000,
      at_us: 3000,
      pop: 'LHR',
    })
  })
})
