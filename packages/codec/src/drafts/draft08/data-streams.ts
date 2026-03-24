import { BufferReader } from "../../core/buffer-reader.js";
import { BufferWriter } from "../../core/buffer-writer.js";
import type { DecodeResult } from "../../core/types.js";
import { DecodeError } from "../../core/types.js";
import type {
  DatagramObject,
  DatagramStatusObject,
  Draft08DataStream,
  FetchObjectPayload,
  FetchStream,
  ObjectPayload,
  SubgroupStream,
} from "./types.js";

// ─── Data Stream Encoding/Decoding ─────────────────────────────────────────────

// Stream type IDs for draft-08
const SUBGROUP_STREAM_TYPE = 0x04n;
const DATAGRAM_TYPE = 0x01n;
const DATAGRAM_STATUS_TYPE = 0x02n;
const FETCH_STREAM_TYPE = 0x05n;

export function encodeSubgroupStream(stream: SubgroupStream): Uint8Array {
  const w = new BufferWriter();
  w.writeVarInt(SUBGROUP_STREAM_TYPE);
  w.writeVarInt(stream.trackAlias);
  w.writeVarInt(stream.groupId);
  w.writeVarInt(stream.subgroupId);
  w.writeUint8(stream.publisherPriority);
  for (const obj of stream.objects) {
    w.writeVarInt(obj.objectId);
    w.writeVarInt(obj.extensionCount);
    if (obj.extensionData.length > 0) w.writeBytes(obj.extensionData);
    w.writeVarInt(obj.payloadLength);
    if (obj.payloadLength === 0 && obj.status !== undefined) {
      w.writeVarInt(obj.status);
    } else {
      w.writeBytes(obj.payload);
    }
  }
  return w.finish();
}

export function encodeDatagram(dg: DatagramObject): Uint8Array {
  const w = new BufferWriter();
  w.writeVarInt(DATAGRAM_TYPE);
  w.writeVarInt(dg.trackAlias);
  w.writeVarInt(dg.groupId);
  w.writeVarInt(dg.objectId);
  w.writeUint8(dg.publisherPriority);
  w.writeVarInt(dg.extensionCount);
  if (dg.extensionData.length > 0) w.writeBytes(dg.extensionData);
  w.writeVarInt(dg.payloadLength);
  if (dg.payloadLength === 0 && dg.objectStatus !== undefined) {
    w.writeVarInt(dg.objectStatus);
  } else {
    w.writeBytes(dg.payload);
  }
  return w.finish();
}

export function encodeDatagramStatus(dg: DatagramStatusObject): Uint8Array {
  const w = new BufferWriter();
  w.writeVarInt(DATAGRAM_STATUS_TYPE);
  w.writeVarInt(dg.trackAlias);
  w.writeVarInt(dg.groupId);
  w.writeVarInt(dg.objectId);
  w.writeUint8(dg.publisherPriority);
  w.writeVarInt(dg.objectStatus);
  return w.finish();
}

export function encodeFetchStream(stream: FetchStream): Uint8Array {
  const w = new BufferWriter();
  w.writeVarInt(FETCH_STREAM_TYPE);
  w.writeVarInt(stream.subscribeId);
  for (const obj of stream.objects) {
    w.writeVarInt(obj.groupId);
    w.writeVarInt(obj.subgroupId);
    w.writeVarInt(obj.objectId);
    w.writeUint8(obj.publisherPriority);
    w.writeVarInt(obj.extensionCount);
    if (obj.extensionData.length > 0) w.writeBytes(obj.extensionData);
    w.writeVarInt(obj.payloadLength);
    if (obj.payloadLength === 0 && obj.status !== undefined) {
      w.writeVarInt(obj.status);
    } else {
      w.writeBytes(obj.payload);
    }
  }
  return w.finish();
}

