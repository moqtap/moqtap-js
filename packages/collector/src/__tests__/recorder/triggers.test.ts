/**
 * The triggers.
 *
 * The tests that matter here are the ones about *not* firing: a fresh
 * install must never generate spend the customer did not ask for, and
 * the cadence trigger must not fire until the track's median is established.
 * Both are assertions about silence, which is the kind of behaviour that decays
 * without a test.
 */

import { describe, expect, it } from 'vitest'
import { type MedianSource, TriggerEngine, type TriggerEvent } from '../../recorder/index.js'
import type { BucketKey, ObjectSample, TriggerConfig } from '../../types.js'

const VIDEO: BucketKey = Object.freeze({ dir: 'rx', kind: 'alias', id: 1n, epoch: 0 })
const AUDIO: BucketKey = Object.freeze({ dir: 'rx', kind: 'alias', id: 2n, epoch: 0 })

/** A median source under the test's control: the rollup's shape, none of its state. */
class Medians implements MedianSource {
  private readonly m = new Map<string, { median?: number; samples: number }>()

  set(k: BucketKey, median: number | undefined, samples: number): void {
    const entry = median === undefined ? { samples } : { median, samples }
    this.m.set(tag(k), entry)
  }

  medianFor(k: BucketKey): number | undefined {
    return this.m.get(tag(k))?.median
  }

  medianSamplesFor(k: BucketKey): number {
    return this.m.get(tag(k))?.samples ?? 0
  }
}

function tag(k: BucketKey): string {
  return `${k.dir}:${k.kind}:${k.id}:${k.epoch}`
}

function sample(key: BucketKey, at: number, objectId = 0n): ObjectSample {
  return { key, groupId: 0n, objectId, headerBytes: 8, payloadBytes: 1000, at }
}

interface Harness {
  readonly engine: TriggerEngine
  readonly fired: TriggerEvent[]
  readonly medians: Medians
}

function harness(config: TriggerConfig, cooldownMs = 0, maxTracked?: number): Harness {
  const fired: TriggerEvent[] = []
  const medians = new Medians()
  const engine = new TriggerEngine({
    config,
    medians,
    onFire: (e) => fired.push(e),
    cooldownMs,
    ...(maxTracked !== undefined ? { maxTracked } : {}),
  })
  return { engine, fired, medians }
}

describe('automated mode ships off', () => {
  it('fires nothing on an empty config, whatever the traffic does', () => {
    const h = harness({})
    expect(h.engine.idle).toBe(true)
    h.medians.set(VIDEO, 40, 100)

    h.engine.onObject(sample(VIDEO, 0))
    h.engine.onObject(sample(VIDEO, 60_000))
    h.engine.tick(600_000)
    h.engine.onTrackChange(VIDEO, 600_000)

    expect(h.fired).toEqual([])
    expect(h.engine.capturesFired).toBe(0)
  })

  it('ignores a track change unless trackSwitch is configured', () => {
    const h = harness({ stall: { afterMs: 1000 } })
    h.engine.onTrackChange(VIDEO, 10)
    expect(h.fired).toEqual([])

    const on = harness({ trackSwitch: {} })
    on.engine.onTrackChange(VIDEO, 10)
    expect(on.fired.map((e) => e.kind)).toEqual(['trackSwitch'])
    expect(on.fired[0]?.key).toBe(VIDEO)
  })
})

