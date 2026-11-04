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
 * {@link FETCH_HAND_WALK_FROM}), with draft-23's indicators and ID rules from
 * {@link FETCH_INDICATORS_FROM}. Every draft before 18 differs somewhere a
 * value depends on: absolute Group IDs (15-17), absolute Object IDs (15-17),
 * an Object Status (15), no Serialization Flags at all (07-14). Those drafts,
 * and 18-19, are walked by their adapter instead.
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

/** The first draft with End of Group, End of Track and End of Gone Range. */
export const FETCH_INDICATORS_FROM = 23

const END_OF_GROUP = 0x80
const END_OF_TRACK = 0x81

/** draft-23 Table 8's End of Range values. */
const END_OF_RANGE: ReadonlySet<number> = new Set([0x8c, 0x10c, 0x20c, 0x40c])

/** The largest Group or Object ID. */
const MAX_U64 = 0xffff_ffff_ffff_ffffn

/**
 * Walk one record on a fetch stream, draft-20 Section 11.4.4.
 *
 * `marker` marks an indicator, not an Object: an End-of-Range marker (draft-20
 * Section 11.4.4.2, draft-23 Section 11.4.2), a statement that a range of
 * Objects does not exist, is unknown, timed out or is gone; or, from draft-23,
 * End of Group or End of Track (draft-23 Section 11.4.2.2). Counting one as an
 * object would inflate every object rate on the track; see {@link FetchCounter}
 * for its bytes.
 *
 * The cursor's Subgroup ID and priority move only on a complete object, and
 * never on a marker, which has neither.
 *
 * `indicators` reads draft-23's rules: its Table 8 indicators and the Object
 * ID Delta `+ 2`.
 */
