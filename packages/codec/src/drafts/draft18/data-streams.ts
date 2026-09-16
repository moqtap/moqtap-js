import { MoqtBufferReader as BufferReader } from '../../core/buffer-reader.js'
import { MoqtBufferWriter as BufferWriter } from '../../core/buffer-writer.js'
import type { DecodeResult } from '../../core/types.js'
import { DecodeError } from '../../core/types.js'
import type {
  DatagramObject,
  DataStreamEvent,
  Draft18DataStream,
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

// Subgroup stream type validation per draft-18 §11.4.2:
// Type matches 0b0XX1XXXX (i.e. 0x10..0x1F / 0x30..0x3F / 0x50..0x5F / 0x70..0x7F)
// with SUBGROUP_ID_MODE (bits 1-2) != 0b11.
function isValidSubgroupType(streamType: number): boolean {
  const inRange =
    (streamType >= 0x10 && streamType <= 0x1f) ||
    (streamType >= 0x30 && streamType <= 0x3f) ||
    (streamType >= 0x50 && streamType <= 0x5f) ||
    (streamType >= 0x70 && streamType <= 0x7f)
  if (!inRange) return false
  // SUBGROUP_ID_MODE = 0b11 (mask 0x06 == 0x06) is reserved
  return (streamType & 0x06) !== 0x06
}

export function encodeSubgroupStream(stream: SubgroupStream): Uint8Array {
  const w = new BufferWriter()
  const streamType = stream.headerType
  // SUBGROUP_HEADER stream type is a single byte in draft-18 to allow types up to 0x7D.
  w.writeUint8(streamType)

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
        w.writeVarInt(0n)
      }
    }
    w.writeVarInt(BigInt(obj.payloadLength))
    if (obj.payloadLength === 0) {
      w.writeVarInt(obj.status ?? 0n)
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
  // OBJECT_DATAGRAM type is a single byte in draft-18.
  w.writeUint8(dgType)
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
      w.writeVarInt(0n)
    }
  }

  if (isStatus) {
    w.writeVarInt(dg.objectStatus ?? 0n)
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
      // End of Range (0x8C, 0x10C): Group ID, Object ID, PayloadLength=0
      w.writeVarInt(obj.groupId)
      w.writeVarInt(obj.objectId)
      w.writeVarInt(BigInt(obj.payloadLength))
    } else if (flags & 0x40) {
      // DATAGRAM mode: no subgroup_id field
      if (flags & 0x08) {
        // First object encodes absolute group; subsequent encode delta (ascending: delta+1)
        if (first) w.writeVarInt(obj.groupId)
        else w.writeVarInt(obj.groupId - prevGroupId - 1n)
      }
      if (flags & 0x04) w.writeVarInt(obj.objectId)
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
      if (flags & 0x04) w.writeVarInt(obj.objectId)
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
  // suppress unused-warning: prevObjectId is updated for clarity / future use
  void prevObjectId
  return w.finish()
}

/**
 * The SUBGROUP_HEADER fields, read once for both decoders.
 *
 * `decodeSubgroupStream` and `createSubgroupStreamDecoder` used to parse this
 * header separately and they drifted: the incremental one dropped the header
 * flags, reported no Type Flags, and left the Subgroup ID at zero under the
 * mode that derives it from the first Object. One reader means there is
 * nothing left to keep in sync.
 */
