import { BufferReader } from '../../core/buffer-reader.js'
import { BufferWriter } from '../../core/buffer-writer.js'
import type { DecodeResult } from '../../core/types.js'
import { DecodeError } from '../../core/types.js'
import type {
  DatagramObject,
  DataStreamEvent,
  Draft14DataStream,
  FetchObjectPayload,
  FetchStream,
  FetchStreamHeader,
  ObjectPayload,
  SubgroupStream,
  SubgroupStreamHeader,
} from './types.js'

// ─── Data Stream Constants ────────────────────────────────────────────────────

const FETCH_STREAM_TYPE = 0x05n

// Valid subgroup stream types: 0x10-0x1D (12 types)
// Bit 0: extensions present
// Bit 1: subgroup-id mode (0=zero or first-object-id, with bit 2)
// Bit 2: subgroup-id field present (when set, explicit subgroup ID)
// Bit 3: end-of-group
function isValidSubgroupType(t: number): boolean {
  // 12 defined types: 0x10-0x15, 0x18-0x1D
  return (t >= 0x10 && t <= 0x15) || (t >= 0x18 && t <= 0x1d)
}

// ─── Data Stream Encoding/Decoding ─────────────────────────────────────────────

/**
 * Encode a subgroup stream header + objects.
 * Uses delta-encoded Object IDs per draft-14 §10.4.2.
 */
export function encodeSubgroupStream(stream: SubgroupStream): Uint8Array {
  const w = new BufferWriter()
  w.writeVarInt(BigInt(stream.headerType))
  w.writeVarInt(stream.trackAlias)
  w.writeVarInt(stream.groupId)

  const hasSubgroupField = (stream.headerType & 0x04) !== 0
  const extensionsPresent = (stream.headerType & 0x01) !== 0
  if (hasSubgroupField) {
    w.writeVarInt(stream.subgroupId)
  }
  w.writeUint8(stream.publisherPriority)

  let prevObjectId = -1n
  let first = true
  for (const obj of stream.objects) {
    // Delta encoding: first object delta IS the object ID,
    // subsequent deltas: objectId - prevObjectId - 1
    const delta = first ? obj.objectId : obj.objectId - prevObjectId - 1n
    w.writeVarInt(delta)
    first = false
    prevObjectId = obj.objectId

    // Extension headers
    if (extensionsPresent) {
      w.writeVarInt(BigInt(obj.extensionData.length))
      if (obj.extensionData.length > 0) w.writeBytes(obj.extensionData)
    }

    if (obj.payloadLength === 0) {
      w.writeVarInt(0)
      w.writeVarInt(obj.status ?? 0n)
    } else {
      w.writeVarInt(obj.payloadLength)
      w.writeBytes(obj.payload)
    }
  }
  return w.finish()
}

/**
 * Encode a datagram object.
 * Draft-14 datagram types: 0x00-0x07, 0x20-0x21.
 */
export function encodeDatagram(dg: DatagramObject): Uint8Array {
  const w = new BufferWriter()
  w.writeVarInt(BigInt(dg.datagramType))
  w.writeVarInt(dg.trackAlias)
  w.writeVarInt(dg.groupId)

  const objectIdPresent = (dg.datagramType & 0x04) === 0
  const isStatus = dg.datagramType >= 0x20
  const extensionsPresent = (dg.datagramType & 0x01) !== 0

  if (objectIdPresent) {
    w.writeVarInt(dg.objectId)
  }
  w.writeUint8(dg.publisherPriority)

  if (extensionsPresent) {
    const extData = dg.extensionData ?? new Uint8Array(0)
    w.writeVarInt(extData.byteLength)
    if (extData.byteLength > 0) w.writeBytes(extData)
  }

  if (isStatus) {
    w.writeVarInt(dg.objectStatus ?? 0n)
  } else {
    w.writeBytes(dg.payload)
  }
  return w.finish()
}

/**
 * Encode a fetch stream header + objects.
 * Draft-14 fetch: type 0x05, then per-object: GroupID, SubgroupID, ObjectID,
 * PublisherPriority(8), ExtensionHeadersLength, [Extensions], PayloadLength,
 * [ObjectStatus], Payload.
 */
export function encodeFetchStream(stream: FetchStream): Uint8Array {
  const w = new BufferWriter()
  w.writeVarInt(FETCH_STREAM_TYPE)
  w.writeVarInt(stream.requestId)
  for (const obj of stream.objects) {
    w.writeVarInt(obj.groupId)
    w.writeVarInt(obj.subgroupId)
    w.writeVarInt(obj.objectId)
    w.writeUint8(obj.publisherPriority)
    w.writeVarInt(BigInt(obj.extensionData.length))
    if (obj.extensionData.length > 0) w.writeBytes(obj.extensionData)
    if (obj.payloadLength === 0) {
      w.writeVarInt(0)
      w.writeVarInt(obj.status ?? 0n)
    } else {
      w.writeVarInt(obj.payloadLength)
      w.writeBytes(obj.payload)
    }
  }
  return w.finish()
}