export function readFetchObject(
  v: VarintReader,
  b: Uint8Array,
  i: number,
  prev: ObjectCursor,
  slack: number,
  indicators = false,
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
    // End-of-Range marker. draft-20 Section 11.4.4.2: Group ID, Object ID
    // and a Payload Length encoded as 0, and no Subgroup ID or Priority of its
    // own. Draft-19 has two such markers and draft-20 three (0x8C, 0x10C and
    // draft-20's new 0x20C); through draft-22 the walk accepts any value at or
    // above 0x80 because the *layout* is what it needs and a counting decoder
    // that enforced the enumeration would abandon a stream over a codepoint a
    // later draft adds — the failure mode a withheld adapter exists to avoid.
    if (indicators) {
      // draft-23 Section 11.4.2.2: "When Serialization Flags is 0x80 (End of
      // Group) or 0x81 (End of Track), no other fields are present. The prior
      // Object is the last Object in its Group, or in the Track, respectively.
      // End of Track also indicates End of Group. The prior Object ID becomes
      // 2^64-1." Reported as the cursor it leaves. As the first entry it names
      // a prior Object that does not exist.
      if (flags === END_OF_GROUP || flags === END_OF_TRACK) {
        if (prev.first) return DESYNC
        return {
          objectId: MAX_U64,
          groupId,
          payloadLength: 0,
          headerBytes: p - i,
          next: p,
          marker: true,
          markerFlags: flags,
        }
      }
      // draft-23 Section 11.4.1: "If an endpoint receives any other value
      // greater than 127, it MUST close the session with MALFORMED_OBJECT."
      if (!END_OF_RANGE.has(flags)) return DESYNC
    }
    const g = v.read(b, p)
    if (g === NEED) return NEED
    p = g.next
    const o = v.read(b, p)
    if (o === NEED) return NEED
    p = o.next
    objectId = o.value
    if (!indicators) {
      // draft-20 Section 11.4.4.2: "the Group ID and Object ID fields are
      // present". Absolute through draft-22: the delta rules of
      // draft-20 Section 11.4.4.1 cover only Objects.
      groupId = g.value
    } else if (prev.first) {
      groupId = g.value
    } else if (g.value === 0n) {
      // draft-23 Section 11.4.2.1: "If this End of Range indicator is the
      // first entry after the FETCH_HEADER, both fields encode absolute IDs.
      // [...] For subsequent indicators, the Group ID is the prior Group ID
      // plus Group ID Delta for Ascending Group Order, or minus Group ID Delta
      // for Descending Group Order. If Group ID Delta is zero, the Object ID is
      // the prior Object ID plus Object ID Delta + 1. When Group ID Delta is
      // nonzero, the Object ID Delta field contains the absolute Object ID in
      // the new Group."
      // Ambiguous straight after End of Group or End of Track: Section
      // 11.4.2.1 takes the prior IDs from "the most recent preceding Object or
      // End of Range indicator", while Section 11.4.2.2 says "The prior Object
      // ID becomes 2^64-1". The second is read, as the codec does, so a zero
      // Group ID Delta there overflows.
      objectId = prev.prevObjectId + o.value + 1n
    } else if (prev.descending === null) {
      if (!prev.unseen) {
        prev.orderMissing = true
        return NEED
      }
      prev.ungrouped = true
    } else {
      groupId = prev.descending ? groupId - g.value : groupId + g.value
    }
    // draft-23 Section 11.4.2.1: "If either decoded ID is less than zero or
    // greater than 2^64-1, the Subscriber MUST close the Session with
    // DELTA_ENCODING_OVERFLOW."
    if (groupId < 0n || groupId > MAX_U64 || objectId > MAX_U64) return DESYNC
    // The Object Payload Length stays: draft-23 Figure 29 makes it mandatory
    // and Section 11.4.2 does not list it among the absent fields.
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
    if (og < 0n || og > MAX_U64) return DESYNC
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
    // draft-23 Section 11.4.1.1: "When the Group ID Delta field is not
    // present, the Object ID is the prior Object's ID plus the Object ID Delta
    // + 2 if present." Drafts 20-22 add the delta alone.
    objectId = groupIdPresent ? o.value : prev.prevObjectId + o.value + (indicators ? 2n : 0n)
  } else if (prev.first) {
    return DESYNC
  }
  // Past 2^64-1, e.g. an implicit `prior + 1` right after End of Group:
  // DELTA_ENCODING_OVERFLOW from draft-23, PROTOCOL_VIOLATION before.
  if (objectId > MAX_U64) return DESYNC

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
    if (prev.unseen) {
      prev.ungrouped = true
      return prev.prevGroupId
    }
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
  private path: DeliveryPath = 'fetch_unseen'
  private readonly streamId: number
  private readonly cursor: ObjectCursor = newCursor()
  private readonly v: VarintReader
  private readonly draft: DraftAdapter['draft']
  /** Set for a draft before {@link FETCH_HAND_WALK_FROM}: its adapter walks the stream. */
  private readonly older: DraftAdapter | null
  /** Draft-23's indicators and ID rules: {@link FETCH_INDICATORS_FROM}. */
  private readonly indicators: boolean
  /** The last entry walked was an Object, not an indicator. */
  private afterObject = false
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
    this.indicators = a.draft >= FETCH_INDICATORS_FROM
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
        const path = this.keys.fetchPath(this.dir, h.requestId)
        if (path !== null) this.path = path
        else this.cursor.unseen = this.draft >= FETCH_ORDER_FROM
        if (this.key === null && !this.capped) {
          this.capped = true
          this.sink.onParseFailure(null, 'bucket-cap')
        }
        if (this.key !== null && this.streamId >= 0) {
          this.sink.onStreamHeader?.({
            key: this.key,
            streamId: this.streamId,
            path: this.path,
            groupId: null,
            eog: false,
            at,
          })
        }
        i = h.next
        continue
      }

      const priorFirst = this.cursor.first
      const priorGroup = this.cursor.prevGroupId
      const priorObject = this.cursor.prevObjectId
      const o =
        this.older === null
          ? readFetchObject(this.v, b, i, this.cursor, this.slack, this.indicators)
          : this.older.readFetchObject(b, i, this.cursor)
      if (o === NEED) {
        if (this.cursor.orderMissing) return { consumed: i, skip: 0, desync: true }
        break
      }
      if (o === DESYNC) return { consumed: i, skip: 0, desync: true }

      const flags = o.markerFlags ?? 0
      if (this.cursor.ungrouped) {
        // Past an unresolved Group ID Delta nothing can be placed.
        this.pendingHeaderBytes = 0
        if (o.marker !== true && this.key !== null) this.sink.onUngrouped?.()
      } else if (o.marker === true) {
        // A marker is not an object. Its bytes ride along on the next real one;
        // with none after it they go uncounted, as does the End of Group that
        // draft-23 puts after the last Object.
        this.pendingHeaderBytes += o.headerBytes
        const prior = { groupId: priorGroup, objectId: priorObject }
        if (this.indicators && (flags === END_OF_GROUP || flags === END_OF_TRACK)) {
          // Only straight after an Object: after an End of Range the draft
          // does not say which Object ends the group.
          if (this.afterObject) {
            this.mark(o, at, { end: flags === END_OF_TRACK ? 'track' : 'group' }, prior)
          }
        } else {
          const from = priorFirst ? o : prior
          this.mark(o, at, { range: flags, g2: o.groupId, o2: o.objectId, first: priorFirst }, from)
        }
      } else {
        this.emit(o, at)
        if (o.propsStart !== undefined) this.gaps(b, o, at)
      }
      this.afterObject = o.marker !== true
      // draft-20 Section 11.4.4.2: "Prior Group ID and prior Object ID: The
      // values from the End of Range indicator", so the cursor advances for
      // markers too. draft-23 Section 11.4.2.2, after End of Group or End of
      // Track: "The prior Object ID becomes 2^64-1."
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
    if (this.key === null || this.sink.onMark === undefined) return
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
