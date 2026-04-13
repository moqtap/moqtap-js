import { BufferReader } from '../../core/buffer-reader.js'
import { BufferWriter } from '../../core/buffer-writer.js'
import type { DecodeResult } from '../../core/types.js'
import { DecodeError } from '../../core/types.js'
import type {
  DatagramObject,
  DataStreamEvent,
  Draft15DataStream,
  FetchObjectPayload,
  FetchStream,
  FetchStreamHeader,
  ObjectPayload,
  SubgroupStream,
  SubgroupStreamHeader,
} from './types.js'

// ─── Data Stream Encoding/Decoding ─────────────────────────────────────────────

// Draft-15 subgroup stream types use 0x10-0x1D range.
// For MVP, we use 0x10 (subgroupId=0, no extensions, no endOfGroup, priority present).
const _SUBGROUP_STREAM_TYPE_SIMPLE = 0x10n
// Draft-15 fetch stream type
const FETCH_STREAM_TYPE = 0x05n

/**
 * Encode a subgroup stream header + objects.
 * Uses the headerType from the stream to reproduce the exact wire type byte.
 */
export function encodeSubgroupStream(stream: SubgroupStream): Uint8Array {
  const w = new BufferWriter()
  const streamType = stream.headerType
  w.writeVarInt(BigInt(streamType))

  const extensionsPresent = (streamType & 0x01) !== 0
  const hasSubgroupField = (streamType & 0x04) !== 0
  const hasPriority = streamType < 0x30

  w.writeVarInt(stream.trackAlias)
  w.writeVarInt(stream.groupId)
  if (hasSubgroupField) {
    w.writeVarInt(stream.subgroupId)
  }
  if (hasPriority) {
    w.writeUint8(stream.publisherPriority)
  }
  // Objects: delta-encoded object IDs
  let prevObjectId = -1n
  for (const obj of stream.objects) {
    const delta = prevObjectId < 0n ? obj.objectId : obj.objectId - prevObjectId - 1n
    w.writeVarInt(delta)
    if (extensionsPresent) {
      w.writeVarInt(BigInt(obj.extensionData.length))
      if (obj.extensionData.length > 0) w.writeBytes(obj.extensionData)
    }
    w.writeVarInt(obj.payloadLength)
    if (obj.payloadLength === 0) {
      w.writeVarInt(obj.status ?? 0n)
    } else {
      w.writeBytes(obj.payload)
    }
    prevObjectId = obj.objectId
  }
  return w.finish()
}

/**
 * Encode a datagram object.
 * Uses type 0x00: Object ID present, priority present, no extensions, no EOG, payload.
 */
