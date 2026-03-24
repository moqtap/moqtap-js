import { BufferReader } from "../../core/buffer-reader.js";
import { BufferWriter } from "../../core/buffer-writer.js";
import type { DecodeResult } from "../../core/types.js";
import { DecodeError } from "../../core/types.js";
import type {
  DatagramObject,
  DataStreamEvent,
  Draft17DataStream,
  FetchObjectPayload,
  FetchStream,
  FetchStreamHeader,
  ObjectPayload,
  SubgroupStream,
  SubgroupStreamHeader,
} from "./types.js";

// ─── Data Stream Encoding/Decoding (same as draft-16) ───────────────────────

const FETCH_STREAM_TYPE = 0x05n;

export function encodeSubgroupStream(stream: SubgroupStream): Uint8Array {
  const w = new BufferWriter();
  const streamType = stream.headerType;
  w.writeVarInt(BigInt(streamType));

  const extensionsPresent = (streamType & 0x01) !== 0;
  const hasSubgroupField = (streamType & 0x04) !== 0;
  const hasPriority = streamType < 0x30;

  w.writeVarInt(stream.trackAlias);
  w.writeVarInt(stream.groupId);
  if (hasSubgroupField) {
    w.writeVarInt(stream.subgroupId);
  }
  if (hasPriority) {
    w.writeUint8(stream.publisherPriority);
  }
  let prevObjectId = -1n;
  for (const obj of stream.objects) {
    const delta = prevObjectId < 0n ? obj.objectId : obj.objectId - prevObjectId - 1n;
    w.writeVarInt(delta);
    if (extensionsPresent) {
      w.writeVarInt(BigInt(obj.extensionData.length));
      if (obj.extensionData.length > 0) w.writeBytes(obj.extensionData);
    }
    w.writeVarInt(BigInt(obj.payloadLength));
    if (obj.payloadLength === 0) {
      w.writeVarInt(obj.status ?? 0n);
    } else {
      w.writeBytes(obj.payload);
    }
    prevObjectId = obj.objectId;
  }
  return w.finish();
}

export function encodeDatagram(dg: DatagramObject): Uint8Array {
  const w = new BufferWriter();
  const dgType = dg.datagramType;
  w.writeVarInt(BigInt(dgType));
  w.writeVarInt(dg.trackAlias);
  w.writeVarInt(dg.groupId);

  const objectIdAbsent = (dgType & 0x04) !== 0;
  const isStatus = (dgType & 0x20) !== 0;
  const defaultPriority = (dgType & 0x08) !== 0;

  if (!objectIdAbsent) {
    w.writeVarInt(dg.objectId);
  }
  if (!defaultPriority) {
    w.writeUint8(dg.publisherPriority);
  }

  if (isStatus) {
    w.writeVarInt(dg.objectStatus ?? 0n);
  } else {
    w.writeBytes(dg.payload);
  }
  return w.finish();
}

export function encodeFetchStream(stream: FetchStream): Uint8Array {
  const w = new BufferWriter();
  w.writeVarInt(FETCH_STREAM_TYPE);
  w.writeVarInt(stream.requestId);
  for (const obj of stream.objects) {
    w.writeVarInt(BigInt(obj.serializationFlags));
    const flags = obj.serializationFlags;
    if (flags >= 0x80) {
      // End of Range (0x8C, 0x10C): Group ID, Object ID, PayloadLength=0
      w.writeVarInt(obj.groupId);
      w.writeVarInt(obj.objectId);
      w.writeVarInt(BigInt(obj.payloadLength));
    } else {
      if (flags & 0x08) w.writeVarInt(obj.groupId);
      const subgroupEncoding = flags & 0x03;
      if (subgroupEncoding === 0x03) w.writeVarInt(obj.subgroupId);
      if (flags & 0x04) w.writeVarInt(obj.objectId);
      if (flags & 0x10) w.writeUint8(obj.publisherPriority);
      if (flags & 0x20) {
        w.writeVarInt(BigInt(obj.extensionData.length));
        if (obj.extensionData.length > 0) w.writeBytes(obj.extensionData);
      }
      w.writeVarInt(BigInt(obj.payloadLength));
      if (obj.payloadLength > 0) {
        w.writeBytes(obj.payload);
      }
    }
  }
  return w.finish();
}

