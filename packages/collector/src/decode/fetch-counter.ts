/**
 * The counting decoder for FETCH_HEADER streams.
 *
 * Hand-rolled for the same reason as the subgroup walk: nothing exported by
 * `@moqtap/codec` reports a fetch object's header length without materialising
 * its payload.
 *
 * A fetch stream's bucket is keyed on the Request ID in its header and
 * needs no epoch. `FetchStreamHeader` is `{type, requestId}` and nothing else,
 * and draft-20 Section 11.4.4 is explicit
 * that this is "the message identified by Request ID" — *the* message, not *the
 * FETCH* message, because a fill fetch stream (Section 5.1.3) names the
 * SUBSCRIBE or REQUEST_UPDATE that asked for the fill. The id is therefore
 * natively stable; ingest chains it back to a track through the control records,
 * which carry the stream id.
 *
 * From draft-16 a fetch object carries **no Object Status**. Status is only present on
 * subscription-delivered objects (Section 11.2.1.1) — which is also the one way
 * the two copies of a doubly delivered object differ. Reading a status varint
 * here would desynchronise the stream exactly as omitting it does on a subgroup
 * stream.
 *
 * The walk is draft-20's, and right from draft-20 on (see
 * {@link FETCH_HAND_WALK_FROM}). Every older draft differs somewhere a value
 * depends on: absolute Group IDs (15-17), absolute marker Group IDs (16-19),
 * absolute Object IDs (15-19), an Object Status (15), no Serialization Flags at
 * all (07-14). Its stream is walked by its adapter instead.
 */

import {
  type BucketKey,
  type CountingSink,
  type Direction,
  type DraftAdapter,
  type FetchHeaderInfo,
  type Mono,
  NEED,
  type Need,
  newCursor,
  type ObjectCursor,
  type ObjectHeaderFields,
  type ObjectHeaderInfo,
  type ObjectSample,
  type TrackKeyResolver,
  type VarintReader,
} from '../types.js'
import {
  DataStreamCounter,
  DEFAULT_HEADER_SLACK_BYTES,
  DESYNC,
  type Desync,
  type ParseRun,
} from './stream-walk.js'
import { type CounterOptions, withStream } from './subgroup-counter.js'

/** `FETCH_HEADER`'s stream type, identical in draft-19 and draft-20. */
const FETCH_STREAM_TYPE = 0x05n

/** Walk a FETCH_HEADER: `[0x05][Request ID]`. */
export function readFetchHeader(
  v: VarintReader,
  b: Uint8Array,
  i: number,
): FetchHeaderInfo | Need | Desync {
  const t = v.read(b, i)
  if (t === NEED) return NEED
  if (t.value !== FETCH_STREAM_TYPE) return DESYNC
  const rid = v.read(b, t.next)
  if (rid === NEED) return NEED
  return { requestId: rid.value, headerBytes: rid.next - i, next: rid.next }
}

/** The first draft whose fetch streams {@link readFetchObject} reads correctly. */
export const FETCH_HAND_WALK_FROM = 20

/**
 * Walk one record on a fetch stream, draft-20 Section 11.4.4.
 *
 * `marker` marks an End-of-Range marker (Section 11.4.4.2): a statement that a
 * range of Objects does not exist, is unknown, or timed out. Counting one as an
 * object would inflate every object rate on the track; its bytes are still
 * attributed, see {@link FetchCounter}.
 *
 * The cursor's Subgroup ID and priority move only on a complete object, and
 * never on a marker, which has neither.
 */