/**
 * Decode a subgroup data stream from raw bytes.
 * Accepts types 0x10-0x15 and 0x18-0x1D. Delta-decodes Object IDs.
 */
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
  readonly extensionsPresent: boolean
  readonly subgroupIsFirstObjId: boolean
  readonly trackAlias: bigint
  readonly groupId: bigint
  /** Zero under `subgroupIsFirstObjId` until the first Object has been read. */
  readonly subgroupId: bigint
  readonly publisherPriority: number
}

function readSubgroupHeader(r: BufferReader): SubgroupHeaderFields {
  const streamType = Number(r.readVarInt())
  if (!isValidSubgroupType(streamType)) {
    throw new DecodeError(
      'CONSTRAINT_VIOLATION',
      `Expected subgroup stream type 0x10-0x1D, got 0x${streamType.toString(16)}`,
      0,
    )
  }

  const extensionsPresent = (streamType & 0x01) !== 0
  const hasSubgroupField = (streamType & 0x04) !== 0
  const subgroupIsFirstObjId = (streamType & 0x02) !== 0 && !hasSubgroupField

  const trackAlias = r.readVarInt()
  const groupId = r.readVarInt()

  let subgroupId = 0n
  if (hasSubgroupField) {
    subgroupId = r.readVarInt()
  }

  const publisherPriority = r.readUint8()

  return {
    streamType,
    extensionsPresent,
    subgroupIsFirstObjId,
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
  extensionsPresent: boolean,
  isFirst: boolean,
  prevObjectId: bigint,
  base: number,
): ObjectPayload {
  const byteOffset = base + r.offset
  const delta = r.readVarInt()
  const objectId = isFirst ? delta : prevObjectId + 1n + delta

  let extensionData = new Uint8Array(0)
  if (extensionsPresent) {
    const extLen = Number(r.readVarInt())
    extensionData = extLen > 0 ? r.readBytesView(extLen) : new Uint8Array(0)
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
      const obj = readSubgroupObject(r, h.extensionsPresent, isFirst, prevObjectId, 0)
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
    const dgType = Number(r.readVarInt())

    // Validate datagram type
    const validDatagram = (dgType >= 0x00 && dgType <= 0x07) || dgType === 0x20 || dgType === 0x21
    if (!validDatagram) {
      return {
        ok: false,
        error: new DecodeError(
          'CONSTRAINT_VIOLATION',
          `Expected datagram type 0x00-0x07 or 0x20-0x21, got 0x${dgType.toString(16)}`,
          0,
        ),
      }
    }

    const objectIdPresent = (dgType & 0x04) === 0
    const endOfGroup = (dgType & 0x02) !== 0
    const extensionsPresent = (dgType & 0x01) !== 0
    const isStatus = dgType >= 0x20

    const trackAlias = r.readVarInt()
    const groupId = r.readVarInt()
    let objectId = 0n
    if (objectIdPresent) {
      objectId = r.readVarInt()
    }
    const publisherPriority = r.readUint8()

    let extensionData: Uint8Array | undefined
    if (extensionsPresent) {
      const extLen = Number(r.readVarInt())
      extensionData = extLen > 0 ? r.readBytesView(extLen) : new Uint8Array(0)
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
    if (extensionData !== undefined)
      (result as unknown as Record<string, unknown>).extensionData = extensionData

    return { ok: true, value: result, bytesRead: r.offset }
  } catch (e) {
    if (e instanceof DecodeError) return { ok: false, error: e }
    throw e
  }
}

/**
 * Decode a fetch data stream from raw bytes.
 * Draft-14 fetch: type 0x05, per-object has all fields (no serialization flags).
 */
/**
 * Nothing is carried between fetch Objects in this draft: Group ID,
 * Subgroup ID, Object ID and Priority are all absolute on the wire, so the
 * reader is a pure function of the bytes in front of it.
 */
type FetchObjectState = Record<string, never>

function newFetchObjectState(): FetchObjectState {
  return {}
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
function readFetchObject(r: BufferReader, base: number, _st: FetchObjectState): FetchObjectPayload {
  const byteOffset = base + r.offset
  const groupId = r.readVarInt()
  const subgroupId = r.readVarInt()
  const objectId = r.readVarInt()
  const publisherPriority = r.readUint8()
  const extLen = Number(r.readVarInt())
  const extensionData = extLen > 0 ? r.readBytesView(extLen) : new Uint8Array(0)
  const payloadLength = Number(r.readVarInt())
  let payload: Uint8Array
  let status: bigint | undefined
  let payloadByteOffset: number
  if (payloadLength === 0) {
    status = r.readVarInt()
    payloadByteOffset = base + r.offset
    payload = new Uint8Array(0)
  } else {
    payloadByteOffset = base + r.offset
    payload = r.readBytesView(payloadLength)
  }
  const obj: FetchObjectPayload = {
    type: 'object',
    byteOffset,
    payloadByteOffset,
    groupId,
    subgroupId,
    objectId,
    publisherPriority,
    payloadLength,
    payload,
    extensionData,
  }
  if (status !== undefined) (obj as unknown as Record<string, unknown>).status = status

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

/**
 * Decode a data stream, dispatching by stream type.
 */
export function decodeDataStream(
  streamType: 'subgroup' | 'datagram' | 'fetch',
  bytes: Uint8Array,
): DecodeResult<Draft14DataStream> {
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
 * Create a TransformStream that decodes a subgroup data stream.
 * First emits a SubgroupStreamHeader, then emits ObjectPayload events.
 * Accepts types 0x10-0x1D. Delta-decodes Object IDs.
 */
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
          obj = readSubgroupObject(r, h.extensionsPresent, isFirst, prevObjectId, b.base)
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
  let buffer = new Uint8Array(0)
  let offset = 0
  let detectedType: 'subgroup' | 'fetch' | null = null
  let headerEmitted = false
  let extensionsPresent = false
  let prevObjectId = -1n
  let firstObject = true

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

      if (detectedType === null) {
        try {
          const r = new BufferReader(buffer.subarray(offset))
          const streamType = Number(r.readVarInt())
          if (isValidSubgroupType(streamType)) {
            detectedType = 'subgroup'
          } else if (streamType === 0x05) {
            detectedType = 'fetch'
          } else {
            controller.error(
              new DecodeError(
                'CONSTRAINT_VIOLATION',
                `Unknown data stream type: 0x${streamType.toString(16)}`,
                0,
              ),
            )
            return
          }
        } catch (e) {
          if (e instanceof DecodeError && e.code === 'UNEXPECTED_END') {
            return
          }
          controller.error(e)
          return
        }
      }

      if (detectedType === 'subgroup') {
        if (!headerEmitted) {
          try {
            const r = new BufferReader(buffer.subarray(offset))
            const streamType = Number(r.readVarInt())
            extensionsPresent = (streamType & 0x01) !== 0
            const hasSubgroupField = (streamType & 0x04) !== 0
            const trackAlias = r.readVarInt()
            const groupId = r.readVarInt()
            let subgroupId = 0n
            if (hasSubgroupField) subgroupId = r.readVarInt()
            const publisherPriority = r.readUint8()
            controller.enqueue({
              type: 'subgroup_header',
              headerType: streamType,
              trackAlias,
              groupId,
              subgroupId,
              publisherPriority,
            })
            headerEmitted = true
            offset += r.offset
          } catch (e) {
            if (e instanceof DecodeError && e.code === 'UNEXPECTED_END') return
            controller.error(e)
            return
          }
        }

        while (offset < buffer.length) {
          try {
            const r = new BufferReader(buffer.subarray(offset))
            const byteOffset = r.offset
            const delta = r.readVarInt()
            const objectId = firstObject ? delta : prevObjectId + 1n + delta
            firstObject = false
            let extensionData = new Uint8Array(0)
            if (extensionsPresent) {
              const extLen = Number(r.readVarInt())
              extensionData = extLen > 0 ? r.readBytesView(extLen) : new Uint8Array(0)
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
              payloadLength,
              payload,
              extensionData,
            }
            if (status !== undefined) (obj as unknown as Record<string, unknown>).status = status
            controller.enqueue(obj)
            prevObjectId = objectId
            offset += r.offset
          } catch (e) {
            if (e instanceof DecodeError && e.code === 'UNEXPECTED_END') break
            controller.error(e)
            return
          }
        }
      } else {
        if (!headerEmitted) {
          try {
            const r = new BufferReader(buffer.subarray(offset))
            r.readVarInt() // stream type (0x05)
            const requestId = r.readVarInt()
            controller.enqueue({ type: 'fetch_header', requestId })
            headerEmitted = true
            offset += r.offset
          } catch (e) {
            if (e instanceof DecodeError && e.code === 'UNEXPECTED_END') return
            controller.error(e)
            return
          }
        }

        while (offset < buffer.length) {
          try {
            const r = new BufferReader(buffer.subarray(offset))
            const byteOffset = r.offset
            const groupId = r.readVarInt()
            const subgroupId = r.readVarInt()
            const objectId = r.readVarInt()
            const publisherPriority = r.readUint8()
            const extLen = Number(r.readVarInt())
            const extensionData = extLen > 0 ? r.readBytesView(extLen) : new Uint8Array(0)
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
            const obj: FetchObjectPayload = {
              type: 'object',
              byteOffset,
              payloadByteOffset,
              groupId,
              subgroupId,
              objectId,
              publisherPriority,
              payloadLength,
              payload,
              extensionData,
            }
            if (status !== undefined) (obj as unknown as Record<string, unknown>).status = status
            controller.enqueue(obj)
            offset += r.offset
          } catch (e) {
            if (e instanceof DecodeError && e.code === 'UNEXPECTED_END') break
            controller.error(e)
            return
          }
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
