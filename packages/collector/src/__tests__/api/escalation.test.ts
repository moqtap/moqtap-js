/**
 * The increment, and what closes a capture window.
 *
 * Two rules are asserted here and nowhere else, both invisible end to end.
 * Elevated time counts in whole seconds, rounded down, with a one-second
 * minimum: a 4.9 s window counts 4 s, a 200 ms window counts 1 s. And exactly
 * four things end a window — `resolve()`, the ring filling, the page unloading,
 * and the post-event timeout — with no "the fault recovered", which is a
 * player-level judgement the collector has no semantics for.
 *
 * The rounding is asserted per window rather than per session, because that is
 * what a session total cannot express: two 200 ms windows are two seconds and
 * one 400 ms window is one, and a meter flooring a session total would report
 * the same number for both.
 */

import { describe, expect, it } from 'vitest'
import { EscalationController, type EscalationControllerOptions } from '../../api/escalation.js'
import { billableSeconds, UsageMeter } from '../../api/meter.js'
import type { ClockSource, EnvelopeRecord, EscalationRecord, RecordSink } from '../../types.js'

interface Fixture {
  readonly ctl: EscalationController
  readonly meter: UsageMeter
  readonly records: EscalationRecord[]
  readonly clock: ClockSource
  /** Move both clocks forward together, so nothing reads as a suspended device. */
  advance(ms: number): void
  /** What `tick()` sees on the interval the session drives it on. */
  tick(): void
}

/**
 * A controller with a clock the test moves by hand.
 *
 * `ceilingMinutes: 0` disables the ceiling — it has its own tests in
 * `lifecycle.test.ts`, and leaving it armed here would close windows for a
 * reason none of these cases is about.
 */
function fixture(over: Partial<EscalationControllerOptions> = {}): Fixture {
  let t = 0
  const clock: ClockSource = { now: () => t, wall: () => t }
  const records: EscalationRecord[] = []
  const sink: RecordSink = {
    json: (r: EnvelopeRecord) => {
      if (r.t === 'escalation') records.push(r)
    },
    raw: () => {},
  }
  const meter = new UsageMeter(clock)
  const ctl = new EscalationController({
    configured: 'baseline',
    ceilingMinutes: 0,
    windowMs: 15_000,
    meter,
    clock,
    anchor: { originMono: 0, originWall: 0 },
    sink,
    ...over,
  })
  return {
    ctl,
    meter,
    records,
    clock,
    advance: (ms: number) => {
      t += ms
    },
    tick: () => {
      ctl.tick(t)
    },
  }
}

