/**
 * The other half: the ring, re-parsed at full resolution, exactly once.
 *
 * Every line of work in this file sits behind {@link FlightRecorder.fire}. There
 * is no per-object hook, no per-chunk hook and no armed-mode bookkeeping of any
 * kind: while armed, this module's entire contribution to the data path is that
 * somebody else pushes bytes into a `ByteRing` that overwrites them.
 *
 * ── Why the walk is here and not in the counting decoder.
 *
 * The counting decoder sees each object once, in one direction, and reports the
 * chunk time at which its header completed. It cannot report a **delivery
 * duration**, because that needs the object's first byte and its last byte and
 * the decoder has already discarded the first by the time the last arrives. The
 * ring kept the bytes *and* their seam-stamped arrival times, so it is the only
 * place that measurement can come from.
 *
 * This is a second walk over the same bytes, but not a second *implementation*
 * of the walk: it drives {@link DraftAdapter}'s header readers, the same
 * functions the counting decoder drives. What differs is the bookkeeping around
 * them — contiguous bytes instead of a chunk carry, an offset→arrival index
 * instead of a single timestamp.
 *
 * ── Two properties that look like details and are not.
 *
 *  1. **A subgroup stream cannot be resynchronised mid-stream.** Its objects
 *     delta-encode against their predecessors and its header is read once, so a
 *     walk that starts at an arbitrary byte produces plausible garbage rather
 *     than an error. The walk therefore always starts at the **oldest bytes the
 *     ring still holds** for a stream, and the requested window filters which
 *     objects are *reported*, not where parsing begins. A stream whose head the
 *     ring has already overwritten is skipped whole and the record says
 *     `truncated`.
 *  2. **Payload bytes never leave.** What crosses from the ring to the flush
 *     buffer is derived records — per-object timings, delivery durations. The
 *     walk reaches a payload only by adding its declared length to an offset; no
 *     payload is ever viewed, copied or measured for content.
 */

import type { ByteRing, RingEntry } from '../ring/index.js'
import {
  type BucketKey,
  type BucketKind,
  type DetailLevel,
  type Direction,
  type DraftAdapter,
  type FetchHeaderInfo,
  type FlightRecord,
  type Mono,
  NEED,
  type ObjectCursor,
  type ObjectHeaderInfo,
  type PendingRequest,
  type RecordSink,
  type SubgroupHeaderInfo,
  type TrackKeyResolver,
  type TriggerConfig,
  type TriggerKind,
} from '../types.js'
import { type ColumnarBlock, encodeColumnar, type ObjectTiming, roundMs } from './columnar.js'
import type { TriggerEvent } from './triggers.js'

/**
 * The `streamId` a datagram is pushed into the ring under.
 *
 * Datagrams have no stream. The ring's entry shape requires a `streamId`
 * anyway, so this module fixes a sentinel rather than leaving each caller to
 * invent one: **any negative id is a datagram**, and this is the value to push.
 * A datagram entry is one whole datagram, which is what makes it decodable on
 * its own — unlike a stream chunk, which is a slice of a byte stream.
 */
export const DATAGRAM_STREAM_ID = -1

/**
 * Objects one dump may carry.
 *
 * At the default `'32MB'` depth a 1 KB-object stream holds roughly 32,000
 * objects and a 200-byte datagram stream roughly 160,000, so this covers the
 * ordinary case whole and bounds the pathological one. Past it the objects
 * **nearest the trigger** are kept — the dump exists to show the moments just
 * before it broke, so the head is what to lose — and the record says
 * `truncated`.
 */
export const DEFAULT_MAX_OBJECTS = 50_000

/** The window a dump covers. `fromMono` may be `-Infinity`: the whole ring. */
export interface ReplayWindow {
  readonly fromMono: Mono
  readonly toMono: Mono
}

