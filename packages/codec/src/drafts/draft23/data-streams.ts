import { MoqtBufferReader as BufferReader } from '../../core/buffer-reader.js'
import { MoqtBufferWriter as BufferWriter } from '../../core/buffer-writer.js'
import { FetchGapOrder } from '../../core/fetch-gaps.js'
import { type FetchGroupOrder, isDescending } from '../../core/group-order.js'
import type {
  ObjectProperty,
  ObjectPropertyInit,
  ObjectPropertyRules,
} from '../../core/object-properties.js'
import { readObjectProperties, writeObjectProperties } from '../../core/object-properties.js'
import type { DecodeResult } from '../../core/types.js'
import { DecodeError } from '../../core/types.js'
import { SessionTerminationCode as Close } from './error-codes.js'
import { isGrease } from './messages.js'
import type {
  DatagramObject,
  DataStreamEvent,
  Draft23DataStream,
  Draft23TrackProperties,
  FetchObjectPayload,
  FetchStream,
  FetchStreamHeader,
  ObjectPayload,
  SubgroupStream,
  SubgroupStreamHeader,
} from './types.js'

const FETCH_STREAM_TYPE = 0x05n

/** A data-plane failure carrying the draft-23 session termination code it calls for. */
function fail(close: bigint, message: string, offset: number): DecodeError {
  return new DecodeError('CONSTRAINT_VIOLATION', message, offset, close)
}

// ─── Fetch stream Serialization Flags indicators (draft-23 Section 11.4.1, Table 8) ─

/** End of Non-Existent Range. */
const FETCH_END_OF_NON_EXISTENT_RANGE = 0x8c
/** End of Unknown Range. */
const FETCH_END_OF_UNKNOWN_RANGE = 0x10c
/** End of Timed-Out Range. */
const FETCH_END_OF_TIMED_OUT_RANGE = 0x20c
/** End of Gone Range. */
const FETCH_END_OF_GONE_RANGE = 0x40c
/** End of Group. */
const FETCH_END_OF_GROUP = 0x80
/** End of Track, which "also indicates End of Group" (Section 11.4.2.2). */
const FETCH_END_OF_TRACK = 0x81

/**
 * draft-23 Section 11.4.2: "When the Serialization Flags field indicates an
 * End of Range (0x8C, 0x10C, 0x20C, or 0x40C), the Group ID Delta and Object ID
 * Delta fields are always present. Subgroup ID, Priority and Properties are not
 * present."
 */
const FETCH_END_OF_RANGE: ReadonlySet<number> = new Set([
  FETCH_END_OF_NON_EXISTENT_RANGE,
  FETCH_END_OF_UNKNOWN_RANGE,
  FETCH_END_OF_TIMED_OUT_RANGE,
  FETCH_END_OF_GONE_RANGE,
])

/** End of Group or End of Track, which carry no fields at all. */
function isEndMarker(flags: number): boolean {
  return flags === FETCH_END_OF_GROUP || flags === FETCH_END_OF_TRACK
}

// ─── Object Properties ───────────────────────────────────────────────────────

/**
 * Draft-23's property block: each Type a delta from the one before it, an odd
 * type's value at most 2^16-1 bytes (Section 8.3), Immutable Properties at 0xB
 * (Section 10.7).
 */
const PROPERTY_RULES: ObjectPropertyRules = {
  deltaTypes: true,
  maxValueLength: 0xffff,
  immutableType: 0x0bn,
}

/** Decode an Object's `extensionData` in wire order; odd-typed values are views into `bytes`. */
export function decodeObjectProperties(bytes: Uint8Array): DecodeResult<ObjectProperty[]> {
  try {
    const r = new BufferReader(bytes)
    const value = readObjectProperties(r, bytes.byteLength, PROPERTY_RULES)
    return { ok: true, value, bytesRead: r.offset }
  } catch (e) {
    if (e instanceof DecodeError) return { ok: false, error: e }
    throw e
  }
}

/** Encode properties into a block to carry as an Object's `extensionData`. */
export function encodeObjectProperties(props: readonly ObjectPropertyInit[]): Uint8Array {
  const w = new BufferWriter(32)
  writeObjectProperties(w, props, PROPERTY_RULES, () => new BufferWriter(32))
  return w.finish()
}

// ─── Malformed Tracks from Object Properties (draft-23 Section 8.4, Section 10, Section 12.1) ─

/** Track-only Properties, draft-23 Section 16.8, Table 15. */
const TRACK_ONLY_PROPERTIES: ReadonlySet<bigint> = new Set([0x04n, 0x0en, 0x22n, 0x30n])
/** The Properties draft-23 defines, Table 15. None allows multiple instances. */
const TRANSPORT_PROPERTIES: ReadonlySet<bigint> = new Set([
  0x02n,
  0x04n,
  0x06n,
  0x0bn,
  0x0en,
  0x22n,
  0x30n,
  0x3cn,
  0x3en,
])
/** Object-only Properties, draft-23 Section 16.8, Table 15. */
const OBJECT_ONLY_PROPERTIES: ReadonlySet<bigint> = new Set([0x3cn, 0x3en])
const PROPERTY_IMMUTABLE = 0x0bn
const PROPERTY_PRIOR_GROUP_ID_GAP = 0x3cn
const PROPERTY_PRIOR_OBJECT_ID_GAP = 0x3en

/**
 * draft-23 Section 3.7: "Property types in the range 0x4000-0x7FFF are
 * designated as Mandatory Track Properties. These properties MUST have Track
 * scope. ... Grease values (Section 13) in this range are not Mandatory Track
 * Properties."
 */
function isMandatoryTrackProperty(type: bigint): boolean {
  return type >= 0x4000n && type <= 0x7fffn && !isGrease(type)
}

/**
 * Why an Object's Properties make its Track malformed (draft-23 Section 12.1),
 * or null. Only what the Object shows by itself, with `groupGap` the Prior
 * Group ID Gap an earlier Object of the same Group carried:
 *
 *  - Section 10.7: "A Key-Value-Pair cannot be parsed." and "An Object
 *    contains an Immutable Properties property that contains another Immutable
 *    Properties key."
 *  - Section 8.4: "An endpoint that supports a Property and receives it outside
 *    its scope (e.g. a Track-only Property as an Object Property) MUST treat
 *    the Track as malformed". And "A Track or Object MUST NOT contain more
 *    than one instance of the Property. An endpoint that supports a Property
 *    and receives more instances of it than allowed MUST treat the Track as
 *    malformed". Section 10.7: "When looking for the value of a property,
 *    processors MUST search both the mutable properties and the contents of
 *    Immutable Properties", so both count.
 *  - Section 3.7: "An Object received with a Mandatory Track Property as an
 *    Object Property is malformed (see Section 12.1)."
 *  - Section 10.8: "A Group contains more than one Object with different
 *    values for Prior Group ID Gap." and "An Object has a Prior Group ID Gap
 *    larger than the Group ID."
 *  - Section 10.9: "An Object has a Prior Object ID Gap larger than the Object
 *    ID."
 *
 * The conditions that need Objects received earlier, such as a gap covering
 * an Object already received, are checked across a subgroup or fetch
 * stream's Objects by {@link malformedTrackReason}; across streams they are
 * the receiver's to check.
 */
