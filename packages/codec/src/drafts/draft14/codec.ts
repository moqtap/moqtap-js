import { bytesToHex, hexToBytes } from "../../core/hex.js";
import { BufferReader } from "../../core/buffer-reader.js";
import { BufferWriter } from "../../core/buffer-writer.js";
import type { BaseCodec, DecodeResult } from "../../core/types.js";
import { DecodeError } from "../../core/types.js";
import {
  MESSAGE_ID_MAP,
  MSG_CLIENT_SETUP,
  MSG_FETCH,
  MSG_FETCH_CANCEL,
  MSG_FETCH_ERROR,
  MSG_FETCH_OK,
  MSG_GOAWAY,
  MSG_MAX_REQUEST_ID,
  MSG_PUBLISH,
  MSG_PUBLISH_DONE,
  MSG_PUBLISH_ERROR,
  MSG_PUBLISH_NAMESPACE,
  MSG_PUBLISH_NAMESPACE_CANCEL,
  MSG_PUBLISH_NAMESPACE_DONE,
  MSG_PUBLISH_NAMESPACE_ERROR,
  MSG_PUBLISH_NAMESPACE_OK,
  MSG_PUBLISH_OK,
  MSG_REQUESTS_BLOCKED,
  MSG_SERVER_SETUP,
  MSG_SUBSCRIBE,
  MSG_SUBSCRIBE_ERROR,
  MSG_SUBSCRIBE_NAMESPACE,
  MSG_SUBSCRIBE_NAMESPACE_ERROR,
  MSG_SUBSCRIBE_NAMESPACE_OK,
  MSG_SUBSCRIBE_OK,
  MSG_SUBSCRIBE_UPDATE,
  MSG_TRACK_STATUS,
  MSG_TRACK_STATUS_ERROR,
  MSG_TRACK_STATUS_OK,
  MSG_UNSUBSCRIBE,
  MSG_UNSUBSCRIBE_NAMESPACE,
  PARAM_MAX_REQUEST_ID,
  PARAM_PATH,
  PARAM_ROLE,
} from "./messages.js";
import type {
  DatagramObject,
  DataStreamEvent,
  Draft14DataStream,
  Draft14Message,
  Draft14Params,
  FetchObjectPayload,
  FetchStream,
  FetchStreamHeader,
  ObjectPayload,
  SubgroupStream,
  SubgroupStreamHeader,
  UnknownParam,
} from "./types.js";

const textEncoder = /* @__PURE__ */ new TextEncoder();
const textDecoder = /* @__PURE__ */ new TextDecoder();

// ─── Parameter Encoding/Decoding ───────────────────────────────────────────────

function encodeParams(params: Draft14Params, writer: BufferWriter): void {
  // Count total params
  let count = 0;
  if (params.role !== undefined) count++;
  if (params.path !== undefined) count++;
  if (params.max_request_id !== undefined) count++;
  if (params.unknown) count += params.unknown.length;

  writer.writeVarInt(count);

  // ROLE (0x00) - even, varint value
  if (params.role !== undefined) {
    writer.writeVarInt(PARAM_ROLE);
    writer.writeVarInt(params.role);
  }

  // PATH (0x01) - odd, length-prefixed bytes
  if (params.path !== undefined) {
    writer.writeVarInt(PARAM_PATH);
    const encoded = textEncoder.encode(params.path);
    writer.writeVarInt(encoded.byteLength);
    writer.writeBytes(encoded);
  }

  // MAX_REQUEST_ID (0x02) - even, varint value
  if (params.max_request_id !== undefined) {
    writer.writeVarInt(PARAM_MAX_REQUEST_ID);
    writer.writeVarInt(params.max_request_id);
  }

  // Unknown params
  if (params.unknown) {
    for (const u of params.unknown) {
      const id = BigInt(u.id);
      writer.writeVarInt(id);
      const raw = hexToBytes(u.raw_hex);
      writer.writeVarInt(raw.byteLength);
      writer.writeBytes(raw);
    }
  }
}

