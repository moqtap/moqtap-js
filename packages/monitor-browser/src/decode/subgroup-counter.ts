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
 *
 * The same walk is right for every draft from 14 (see {@link HAND_WALK_FROM});
 * an older draft's stream is walked by its adapter instead, whose dialect
 * covers the older type ranges and absolute Object IDs. The adapter's walk is
 * the slower of the two by a call and a dialect lookup per field, which is why
 * the newer drafts keep this one.
 */

import {
  type BucketKey,
  type CountingSink,
  type Direction,
  type DraftAdapter,
  type Mono,
  NEED,
  type Need,
  newCursor,
  type ObjectCursor,
  type ObjectHeaderFields,
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
  const mode = (flags & 0x06) >> 1
  let subgroupId = 0n
  if (mode === 0x02) {
    const subgroup = v.read(b, p)
    if (subgroup === NEED) return NEED
    subgroupId = subgroup.value
    p = subgroup.next
  }
  // DEFAULT_PRIORITY (0x20) SET means the field is absent — the sense is
  // inverted relative to every other flag in the byte.
  let priority = -1
  if ((flags & 0x20) === 0) {
    const byte = b[p]
    if (byte === undefined) return NEED
    priority = byte
    p += 1
  }

  return {
    trackAlias: alias.value,
    groupId: group.value,
    propertiesPresent: (flags & 0x01) !== 0,
    subgroupId,
    subgroupIsFirstObjectId: mode === 0x01,
    priority,
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

/**
 * The first draft whose subgroup streams this file's walk reads correctly.
 * Drafts 07-11 use other type values and 12-13 absolute Object IDs, so their
 * streams go through the adapter's walk.
 */
export const HAND_WALK_FROM = 14

export interface CounterOptions {
  /** Header bytes carried across a chunk boundary before declaring desync. */
  readonly slackBytes?: number
  /** The stream's id, carried on every sample so a per-object record can name it. */
  readonly streamId?: number
}

/**
 * O(1) memory per stream. Payload bytes are skipped, never viewed, never
 * retained.
 *
 * One instance per subgroup stream. The stream header's own bytes are folded
 * into the first object's `headerBytes` so no byte on the stream goes
 * unattributed; a subgroup stream that carries no objects at all therefore
 * reports nothing, which is correct — it has no bucket to report against.
 *
 * Its {@link ObjectHeaderFields} are the stream header's: every object on a
 * subgroup stream shares one priority and one subgroup.
 */
export class SubgroupCounter extends DataStreamCounter implements ObjectHeaderFields {
  private header: SubgroupHeaderInfo | null = null
  private key: BucketKey | null = null
  private capped = false
  private pendingHeaderBytes = 0
  private subgroup = 0n
  private readonly cursor: ObjectCursor = newCursor()
  private readonly streamId: number
  private readonly v: VarintReader
  /** Set for a draft before {@link HAND_WALK_FROM}: its adapter walks the stream. */
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
    this.older = a.draft < HAND_WALK_FROM ? a : null
  }

  /** The bucket this stream's objects are counted into, once resolved. */
  get bucketKey(): BucketKey | null {
    return this.key
  }

  get priority(): number {
    return this.header === null ? -1 : this.header.priority
  }

  get subgroupId(): bigint | null {
    return this.header === null ? null : this.subgroup
  }

  protected override parse(b: Uint8Array, at: Mono): ParseRun {
    let i = 0
    while (i < b.length) {
      if (this.header === null) {
        const h =
          this.older === null
            ? readSubgroupHeader(this.v, b, i)
            : this.older.readSubgroupHeader(b, i)
        if (h === NEED) break
        if (h === DESYNC) return { consumed: i, skip: 0, desync: true }
        this.header = h
        this.subgroup = h.subgroupId
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

      // Read before the walk: the adapter's moves the cursor itself.
      const first = this.cursor.first
      const o =
        this.older === null
          ? readSubgroupObject(this.v, b, i, this.header, this.cursor, this.slack)
          : this.older.readSubgroupObject(b, i, this.header, this.cursor)
      if (o === NEED) break
      if (o === DESYNC) return { consumed: i, skip: 0, desync: true }

      if (first && this.header.subgroupIsFirstObjectId) this.subgroup = o.objectId
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
    this.sink.onObject(
      withStream(
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
            },
        this.streamId,
      ),
    )
  }
}

/**
 * `s` with its stream id, when the counter was given one. Assigned rather than
 * spread: this runs once per object.
 */
export function withStream(s: ObjectSample, streamId: number): ObjectSample {
  if (streamId >= 0) (s as { streamId?: number }).streamId = streamId
  return s
}
