import { BufferReader } from "../../core/buffer-reader.js";
import { BufferWriter } from "../../core/buffer-writer.js";
import type { DecodeResult } from "../../core/types.js";
import { DecodeError } from "../../core/types.js";
import type {
  DatagramObject,
  Draft11DataStream,
  FetchObjectPayload,
  FetchStream,
  ObjectPayload,
  SubgroupStream,
} from "./types.js";

// ─── Data Stream Encoding/Decoding ─────────────────────────────────────────────

const FETCH_STREAM_TYPE = 0x05n;

export function encodeSubgroupStream(stream: SubgroupStream): Uint8Array {
  const w = new BufferWriter();
  const typeId = stream.streamTypeId;
  w.writeVarInt(BigInt(typeId));
  w.writeVarInt(stream.trackAlias);
  w.writeVarInt(stream.groupId);
  const extensionsPresent = (typeId & 0x01) !== 0;
  const hasSubgroupField = (typeId & 0x04) !== 0;
  if (hasSubgroupField) w.writeVarInt(stream.subgroupId);
  w.writeUint8(stream.publisherPriority);
  for (const obj of stream.objects) {
    w.writeVarInt(obj.objectId);
    if (extensionsPresent) {
      w.writeVarInt(BigInt(obj.extensionData.length));
      if (obj.extensionData.length > 0) w.writeBytes(obj.extensionData);
    }
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
  w.writeVarInt(BigInt(dg.streamTypeId));
  w.writeVarInt(dg.trackAlias);
  w.writeVarInt(dg.groupId);
  w.writeVarInt(dg.objectId);
  w.writeUint8(dg.publisherPriority);
  if (dg.streamTypeId === 0x02) {
    // Datagram status — write status varint
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
    w.writeVarInt(obj.groupId);
    w.writeVarInt(obj.subgroupId);
    w.writeVarInt(obj.objectId);
    w.writeUint8(obj.publisherPriority);
    w.writeVarInt(BigInt(obj.extensionData.length));
    if (obj.extensionData.length > 0) w.writeBytes(obj.extensionData);
    w.writeVarInt(obj.payloadLength);
    w.writeBytes(obj.payload);
  }
  return w.finish();
}

export function decodeSubgroupStream(bytes: Uint8Array): DecodeResult<SubgroupStream> {
  try {
    const r = new BufferReader(bytes);
    const streamTypeId = Number(r.readVarInt());
    if (streamTypeId < 0x08 || streamTypeId > 0x0d) {
      return {
        ok: false,
        error: new DecodeError(
          "CONSTRAINT_VIOLATION",
          `Expected subgroup type 0x08-0x0D, got 0x${streamTypeId.toString(16)}`,
          0,
        ),
      };
    }
    const extensionsPresent = (streamTypeId & 0x01) !== 0;
    const hasSubgroupField = (streamTypeId & 0x04) !== 0;
    const subgroupIsFirstObjId = (streamTypeId & 0x02) !== 0 && !hasSubgroupField;
    const trackAlias = r.readVarInt();
    const groupId = r.readVarInt();
    let subgroupId = 0n;
    if (hasSubgroupField) subgroupId = r.readVarInt();
    const publisherPriority = r.readUint8();
    const objects: ObjectPayload[] = [];
    let firstObject = true;
    while (r.remaining > 0) {
      const byteOffset = r.offset;
      const objectId = r.readVarInt();
      if (firstObject && subgroupIsFirstObjId) {
        subgroupId = objectId;
        firstObject = false;
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
      const obj: ObjectPayload = { type: "object", byteOffset, payloadByteOffset, objectId, extensionData, payloadLength, payload };
      if (status !== undefined) (obj as unknown as Record<string, unknown>).status = status;
      objects.push(obj);
    }
    return {
      ok: true,
      value: {
        type: "subgroup",
        streamTypeId,
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
    const streamTypeId = Number(r.readVarInt());
    if (streamTypeId !== 0x00 && streamTypeId !== 0x02) {
      return {
        ok: false,
        error: new DecodeError(
          "CONSTRAINT_VIOLATION",
          `Expected datagram type 0x00 or 0x02, got 0x${streamTypeId.toString(16)}`,
          0,
        ),
      };
    }
    const trackAlias = r.readVarInt();
    const groupId = r.readVarInt();
    const objectId = r.readVarInt();
    const publisherPriority = r.readUint8();
    let objectStatus: bigint | undefined;
    let payload: Uint8Array;
    if (streamTypeId === 0x02) {
      objectStatus = r.readVarInt();
      payload = new Uint8Array(0);
    } else {
      payload = r.readBytes(r.remaining);
    }
    const result: DatagramObject = {
      type: "datagram",
      streamTypeId,
      trackAlias,
      groupId,
      objectId,
      publisherPriority,
      payloadLength: payload.byteLength,
      payload,
    };
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
          `Expected fetch type 0x05, got 0x${streamType.toString(16)}`,
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
      const extensionHeadersLength = r.readVarInt();
      const extensionData = extensionHeadersLength > 0n ? r.readBytes(Number(extensionHeadersLength)) : new Uint8Array(0);
      const payloadLength = Number(r.readVarInt());
      let payload: Uint8Array;
      let objectStatus: bigint | undefined;
      let payloadByteOffset: number;
      if (payloadLength === 0) {
        objectStatus = r.readVarInt();
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
        extensionHeadersLength,
        extensionData,
        payloadLength,
        payload,
      };
      if (objectStatus !== undefined)
        (obj as unknown as Record<string, unknown>).objectStatus = objectStatus;
      objects.push(obj);
    }
    return { ok: true, value: { type: "fetch", requestId, objects }, bytesRead: r.offset };
  } catch (e) {
    if (e instanceof DecodeError) return { ok: false, error: e };
    throw e;
  }
}

export function decodeDataStream(
  streamType: "subgroup" | "datagram" | "fetch",
  bytes: Uint8Array,
): DecodeResult<Draft11DataStream> {
  switch (streamType) {
    case "subgroup":
      return decodeSubgroupStream(bytes);
    case "datagram":
      return decodeDatagram(bytes);
    case "fetch":
      return decodeFetchStream(bytes);
    default: {
      const _: never = streamType;
      throw new Error(`Unknown: ${_}`);
    }
  }
}