function decodeParams(reader: BufferReader): Draft14Params {
  const count = Number(reader.readVarInt());
  const result: Draft14Params = {};
  const unknown: UnknownParam[] = [];

  for (let i = 0; i < count; i++) {
    const paramType = reader.readVarInt();

    if (paramType % 2n === 0n) {
      // Even: value is a varint directly
      const value = reader.readVarInt();
      if (paramType === PARAM_ROLE) {
        result.role = value;
      } else if (paramType === PARAM_MAX_REQUEST_ID) {
        result.max_request_id = value;
      } else {
        // Unknown even param — encode the varint value as raw bytes
        const tmpWriter = new BufferWriter(16);
        tmpWriter.writeVarInt(value);
        const raw = tmpWriter.finish();
        unknown.push({
          id: `0x${paramType.toString(16)}`,
          length: raw.byteLength,
          raw_hex: bytesToHex(raw),
        });
      }
    } else {
      // Odd: value is length-prefixed bytes
      const length = Number(reader.readVarInt());
      const bytes = reader.readBytes(length);
      if (paramType === PARAM_PATH) {
        result.path = textDecoder.decode(bytes);
      } else {
        unknown.push({
          id: `0x${paramType.toString(16)}`,
          length,
          raw_hex: bytesToHex(bytes),
        });
      }
    }
  }

  if (unknown.length > 0) {
    result.unknown = unknown;
  }

  return result;
}

// ─── Payload Encoders ──────────────────────────────────────────────────────────

function encodeClientSetupPayload(
  msg: Draft14Message & { type: "client_setup" },
  w: BufferWriter,
): void {
  w.writeVarInt(msg.supported_versions.length);
  for (const v of msg.supported_versions) {
    w.writeVarInt(v);
  }
  encodeParams(msg.parameters, w);
}

function encodeServerSetupPayload(
  msg: Draft14Message & { type: "server_setup" },
  w: BufferWriter,
): void {
  w.writeVarInt(msg.selected_version);
  encodeParams(msg.parameters, w);
}

function encodeSubscribePayload(
  msg: Draft14Message & { type: "subscribe" },
  w: BufferWriter,
): void {
  w.writeVarInt(msg.request_id);
  w.writeTuple(msg.track_namespace);
  w.writeString(msg.track_name);
  w.writeUint8(Number(msg.subscriber_priority));
  w.writeVarInt(msg.group_order);
  w.writeVarInt(msg.forward);
  w.writeVarInt(msg.filter_type);
  const ft = Number(msg.filter_type);
  if (ft >= 3) {
    w.writeVarInt(msg.start_group!);
    w.writeVarInt(msg.start_object!);
  }
  if (ft === 4) {
    w.writeVarInt(msg.end_group!);
  }
  encodeParams(msg.parameters, w);
}

function encodeSubscribeOkPayload(
  msg: Draft14Message & { type: "subscribe_ok" },
  w: BufferWriter,
): void {
  w.writeVarInt(msg.request_id);
  w.writeVarInt(msg.track_alias);
  w.writeVarInt(msg.expires);
  w.writeVarInt(msg.group_order);
  w.writeVarInt(msg.content_exists);
  if (Number(msg.content_exists) === 1) {
    w.writeVarInt(msg.largest_group!);
    w.writeVarInt(msg.largest_object!);
  }
  encodeParams(msg.parameters, w);
}

function encodeSubscribeUpdatePayload(
  msg: Draft14Message & { type: "subscribe_update" },
  w: BufferWriter,
): void {
  w.writeVarInt(msg.request_id);
  w.writeVarInt(msg.start_group);
  w.writeVarInt(msg.start_object);
  w.writeVarInt(msg.end_group);
  w.writeUint8(Number(msg.subscriber_priority));
  w.writeVarInt(msg.forward);
  encodeParams(msg.parameters, w);
}

function encodeSubscribeErrorPayload(
  msg: Draft14Message & { type: "subscribe_error" },
  w: BufferWriter,
): void {
  w.writeVarInt(msg.request_id);
  w.writeVarInt(msg.error_code);
  w.writeString(msg.reason_phrase);
}

function encodeUnsubscribePayload(
  msg: Draft14Message & { type: "unsubscribe" },
  w: BufferWriter,
): void {
  w.writeVarInt(msg.request_id);
}

function encodePublishPayload(msg: Draft14Message & { type: "publish" }, w: BufferWriter): void {
  w.writeVarInt(msg.request_id);
  w.writeTuple(msg.track_namespace);
  w.writeString(msg.track_name);
  w.writeVarInt(msg.forward);
  encodeParams(msg.parameters, w);
}

function encodePublishOkPayload(
  msg: Draft14Message & { type: "publish_ok" },
  w: BufferWriter,
): void {
  w.writeVarInt(msg.request_id);
  w.writeVarInt(msg.track_alias);
  w.writeVarInt(msg.forward);
  encodeParams(msg.parameters, w);
}

function encodePublishErrorPayload(
  msg: Draft14Message & { type: "publish_error" },
  w: BufferWriter,
): void {
  w.writeVarInt(msg.request_id);
  w.writeVarInt(msg.error_code);
  w.writeString(msg.reason_phrase);
}