export interface ReplayOptions {
  /**
   * The live bucket keys.
   *
   * Pass the decoder's `TrackKeys` so the dump's `cols.key` entries are byte
   * identical to the rollup rows for the same tracks — including the **alias
   * epoch**, which a fresh resolver cannot reconstruct from a window that does
   * not contain the binding. Without it the fallback mints epoch-0 keys and
   * ingest must join on `(dir, kind, id)` and time instead.
   */
  readonly keys?: TrackKeyResolver
  /** Session anchor. Every `Mono` on the wire is relative to it. */
  readonly originMono?: Mono
  /** See {@link DEFAULT_MAX_OBJECTS}. */
  readonly maxObjects?: number
}

/** What one walk of the ring recovered, before it becomes a record. */
export interface ReplayResult {
  /** Ordered by arrival across every stream, oldest first. */
  readonly rows: readonly ObjectTiming[]
  /** The window did not fit, or part of it could not be parsed. */
  readonly truncated: boolean
  /** Streams whose head the ring no longer held, or that did not parse. */
  readonly streamsSkipped: number
  /** Objects dropped to stay under {@link DEFAULT_MAX_OBJECTS}. */
  readonly objectsDropped: number
  /** Objects the bucket cap could not key. Counted, never merged. */
  readonly objectsUnkeyed: number
  readonly windowStart: Mono
  readonly windowEnd: Mono
}

/**
 * Walk the ring and recover per-object wire timings.
 *
 * Cold path by construction: it runs only after a trigger has already fired.
 * Memory peaks at the snapshot plus one stream's contiguous bytes — streams are
 * concatenated and released one at a time rather than all at once, because the
 * snapshot of a 32 MB ring is already a 32 MB copy taken on the main thread and
 * doubling that at the moment the network is worst is exactly the interference
 * this collector must not cause.
 */
export function replayWindow(
  ring: ByteRing,
  a: DraftAdapter,
  window: ReplayWindow,
  opts?: ReplayOptions,
): ReplayResult {
  const keys = opts?.keys ?? new ReplayKeys()
  const maxObjects =
    opts?.maxObjects !== undefined && opts.maxObjects > 0 ? opts.maxObjects : DEFAULT_MAX_OBJECTS

  // Everything the ring holds up to the trigger, not just the reported window:
  // see property 1 in the module header. `snapshotWindow` stops at `toMono`, so
  // bytes that arrived after the trigger are never read.
  const entries = ring.snapshotWindow(Number.NEGATIVE_INFINITY, window.toMono)

  const rows: ObjectTiming[] = []
  let streamsSkipped = 0
  let objectsUnkeyed = 0

  // Grouped by (streamId, direction): one bidirectional stream is two byte
  // streams under one id, and splicing them together desynchronises the walk on
  // the first response — the same reason the dispatcher keys its table that way.
  const groups = new Map<number, RingEntry[]>()
  const datagrams: RingEntry[] = []
  for (const e of entries) {
    if (e.control) continue
    if (e.streamId < 0) {
      datagrams.push(e)
      continue
    }
    const slot = e.streamId * 2 + (e.dir === 'tx' ? 0 : 1)
    const list = groups.get(slot)
    if (list === undefined) groups.set(slot, [e])
    else list.push(e)
  }

  for (const [slot, list] of groups) {
    const walked = walkStream(list, a, keys, window, rows)
    if (!walked.parsed) streamsSkipped++
    objectsUnkeyed += walked.unkeyed
    // Release the stream's bytes before concatenating the next one.
    groups.set(slot, [])
  }

  for (const e of datagrams) {
    const counts = a.decodeDatagram(e.data)
    if (counts === null) continue
    if (e.atMono < window.fromMono || e.atMono > window.toMono) continue
    const key = keys.aliasKey(e.dir, counts.trackAlias)
    if (key === null) {
      objectsUnkeyed++
      continue
    }
    rows.push({
      key,
      at: e.atMono,
      groupId: counts.groupId,
      objectId: counts.objectId,
      bytes: counts.headerBytes + counts.payloadBytes,
      // A datagram arrives whole or not at all: there is no span to measure.
      deliveryMs: 0,
    })
  }

  rows.sort(byArrival)

  let objectsDropped = 0
  let kept: ObjectTiming[] = rows
  if (rows.length > maxObjects) {
    objectsDropped = rows.length - maxObjects
    kept = rows.slice(rows.length - maxObjects)
  }

  // Truncation, in the three ways it can happen. All three mean the same thing
  // to a reader — do not assume this dump is the whole window — and the
  // honesty rule says it must be said rather than left to be inferred from a
  // suspiciously short column.
  const oldest = entries.length > 0 ? (entries[0] as RingEntry).atMono : window.toMono
  // The ring has evicted, and the requested window reaches back past the oldest
  // byte it still holds: the head of the window is gone. With no `preRollMs` the
  // request reaches back forever, so any eviction at all truncates — which is
  // the byte bound saying how far back it could afford to go.
  const overwritten = ring.evicted > 0 && oldest > window.fromMono
  // A chunk larger than the whole ring was refused, which leaves a hole in the
  // MIDDLE of some stream rather than trimming its head. The ring cannot say
  // which stream, so no stream's bytes may be assumed contiguous.
  const holed = ring.refused > 0
  const truncated = overwritten || holed || streamsSkipped > 0 || objectsDropped > 0

  return {
    rows: kept,
    truncated,
    streamsSkipped,
    objectsDropped,
    objectsUnkeyed,
    windowStart: Number.isFinite(window.fromMono) ? Math.max(window.fromMono, oldest) : oldest,
    windowEnd: window.toMono,
  }
}

