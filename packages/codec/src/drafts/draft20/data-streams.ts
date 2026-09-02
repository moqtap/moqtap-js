import { MoqtBufferReader as BufferReader } from '../../core/buffer-reader.js'
import { MoqtBufferWriter as BufferWriter } from '../../core/buffer-writer.js'
import type { DecodeResult } from '../../core/types.js'
import { DecodeError } from '../../core/types.js'
import type {
  DatagramObject,
  DataStreamEvent,
  Draft20DataStream,
  FetchObjectPayload,
  FetchStream,
  FetchStreamHeader,
  ObjectPayload,
  SubgroupStream,
  SubgroupStreamHeader,
} from './types.js'

// ─── Data Stream Encoding/Decoding ─────────────────────────────────────────

const FETCH_STREAM_TYPE = 0x05n

// Object property type IDs
const OBJPROP_PRIOR_GROUP_ID_GAP = 0x3cn
const OBJPROP_PRIOR_OBJECT_ID_GAP = 0x3en

const KNOWN_OBJ_PROPS: ReadonlyMap<bigint, string> = new Map([
  [OBJPROP_PRIOR_OBJECT_ID_GAP, 'prior_object_id_gap'],
  [OBJPROP_PRIOR_GROUP_ID_GAP, 'prior_group_id_gap'],
])

// ─── Fetch stream Serialization Flags (draft-20 Section 11.4.4, Table 7) ────

/** End of Non-Existent Range. */
const FETCH_MARKER_NON_EXISTENT = 0x8c
/** End of Unknown Range. */
const FETCH_MARKER_UNKNOWN = 0x10c
/**
 * End of Timed-Out Range — NEW in draft-20 (Sections 11.4.4, 11.4.4.2).
 *
 * Every Object between the last serialized Object, if any, and this Location
 * inclusive timed out: the relay's FILL_TIMEOUT budget ran out. draft-19
 * reported these as Unknown gaps (0x10C) and had no distinct marker, so this
 * value takes over the FILL_TIMEOUT outcome from 0x10C.
 */
const FETCH_MARKER_TIMED_OUT = 0x20c

const FETCH_END_OF_RANGE_MARKERS: ReadonlySet<number> = new Set([
  FETCH_MARKER_NON_EXISTENT,
  FETCH_MARKER_UNKNOWN,
  FETCH_MARKER_TIMED_OUT,
])

function decodeObjectProperties(r: BufferReader, propsLength: number): Record<string, bigint> {
  const endOff = r.offset + propsLength
  const props: Record<string, bigint> = {}
  let prevType = 0n

  while (r.offset < endOff) {
    const delta = r.readVarInt()
    const propType = prevType + delta
    prevType = propType

    if (propType % 2n === 0n) {
      const value = r.readVarInt()
      const name = KNOWN_OBJ_PROPS.get(propType) ?? `0x${propType.toString(16)}`
      props[name] = value
    } else {
      const length = Number(r.readVarInt())
      // Skip unknown odd properties
      r.readBytes(length)
    }
  }
  return props
}

function encodeObjectProperties(props: Record<string, bigint>, w: BufferWriter): void {
  const reverseMap = new Map<string, bigint>()
  for (const [id, name] of KNOWN_OBJ_PROPS) {
    reverseMap.set(name, id)
  }

  const entries: Array<{ type: bigint; value: bigint }> = []
  for (const [name, value] of Object.entries(props)) {
    const typeId = reverseMap.get(name)
    if (typeId !== undefined) {
      entries.push({ type: typeId, value })
    }
  }
  entries.sort((a, b) => (a.type < b.type ? -1 : a.type > b.type ? 1 : 0))

  let prevType = 0n
  for (const entry of entries) {
    w.writeVarInt(entry.type - prevType)
    w.writeVarInt(entry.value)
    prevType = entry.type
  }
}

// ─── SUBGROUP_HEADER Type Flags (draft-20 Section 11.4.2) ───────────────────
//
// | Bit | Mask | Meaning
// |  0  | 0x01 | PROPERTIES — Object Properties present on EVERY object here
// | 1-2 | 0x06 | SUBGROUP_ID_MODE: 00 = id is 0, 01 = id is the first Object's
// |     |      | Object ID, 10 = the Subgroup ID field is present, 11 = reserved
// |  3  | 0x08 | END_OF_GROUP
// |  4  | 0x10 | structural — MUST be 1
// |  5  | 0x20 | DEFAULT_PRIORITY — Publisher Priority field omitted
// |  6  | 0x40 | FIRST_OBJECT
//
// These are draft-20's OWN rules, computed from Section 11.4.2's three
// conditions. They are NOT the datagram rules (Section 11.3.1): bit 4 is
// required here and forbidden there, and SUBGROUP_HEADER has no "unspecified
// bit" condition at all, because bits 0 through 6 are all specified for it.
// SPEC-DELTA Section 10 item 3 flags exactly this conflation as a mistake, so
// neither rule set is derived from the other.
//
// The resulting valid set — 0x10-0x15, 0x18-0x1D, 0x30-0x35, 0x38-0x3D,
// 0x50-0x55, 0x58-0x5D, 0x70-0x75, 0x78-0x7D — is byte for byte draft-19's
// enumeration, so this is a restatement, not a widening or a narrowing.