describe('whole seconds, rounded down, one-second minimum', () => {
  it('rounds one window the way the spec spells it out', () => {
    expect(billableSeconds(0)).toBe(1)
    expect(billableSeconds(200)).toBe(1)
    expect(billableSeconds(999)).toBe(1)
    expect(billableSeconds(1_000)).toBe(1)
    expect(billableSeconds(4_900)).toBe(4)
    expect(billableSeconds(5_000)).toBe(5)
    expect(billableSeconds(59_999)).toBe(59)
  })

  it('bills a 200 ms window as one second', () => {
    const f = fixture()
    f.ctl.escalate('headers')
    f.advance(200)
    f.ctl.resolve()
    expect(f.meter.billableSeconds).toBe(1)
    expect(f.meter.elevatedMs).toBe(200)
  })

  it('bills a 4.9 s window as four seconds — down, never up', () => {
    const f = fixture()
    f.ctl.escalate('headers')
    f.advance(4_900)
    f.ctl.resolve()
    expect(f.meter.billableSeconds).toBe(4)
  })

  it('bills exactly 5.0 s as five seconds', () => {
    const f = fixture()
    f.ctl.escalate('headers')
    f.advance(5_000)
    f.ctl.resolve()
    expect(f.meter.billableSeconds).toBe(5)
  })

  it('bills two 200 ms windows as two seconds, not one', () => {
    const f = fixture()
    for (let i = 0; i < 2; i += 1) {
      f.ctl.escalate('headers')
      f.advance(200)
      f.ctl.resolve()
      f.advance(60_000)
    }
    // The floor and the minimum are per window. A session total floored once
    // would say 0 s here, and a session total with one minimum would say 1 s.
    expect(f.meter.billableSeconds).toBe(2)
    expect(f.meter.windows).toBe(2)
  })

  it('bills a window that never opened as nothing', () => {
    const f = fixture()
    f.advance(600_000)
    expect(f.meter.billableSeconds).toBe(0)
    expect(f.meter.elevatedMinutes).toBe(0)
    expect(f.meter.report().elevatedSeconds).toBe(0)
    expect(f.meter.report().bytesPerElevatedMinute).toBe(0)
  })

  it('counts a raise between two elevated levels as one window, not two', () => {
    const f = fixture()
    f.ctl.escalate('headers')
    f.advance(200)
    f.ctl.escalate('headers+sizes')
    f.advance(200)
    f.ctl.resolve()
    // Otherwise a level change mid-incident would count the one-second minimum
    // once per change.
    expect(f.meter.windows).toBe(1)
    expect(f.meter.billableSeconds).toBe(1)
  })

  it('bills the open window at its minimum from the moment it opens', () => {
    const f = fixture()
    f.ctl.escalate('headers')
    f.advance(200)
    // The ceiling check reads this on every tick, so it has to be the billable
    // quantity mid-window and not a fraction climbing towards one.
    expect(f.meter.billableSeconds).toBe(1)
    f.advance(4_800)
    expect(f.meter.billableSeconds).toBe(5)
  })

  it('records a suspension once per window, not once per read of the meter', () => {
    const mono = 0
    let wall = 0
    // A monotonic clock that stopped while the wall clock ran on is what a
    // suspended device looks like.
    const meter = new UsageMeter({ now: () => mono, wall: () => wall })
    meter.setLevel('headers')
    wall += 5_000
    // The ceiling check reads this on every tick. A divergence accrued from the
    // getter would count the same suspension once per read.
    for (let i = 0; i < 5; i += 1) void meter.elevatedMinutes
    meter.setLevel('baseline')
    expect(meter.suspendedMs).toBe(5_000)
    // The smaller of the two clocks is what counts, so the suspended time is
    // excluded — but the window opened, so its minimum still counts.
    expect(meter.billableSeconds).toBe(1)
  })
})

describe('resolve() is the primary close', () => {
  it('closes the window, returns to the configured level and says why', () => {
    const f = fixture()
    f.ctl.escalate('headers', 'user reported a stall')
    f.advance(200)
    f.ctl.resolve()
    expect(f.ctl.level).toBe('baseline')
    expect(f.ctl.windowOpen).toBe(false)
    const last = f.records.at(-1)
    expect(last?.from).toBe('headers')
    expect(last?.to).toBe('baseline')
    expect(last?.by).toEqual({ kind: 'window', closed: 'resolve' })
  })

  it('is a harmless no-op with no window open', () => {
    const f = fixture()
    expect(() => {
      f.ctl.resolve()
    }).not.toThrow()
    expect(f.records).toHaveLength(0)
    expect(f.ctl.level).toBe('baseline')
    expect(f.meter.billableSeconds).toBe(0)
  })

  it('is a no-op the second time, and bills the window once', () => {
    const f = fixture()
    f.ctl.escalate('headers')
    f.advance(200)
    f.ctl.resolve()
    const after = f.records.length
    f.advance(60_000)
    f.ctl.resolve()
    // Called from an error handler, so twice for one incident is the ordinary
    // case rather than a misuse.
    expect(f.records).toHaveLength(after)
    expect(f.meter.billableSeconds).toBe(1)
  })

  it('never drops the session below its configured detail', () => {
    const f = fixture({ configured: 'headers' })
    f.advance(200)
    f.ctl.resolve()
    expect(f.ctl.level).toBe('headers')
    expect(f.records).toHaveLength(0)
  })

  it('closes a window opened above a configured floor, back to that floor', () => {
    const f = fixture({ configured: 'headers' })
    f.ctl.escalate('headers+sizes')
    f.advance(200)
    f.ctl.resolve()
    expect(f.ctl.level).toBe('headers')
  })

  it('names the browser, not the developer, when the page unloads', () => {
    const f = fixture()
    f.ctl.escalate('headers')
    f.ctl.unload()
    expect(f.records.at(-1)?.by).toEqual({ kind: 'window', closed: 'unload' })
  })

  it('carries a caller reason through alongside the close condition', () => {
    const f = fixture()
    f.ctl.escalate('headers')
    f.ctl.resolve('player recovered')
    expect(f.records.at(-1)?.by).toEqual({
      kind: 'window',
      closed: 'resolve',
      reason: 'player recovered',
    })
  })
})

