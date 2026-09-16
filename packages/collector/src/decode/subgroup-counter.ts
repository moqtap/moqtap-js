/**
 * The counting decoder for SUBGROUP_HEADER streams.
 *
 * The header walk is hand-rolled. Two reasons, both checked in
 * `packages/codec@0.10.0` rather than inherited:
 *
 *  - **No exported codec function reports a header's byte length without
 *    materialising the payload.** `decodeSubgroupStream` returns every object
 *    with a `payload` view and needs the whole stream in one buffer, which is
 *    the opposite of "parse a header, update counters, discard".
 *  - **A `@moqtap/codec` below 0.11.0 decodes these streams wrongly, and that
 *    is still not why this walk exists.** In 0.10.0 and earlier
 *    `createSubgroupStreamDecoder` reads Object Payload Length and then the
 *    payload with no `payloadLength === 0 -> readVarInt status` branch, so one
 *    status object desynchronises the stream and everything after it is
 *    garbage -- silently, because a varint read at the wrong offset yields a
 *    plausible number rather than an error, and `createDataStreamDecoder`
 *    selects an inner decoder and never feeds it. From 0.11.0 a cross-draft
 *    test holds the streaming and one-shot decoders to returning the same
 *    thing for the same bytes.
 *
 *    **The first reason above is the load-bearing one.** Measured in Chrome on
 *    real capture shapes, this walk costs
 *    170-240 ns per object at the median where the codec's streaming decoder
 *    costs 11.5-14.4 us fed in 16 KB chunks -- some sixty times more, most of
 *    it the buffer it regrows and recopies on every chunk. Parse-and-discard is
 *    a different job from decode-and-materialise.
 *
 * The walk below is draft-19 and draft-20's shared shape. They differ in one
 * place that does not reach a byte count: draft-19 reads the Type Flags with
 * `readUint8` and draft-20 with `readVarInt`. Every
 * legal SUBGROUP_HEADER Type Flags value is below 0x80, and MoQT's vi64 encodes
 * 0-127 in one byte whose leading bit is clear, so reading it as a varint is
 * byte-identical for draft-19 and additionally accepts draft-20's legal
 * non-minimal forms.

 */