function encodePublishDonePayload(
  msg: Draft14Message & { type: "publish_done" },
  w: BufferWriter,
): void {
  w.writeVarInt(msg.request_id);
  w.writeVarInt(msg.status_code);
  w.writeString(msg.reason_phrase);
}

function encodePublishNamespacePayload(
  msg: Draft14Message & { type: "publish_namespace" },
  w: BufferWriter,
): void {
  w.writeVarInt(msg.request_id);
  w.writeTuple(msg.track_namespace);
  encodeParams(msg.parameters, w);
}

function encodePublishNamespaceOkPayload(
  msg: Draft14Message & { type: "publish_namespace_ok" },
  w: BufferWriter,
): void {
  w.writeVarInt(msg.request_id);
  encodeParams(msg.parameters, w);
}

function encodePublishNamespaceErrorPayload(
  msg: Draft14Message & { type: "publish_namespace_error" },
  w: BufferWriter,
): void {
  w.writeVarInt(msg.request_id);
  w.writeVarInt(msg.error_code);
  w.writeString(msg.reason_phrase);
}

function encodePublishNamespaceDonePayload(
  msg: Draft14Message & { type: "publish_namespace_done" },
  w: BufferWriter,
): void {
  w.writeVarInt(msg.request_id);
  w.writeVarInt(msg.status_code);
  w.writeString(msg.reason_phrase);
}

function encodePublishNamespaceCancelPayload(
  msg: Draft14Message & { type: "publish_namespace_cancel" },
  w: BufferWriter,
): void {
  w.writeVarInt(msg.request_id);
}

function encodeSubscribeNamespacePayload(
  msg: Draft14Message & { type: "subscribe_namespace" },
  w: BufferWriter,
): void {
  w.writeVarInt(msg.request_id);
  w.writeTuple(msg.namespace_prefix);
  encodeParams(msg.parameters, w);
}

function encodeSubscribeNamespaceOkPayload(
  msg: Draft14Message & { type: "subscribe_namespace_ok" },
  w: BufferWriter,
): void {
  w.writeVarInt(msg.request_id);
  encodeParams(msg.parameters, w);
}

function encodeSubscribeNamespaceErrorPayload(
  msg: Draft14Message & { type: "subscribe_namespace_error" },
  w: BufferWriter,
): void {
  w.writeVarInt(msg.request_id);
  w.writeVarInt(msg.error_code);
  w.writeString(msg.reason_phrase);
}

function encodeUnsubscribeNamespacePayload(
  msg: Draft14Message & { type: "unsubscribe_namespace" },
  w: BufferWriter,
): void {
  w.writeVarInt(msg.request_id);
}

function encodeFetchPayload(msg: Draft14Message & { type: "fetch" }, w: BufferWriter): void {
  w.writeVarInt(msg.request_id);
  w.writeTuple(msg.track_namespace);
  w.writeString(msg.track_name);
  w.writeVarInt(msg.start_group);
  w.writeVarInt(msg.start_object);
  w.writeVarInt(msg.end_group);
  encodeParams(msg.parameters, w);
}

function encodeFetchOkPayload(msg: Draft14Message & { type: "fetch_ok" }, w: BufferWriter): void {
  w.writeVarInt(msg.request_id);
  w.writeVarInt(msg.track_alias);
  w.writeVarInt(msg.end_of_track);
  encodeParams(msg.parameters, w);
}

function encodeFetchErrorPayload(
  msg: Draft14Message & { type: "fetch_error" },
  w: BufferWriter,
): void {
  w.writeVarInt(msg.request_id);
  w.writeVarInt(msg.error_code);
  w.writeString(msg.reason_phrase);
}

function encodeFetchCancelPayload(
  msg: Draft14Message & { type: "fetch_cancel" },
  w: BufferWriter,
): void {
  w.writeVarInt(msg.request_id);
}

function encodeTrackStatusPayload(
  msg: Draft14Message & { type: "track_status" },
  w: BufferWriter,
): void {
  w.writeVarInt(msg.request_id);
  w.writeTuple(msg.track_namespace);
  w.writeString(msg.track_name);
  encodeParams(msg.parameters, w);
}

function encodeTrackStatusOkPayload(
  msg: Draft14Message & { type: "track_status_ok" },
  w: BufferWriter,
): void {
  w.writeVarInt(msg.request_id);
  w.writeVarInt(msg.status_code);
  const sc = Number(msg.status_code);
  if (sc === 0 || sc === 3) {
    w.writeVarInt(msg.largest_group!);
    w.writeVarInt(msg.largest_object!);
  }
  encodeParams(msg.parameters, w);
}