/**
 * {@link replayWindow} as one finished record.
 *
 * `trigger` defaults to `'stall'` only so this stays callable with the three
 * arguments the module contract names; {@link FlightRecorder} always passes the
 * kind that actually fired.
 */
export function replayRing(
  ring: ByteRing,
  a: DraftAdapter,
  window: ReplayWindow,
  opts?: ReplayOptions & { readonly trigger?: TriggerKind; readonly level?: DetailLevel },
): FlightRecord {
  const origin = opts?.originMono ?? 0
  const r = replayWindow(ring, a, window, opts)
  return {
    t: 'flight',
    ts: roundMs(window.toMono - origin),
    // The dump is the first record of the capture window the trigger opened, so
    // it carries that window's elevated level and never baseline.
    lvl: opts?.level ?? 'headers',
    trigger: opts?.trigger ?? 'stall',
    windowStart: roundMs(r.windowStart - origin),
    windowEnd: roundMs(r.windowEnd - origin),
    cols: encodeColumnar(r.rows, origin),
    truncated: r.truncated,
  }
}

/* ── the walk ────────────────────────────────────────────────────────────── */

interface WalkResult {
  readonly parsed: boolean
  readonly unkeyed: number
}

interface StreamBytes {
  readonly bytes: Uint8Array
  /** Start offset of each chunk. Parallel to {@link times}. */
  readonly starts: number[]
  readonly times: number[]
}

function walkStream(
  list: readonly RingEntry[],
  a: DraftAdapter,
  keys: TrackKeyResolver,
  window: ReplayWindow,
  out: ObjectTiming[],
): WalkResult {
  if (list.length === 0) return { parsed: false, unkeyed: 0 }
  const first = list[0] as RingEntry
  const s = concat(list)
  if (s.bytes.length === 0) return { parsed: false, unkeyed: 0 }

  // MoQT permits non-minimal varints, so a first byte is a heuristic and
  // `'unknown'` is an ordinary outcome — but a stream we cannot classify is a
  // stream we cannot walk, and guessing costs the stream.
  const kind = a.sniff(s.bytes[0] as number)
  if (kind === 'subgroup') return walkSubgroup(s, first.dir, a, keys, window, out)
  if (kind === 'fetch') return walkFetch(s, first.dir, a, keys, window, out)
  return { parsed: false, unkeyed: 0 }
}

