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
  type DeliveryPath,
  type Direction,
  type DraftAdapter,
  type FetchHeaderInfo,
  type MarkSample,
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
import { readGaps } from './gaps.js'
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
    const mg = groupFrom(prev, g.value)
    if (mg === NEED) return NEED
    groupId = mg
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
      markerFlags: flags,
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
    const og = groupFrom(prev, g.value)
    if (og === NEED) return NEED
    groupId = og
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

  let propsStart = -1
  if (propsPresent) {
    const propsLen = v.read(b, p)
    if (propsLen === NEED) return NEED
    p = propsLen.next
    const n = Number(propsLen.value)
    if (!Number.isSafeInteger(n) || n < 0 || n > slack) return DESYNC
    if (p + n > b.length) return NEED
    if (n > 0) propsStart = p
    p += n
  }
  const propsEnd = propsStart >= 0 ? p : -1

  const len = v.read(b, p)
  if (len === NEED) return NEED
  p = len.next
  const payloadLength = Number(len.value)
  if (!Number.isSafeInteger(payloadLength) || payloadLength < 0) return DESYNC

  if (!datagramMode) prev.prevSubgroupId = subgroupId
  prev.prevPriority = priority
  prev.hadSubgroup = !datagramMode
  const info: ObjectHeaderInfo = {
    objectId,
    groupId,
    payloadLength,
    headerBytes: p - i,
    next: p + payloadLength,
  }
  return propsStart < 0 ? info : { ...info, propsStart, propsEnd }
}

/** A Group ID Delta against the prior object, in the stream's group order. */
function groupFrom(prev: ObjectCursor, delta: bigint): bigint | Need {
  if (prev.first) return delta
  if (prev.descending === null) {
    prev.orderMissing = true
    return NEED
  }
  return prev.descending ? prev.prevGroupId - delta - 1n : prev.prevGroupId + delta + 1n
}

/** Group ID Deltas follow the group order from this draft. */
export const FETCH_ORDER_FROM = 18

/** Bytes a fetch stream may hold while its group order is not yet known. */
export const FETCH_HOLD_BYTES = 64 * 1024

/**
 * O(1) memory per stream, but for one case: from draft-18 a fetch stream's
 * Group ID Deltas count in the stream's group order, which comes from the
 * control plane. Until the request it names settles the order, the stream's
 * chunks are held, up to {@link FETCH_HOLD_BYTES}, and walked once it does.
 * A stream that ends, or outgrows the hold, first is walked as far as it
 * reads without the order, and abandoned at the first delta that needs it.
 *
 * Its {@link ObjectHeaderFields} are the last object's, which is what a fetch
 * object's "prior" fields refer to.
 */