function encodeTrackStatusErrorPayload(
  msg: Draft14Message & { type: "track_status_error" },
  w: BufferWriter,
): void {
  w.writeVarInt(msg.request_id);
  w.writeVarInt(msg.error_code);
  w.writeString(msg.reason_phrase);
}

function encodeGoAwayPayload(msg: Draft14Message & { type: "goaway" }, w: BufferWriter): void {
  w.writeString(msg.new_session_uri);
}

function encodeMaxRequestIdPayload(
  msg: Draft14Message & { type: "max_request_id" },
  w: BufferWriter,
): void {
  w.writeVarInt(msg.request_id);
}

function encodeRequestsBlockedPayload(
  msg: Draft14Message & { type: "requests_blocked" },
  w: BufferWriter,
): void {
  w.writeVarInt(msg.request_id);
}

// ─── Payload Decoders ──────────────────────────────────────────────────────────

function decodeClientSetupPayload(r: BufferReader): Draft14Message {
  const numVersions = Number(r.readVarInt());
  if (numVersions === 0) {
    throw new DecodeError(
      "CONSTRAINT_VIOLATION",
      "CLIENT_SETUP must offer at least one version",
      r.offset,
    );
  }
  const supported_versions: bigint[] = [];
  for (let i = 0; i < numVersions; i++) {
    supported_versions.push(r.readVarInt());
  }
  const parameters = decodeParams(r);
  return { type: "client_setup", supported_versions, parameters };
}

function decodeServerSetupPayload(r: BufferReader): Draft14Message {
  const selected_version = r.readVarInt();
  const parameters = decodeParams(r);
  return { type: "server_setup", selected_version, parameters };
}

function decodeSubscribePayload(r: BufferReader): Draft14Message {
  const request_id = r.readVarInt();
  const track_namespace = r.readTuple();
  const track_name = r.readString();
  const subscriber_priority = BigInt(r.readUint8());
  const group_order = r.readVarInt();
  const forward = r.readVarInt();
  const filter_type = r.readVarInt();
  const ft = Number(filter_type);

  if (ft < 1 || ft > 4) {
    throw new DecodeError("CONSTRAINT_VIOLATION", `Invalid filter_type: ${ft}`, r.offset);
  }

  let start_group: bigint | undefined;
  let start_object: bigint | undefined;
  let end_group: bigint | undefined;

  if (ft >= 3) {
    start_group = r.readVarInt();
    start_object = r.readVarInt();
  }
  if (ft === 4) {
    end_group = r.readVarInt();
  }

  const parameters = decodeParams(r);

  const msg: Draft14Message & { type: "subscribe" } = {
    type: "subscribe",
    request_id,
    track_namespace,
    track_name,
    subscriber_priority,
    group_order,
    forward,
    filter_type,
    parameters,
  };

  if (start_group !== undefined) {
    return { ...msg, start_group, start_object, end_group } as Draft14Message;
  }

  return msg;
}

function decodeSubscribeOkPayload(r: BufferReader): Draft14Message {
  const request_id = r.readVarInt();
  const track_alias = r.readVarInt();
  const expires = r.readVarInt();
  const group_order = r.readVarInt();
  const content_exists = r.readVarInt();

  let largest_group: bigint | undefined;
  let largest_object: bigint | undefined;

  if (Number(content_exists) === 1) {
    largest_group = r.readVarInt();
    largest_object = r.readVarInt();
  }

  const parameters = decodeParams(r);

  const msg: Draft14Message = {
    type: "subscribe_ok",
    request_id,
    track_alias,
    expires,
    group_order,
    content_exists,
    parameters,
    ...(largest_group !== undefined ? { largest_group, largest_object } : {}),
  } as Draft14Message;

  return msg;
}

function decodeSubscribeUpdatePayload(r: BufferReader): Draft14Message {
  const request_id = r.readVarInt();
  const start_group = r.readVarInt();
  const start_object = r.readVarInt();
  const end_group = r.readVarInt();
  const subscriber_priority = BigInt(r.readUint8());
  const forward = r.readVarInt();
  const parameters = decodeParams(r);
  return {
    type: "subscribe_update",
    request_id,
    start_group,
    start_object,
    end_group,
    subscriber_priority,
    forward,
    parameters,
  };
}

function decodeSubscribeErrorPayload(r: BufferReader): Draft14Message {
  const request_id = r.readVarInt();
  const error_code = r.readVarInt();
  const reason_phrase = r.readString();
  return { type: "subscribe_error", request_id, error_code, reason_phrase };
}