export function readFetchObject(
  v: VarintReader,
  b: Uint8Array,
  i: number,
  prev: ObjectCursor,
  slack: number,
): ObjectHeaderInfo | Need | Desync {
  const f = v.read(b, i)
  if (f === NEED) return NEED
  if (f.value > 0xffff_ffffn) return DESYNC
  const flags = Number(f.value)
  let p = f.next

  let groupId = prev.prevGroupId
  // Section 11.4.4.1: absent an Object ID Delta the id is the prior object's
  // plus one. Stream delta encoding, not a range end.
  let objectId = prev.prevObjectId + 1n

  if (flags >= 0x80) {
    // End-of-Range marker. Section 11.4.4.2: Group ID Delta, Object ID Delta
    // and a Payload Length encoded as 0, and no Subgroup ID or Priority of its
    // own. Draft-19 has two such markers and draft-20 three (0x8C, 0x10C and
    // draft-20's new 0x20C); the walk accepts any value at or above 0x80
    // because the *layout* is what it needs and a counting decoder that
    // enforced the enumeration would abandon a stream over a codepoint a later
    // draft adds — the failure mode a withheld adapter exists to avoid.
    const g = v.read(b, p)
    if (g === NEED) return NEED
    p = g.next
    groupId = prev.first ? g.value : prev.prevGroupId + g.value + 1n
    const o = v.read(b, p)
    if (o === NEED) return NEED
    p = o.next
    objectId = o.value
    const len = v.read(b, p)
    if (len === NEED) return NEED
    p = len.next
    const payloadLength = Number(len.value)
    if (!Number.isSafeInteger(payloadLength) || payloadLength < 0) return DESYNC
    return {
      objectId,
      groupId,
      payloadLength,
      headerBytes: p - i,
      next: p + payloadLength,
      marker: true,
    }
  }

  const datagramMode = (flags & 0x40) !== 0
  const objectIdPresent = (flags & 0x04) !== 0
  const groupIdPresent = (flags & 0x08) !== 0
  const priorityPresent = (flags & 0x10) !== 0
  const propsPresent = (flags & 0x20) !== 0

  if (groupIdPresent) {
    const g = v.read(b, p)
    if (g === NEED) return NEED
    p = g.next
    groupId = prev.first ? g.value : prev.prevGroupId + g.value + 1n
  } else if (prev.first) {
    // Section 11.4.4: the first object on a fetch stream must carry both ids.
    return DESYNC
  }

  // SUBGROUP_ID_ENCODING 0b11 is the only value with a field on the wire;
  // 0b00 is 0, 0b01 the prior object's and 0b10 the prior's plus one. DATAGRAM
  // mode has no Subgroup ID at all.
  const encoding = flags & 0x03
  let subgroupId = prev.prevSubgroupId
  if (!datagramMode) {
    if (encoding === 0x03) {
      const sg = v.read(b, p)
      if (sg === NEED) return NEED
      p = sg.next
      subgroupId = sg.value
    } else if (encoding === 0x00) {
      subgroupId = 0n
    } else if (prev.first) {
      // Section 11.4.4: there is no prior object to name.
      return DESYNC
    } else if (encoding === 0x02) {
      subgroupId += 1n
    }
  }

  if (objectIdPresent) {
    const o = v.read(b, p)
    if (o === NEED) return NEED
    p = o.next
    objectId = groupIdPresent ? o.value : prev.prevObjectId + o.value
  } else if (prev.first) {
    return DESYNC
  }

  // Absent, the priority is the prior object's.
  let priority = prev.prevPriority
  if (priorityPresent) {
    const byte = b[p]
    if (byte === undefined) return NEED
    priority = byte
    p += 1
  }

  if (propsPresent) {
    const propsLen = v.read(b, p)
    if (propsLen === NEED) return NEED
    p = propsLen.next
    const n = Number(propsLen.value)
    if (!Number.isSafeInteger(n) || n < 0 || n > slack) return DESYNC
    if (p + n > b.length) return NEED
    p += n
  }

  const len = v.read(b, p)
  if (len === NEED) return NEED
  p = len.next
  const payloadLength = Number(len.value)
  if (!Number.isSafeInteger(payloadLength) || payloadLength < 0) return DESYNC

  if (!datagramMode) prev.prevSubgroupId = subgroupId
  prev.prevPriority = priority
  prev.hadSubgroup = !datagramMode
  return { objectId, groupId, payloadLength, headerBytes: p - i, next: p + payloadLength }
}

