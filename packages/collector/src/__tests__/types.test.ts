/**
 * Tests for the shared contract's runtime surface.
 *
 * `src/types.ts` is mostly types, which the compiler checks. What it also
 * carries is four constants and two helpers that seven other modules depend on
 * behaving one specific way, and none of that is checked by `tsc`:
 *
 *  - {@link bucketKeyString} is the single stringification of a bucket key
 *    Every map key, every columnar `cols.key` entry and every `hdr`
 *    record key goes through it, so a collision or an unstable form re-splits
 *    or merges tracks at ingest.
 *  - {@link FRAME_RAW_FLAG} sits on bit 31 of a u32, where JavaScript's
 *    int32 bitwise coercion makes the obvious comparison silently wrong.
 *  - {@link NEED} is an identity sentinel; a value that could impersonate it
 *    would turn a buffered prefix into a decoded value.
 *  - {@link DETAIL_LEVELS} is an ordered lattice the ceiling and
 *    `TRIGGER_CAPTURE_LEVEL` are both expressed as positions on.
 */

import { describe, expect, it } from 'vitest'
import {
  asAnyMessage,
  type BucketKey,
  bucketKeyString,
  DETAIL_LEVELS,
  FRAME_LENGTH_MASK,
  FRAME_RAW_FLAG,
  NEED,
} from '../types.js'

const key = (o: Partial<BucketKey> = {}): BucketKey => ({
  dir: 'rx',
  kind: 'alias',
  id: 7n,
  epoch: 0,
  ...o,
})

describe('bucketKeyString', () => {
  it('gives every axis of the key its own place in the string', () => {
    const base = bucketKeyString(key())
    const variants = [
      bucketKeyString(key({ dir: 'tx' })),
      bucketKeyString(key({ kind: 'fetch' })),
      bucketKeyString(key({ id: 8n })),
      bucketKeyString(key({ epoch: 1 })),
    ]
    for (const v of variants) expect(v).not.toBe(base)
    expect(new Set([base, ...variants]).size).toBe(5)
  })

  it('is stable: equal keys give an identical string every time', () => {
    const a = bucketKeyString({ dir: 'tx', kind: 'fetch', id: 42n, epoch: 3 })
    const b = bucketKeyString({ dir: 'tx', kind: 'fetch', id: 42n, epoch: 3 })
    expect(a).toBe(b)
    expect(a).toBe('tx:fetch:42:3')
  })

  it('separates an epoch bump from the same alias, which is the whole point of the epoch', () => {
    // A publisher may rebind a track alias sequentially once the prior
    // subscription has closed. Two tracks summed into one row are unrecoverable
    // at ingest, so the two epochs must not collide.
    expect(bucketKeyString(key({ id: 2n, epoch: 0 }))).not.toBe(
      bucketKeyString(key({ id: 2n, epoch: 1 })),
    )
  })

  it('separates the two directions, which are two distinct alias spaces', () => {
    expect(bucketKeyString(key({ dir: 'rx', id: 1n }))).not.toBe(
      bucketKeyString(key({ dir: 'tx', id: 1n })),
    )
  })

  it('keeps a full u64 alias exact, where a number would have lost it', () => {
    // Track aliases and request ids are vi64. Number(2n ** 62n) and
    // Number(2n ** 62n + 1n) are the same double, so a numeric key would merge
    // two tracks.
    const big = 2n ** 62n
    const a = bucketKeyString(key({ id: big }))
    const b = bucketKeyString(key({ id: big + 1n }))
    expect(a).not.toBe(b)
    expect(a).toContain(big.toString())
    expect(Number(big)).toBe(Number(big + 1n))
  })

  it('never emits a bigint suffix that would break a round trip through the id', () => {
    const s = bucketKeyString(key({ id: 12345678901234567890n }))
    const parts = s.split(':')
    expect(parts).toHaveLength(4)
    expect(BigInt(parts[2] as string)).toBe(12345678901234567890n)
  })
})