describe('the post-event timeout is the backstop, not the mechanism', () => {
  it('closes a trigger window when resolve() is never called', () => {
    const f = fixture()
    f.ctl.onTrigger('stall', f.clock.now())
    expect(f.ctl.level).toBe('headers')
    f.advance(14_999)
    f.tick()
    expect(f.ctl.level).toBe('headers')
    f.advance(1)
    f.tick()
    expect(f.ctl.level).toBe('baseline')
    expect(f.records.at(-1)?.by).toEqual({ kind: 'window', closed: 'timeout' })
    expect(f.meter.billableSeconds).toBe(15)
  })

  it('uses flightRecorder.windowMs and not a constant', () => {
    const f = fixture({ windowMs: 3_000 })
    f.ctl.onTrigger('cadence', f.clock.now())
    f.advance(3_000)
    f.tick()
    expect(f.ctl.level).toBe('baseline')
    expect(f.meter.billableSeconds).toBe(3)
  })

  it('leaves a manual window open forever, because that is the customer toggle', () => {
    const f = fixture()
    f.ctl.escalate('headers')
    f.advance(10 * 60_000)
    f.tick()
    // A manual window is bounded by the customer's own toggle: there is no
    // recovered signal to close it and the collector must not invent one.
    expect(f.ctl.level).toBe('headers')
    expect(f.ctl.windowOpen).toBe(true)
  })

  it('lets a manual raise cancel a trigger deadline it took over', () => {
    const f = fixture()
    f.ctl.onTrigger('stall', f.clock.now())
    f.ctl.escalate('headers+sizes', 'operator is watching')
    f.advance(60_000)
    f.tick()
    expect(f.ctl.level).toBe('headers+sizes')
  })

  it('never lowers the level on a trigger that fires above its capture level', () => {
    const f = fixture()
    f.ctl.escalate('headers+sizes')
    const before = f.records.length
    f.ctl.onTrigger('stall', f.clock.now())
    expect(f.ctl.level).toBe('headers+sizes')
    expect(f.records).toHaveLength(before)
  })
})

describe('the ring filling closes the window', () => {
  it('closes a trigger window once the ring has turned over completely', () => {
    let evicted = 0
    const f = fixture({
      ring: { capacityBytes: 1_000, evictedBytes: () => evicted },
    })
    f.ctl.onTrigger('stall', f.clock.now())
    f.advance(1_000)
    evicted = 999
    f.tick()
    // Not yet: one byte of what the ring held when the trigger fired survives.
    expect(f.ctl.level).toBe('headers')
    evicted = 1_000
    f.tick()
    expect(f.ctl.level).toBe('baseline')
    expect(f.records.at(-1)?.by).toEqual({ kind: 'window', closed: 'ring' })
  })

  it('leaves a manual window alone, because a manual raise reads no ring', () => {
    let evicted = 0
    const f = fixture({
      ring: { capacityBytes: 1_000, evictedBytes: () => evicted },
    })
    f.ctl.escalate('headers')
    evicted = 10_000
    f.advance(1_000)
    f.tick()
    expect(f.ctl.level).toBe('headers')
  })

  it('never fires when the recorder was never armed, so no ring turns over', () => {
    const f = fixture()
    f.ctl.onTrigger('stall', f.clock.now())
    f.advance(1_000)
    f.tick()
    expect(f.ctl.level).toBe('headers')
  })
})

describe('there is no fifth close condition', () => {
  it('holds a trigger window open while traffic carries on normally', () => {
    const f = fixture()
    f.ctl.onTrigger('stall', f.clock.now())
    // Nothing here signals recovery, and nothing may infer it: the collector
    // sees objects arriving, not a rebuffer ending.
    for (let i = 0; i < 14; i += 1) {
      f.advance(1_000)
      f.tick()
    }
    expect(f.ctl.level).toBe('headers')
  })
})

describe('teardown stops the meter', () => {
  it('stops accruing after close(), even on a statically elevated session', () => {
    const f = fixture({ configured: 'headers' })
    f.advance(2_000)
    f.ctl.close()
    const billed = f.meter.billableSeconds
    f.advance(600_000)
    // Otherwise `usage()` climbs with wall time for as long as the page holds a
    // reference to a stopped collector.
    expect(f.meter.billableSeconds).toBe(billed)
    expect(billed).toBe(2)
  })
})