function objectPropertiesMalformed(
  block: Uint8Array | undefined,
  groupId: bigint,
  objectId: bigint,
  groupGap: bigint | undefined,
): { reason: string } | { groupGap: bigint | undefined } {
  if (block === undefined || block.byteLength === 0) return { groupGap }
  const decoded = decodeObjectProperties(block)
  if (!decoded.ok) return { reason: `a Key-Value-Pair cannot be parsed: ${decoded.error.message}` }

  const all: ObjectProperty[] = []
  for (const p of decoded.value) {
    all.push(p)
    if (p.type !== PROPERTY_IMMUTABLE) continue
    for (const inner of p.properties ?? []) {
      if (inner.type === PROPERTY_IMMUTABLE) {
        return { reason: 'Immutable Properties contains another Immutable Properties key' }
      }
      all.push(inner)
    }
  }

  const seen = new Set<bigint>()
  for (const p of all) {
    const hex = `0x${p.type.toString(16)}`
    if (TRACK_ONLY_PROPERTIES.has(p.type)) {
      return { reason: `Track-only Property ${hex} received as an Object Property` }
    }
    if (isMandatoryTrackProperty(p.type)) {
      return { reason: `Mandatory Track Property ${hex} received as an Object Property` }
    }
    if (TRANSPORT_PROPERTIES.has(p.type)) {
      if (seen.has(p.type)) return { reason: `Property ${hex} appears more than once` }
      seen.add(p.type)
    }
  }

  const priorGroupGap = all.find((p) => p.type === PROPERTY_PRIOR_GROUP_ID_GAP)?.value
  if (priorGroupGap !== undefined) {
    if (priorGroupGap > groupId) {
      return { reason: `Prior Group ID Gap ${priorGroupGap} is larger than Group ID ${groupId}` }
    }
    if (groupGap !== undefined && groupGap !== priorGroupGap) {
      return {
        reason: `Group ${groupId} carries Prior Group ID Gap ${groupGap} and ${priorGroupGap}`,
      }
    }
  }
  const priorObjectGap = all.find((p) => p.type === PROPERTY_PRIOR_OBJECT_ID_GAP)?.value
  if (priorObjectGap !== undefined && priorObjectGap > objectId) {
    return { reason: `Prior Object ID Gap ${priorObjectGap} is larger than Object ID ${objectId}` }
  }
  return { groupGap: priorGroupGap ?? groupGap }
}

/**
 * Why the Object Properties on a decoded subgroup stream, datagram or fetch
 * stream make the Track malformed, or null when nothing here does. See
 * {@link objectPropertiesMalformed} for the conditions, and on a
 * subgroup or fetch stream also those `FetchGapOrder` checks across its
 * Objects. A malformed Track is not a decode failure: draft-23 Section 12.1,
 * "When a subscriber detects a Malformed Track, it MUST cancel any
 * corresponding subscription or fetches for that Track from that publisher".
 */
export function malformedTrackReason(stream: Draft23DataStream): string | null {
  if (stream.type === 'datagram') {
    const r = objectPropertiesMalformed(
      stream.extensionData,
      stream.groupId,
      stream.objectId,
      undefined,
    )
    return 'reason' in r ? r.reason : null
  }
  const gaps = new Map<bigint, bigint | undefined>()
  // draft-23 Section 2.2 sends a subgroup's Objects "in ascending order by
  // Object ID", so on a subgroup stream only a gap covering the Object before
  // it applies.
  const order = new FetchGapOrder({
    groupType: PROPERTY_PRIOR_GROUP_ID_GAP,
    objectType: PROPERTY_PRIOR_OBJECT_ID_GAP,
    covering: true,
    withinGap: stream.type === 'fetch',
  })
  for (const obj of stream.objects) {
    if ('serializationFlags' in obj && obj.serializationFlags >= 0x80) continue
    const groupId =
      stream.type === 'subgroup' ? stream.groupId : (obj as FetchObjectPayload).groupId
    const r = objectPropertiesMalformed(obj.extensionData, groupId, obj.objectId, gaps.get(groupId))
    if ('reason' in r) return r.reason
    gaps.set(groupId, r.groupGap)
    const decoded = decodeObjectProperties(obj.extensionData)
    const reason = order.check(groupId, obj.objectId, decoded.ok ? decoded.value : [])
    if (reason !== null) return reason
  }
  return null
}

/**
 * Why the Track Properties of a SUBSCRIBE_OK, PUBLISH or REQUEST_OK make the
 * Track malformed, or null. The decoder keeps a repeated Property after the
 * first in `unknown`, so repeats stay visible here.
 *
 *  - Section 8.4: "A Track or Object MUST NOT contain more than one instance
 *    of the Property. An endpoint that supports a Property and receives more
 *    instances of it than allowed MUST treat the Track as malformed".
 *    Section 10.7: "When looking for the value of a property, processors MUST search
 *    both the mutable properties and the contents of Immutable Properties", so
 *    both count.
 *  - Section 8.4: "An endpoint that supports a Property and receives it outside
 *    its scope ... MUST treat the Track as malformed". PRIOR_GROUP_ID_GAP and
 *    PRIOR_OBJECT_ID_GAP have Object scope (Table 15).
 *  - Section 10.7: "A Key-Value-Pair cannot be parsed."
 */
export function malformedTrackPropertiesReason(props: Draft23TrackProperties): string | null {
  const types: bigint[] = []
  if (props.object_delivery_timeout !== undefined) types.push(0x02n)
  if (props.max_cache_duration !== undefined) types.push(0x04n)
  if (props.subgroup_delivery_timeout !== undefined) types.push(0x06n)
  if (props.immutable_properties !== undefined) {
    types.push(PROPERTY_IMMUTABLE)
    const inner = decodeObjectProperties(props.immutable_properties)
    if (!inner.ok) {
      return `a Key-Value-Pair in Immutable Properties cannot be parsed: ${inner.error.message}`
    }
    for (const p of inner.value) types.push(p.type)
  }
  if (props.default_publisher_priority !== undefined) types.push(0x0en)
  if (props.default_publisher_group_order !== undefined) types.push(0x22n)
  if (props.dynamic_groups !== undefined) types.push(0x30n)
  for (const u of props.unknown ?? []) types.push(BigInt(u.id))

  const seen = new Set<bigint>()
  for (const type of types) {
    const hex = `0x${type.toString(16)}`
    if (OBJECT_ONLY_PROPERTIES.has(type)) {
      return `Object-only Property ${hex} received as a Track Property`
    }
    if (TRANSPORT_PROPERTIES.has(type)) {
      if (seen.has(type)) return `Property ${hex} appears more than once`
      seen.add(type)
    }
  }
  return null
}

// ─── Object Status (draft-23 Section 11.1.1) ────────────────────────────────

const OBJECT_STATUS_NORMAL = 0n

/** Normal (0x0), End of Group (0x3), End of Track (0x4): Section 16.9, Table 17. */
const OBJECT_STATUSES: ReadonlySet<bigint> = new Set([0x0n, 0x3n, 0x4n])

/**
 * draft-23 Section 11.1.1: "If an endpoint receives any other value, it SHOULD
 * close the session with INVALID_OBJECT_STATUS (Section 12.2)."
 * Section 11.1.2: "If an endpoint receives properties on an Object with status that is
 * not Normal, it MUST close the session with INVALID_OBJECT_STATUS."
 */