export function decodeSubgroupStream(bytes: Uint8Array): DecodeResult<SubgroupStream> {
  try {
    const r = new BufferReader(bytes);
    const streamType = Number(r.readVarInt());

    if (
      !((streamType >= 0x10 && streamType <= 0x1d) || (streamType >= 0x30 && streamType <= 0x3d)) ||
      (streamType & 0x06) === 0x06 // reserved SUBGROUP_ID_MODE (bits 2:1 = 0b11)
    ) {
      return {
        ok: false,
        error: new DecodeError(
          "CONSTRAINT_VIOLATION",
          `Expected subgroup stream type 0x10-0x15/0x18-0x1D/0x30-0x35/0x38-0x3D, got 0x${streamType.toString(16)}`,
          0,
        ),
      };
    }

    const extensionsPresent = (streamType & 0x01) !== 0;
    const hasSubgroupField = (streamType & 0x04) !== 0;
    const subgroupIsFirstObjId = (streamType & 0x02) !== 0 && !hasSubgroupField;
    const hasPriority = streamType < 0x30;

    const trackAlias = r.readVarInt();
    const groupId = r.readVarInt();

    let subgroupId = 0n;
    if (hasSubgroupField) {
      subgroupId = r.readVarInt();
    }

    let publisherPriority = 128;
    if (hasPriority) {
      publisherPriority = r.readUint8();
    }

    const objects: ObjectPayload[] = [];
    let prevObjectId = -1n;
    let firstObject = true;

    while (r.remaining > 0) {
      const byteOffset = r.offset;
      const delta = r.readVarInt();
      let objectId: bigint;
      if (firstObject) {
        objectId = delta;
        if (subgroupIsFirstObjId && firstObject) {
          subgroupId = objectId;
        }
        firstObject = false;
      } else {
        objectId = prevObjectId + 1n + delta;
      }
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

export function decodeDatagram(bytes: Uint8Array): DecodeResult<DatagramObject> {
  try {
    const r = new BufferReader(bytes);
    const dgType = Number(r.readVarInt());

    const objectIdAbsent = (dgType & 0x04) !== 0;
    const endOfGroup = (dgType & 0x02) !== 0;
    const isStatus = (dgType & 0x20) !== 0;
    const defaultPriority = (dgType & 0x08) !== 0;

    const trackAlias = r.readVarInt();
    const groupId = r.readVarInt();
    let objectId = 0n;
    if (!objectIdAbsent) {
      objectId = r.readVarInt();
    }

    let publisherPriority = 128;
    if (!defaultPriority) {
      publisherPriority = r.readUint8();
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

    let prevGroupId = 0n;
    let prevSubgroupId = 0n;
    let prevObjectId = 0n;
    let prevPriority = 128;
    let first = true;

    while (r.remaining > 0) {
      const byteOffset = r.offset;
      const flags = Number(r.readVarInt());

      let groupId = prevGroupId;
      let subgroupId = prevSubgroupId;
      let objectId = prevObjectId + 1n;
      let payloadLength: number;
      let payload: Uint8Array;
      let payloadByteOffset: number;
      let extensionData = new Uint8Array(0);

      if (flags >= 0x80) {
        // End of Range: 0x8C = End of Non-Existent Range, 0x10C = End of Unknown Range
        // Per spec §10.4.4.2: Group ID and Object ID are present;
        // Subgroup ID, Priority, Properties are not present.
        if (flags !== 0x8c && flags !== 0x10c) {
          return {
            ok: false,
            error: new DecodeError(
              "CONSTRAINT_VIOLATION",
              `Unknown serialization flags value: 0x${flags.toString(16)}`,
              r.offset,
            ),
          };
        }
        groupId = r.readVarInt();
        objectId = r.readVarInt();
        payloadLength = Number(r.readVarInt());
        payloadByteOffset = r.offset;
        payload = payloadLength > 0 ? r.readBytes(payloadLength) : new Uint8Array(0);
      } else {
        const subgroupEncoding = flags & 0x03;
        const objectIdPresent = (flags & 0x04) !== 0;
        const groupIdPresent = (flags & 0x08) !== 0;
        const priorityPresent = (flags & 0x10) !== 0;
        const extensionsPresent = (flags & 0x20) !== 0;

        if (flags & 0x40) {
          return {
            ok: false,
            error: new DecodeError(
              "CONSTRAINT_VIOLATION",
              "Reserved bits set in fetch object flags",
              r.offset,
            ),
          };
        }

        if (groupIdPresent) {
          groupId = r.readVarInt();
        } else if (first) {
          return {
            ok: false,
            error: new DecodeError(
              "CONSTRAINT_VIOLATION",
              "First fetch object must include groupId",
              r.offset,
            ),
          };
        }

        if (subgroupEncoding === 0x00) {
          subgroupId = 0n;
        } else if (subgroupEncoding === 0x01) {
          if (first) {
            return {
              ok: false,
              error: new DecodeError(
                "CONSTRAINT_VIOLATION",
                "First fetch object cannot reference prior subgroupId",
                r.offset,
              ),
            };
          }
          subgroupId = prevSubgroupId;
        } else if (subgroupEncoding === 0x02) {
          if (first) {
            return {
              ok: false,
              error: new DecodeError(
                "CONSTRAINT_VIOLATION",
                "First fetch object cannot reference prior subgroupId",
                r.offset,
              ),
            };
          }
          subgroupId = prevSubgroupId + 1n;
        } else if (subgroupEncoding === 0x03) {
          subgroupId = r.readVarInt();
        }

        if (objectIdPresent) {
          objectId = r.readVarInt();
        } else if (first) {
          return {
            ok: false,
            error: new DecodeError(
              "CONSTRAINT_VIOLATION",
              "First fetch object must include objectId",
              r.offset,
            ),
          };
        }

        if (priorityPresent) {
          prevPriority = r.readUint8();
        }

        if (extensionsPresent) {
          const extLen = Number(r.readVarInt());
          if (extLen > 0) {
            extensionData = r.readBytes(extLen);
          }
        }

        payloadLength = Number(r.readVarInt());
        payloadByteOffset = r.offset;
        payload = payloadLength > 0 ? r.readBytes(payloadLength) : new Uint8Array(0);
      }

      const obj: FetchObjectPayload = {
        type: "object",
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
      };
      objects.push(obj);

      prevGroupId = groupId;
      prevSubgroupId = subgroupId;
      prevObjectId = objectId;
      first = false;
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

export function decodeDataStream(
  streamType: "subgroup" | "datagram" | "fetch",
  bytes: Uint8Array,
): DecodeResult<Draft17DataStream> {
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

export function createSubgroupStreamDecoder(): TransformStream<
  Uint8Array,
  SubgroupStreamHeader | ObjectPayload
> {
  let buffer = new Uint8Array(0);
  let headerEmitted = false;
  let prevObjectId = -1n;
  let firstObject = true;
  let _subgroupIsFirstObjId = false;
  let _extensionsPresent = false;

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

          if (
            !(
              (streamType >= 0x10 && streamType <= 0x1d) ||
              (streamType >= 0x30 && streamType <= 0x3d)
            )
          ) {
            controller.error(
              new DecodeError(
                "CONSTRAINT_VIOLATION",
                `Expected subgroup stream type, got 0x${streamType.toString(16)}`,
                0,
              ),
            );
            return;
          }

          _extensionsPresent = (streamType & 0x01) !== 0;
          const hasSubgroupField = (streamType & 0x04) !== 0;
          _subgroupIsFirstObjId = (streamType & 0x02) !== 0 && !hasSubgroupField;
          const hasPriority = streamType < 0x30;

          const trackAlias = r.readVarInt();
          const groupId = r.readVarInt();

          let subgroupId = 0n;
          if (hasSubgroupField) {
            subgroupId = r.readVarInt();
          }

          let publisherPriority = 128;
          if (hasPriority) {
            publisherPriority = r.readUint8();
          }

          controller.enqueue({
            type: "subgroup_header",
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
          const delta = r.readVarInt();
          let objectId: bigint;
          if (firstObject) {
            objectId = delta;
            firstObject = false;
          } else {
            objectId = prevObjectId + 1n + delta;
          }
          let extensionData = new Uint8Array(0);
          if (_extensionsPresent) {
            const extLen = Number(r.readVarInt());
            extensionData = extLen > 0 ? r.readBytes(extLen) : new Uint8Array(0);
          }
          const payloadLength = Number(r.readVarInt());
          const payloadByteOffset = r.offset;
          const payload = payloadLength > 0 ? r.readBytes(payloadLength) : new Uint8Array(0);
          controller.enqueue({ type: "object", objectId, payloadLength, payload, extensionData, byteOffset: 0, payloadByteOffset });
          buffer = buffer.slice(r.offset);
          prevObjectId = objectId;
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
          const flags = Number(r.readVarInt());
          const objectIdPresent = (flags & 0x04) !== 0;
          const groupIdPresent = (flags & 0x08) !== 0;
          const priorityPresent = (flags & 0x10) !== 0;
          const extensionsPresent = (flags & 0x20) !== 0;
          const subgroupEncoding = flags & 0x03;

          if (groupIdPresent) r.readVarInt();
          if (subgroupEncoding === 0x03) r.readVarInt();
          let objectId = 0n;
          if (objectIdPresent) objectId = r.readVarInt();
          if (priorityPresent) r.readUint8();
          let extensionData = new Uint8Array(0);
          if (extensionsPresent) {
            const extLen = Number(r.readVarInt());
            extensionData = extLen > 0 ? r.readBytes(extLen) : new Uint8Array(0);
          }
          const payloadLength = Number(r.readVarInt());
          const payloadByteOffset = r.offset;
          const payload = payloadLength > 0 ? r.readBytes(payloadLength) : new Uint8Array(0);
          controller.enqueue({ type: "object", objectId, payloadLength, payload, extensionData, byteOffset: 0, payloadByteOffset });
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

export function createDataStreamDecoder(): TransformStream<Uint8Array, DataStreamEvent> {
  let buffer = new Uint8Array(0);
  let inner: TransformStream<Uint8Array, DataStreamEvent> | null = null;

  return new TransformStream<Uint8Array, DataStreamEvent>({
    transform(chunk, controller) {
      const newBuffer = new Uint8Array(buffer.length + chunk.length);
      newBuffer.set(buffer, 0);
      newBuffer.set(chunk, buffer.length);
      buffer = newBuffer;

      if (inner === null) {
        if (buffer.length === 0) return;
        const firstByte = buffer[0]!;

        if ((firstByte >= 0x10 && firstByte <= 0x1d) || (firstByte >= 0x30 && firstByte <= 0x3d)) {
          const decoder = createSubgroupStreamDecoder();
          inner = decoder as unknown as TransformStream<Uint8Array, DataStreamEvent>;
        } else if (firstByte === 0x05) {
          const decoder = createFetchStreamDecoder();
          inner = decoder as unknown as TransformStream<Uint8Array, DataStreamEvent>;
        } else {
          controller.error(
            new DecodeError(
              "CONSTRAINT_VIOLATION",
              `Unknown data stream type: 0x${firstByte.toString(16)}`,
              0,
            ),
          );
          return;
        }
      }
    },

    flush(controller) {
      if (buffer.length === 0) return;

      const firstByte = buffer[0]!;
      let result: DecodeResult<Draft17DataStream>;

      if ((firstByte >= 0x10 && firstByte <= 0x1d) || (firstByte >= 0x30 && firstByte <= 0x3d)) {
        result = decodeSubgroupStream(buffer);
      } else if (firstByte === 0x05) {
        result = decodeFetchStream(buffer);
      } else {
        controller.error(
          new DecodeError(
            "CONSTRAINT_VIOLATION",
            `Unknown data stream type: 0x${firstByte.toString(16)}`,
            0,
          ),
        );
        return;
      }

      if (!result.ok) {
        controller.error(result.error);
        return;
      }

      const stream = result.value;
      if (stream.type === "subgroup") {
        controller.enqueue({
          type: "subgroup_header",
          trackAlias: stream.trackAlias,
          groupId: stream.groupId,
          subgroupId: stream.subgroupId,
          publisherPriority: stream.publisherPriority,
        });
        for (const obj of stream.objects) {
          controller.enqueue(obj);
        }
      } else if (stream.type === "fetch") {
        controller.enqueue({
          type: "fetch_header",
          requestId: stream.requestId,
        });
        for (const obj of stream.objects) {
          controller.enqueue(obj);
        }
      }
    },
  });
}
