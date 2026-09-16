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
 * A fetch object carries **no Object Status**. Status is only present on
 * subscription-delivered objects (Section 11.2.1.1) — which is also the one way
 * the two copies of a doubly delivered object differ. Reading a status varint
 * here would desynchronise the stream exactly as omitting it does on a subgroup
 * stream.

 */

import {
  type BucketKey,
  type CountingSink,
  type Direction,
  type FetchHeaderInfo,
  type Mono,
  NEED,
  type Need,
  type ObjectCursor,
  type ObjectHeaderInfo,
  type ObjectSample,
  type SupportedDraft,
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
import type { CounterOptions } from './subgroup-counter.js'

/** `FETCH_HEADER`'s stream type, identical in draft-19 and draft-20. */
const FETCH_STREAM_TYPE = 0x05n

/**
 * One walked fetch record.
 *
 * `marker` distinguishes an End-of-Range marker (Section 11.4.4.2) from a real
 * object. A marker declares that a range of Objects does not exist, is unknown,
 * or timed out; it is a gap statement, not an object, and counting it as one
 * would inflate every object rate on the track. Its bytes are still attributed —
 * see {@link FetchCounter}.
 */
export interface FetchObjectInfo extends ObjectHeaderInfo {
  readonly marker: boolean
}

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

/**
 * Walk one record on a fetch stream, draft-20 Section 11.4.4.
 *
 * `relativeObjectId` selects the one place draft-19 and draft-20 disagree on a
 * *value* (never on a byte count): draft-20 resolves an Object ID Delta against
 * the prior object when no Group ID Delta accompanies it, where draft-19
 * always reads it as absolute. With a Group ID Delta present
 * the two agree, so the divergence only reaches objects that stay within a
 * group and omit their group delta.
 */
export function readFetchObject(
  v: VarintReader,
  b: Uint8Array,
  i: number,
  prev: ObjectCursor,
  slack: number,
  relativeObjectId: boolean,
): FetchObjectInfo | Need | Desync {
  const f = v.read(b, i)
  if (f === NEED) return NEED
  if (f.value > 0xffff_ffffn) return DESYNC
  const flags = Number(f.value)
  let p = f.next

  let groupId = prev.prevGroupId
  // Section 11.4.4.1: absent an Object ID Delta the id is the prior object's
  // plus one. Stream delta encoding, not a range end.
  let objectId = prev.prevObjectId + 1n
  let marker = false

  if (flags >= 0x80) {
    // End-of-Range marker. Section 11.4.4.2: Group ID Delta, Object ID Delta
    // and a Payload Length encoded as 0, and no Subgroup ID or Priority of its
    // own. Draft-19 has two such markers and draft-20 three (0x8C, 0x10C and
    // draft-20's new 0x20C); the walk accepts any value at or above 0x80
    // because the *layout* is what it needs and a counting decoder that
    // enforced the enumeration would abandon a stream over a codepoint a later
    // draft adds — the failure mode a withheld adapter exists to avoid.
    marker = true
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
    return { objectId, groupId, payloadLength, headerBytes: p - i, next: p + payloadLength, marker }
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

  // SUBGROUP_ID_ENCODING 0b11 is the only value with a field on the wire, and
  // DATAGRAM mode has no Subgroup ID field at all.
  if (!datagramMode && (flags & 0x03) === 0x03) {
    const sg = v.read(b, p)
    if (sg === NEED) return NEED
    p = sg.next
  }

  if (objectIdPresent) {
    const o = v.read(b, p)
    if (o === NEED) return NEED
    p = o.next
    objectId = relativeObjectId && !groupIdPresent ? prev.prevObjectId + o.value : o.value
  } else if (prev.first) {
    return DESYNC
  }

  if (priorityPresent) {
    if (p + 1 > b.length) return NEED
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

  return { objectId, groupId, payloadLength, headerBytes: p - i, next: p + payloadLength, marker }
}

export interface FetchCounterOptions extends CounterOptions {
  /**
   * Which draft's Object ID resolution to use. Defaults to 20 — the newer rule,
   * and the one a draft-19 stream only diverges from on objects that omit their
   * Group ID Delta.
   */
  readonly draft?: SupportedDraft
}

/** O(1) memory per stream. Payload bytes are skipped, never viewed. */
export class FetchCounter extends DataStreamCounter {
  private header: FetchHeaderInfo | null = null
  private key: BucketKey | null = null
  private capped = false
  private pendingHeaderBytes = 0
  private readonly relativeObjectId: boolean
  private readonly cursor: ObjectCursor = { first: true, prevObjectId: 0n, prevGroupId: 0n }

  constructor(
    private readonly dir: Direction,
    private readonly keys: TrackKeyResolver,
    private readonly sink: CountingSink,
    private readonly v: VarintReader,
    opts?: FetchCounterOptions,
  ) {
    super(opts?.slackBytes ?? DEFAULT_HEADER_SLACK_BYTES)
    this.relativeObjectId = (opts?.draft ?? 20) >= 20
  }

  get bucketKey(): BucketKey | null {
    return this.key
  }

  protected override parse(b: Uint8Array, at: Mono): ParseRun {
    let i = 0
    while (i < b.length) {
      if (this.header === null) {
        const h = readFetchHeader(this.v, b, i)
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

      const o = readFetchObject(this.v, b, i, this.cursor, this.slack, this.relativeObjectId)
      if (o === NEED) break
      if (o === DESYNC) return { consumed: i, skip: 0, desync: true }

      if (o.marker) {
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

  private emit(o: FetchObjectInfo, at: Mono): void {
    const headerBytes = o.headerBytes + this.pendingHeaderBytes
    this.pendingHeaderBytes = 0
    const key = this.key
    if (key === null) return
    const sample: ObjectSample = {
      key,
      groupId: o.groupId,
      objectId: o.objectId,
      headerBytes,
      payloadBytes: o.payloadLength,
      at,
    }
    this.sink.onObject(sample)
  }
}