function checkObjectStatus(status: bigint, hasProperties: boolean, offset: number): void {
  if (!OBJECT_STATUSES.has(status)) {
    throw fail(
      Close.InvalidObjectStatus,
      `Object Status 0x${status.toString(16)} is not defined`,
      offset,
    )
  }
  if (hasProperties && status !== OBJECT_STATUS_NORMAL) {
    throw fail(
      Close.InvalidObjectStatus,
      `only a Normal (0x0) Object may carry Properties, got status 0x${status.toString(16)}`,
      offset,
    )
  }
}

// ─── SUBGROUP_HEADER Type Flags (draft-23 Section 11.3.1) ───────────────────
//
// | Bit | Mask | Meaning
// |  0  | 0x01 | PROPERTIES — Object Properties present on every object here
// | 1-2 | 0x06 | SUBGROUP_ID_MODE: 00 = id is 0, 01 = id is the first Object's
// |     |      | Object ID, 10 = the Subgroup ID field is present, 11 = reserved
// |  3  | 0x08 | END_OF_GROUP
// |  4  | 0x10 | MUST be 1
// |  5  | 0x20 | DEFAULT_PRIORITY — Publisher Priority field omitted
// |  6  | 0x40 | FIRST_OBJECT

/**
 * Returns null when valid, or the reason it is not. Section 11.3.1: "The
 * following Type Flags values are invalid. If an endpoint receives a stream
 * header with any of these values, it MUST close the session with
 * INVALID_STREAM_HEADER".
 */
function subgroupTypeFlagsError(typeFlags: bigint): string | null {
  // "Values of 128 or greater (i.e., any value that requires more than a
  // one-byte variable-length integer encoding)."
  if (typeFlags >= 128n) {
    return `SUBGROUP_HEADER Type Flags of 128 or greater are invalid (got ${typeFlags})`
  }
  const v = Number(typeFlags)
  // "Values where bit 4 is not set. Bit 4 MUST be 1 for SUBGROUP_HEADER."
  if ((v & 0x10) === 0) {
    return `SUBGROUP_HEADER Type Flags 0x${v.toString(16)} must have bit 4 (0x10) set`
  }
  // "Values with SUBGROUP_ID_MODE set to 0b11. This mode is reserved for future
  // use."
  if ((v & 0x06) === 0x06) {
    return `SUBGROUP_HEADER Type Flags 0x${v.toString(16)} sets SUBGROUP_ID_MODE to the reserved 0b11`
  }
  return null
}

/** Whether a first byte could begin a SUBGROUP_HEADER — used to sniff a stream's type. */
function isValidSubgroupType(streamType: number): boolean {
  return subgroupTypeFlagsError(BigInt(streamType)) === null
}

// ─── OBJECT_DATAGRAM Type Flags (draft-23 Section 11.2.1) ───────────────────
//
// | Bit | Mask | Meaning
// |  0  | 0x01 | PROPERTIES
// |  1  | 0x02 | END_OF_GROUP
// |  2  | 0x04 | ZERO_OBJECT_ID — Object ID field omitted, id is 0
// |  3  | 0x08 | DEFAULT_PRIORITY — Publisher Priority field omitted
// |  4  | 0x10 | MUST be 0
// |  5  | 0x20 | STATUS — Object Status present instead of an Object Payload
// |  6+ |      | no specified meaning

/** Bits with a specified meaning that a sender is allowed to set. */
const DATAGRAM_ALLOWED_BITS = 0x2fn // 0x01 | 0x02 | 0x04 | 0x08 | 0x20

/**
 * Returns null when valid, or the reason it is not. Section 11.2.1: "If a
 * received value has bit 4 set, or has a bit set whose meaning is not
 * specified, the endpoint MUST close the session with INVALID_STREAM_HEADER."
 * and the STATUS-with-END_OF_GROUP combination is in the same list.
 */
function datagramTypeFlagsError(typeFlags: bigint): string | null {
  if ((typeFlags & 0x10n) !== 0n) {
    return `datagram Type Flags bit 4 (0x10) is reserved and MUST be zero (got 0x${typeFlags.toString(16)})`
  }
  if ((typeFlags & ~DATAGRAM_ALLOWED_BITS) !== 0n) {
    return `datagram Type Flags 0x${typeFlags.toString(16)} sets a bit whose meaning is not specified`
  }
  const v = Number(typeFlags)
  if ((v & 0x20) !== 0 && (v & 0x02) !== 0) {
    return `datagram Type Flags 0x${v.toString(16)} sets both the STATUS and END_OF_GROUP bits`
  }
  return null
}

/** The largest value a Group ID or Object ID can take (draft-23 Section 8.1). */
const MAX_U64 = 0xffffffffffffffffn

export function encodeSubgroupStream(stream: SubgroupStream): Uint8Array {
  const w = new BufferWriter()
  const streamType = stream.headerType
  // writeVarInt emits the minimal form, so a legal Type Flags value always goes
  // out as the one byte Section 11.3.1 expects.
  w.writeVarInt(BigInt(streamType))

  const propertiesPresent = (streamType & 0x01) !== 0
  const subgroupMode = (streamType & 0x06) >> 1
  const hasSubgroupField = subgroupMode === 0x02
  const hasPriority = (streamType & 0x20) === 0

  w.writeVarInt(stream.trackAlias)
  w.writeVarInt(stream.groupId)
  if (hasSubgroupField) {
    w.writeVarInt(stream.subgroupId)
  }
  if (hasPriority) {
    w.writeUint8(stream.publisherPriority)
  }
  let prevObjectId = -1n
  for (const obj of stream.objects) {
    // Section 11.3.1: "The Object ID Delta + 1 is added to the previous Object
    // ID in the Subgroup stream if there was one. The Object ID is the Object
    // ID Delta if it's the first Object in the Subgroup stream."
    const delta = prevObjectId < 0n ? obj.objectId : obj.objectId - prevObjectId - 1n
    w.writeVarInt(delta)
    if (propertiesPresent) {
      const props = obj.extensionData
      w.writeVarInt(BigInt(props.byteLength))
      w.writeBytes(props)
    }
    w.writeVarInt(BigInt(obj.payloadLength))
    if (obj.payloadLength === 0) {
      w.writeVarInt(obj.status ?? OBJECT_STATUS_NORMAL)
    } else {
      w.writeBytes(obj.payload)
    }
    prevObjectId = obj.objectId
  }
  return w.finish()
}

export function encodeDatagram(dg: DatagramObject): Uint8Array {
  const w = new BufferWriter()
  const dgType = dg.datagramType
  w.writeVarInt(BigInt(dgType))
  w.writeVarInt(dg.trackAlias)
  w.writeVarInt(dg.groupId)

  const objectIdAbsent = (dgType & 0x04) !== 0
  const isStatus = (dgType & 0x20) !== 0
  const defaultPriority = (dgType & 0x08) !== 0
  const propertiesPresent = (dgType & 0x01) !== 0

  if (!objectIdAbsent) {
    w.writeVarInt(dg.objectId)
  }
  if (!defaultPriority) {
    w.writeUint8(dg.publisherPriority)
  }

  if (propertiesPresent) {
    const props = dg.extensionData ?? new Uint8Array(0)
    w.writeVarInt(BigInt(props.byteLength))
    w.writeBytes(props)
  }

  if (isStatus) {
    // Status and payload occupy the same position; only one is present.
    w.writeVarInt(dg.objectStatus ?? OBJECT_STATUS_NORMAL)
  } else {
    w.writeBytes(dg.payload)
  }
  return w.finish()
}