describe('cadence is a multiple of the track own median', () => {
  it('does not fire while the median is cold', () => {
    const h = harness({ cadence: { multiple: 3, minSamples: 8 } })
    // No median at all: the track has produced one object.
    h.medians.set(VIDEO, undefined, 1)
    h.engine.onObject(sample(VIDEO, 0))
    expect(h.engine.warm(VIDEO)).toBe(false)
    h.engine.tick(100_000)
    expect(h.fired).toEqual([])

    // A median, but not enough samples behind it: still cold.
    h.medians.set(VIDEO, 40, 7)
    expect(h.engine.warm(VIDEO)).toBe(false)
    h.engine.tick(200_000)
    expect(h.fired).toEqual([])

    h.medians.set(VIDEO, 40, 8)
    expect(h.engine.warm(VIDEO)).toBe(true)
  })

  it('fires at 6,000 ms on a 2 s GOP and at 750 ms on a 250 ms one, from one key', () => {
    const config: TriggerConfig = { cadence: { multiple: 3, minSamples: 4 } }

    const slow = harness(config)
    slow.medians.set(VIDEO, 2000, 30)
    slow.engine.onObject(sample(VIDEO, 0))
    slow.engine.tick(5_900)
    expect(slow.fired).toEqual([])
    slow.engine.tick(6_000)
    expect(slow.fired.map((e) => e.kind)).toEqual(['cadence'])

    const fast = harness(config)
    fast.medians.set(VIDEO, 250, 30)
    fast.engine.onObject(sample(VIDEO, 0))
    fast.engine.tick(740)
    expect(fast.fired).toEqual([])
    fast.engine.tick(750)
    expect(fast.fired.map((e) => e.kind)).toEqual(['cadence'])
  })

  it('fires on a completed gap too, and re-arms once the rhythm returns', () => {
    const h = harness({ cadence: { multiple: 3, minSamples: 4 } })
    h.medians.set(VIDEO, 100, 30)
    h.engine.onObject(sample(VIDEO, 0))
    h.engine.onObject(sample(VIDEO, 500))
    expect(h.fired).toHaveLength(1)

    // Latched: a second anomaly with no normal interval between them is the
    // same episode and must not open a second billable window.
    h.engine.onObject(sample(VIDEO, 1_000))
    expect(h.fired).toHaveLength(1)

    // A normal interval ends the episode; the next anomaly is a new one.
    h.engine.onObject(sample(VIDEO, 1_100))
    h.engine.onObject(sample(VIDEO, 1_600))
    expect(h.fired).toHaveLength(2)
  })
})

describe('stall', () => {
  it('fires during the silence, not when the stream recovers', () => {
    const h = harness({ stall: { afterMs: 2_000 } })
    h.engine.onObject(sample(VIDEO, 1_000))

    h.engine.tick(2_500)
    expect(h.fired).toEqual([])

    h.engine.tick(3_000)
    expect(h.fired.map((e) => e.kind)).toEqual(['stall'])
    expect(h.fired[0]?.atMono).toBe(3_000)
    expect(h.fired[0]?.detail).toContain('2000')

    // Still stalled: one episode, one window.
    h.engine.tick(9_000)
    expect(h.fired).toHaveLength(1)
  })

  it('reports the threshold that crossed first when both are configured', () => {
    const h = harness({ stall: { afterMs: 10_000 }, cadence: { multiple: 3, minSamples: 4 } })
    h.medians.set(VIDEO, 100, 30)
    h.engine.onObject(sample(VIDEO, 0))
    // 300 ms (cadence) is crossed long before 10,000 ms (stall).
    h.engine.tick(20_000)
    expect(h.fired.map((e) => e.kind)).toEqual(['cadence'])
  })
})

describe('rate limiting', () => {
  it('suppresses a second window inside the cooldown and counts it', () => {
    const h = harness({ stall: { afterMs: 1_000 } }, 30_000)
    h.engine.onObject(sample(VIDEO, 0))
    h.engine.tick(2_000)
    expect(h.fired).toHaveLength(1)

    // A different track stalls a second later: same ring, same window.
    h.engine.onObject(sample(AUDIO, 2_100))
    h.engine.tick(4_000)
    expect(h.fired).toHaveLength(1)
    expect(h.engine.capturesSuppressed).toBe(1)

    // A normal interval ends that track's episode; once the cooldown has passed
    // the next stall opens a window again.
    h.engine.onObject(sample(AUDIO, 2_200))
    h.engine.tick(40_000)
    expect(h.fired).toHaveLength(2)
  })
})

describe('bounded state', () => {
  it('drops the least recently active track rather than growing without bound', () => {
    const h = harness({ stall: { afterMs: 1_000 } }, 0, 2)
    h.engine.onObject(sample(VIDEO, 0))
    h.engine.onObject(sample(AUDIO, 10))
    expect(h.engine.trackedCount).toBe(2)

    const third: BucketKey = { dir: 'rx', kind: 'alias', id: 3n, epoch: 0 }
    h.engine.onObject(sample(third, 20))
    expect(h.engine.trackedCount).toBe(2)
    expect(h.engine.tracksEvicted).toBe(1)
  })
})