describe('frame length prefix', () => {
  const prefix = (len: number, raw: boolean) => (raw ? (len | FRAME_RAW_FLAG) >>> 0 : len >>> 0)

  it('round-trips a JSON frame length with the flag clear', () => {
    const p = prefix(4096, false)
    expect((p & FRAME_RAW_FLAG) !== 0).toBe(false)
    expect((p & FRAME_LENGTH_MASK) >>> 0).toBe(4096)
  })

  it('round-trips a raw frame length with the flag set', () => {
    const p = prefix(4096, true)
    expect((p & FRAME_RAW_FLAG) !== 0).toBe(true)
    expect((p & FRAME_LENGTH_MASK) >>> 0).toBe(4096)
  })

  it('carries the largest length the mask allows', () => {
    const p = prefix(FRAME_LENGTH_MASK, true)
    expect((p & FRAME_LENGTH_MASK) >>> 0).toBe(FRAME_LENGTH_MASK)
    expect((p & FRAME_RAW_FLAG) !== 0).toBe(true)
    expect(p).toBe(0xffffffff)
  })

  it('makes the documented trap real: `=== FRAME_RAW_FLAG` is false on a raw frame', () => {
    // JavaScript's bitwise operators coerce to int32, so the masked bit comes
    // back as -2147483648. `!== 0` is the only correct test, and this asserts
    // the wrong one actually fails rather than merely warning about it.
    const p = prefix(4, true)
    expect(p & FRAME_RAW_FLAG).toBe(-0x80000000)
    expect((p & FRAME_RAW_FLAG) === FRAME_RAW_FLAG).toBe(false)
    expect((p & FRAME_RAW_FLAG) !== 0).toBe(true)
  })

  it('has complementary masks that together cover a u32', () => {
    expect(FRAME_RAW_FLAG & FRAME_LENGTH_MASK).toBe(0)
    expect((FRAME_RAW_FLAG | FRAME_LENGTH_MASK) >>> 0).toBe(0xffffffff)
  })

  it('leaves the flag free for every batch size the schedule can produce', () => {
    // A seal happens at ~32 KB, the beacon caps near 64 KB. Both are far below
    // the point where bit 31 would be needed for length.
    expect(64 * 1024).toBeLessThan(FRAME_LENGTH_MASK)
  })
})

describe('NEED', () => {
  it('is a symbol no decoded value can equal', () => {
    expect(typeof NEED).toBe('symbol')
    for (const v of [0, -1, '', 'need', null, undefined, false, 0n, Symbol('need')]) {
      expect(v === (NEED as unknown)).toBe(false)
    }
  })

  it('narrows a reader result by identity', () => {
    const read = (ok: boolean): { value: bigint; next: number } | typeof NEED =>
      ok ? { value: 1n, next: 1 } : NEED
    const a = read(true)
    expect(a === NEED).toBe(false)
    expect(a === NEED ? undefined : a.value).toBe(1n)
    expect(read(false) === NEED).toBe(true)
  })
})

describe('DETAIL_LEVELS', () => {
  it('is the ordered lattice the ceiling and trigger level index into', () => {
    expect([...DETAIL_LEVELS]).toEqual(['baseline', 'headers', 'headers+sizes', 'headers+data'])
  })

  it('starts at the always-on floor', () => {
    expect(DETAIL_LEVELS[0]).toBe('baseline')
  })

  it('lets a floor-only merge lower but never raise', () => {
    const floor = (a: string, b: string) =>
      DETAIL_LEVELS[Math.min(DETAIL_LEVELS.indexOf(a as never), DETAIL_LEVELS.indexOf(b as never))]
    expect(floor('headers+data', 'baseline')).toBe('baseline')
    expect(floor('baseline', 'headers+data')).toBe('baseline')
    expect(floor('headers', 'headers+sizes')).toBe('headers')
  })

  it('has no duplicate rungs, so an index is an unambiguous rank', () => {
    expect(new Set(DETAIL_LEVELS).size).toBe(DETAIL_LEVELS.length)
  })
})

describe('asAnyMessage', () => {
  it('widens without copying, so it costs nothing on the control path', () => {
    const msg = { type: 'subscribe_ok', track_alias: 5n }
    expect(asAnyMessage(msg)).toBe(msg)
  })

  it('leaves each message field spelling readable as written', () => {
    // The codec spells control-message fields in snake_case and data-stream
    // fields in camelCase, so a widened message must expose whatever the source
    // used rather than a normalised form.
    const snake = asAnyMessage({ type: 'publish', track_alias: 9n, request_id: 3n })
    expect(snake.track_alias).toBe(9n)
    expect(snake.request_id).toBe(3n)
    const camel = asAnyMessage({ trackAlias: 9n })
    expect(camel.trackAlias).toBe(9n)
    expect(camel.track_alias).toBeUndefined()
  })
})