/**
 * The value to write into an Object's Object ID Delta slot,
 * draft-23 Section 11.4.1.1: "When the Group ID Delta field is present, the Object ID is the
 * value of Object ID Delta if present. When the Group ID Delta field is not
 * present, the Object ID is the prior Object's ID plus the Object ID Delta + 2
 * if present."
 */
function objectIdDeltaFor(flags: number, objectId: bigint, prevObjectId: bigint): bigint {
  return (flags & 0x08) !== 0 ? objectId : objectId - prevObjectId - 2n
}

/** The decode-side counterpart of {@link objectIdDeltaFor}. */
function resolveObjectId(groupIdPresent: boolean, delta: bigint, prevObjectId: bigint): bigint {
  return groupIdPresent ? delta : prevObjectId + delta + 2n
}

export function encodeFetchStream(
  stream: FetchStream,
  groupOrder: FetchGroupOrder = 1n,
): Uint8Array {
  const descending = isDescending(groupOrder)
  const w = new BufferWriter()
  w.writeVarInt(FETCH_STREAM_TYPE)
  w.writeVarInt(stream.requestId)

  let prevGroupId = 0n
  let prevObjectId = 0n
  let first = true

  for (const obj of stream.objects) {
    const flags = obj.serializationFlags
    w.writeVarInt(BigInt(flags))
    if (isEndMarker(flags)) {
      // Section 11.4.2.2: "no other fields are present. [...] The prior Object
      // ID becomes 2^64-1."
      prevObjectId = MAX_U64
      first = false
      continue
    }
    if (FETCH_END_OF_RANGE.has(flags)) {
      // Section 11.4.2.1: absolute IDs when first; otherwise Group ID Delta
      // from the prior Group ID (no + 1, subtracted under Descending) and,
      // within the same Group, the Object ID as prior + Object ID Delta + 1.
      if (first) {
        w.writeVarInt(obj.groupId)
        w.writeVarInt(obj.objectId)
      } else {
        const groupDelta = descending ? prevGroupId - obj.groupId : obj.groupId - prevGroupId
        w.writeVarInt(groupDelta)
        w.writeVarInt(groupDelta === 0n ? obj.objectId - prevObjectId - 1n : obj.objectId)
      }
      // Object Payload Length stays: Figure 29 makes it mandatory and
      // Section 11.4.2 does not list it among the absent fields. Written as 0.
      w.writeVarInt(BigInt(obj.payloadLength))
    } else {
      if (flags & 0x08) {
        if (first) w.writeVarInt(obj.groupId)
        else w.writeVarInt(groupIdDeltaFor(obj.groupId, prevGroupId, descending))
      }
      // A DATAGRAM-mode Object (0x40) has no Subgroup ID field.
      if (!(flags & 0x40) && (flags & 0x03) === 0x03) w.writeVarInt(obj.subgroupId)
      if (flags & 0x04) {
        w.writeVarInt(first ? obj.objectId : objectIdDeltaFor(flags, obj.objectId, prevObjectId))
      }
      if (flags & 0x10) w.writeUint8(obj.publisherPriority)
      if (flags & 0x20) {
        const props = obj.extensionData
        w.writeVarInt(BigInt(props.byteLength))
        w.writeBytes(props)
      }
      w.writeVarInt(BigInt(obj.payloadLength))
      if (obj.payloadLength > 0) {
        w.writeBytes(obj.payload)
      }
    }
    prevGroupId = obj.groupId
    prevObjectId = obj.objectId
    first = false
  }
  return w.finish()
}

/**
 * The Group ID Delta to write for an Object after the first, the inverse of
 * draft-23 Section 11.4.1.1: "If the Group Order is Ascending, the Group ID is the
 * prior Object's Group ID plus the Group ID Delta + 1. If the Group Order is
 * Descending, the Group ID is the prior Object's Group ID minus the (Group ID
 * Delta + 1)."
 */
function groupIdDeltaFor(groupId: bigint, prevGroupId: bigint, descending: boolean): bigint {
  return descending ? prevGroupId - groupId - 1n : groupId - prevGroupId - 1n
}

/**
 * Resolve an Object's Group ID Delta, draft-23 Section 11.4.1.1: "If the Group
 * Order is Ascending, the Group ID is the prior Object's Group ID plus the
 * Group ID Delta + 1. If the Group Order is Descending, the Group ID is the
 * prior Object's Group ID minus the (Group ID Delta + 1). If the computed
 * Group ID would be less than 0 or greater than 2^64-1, the Subscriber MUST
 * close the Session with DELTA_ENCODING_OVERFLOW."
 *
 * The order comes from the FETCH, not the data stream, so the caller passes
 * it to `decodeFetchStream`.
 */
function resolveGroupId(
  first: boolean,
  delta: bigint,
  prevGroupId: bigint,
  offset: number,
  descending: boolean,
): bigint {
  const groupId = first ? delta : descending ? prevGroupId - delta - 1n : prevGroupId + delta + 1n
  if (groupId < 0n) {
    throw fail(Close.DeltaEncodingOverflow, 'computed Group ID is below 0', offset)
  }
  if (groupId > MAX_U64) {
    throw fail(Close.DeltaEncodingOverflow, 'computed Group ID exceeds 2^64 - 1', offset)
  }
  return groupId
}

/**
 * The SUBGROUP_HEADER fields, read once for both decoders so that the one-shot
 * and incremental paths cannot disagree about a header.
 */
interface SubgroupHeaderFields {
  readonly streamType: number
  readonly propertiesPresent: boolean
  /** Subgroup Mode 0b01: the Subgroup ID is the first Object's ID. */
  readonly subgroupIsFirstObjId: boolean
  readonly endOfGroup: boolean
  readonly firstObjectFlag: boolean
  readonly trackAlias: bigint
  readonly groupId: bigint
  /** Zero under `subgroupIsFirstObjId` until the first Object has been read. */
  readonly subgroupId: bigint
  readonly publisherPriority: number
}

function readSubgroupHeader(r: BufferReader): SubgroupHeaderFields {
  // The Type Flags are a vi64 and Section 8.1 allows non-minimal encodings, so
  // the value is judged, not the encoding.
  const typeFlags = r.readVarInt()
  const flagsError = subgroupTypeFlagsError(typeFlags)
  if (flagsError !== null) {
    throw fail(Close.InvalidStreamHeader, flagsError, 0)
  }
  const streamType = Number(typeFlags)

  const propertiesPresent = (streamType & 0x01) !== 0
  const subgroupMode = (streamType & 0x06) >> 1
  const hasSubgroupField = subgroupMode === 0x02
  const subgroupIsFirstObjId = subgroupMode === 0x01
  const endOfGroup = (streamType & 0x08) !== 0
  const hasPriority = (streamType & 0x20) === 0
  const firstObjectFlag = (streamType & 0x40) !== 0

  const trackAlias = r.readVarInt()
  const groupId = r.readVarInt()
  let subgroupId = 0n
  if (hasSubgroupField) {
    subgroupId = r.readVarInt()
  }

  let publisherPriority = 128
  if (hasPriority) {
    publisherPriority = r.readUint8()
  }

  return {
    streamType,
    propertiesPresent,
    subgroupIsFirstObjId,
    endOfGroup,
    firstObjectFlag,
    trackAlias,
    groupId,
    subgroupId,
    publisherPriority,
  }
}