function decodeUnsubscribePayload(r: BufferReader): Draft14Message {
  const request_id = r.readVarInt();
  return { type: "unsubscribe", request_id };
}

function decodePublishPayload(r: BufferReader): Draft14Message {
  const request_id = r.readVarInt();
  const track_namespace = r.readTuple();
  const track_name = r.readString();
  const forward = r.readVarInt();
  const parameters = decodeParams(r);
  return { type: "publish", request_id, track_namespace, track_name, forward, parameters };
}

function decodePublishOkPayload(r: BufferReader): Draft14Message {
  const request_id = r.readVarInt();
  const track_alias = r.readVarInt();
  const forward = r.readVarInt();
  const parameters = decodeParams(r);
  return { type: "publish_ok", request_id, track_alias, forward, parameters };
}

function decodePublishErrorPayload(r: BufferReader): Draft14Message {
  const request_id = r.readVarInt();
  const error_code = r.readVarInt();
  const reason_phrase = r.readString();
  return { type: "publish_error", request_id, error_code, reason_phrase };
}

function decodePublishDonePayload(r: BufferReader): Draft14Message {
  const request_id = r.readVarInt();
  const status_code = r.readVarInt();
  const reason_phrase = r.readString();
  return { type: "publish_done", request_id, status_code, reason_phrase };
}

function decodePublishNamespacePayload(r: BufferReader): Draft14Message {
  const request_id = r.readVarInt();
  const track_namespace = r.readTuple();
  const parameters = decodeParams(r);
  return { type: "publish_namespace", request_id, track_namespace, parameters };
}

function decodePublishNamespaceOkPayload(r: BufferReader): Draft14Message {
  const request_id = r.readVarInt();
  const parameters = decodeParams(r);
  return { type: "publish_namespace_ok", request_id, parameters };
}

function decodePublishNamespaceErrorPayload(r: BufferReader): Draft14Message {
  const request_id = r.readVarInt();
  const error_code = r.readVarInt();
  const reason_phrase = r.readString();
  return { type: "publish_namespace_error", request_id, error_code, reason_phrase };
}

function decodePublishNamespaceDonePayload(r: BufferReader): Draft14Message {
  const request_id = r.readVarInt();
  const status_code = r.readVarInt();
  const reason_phrase = r.readString();
  return { type: "publish_namespace_done", request_id, status_code, reason_phrase };
}

function decodePublishNamespaceCancelPayload(r: BufferReader): Draft14Message {
  const request_id = r.readVarInt();
  return { type: "publish_namespace_cancel", request_id };
}

function decodeSubscribeNamespacePayload(r: BufferReader): Draft14Message {
  const request_id = r.readVarInt();
  const namespace_prefix = r.readTuple();
  const parameters = decodeParams(r);
  return { type: "subscribe_namespace", request_id, namespace_prefix, parameters };
}

function decodeSubscribeNamespaceOkPayload(r: BufferReader): Draft14Message {
  const request_id = r.readVarInt();
  const parameters = decodeParams(r);
  return { type: "subscribe_namespace_ok", request_id, parameters };
}

function decodeSubscribeNamespaceErrorPayload(r: BufferReader): Draft14Message {
  const request_id = r.readVarInt();
  const error_code = r.readVarInt();
  const reason_phrase = r.readString();
  return { type: "subscribe_namespace_error", request_id, error_code, reason_phrase };
}

function decodeUnsubscribeNamespacePayload(r: BufferReader): Draft14Message {
  const request_id = r.readVarInt();
  return { type: "unsubscribe_namespace", request_id };
}

function decodeFetchPayload(r: BufferReader): Draft14Message {
  const request_id = r.readVarInt();
  const track_namespace = r.readTuple();
  const track_name = r.readString();
  const start_group = r.readVarInt();
  const start_object = r.readVarInt();
  const end_group = r.readVarInt();
  const parameters = decodeParams(r);
  return {
    type: "fetch",
    request_id,
    track_namespace,
    track_name,
    start_group,
    start_object,
    end_group,
    parameters,
  };
}

function decodeFetchOkPayload(r: BufferReader): Draft14Message {
  const request_id = r.readVarInt();
  const track_alias = r.readVarInt();
  const end_of_track = r.readVarInt();
  const parameters = decodeParams(r);
  return { type: "fetch_ok", request_id, track_alias, end_of_track, parameters };
}

function decodeFetchErrorPayload(r: BufferReader): Draft14Message {
  const request_id = r.readVarInt();
  const error_code = r.readVarInt();
  const reason_phrase = r.readString();
  return { type: "fetch_error", request_id, error_code, reason_phrase };
}