function walkSubgroup(
  s: StreamBytes,
  dir: Direction,
  a: DraftAdapter,
  keys: TrackKeyResolver,
  window: ReplayWindow,
  out: ObjectTiming[],
): WalkResult {
  const b = s.bytes
  const h = a.readSubgroupHeader(b, 0)
  if (h === NEED || !isSubgroupHeader(h)) return { parsed: false, unkeyed: 0 }
  const key = keys.aliasKey(dir, h.trackAlias)

  const cursor: ObjectCursor = { first: true, prevObjectId: 0n, prevGroupId: 0n }
  // The stream header's own bytes ride on the first object, so no byte on the
  // stream goes unattributed — the same attribution the counting decoder makes.
  let carriedHeaderBytes = h.headerBytes
  let i = h.next
  let unkeyed = 0

  while (i < b.length) {
    const o = a.readSubgroupObject(b, i, h, cursor)
    if (o === NEED || !isObjectHeader(o)) break
    // The last object of a window is routinely still arriving: its declared
    // payload runs past the bytes the ring holds. Its delivery duration is not
    // knowable, so it is not reported — and this is the expected tail of every
    // live capture, not a truncation of history.
    if (o.next > b.length) break

    if (key !== null) {
      const at = timeAt(s, i)
      if (at >= window.fromMono && at <= window.toMono) {
        out.push({
          key,
          at,
          groupId: o.groupId,
          objectId: o.objectId,
          bytes: o.headerBytes + o.payloadLength + carriedHeaderBytes,
          deliveryMs: Math.max(0, timeAt(s, o.next - 1) - at),
        })
      }
    } else {
      unkeyed++
    }

    carriedHeaderBytes = 0
    cursor.first = false
    cursor.prevObjectId = o.objectId
    cursor.prevGroupId = o.groupId
    i = o.next
  }

  return { parsed: true, unkeyed }
}

function walkFetch(
  s: StreamBytes,
  dir: Direction,
  a: DraftAdapter,
  keys: TrackKeyResolver,
  window: ReplayWindow,
  out: ObjectTiming[],
): WalkResult {
  const b = s.bytes
  const h = a.readFetchHeader(b, 0)
  if (h === NEED || !isFetchHeader(h)) return { parsed: false, unkeyed: 0 }
  const key = keys.fetchKey(dir, h.requestId)

  const cursor: ObjectCursor = { first: true, prevObjectId: 0n, prevGroupId: 0n }
  let carriedHeaderBytes = h.headerBytes
  let i = h.next
  let unkeyed = 0

  while (i < b.length) {
    // the End-of-Range markers are gap statements, not objects: they
    // declare that a range does not exist, is unknown, or timed out. Counting
    // one as an object would inflate the dump's object count against the
    // rollup's for the same track — the two must agree. Its bytes still ride
    // along on the next real object, exactly as the counting decoder does it.
    const flags = a.varint.read(b, i)
    if (flags === NEED) break
    const marker = flags.value >= 0x80n

    const o = a.readFetchObject(b, i, cursor)
    if (o === NEED || !isObjectHeader(o)) break
    if (o.next > b.length) break

    if (marker) {
      carriedHeaderBytes += o.headerBytes + o.payloadLength
      cursor.first = false
      cursor.prevObjectId = o.objectId
      cursor.prevGroupId = o.groupId
      i = o.next
      continue
    }

    if (key !== null) {
      const at = timeAt(s, i)
      if (at >= window.fromMono && at <= window.toMono) {
        out.push({
          key,
          at,
          groupId: o.groupId,
          objectId: o.objectId,
          bytes: o.headerBytes + o.payloadLength + carriedHeaderBytes,
          deliveryMs: Math.max(0, timeAt(s, o.next - 1) - at),
        })
      }
    } else {
      unkeyed++
    }

    carriedHeaderBytes = 0
    cursor.first = false
    cursor.prevObjectId = o.objectId
    cursor.prevGroupId = o.groupId
    i = o.next
  }

  return { parsed: true, unkeyed }
}

function concat(list: readonly RingEntry[]): StreamBytes {
  let total = 0
  for (const e of list) total += e.data.length
  const bytes = new Uint8Array(total)
  const starts: number[] = new Array(list.length)
  const times: number[] = new Array(list.length)
  let off = 0
  for (let n = 0; n < list.length; n++) {
    const e = list[n] as RingEntry
    starts[n] = off
    times[n] = e.atMono
    bytes.set(e.data, off)
    off += e.data.length
  }
  return { bytes, starts, times }
}