/** Returns null when valid, or the reason it is not. */
function subgroupTypeFlagsError(typeFlags: bigint): string | null {
  // 3. "Values of 128 or greater."
  if (typeFlags >= 128n) {
    return `SUBGROUP_HEADER Type Flags of 128 or greater are invalid (got ${typeFlags})`
  }
  const v = Number(typeFlags)
  // 2. "Values where bit 4 is not set. Bit 4 MUST be 1 for SUBGROUP_HEADER."
  if ((v & 0x10) === 0) {
    return `SUBGROUP_HEADER Type Flags 0x${v.toString(16)} must have bit 4 (0x10) set`
  }
  // 1. "Values with SUBGROUP_ID_MODE set to 0b11. This mode is reserved."
  if ((v & 0x06) === 0x06) {
    return `SUBGROUP_HEADER Type Flags 0x${v.toString(16)} sets SUBGROUP_ID_MODE to the reserved 0b11`
  }
  return null
}

/** Whether a first byte could begin a SUBGROUP_HEADER — used to sniff a stream's type. */
function isValidSubgroupType(streamType: number): boolean {
  return subgroupTypeFlagsError(BigInt(streamType)) === null
}

// ─── OBJECT_DATAGRAM Type Flags (draft-20 Section 11.3.1) ───────────────────
//
// | Bit | Mask | Meaning
// |  0  | 0x01 | PROPERTIES
// |  1  | 0x02 | END_OF_GROUP
// |  2  | 0x04 | ZERO_OBJECT_ID — Object ID field omitted, id is 0
// |  3  | 0x08 | DEFAULT_PRIORITY — Publisher Priority field omitted
// |  4  | 0x10 | RESERVED — MUST be 0
// |  5  | 0x20 | STATUS — Object Status present instead of an Object Payload
// |  6+ |      | no specified meaning
//
// Section 11.3.1's invalid values: STATUS and END_OF_GROUP both set; bit 4 set;
// any bit set whose meaning is not specified. Unlike SUBGROUP_HEADER there is
// no explicit "128 or greater" bullet — a value of 128 or more necessarily
// sets an unspecified bit, so the third rule catches it. The other two
// conditions (PROPERTIES with a zero Properties Length, and Properties on a
// non-Normal Object) depend on fields past the flags and are checked inline.

/** Bits with a specified meaning that a sender is allowed to set. */
const DATAGRAM_ALLOWED_BITS = 0x2fn // 0x01 | 0x02 | 0x04 | 0x08 | 0x20

/** Returns null when valid, or the reason it is not. */
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

const OBJECT_STATUS_NORMAL = 0n

/** The largest value a Group ID or Object ID can take (draft-20 Section 1.4.1). */
const MAX_U64 = 0xffffffffffffffffn

export function encodeSubgroupStream(stream: SubgroupStream): Uint8Array {
  const w = new BufferWriter()
  const streamType = stream.headerType
  // DECISION (DECISIONS.md D5): strict on send. Section 1.4.1 permits
  // non-minimal encodings, and Section 11.4.2 words its third invalidity rule
  // as "values of 128 or greater (i.e., any value that requires more than a
  // one-byte variable-length integer encoding)" — two clauses that come apart
  // under that allowance. writeVarInt always emits the minimal form, so a
  // legal Type Flags value below 128 always goes out as one byte and can never
  // trip a peer that reads the parenthetical literally.
  w.writeVarInt(BigInt(streamType))

  const propertiesPresent = (streamType & 0x01) !== 0
  const subgroupMode = (streamType & 0x06) >> 1
  const hasSubgroupField = subgroupMode === 0x02
  // DEFAULT_PRIORITY bit (0x20): when set, priority is absent
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
    // Section 11.4.2: "Object ID = previous Object ID + Object ID Delta + 1",
    // or the delta itself for the first Object on the stream. This +1 is the
    // subgroup delta encoding, not a range end — nothing to do with the
    // inclusive/exclusive flip of DECISIONS.md D4.
    const delta = prevObjectId < 0n ? obj.objectId : obj.objectId - prevObjectId - 1n
    w.writeVarInt(delta)
    if (propertiesPresent) {
      if (obj.objectProperties && Object.keys(obj.objectProperties).length > 0) {
        const tmpW = new BufferWriter(32)
        encodeObjectProperties(obj.objectProperties, tmpW)
        const raw = tmpW.finish()
        w.writeVarInt(BigInt(raw.byteLength))
        w.writeBytes(raw)
      } else {
        // Legal here and only here: on a subgroup stream the field is present
        // on every object and an empty one sets Properties Length to 0. The
        // same thing on a datagram is a PROTOCOL_VIOLATION.
        w.writeVarInt(0n)
      }
    }
    w.writeVarInt(BigInt(obj.payloadLength))
    if (obj.payloadLength === 0) {
      // Object Status is serialized only when Object Payload Length is 0.
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
  // D5: minimal on send. See encodeSubgroupStream.
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
    if (dg.objectProperties && Object.keys(dg.objectProperties).length > 0) {
      const tmpW = new BufferWriter(32)
      encodeObjectProperties(dg.objectProperties, tmpW)
      const raw = tmpW.finish()
      w.writeVarInt(BigInt(raw.byteLength))
      w.writeBytes(raw)
    } else {
      // Section 11.3.1 makes this a PROTOCOL_VIOLATION on receipt. An object
      // with no properties leaves the PROPERTIES bit clear instead.
      w.writeVarInt(0n)
    }
  }

  if (isStatus) {
    // Status and payload occupy the same position; only one is present.
    w.writeVarInt(dg.objectStatus ?? OBJECT_STATUS_NORMAL)
  } else {
    w.writeBytes(dg.payload)
  }
  return w.finish()
}