/**
 * One Object off a subgroup stream, for both decoders. `base` is the absolute
 * stream offset that `r.offset === 0` corresponds to. Throws `UNEXPECTED_END`
 * when the Object is not yet complete.
 */
function readSubgroupObject(
  r: BufferReader,
  propertiesPresent: boolean,
  isFirst: boolean,
  prevObjectId: bigint,
  base: number,
): ObjectPayload {
  const byteOffset = base + r.offset
  const delta = r.readVarInt()
  const objectId = isFirst ? delta : prevObjectId + 1n + delta
  // Section 11.3.1: "If the resulting Object ID would be greater than 2^64 - 1,
  // the endpoint MUST close the session with DELTA_ENCODING_OVERFLOW."
  if (objectId > MAX_U64) {
    throw fail(Close.DeltaEncodingOverflow, 'computed Object ID exceeds 2^64 - 1', base + r.offset)
  }

  let extensionData = new Uint8Array(0)
  let extensionDataByteOffset: number | undefined
  if (propertiesPresent) {
    const propsLen = Number(r.readVarInt())
    extensionDataByteOffset = base + r.offset
    extensionData = r.readBytesView(propsLen)
  }

  const payloadLength = Number(r.readVarInt())
  let payload: Uint8Array
  let status: bigint | undefined
  let payloadByteOffset: number
  if (payloadLength === 0) {
    // Section 11.3.1: "The Object Status field is only sent if the Object
    // Payload Length is zero."
    status = r.readVarInt()
    checkObjectStatus(status, extensionData.byteLength > 0, base + r.offset)
    payloadByteOffset = base + r.offset
    payload = new Uint8Array(0)
  } else {
    payloadByteOffset = base + r.offset
    payload = r.readBytesView(payloadLength)
  }

  const obj: ObjectPayload = {
    type: 'object',
    byteOffset,
    payloadByteOffset,
    objectId,
    objectIdDelta: delta,
    payloadLength,
    payload,
    extensionData,
  }
  if (status !== undefined) (obj as unknown as Record<string, unknown>).status = status
  if (extensionDataByteOffset !== undefined)
    (obj as unknown as Record<string, unknown>).extensionDataByteOffset = extensionDataByteOffset
  return obj
}

export function decodeSubgroupStream(bytes: Uint8Array): DecodeResult<SubgroupStream> {
  try {
    const r = new BufferReader(bytes)
    const h = readSubgroupHeader(r)

    const objects: ObjectPayload[] = []
    let prevObjectId = -1n
    let isFirst = true
    let subgroupId = h.subgroupId

    while (r.remaining > 0) {
      const obj = readSubgroupObject(r, h.propertiesPresent, isFirst, prevObjectId, 0)
      if (isFirst && h.subgroupIsFirstObjId) subgroupId = obj.objectId
      isFirst = false
      objects.push(obj)
      prevObjectId = obj.objectId
    }

    const result: SubgroupStream = {
      type: 'subgroup',
      headerType: h.streamType,
      trackAlias: h.trackAlias,
      groupId: h.groupId,
      subgroupId,
      publisherPriority: h.publisherPriority,
      objects,
      ...(h.endOfGroup ? { endOfGroup: true } : {}),
      ...(h.firstObjectFlag ? { firstObject: true } : {}),
    }

    return { ok: true, value: result, bytesRead: r.offset }
  } catch (e) {
    if (e instanceof DecodeError) return { ok: false, error: e }
    throw e
  }
}

export function decodeDatagram(bytes: Uint8Array): DecodeResult<DatagramObject> {
  try {
    const r = new BufferReader(bytes)
    const typeFlags = r.readVarInt()
    const flagsError = datagramTypeFlagsError(typeFlags)
    if (flagsError !== null) {
      return { ok: false, error: fail(Close.InvalidStreamHeader, flagsError, 0) }
    }
    const dgType = Number(typeFlags)

    const objectIdAbsent = (dgType & 0x04) !== 0
    const endOfGroup = (dgType & 0x02) !== 0
    const isStatus = (dgType & 0x20) !== 0
    const defaultPriority = (dgType & 0x08) !== 0
    const propertiesPresent = (dgType & 0x01) !== 0

    const trackAlias = r.readVarInt()
    const groupId = r.readVarInt()
    let objectId = 0n
    if (!objectIdAbsent) {
      objectId = r.readVarInt()
    }

    let publisherPriority = 128
    if (!defaultPriority) {
      publisherPriority = r.readUint8()
    }

    let extensionData: Uint8Array | undefined
    let extensionDataByteOffset: number | undefined
    if (propertiesPresent) {
      const propsLen = Number(r.readVarInt())
      if (propsLen === 0) {
        // Section 11.2.1: "If an endpoint receives a datagram with the
        // PROPERTIES bit set and an Properties Length of 0, it MUST close the
        // session with MALFORMED_OBJECT."
        return {
          ok: false,
          error: fail(
            Close.MalformedObject,
            'a datagram with the PROPERTIES bit set must carry a non-empty Properties structure',
            r.offset,
          ),
        }
      }
      extensionDataByteOffset = r.offset
      extensionData = r.readBytesView(propsLen)
    }

    let objectStatus: bigint | undefined
    let payload: Uint8Array
    if (isStatus) {
      objectStatus = r.readVarInt()
      // Section 11.2.1: "If an Object Datagram includes both the STATUS bit and
      // PROPERTIES bit, and the Object Status is not Normal (0x0), the endpoint
      // MUST close the session with INVALID_OBJECT_STATUS".
      checkObjectStatus(objectStatus, propertiesPresent, r.offset)
      if (r.remaining > 0) {
        // Section 11.1.1: "An Object MUST have an empty payload unless its
        // Object Status value is registered as permitting a payload"; with the
        // STATUS bit set the Object Status takes the payload's place, so these
        // bytes cannot be serialized as part of the Object.
        return {
          ok: false,
          error: fail(
            Close.MalformedObject,
            `a status datagram must not carry a payload (${r.remaining} trailing byte(s))`,
            r.offset,
          ),
        }
      }
      payload = new Uint8Array(0)
    } else {
      // No length field: the payload is everything left in the datagram.
      payload = r.readBytesView(r.remaining)
    }
    const payloadLength = payload.byteLength

    const result: DatagramObject = {
      type: 'datagram',
      datagramType: dgType,
      trackAlias,
      groupId,
      objectId,
      publisherPriority,
      payloadLength,
      payload,
    }

    if (endOfGroup) (result as unknown as Record<string, unknown>).endOfGroup = true
    if (objectStatus !== undefined)
      (result as unknown as Record<string, unknown>).objectStatus = objectStatus
    if (extensionData !== undefined)
      (result as unknown as Record<string, unknown>).extensionData = extensionData
    if (extensionDataByteOffset !== undefined)
      (result as unknown as Record<string, unknown>).extensionDataByteOffset =
        extensionDataByteOffset

    return { ok: true, value: result, bytesRead: r.offset }
  } catch (e) {
    if (e instanceof DecodeError) return { ok: false, error: e }
    throw e
  }
}

