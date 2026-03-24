import { BufferReader } from "../../core/buffer-reader.js";
import { BufferWriter } from "../../core/buffer-writer.js";
import type { DecodeResult } from "../../core/types.js";
import { DecodeError } from "../../core/types.js";
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
} from "./types.js";

// ─── Data Stream Constants ────────────────────────────────────────────────────

const FETCH_STREAM_TYPE = 0x05n;

// Valid subgroup stream types: 0x10-0x1D (12 types)
// Bit 0: extensions present
// Bit 1: subgroup-id mode (0=zero or first-object-id, with bit 2)
// Bit 2: subgroup-id field present (when set, explicit subgroup ID)
// Bit 3: end-of-group
function isValidSubgroupType(t: number): boolean {
  // 12 defined types: 0x10-0x15, 0x18-0x1D
  return (t >= 0x10 && t <= 0x15) || (t >= 0x18 && t <= 0x1d);
}

// ─── Data Stream Encoding/Decoding ─────────────────────────────────────────────

/**
 * Compute the subgroup stream type byte from header properties.
 */
function computeSubgroupType(opts: {
  hasSubgroupField: boolean;
  subgroupIsFirstObjId: boolean;
  extensionsPresent: boolean;
  endOfGroup: boolean;
}): number {
  let t = 0x10;
  if (opts.extensionsPresent) t |= 0x01;
  if (opts.subgroupIsFirstObjId) t |= 0x02;
  if (opts.hasSubgroupField) t |= 0x04;
  if (opts.endOfGroup) t |= 0x08;
  return t;
}

/**
 * Encode a subgroup stream header + objects.
 * Uses delta-encoded Object IDs per draft-14 §10.4.2.
 */
export function encodeSubgroupStream(stream: SubgroupStream): Uint8Array {
  const w = new BufferWriter();
  w.writeVarInt(BigInt(stream.headerType));
  w.writeVarInt(stream.trackAlias);
  w.writeVarInt(stream.groupId);

  const hasSubgroupField = (stream.headerType & 0x04) !== 0;
  const extensionsPresent = (stream.headerType & 0x01) !== 0;
  if (hasSubgroupField) {
    w.writeVarInt(stream.subgroupId);
  }
  w.writeUint8(stream.publisherPriority);

  let prevObjectId = -1n;
  let first = true;
  for (const obj of stream.objects) {
    // Delta encoding: first object delta IS the object ID,
    // subsequent deltas: objectId - prevObjectId - 1
    const delta = first ? obj.objectId : obj.objectId - prevObjectId - 1n;
    w.writeVarInt(delta);
    first = false;
    prevObjectId = obj.objectId;

    // Extension headers
    if (extensionsPresent) {
      w.writeVarInt(BigInt(obj.extensionData.length));
      if (obj.extensionData.length > 0) w.writeBytes(obj.extensionData);
    }

    if (obj.payloadLength === 0) {
      w.writeVarInt(0);
      w.writeVarInt(obj.status ?? 0n);
    } else {
      w.writeVarInt(obj.payloadLength);
      w.writeBytes(obj.payload);
    }
  }
  return w.finish();
}

/**
 * Encode a datagram object.
 * Draft-14 datagram types: 0x00-0x07, 0x20-0x21.
 */
export function encodeDatagram(dg: DatagramObject): Uint8Array {
  const w = new BufferWriter();
  w.writeVarInt(BigInt(dg.datagramType));
  w.writeVarInt(dg.trackAlias);
  w.writeVarInt(dg.groupId);

  const objectIdPresent = (dg.datagramType & 0x04) === 0;
  const isStatus = dg.datagramType >= 0x20;
  const extensionsPresent = (dg.datagramType & 0x01) !== 0;

  if (objectIdPresent) {
    w.writeVarInt(dg.objectId);
  }
  w.writeUint8(dg.publisherPriority);

  if (extensionsPresent) {
    w.writeVarInt(0); // extension headers length = 0
  }

  if (isStatus) {
    w.writeVarInt(dg.objectStatus ?? 0n);
  } else {
    w.writeBytes(dg.payload);
  }
  return w.finish();
}

/**
 * Encode a fetch stream header + objects.
 * Draft-14 fetch: type 0x05, then per-object: GroupID, SubgroupID, ObjectID,
 * PublisherPriority(8), ExtensionHeadersLength, [Extensions], PayloadLength,
 * [ObjectStatus], Payload.
 */
