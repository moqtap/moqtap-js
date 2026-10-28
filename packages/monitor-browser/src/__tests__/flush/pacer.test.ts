/**
 * Release shaping — "do not upload into congestion".
 *
 * The pacer is the sharpest expression of the non-interference promise, and
 * it is the one component here whose *correct* behaviour looks like a bug: it
 * makes the collector slower exactly when there is most to say. The pacer explains
 * why — flight-recorder mode raises our output at the moment the network is
 * worst, so uploading on the trigger both worsens the user's stall and biases
 * the measurement by the act of measuring.
 *
 * So the tests below check three things, in this order of importance:
 *
 *  1. **It only ever slows release.** Nothing here seals, and nothing here can
 *    make the flush schedule seal less often. That separation is what keeps
 *    "a crash loses at most 60 seconds" true under congestion.
 *  2. **Object arrival rate is the signal** (the words), read against the
 *    rate *this session* established rather than an absolute number nobody can
 *    pick for someone else's GOP length.
 *  3. **It does not invent pressure.** A warm-up sample, a legitimate step down
 *    to a slower steady rate, and an idle publisher with no signal at all must
 *    all release at full speed — a pacer that throttles silence would throttle
 *    every healthy session that happens to be quiet.
 *
 * The publish-only fallback to `writer.ready` latency is this package's decision
 * and NOT the spec's: publisher backpressure has no subscriber-side
 * analogue, and nothing has validated the substitute. It is tested as
 * implemented, not as vindicated — see the module's reported defects.
 */

import { describe, expect, it } from 'vitest'
import { ReleasePacer } from '../../flush/index.js'
import type { PressureSample } from '../../types.js'

const MIN = 1_000
const MAX = 60_000

const pacer = (): ReleasePacer => new ReleasePacer({ minIntervalMs: MIN, maxIntervalMs: MAX })

const feed = (p: ReleasePacer, rate: number, times: number, extra?: { readyMs?: number }): void => {
  for (let i = 0; i < times; i++) {
    const sample: PressureSample =
      extra?.readyMs === undefined
        ? { objectsPerSec: rate, at: i * 1_000 }
        : { objectsPerSec: rate, writerReadyMs: extra.readyMs, at: i * 1_000 }
    p.notePressure(sample)
  }
}

describe('ReleasePacer, healthy session', () => {
  it('releases at the minimum interval before it has seen anything', () => {
    expect(pacer().nextReleaseDelayMs()).toBe(MIN)
  })

  it('infers nothing from a single sample — one rate is a baseline, not a change', () => {
    const p = pacer()
    feed(p, 100, 1)
    expect(p.nextReleaseDelayMs()).toBe(MIN)
  })

  it('stays at the minimum while the arrival rate holds', () => {
    const p = pacer()
    feed(p, 100, 20)
    expect(p.pressure).toBe(0)
    expect(p.nextReleaseDelayMs()).toBe(MIN)
  })

  it('ignores jitter around the established rate rather than oscillating on it', () => {
    const p = pacer()
    feed(p, 100, 20)
    for (const r of [95, 104, 96, 103, 97]) feed(p, r, 1)
    expect(p.nextReleaseDelayMs()).toBe(MIN)
  })
})