interface SubgroupHeaderFields {
  readonly streamType: number
  readonly propertiesPresent: boolean
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
  const streamType = r.readUint8()
  if (!isValidSubgroupType(streamType)) {
    throw new DecodeError(
      'CONSTRAINT_VIOLATION',
      `Invalid subgroup stream type 0x${streamType.toString(16)}`,
      0,
    )
  }

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
 * One Object off a subgroup stream, for both decoders.
 *
 * `base` is the absolute offset within the stream that `r.offset === 0`
 * corresponds to. The one-shot decoder reads from a reader spanning the whole
 * stream and passes 0; the incremental decoder reads from a window over its
 * own buffer and passes that window's position. That is what makes
 * `byteOffset` mean the same thing on both paths, instead of being hardcoded
 * to zero on one of them.
 *
 * Throws `UNEXPECTED_END` when the Object is not yet complete, which the
 * incremental decoder reads as "wait for more bytes" rather than as an error.
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
    // The Object Status field is sent only when the Payload Length is zero.
    // Skipping it leaves the varint to be read as the next Object's Object ID
    // Delta, which desynchronises the rest of the stream silently.
    status = r.readVarInt()
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
    payloadLength,
    payload,
    extensionData,
  }
  if (status !== undefined) (obj as unknown as Record<string, unknown>).status = status
  if (objectProperties !== undefined)
    (obj as unknown as Record<string, unknown>).objectProperties = objectProperties
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
    const dgType = r.readUint8()

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
      if (propsLen > 0) {
        objectProperties = decodeObjectProperties(r, propsLen)
      }
    }

    let objectStatus: bigint | undefined
    let payload: Uint8Array
    if (isStatus) {
      objectStatus = r.readVarInt()
      payload = new Uint8Array(0)
    } else {
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

/** The delta state a fetch stream carries from one Object to the next. */
interface FetchObjectState {
  prevGroupId: bigint
  prevSubgroupId: bigint
  prevObjectId: bigint
  prevPriority: number
  first: boolean
}

function newFetchObjectState(): FetchObjectState {
  return { prevGroupId: 0n, prevSubgroupId: 0n, prevObjectId: 0n, prevPriority: 128, first: true }
}

/**
 * One Object off a fetch stream, for both decoders.
 *
 * Lifted out of `decodeFetchStream` unchanged so the incremental decoder
 * cannot report a different shape for the same bytes. It used to return a
 * bare ObjectPayload -- no Serialization Flags, no Group or Subgroup ID, no
 * Priority, no deltas -- with every `byteOffset` zero, and in DATAGRAM mode
 * it resolved the Object ID against state it never carried.
 *
 * `base` is the absolute offset that `r.offset === 0` corresponds to: 0 for
 * the one-shot decoder, the buffer window's position for the incremental one.
 */
function readFetchObject(r: BufferReader, base: number, st: FetchObjectState): FetchObjectPayload {
  const byteOffset = base + r.offset
  const flags = Number(r.readVarInt())

  let groupId = st.prevGroupId
  let subgroupId = st.prevSubgroupId
  let objectId = st.prevObjectId + 1n
  let payloadLength: number
  let payload: Uint8Array
  let payloadByteOffset: number
  const extensionData = new Uint8Array(0)

  if (flags >= 0x80) {
    // End of Range: 0x8C = End of Non-Existent Range, 0x10C = End of Unknown Range
    if (flags !== 0x8c && flags !== 0x10c) {
      throw new DecodeError(
        'CONSTRAINT_VIOLATION',
        `Unknown serialization flags value: 0x${flags.toString(16)}`,
        r.offset,
      )
    }
    groupId = r.readVarInt()
    objectId = r.readVarInt()
    payloadLength = Number(r.readVarInt())
    payloadByteOffset = base + r.offset
    payload = payloadLength > 0 ? r.readBytesView(payloadLength) : new Uint8Array(0)
  } else if (flags & 0x40) {
    // DATAGRAM mode: no subgroup_id field
    const objectIdPresent = (flags & 0x04) !== 0
    const groupIdPresent = (flags & 0x08) !== 0
    const priorityPresent = (flags & 0x10) !== 0
    const propsPresent = (flags & 0x20) !== 0

    if (groupIdPresent) {
      // First object's delta IS the absolute group id;
      // subsequent objects: groupId = st.prevGroupId + delta + 1 (ascending)
      const groupDelta = r.readVarInt()
      groupId = st.first ? groupDelta : st.prevGroupId + groupDelta + 1n
    }
    if (objectIdPresent) {
      objectId = r.readVarInt()
    }
    if (priorityPresent) {
      st.prevPriority = r.readUint8()
    }
    let objectProperties: Record<string, bigint> | undefined
    if (propsPresent) {
      const propsLen = Number(r.readVarInt())
      if (propsLen > 0) {
        objectProperties = decodeObjectProperties(r, propsLen)
      }
    }
    payloadLength = Number(r.readVarInt())
    payloadByteOffset = base + r.offset
    payload = payloadLength > 0 ? r.readBytesView(payloadLength) : new Uint8Array(0)

    const obj: FetchObjectPayload = {
      type: 'object',
      byteOffset,
      payloadByteOffset,
      serializationFlags: flags,
      groupId,
      subgroupId: 0n,
      objectId,
      publisherPriority: st.prevPriority,
      payloadLength,
      payload,
      extensionData,
    }
    if (objectProperties)
      (obj as unknown as Record<string, unknown>).objectProperties = objectProperties

    st.prevGroupId = groupId
    st.prevObjectId = objectId
    st.first = false
    return obj
  } else {
    const subgroupEncoding = flags & 0x03
    const objectIdPresent = (flags & 0x04) !== 0
    const groupIdPresent = (flags & 0x08) !== 0
    const priorityPresent = (flags & 0x10) !== 0
    const propsPresent = (flags & 0x20) !== 0

    if (groupIdPresent) {
      const groupDelta = r.readVarInt()
      groupId = st.first ? groupDelta : st.prevGroupId + groupDelta + 1n
    } else if (st.first) {
      throw new DecodeError(
        'CONSTRAINT_VIOLATION',
        'First fetch object must include groupId',
        r.offset,
      )
    }

    if (subgroupEncoding === 0x00) {
      subgroupId = 0n
    } else if (subgroupEncoding === 0x01) {
      if (st.first) {
        throw new DecodeError(
          'CONSTRAINT_VIOLATION',
          'First fetch object cannot reference prior subgroupId',
          r.offset,
        )
      }
      subgroupId = st.prevSubgroupId
    } else if (subgroupEncoding === 0x02) {
      if (st.first) {
        throw new DecodeError(
          'CONSTRAINT_VIOLATION',
          'First fetch object cannot reference prior subgroupId',
          r.offset,
        )
      }
      subgroupId = st.prevSubgroupId + 1n
    } else if (subgroupEncoding === 0x03) {
      subgroupId = r.readVarInt()
    }

    if (objectIdPresent) {
      objectId = r.readVarInt()
    } else if (st.first) {
      throw new DecodeError(
        'CONSTRAINT_VIOLATION',
        'First fetch object must include objectId',
        r.offset,
      )
    }

    if (priorityPresent) {
      st.prevPriority = r.readUint8()
    }

    let objectProperties: Record<string, bigint> | undefined
    if (propsPresent) {
      const propsLen = Number(r.readVarInt())
      if (propsLen > 0) {
        objectProperties = decodeObjectProperties(r, propsLen)
      }
    }

    payloadLength = Number(r.readVarInt())
    payloadByteOffset = base + r.offset
    payload = payloadLength > 0 ? r.readBytesView(payloadLength) : new Uint8Array(0)

    if (objectProperties) {
      const obj: FetchObjectPayload = {
        type: 'object',
        byteOffset,
        payloadByteOffset,
        serializationFlags: flags,
        groupId,
        subgroupId,
        objectId,
        publisherPriority: st.prevPriority,
        payloadLength,
        payload,
        extensionData,
      }
      ;(obj as unknown as Record<string, unknown>).objectProperties = objectProperties
      st.prevGroupId = groupId
      st.prevSubgroupId = subgroupId
      st.prevObjectId = objectId
      st.first = false
      return obj
    }
  }

  const obj: FetchObjectPayload = {
    type: 'object',
    byteOffset,
    payloadByteOffset,
    serializationFlags: flags,
    groupId,
    subgroupId,
    objectId,
    publisherPriority: st.prevPriority,
    payloadLength,
    payload,
    extensionData,
  }

  st.prevGroupId = groupId
  st.prevSubgroupId = subgroupId
  st.prevObjectId = objectId
  st.first = false

  return obj
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
    const requestId = r.readVarInt()
    const objects: FetchObjectPayload[] = []

    const st = newFetchObjectState()

    while (r.remaining > 0) {
      objects.push(readFetchObject(r, 0, st))
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
): DecodeResult<Draft18DataStream> {
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

/**
 * A data stream's bytes, accumulated across chunks.
 *
 * The decoders below used to allocate an array of `unread + chunk.length` and
 * copy both halves into it on *every* chunk. Capacity now grows geometrically,
 * so most chunks are a single `set` into spare room.
 *
 * **It never compacts in place.** Object payloads are handed out as views into
 * this buffer (`readBytesView`), so moving bytes within it would corrupt an
 * object that has already been emitted. The consumed prefix is dropped only
 * when a fresh array is being allocated anyway, which leaves the old array
 * alive for exactly as long as the views into it are.
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
      // Grow until reclaiming the consumed prefix leaves the buffer at least
      // half free. Sizing to `needed` -- which is what this did first -- leaves
      // no room at all, so the next chunk reallocates too and the buffer
      // reallocates on every single chunk, which is the cost it exists to
      // avoid. Capacity never shrinks, so it settles at roughly twice the
      // largest `live + chunk` this stream has seen.
      let cap = Math.max(4096, this.buf.length)
      while (cap < needed * 2) cap *= 2
      // A fresh array every time, including when the capacity is unchanged:
      // the old one is still pinned by the payload views handed out of it, so
      // it can be neither compacted nor reused.
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

  /**
   * The written bytes, for a reader positioned at `offset`. Bounded by `len`
   * rather than by capacity, so `BufferReader.remaining` counts real bytes and
   * not the spare room after them.
   */
  written(): Uint8Array {
    return this.buf.subarray(0, this.len)
  }
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
      // One view and one reader per chunk. Both used to be allocated per
      // object, and an object is the thing there are a great many of.
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
        // Where the Subgroup ID is the first Object's ID, that Object has not
        // been read yet. Holding the header back until it has is the only way
        // to emit the value the one-shot decoder reports; every other mode
        // knows its Subgroup ID already.
        if (!header.subgroupIsFirstObjId) emitHeader(controller, header, header.subgroupId)
      }

      const h = header
      if (h === null) return

      const r = new BufferReader(view, b.offset)
      while (r.remaining > 0) {
        // Where this Object starts, so a partial one is re-read from the top
        // once the rest of it arrives.
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
      // A stream carrying a header and no Objects still has a header to report,
      // and its Subgroup ID is then zero -- the same value the one-shot decoder
      // returns when it finds no first Object to derive one from.
      if (header !== null && !headerEmitted) emitHeader(controller, header, 0n)
      if (b.unread > 0) {
        controller.error(new DecodeError('UNEXPECTED_END', 'Stream ended with incomplete data', 0))
      }
    },
  })
}