export function encodeFetchStream(stream: FetchStream): Uint8Array {
  const w = new BufferWriter()
  w.writeVarInt(FETCH_STREAM_TYPE)
  w.writeVarInt(stream.requestId)

  let prevGroupId = 0n
  let prevObjectId = 0n
  let first = true

  for (const obj of stream.objects) {
    w.writeVarInt(BigInt(obj.serializationFlags))
    const flags = obj.serializationFlags
    if (flags >= 0x80) {
      // End-of-Range marker (0x8C / 0x10C / 0x20C).
      //
      // DECISION (DECISIONS.md D7, SPEC-DELTA Section 11 Q16): the ordinary
      // Section 11.4.4.1 delta arithmetic applies to the marker's two fields.
      // All three marker values carry the low bits 0x0C — the ordinary
      // "Group ID Delta present, Object ID Delta present" pattern — and
      // Section 11.4.4.2 says only that "the Group ID and Object ID fields are
      // present". It does not say whether they are deltas or absolutes; the
      // flags are literally the normal flags, so they are treated as normal.
      if (first) w.writeVarInt(obj.groupId)
      else w.writeVarInt(obj.groupId - prevGroupId - 1n)
      w.writeVarInt(obj.objectId)
      // DECISION (D7, Q17): Object Payload Length IS present on a marker,
      // encoded as 0. Section 11.4.4.2 lists what is absent — "Subgroup ID,
      // Priority and Properties" — and does not name Object Payload Length,
      // which Figure 28 marks mandatory. Omitting a field the figure requires
      // is what desynchronises a fetch stream.
      w.writeVarInt(BigInt(obj.payloadLength))
    } else if (flags & 0x40) {
      // DATAGRAM mode: no subgroup_id field
      if (flags & 0x08) {
        // Ascending order: Group ID = prior + delta + 1. Section 11.4.4.1
        // delta encoding; not a range end.
        if (first) w.writeVarInt(obj.groupId)
        else w.writeVarInt(obj.groupId - prevGroupId - 1n)
      }
      if (flags & 0x04) w.writeVarInt(objectIdDeltaFor(flags, obj.objectId, prevObjectId))
      if (flags & 0x10) w.writeUint8(obj.publisherPriority)
      if (flags & 0x20) {
        if (obj.objectProperties && Object.keys(obj.objectProperties).length > 0) {
          const tmpW = new BufferWriter(32)
          encodeObjectProperties(obj.objectProperties, tmpW)
          const raw = tmpW.finish()
          w.writeVarInt(BigInt(raw.byteLength))
          w.writeBytes(raw)
        } else {
          w.writeVarInt(0n)
        }
      }
      w.writeVarInt(BigInt(obj.payloadLength))
      if (obj.payloadLength > 0) {
        w.writeBytes(obj.payload)
      }
    } else {
      if (flags & 0x08) {
        if (first) w.writeVarInt(obj.groupId)
        else w.writeVarInt(obj.groupId - prevGroupId - 1n)
      }
      const subgroupEncoding = flags & 0x03
      if (subgroupEncoding === 0x03) w.writeVarInt(obj.subgroupId)
      if (flags & 0x04) w.writeVarInt(objectIdDeltaFor(flags, obj.objectId, prevObjectId))
      if (flags & 0x10) w.writeUint8(obj.publisherPriority)
      if (flags & 0x20) {
        if (obj.objectProperties && Object.keys(obj.objectProperties).length > 0) {
          const tmpW = new BufferWriter(32)
          encodeObjectProperties(obj.objectProperties, tmpW)
          const raw = tmpW.finish()
          w.writeVarInt(BigInt(raw.byteLength))
          w.writeBytes(raw)
        } else {
          w.writeVarInt(0n)
        }
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
 * The value to write into the Object ID Delta slot, per draft-20 Section
 * 11.4.4.1: "When the Group ID Delta field is present, the Object ID is the
 * value of Object ID Delta if present. When the Group ID Delta field is not
 * present, the Object ID is the prior Object's ID plus the Object ID Delta if
 * present."
 *
 * So the field is absolute alongside a Group ID Delta and relative without
 * one — and the relative form adds no 1, unlike the Group ID Delta and unlike
 * the subgroup-stream Object ID Delta.
 */
function objectIdDeltaFor(flags: number, objectId: bigint, prevObjectId: bigint): bigint {
  return (flags & 0x08) !== 0 ? objectId : objectId - prevObjectId
}

/** The decode-side counterpart of {@link objectIdDeltaFor}. */
function resolveObjectId(groupIdPresent: boolean, delta: bigint, prevObjectId: bigint): bigint {
  return groupIdPresent ? delta : prevObjectId + delta
}

/**
 * Resolve a Group ID Delta, per draft-20 Section 11.4.4.1.
 *
 * The first Object's delta IS the absolute Group ID. On any later Object,
 * "the Group ID is the prior Object's Group ID plus the Group ID Delta + 1"
 * for Ascending group order. Descending order subtracts `delta + 1` instead —
 * but Group Order is a subscription/fetch parameter carried on the control
 * stream, and this decoder sees only the data stream, so Ascending is assumed.
 * A caller that knows the negotiated order and needs Descending has to
 * recompute from the `groupIdDelta` this decoder preserves on each object.
 */
function resolveGroupId(
  first: boolean,
  delta: bigint,
  prevGroupId: bigint,
  offset: number,
): bigint {
  const groupId = first ? delta : prevGroupId + delta + 1n
  if (groupId > MAX_U64) {
    throw new DecodeError('CONSTRAINT_VIOLATION', 'computed Group ID exceeds 2^64 - 1', offset)
  }
  return groupId
}

export function decodeSubgroupStream(bytes: Uint8Array): DecodeResult<SubgroupStream> {
  try {
    const r = new BufferReader(bytes)
    // DECISION (DECISIONS.md D5): permissive on receive. The Type Flags are a
    // vi64 and Section 1.4.1 allows non-minimal encodings, so 0x10 may legally
    // arrive as the two-byte 0x8010. Read the value, then judge the value.
    const typeFlags = r.readVarInt()
    const flagsError = subgroupTypeFlagsError(typeFlags)
    if (flagsError !== null) {
      return { ok: false, error: new DecodeError('CONSTRAINT_VIOLATION', flagsError, 0) }
    }
    const streamType = Number(typeFlags)

    const propertiesPresent = (streamType & 0x01) !== 0
    const subgroupMode = (streamType & 0x06) >> 1
    const hasSubgroupField = subgroupMode === 0x02
    const subgroupIsFirstObjId = subgroupMode === 0x01
    const endOfGroup = (streamType & 0x08) !== 0
    const hasPriority = (streamType & 0x20) === 0
    const firstObject = (streamType & 0x40) !== 0

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

    const objects: ObjectPayload[] = []
    let prevObjectId = -1n
    let isFirst = true

    while (r.remaining > 0) {
      const byteOffset = r.offset
      const delta = r.readVarInt()
      let objectId: bigint
      if (isFirst) {
        objectId = delta
        if (subgroupIsFirstObjId) {
          subgroupId = objectId
        }
        isFirst = false
      } else {
        // Section 11.4.2 delta encoding: prior + delta + 1.
        objectId = prevObjectId + 1n + delta
      }
      const extensionData = new Uint8Array(0)
      let objectProperties: Record<string, bigint> | undefined
      if (propertiesPresent) {
        const propsLen = Number(r.readVarInt())
        if (propsLen > 0) {
          objectProperties = decodeObjectProperties(r, propsLen)
        }
      }
      const payloadLength = Number(r.readVarInt())
      let payload: Uint8Array
      let status: bigint | undefined
      let payloadByteOffset: number
      if (payloadLength === 0) {
        status = r.readVarInt()
        payloadByteOffset = r.offset
        payload = new Uint8Array(0)
      } else {
        payloadByteOffset = r.offset
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
      if (objectProperties !== undefined)
        (obj as unknown as Record<string, unknown>).objectProperties = objectProperties
      objects.push(obj)
      prevObjectId = objectId
    }

    const result: SubgroupStream = {
      type: 'subgroup',
      headerType: streamType,
      trackAlias,
      groupId,
      subgroupId,
      publisherPriority,
      objects,
    }
    if (endOfGroup) (result as unknown as Record<string, unknown>).endOfGroup = true
    if (firstObject) (result as unknown as Record<string, unknown>).firstObject = true

    return {
      ok: true,
      value: result,
      bytesRead: r.offset,
    }
  } catch (e) {
    if (e instanceof DecodeError) return { ok: false, error: e }
    throw e
  }
}

export function decodeDatagram(bytes: Uint8Array): DecodeResult<DatagramObject> {
  try {
    const r = new BufferReader(bytes)
    // D5: permissive on receive — the Type Flags are a vi64 (see
    // decodeSubgroupStream).
    const typeFlags = r.readVarInt()
    const flagsError = datagramTypeFlagsError(typeFlags)
    if (flagsError !== null) {
      return { ok: false, error: new DecodeError('CONSTRAINT_VIOLATION', flagsError, 0) }
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

    let objectProperties: Record<string, bigint> | undefined
    if (propertiesPresent) {
      const propsLen = Number(r.readVarInt())
      if (propsLen === 0) {
        // Section 11.3.1: "If an endpoint receives a datagram with the
        // PROPERTIES bit set and an Properties Length of 0, it MUST close the
        // session with a PROTOCOL_VIOLATION." A subgroup stream is the
        // opposite: there a zero-length Properties field is normal.
        return {
          ok: false,
          error: new DecodeError(
            'CONSTRAINT_VIOLATION',
            'a datagram with the PROPERTIES bit set must carry a non-empty Properties structure',
            r.offset,
          ),
        }
      }
      objectProperties = decodeObjectProperties(r, propsLen)
    }

    let objectStatus: bigint | undefined
    let payload: Uint8Array
    if (isStatus) {
      objectStatus = r.readVarInt()
      if (propertiesPresent && objectStatus !== OBJECT_STATUS_NORMAL) {
        // Section 11.3.1: STATUS and PROPERTIES both set with a status other
        // than Normal is a PROTOCOL_VIOLATION, "because only Normal Objects
        // can have Properties".
        return {
          ok: false,
          error: new DecodeError(
            'CONSTRAINT_VIOLATION',
            `only a Normal (0x0) Object may carry Properties, got status 0x${objectStatus.toString(16)}`,
            r.offset,
          ),
        }
      }
      if (r.remaining > 0) {
        // The STATUS bit says the Object Status occupies the position an
        // Object Payload would have, so trailing bytes are not a payload this
        // frame can hold.
        return {
          ok: false,
          error: new DecodeError(
            'CONSTRAINT_VIOLATION',
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
    if (objectProperties !== undefined)
      (result as unknown as Record<string, unknown>).objectProperties = objectProperties

    return { ok: true, value: result, bytesRead: r.offset }
  } catch (e) {
    if (e instanceof DecodeError) return { ok: false, error: e }
    throw e
  }
}

export function decodeFetchStream(bytes: Uint8Array): DecodeResult<FetchStream> {
  try {
    const r = new BufferReader(bytes)
    const streamType = r.readVarInt()
    if (streamType !== FETCH_STREAM_TYPE) {
      return {
        ok: false,
        error: new DecodeError(
          'CONSTRAINT_VIOLATION',
          `Expected fetch stream type 0x05, got 0x${streamType.toString(16)}`,
          0,
        ),
      }
    }
    // Section 11.4.4: "all objects on the stream belong to the track requested
    // in the message identified by Request ID" — "the message", not "the FETCH
    // message", because a fill fetch stream (Section 5.1.3) names a SUBSCRIBE
    // or a REQUEST_UPDATE here.
    const requestId = r.readVarInt()
    const objects: FetchObjectPayload[] = []

    let prevGroupId = 0n
    let prevSubgroupId = 0n
    let prevObjectId = 0n
    let prevPriority = 128
    let first = true

    while (r.remaining > 0) {
      const byteOffset = r.offset
      const flags = Number(r.readVarInt())

      let groupId = prevGroupId
      let subgroupId = prevSubgroupId
      // Section 11.4.4.1: absent an Object ID Delta, Object ID is the prior
      // Object's ID plus one. Stream delta encoding, not a range end.
      let objectId = prevObjectId + 1n
      let payloadLength: number
      let payload: Uint8Array
      let payloadByteOffset: number
      const extensionData = new Uint8Array(0)

      if (flags >= 0x80) {
        // End-of-Range marker. Section 11.4.4: "Any other value is a
        // PROTOCOL_VIOLATION."
        if (!FETCH_END_OF_RANGE_MARKERS.has(flags)) {
          return {
            ok: false,
            error: new DecodeError(
              'CONSTRAINT_VIOLATION',
              `0x${flags.toString(16)} is neither a flag combination below 128 nor one of the three End of Range markers`,
              r.offset,
            ),
          }
        }
        // D7 / Q16: ordinary delta arithmetic (see encodeFetchStream).
        const groupDelta = r.readVarInt()
        groupId = resolveGroupId(first, groupDelta, prevGroupId, r.offset)
        // With a Group ID Delta present, Object ID is the Object ID Delta.
        const objectDelta = r.readVarInt()
        objectId = objectDelta
        // D7 / Q17: Object Payload Length is present, encoded as 0.
        payloadLength = Number(r.readVarInt())
        payloadByteOffset = r.offset
        payload = payloadLength > 0 ? r.readBytesView(payloadLength) : new Uint8Array(0)

        const marker: FetchObjectPayload = {
          type: 'object',
          byteOffset,
          payloadByteOffset,
          serializationFlags: flags,
          groupId,
          groupIdDelta: groupDelta,
          // A marker has no Subgroup ID or Priority of its own — Section
          // 11.4.4.2 says neither field is present. The interface requires
          // both, so they carry the last actual Object's values, which is also
          // what a following Object that references "the prior Object" gets.
          subgroupId: prevSubgroupId,
          objectId,
          objectIdDelta: objectDelta,
          publisherPriority: prevPriority,
          payloadLength,
          payload,
          extensionData,
        }
        objects.push(marker)

        // Section 11.4.4.2: prior Group ID and prior Object ID come FROM the
        // marker; prior Subgroup ID and prior Priority stay with the last
        // actual Object before it, so they are deliberately not updated here.
        prevGroupId = groupId
        prevObjectId = objectId
        first = false
        continue
      }

      if (flags & 0x40) {
        // DATAGRAM mode: no subgroup_id field
        const objectIdPresent = (flags & 0x04) !== 0
        const groupIdPresent = (flags & 0x08) !== 0
        const priorityPresent = (flags & 0x10) !== 0
        const propsPresent = (flags & 0x20) !== 0

        let groupDelta: bigint | undefined
        if (groupIdPresent) {
          // First object's delta IS the absolute group id; subsequent objects:
          // groupId = prevGroupId + delta + 1 (ascending).
          groupDelta = r.readVarInt()
          groupId = resolveGroupId(first, groupDelta, prevGroupId, r.offset)
        }
        let objectDelta: bigint | undefined
        if (objectIdPresent) {
          objectDelta = r.readVarInt()
          objectId = resolveObjectId(groupIdPresent, objectDelta, prevObjectId)
        }
        if (objectId > MAX_U64) {
          return {
            ok: false,
            error: new DecodeError(
              'CONSTRAINT_VIOLATION',
              'computed Object ID exceeds 2^64 - 1',
              r.offset,
            ),
          }
        }
        if (priorityPresent) {
          prevPriority = r.readUint8()
        }
        let objectProperties: Record<string, bigint> | undefined
        if (propsPresent) {
          const propsLen = Number(r.readVarInt())
          if (propsLen > 0) {
            objectProperties = decodeObjectProperties(r, propsLen)
          }
        }
        payloadLength = Number(r.readVarInt())
        payloadByteOffset = r.offset
        payload = payloadLength > 0 ? r.readBytesView(payloadLength) : new Uint8Array(0)

        const obj: FetchObjectPayload = {
          type: 'object',
          byteOffset,
          payloadByteOffset,
          serializationFlags: flags,
          groupId,
          subgroupId: 0n,
          objectId,
          publisherPriority: prevPriority,
          payloadLength,
          payload,
          extensionData,
        }
        if (groupDelta !== undefined)
          (obj as unknown as Record<string, unknown>).groupIdDelta = groupDelta
        if (objectDelta !== undefined)
          (obj as unknown as Record<string, unknown>).objectIdDelta = objectDelta
        if (objectProperties)
          (obj as unknown as Record<string, unknown>).objectProperties = objectProperties
        objects.push(obj)

        prevGroupId = groupId
        prevObjectId = objectId
        first = false
        continue
      }

      const subgroupEncoding = flags & 0x03
      const objectIdPresent = (flags & 0x04) !== 0
      const groupIdPresent = (flags & 0x08) !== 0
      const priorityPresent = (flags & 0x10) !== 0
      const propsPresent = (flags & 0x20) !== 0

      let groupDelta: bigint | undefined
      if (groupIdPresent) {
        groupDelta = r.readVarInt()
        groupId = resolveGroupId(first, groupDelta, prevGroupId, r.offset)
      } else if (first) {
        return {
          ok: false,
          error: new DecodeError(
            'CONSTRAINT_VIOLATION',
            'First fetch object must include groupId',
            r.offset,
          ),
        }
      }

      if (subgroupEncoding === 0x00) {
        subgroupId = 0n
      } else if (subgroupEncoding === 0x01 || subgroupEncoding === 0x02) {
        if (first) {
          return {
            ok: false,
            error: new DecodeError(
              'CONSTRAINT_VIOLATION',
              'First fetch object cannot reference prior subgroupId',
              r.offset,
            ),
          }
        }
        subgroupId = subgroupEncoding === 0x01 ? prevSubgroupId : prevSubgroupId + 1n
      } else {
        subgroupId = r.readVarInt()
      }

      let objectDelta: bigint | undefined
      if (objectIdPresent) {
        objectDelta = r.readVarInt()
        objectId = resolveObjectId(groupIdPresent, objectDelta, prevObjectId)
      } else if (first) {
        return {
          ok: false,
          error: new DecodeError(
            'CONSTRAINT_VIOLATION',
            'First fetch object must include objectId',
            r.offset,
          ),
        }
      }
      if (objectId > MAX_U64) {
        return {
          ok: false,
          error: new DecodeError(
            'CONSTRAINT_VIOLATION',
            'computed Object ID exceeds 2^64 - 1',
            r.offset,
          ),
        }
      }

      if (priorityPresent) {
        prevPriority = r.readUint8()
      }

      let objectProperties: Record<string, bigint> | undefined
      if (propsPresent) {
        const propsLen = Number(r.readVarInt())
        if (propsLen > 0) {
          objectProperties = decodeObjectProperties(r, propsLen)
        }
      }

      payloadLength = Number(r.readVarInt())
      payloadByteOffset = r.offset
      payload = payloadLength > 0 ? r.readBytesView(payloadLength) : new Uint8Array(0)

      // A fetch stream carries no Object Status: status is only present on
      // subscription-delivered objects (Section 11.2.1.1). That is also the
      // one way the two copies of a doubly delivered object differ — the
      // subscription copy can carry a status, the fill copy cannot.
      const obj: FetchObjectPayload = {
        type: 'object',
        byteOffset,
        payloadByteOffset,
        serializationFlags: flags,
        groupId,
        subgroupId,
        objectId,
        publisherPriority: prevPriority,
        payloadLength,
        payload,
        extensionData,
      }
      if (groupDelta !== undefined)
        (obj as unknown as Record<string, unknown>).groupIdDelta = groupDelta
      if (objectDelta !== undefined)
        (obj as unknown as Record<string, unknown>).objectIdDelta = objectDelta
      if (objectProperties)
        (obj as unknown as Record<string, unknown>).objectProperties = objectProperties
      objects.push(obj)

      prevGroupId = groupId
      prevSubgroupId = subgroupId
      prevObjectId = objectId
      first = false
    }

    return {
      ok: true,
      value: { type: 'fetch', requestId, objects },
      bytesRead: r.offset,
    }
  } catch (e) {
    if (e instanceof DecodeError) return { ok: false, error: e }
    throw e
  }
}

export function decodeDataStream(
  streamType: 'subgroup' | 'datagram' | 'fetch',
  bytes: Uint8Array,
): DecodeResult<Draft20DataStream> {
  switch (streamType) {
    case 'subgroup':
      return decodeSubgroupStream(bytes)
    case 'datagram':
      return decodeDatagram(bytes)
    case 'fetch':
      return decodeFetchStream(bytes)
    default: {
      const _exhaustive: never = streamType
      throw new Error(`Unknown stream type: ${_exhaustive}`)
    }
  }
}

// ─── Data Stream Decoders ──────────────────────────────────────────────────────

export function createSubgroupStreamDecoder(): TransformStream<
  Uint8Array,
  SubgroupStreamHeader | ObjectPayload
> {
  let buffer = new Uint8Array(0)
  let offset = 0
  let headerEmitted = false
  let prevObjectId = -1n
  let firstObject = true
  let _propertiesPresent = false

  return new TransformStream<Uint8Array, SubgroupStreamHeader | ObjectPayload>({
    transform(chunk, controller) {
      if (offset > 0) {
        buffer = buffer.subarray(offset)
        offset = 0
      }
      const newBuffer = new Uint8Array(buffer.length + chunk.length)
      newBuffer.set(buffer, 0)
      newBuffer.set(chunk, buffer.length)
      buffer = newBuffer

      if (!headerEmitted) {
        try {
          const r = new BufferReader(buffer.subarray(offset))
          const typeFlags = r.readVarInt()
          const flagsError = subgroupTypeFlagsError(typeFlags)
          if (flagsError !== null) {
            controller.error(new DecodeError('CONSTRAINT_VIOLATION', flagsError, 0))
            return
          }
          const streamType = Number(typeFlags)

          _propertiesPresent = (streamType & 0x01) !== 0
          const subgroupMode = (streamType & 0x06) >> 1
          const hasSubgroupField = subgroupMode === 0x02
          const hasPriority = (streamType & 0x20) === 0

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

          controller.enqueue({
            type: 'subgroup_header',
            trackAlias,
            groupId,
            subgroupId,
            publisherPriority,
          })
          headerEmitted = true
          offset += r.offset
        } catch (e) {
          if (e instanceof DecodeError && e.code === 'UNEXPECTED_END') {
            return
          }
          controller.error(e)
          return
        }
      }

      while (offset < buffer.length) {
        try {
          const r = new BufferReader(buffer.subarray(offset))
          const delta = r.readVarInt()
          let objectId: bigint
          if (firstObject) {
            objectId = delta
            firstObject = false
          } else {
            objectId = prevObjectId + 1n + delta
          }
          let extensionData = new Uint8Array(0)
          if (_propertiesPresent) {
            const extLen = Number(r.readVarInt())
            extensionData = extLen > 0 ? r.readBytesView(extLen) : new Uint8Array(0)
          }
          const payloadLength = Number(r.readVarInt())
          const payloadByteOffset = r.offset
          const payload = payloadLength > 0 ? r.readBytesView(payloadLength) : new Uint8Array(0)
          controller.enqueue({
            type: 'object',
            objectId,
            objectIdDelta: delta,
            payloadLength,
            payload,
            extensionData,
            byteOffset: 0,
            payloadByteOffset,
          })
          offset += r.offset
          prevObjectId = objectId
        } catch (e) {
          if (e instanceof DecodeError && e.code === 'UNEXPECTED_END') {
            break
          }
          controller.error(e)
          return
        }
      }
    },

    flush(controller) {
      if (offset < buffer.length) {
        controller.error(new DecodeError('UNEXPECTED_END', 'Stream ended with incomplete data', 0))
      }
    },
  })
}

export function createFetchStreamDecoder(): TransformStream<
  Uint8Array,
  FetchStreamHeader | ObjectPayload
> {
  let buffer = new Uint8Array(0)
  let offset = 0
  let headerEmitted = false

  return new TransformStream<Uint8Array, FetchStreamHeader | ObjectPayload>({
    transform(chunk, controller) {
      if (offset > 0) {
        buffer = buffer.subarray(offset)
        offset = 0
      }
      const newBuffer = new Uint8Array(buffer.length + chunk.length)
      newBuffer.set(buffer, 0)
      newBuffer.set(chunk, buffer.length)
      buffer = newBuffer

      if (!headerEmitted) {
        try {
          const r = new BufferReader(buffer.subarray(offset))
          const streamType = r.readVarInt()
          if (streamType !== FETCH_STREAM_TYPE) {
            controller.error(
              new DecodeError(
                'CONSTRAINT_VIOLATION',
                `Expected fetch stream type 0x05, got 0x${streamType.toString(16)}`,
                0,
              ),
            )
            return
          }
          const requestId = r.readVarInt()
          controller.enqueue({ type: 'fetch_header', requestId })
          headerEmitted = true
          offset += r.offset
        } catch (e) {
          if (e instanceof DecodeError && e.code === 'UNEXPECTED_END') {
            return
          }
          controller.error(e)
          return
        }
      }

      while (offset < buffer.length) {
        try {
          const r = new BufferReader(buffer.subarray(offset))
          const flags = Number(r.readVarInt())

          if (flags >= 0x80) {
            if (!FETCH_END_OF_RANGE_MARKERS.has(flags)) {
              controller.error(
                new DecodeError(
                  'CONSTRAINT_VIOLATION',
                  `0x${flags.toString(16)} is neither a flag combination below 128 nor one of the three End of Range markers`,
                  0,
                ),
              )
              return
            }
            r.readVarInt() // Group ID Delta
            const objectDelta = r.readVarInt()
            const markerPayloadLength = Number(r.readVarInt())
            const markerPayloadByteOffset = r.offset
            controller.enqueue({
              type: 'object',
              objectId: objectDelta,
              objectIdDelta: objectDelta,
              payloadLength: markerPayloadLength,
              payload: new Uint8Array(0),
              extensionData: new Uint8Array(0),
              byteOffset: 0,
              payloadByteOffset: markerPayloadByteOffset,
            })
            offset += r.offset
            continue
          }

          const objectIdPresent = (flags & 0x04) !== 0
          const groupIdPresent = (flags & 0x08) !== 0
          const priorityPresent = (flags & 0x10) !== 0
          const extensionsPresent = (flags & 0x20) !== 0
          const subgroupEncoding = flags & 0x03
          const datagramMode = (flags & 0x40) !== 0

          if (groupIdPresent) r.readVarInt()
          if (!datagramMode && subgroupEncoding === 0x03) r.readVarInt()
          let objectId = 0n
          let objectIdDelta: bigint | undefined
          if (objectIdPresent) {
            objectIdDelta = r.readVarInt()
            objectId = objectIdDelta
          }
          if (priorityPresent) r.readUint8()
          let extensionData = new Uint8Array(0)
          if (extensionsPresent) {
            const extLen = Number(r.readVarInt())
            extensionData = extLen > 0 ? r.readBytesView(extLen) : new Uint8Array(0)
          }
          const payloadLength = Number(r.readVarInt())
          const payloadByteOffset = r.offset
          const payload = payloadLength > 0 ? r.readBytesView(payloadLength) : new Uint8Array(0)
          const event: ObjectPayload = {
            type: 'object',
            objectId,
            payloadLength,
            payload,
            extensionData,
            byteOffset: 0,
            payloadByteOffset,
          }
          if (objectIdDelta !== undefined)
            (event as unknown as Record<string, unknown>).objectIdDelta = objectIdDelta
          controller.enqueue(event)
          offset += r.offset
        } catch (e) {
          if (e instanceof DecodeError && e.code === 'UNEXPECTED_END') {
            break
          }
          controller.error(e)
          return
        }
      }
    },

    flush(controller) {
      if (offset < buffer.length) {
        controller.error(new DecodeError('UNEXPECTED_END', 'Stream ended with incomplete data', 0))
      }
    },
  })
}

export function createDataStreamDecoder(): TransformStream<Uint8Array, DataStreamEvent> {
  let buffer = new Uint8Array(0)
  let offset = 0
  let inner: TransformStream<Uint8Array, DataStreamEvent> | null = null

  return new TransformStream<Uint8Array, DataStreamEvent>({
    transform(chunk, controller) {
      if (offset > 0) {
        buffer = buffer.subarray(offset)
        offset = 0
      }
      const newBuffer = new Uint8Array(buffer.length + chunk.length)
      newBuffer.set(buffer, 0)
      newBuffer.set(chunk, buffer.length)
      buffer = newBuffer

      if (inner === null) {
        if (offset >= buffer.length) return
        const firstByte = buffer[offset]!

        if (isValidSubgroupType(firstByte)) {
          const decoder = createSubgroupStreamDecoder()
          inner = decoder as unknown as TransformStream<Uint8Array, DataStreamEvent>
        } else if (firstByte === 0x05) {
          const decoder = createFetchStreamDecoder()
          inner = decoder as unknown as TransformStream<Uint8Array, DataStreamEvent>
        } else {
          controller.error(
            new DecodeError(
              'CONSTRAINT_VIOLATION',
              `Unknown data stream type: 0x${firstByte.toString(16)}`,
              0,
            ),
          )
          return
        }
      }
    },

    flush(controller) {
      if (offset >= buffer.length) return
      const view = buffer.subarray(offset)

      const firstByte = view[0]!
      let result: DecodeResult<Draft20DataStream>

      if (isValidSubgroupType(firstByte)) {
        result = decodeSubgroupStream(view)
      } else if (firstByte === 0x05) {
        result = decodeFetchStream(view)
      } else {
        controller.error(
          new DecodeError(
            'CONSTRAINT_VIOLATION',
            `Unknown data stream type: 0x${firstByte.toString(16)}`,
            0,
          ),
        )
        return
      }

      if (!result.ok) {
        controller.error(result.error)
        return
      }

      const stream = result.value
      if (stream.type === 'subgroup') {
        controller.enqueue({
          type: 'subgroup_header',
          trackAlias: stream.trackAlias,
          groupId: stream.groupId,
          subgroupId: stream.subgroupId,
          publisherPriority: stream.publisherPriority,
        })
        for (const obj of stream.objects) {
          controller.enqueue(obj)
        }
      } else if (stream.type === 'fetch') {
        controller.enqueue({
          type: 'fetch_header',
          requestId: stream.requestId,
        })
        for (const obj of stream.objects) {
          controller.enqueue(obj)
        }
      }
    },
  })
}