/** The delta state a fetch stream carries from one entry to the next. */
interface FetchObjectState {
  prevGroupId: bigint
  prevSubgroupId: bigint
  prevObjectId: bigint
  prevPriority: number
  /** No entry has been read since the FETCH_HEADER. */
  first: boolean
  /** An actual Object has been read, so prior Subgroup ID and Priority exist. */
  hasPriorObject: boolean
  /** The stream's Group Order is Descending. */
  descending: boolean
}

function newFetchObjectState(groupOrder: FetchGroupOrder): FetchObjectState {
  return {
    prevGroupId: 0n,
    prevSubgroupId: 0n,
    prevObjectId: 0n,
    prevPriority: 128,
    first: true,
    hasPriorObject: false,
    descending: isDescending(groupOrder),
  }
}

/**
 * An Object flag that refers to a prior field which does not exist.
 * Section 11.4.1.1: "If the first Object in the FETCH response uses a flag that
 * references fields in the prior Object, the Subscriber MUST close the session
 * with MALFORMED_OBJECT." Section 11.4.2.2 says the same of the prior Subgroup
 * ID and Priority after an End of Range indicator with no Object before it.
 */
function noPriorField(field: string, offset: number): DecodeError {
  return fail(
    Close.MalformedObject,
    `fetch Object references the prior ${field} and there is no prior Object`,
    offset,
  )
}

/**
 * An End of Range indicator, draft-23 Section 11.4.2.1: "If this End of Range
 * indicator is the first entry after the FETCH_HEADER, both fields encode
 * absolute IDs. Otherwise, the prior Group ID and prior Object ID are the
 * decoded IDs of the most recent preceding Object or End of Range indicator.
 * For subsequent indicators, the Group ID is the prior Group ID plus Group ID
 * Delta for Ascending Group Order, or minus Group ID Delta for Descending Group
 * Order. If Group ID Delta is zero, the Object ID is the prior Object ID plus
 * Object ID Delta + 1. When Group ID Delta is nonzero, the Object ID Delta field
 * contains the absolute Object ID in the new Group. If either decoded ID is less
 * than zero or greater than 2^64-1, the Subscriber MUST close the Session with
 * DELTA_ENCODING_OVERFLOW."
 *
 * After End of Group or End of Track the prior Object ID is 2^64-1
 * (Section 11.4.2.2), so an indicator in the same Group overflows.
 */
function readEndOfRange(
  r: BufferReader,
  base: number,
  byteOffset: number,
  flags: number,
  st: FetchObjectState,
): FetchObjectPayload {
  const groupDelta = r.readVarInt()
  const objectDelta = r.readVarInt()
  let groupId: bigint
  let objectId: bigint
  if (st.first) {
    groupId = groupDelta
    objectId = objectDelta
  } else {
    groupId = st.descending ? st.prevGroupId - groupDelta : st.prevGroupId + groupDelta
    objectId = groupDelta === 0n ? st.prevObjectId + objectDelta + 1n : objectDelta
  }
  if (groupId < 0n || groupId > MAX_U64 || objectId > MAX_U64) {
    throw fail(
      Close.DeltaEncodingOverflow,
      'End of Range indicator decodes to an ID below 0 or above 2^64 - 1',
      base + r.offset,
    )
  }
  const payloadLength = Number(r.readVarInt())
  const payloadByteOffset = base + r.offset
  const payload = payloadLength > 0 ? r.readBytesView(payloadLength) : new Uint8Array(0)

  // Section 11.4.2.2: "Prior Group ID and prior Object ID: The decoded values
  // from the End of Range indicator." The prior Subgroup ID and Priority stay
  // with the last actual Object.
  st.prevGroupId = groupId
  st.prevObjectId = objectId
  st.first = false
  return {
    type: 'object',
    byteOffset,
    payloadByteOffset,
    serializationFlags: flags,
    groupId,
    groupIdDelta: groupDelta,
    subgroupId: st.prevSubgroupId,
    objectId,
    objectIdDelta: objectDelta,
    publisherPriority: st.prevPriority,
    payloadLength,
    payload,
    extensionData: new Uint8Array(0),
  }
}

/**
 * End of Group (0x80) or End of Track (0x81), draft-23 Section 11.4.2.2: "When
 * Serialization Flags is 0x80 (End of Group) or 0x81 (End of Track), no other
 * fields are present. The prior Object is the last Object in its Group, or in
 * the Track, respectively. End of Track also indicates End of Group. The prior
 * Object ID becomes 2^64-1."
 *
 * As the first entry it would name a prior Object that does not exist, which
 * Section 12.2 files under MALFORMED_OBJECT: "The serialization of an Object on
 * a data stream or in a datagram cannot be decoded, for example a flag
 * references a prior Object that does not exist."
 *
 * Straight after another marker or an End of Range indicator, the draft states
 * no rule. The marker is accepted and reports the prior entry's Location: after
 * a marker that is {Group, 2^64-1}, after End of Range the range's end.
 */
function readEndMarker(
  r: BufferReader,
  base: number,
  byteOffset: number,
  flags: number,
  st: FetchObjectState,
): FetchObjectPayload {
  if (st.first) {
    throw fail(
      Close.MalformedObject,
      `0x${flags.toString(16)} is the first fetch entry, so there is no prior Object for it to end`,
      base + r.offset,
    )
  }
  const marker: FetchObjectPayload = {
    type: 'object',
    byteOffset,
    payloadByteOffset: base + r.offset,
    serializationFlags: flags,
    groupId: st.prevGroupId,
    subgroupId: st.prevSubgroupId,
    objectId: st.prevObjectId,
    publisherPriority: st.prevPriority,
    payloadLength: 0,
    payload: new Uint8Array(0),
    extensionData: new Uint8Array(0),
  }
  st.prevObjectId = MAX_U64
  return marker
}

/**
 * One entry off a fetch stream, for both decoders: an Object or a Table 8
 * indicator. `base` is the absolute offset that `r.offset === 0` corresponds
 * to.
 */