export class FetchCounter extends DataStreamCounter implements ObjectHeaderFields {
  private header: FetchHeaderInfo | null = null
  private key: BucketKey | null = null
  private capped = false
  private pendingHeaderBytes = 0
  private path: DeliveryPath | null = null
  private readonly streamId: number
  private readonly cursor: ObjectCursor = newCursor()
  private readonly v: VarintReader
  private readonly draft: DraftAdapter['draft']
  /** Set for a draft before {@link FETCH_HAND_WALK_FROM}: its adapter walks the stream. */
  private readonly older: DraftAdapter | null
  /** Chunks held while the group order is unknown; `null` once it is known or not needed. */
  private held: { chunk: Uint8Array; at: Mono }[] | null
  private heldBytes = 0

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
    this.draft = a.draft
    this.older = a.draft < FETCH_HAND_WALK_FROM ? a : null
    this.held = a.draft >= FETCH_ORDER_FROM ? [] : null
  }

  get bucketKey(): BucketKey | null {
    return this.key
  }

  /** The stream is waiting for its group order. */
  get holding(): boolean {
    return this.held !== null
  }

  get priority(): number {
    return this.cursor.prevPriority
  }

  get subgroupId(): bigint | null {
    return this.cursor.hadSubgroup ? this.cursor.prevSubgroupId : null
  }

  override push(chunk: Uint8Array, at: Mono): void {
    const held = this.held
    if (held === null) {
      super.push(chunk, at)
      return
    }
    if (chunk.length === 0) return
    held.push({ chunk: chunk.slice(), at })
    this.heldBytes += chunk.length
    this.retry()
    if (this.held !== null && this.heldBytes > FETCH_HOLD_BYTES) this.release(null)
  }

  /** Walk the held chunks if the control plane has since settled the group order. */
  retry(): void {
    const held = this.held
    if (held === null || held.length === 0) return
    const id = this.requestId(held)
    if (id === undefined) return
    const descending = this.keys.descending(this.dir, id)
    if (descending !== null) this.release(descending)
  }

  override end(): void {
    if (this.held !== null) {
      this.retry()
      if (this.held !== null) this.release(null)
    }
    super.end()
  }

  /** Walk what is held in the order given, or as far as it reads without one. */
  private release(descending: boolean | null): void {
    const held = this.held ?? []
    this.cursor.descending = descending
    this.held = null
    this.heldBytes = 0
    for (const h of held) super.push(h.chunk, h.at)
  }

  /** The Request ID the held bytes open with, once their header is whole. */
  private requestId(held: readonly { chunk: Uint8Array }[]): bigint | undefined {
    let bytes = held[0]!.chunk
    if (held.length > 1) {
      const n = Math.min(this.heldBytes, this.slack)
      bytes = new Uint8Array(n)
      let at = 0
      for (const h of held) {
        if (at >= n) break
        const part = h.chunk.subarray(0, n - at)
        bytes.set(part, at)
        at += part.length
      }
    }
    const h =
      this.older === null ? readFetchHeader(this.v, bytes, 0) : this.older.readFetchHeader(bytes, 0)
    return h === NEED || h === DESYNC ? undefined : h.requestId
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
        this.path = this.keys.fetchPath(this.dir, h.requestId)
        if (this.key === null && !this.capped) {
          this.capped = true
          this.sink.onParseFailure(null, 'bucket-cap')
        }
        i = h.next
        continue
      }

      const priorFirst = this.cursor.first
      const priorGroup = this.cursor.prevGroupId
      const priorObject = this.cursor.prevObjectId
      const o =
        this.older === null
          ? readFetchObject(this.v, b, i, this.cursor, this.slack)
          : this.older.readFetchObject(b, i, this.cursor)
      if (o === NEED) {
        if (this.cursor.orderMissing) return { consumed: i, skip: 0, desync: true }
        break
      }
      if (o === DESYNC) return { consumed: i, skip: 0, desync: true }

      if (o.marker === true) {
        // A marker is not an object. Its bytes ride along on the next real one
        // so the track's byte total still balances against the wire.
        this.pendingHeaderBytes += o.headerBytes
        const from = priorFirst ? o : { groupId: priorGroup, objectId: priorObject }
        this.mark(o, at, { range: o.markerFlags ?? 0, g2: o.groupId, o2: o.objectId }, from)
      } else {
        this.emit(o, at)
        if (o.propsStart !== undefined) this.gaps(b, o, at)
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
    const reason = this.cursor.orderMissing ? 'fetch-order-unknown' : 'fetch-desync'
    this.sink.onParseFailure(this.key, reason)
  }

  protected override payloadArrived(at: Mono): void {
    if (this.key !== null) this.sink.onPayload?.(this.streamId, at)
  }

  private emit(o: ObjectHeaderInfo, at: Mono): void {
    const headerBytes = o.headerBytes + this.pendingHeaderBytes
    this.pendingHeaderBytes = 0
    const key = this.key
    if (key === null) return
    const s: ObjectSample = {
      key,
      groupId: o.groupId,
      objectId: o.objectId,
      headerBytes,
      payloadBytes: o.payloadLength,
      at,
      path: this.path,
      sub: this.cursor.hadSubgroup ? this.cursor.prevSubgroupId : null,
      fo: false,
      foKnown: false,
      eog: false,
    }
    // Only drafts 07-15 put an Object Status on a fetch object, and 0x0 is Normal.
    if (o.status !== undefined && o.status !== 0n) (s as { status?: bigint }).status = o.status
    this.sink.onObject(withStream(s, this.streamId))
  }

  private mark(
    o: ObjectHeaderInfo,
    at: Mono,
    what: MarkSample['what'],
    from: { readonly groupId: bigint; readonly objectId: bigint } = o,
  ): void {
    if (this.key === null || this.path === null || this.sink.onMark === undefined) return
    this.sink.onMark({
      key: this.key,
      what,
      groupId: from.groupId,
      objectId: from.objectId,
      path: this.path,
      ...(this.streamId >= 0 ? { streamId: this.streamId } : {}),
      at,
    })
  }

  private gaps(b: Uint8Array, o: ObjectHeaderInfo, at: Mono): void {
    if (this.sink.onMark === undefined) return
    const g = readGaps(this.v, b, o.propsStart as number, o.propsEnd as number, this.draft)
    if (g === null) return
    if (g.group !== undefined) this.mark(o, at, { gap: 'group', n: g.group })
    if (g.object !== undefined) this.mark(o, at, { gap: 'object', n: g.object })
  }
}