/**
 * O(1) memory per stream. Payload bytes are skipped, never viewed.
 *
 * Its {@link ObjectHeaderFields} are the last object's, which is the one being
 * reported while the sink's `onObject` runs.
 */
export class FetchCounter extends DataStreamCounter implements ObjectHeaderFields {
  private header: FetchHeaderInfo | null = null
  private key: BucketKey | null = null
  private capped = false
  private pendingHeaderBytes = 0
  private readonly streamId: number
  private readonly cursor: ObjectCursor = newCursor()
  private readonly v: VarintReader
  /** Set for a draft before {@link FETCH_HAND_WALK_FROM}: its adapter walks the stream. */
  private readonly older: DraftAdapter | null

  constructor(
    private readonly dir: Direction,
    private readonly keys: TrackKeyResolver,
    private readonly sink: CountingSink,
    a: DraftAdapter,
    opts?: CounterOptions,
  ) {
    super(opts?.slackBytes ?? DEFAULT_HEADER_SLACK_BYTES)
    this.streamId = opts?.streamId ?? -1
    this.v = a.varint
    this.older = a.draft < FETCH_HAND_WALK_FROM ? a : null
  }

  get bucketKey(): BucketKey | null {
    return this.key
  }

  get priority(): number {
    return this.cursor.prevPriority
  }

  get subgroupId(): bigint | null {
    return this.cursor.hadSubgroup ? this.cursor.prevSubgroupId : null
  }

  protected override parse(b: Uint8Array, at: Mono): ParseRun {
    let i = 0
    while (i < b.length) {
      if (this.header === null) {
        const h =
          this.older === null ? readFetchHeader(this.v, b, i) : this.older.readFetchHeader(b, i)
        if (h === NEED) break
        if (h === DESYNC) return { consumed: i, skip: 0, desync: true }
        this.header = h
        this.pendingHeaderBytes = h.headerBytes
        this.key = this.keys.fetchKey(this.dir, h.requestId)
        if (this.key === null && !this.capped) {
          this.capped = true
          this.sink.onParseFailure(null, 'bucket-cap')
        }
        i = h.next
        continue
      }

      const o =
        this.older === null
          ? readFetchObject(this.v, b, i, this.cursor, this.slack)
          : this.older.readFetchObject(b, i, this.cursor)
      if (o === NEED) break
      if (o === DESYNC) return { consumed: i, skip: 0, desync: true }

      if (o.marker === true) {
        // A marker is not an object. Its bytes ride along on the next real one
        // so the track's byte total still balances against the wire.
        this.pendingHeaderBytes += o.headerBytes
      } else {
        this.emit(o, at)
      }
      // Section 11.4.4.2: prior Group ID and prior Object ID come FROM a marker,
      // so the cursor advances for markers too.
      this.cursor.first = false
      this.cursor.prevObjectId = o.objectId
      this.cursor.prevGroupId = o.groupId

      if (o.next > b.length) {
        return { consumed: b.length, skip: o.next - b.length, desync: false }
      }
      i = o.next
    }
    return { consumed: i, skip: 0, desync: false }
  }

  protected override onDesync(): void {
    this.sink.onParseFailure(this.key, 'fetch-desync')
  }

  private emit(o: ObjectHeaderInfo, at: Mono): void {
    const headerBytes = o.headerBytes + this.pendingHeaderBytes
    this.pendingHeaderBytes = 0
    const key = this.key
    if (key === null) return
    // Only drafts 07-15 put an Object Status on a fetch object.
    const sample: ObjectSample =
      o.status === undefined
        ? {
            key,
            groupId: o.groupId,
            objectId: o.objectId,
            headerBytes,
            payloadBytes: o.payloadLength,
            at,
          }
        : {
            key,
            groupId: o.groupId,
            objectId: o.objectId,
            headerBytes,
            payloadBytes: o.payloadLength,
            status: o.status,
            at,
          }
    this.sink.onObject(withStream(sample, this.streamId))
  }
}