export function encodeFetchStream(stream: FetchStream): Uint8Array {
  const w = new BufferWriter();
  w.writeVarInt(FETCH_STREAM_TYPE);
  w.writeVarInt(stream.requestId);
  for (const obj of stream.objects) {
    w.writeVarInt(obj.groupId);
    w.writeVarInt(obj.subgroupId);
    w.writeVarInt(obj.objectId);
    w.writeUint8(obj.publisherPriority);
    w.writeVarInt(BigInt(obj.extensionData.length));
    if (obj.extensionData.length > 0) w.writeBytes(obj.extensionData);
    if (obj.payloadLength === 0) {
      w.writeVarInt(0);
      w.writeVarInt(obj.status ?? 0n);
    } else {
      w.writeVarInt(obj.payloadLength);
      w.writeBytes(obj.payload);
    }
  }
  return w.finish();
}

/**
 * Decode a subgroup data stream from raw bytes.
 * Accepts types 0x10-0x15 and 0x18-0x1D. Delta-decodes Object IDs.
 */
export function decodeSubgroupStream(bytes: Uint8Array): DecodeResult<SubgroupStream> {
  try {
    const r = new BufferReader(bytes);
    const streamType = Number(r.readVarInt());

    if (!isValidSubgroupType(streamType)) {
      return {
        ok: false,
        error: new DecodeError(
          "CONSTRAINT_VIOLATION",
          `Expected subgroup stream type 0x10-0x1D, got 0x${streamType.toString(16)}`,
          0,
        ),
      };
    }

    // Decode type flags
    const extensionsPresent = (streamType & 0x01) !== 0;
    const hasSubgroupField = (streamType & 0x04) !== 0;
    const subgroupIsFirstObjId = (streamType & 0x02) !== 0 && !hasSubgroupField;

    const trackAlias = r.readVarInt();
    const groupId = r.readVarInt();

    let subgroupId = 0n;
    if (hasSubgroupField) {
      subgroupId = r.readVarInt();
    }
    const publisherPriority = r.readUint8();

    const objects: ObjectPayload[] = [];
    let prevObjectId = -1n;
    let firstObject = true;

    while (r.remaining > 0) {
      const byteOffset = r.offset;
      const delta = r.readVarInt();
      let objectId: bigint;
      if (firstObject) {
        objectId = delta;
        if (subgroupIsFirstObjId) {
          subgroupId = objectId;
        }
        firstObject = false;
      } else {
        objectId = prevObjectId + 1n + delta;
      }

      // Read extension headers if type indicates they're present
      let extensionData = new Uint8Array(0);
      if (extensionsPresent) {
        const extLen = Number(r.readVarInt());
        extensionData = extLen > 0 ? r.readBytes(extLen) : new Uint8Array(0);
      }

      const payloadLength = Number(r.readVarInt());
      let payload: Uint8Array;
      let status: bigint | undefined;
      let payloadByteOffset: number;
      if (payloadLength === 0) {
        status = r.readVarInt();
        payloadByteOffset = r.offset;
        payload = new Uint8Array(0);
      } else {
        payloadByteOffset = r.offset;
        payload = r.readBytes(payloadLength);
      }
      const obj: ObjectPayload = { type: "object", byteOffset, payloadByteOffset, objectId, payloadLength, payload, extensionData };
      if (status !== undefined) (obj as unknown as Record<string, unknown>).status = status;
      objects.push(obj);
      prevObjectId = objectId;
    }

    return {
      ok: true,
      value: {
        type: "subgroup",
        headerType: streamType,
        trackAlias,
        groupId,
        subgroupId,
        publisherPriority,
        objects,
      },
      bytesRead: r.offset,
    };
  } catch (e) {
    if (e instanceof DecodeError) return { ok: false, error: e };
    throw e;
  }
}

/**
 * Decode a datagram object from raw bytes.
 * Accepts types 0x00-0x07 and 0x20-0x21.
 */