import {
  type BucketKey,
  type CountingSink,
  type Direction,
  type Mono,
  NEED,
  type Need,
  type ObjectCursor,
  type ObjectHeaderInfo,
  type ObjectSample,
  type SubgroupHeaderInfo,
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

/**
 * Walk a SUBGROUP_HEADER, draft-20 Section 11.4.2.
 *
 * `[Type Flags][Track Alias][Group ID][Subgroup ID?][Publisher Priority?]`
 */
export function readSubgroupHeader(
  v: VarintReader,
  b: Uint8Array,
  i: number,
): SubgroupHeaderInfo | Need | Desync {
  const t = v.read(b, i)
  if (t === NEED) return NEED
  // Section 11.4.2's three invalid conditions, in the codec's own order. Bit 4
  // is REQUIRED here and FORBIDDEN on a datagram; conflating the two rule sets
  // is an easy mistake, so this restates them rather than deriving them.
  if (t.value >= 128n) return DESYNC
  const flags = Number(t.value)
  if ((flags & 0x10) === 0) return DESYNC
  if ((flags & 0x06) === 0x06) return DESYNC

  let p = t.next
  const alias = v.read(b, p)
  if (alias === NEED) return NEED
  p = alias.next
  const group = v.read(b, p)
  if (group === NEED) return NEED
  p = group.next

  // SUBGROUP_ID_MODE 0b10 is the only mode with a field on the wire; 0b00 means
  // the id is zero and 0b01 means it is the first object's id, and neither
  // costs a byte here.
  if ((flags & 0x06) >> 1 === 0x02) {
    const subgroup = v.read(b, p)
    if (subgroup === NEED) return NEED
    p = subgroup.next
  }
  // DEFAULT_PRIORITY (0x20) SET means the field is absent — the sense is
  // inverted relative to every other flag in the byte.
  if ((flags & 0x20) === 0) {
    if (p + 1 > b.length) return NEED
    p += 1
  }

  return {
    trackAlias: alias.value,
    groupId: group.value,
    propertiesPresent: (flags & 0x01) !== 0,
    headerBytes: p - i,
    next: p,
  }
}

/**
 * Walk one object on a subgroup stream, draft-20 Section 11.4.2.
 *
 * `[Object ID Delta][Properties Length + Properties?][Payload Length]` and then
 * either `[Object Status]` when the length is zero or the payload itself.
 *
 * `next` is deliberately allowed to point **past `b.length`**: the payload is
 * skipped by arithmetic, never read, so the caller turns the overshoot into a
 * byte counter. That is the whole of this module's O(1) claim.
 */
export function readSubgroupObject(
  v: VarintReader,
  b: Uint8Array,
  i: number,
  st: SubgroupHeaderInfo,
  prev: ObjectCursor,
  slack: number,
): ObjectHeaderInfo | Need | Desync {
  const delta = v.read(b, i)
  if (delta === NEED) return NEED
  let p = delta.next
  // Section 11.4.2: the first object's delta IS its Object ID; after that the
  // id is the prior object's id plus the delta plus one.
  const objectId = prev.first ? delta.value : prev.prevObjectId + 1n + delta.value

  if (st.propertiesPresent) {
    const propsLen = v.read(b, p)
    if (propsLen === NEED) return NEED
    p = propsLen.next
    const n = Number(propsLen.value)
    // An over-large declared length is desync, never a buffer: The "stop
    // rather than degrade" applied to memory. Properties must be *skipped over*
    // to reach the Payload Length, so unlike a payload they cannot be turned
    // into a counter, which is exactly why they need a ceiling.
    if (!Number.isSafeInteger(n) || n < 0 || n > slack) return DESYNC
    if (p + n > b.length) return NEED
    p += n
  }

  const len = v.read(b, p)
  if (len === NEED) return NEED
  p = len.next
  const payloadLength = Number(len.value)
  if (!Number.isSafeInteger(payloadLength) || payloadLength < 0) return DESYNC

  // THE BRANCH `createSubgroupStreamDecoder` OMITS. A zero Payload Length means
  // an Object Status varint occupies the position a payload would have; reading
  // on without it puts every later object one varint out of phase.
  if (payloadLength === 0) {
    const status = v.read(b, p)
    if (status === NEED) return NEED
    p = status.next
    return {
      objectId,
      groupId: st.groupId,
      payloadLength: 0,
      status: status.value,
      headerBytes: p - i,
      next: p,
    }
  }

  return {
    objectId,
    groupId: st.groupId,
    payloadLength,
    headerBytes: p - i,
    next: p + payloadLength,
  }
}

export interface CounterOptions {
  /** Header bytes carried across a chunk boundary before declaring desync. */
  readonly slackBytes?: number
}

/**
 * O(1) memory per stream. Payload bytes are skipped, never viewed, never
 * retained.
 *
 * One instance per subgroup stream. The stream header's own bytes are folded
 * into the first object's `headerBytes` so no byte on the stream goes
 * unattributed; a subgroup stream that carries no objects at all therefore
 * reports nothing, which is correct — it has no bucket to report against.
 */
export class SubgroupCounter extends DataStreamCounter {
  private header: SubgroupHeaderInfo | null = null
  private key: BucketKey | null = null
  private capped = false
  private pendingHeaderBytes = 0
  private readonly cursor: ObjectCursor = { first: true, prevObjectId: 0n, prevGroupId: 0n }

  constructor(
    private readonly dir: Direction,
    private readonly keys: TrackKeyResolver,
    private readonly sink: CountingSink,
    private readonly v: VarintReader,
    opts?: CounterOptions,
  ) {
    super(opts?.slackBytes ?? DEFAULT_HEADER_SLACK_BYTES)
  }

  /** The bucket this stream's objects are counted into, once resolved. */
  get bucketKey(): BucketKey | null {
    return this.key
  }

  protected override parse(b: Uint8Array, at: Mono): ParseRun {
    let i = 0
    while (i < b.length) {
      if (this.header === null) {
        const h = readSubgroupHeader(this.v, b, i)
        if (h === NEED) break
        if (h === DESYNC) return { consumed: i, skip: 0, desync: true }
        this.header = h
        this.pendingHeaderBytes = h.headerBytes
        // The bucket key is the raw wire number, tagged with the seam's
        // direction and the control plane's alias epoch. No name is read, here
        // or anywhere else on the device.
        this.key = this.keys.aliasKey(this.dir, h.trackAlias)
        if (this.key === null && !this.capped) {
          this.capped = true
          this.sink.onParseFailure(null, 'bucket-cap')
        }
        i = h.next
        continue
      }

      const o = readSubgroupObject(this.v, b, i, this.header, this.cursor, this.slack)
      if (o === NEED) break
      if (o === DESYNC) return { consumed: i, skip: 0, desync: true }

      this.emit(o, at)
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
    this.sink.onParseFailure(this.key, 'subgroup-desync')
  }

  private emit(o: ObjectHeaderInfo, at: Mono): void {
    const headerBytes = o.headerBytes + this.pendingHeaderBytes
    this.pendingHeaderBytes = 0
    const key = this.key
    if (key === null) return
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
    this.sink.onObject(sample)
  }
}