describe('ReleasePacer under congestion', () => {
  it('slows release as the arrival rate collapses, up to the configured ceiling', () => {
    const p = pacer()
    feed(p, 100, 20)
    expect(p.nextReleaseDelayMs()).toBe(MIN)

    feed(p, 0, 5)
    expect(p.pressure).toBe(1)
    expect(p.nextReleaseDelayMs()).toBe(MAX)
  })

  it('ramps rather than switching: a partial drop pays a partial delay', () => {
    const p = pacer()
    feed(p, 100, 20)
    feed(p, 40, 3)
    const delay = p.nextReleaseDelayMs()
    expect(delay).toBeGreaterThan(MIN)
    expect(delay).toBeLessThan(MAX)
  })

  it('never returns a delay outside its two bounds, whatever the signal does', () => {
    const p = pacer()
    for (const rate of [0, 1, 5, 1_000, 100, 0, 0.5]) {
      feed(p, rate, 3)
      const delay = p.nextReleaseDelayMs()
      expect(delay).toBeGreaterThanOrEqual(MIN)
      expect(delay).toBeLessThanOrEqual(MAX)
    }
  })

  it('returns to full speed when the objects come back', () => {
    const p = pacer()
    feed(p, 100, 20)
    feed(p, 0, 5)
    expect(p.nextReleaseDelayMs()).toBe(MAX)
    feed(p, 100, 5)
    expect(p.nextReleaseDelayMs()).toBe(MIN)
  })

  it('stops reading a legitimate step down to a slower steady rate as congestion', () => {
    const p = pacer()
    feed(p, 100, 20)
    feed(p, 60, 3)
    expect(p.nextReleaseDelayMs()).toBeGreaterThan(MIN)
    // The baseline decays toward the new steady rate, so a track that simply
    // publishes less often is not throttled forever.
    feed(p, 60, 40)
    expect(p.nextReleaseDelayMs()).toBe(MIN)
  })
})

describe('ReleasePacer, publish-only sessions', () => {
  it('falls back to writer.ready latency when no object has ever arrived', () => {
    const p = pacer()
    feed(p, 0, 4, { readyMs: 300 })
    expect(p.pressure).toBe(1)
    expect(p.nextReleaseDelayMs()).toBe(MAX)
  })

  it('treats an unloaded writer as healthy', () => {
    const p = pacer()
    feed(p, 0, 4, { readyMs: 1 })
    expect(p.nextReleaseDelayMs()).toBe(MIN)
  })

  it('invents no pressure from silence: no objects and no writer samples is not congestion', () => {
    const p = pacer()
    feed(p, 0, 10)
    expect(p.pressure).toBe(0)
    expect(p.nextReleaseDelayMs()).toBe(MIN)
  })

  it('does not re-pace a stalled subscriber off the send-side signal', () => {
    const p = pacer()
    feed(p, 100, 20, { readyMs: 1 })
    // Objects stop arriving while the writer stays unloaded — which is exactly
    // what a subscriber-side stall looks like. Arrival rate governs.
    feed(p, 0, 5, { readyMs: 1 })
    expect(p.nextReleaseDelayMs()).toBe(MAX)
  })
})

describe('ReleasePacer, hostile inputs', () => {
  it('ignores non-finite and negative rates rather than folding them in', () => {
    const p = pacer()
    feed(p, 100, 20)
    for (const rate of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      p.notePressure({ objectsPerSec: rate, at: 0 })
    }
    expect(p.pressure).toBe(0)
    expect(p.nextReleaseDelayMs()).toBe(MIN)
  })

  it('ignores a non-finite writer latency', () => {
    const p = pacer()
    p.notePressure({ objectsPerSec: 0, writerReadyMs: Number.NaN, at: 0 })
    p.notePressure({ objectsPerSec: 0, writerReadyMs: Number.NaN, at: 1 })
    expect(p.nextReleaseDelayMs()).toBe(MIN)
  })

  it('clamps a max below its min instead of returning a delay below the floor', () => {
    const p = new ReleasePacer({ minIntervalMs: 5_000, maxIntervalMs: 100 })
    feed(p, 100, 20)
    feed(p, 0, 5)
    expect(p.nextReleaseDelayMs()).toBe(5_000)
  })

  it('works with a zero minimum, which is what an unpaced session configures', () => {
    const p = new ReleasePacer({ minIntervalMs: 0, maxIntervalMs: 10_000 })
    feed(p, 100, 20)
    expect(p.nextReleaseDelayMs()).toBe(0)
    feed(p, 0, 5)
    expect(p.nextReleaseDelayMs()).toBe(10_000)
  })
})