function decodeFetchCancelPayload(r: BufferReader): Draft14Message {
  const request_id = r.readVarInt();
  return { type: "fetch_cancel", request_id };
}

function decodeTrackStatusPayload(r: BufferReader): Draft14Message {
  const request_id = r.readVarInt();
  const track_namespace = r.readTuple();
  const track_name = r.readString();
  const parameters = decodeParams(r);
  return { type: "track_status", request_id, track_namespace, track_name, parameters };
}

function decodeTrackStatusOkPayload(r: BufferReader): Draft14Message {
  const request_id = r.readVarInt();
  const status_code = r.readVarInt();
  const sc = Number(status_code);

  let largest_group: bigint | undefined;
  let largest_object: bigint | undefined;

  if (sc === 0 || sc === 3) {
    largest_group = r.readVarInt();
    largest_object = r.readVarInt();
  }

  const parameters = decodeParams(r);

  return {
    type: "track_status_ok",
    request_id,
    status_code,
    parameters,
    ...(largest_group !== undefined ? { largest_group, largest_object } : {}),
  } as Draft14Message;
}

function decodeTrackStatusErrorPayload(r: BufferReader): Draft14Message {
  const request_id = r.readVarInt();
  const error_code = r.readVarInt();
  const reason_phrase = r.readString();
  return { type: "track_status_error", request_id, error_code, reason_phrase };
}

function decodeGoAwayPayload(r: BufferReader): Draft14Message {
  const new_session_uri = r.readString();
  return { type: "goaway", new_session_uri };
}

function decodeMaxRequestIdPayload(r: BufferReader): Draft14Message {
  const request_id = r.readVarInt();
  return { type: "max_request_id", request_id };
}

function decodeRequestsBlockedPayload(r: BufferReader): Draft14Message {
  const request_id = r.readVarInt();
  return { type: "requests_blocked", request_id };
}

// ─── Payload dispatch tables ───────────────────────────────────────────────────

const payloadDecoders: ReadonlyMap<bigint, (r: BufferReader) => Draft14Message> = new Map([
  [MSG_CLIENT_SETUP, decodeClientSetupPayload],
  [MSG_SERVER_SETUP, decodeServerSetupPayload],
  [MSG_SUBSCRIBE, decodeSubscribePayload],
  [MSG_SUBSCRIBE_OK, decodeSubscribeOkPayload],
  [MSG_SUBSCRIBE_UPDATE, decodeSubscribeUpdatePayload],
  [MSG_SUBSCRIBE_ERROR, decodeSubscribeErrorPayload],
  [MSG_UNSUBSCRIBE, decodeUnsubscribePayload],
  [MSG_PUBLISH, decodePublishPayload],
  [MSG_PUBLISH_OK, decodePublishOkPayload],
  [MSG_PUBLISH_ERROR, decodePublishErrorPayload],
  [MSG_PUBLISH_DONE, decodePublishDonePayload],
  [MSG_PUBLISH_NAMESPACE, decodePublishNamespacePayload],
  [MSG_PUBLISH_NAMESPACE_OK, decodePublishNamespaceOkPayload],
  [MSG_PUBLISH_NAMESPACE_ERROR, decodePublishNamespaceErrorPayload],
  [MSG_PUBLISH_NAMESPACE_DONE, decodePublishNamespaceDonePayload],
  [MSG_PUBLISH_NAMESPACE_CANCEL, decodePublishNamespaceCancelPayload],
  [MSG_SUBSCRIBE_NAMESPACE, decodeSubscribeNamespacePayload],
  [MSG_SUBSCRIBE_NAMESPACE_OK, decodeSubscribeNamespaceOkPayload],
  [MSG_SUBSCRIBE_NAMESPACE_ERROR, decodeSubscribeNamespaceErrorPayload],
  [MSG_UNSUBSCRIBE_NAMESPACE, decodeUnsubscribeNamespacePayload],
  [MSG_FETCH, decodeFetchPayload],
  [MSG_FETCH_OK, decodeFetchOkPayload],
  [MSG_FETCH_ERROR, decodeFetchErrorPayload],
  [MSG_FETCH_CANCEL, decodeFetchCancelPayload],
  [MSG_TRACK_STATUS, decodeTrackStatusPayload],
  [MSG_TRACK_STATUS_OK, decodeTrackStatusOkPayload],
  [MSG_TRACK_STATUS_ERROR, decodeTrackStatusErrorPayload],
  [MSG_GOAWAY, decodeGoAwayPayload],
  [MSG_MAX_REQUEST_ID, decodeMaxRequestIdPayload],
  [MSG_REQUESTS_BLOCKED, decodeRequestsBlockedPayload],
]);