function readFetchObject(r: BufferReader, base: number, st: FetchObjectState): FetchObjectPayload {
  const byteOffset = base + r.offset
  const rawFlags = r.readVarInt()

  if (rawFlags >= 0x80n) {
    // Section 11.4.1: "When 128 or greater, the value signals an indicator
    // [...] If an endpoint receives any other value greater than 127, it MUST
    // close the session with MALFORMED_OBJECT."
    const flags = Number(rawFlags)
    if (rawFlags <= 0xffffn && FETCH_END_OF_RANGE.has(flags)) {
      return readEndOfRange(r, base, byteOffset, flags, st)
    }
    if (isEndMarker(flags)) return readEndMarker(r, base, byteOffset, flags, st)
    throw fail(
      Close.MalformedObject,
      `0x${rawFlags.toString(16)} is neither a flag combination below 128 nor a Table 8 indicator`,
      base + r.offset,
    )
  }
  const flags = Number(rawFlags)

  const datagram = (flags & 0x40) !== 0
  const subgroupEncoding = flags & 0x03
  const objectIdPresent = (flags & 0x04) !== 0
  const groupIdPresent = (flags & 0x08) !== 0
  const priorityPresent = (flags & 0x10) !== 0
  const propsPresent = (flags & 0x20) !== 0

  // Section 11.4.1.1: "The first Object MUST include a Group ID Delta and
  // Object ID Delta, and these values are the absolute Group ID and Object ID."
  if (st.first && !groupIdPresent) throw noPriorField('Group ID', base + r.offset)
  if (st.first && !objectIdPresent) throw noPriorField('Object ID', base + r.offset)

  let groupId = st.prevGroupId
  let groupDelta: bigint | undefined
  if (groupIdPresent) {
    groupDelta = r.readVarInt()
    groupId = resolveGroupId(st.first, groupDelta, st.prevGroupId, base + r.offset, st.descending)
  }

  // Section 11.4.1.1: with 0x40 set the subscriber "MUST ignore" the two low
  // bits, and the Object has no Subgroup ID.
  let subgroupId = st.prevSubgroupId
  if (!datagram) {
    if (subgroupEncoding === 0x00) {
      subgroupId = 0n
    } else if (subgroupEncoding === 0x03) {
      subgroupId = r.readVarInt()
    } else {
      if (!st.hasPriorObject) throw noPriorField('Subgroup ID', base + r.offset)
      subgroupId = subgroupEncoding === 0x01 ? st.prevSubgroupId : st.prevSubgroupId + 1n
    }
  }

  // Table 10: absent an Object ID Delta, "Object ID is the prior Object's ID
  // plus one".
  let objectId = st.prevObjectId + 1n
  let objectDelta: bigint | undefined
  if (objectIdPresent) {
    objectDelta = r.readVarInt()
    objectId = st.first
      ? objectDelta
      : resolveObjectId(groupIdPresent, objectDelta, st.prevObjectId)
  }
  // "If the computed Object ID would be greater than 2^64-1, the Subscriber
  // MUST close the Session with DELTA_ENCODING_OVERFLOW."
  if (objectId > MAX_U64) {
    throw fail(Close.DeltaEncodingOverflow, 'computed Object ID exceeds 2^64 - 1', base + r.offset)
  }

  let publisherPriority = st.prevPriority
  if (priorityPresent) {
    publisherPriority = r.readUint8()
  } else if (!st.hasPriorObject) {
    throw noPriorField('Priority', base + r.offset)
  }

  let extensionData = new Uint8Array(0)
  let extensionDataByteOffset: number | undefined
  if (propsPresent) {
    const propsLen = Number(r.readVarInt())
    extensionDataByteOffset = base + r.offset
    extensionData = r.readBytesView(propsLen)
  }

  const payloadLength = Number(r.readVarInt())
  const payloadByteOffset = base + r.offset
  const payload = payloadLength > 0 ? r.readBytesView(payloadLength) : new Uint8Array(0)

  // A fetch stream carries no Object Status: Section 11.1.1 says it "is absent
  // in Objects delivered via a FETCH".
  const obj: FetchObjectPayload = {
    type: 'object',
    byteOffset,
    payloadByteOffset,
    serializationFlags: flags,
    groupId,
    subgroupId: datagram ? 0n : subgroupId,
    objectId,
    publisherPriority,
    payloadLength,
    payload,
    extensionData,
  }
  if (groupDelta !== undefined)
    (obj as unknown as Record<string, unknown>).groupIdDelta = groupDelta
  if (objectDelta !== undefined)
    (obj as unknown as Record<string, unknown>).objectIdDelta = objectDelta
  if (extensionDataByteOffset !== undefined)
    (obj as unknown as Record<string, unknown>).extensionDataByteOffset = extensionDataByteOffset

  st.prevGroupId = groupId
  if (!datagram) st.prevSubgroupId = subgroupId
  st.prevObjectId = objectId
  st.prevPriority = publisherPriority
  st.first = false
  st.hasPriorObject = true
  return obj
}

function fetchHeaderTypeError(streamType: bigint): DecodeError {
  return fail(
    Close.InvalidStreamHeader,
    `Expected fetch stream type 0x05, got 0x${streamType.toString(16)}`,
    0,
  )
}

export function decodeFetchStream(
  bytes: Uint8Array,
  groupOrder: FetchGroupOrder = 1n,
): DecodeResult<FetchStream> {
  try {
    const r = new BufferReader(bytes)
    const streamType = r.readVarInt()
    if (streamType !== FETCH_STREAM_TYPE) {
      return { ok: false, error: fetchHeaderTypeError(streamType) }
    }
    // Section 11.4.1: "all objects on the stream belong to the track requested
    // in the message identified by Request ID": a FETCH, or the SUBSCRIBE,
    // PUBLISH or REQUEST_UPDATE that requested a fill (Section 3.4).
    const requestId = r.readVarInt()
    const objects: FetchObjectPayload[] = []
    const st = newFetchObjectState(groupOrder)
    while (r.remaining > 0) {
      objects.push(readFetchObject(r, 0, st))
    }
    return { ok: true, value: { type: 'fetch', requestId, objects }, bytesRead: r.offset }
  } catch (e) {
    if (e instanceof DecodeError) return { ok: false, error: e }
    throw e
  }
}

/** `groupOrder` is the FETCH's Group Order, read only for a fetch stream. */
export function decodeDataStream(
  streamType: 'subgroup' | 'datagram' | 'fetch',
  bytes: Uint8Array,
  groupOrder: FetchGroupOrder = 1n,
): DecodeResult<Draft23DataStream> {
  switch (streamType) {
    case 'subgroup':
      return decodeSubgroupStream(bytes)
    case 'datagram':
      return decodeDatagram(bytes)
    case 'fetch':
      return decodeFetchStream(bytes, groupOrder)
    default: {
      const _exhaustive: never = streamType
      throw new Error(`Unknown stream type: ${_exhaustive}`)
    }
  }
}

// ─── Data Stream Decoders ──────────────────────────────────────────────────────

/**
 * A data stream's bytes, accumulated across chunks.
 *
 * It never compacts in place: Object payloads are handed out as views into
 * this buffer, so moving bytes within it would corrupt an Object already
 * emitted. The consumed prefix is dropped only when a fresh array is being
 * allocated anyway.
 */
class StreamBuffer {
  private buf = new Uint8Array(0)
  /** Bytes written into `buf`. */
  private len = 0
  /** Consumed prefix of `buf`; `base + offset` is the position in the stream. */
  offset = 0
  /** Absolute position of `buf[0]` within the stream. */
  base = 0

  get unread(): number {
    return this.len - this.offset
  }

  append(chunk: Uint8Array): void {
    if (this.len + chunk.length > this.buf.length) {
      const live = this.len - this.offset
      const needed = live + chunk.length
      // Grow until the buffer is at least half free after reclaiming the
      // consumed prefix, so it does not reallocate on every chunk.
      let cap = Math.max(4096, this.buf.length)
      while (cap < needed * 2) cap *= 2
      // A fresh array every time: the old one is still pinned by the payload
      // views handed out of it.
      const next = new Uint8Array(cap)
      next.set(this.buf.subarray(this.offset, this.len), 0)
      this.buf = next
      this.base += this.offset
      this.len = live
      this.offset = 0
    }
    this.buf.set(chunk, this.len)
    this.len += chunk.length
  }

  /** The written bytes, bounded by `len` rather than by capacity. */
  written(): Uint8Array {
    return this.buf.subarray(0, this.len)
  }
}

/**
 * The error for a stream that ends with unread bytes. Past the header they are
 * part of an Object, draft-23 Section 11.3: "If a stream ends gracefully
 * (i.e., the stream terminates with a FIN) in the middle of a serialized
 * Object, the receiver SHOULD close the session with TRUNCATED_OBJECT."
 */