/**
 * When the byte at `off` arrived.
 *
 * The seam stamps a chunk, not a byte, so this is the arrival of the chunk that
 * carried it — which is the finest resolution that exists anywhere in this
 * package. Binary search rather than a scan: a long-lived stream in a 32 MB ring
 * can hold thousands of chunks and this is called twice per object.
 */
function timeAt(s: StreamBytes, off: number): Mono {
  const starts = s.starts
  let lo = 0
  let hi = starts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if ((starts[mid] as number) <= off) lo = mid
    else hi = mid - 1
  }
  return s.times[lo] as Mono
}

function byArrival(x: ObjectTiming, y: ObjectTiming): number {
  return x.at - y.at
}

/*
 * The adapter's walk methods are declared `T | Need` and the two shipped
 * adapters return exactly that. These guards are the seam's belt: a walk that
 * grew a third outcome — the decode module's `DESYNC` symbol is one, and its own
 * copies of these walks do return it — would otherwise reach `o.next` on a
 * symbol, yield `NaN`, and push a row of `NaN`s rather than stopping. Three
 * `in` checks on a cold path is a cheap price for that not being possible.
 */

function isSubgroupHeader(v: unknown): v is SubgroupHeaderInfo {
  return typeof v === 'object' && v !== null && 'trackAlias' in v && 'next' in v
}

function isFetchHeader(v: unknown): v is FetchHeaderInfo {
  return typeof v === 'object' && v !== null && 'requestId' in v && 'next' in v
}

function isObjectHeader(v: unknown): v is ObjectHeaderInfo {
  return typeof v === 'object' && v !== null && 'payloadLength' in v && 'next' in v
}

/**
 * The fallback bucket keys, used only when no live resolver is supplied.
 *
 * It mints `epoch: 0` keys and nothing else — no cap, no rebind detection, no
 * control plane. That is honest for a replay taken in isolation (a test, or a
 * capture replayed offline) and **wrong for a live dump**, where an alias may
 * have been rebound and the rollup's rows carry a later epoch. Pass
 * {@link ReplayOptions.keys} on the live path.
 */
export class ReplayKeys implements TrackKeyResolver {
  private readonly alias = new Map<string, BucketKey>()
  private readonly fetch = new Map<string, BucketKey>()
  readonly bucketsRefused = 0

  aliasKey(dir: Direction, alias: bigint): BucketKey {
    return this.intern(this.alias, dir, 'alias', alias)
  }

  fetchKey(dir: Direction, requestId: bigint): BucketKey {
    return this.intern(this.fetch, dir, 'fetch', requestId)
  }

  /** A replay reads no control plane: the epoch it would learn is already past. */
  applyControl(): void {}

  pendingFor(): PendingRequest | undefined {
    return undefined
  }

  private intern(
    m: Map<string, BucketKey>,
    dir: Direction,
    kind: BucketKind,
    id: bigint,
  ): BucketKey {
    const tag = `${dir}:${id}`
    const found = m.get(tag)
    if (found !== undefined) return found
    const key: BucketKey = Object.freeze({ dir, kind, id, epoch: 0 })
    m.set(tag, key)
    return key
  }
}

/* ── the recorder ────────────────────────────────────────────────────────── */

export interface FlightRecorderOptions {
  readonly ring: ByteRing
  readonly sink: RecordSink
  /**
   * The loaded draft, looked up at fire time.
   *
   * A getter rather than a value because the draft module loads *after* the
   * session's protocol is negotiated, while the recorder is armed from `init()`
   * — and because the adapter is withheld entirely when the customer's pin
   * disagrees with the negotiated protocol. `undefined` means the session is
   * degraded and no re-parse is possible; the fire is counted, not faked.
   */
  readonly adapter: () => DraftAdapter | undefined
  /** The live `TrackKeys`. See {@link ReplayOptions.keys}. */
  readonly keys?: () => TrackKeyResolver | undefined
  /** The level the capture window runs at. Defaults to `'headers'`. */
  readonly level?: () => DetailLevel
  readonly originMono?: Mono
  /**
   * How far before the trigger to report, in ms.
   *
   * Absent by default: the recorder is bounded **in bytes, never in seconds**,
   * and absent means "everything the ring still holds". A value here is a
   * second, tighter bound for a customer who wants one, never the primary one.
   */
  readonly preRollMs?: number
  readonly maxObjects?: number
}

