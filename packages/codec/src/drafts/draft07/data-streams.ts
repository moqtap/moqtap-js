import { BufferReader } from "../../core/buffer-reader.js";
import { BufferWriter } from "../../core/buffer-writer.js";
import type { DecodeResult } from "../../core/types.js";
import { DecodeError } from "../../core/types.js";
import type {
  DatagramObject as Draft07DatagramObject,
  FetchObjectPayload,
  FetchStream,
  ObjectPayload,
  SubgroupStream,
} from "./types.js";

// ─── Data Stream Encoding/Decoding ─────────────────────────────────────────────

// Stream type IDs for draft-07
const SUBGROUP_STREAM_TYPE = 0x04n;
const FETCH_STREAM_TYPE = 0x05n;
const DATAGRAM_TYPE = 0x01n;

export function encodeSubgroupStream(stream: SubgroupStream): Uint8Array {
  const w = new BufferWriter();
  w.writeVarInt(SUBGROUP_STREAM_TYPE);
  w.writeVarInt(stream.trackAlias);
  w.writeVarInt(stream.groupId);
  w.writeVarInt(stream.subgroupId);
  w.writeUint8(stream.publisherPriority);
  for (const obj of stream.objects) {
    w.writeVarInt(obj.objectId);
    w.writeVarInt(obj.payloadLength);
    if (obj.payloadLength === 0 && obj.status !== undefined) {
      w.writeVarInt(obj.status);
    } else {
      w.writeBytes(obj.payload);
    }
  }
  return w.finish();
}

export function encodeDatagram(dg: Draft07DatagramObject): Uint8Array {
  const w = new BufferWriter();
  w.writeVarInt(DATAGRAM_TYPE);
  w.writeVarInt(dg.trackAlias);
  w.writeVarInt(dg.groupId);
  w.writeVarInt(dg.objectId);
  w.writeUint8(dg.publisherPriority);
  w.writeVarInt(dg.payloadLength);
  if (dg.payloadLength === 0 && dg.status !== undefined) {
    w.writeVarInt(dg.status);
  } else {
    w.writeBytes(dg.payload);
  }
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
        payload = r.readBytesView(payloadLength);
      }
      const obj: ObjectPayload = {
        type: "object",
        objectId,
        payloadLength,
        payload,
        byteOffset,
        payloadByteOffset,
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

export function decodeDatagram(bytes: Uint8Array): DecodeResult<Draft07DatagramObject> {
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
    const payloadLength = Number(r.readVarInt());
    let status: bigint | undefined;
    let payload: Uint8Array;
    if (payloadLength === 0) {
      status = r.readVarInt();
      payload = new Uint8Array(0);
    } else {
      payload = r.readBytesView(payloadLength);
    }
    const result: Draft07DatagramObject = {
      type: "datagram",
      streamTypeId: 0x01,
      trackAlias,
      groupId,
      objectId,
      publisherPriority,
      payloadLength,
      payload,
    };
    if (status !== undefined) (result as unknown as Record<string, unknown>).status = status;
    return { ok: true, value: result, bytesRead: r.offset };
  } catch (e) {
    if (e instanceof DecodeError) return { ok: false, error: e };
    throw e;
  }
}

export function decodeFetchStream(bytes: Uint8Array): DecodeResult<FetchStream> {
  try {
    const r = new BufferReader(bytes);
    const streamType = Number(r.readVarInt());
    if (streamType !== 0x05) {
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
        payload = r.readBytesView(payloadLength);
      }
      const obj: FetchObjectPayload = {
        type: "object",
        groupId,
        subgroupId,
        objectId,
        publisherPriority,
        payloadLength,
        payload,
        byteOffset,
        payloadByteOffset,
      };
      if (status !== undefined) (obj as unknown as Record<string, unknown>).status = status;
      objects.push(obj);
    }
    return {
      ok: true,
      value: { type: "fetch", subscribeId, objects },
      bytesRead: r.offset,
    };
  } catch (e) {
    if (e instanceof DecodeError) return { ok: false, error: e };
    throw e;
  }
}
