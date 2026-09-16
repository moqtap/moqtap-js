/**
 * The dump's shape: one record, columns rather than rows.
 *
 * A window that held 30,000 objects produces one
 * {@link import('../types.js').FlightRecord}, not 30,000 records, and inside it
 * the per-object timings are six parallel arrays rather than 30,000 objects
 * each repeating its own field names. Two reasons:
 *
 *  1. Payload is 191× the control plane at `headers` detail and 282× at
 *     `headers+sizes`. A dump is the largest thing this collector sends and it
 *     goes out when the network is at its worst — the trigger is the trouble
 *     signal — so every byte saved is one not competing with the customer's
 *     media.
 *  2. Column-major compresses far better than row-major: each column holds one
 *     kind of number with one distribution — arrival times rising
 *     monotonically, group ids repeating in runs, sizes clustered around a
 *     GOP's shape — so gzip's window sees runs instead of an interleave of six
 *     unrelated value spaces. 22.6× is the number the envelope budget rests on;
 *     a row-major dump does not reach it.
 *
 * The column names stay descriptive: they appear once per dump, not once per
 * object.
 */

import { type BucketKey, bucketKeyString, type FlightRecord, type Mono } from '../types.js'

/**
 * One object as the re-parse recovered it — the row form, which exists only
 * inside this module and never on the wire.
 *
 * `deliveryMs` is the wire time the object's bytes took to arrive, from the
 * chunk carrying its first header byte to the chunk carrying its last payload
 * byte. It is available only because the ring kept the raw bytes with their
 * seam-stamped arrival times; the counting decoder never sees an object twice
 * and cannot report it.
 */
export interface ObjectTiming {
  readonly key: BucketKey
  /** Seam-stamped arrival of the object's first header byte, un-rebased. */
  readonly at: Mono
  readonly groupId: bigint
  readonly objectId: bigint
  /** Header **plus** payload: every wire byte the object occupied. */
  readonly bytes: number
  /**
   * Arrival span of the object's bytes, in ms. Zero when the whole object
   * arrived inside one chunk — the seam stamps chunks, so it cannot see finer.
   */
  readonly deliveryMs: number
}

/** The six parallel arrays of {@link FlightRecord.cols}. */
export type ColumnarBlock = FlightRecord['cols']

/**
 * Decimal places kept on a millisecond column.
 *
 * Microseconds. `performance.now()` is already clamped coarser than this in
 * every shipping browser (5 µs cross-origin-isolated, 100 µs to 1 ms
 * otherwise), so this rounds away float noise rather than measurement — and
 * float noise is the worst input to a compressor, making every value in a
 * column a distinct 17-digit string.
 */
export const TIME_DECIMALS = 3

const TIME_SCALE = 10 ** TIME_DECIMALS

/** Round to {@link TIME_DECIMALS}, without `toFixed`'s string round-trip. */
export function roundMs(v: number): number {
  return Number.isFinite(v) ? Math.round(v * TIME_SCALE) / TIME_SCALE : 0
}

/**
 * Rows to columns.
 *
 * `originMono` rebases arrival times onto the session anchor, as
 * {@link import('../types.js').RecordBase.ts} requires of every `Mono` in the
 * envelope: ingest receives "ms since this session started", never a raw
 * `performance.now()`, which is meaningless off the device.
 *
 * Group and object ids narrow to `number` here. They are `bigint` on the wire
 * (vi64, up to 2⁶²) and `FlightRecord.cols` declares `readonly number[]`, which
 * `JSON.stringify` requires — it throws on a bigint. Ids above 2⁵³ therefore
 * lose precision silently; the alternative, decimal strings as
 * `RollupTrackWire.key.v` uses, needs a type change this module may not make.
 */
export function encodeColumnar(rows: readonly ObjectTiming[], originMono: Mono = 0): ColumnarBlock {
  const n = rows.length
  const key: string[] = new Array(n)
  const at: number[] = new Array(n)
  const group: number[] = new Array(n)
  const object: number[] = new Array(n)
  const bytes: number[] = new Array(n)
  const deliveryMs: number[] = new Array(n)

  for (let i = 0; i < n; i++) {
    const r = rows[i] as ObjectTiming
    // The one place a bucket key is stringified for the wire. `bucketKeyString`
    // is shared with the rollup's rows and the `hdr` records on purpose: the
    // three must agree byte for byte or ingest re-splits one track into several.
    key[i] = bucketKeyString(r.key)
    at[i] = roundMs(r.at - originMono)
    group[i] = Number(r.groupId)
    object[i] = Number(r.objectId)
    bytes[i] = r.bytes
    deliveryMs[i] = roundMs(r.deliveryMs)
  }

  return { key, at, group, object, bytes, deliveryMs }
}