export function decodeDatagram(bytes: Uint8Array): DecodeResult<DatagramObject> {
  try {
    const r = new BufferReader(bytes);
    const dgType = Number(r.readVarInt());

    // Validate datagram type
    const validDatagram = (dgType >= 0x00 && dgType <= 0x07) || dgType === 0x20 || dgType === 0x21;
    if (!validDatagram) {
      return {
        ok: false,
        error: new DecodeError(
          "CONSTRAINT_VIOLATION",
          `Expected datagram type 0x00-0x07 or 0x20-0x21, got 0x${dgType.toString(16)}`,
          0,
        ),
      };
    }

    const objectIdPresent = (dgType & 0x04) === 0;
    const endOfGroup = (dgType & 0x02) !== 0;
    const extensionsPresent = (dgType & 0x01) !== 0;
    const isStatus = dgType >= 0x20;

    const trackAlias = r.readVarInt();
    const groupId = r.readVarInt();
    let objectId = 0n;
    if (objectIdPresent) {
      objectId = r.readVarInt();
    }
    const publisherPriority = r.readUint8();

    if (extensionsPresent) {
      const extLen = Number(r.readVarInt());
      if (extLen > 0) {
        r.readBytes(extLen); // skip extension data
      }
    }

    let objectStatus: bigint | undefined;
    let payload: Uint8Array;
    if (isStatus) {
      objectStatus = r.readVarInt();
      payload = new Uint8Array(0);
    } else {
      payload = r.readBytes(r.remaining);
    }
    const payloadLength = payload.byteLength;

    const result: DatagramObject = {
      type: "datagram",
      datagramType: dgType,
      trackAlias,
      groupId,
      objectId,
      publisherPriority,
      payloadLength,
      payload,
    };

    if (endOfGroup) (result as unknown as Record<string, unknown>).endOfGroup = true;
    if (objectStatus !== undefined)
      (result as unknown as Record<string, unknown>).objectStatus = objectStatus;

    return { ok: true, value: result, bytesRead: r.offset };
  } catch (e) {
    if (e instanceof DecodeError) return { ok: false, error: e };
    throw e;
  }
}

/**
 * Decode a fetch data stream from raw bytes.
 * Draft-14 fetch: type 0x05, per-object has all fields (no serialization flags).
 */
export function decodeFetchStream(bytes: Uint8Array): DecodeResult<FetchStream> {
  try {
    const r = new BufferReader(bytes);
    const streamType = r.readVarInt();
    if (streamType !== FETCH_STREAM_TYPE) {
      return {
        ok: false,
        error: new DecodeError(
          "CONSTRAINT_VIOLATION",
          `Expected fetch stream type 0x05, got 0x${streamType.toString(16)}`,
          0,
        ),
      };
    }
    const requestId = r.readVarInt();
    const objects: FetchObjectPayload[] = [];
    while (r.remaining > 0) {
      const byteOffset = r.offset;
      const groupId = r.readVarInt();
      const subgroupId = r.readVarInt();
      const objectId = r.readVarInt();
      const publisherPriority = r.readUint8();
      // Extension headers
      const extLen = Number(r.readVarInt());
      const extensionData = extLen > 0 ? r.readBytes(extLen) : new Uint8Array(0);
      const payloadLength = Number(r.readVarInt());
      let payload: Uint8Array;
      let status: bigint | undefined;
      let payloadByteOffset: number;
      if (payloadLength === 0) {
        status = r.readVarInt();
        payloadByteOffset = r.offset;
        payload = new Uint8Array(0);
      } else {
        payloadByteOffset = r.offset;
        payload = r.readBytes(payloadLength);
      }
      const obj: FetchObjectPayload = {
        type: "object",
        byteOffset,
        payloadByteOffset,
        groupId,
        subgroupId,
        objectId,
        publisherPriority,
        payloadLength,
        payload,
        extensionData,
      };
      if (status !== undefined) (obj as unknown as Record<string, unknown>).status = status;
      objects.push(obj);
    }
    return {
      ok: true,
      value: { type: "fetch", requestId, objects },
      bytesRead: r.offset,
    };
  } catch (e) {
    if (e instanceof DecodeError) return { ok: false, error: e };
    throw e;
  }
}

/**
 * Decode a data stream, dispatching by stream type.
 */
