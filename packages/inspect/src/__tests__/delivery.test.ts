import { describe, expect, it } from 'vitest'
import {
  deliveryKey,
  highestBucket,
  quantileBucket,
  type RollupAnnotation,
  rollupDelivery,
} from '../delivery.js'

/** A `collector.rollup` for the interval [startMono, endMono], recorded at its end. */
function rollup(
  segment: number,
  atMs: number,
  startMono: number,
  endMono: number,
  tracks: unknown[],
  connection = 'c1',
): RollupAnnotation {
  return {
    segment,
    atMs,
    label: 'collector.rollup',
    data: { startMono, endMono, tracks },
    connection,
  }
}

const video = (extra: Record<string, unknown> = {}) => ({
  key: { d: 'rx', k: 'alias', v: '9' },
  objects: 60,
  payloadBytes: 120_000,
  groups: 2,
  groupGaps: 0,
  statusObjects: 0,
  firstSeen: 1_200,
  hist: {
    stallMs: { n: 0, i: [], c: [] },
    groupCadenceMs: { n: 2, i: [10], c: [2] },
    interArrivalMs: { n: 59, i: [4, 5], c: [50, 9] },
  },
  ...extra,
})

describe('bucket helpers', () => {
  it('finds the bucket holding a quantile, and the highest with a count', () => {
    expect(quantileBucket([0, 5, 0, 5], 0.5)).toBe(1)
    expect(quantileBucket([0, 5, 0, 5], 0.95)).toBe(3)
    expect(quantileBucket([], 0.5)).toBeNull()
    expect(highestBucket([1, 0, 2, 0])).toBe(2)
    expect(highestBucket([0, 0])).toBeNull()
  })
})

describe('rollupDelivery', () => {
  it('places collector time on the session clock off the first rollup of each segment', () => {
    // Recorded at 15,000 ms on the session clock, ending at 10,000 collector ms.
    const { tracks, intervals, offsets } = rollupDelivery([rollup(0, 15_000, 0, 10_000, [video()])])
    expect(offsets.get(0)).toBe(5_000)
    expect(tracks).toHaveLength(1)
    expect(tracks[0]).toMatchObject({
      key: deliveryKey('c1', 'rx', 'alias', '9'),
      connection: 'c1',
      direction: 'rx',
      kind: 'alias',
      id: '9',
      firstObjectMs: 6_200,
      objects: 60,
      payloadBytes: 120_000,
      groups: 2,
      stalls: 0,
      longestStall: null,
      cadenceP50: 10,
      cadenceP95: 10,
      arrivalP95: 5,
    })
    expect(intervals).toEqual([
      {
        key: 'c1|rx:alias:9',
        fromMs: 5_000,
        toMs: 15_000,
        objects: 60,
        groupGaps: 0,
        skipped: 0,
        stalls: 0,
        longestStall: null,
      },
    ])
  })

  it('sums a track across intervals and keeps its earliest first object', () => {
    const stalled = video({
      firstSeen: 10_500,
      groupGaps: 1,
      statusObjects: 3,
      hist: { stallMs: { n: 2, i: [11, 12], c: [1, 1] } },
    })
    const { tracks, intervals } = rollupDelivery([
      rollup(0, 10_000, 0, 10_000, [video()]),
      rollup(0, 20_000, 10_000, 20_000, [stalled]),
    ])
    expect(tracks[0]).toMatchObject({
      firstObjectMs: 1_200,
      objects: 120,
      groupGaps: 1,
      skipped: 3,
      stalls: 2,
      longestStall: 12,
    })
    expect(intervals.map((i) => [i.fromMs, i.stalls, i.longestStall])).toEqual([
      [0, 0, null],
      [10_000, 2, 12],
    ])
  })

  it('lets a segment with no rollup borrow the offset before it', () => {
    const { offsets } = rollupDelivery([
      rollup(0, 15_000, 0, 10_000, []),
      { segment: 1, atMs: 16_000, label: 'collector.flight', data: {} },
    ])
    expect(offsets.get(1)).toBe(5_000)
  })

  it('keeps connections and directions apart, and the send side figures', () => {
    const sent = {
      key: { d: 'tx', k: 'alias', v: '9' },
      objects: 10,
      blockedMs: 40,
      ackedBytes: 900,
    }
    const { tracks } = rollupDelivery([
      rollup(0, 10_000, 0, 10_000, [video()], 'c1'),
      rollup(0, 10_000, 0, 10_000, [video(), sent], 'c2'),
    ])
    expect(tracks.map((t) => t.key)).toEqual(['c1|rx:alias:9', 'c2|rx:alias:9', 'c2|tx:alias:9'])
    expect(tracks[2]).toMatchObject({ blockedMs: 40, ackedBytes: 900 })
    expect(tracks[0]!.blockedMs).toBeUndefined()
  })

  it('passes over other labels and malformed rollups', () => {
    const { tracks } = rollupDelivery([
      { segment: 0, atMs: 1, label: 'player.seek', data: { tracks: [video()] } },
      { segment: 0, atMs: 2, label: 'collector.rollup', data: { tracks: [video()] } },
      rollup(0, 10_000, 0, 10_000, [{ key: { d: 'up', k: 'alias', v: '1' } }, null]),
    ])
    expect(tracks).toEqual([])
  })
})