function streamEndedError(headerRead: boolean, b: StreamBuffer): DecodeError {
  const offset = b.base + b.offset
  return headerRead
    ? new DecodeError(
        'UNEXPECTED_END',
        'Stream ended in the middle of an Object',
        offset,
        Close.TruncatedObject,
      )
    : new DecodeError('UNEXPECTED_END', 'Stream ended in the middle of its header', offset)
}

export function createSubgroupStreamDecoder(): TransformStream<
  Uint8Array,
  SubgroupStreamHeader | ObjectPayload
> {
  const b = new StreamBuffer()
  let header: SubgroupHeaderFields | null = null
  let headerEmitted = false
  let prevObjectId = -1n
  let isFirst = true

  function emitHeader(
    controller: TransformStreamDefaultController<SubgroupStreamHeader | ObjectPayload>,
    h: SubgroupHeaderFields,
    subgroupId: bigint,
  ): void {
    controller.enqueue({
      type: 'subgroup_header',
      headerType: h.streamType,
      trackAlias: h.trackAlias,
      groupId: h.groupId,
      subgroupId,
      publisherPriority: h.publisherPriority,
      ...(h.endOfGroup ? { endOfGroup: true } : {}),
      ...(h.firstObjectFlag ? { firstObject: true } : {}),
    })
    headerEmitted = true
  }

  return new TransformStream<Uint8Array, SubgroupStreamHeader | ObjectPayload>({
    transform(chunk, controller) {
      b.append(chunk)
      const view = b.written()

      if (header === null) {
        try {
          const hr = new BufferReader(view, b.offset)
          header = readSubgroupHeader(hr)
          b.offset = hr.offset
        } catch (e) {
          if (e instanceof DecodeError && e.code === 'UNEXPECTED_END') {
            return
          }
          controller.error(e)
          return
        }
        // Where the Subgroup ID is the first Object's ID, the header waits for
        // that Object, so it reports what the one-shot decoder does.
        if (!header.subgroupIsFirstObjId) emitHeader(controller, header, header.subgroupId)
      }

      const h = header
      if (h === null) return

      const r = new BufferReader(view, b.offset)
      while (r.remaining > 0) {
        const start = r.offset
        let obj: ObjectPayload
        try {
          obj = readSubgroupObject(r, h.propertiesPresent, isFirst, prevObjectId, b.base)
        } catch (e) {
          if (e instanceof DecodeError && e.code === 'UNEXPECTED_END') {
            b.offset = start
            return
          }
          controller.error(e)
          return
        }
        if (!headerEmitted) emitHeader(controller, h, obj.objectId)
        isFirst = false
        b.offset = r.offset
        prevObjectId = obj.objectId
        controller.enqueue(obj)
      }
    },

    flush(controller) {
      // A header with no Objects still reports, with Subgroup ID zero as the
      // one-shot decoder does.
      if (header !== null && !headerEmitted) emitHeader(controller, header, 0n)
      if (b.unread > 0) controller.error(streamEndedError(header !== null, b))
    },
  })
}

export function createFetchStreamDecoder(
  groupOrder: FetchGroupOrder = 1n,
): TransformStream<Uint8Array, FetchStreamHeader | ObjectPayload> {
  const b = new StreamBuffer()
  let headerEmitted = false
  const st = newFetchObjectState(groupOrder)

  return new TransformStream<Uint8Array, FetchStreamHeader | ObjectPayload>({
    transform(chunk, controller) {
      b.append(chunk)
      const view = b.written()

      if (!headerEmitted) {
        try {
          const r = new BufferReader(view, b.offset)
          const streamType = r.readVarInt()
          if (streamType !== FETCH_STREAM_TYPE) {
            controller.error(fetchHeaderTypeError(streamType))
            return
          }
          const requestId = r.readVarInt()
          controller.enqueue({ type: 'fetch_header', requestId })
          headerEmitted = true
          b.offset = r.offset
        } catch (e) {
          if (e instanceof DecodeError && e.code === 'UNEXPECTED_END') {
            return
          }
          controller.error(e)
          return
        }
      }

      const r = new BufferReader(view, b.offset)
      while (r.remaining > 0) {
        const start = r.offset
        let obj: FetchObjectPayload
        try {
          // The delta state changes only once an entry has been read whole, so
          // a partial one is simply re-read when the rest arrives.
          obj = readFetchObject(r, b.base, st)
        } catch (e) {
          if (e instanceof DecodeError && e.code === 'UNEXPECTED_END') {
            b.offset = start
            return
          }
          controller.error(e)
          return
        }
        b.offset = r.offset
        controller.enqueue(obj)
      }
    },

    flush(controller) {
      if (b.unread > 0) controller.error(streamEndedError(headerEmitted, b))
    },
  })
}

/** `groupOrder` is the FETCH's Group Order, read only for a fetch stream. */
export function createDataStreamDecoder(
  groupOrder: FetchGroupOrder = 1n,
): TransformStream<Uint8Array, DataStreamEvent> {
  /**
   * The inner decoder's readable is pumped into this one's controller as the
   * bytes arrive, so events are not held until end of stream. The first byte
   * decides which decoder to use.
   */
  let writer: WritableStreamDefaultWriter<Uint8Array> | null = null
  let pump: Promise<void> = Promise.resolve()
  let broken = false

  function attach(
    inner: TransformStream<Uint8Array, DataStreamEvent>,
    controller: TransformStreamDefaultController<DataStreamEvent>,
  ): void {
    writer = inner.writable.getWriter()
    const reader = inner.readable.getReader()
    pump = (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          controller.enqueue(value)
        }
      } catch (e) {
        // The inner decoder owns the diagnosis, so its error is the one that
        // surfaces.
        if (!broken) {
          broken = true
          controller.error(e)
        }
      }
    })()
  }

  async function feed(bytes: Uint8Array): Promise<void> {
    if (writer === null || broken || bytes.length === 0) return
    try {
      await writer.write(bytes)
    } catch {
      // The pump is already reporting this error.
      broken = true
    }
  }

  return new TransformStream<Uint8Array, DataStreamEvent>({
    async transform(chunk, controller) {
      if (broken) return
      if (writer !== null) {
        await feed(chunk)
        return
      }
      if (chunk.length === 0) return
      const firstByte = chunk[0]!

      if (isValidSubgroupType(firstByte)) {
        attach(
          createSubgroupStreamDecoder() as unknown as TransformStream<Uint8Array, DataStreamEvent>,
          controller,
        )
      } else if (firstByte === 0x05) {
        attach(
          createFetchStreamDecoder(groupOrder) as unknown as TransformStream<
            Uint8Array,
            DataStreamEvent
          >,
          controller,
        )
      } else {
        // Section 6.4.1 closes on an unknown unidirectional stream type with
        // INVALID_STREAM_HEADER.
        broken = true
        controller.error(
          fail(
            Close.InvalidStreamHeader,
            `Unknown data stream type: 0x${firstByte.toString(16)}`,
            0,
          ),
        )
        return
      }

      // The type byte is part of the stream the inner decoder reads.
      await feed(chunk)
    },

    async flush() {
      if (writer === null) return
      try {
        await writer.close()
      } catch {
        // Reported by the pump.
      }
      await pump
    },
  })
}