export function decodeDataStream(
  streamType: "subgroup" | "datagram" | "fetch",
  bytes: Uint8Array,
): DecodeResult<Draft14DataStream> {
  switch (streamType) {
    case "subgroup":
      return decodeSubgroupStream(bytes);
    case "datagram":
      return decodeDatagram(bytes);
    case "fetch":
      return decodeFetchStream(bytes);
    default: {
      const _exhaustive: never = streamType;
      throw new Error(`Unknown stream type: ${_exhaustive}`);
    }
  }
}

// ─── Data Stream Decoders ──────────────────────────────────────────────────────

/**
 * Create a TransformStream that decodes a subgroup data stream.
 * First emits a SubgroupStreamHeader, then emits ObjectPayload events.
 * Accepts types 0x10-0x1D. Delta-decodes Object IDs.
 */
export function createSubgroupStreamDecoder(): TransformStream<
  Uint8Array,
  SubgroupStreamHeader | ObjectPayload
> {
  let buffer = new Uint8Array(0);
  let headerEmitted = false;
  let extensionsPresent = false;
  let prevObjectId = -1n;
  let firstObject = true;

  return new TransformStream<Uint8Array, SubgroupStreamHeader | ObjectPayload>({
    transform(chunk, controller) {
      const newBuffer = new Uint8Array(buffer.length + chunk.length);
      newBuffer.set(buffer, 0);
      newBuffer.set(chunk, buffer.length);
      buffer = newBuffer;

      if (!headerEmitted) {
        try {
          const r = new BufferReader(buffer);
          const streamType = Number(r.readVarInt());
          if (!isValidSubgroupType(streamType)) {
            controller.error(
              new DecodeError(
                "CONSTRAINT_VIOLATION",
                `Expected subgroup stream type 0x10-0x1D, got 0x${streamType.toString(16)}`,
                0,
              ),
            );
            return;
          }
          extensionsPresent = (streamType & 0x01) !== 0;
          const hasSubgroupField = (streamType & 0x04) !== 0;
          const trackAlias = r.readVarInt();
          const groupId = r.readVarInt();
          let subgroupId = 0n;
          if (hasSubgroupField) {
            subgroupId = r.readVarInt();
          }
          const publisherPriority = r.readUint8();

          controller.enqueue({
            type: "subgroup_header",
            headerType: streamType,
            trackAlias,
            groupId,
            subgroupId,
            publisherPriority,
          });
          headerEmitted = true;
          buffer = buffer.slice(r.offset);
        } catch (e) {
          if (e instanceof DecodeError && e.code === "UNEXPECTED_END") {
            return;
          }
          controller.error(e);
          return;
        }
      }

      while (buffer.length > 0) {
        try {
          const r = new BufferReader(buffer);
          const byteOffset = r.offset;
          const delta = r.readVarInt();
          const objectId = firstObject ? delta : prevObjectId + 1n + delta;
          firstObject = false;

          let extensionData = new Uint8Array(0);
          if (extensionsPresent) {
            const extLen = Number(r.readVarInt());
            extensionData = extLen > 0 ? r.readBytes(extLen) : new Uint8Array(0);
          }

          const payloadLength = Number(r.readVarInt());
          let payload: Uint8Array;
          let status: bigint | undefined;
          let payloadByteOffset: number;
          if (payloadLength === 0) {
            status = r.readVarInt();
            payloadByteOffset = r.offset;
            payload = new Uint8Array(0);
          } else {
            payloadByteOffset = r.offset;
            payload = r.readBytes(payloadLength);
          }
          const obj: ObjectPayload = { type: "object", byteOffset, payloadByteOffset, objectId, payloadLength, payload, extensionData };
          if (status !== undefined) (obj as unknown as Record<string, unknown>).status = status;
          controller.enqueue(obj);
          prevObjectId = objectId;
          buffer = buffer.slice(r.offset);
        } catch (e) {
          if (e instanceof DecodeError && e.code === "UNEXPECTED_END") {
            break;
          }
          controller.error(e);
          return;
        }
      }
    },

    flush(controller) {
      if (buffer.length > 0) {
        controller.error(new DecodeError("UNEXPECTED_END", "Stream ended with incomplete data", 0));
      }
    },
  });
}

/**
 * Create a TransformStream that decodes a fetch data stream.
 * First emits a FetchStreamHeader, then emits FetchObjectPayload events.
 * Draft-14 fetch: type 0x05, per-object has all fields.
 */