// ─── Public API ────────────────────────────────────────────────────────────────

/**
 * Encode a draft-14 control message with type(varint) + length(uint16 BE) + payload.
 */
export function encodeMessage(message: Draft14Message): Uint8Array {
  const typeId = MESSAGE_ID_MAP.get(message.type);
  if (typeId === undefined) {
    throw new Error(`Unknown message type: ${message.type}`);
  }

  // Encode payload into a separate buffer
  const payloadWriter = new BufferWriter();
  encodePayload(message, payloadWriter);
  const payload = payloadWriter.finishView();

  if (payload.byteLength > 0xffff) {
    throw new Error(`Payload too large for 16-bit length: ${payload.byteLength}`);
  }

  // Write framed message: type(varint) + length(uint16 BE) + payload
  const writer = new BufferWriter(payload.byteLength + 16);
  writer.writeVarInt(typeId);
  writer.writeUint8((payload.byteLength >> 8) & 0xff);
  writer.writeUint8(payload.byteLength & 0xff);
  writer.writeBytes(payload);

  return writer.finish();
}

function encodePayload(msg: Draft14Message, w: BufferWriter): void {
  switch (msg.type) {
    case "client_setup":
      return encodeClientSetupPayload(msg, w);
    case "server_setup":
      return encodeServerSetupPayload(msg, w);
    case "subscribe":
      return encodeSubscribePayload(msg, w);
    case "subscribe_ok":
      return encodeSubscribeOkPayload(msg, w);
    case "subscribe_update":
      return encodeSubscribeUpdatePayload(msg, w);
    case "subscribe_error":
      return encodeSubscribeErrorPayload(msg, w);
    case "unsubscribe":
      return encodeUnsubscribePayload(msg, w);
    case "publish":
      return encodePublishPayload(msg, w);
    case "publish_ok":
      return encodePublishOkPayload(msg, w);
    case "publish_error":
      return encodePublishErrorPayload(msg, w);
    case "publish_done":
      return encodePublishDonePayload(msg, w);
    case "publish_namespace":
      return encodePublishNamespacePayload(msg, w);
    case "publish_namespace_ok":
      return encodePublishNamespaceOkPayload(msg, w);
    case "publish_namespace_error":
      return encodePublishNamespaceErrorPayload(msg, w);
    case "publish_namespace_done":
      return encodePublishNamespaceDonePayload(msg, w);
    case "publish_namespace_cancel":
      return encodePublishNamespaceCancelPayload(msg, w);
    case "subscribe_namespace":
      return encodeSubscribeNamespacePayload(msg, w);
    case "subscribe_namespace_ok":
      return encodeSubscribeNamespaceOkPayload(msg, w);
    case "subscribe_namespace_error":
      return encodeSubscribeNamespaceErrorPayload(msg, w);
    case "unsubscribe_namespace":
      return encodeUnsubscribeNamespacePayload(msg, w);
    case "fetch":
      return encodeFetchPayload(msg, w);
    case "fetch_ok":
      return encodeFetchOkPayload(msg, w);
    case "fetch_error":
      return encodeFetchErrorPayload(msg, w);
    case "fetch_cancel":
      return encodeFetchCancelPayload(msg, w);
    case "track_status":
      return encodeTrackStatusPayload(msg, w);
    case "track_status_ok":
      return encodeTrackStatusOkPayload(msg, w);
    case "track_status_error":
      return encodeTrackStatusErrorPayload(msg, w);
    case "goaway":
      return encodeGoAwayPayload(msg, w);
    case "max_request_id":
      return encodeMaxRequestIdPayload(msg, w);
    case "requests_blocked":
      return encodeRequestsBlockedPayload(msg, w);
    default: {
      const _exhaustive: never = msg;
      throw new Error(`Unhandled message type: ${(_exhaustive as Draft14Message).type}`);
    }
  }
}

/**
 * Decode a draft-14 control message from bytes (type + uint16 length + payload).
 */
export function decodeMessage(bytes: Uint8Array): DecodeResult<Draft14Message> {
  try {
    const reader = new BufferReader(bytes);
    const typeId = reader.readVarInt();

    // Read 16-bit big-endian payload length
    const lenHi = reader.readUint8();
    const lenLo = reader.readUint8();
    const payloadLength = (lenHi << 8) | lenLo;

    // Read exactly payloadLength bytes
    const payloadBytes = reader.readBytes(payloadLength);
    const payloadReader = new BufferReader(payloadBytes);

    const decoder = payloadDecoders.get(typeId);
    if (!decoder) {
      return {
        ok: false,
        error: new DecodeError(
          "UNKNOWN_MESSAGE_TYPE",
          `Unknown message type ID: 0x${typeId.toString(16)}`,
          0,
        ),
      };
    }

    const message = decoder(payloadReader);
    return { ok: true, value: message, bytesRead: reader.offset };
  } catch (e) {
    if (e instanceof DecodeError) {
      return { ok: false, error: e };
    }
    throw e;
  }
}