export function createFetchStreamDecoder(): TransformStream<
  Uint8Array,
  FetchStreamHeader | ObjectPayload
> {
  const b = new StreamBuffer()
  let headerEmitted = false
  /**
   * The delta state the Objects carry between them. This decoder used to keep
   * none, which is why DATAGRAM-mode Object IDs came out wrong: they resolve
   * against the previous Object's ID.
   */
  const st = newFetchObjectState()

  return new TransformStream<Uint8Array, FetchStreamHeader | ObjectPayload>({
    transform(chunk, controller) {
      b.append(chunk)
      const view = b.written()

      if (!headerEmitted) {
        try {
          const r = new BufferReader(view, b.offset)
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
      if (b.unread > 0) {
        controller.error(new DecodeError('UNEXPECTED_END', 'Stream ended with incomplete data', 0))
      }
    },
  })
}

export function createDataStreamDecoder(): TransformStream<Uint8Array, DataStreamEvent> {
  /**
   * Delegation that actually delegates.
   *
   * This function used to pick an inner decoder and then never write a byte to
   * it: chunks accumulated in a local buffer and `flush` decoded the whole
   * stream in one shot. Every event therefore arrived at end-of-stream, which
   * on a subscription that stays open means no events at all. The inner
   * decoder's readable is now pumped into this one's controller as the bytes
   * arrive.
   *
   * The first byte still decides which decoder to use, on exactly the range
   * this draft accepted before.
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
        // The inner decoder rejected the stream. It owns the diagnosis, so its
        // error is the one that surfaces.
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
      // Writing to an errored inner stream throws the same error the pump is
      // already reporting; swallow it here so it is reported once.
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
      // One byte is enough to choose, and until there is one there is nothing
      // to choose from.
      if (chunk.length === 0) return
      const firstByte = chunk[0]!

      if (isValidSubgroupType(firstByte)) {
        attach(
          createSubgroupStreamDecoder() as unknown as TransformStream<Uint8Array, DataStreamEvent>,
          controller,
        )
      } else if (firstByte === 0x05) {
        attach(
          createFetchStreamDecoder() as unknown as TransformStream<Uint8Array, DataStreamEvent>,
          controller,
        )
      } else {
        broken = true
        controller.error(
          new DecodeError(
            'CONSTRAINT_VIOLATION',
            `Unknown data stream type: 0x${firstByte.toString(16)}`,
            0,
          ),
        )
        return
      }

      // The type byte is part of the stream the inner decoder reads, so the
      // whole chunk goes in, first byte included.
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