export function createFetchStreamDecoder(): TransformStream<
  Uint8Array,
  FetchStreamHeader | ObjectPayload
> {
  let buffer = new Uint8Array(0);
  let headerEmitted = false;

  return new TransformStream<Uint8Array, FetchStreamHeader | ObjectPayload>({
    transform(chunk, controller) {
      const newBuffer = new Uint8Array(buffer.length + chunk.length);
      newBuffer.set(buffer, 0);
      newBuffer.set(chunk, buffer.length);
      buffer = newBuffer;

      if (!headerEmitted) {
        try {
          const r = new BufferReader(buffer);
          const streamType = r.readVarInt();
          if (streamType !== FETCH_STREAM_TYPE) {
            controller.error(
              new DecodeError(
                "CONSTRAINT_VIOLATION",
                `Expected fetch stream type 0x05, got 0x${streamType.toString(16)}`,
                0,
              ),
            );
            return;
          }
          const requestId = r.readVarInt();

          controller.enqueue({ type: "fetch_header", requestId });
          headerEmitted = true;
          buffer = buffer.slice(r.offset);
        } catch (e) {
          if (e instanceof DecodeError && e.code === "UNEXPECTED_END") {
            return;
          }
          controller.error(e);
          return;
        }
      }

      while (buffer.length > 0) {
        try {
          const r = new BufferReader(buffer);
          const byteOffset = r.offset;
          const groupId = r.readVarInt();
          const subgroupId = r.readVarInt();
          const objectId = r.readVarInt();
          const publisherPriority = r.readUint8();
          const extLen = Number(r.readVarInt());
          const extensionData = extLen > 0 ? r.readBytes(extLen) : new Uint8Array(0);
          const payloadLength = Number(r.readVarInt());
          let payload: Uint8Array;
          let status: bigint | undefined;
          let payloadByteOffset: number;
          if (payloadLength === 0) {
            status = r.readVarInt();
            payloadByteOffset = r.offset;
            payload = new Uint8Array(0);
          } else {
            payloadByteOffset = r.offset;
            payload = r.readBytes(payloadLength);
          }
          const obj: FetchObjectPayload = {
            type: "object",
            byteOffset,
            payloadByteOffset,
            groupId,
            subgroupId,
            objectId,
            publisherPriority,
            payloadLength,
            payload,
            extensionData,
          };
          if (status !== undefined) (obj as unknown as Record<string, unknown>).status = status;
          controller.enqueue(obj);
          buffer = buffer.slice(r.offset);
        } catch (e) {
          if (e instanceof DecodeError && e.code === "UNEXPECTED_END") {
            break;
          }
          controller.error(e);
          return;
        }
      }
    },

    flush(controller) {
      if (buffer.length > 0) {
        controller.error(new DecodeError("UNEXPECTED_END", "Stream ended with incomplete data", 0));
      }
    },
  });
}

/**
 * Create a unified auto-detecting data stream decoder.
 * Reads the stream type varint: 0x10-0x1D = subgroup, 0x05 = fetch.
 */