// ─── Data Stream Re-exports ───────────────────────────────────────────────────

import {
  encodeSubgroupStream,
  decodeSubgroupStream,
  encodeDatagram,
  decodeDatagram,
  encodeFetchStream,
  decodeFetchStream,
  decodeDataStream,
  createSubgroupStreamDecoder,
  createFetchStreamDecoder,
  createDataStreamDecoder,
} from "./data-streams.js";

export {
  encodeSubgroupStream,
  decodeSubgroupStream,
  encodeDatagram,
  decodeDatagram,
  encodeFetchStream,
  decodeFetchStream,
  decodeDataStream,
  createSubgroupStreamDecoder,
  createFetchStreamDecoder,
  createDataStreamDecoder,
};

// ─── Stream Decoders ───────────────────────────────────────────────────────────

/**
 * Create a TransformStream that decodes a continuous byte stream (e.g. the
 * WebTransport bidirectional control stream) into individual Draft14Message
 * objects.  Uses the varint(type) + uint16_BE(length) + payload framing.
 */
export function createStreamDecoder(): TransformStream<Uint8Array, Draft14Message> {
  let buffer = new Uint8Array(0);
  let offset = 0;

  return new TransformStream<Uint8Array, Draft14Message>({
    transform(chunk, controller) {
      // Compact before accumulating new data
      if (offset > 0) {
        buffer = buffer.subarray(offset);
        offset = 0;
      }
      const newBuffer = new Uint8Array(buffer.length + chunk.length);
      newBuffer.set(buffer, 0);
      newBuffer.set(chunk, buffer.length);
      buffer = newBuffer;

      // Try to decode messages from the buffer
      while (offset < buffer.length) {
        const result = decodeMessage(buffer.subarray(offset));
        if (!result.ok) {
          if (result.error.code === "UNEXPECTED_END") {
            // Need more data -- wait for next chunk
            break;
          }
          // Fatal decode error
          controller.error(result.error);
          return;
        }
        controller.enqueue(result.value);
        // Advance offset past the consumed bytes
        offset += result.bytesRead;
      }
    },

    flush(controller) {
      // If there is remaining data in the buffer, it is a truncated message
      if (offset < buffer.length) {
        controller.error(
          new DecodeError("UNEXPECTED_END", "Stream ended with incomplete message data", 0),
        );
      }
    },
  });
}

// ─── Codec Factory ─────────────────────────────────────────────────────────────

export interface Draft14Codec extends BaseCodec<Draft14Message> {
  readonly draft: "draft-ietf-moq-transport-14";
  encodeSubgroupStream(stream: SubgroupStream): Uint8Array;
  encodeDatagram(dg: DatagramObject): Uint8Array;
  encodeFetchStream(stream: FetchStream): Uint8Array;
  decodeSubgroupStream(bytes: Uint8Array): DecodeResult<SubgroupStream>;
  decodeDatagram(bytes: Uint8Array): DecodeResult<DatagramObject>;
  decodeFetchStream(bytes: Uint8Array): DecodeResult<FetchStream>;
  decodeDataStream(
    streamType: "subgroup" | "datagram" | "fetch",
    bytes: Uint8Array,
  ): DecodeResult<Draft14DataStream>;
  createStreamDecoder(): TransformStream<Uint8Array, Draft14Message>;
  createSubgroupStreamDecoder(): TransformStream<Uint8Array, SubgroupStreamHeader | ObjectPayload>;
  createFetchStreamDecoder(): TransformStream<Uint8Array, FetchStreamHeader | ObjectPayload>;
  createDataStreamDecoder(): TransformStream<Uint8Array, DataStreamEvent>;
}

export function createDraft14Codec(): Draft14Codec {
  return {
    draft: "draft-ietf-moq-transport-14",
    encodeMessage,
    decodeMessage,
    encodeSubgroupStream,
    encodeDatagram,
    encodeFetchStream,
    decodeSubgroupStream,
    decodeDatagram,
    decodeFetchStream,
    decodeDataStream,
    createStreamDecoder,
    createSubgroupStreamDecoder,
    createFetchStreamDecoder,
    createDataStreamDecoder,
  };
}