export function decodeSubgroupStream(bytes: Uint8Array): DecodeResult<SubgroupStream> {
  try {
    const r = new BufferReader(bytes);
    const streamType = Number(r.readVarInt());
    if (streamType !== 0x04) {
      return {
        ok: false,
        error: new DecodeError(
          "CONSTRAINT_VIOLATION",
          `Expected subgroup type 0x04, got 0x${streamType.toString(16)}`,
          0,
        ),
      };
    }
    const trackAlias = r.readVarInt();
    const groupId = r.readVarInt();
    const subgroupId = r.readVarInt();
    const publisherPriority = r.readUint8();
    const objects: ObjectPayload[] = [];
    while (r.remaining > 0) {
      const byteOffset = r.offset;
      const objectId = r.readVarInt();
      // Parse extensions (even type = varint value, odd type = length-prefixed)
      const extensionCount = Number(r.readVarInt());
      const extStart = r.offset;
      for (let i = 0; i < extensionCount; i++) {
        const extType = Number(r.readVarInt());
        if (extType % 2 === 0) {
          r.readVarInt(); // even: single varint value
        } else {
          const extLen = Number(r.readVarInt());
          if (extLen > 0) r.readBytes(extLen); // odd: length-prefixed
        }
      }
      const extensionData = r.buffer.slice(extStart, r.offset);
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
      const obj: ObjectPayload = {
        type: "object",
        byteOffset,
        payloadByteOffset,
        objectId,
        extensionCount: BigInt(extensionCount),
        extensionData,
        payloadLength,
        payload,
      };
      if (status !== undefined) (obj as unknown as Record<string, unknown>).status = status;
      objects.push(obj);
    }
    return {
      ok: true,
      value: {
        type: "subgroup",
        streamTypeId: 0x04,
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
    const streamType = Number(r.readVarInt());
    if (streamType !== 0x01) {
      return {
        ok: false,
        error: new DecodeError(
          "CONSTRAINT_VIOLATION",
          `Expected datagram type 0x01, got 0x${streamType.toString(16)}`,
          0,
        ),
      };
    }
    const trackAlias = r.readVarInt();
    const groupId = r.readVarInt();
    const objectId = r.readVarInt();
    const publisherPriority = r.readUint8();
    // Parse extensions (even type = varint value, odd type = length-prefixed)
    const extensionCount = Number(r.readVarInt());
    const extStart = r.offset;
    for (let i = 0; i < extensionCount; i++) {
      const extType = Number(r.readVarInt());
      if (extType % 2 === 0) {
        r.readVarInt(); // even: single varint value
      } else {
        const extLen = Number(r.readVarInt());
        if (extLen > 0) r.readBytes(extLen); // odd: length-prefixed
      }
    }
    const extensionData = r.buffer.slice(extStart, r.offset);
    const payloadLength = Number(r.readVarInt());
    let objectStatus: bigint | undefined;
    let payload: Uint8Array;
    if (payloadLength === 0) {
      objectStatus = r.readVarInt();
      payload = new Uint8Array(0);
    } else {
      payload = r.readBytes(payloadLength);
    }
    const result: DatagramObject = {
      type: "datagram",
      streamTypeId: 0x01,
      trackAlias,
      groupId,
      objectId,
      publisherPriority,
      extensionCount: BigInt(extensionCount),
      extensionData,
      objectStatus: objectStatus ?? 0n,
      payloadLength,
      payload,
    };
    return { ok: true, value: result, bytesRead: r.offset };
  } catch (e) {
    if (e instanceof DecodeError) return { ok: false, error: e };
    throw e;
  }
}

export function decodeDatagramStatus(bytes: Uint8Array): DecodeResult<DatagramStatusObject> {
  try {
    const r = new BufferReader(bytes);
    const streamType = Number(r.readVarInt());
    if (streamType !== 0x02) {
      return {
        ok: false,
        error: new DecodeError(
          "CONSTRAINT_VIOLATION",
          `Expected datagram_status type 0x02, got 0x${streamType.toString(16)}`,
          0,
        ),
      };
    }
    const trackAlias = r.readVarInt();
    const groupId = r.readVarInt();
    const objectId = r.readVarInt();
    const publisherPriority = r.readUint8();
    const objectStatus = r.readVarInt();
    return {
      ok: true,
      value: {
        type: "datagram_status",
        streamTypeId: 0x02,
        trackAlias,
        groupId,
        objectId,
        publisherPriority,
        objectStatus,
      },
      bytesRead: r.offset,
    };
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
          `Expected fetch type 0x05, got 0x${streamType.toString(16)}`,
          0,
        ),
      };
    }
    const subscribeId = r.readVarInt();
    const objects: FetchObjectPayload[] = [];
    while (r.remaining > 0) {
      const byteOffset = r.offset;
      const groupId = r.readVarInt();
      const subgroupId = r.readVarInt();
      const objectId = r.readVarInt();
      const publisherPriority = r.readUint8();
      // Parse extensions (even type = varint value, odd type = length-prefixed)
      const extensionCount = Number(r.readVarInt());
      const extStart = r.offset;
      for (let i = 0; i < extensionCount; i++) {
        const extType = Number(r.readVarInt());
        if (extType % 2 === 0) {
          r.readVarInt(); // even: single varint value
        } else {
          const extLen = Number(r.readVarInt());
          if (extLen > 0) r.readBytes(extLen); // odd: length-prefixed
        }
      }
      const extensionData = r.buffer.slice(extStart, r.offset);
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
        extensionCount: BigInt(extensionCount),
        extensionData,
        payloadLength,
        payload,
      };
      if (status !== undefined) (obj as unknown as Record<string, unknown>).status = status;
      objects.push(obj);
    }
    return { ok: true, value: { type: "fetch", subscribeId, objects }, bytesRead: r.offset };
  } catch (e) {
    if (e instanceof DecodeError) return { ok: false, error: e };
    throw e;
  }
}

export function decodeDataStream(
  streamType: "subgroup" | "datagram" | "datagram_status" | "fetch",
  bytes: Uint8Array,
): DecodeResult<Draft08DataStream> {
  switch (streamType) {
    case "subgroup":
      return decodeSubgroupStream(bytes);
    case "datagram":
      return decodeDatagram(bytes);
    case "datagram_status":
      return decodeDatagramStatus(bytes);
    case "fetch":
      return decodeFetchStream(bytes);
    default: {
      const _: never = streamType;
      throw new Error(`Unknown: ${_}`);
    }
  }
}