export function encodeDatagram(dg: DatagramObject): Uint8Array {
  const w = new BufferWriter()
  // Determine datagram type byte from fields
  const dgType = dg.datagramType
  w.writeVarInt(BigInt(dgType))
  w.writeVarInt(dg.trackAlias)
  w.writeVarInt(dg.groupId)

  // Datagram type flags:
  // bit 0 (0x01): extensions present
  // bit 1 (0x02): end-of-group
  // bit 2 (0x04): object_id ABSENT when set
  // bit 5 (0x20): status (replaces payload)
  const extensionsPresent = (dgType & 0x01) !== 0
  const objectIdAbsent = (dgType & 0x04) !== 0
  const isStatus = (dgType & 0x20) !== 0

  if (!objectIdAbsent) {
    w.writeVarInt(dg.objectId)
  }
  w.writeUint8(dg.publisherPriority)

  if (extensionsPresent) {
    const extData = dg.extensionData ?? new Uint8Array(0)
    w.writeVarInt(BigInt(extData.length))
    if (extData.length > 0) w.writeBytes(extData)
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
 */
export function encodeFetchStream(stream: FetchStream): Uint8Array {
  const w = new BufferWriter()
  w.writeVarInt(FETCH_STREAM_TYPE)
  w.writeVarInt(stream.requestId)
  for (const obj of stream.objects) {
    w.writeUint8(obj.serializationFlags)
    const flags = obj.serializationFlags
    if (flags & 0x08) w.writeVarInt(obj.groupId)
    // subgroup encoding: bits 0-1
    const subgroupEncoding = flags & 0x03
    if (subgroupEncoding === 0x03) w.writeVarInt(obj.subgroupId)
    if (flags & 0x04) w.writeVarInt(obj.objectId)
    if (flags & 0x10) w.writeUint8(obj.publisherPriority)
    if (flags & 0x20) {
      w.writeVarInt(BigInt(obj.extensionData.length))
      if (obj.extensionData.length > 0) w.writeBytes(obj.extensionData)
    }
    w.writeVarInt(obj.payloadLength)
    if (obj.payloadLength === 0) {
      w.writeVarInt(obj.status ?? 0n)
    } else {
      w.writeBytes(obj.payload)
    }
  }
  return w.finish()
}

/**
 * Decode a subgroup data stream from raw bytes.
 */
export function decodeSubgroupStream(bytes: Uint8Array): DecodeResult<SubgroupStream> {
  try {
    const r = new BufferReader(bytes)
    const streamType = Number(r.readVarInt())

    // Draft-15 valid subgroup types: 0x10-0x17, 0x30-0x37
    // bit 0: extensions, bit 1: end-of-group, bit 2: explicit subgroup_id
    if (
      !((streamType >= 0x10 && streamType <= 0x17) || (streamType >= 0x30 && streamType <= 0x37))
    ) {
      return {
        ok: false,
        error: new DecodeError(
          'CONSTRAINT_VIOLATION',
          `Expected subgroup stream type 0x10-0x17/0x30-0x37, got 0x${streamType.toString(16)}`,
          0,
        ),
      }
    }

    // Decode type flags
    // Draft-15 bit layout:
    // bit 0: extensions present
    // bit 1: end-of-group
    // bit 2: explicit subgroup_id field present
    // bit 5 (0x20): no priority (>= 0x30)
    const extensionsPresent = (streamType & 0x01) !== 0
    const endOfGroup = (streamType & 0x02) !== 0
    const hasSubgroupField = (streamType & 0x04) !== 0
    const hasPriority = streamType < 0x30

    const trackAlias = r.readVarInt()
    const groupId = r.readVarInt()

    let subgroupId = 0n
    if (hasSubgroupField) {
      subgroupId = r.readVarInt()
    }

    let publisherPriority = 128 // default
    if (hasPriority) {
      publisherPriority = r.readUint8()
    }

    const objects: ObjectPayload[] = []
    let prevObjectId = -1n
    let firstObject = true

    while (r.remaining > 0) {
      const byteOffset = r.offset
      const delta = r.readVarInt()
      let objectId: bigint
      if (firstObject) {
        objectId = delta
        firstObject = false
      } else {
        objectId = prevObjectId + 1n + delta
      }
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
        // When payload_length is 0, an object status varint follows
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
        extensionData,
        payload,
      }
      if (status !== undefined) (obj as unknown as Record<string, unknown>).status = status
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

/**
 * Decode a datagram object from raw bytes.
 */
export function decodeDatagram(bytes: Uint8Array): DecodeResult<DatagramObject> {
  try {
    const r = new BufferReader(bytes)
    const dgType = Number(r.readVarInt())

    // Datagram type flags:
    // bit 0 (0x01): extensions present
    // bit 1 (0x02): end-of-group
    // bit 2 (0x04): object_id ABSENT when set
    // bit 5 (0x20): status (replaces payload with status varint)
    const extensionsPresent = (dgType & 0x01) !== 0
    const objectIdAbsent = (dgType & 0x04) !== 0
    const endOfGroup = (dgType & 0x02) !== 0
    const isStatus = (dgType & 0x20) !== 0

    const trackAlias = r.readVarInt()
    const groupId = r.readVarInt()
    let objectId = 0n
    if (!objectIdAbsent) {
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
 */
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

    let prevGroupId = 0n
    let prevSubgroupId = 0n
    let prevObjectId = 0n
    let prevPriority = 128
    let first = true

    while (r.remaining > 0) {
      const byteOffset = r.offset
      const flags = r.readUint8()
      const subgroupEncoding = flags & 0x03
      const objectIdPresent = (flags & 0x04) !== 0
      const groupIdPresent = (flags & 0x08) !== 0
      const priorityPresent = (flags & 0x10) !== 0
      const extensionsPresent = (flags & 0x20) !== 0

      if (flags & 0xc0) {
        return {
          ok: false,
          error: new DecodeError(
            'CONSTRAINT_VIOLATION',
            'Reserved bits set in fetch object flags',
            r.offset,
          ),
        }
      }

      let groupId = prevGroupId
      if (groupIdPresent) {
        groupId = r.readVarInt()
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

      let subgroupId: bigint
      if (subgroupEncoding === 0x00) {
        subgroupId = 0n
      } else if (subgroupEncoding === 0x01) {
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
        subgroupId = prevSubgroupId
      } else if (subgroupEncoding === 0x02) {
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
        subgroupId = prevSubgroupId + 1n
      } else {
        subgroupId = r.readVarInt()
      }

      let objectId = prevObjectId + 1n
      if (objectIdPresent) {
        objectId = r.readVarInt()
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

      if (priorityPresent) {
        prevPriority = r.readUint8()
      }

      let extensionData = new Uint8Array(0)
      if (extensionsPresent) {
        const extLen = Number(r.readVarInt())
        extensionData = extLen > 0 ? r.readBytesView(extLen) : new Uint8Array(0)
      }

      const payloadLength = Number(r.readVarInt())
      let payload: Uint8Array
      let status: bigint | undefined
      let payloadByteOffset: number
      if (payloadLength > 0) {
        payloadByteOffset = r.offset
        payload = r.readBytesView(payloadLength)
      } else {
        status = r.readVarInt()
        payloadByteOffset = r.offset
        payload = new Uint8Array(0)
      }

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
        extensionData,
        payload,
      }
      if (status !== undefined) (obj as unknown as Record<string, unknown>).status = status
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

/**
 * Decode a data stream, dispatching by stream type.
 */
export function decodeDataStream(
  streamType: 'subgroup' | 'datagram' | 'fetch',
  bytes: Uint8Array,
): DecodeResult<Draft15DataStream> {
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
 */
export function createSubgroupStreamDecoder(): TransformStream<
  Uint8Array,
  SubgroupStreamHeader | ObjectPayload
> {
  let buffer = new Uint8Array(0)
  let offset = 0
  let headerEmitted = false
  let prevObjectId = -1n
  let firstObject = true
  let _subgroupIsFirstObjId = false
  let _extensionsPresent = false

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
          const streamType = Number(r.readVarInt())

          if (
            !(
              (streamType >= 0x10 && streamType <= 0x17) ||
              (streamType >= 0x30 && streamType <= 0x37)
            )
          ) {
            controller.error(
              new DecodeError(
                'CONSTRAINT_VIOLATION',
                `Expected subgroup stream type, got 0x${streamType.toString(16)}`,
                0,
              ),
            )
            return
          }

          _extensionsPresent = (streamType & 0x01) !== 0
          const hasSubgroupField = (streamType & 0x04) !== 0
          // Draft-15: bit 1 = end_of_group (not subgroupIsFirstObjId)
          _subgroupIsFirstObjId = false
          const hasPriority = streamType < 0x30

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

      // Parse objects with delta-encoded IDs
      while (offset < buffer.length) {
        try {
          const r = new BufferReader(buffer.subarray(offset))
          const byteOffset = r.offset
          const delta = r.readVarInt()
          let objectId: bigint
          if (firstObject) {
            objectId = delta
            firstObject = false
          } else {
            objectId = prevObjectId + 1n + delta
          }
          let extensionData = new Uint8Array(0)
          if (_extensionsPresent) {
            const extLen = Number(r.readVarInt())
            extensionData = extLen > 0 ? r.readBytesView(extLen) : new Uint8Array(0)
          }
          const payloadLength = Number(r.readVarInt())
          const payloadByteOffset = r.offset
          const payload = payloadLength > 0 ? r.readBytesView(payloadLength) : new Uint8Array(0)
          controller.enqueue({
            type: 'object',
            byteOffset,
            payloadByteOffset,
            objectId,
            payloadLength,
            extensionData,
            payload,
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

/**
 * Create a TransformStream that decodes a fetch data stream.
 */
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

      // Parse fetch objects with serialization flags
      // Simplified: just read flags + explicit fields
      while (offset < buffer.length) {
        try {
          const r = new BufferReader(buffer.subarray(offset))
          const flags = r.readUint8()
          const objectIdPresent = (flags & 0x04) !== 0
          const groupIdPresent = (flags & 0x08) !== 0
          const priorityPresent = (flags & 0x10) !== 0
          const extensionsPresent = (flags & 0x20) !== 0
          const subgroupEncoding = flags & 0x03

          if (groupIdPresent) r.readVarInt() // groupId — consumed
          if (subgroupEncoding === 0x03) r.readVarInt() // subgroupId — consumed
          let objectId = 0n
          if (objectIdPresent) objectId = r.readVarInt()
          if (priorityPresent) r.readUint8() // priority — consumed
          let extensionData = new Uint8Array(0)
          if (extensionsPresent) {
            const extLen = Number(r.readVarInt())
            extensionData = extLen > 0 ? r.readBytesView(extLen) : new Uint8Array(0)
          }
          const payloadLength = Number(r.readVarInt())
          const payloadByteOffset = r.offset
          const payload = payloadLength > 0 ? r.readBytesView(payloadLength) : new Uint8Array(0)
          controller.enqueue({
            type: 'object',
            objectId,
            payloadLength,
            extensionData,
            payload,
            byteOffset: 0,
            payloadByteOffset,
          })
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

/**
 * Create a unified auto-detecting data stream decoder.
 */
export function createDataStreamDecoder(): TransformStream<Uint8Array, DataStreamEvent> {
  let buffer = new Uint8Array(0)
  let offset = 0
  let inner: TransformStream<Uint8Array, DataStreamEvent> | null = null
  const _innerWriter: WritableStreamDefaultWriter<Uint8Array> | null = null
  const _innerReader: ReadableStreamDefaultReader<DataStreamEvent> | null = null

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
        // Need at least one byte to determine type
        if (offset >= buffer.length) return
        const firstByte = buffer[offset]!

        if ((firstByte >= 0x10 && firstByte <= 0x17) || (firstByte >= 0x30 && firstByte <= 0x37)) {
          // Subgroup — delegate to subgroup decoder
          // We need to feed the full buffer including the type byte
          const decoder = createSubgroupStreamDecoder()
          inner = decoder as unknown as TransformStream<Uint8Array, DataStreamEvent>
        } else if (firstByte === 0x05) {
          // Fetch
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

        // For simplicity, process inline instead of piping
        // Just re-parse from buffer using the appropriate one-shot decoder
      }

      // Since inner TransformStream piping is complex, use a simpler approach:
      // Accumulate and attempt decode when flush is called
      // For the streaming case, we just buffer everything
    },

    flush(controller) {
      if (offset >= buffer.length) return
      const view = buffer.subarray(offset)

      const firstByte = view[0]!
      let result: DecodeResult<Draft15DataStream>

      if ((firstByte >= 0x10 && firstByte <= 0x17) || (firstByte >= 0x30 && firstByte <= 0x37)) {
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