/**
 * The recorder: armed for free, one record per trigger.
 *
 * `arm()` takes the {@link TriggerConfig} as well as setting the flag, and
 * {@link fire} refuses a kind the armed config does not enable. That is a second
 * lock on the same door: the trigger engine already will not fire a disabled
 * kind, but a stale or misconfigured engine must not be able to open a capture
 * window through this object either.
 */
export class FlightRecorder {
  private readonly o: FlightRecorderOptions
  private config: TriggerConfig | null = null
  private fired = 0
  private skipped = 0
  private lastRecord: FlightRecord | null = null

  constructor(o: FlightRecorderOptions) {
    this.o = o
  }

  /** True between {@link arm} and {@link disarm}. Costs nothing on its own. */
  get armed(): boolean {
    return this.config !== null
  }

  get capturesFired(): number {
    return this.fired
  }

  /**
   * Triggers that reached {@link fire} and produced no record: disarmed, a kind
   * the config does not enable, or a session with no usable draft adapter.
   */
  get capturesSkipped(): number {
    return this.skipped
  }

  /** The most recent dump, for `usage()` and for tests. Never re-sent. */
  get last(): FlightRecord | null {
    return this.lastRecord
  }

  arm(c: TriggerConfig): void {
    this.config = c
  }

  /**
   * Stop capturing. **The ring is not cleared**: it belongs to the session, is
   * shared with the dormant buffer, and `stop()`/`abort()` clear it.
   * A recorder that cleared it here would destroy a buffer it does not own.
   */
  disarm(): void {
    this.config = null
  }

  /**
   * A trigger fired: re-parse the window it names and emit one record.
   *
   * The dump is the capture window's **first** record, not a separate event: it
   * covers the moments before the window opened and is included in it. Emitting
   * is unconditional once a re-parse is possible — a window that recovered no
   * objects still says so, because silence would be indistinguishable from a
   * collector that never fired.
   */
  fire(e: TriggerEvent): void {
    const config = this.config
    if (config === null || !enabled(config, e.kind)) {
      this.skipped++
      return
    }
    const a = this.o.adapter()
    if (a === undefined) {
      this.skipped++
      return
    }

    const origin = this.o.originMono ?? 0
    const preRoll = this.o.preRollMs
    const window: ReplayWindow = {
      fromMono:
        preRoll !== undefined && preRoll > 0 ? e.atMono - preRoll : Number.NEGATIVE_INFINITY,
      toMono: e.atMono,
    }

    const keys = this.o.keys?.()
    const r = replayWindow(this.o.ring, a, window, {
      ...(keys !== undefined ? { keys } : {}),
      ...(this.o.maxObjects !== undefined ? { maxObjects: this.o.maxObjects } : {}),
    })

    const cols: ColumnarBlock = encodeColumnar(r.rows, origin)
    const record: FlightRecord = {
      t: 'flight',
      ts: roundMs(e.atMono - origin),
      lvl: this.o.level?.() ?? 'headers',
      trigger: e.kind,
      windowStart: roundMs(r.windowStart - origin),
      windowEnd: roundMs(r.windowEnd - origin),
      cols,
      truncated: r.truncated,
    }
    this.lastRecord = record
    this.fired++
    this.o.sink.json(record)
  }
}

function enabled(c: TriggerConfig, kind: TriggerKind): boolean {
  switch (kind) {
    case 'stall':
      return c.stall !== undefined
    case 'cadence':
      return c.cadence !== undefined
    default:
      return c.trackSwitch !== undefined
  }
}