export function createDataStreamDecoder(): TransformStream<Uint8Array, DataStreamEvent> {
  let buffer = new Uint8Array(0);
  let detectedType: "subgroup" | "fetch" | null = null;
  let headerEmitted = false;
  let extensionsPresent = false;
  let prevObjectId = -1n;
  let firstObject = true;

  return new TransformStream<Uint8Array, DataStreamEvent>({
    transform(chunk, controller) {
      const newBuffer = new Uint8Array(buffer.length + chunk.length);
      newBuffer.set(buffer, 0);
      newBuffer.set(chunk, buffer.length);
      buffer = newBuffer;

      if (detectedType === null) {
        try {
          const r = new BufferReader(buffer);
          const streamType = Number(r.readVarInt());
          if (isValidSubgroupType(streamType)) {
            detectedType = "subgroup";
          } else if (streamType === 0x05) {
            detectedType = "fetch";
          } else {
            controller.error(
              new DecodeError(
                "CONSTRAINT_VIOLATION",
                `Unknown data stream type: 0x${streamType.toString(16)}`,
                0,
              ),
            );
            return;
          }
        } catch (e) {
          if (e instanceof DecodeError && e.code === "UNEXPECTED_END") {
            return;
          }
          controller.error(e);
          return;
        }
      }

      if (detectedType === "subgroup") {
        if (!headerEmitted) {
          try {
            const r = new BufferReader(buffer);
            const streamType = Number(r.readVarInt());
            extensionsPresent = (streamType & 0x01) !== 0;
            const hasSubgroupField = (streamType & 0x04) !== 0;
            const trackAlias = r.readVarInt();
            const groupId = r.readVarInt();
            let subgroupId = 0n;
            if (hasSubgroupField) subgroupId = r.readVarInt();
            const publisherPriority = r.readUint8();
            controller.enqueue({
              type: "subgroup_header",
              headerType: streamType,
              trackAlias,
              groupId,
              subgroupId,
              publisherPriority,
            });
            headerEmitted = true;
            buffer = buffer.slice(r.offset);
          } catch (e) {
            if (e instanceof DecodeError && e.code === "UNEXPECTED_END") return;
            controller.error(e);
            return;
          }
        }

        while (buffer.length > 0) {
          try {
            const r = new BufferReader(buffer);
            const byteOffset = r.offset;
            const delta = r.readVarInt();
            const objectId = firstObject ? delta : prevObjectId + 1n + delta;
            firstObject = false;
            let extensionData = new Uint8Array(0);
            if (extensionsPresent) {
              const extLen = Number(r.readVarInt());
              extensionData = extLen > 0 ? r.readBytes(extLen) : new Uint8Array(0);
            }
            const payloadLength = Number(r.readVarInt());
            let payload: Uint8Array;
            let status: bigint | undefined;
            let payloadByteOffset: number;
            if (payloadLength === 0) {
              status = r.readVarInt();
              payloadByteOffset = r.offset;
              payload = new Uint8Array(0);
            } else {
              payloadByteOffset = r.offset;
              payload = r.readBytes(payloadLength);
            }
            const obj: ObjectPayload = { type: "object", byteOffset, payloadByteOffset, objectId, payloadLength, payload, extensionData };
            if (status !== undefined)
              (obj as unknown as Record<string, unknown>).status = status;
            controller.enqueue(obj);
            prevObjectId = objectId;
            buffer = buffer.slice(r.offset);
          } catch (e) {
            if (e instanceof DecodeError && e.code === "UNEXPECTED_END") break;
            controller.error(e);
            return;
          }
        }
      } else {
        if (!headerEmitted) {
          try {
            const r = new BufferReader(buffer);
            r.readVarInt(); // stream type (0x05)
            const requestId = r.readVarInt();
            controller.enqueue({ type: "fetch_header", requestId });
            headerEmitted = true;
            buffer = buffer.slice(r.offset);
          } catch (e) {
            if (e instanceof DecodeError && e.code === "UNEXPECTED_END") return;
            controller.error(e);
            return;
          }
        }

        while (buffer.length > 0) {
          try {
            const r = new BufferReader(buffer);
            const byteOffset = r.offset;
            const groupId = r.readVarInt();
            const subgroupId = r.readVarInt();
            const objectId = r.readVarInt();
            const publisherPriority = r.readUint8();
            const extLen = Number(r.readVarInt());
            const extensionData = extLen > 0 ? r.readBytes(extLen) : new Uint8Array(0);
            const payloadLength = Number(r.readVarInt());
            let payload: Uint8Array;
            let status: bigint | undefined;
            let payloadByteOffset: number;
            if (payloadLength === 0) {
              status = r.readVarInt();
              payloadByteOffset = r.offset;
              payload = new Uint8Array(0);
            } else {
              payloadByteOffset = r.offset;
              payload = r.readBytes(payloadLength);
            }
            const obj: ObjectPayload = { type: "object", byteOffset, payloadByteOffset, objectId, payloadLength, payload, extensionData };
            if (status !== undefined)
              (obj as unknown as Record<string, unknown>).status = status;
            controller.enqueue(obj);
            buffer = buffer.slice(r.offset);
          } catch (e) {
            if (e instanceof DecodeError && e.code === "UNEXPECTED_END") break;
            controller.error(e);
            return;
          }
        }
      }
    },

    flush(controller) {
      if (buffer.length > 0) {
        controller.error(new DecodeError("UNEXPECTED_END", "Stream ended with incomplete data", 0));
      }
    },
  });
}
