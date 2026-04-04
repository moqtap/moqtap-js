import { bytesToHex, hexToBytes } from "../../core/hex.js";
import { BufferReader } from "../../core/buffer-reader.js";
import { BufferWriter } from "../../core/buffer-writer.js";
import type { BaseCodec, DecodeResult } from "../../core/types.js";
import { DecodeError } from "../../core/types.js";
import {
  MESSAGE_ID_MAP,
  MSG_ANNOUNCE,
  MSG_ANNOUNCE_CANCEL,
  MSG_ANNOUNCE_ERROR,
  MSG_ANNOUNCE_OK,
  MSG_CLIENT_SETUP,
  MSG_FETCH,
  MSG_FETCH_CANCEL,
  MSG_FETCH_ERROR,
  MSG_FETCH_OK,
  MSG_GOAWAY,
  MSG_MAX_REQUEST_ID,
  MSG_PUBLISH,
  MSG_PUBLISH_ERROR,
  MSG_PUBLISH_OK,
  MSG_REQUESTS_BLOCKED,
  MSG_SERVER_SETUP,
  MSG_SUBSCRIBE,
  MSG_SUBSCRIBE_ANNOUNCES,
  MSG_SUBSCRIBE_ANNOUNCES_ERROR,
  MSG_SUBSCRIBE_ANNOUNCES_OK,
  MSG_SUBSCRIBE_DONE,
  MSG_SUBSCRIBE_ERROR,
  MSG_SUBSCRIBE_OK,
  MSG_SUBSCRIBE_UPDATE,
  MSG_TRACK_STATUS,
  MSG_TRACK_STATUS_REQUEST,
  MSG_UNANNOUNCE,
  MSG_UNSUBSCRIBE,
  MSG_UNSUBSCRIBE_ANNOUNCES,
  PARAM_AUTHORIZATION_TOKEN,
  PARAM_DELIVERY_TIMEOUT,
  SETUP_PARAM_MAX_REQUEST_ID,
  SETUP_PARAM_PATH,
} from "./messages.js";
import type {
  DatagramObject,
  Draft12DataStream,
  Draft12Fetch,
  Draft12Message,
  Draft12Params,
  Draft12SetupParams,
  FetchObjectPayload,
  FetchStream,
  JoiningFetch,
  LargestLocation,
  ObjectPayload,
  StandaloneFetch,
  SubgroupStream,
  UnknownParam,
} from "./types.js";

const textEncoder = /* @__PURE__ */ new TextEncoder();
const textDecoder = /* @__PURE__ */ new TextDecoder();

// ─── Setup Parameter Encoding/Decoding (even/odd convention) ────────────────────

function encodeSetupParams(params: Draft12SetupParams, w: BufferWriter): void {
  let count = 0;
  if (params.path !== undefined) count++;
  if (params.max_request_id !== undefined) count++;
  if (params.unknown) count += params.unknown.length;

  w.writeVarInt(count);

  if (params.path !== undefined) {
    w.writeVarInt(SETUP_PARAM_PATH);
    const encoded = textEncoder.encode(params.path);
    w.writeVarInt(encoded.byteLength);
    w.writeBytes(encoded);
  }
  if (params.max_request_id !== undefined) {
    w.writeVarInt(SETUP_PARAM_MAX_REQUEST_ID);
    w.writeVarInt(params.max_request_id);
  }
  if (params.unknown) {
    for (const u of params.unknown) {
      const id = BigInt(u.id);
      w.writeVarInt(id);
      if (id % 2n === 0n) {
        const raw = hexToBytes(u.raw_hex);
        const tmpReader = new BufferReader(raw);
        w.writeVarInt(tmpReader.readVarInt());
      } else {
        const raw = hexToBytes(u.raw_hex);
        w.writeVarInt(raw.byteLength);
        w.writeBytes(raw);
      }
    }
  }
}

function decodeSetupParams(r: BufferReader): Draft12SetupParams {
  const count = Number(r.readVarInt());
  const result: Draft12SetupParams = {};
  const unknown: UnknownParam[] = [];

  for (let i = 0; i < count; i++) {
    const paramType = r.readVarInt();
    if (paramType % 2n === 0n) {
      const value = r.readVarInt();
      if (paramType === SETUP_PARAM_MAX_REQUEST_ID) {
        result.max_request_id = value;
      } else {
        const tmpW = new BufferWriter(16);
        tmpW.writeVarInt(value);
        const raw = tmpW.finish();
        unknown.push({
          id: `0x${paramType.toString(16)}`,
          length: raw.byteLength,
          raw_hex: bytesToHex(raw),
        });
      }
    } else {
      const length = Number(r.readVarInt());
      const bytes = r.readBytes(length);
      if (paramType === SETUP_PARAM_PATH) {
        result.path = textDecoder.decode(bytes);
      } else {
        unknown.push({ id: `0x${paramType.toString(16)}`, length, raw_hex: bytesToHex(bytes) });
      }
    }
  }

  if (unknown.length > 0) result.unknown = unknown;
  return result;
}

// ─── Version-Specific Parameter Encoding/Decoding ───────────────────────────────
// Uses even/odd convention: even type → bare varint value, odd type → length-prefixed blob

function encodeParams(params: Draft12Params, w: BufferWriter): void {
  let count = params.unknown ? params.unknown.length : 0;
  if (params.authorization_token !== undefined) count++;
  if (params.delivery_timeout !== undefined) count++;
  w.writeVarInt(count);

  if (params.authorization_token !== undefined) {
    // AUTHORIZATION_TOKEN = 0x01 (odd → length-prefixed)
    w.writeVarInt(PARAM_AUTHORIZATION_TOKEN);
    const at = params.authorization_token;
    const tmpW = new BufferWriter(64);
    tmpW.writeVarInt(at.alias_type);
    tmpW.writeVarInt(at.token_type);
    const tokenBytes = textEncoder.encode(at.token_value);
    tmpW.writeBytes(tokenBytes);
    const raw = tmpW.finish();
    w.writeVarInt(raw.byteLength);
    w.writeBytes(raw);
  }
  if (params.delivery_timeout !== undefined) {
    // DELIVERY_TIMEOUT = 0x03 (odd → length-prefixed varint)
    w.writeVarInt(PARAM_DELIVERY_TIMEOUT);
    const tmpW = new BufferWriter(16);
    tmpW.writeVarInt(params.delivery_timeout);
    const raw = tmpW.finish();
    w.writeVarInt(raw.byteLength);
    w.writeBytes(raw);
  }
  if (params.unknown) {
    for (const u of params.unknown) {
      const id = BigInt(u.id);
      w.writeVarInt(id);
      if (id % 2n === 0n) {
        // Even → bare varint
        const raw = hexToBytes(u.raw_hex);
        const tmpReader = new BufferReader(raw);
        w.writeVarInt(tmpReader.readVarInt());
      } else {
        // Odd → length-prefixed
        const raw = hexToBytes(u.raw_hex);
        w.writeVarInt(raw.byteLength);
        w.writeBytes(raw);
      }
    }
  }
}

function decodeParams(r: BufferReader): Draft12Params {
  const count = Number(r.readVarInt());
  const result: Draft12Params = {};
  const unknown: UnknownParam[] = [];

  for (let i = 0; i < count; i++) {
    const paramType = r.readVarInt();

    if (paramType % 2n === 0n) {
      // Even type → bare varint value
      const value = r.readVarInt();
      const tmpW = new BufferWriter(16);
      tmpW.writeVarInt(value);
      const raw = tmpW.finish();
      unknown.push({
        id: `0x${paramType.toString(16)}`,
        length: raw.byteLength,
        raw_hex: bytesToHex(raw),
      });
    } else {
      // Odd type → length-prefixed blob
      const length = Number(r.readVarInt());
      const startOff = r.offset;

      if (paramType === PARAM_AUTHORIZATION_TOKEN) {
        const alias_type = r.readVarInt();
        const token_type = r.readVarInt();
        const tokenBytesLen = length - (r.offset - startOff);
        const tokenBytes = r.readBytes(tokenBytesLen);
        result.authorization_token = {
          alias_type,
          token_type,
          token_value: textDecoder.decode(tokenBytes),
        };
      } else if (paramType === PARAM_DELIVERY_TIMEOUT) {
        const blob = r.readBytes(length);
        const tmpReader = new BufferReader(blob);
        result.delivery_timeout = tmpReader.readVarInt();
      } else {
        const bytes = r.readBytes(length);
        unknown.push({ id: `0x${paramType.toString(16)}`, length, raw_hex: bytesToHex(bytes) });
      }
    }
  }

  if (unknown.length > 0) result.unknown = unknown;
  return result;
}

// ─── Payload Encoders ──────────────────────────────────────────────────────────

function encodeClientSetupPayload(
  msg: Draft12Message & { type: "client_setup" },
  w: BufferWriter,
): void {
  w.writeVarInt(msg.supported_versions.length);
  for (const v of msg.supported_versions) w.writeVarInt(v);
  encodeSetupParams(msg.parameters, w);
}

function encodeServerSetupPayload(
  msg: Draft12Message & { type: "server_setup" },
  w: BufferWriter,
): void {
  w.writeVarInt(msg.selected_version);
  encodeSetupParams(msg.parameters, w);
}

function encodeSubscribePayload(
  msg: Draft12Message & { type: "subscribe" },
  w: BufferWriter,
): void {
  w.writeVarInt(msg.request_id);
  // Draft-12: no track_alias in subscribe (moved to subscribe_ok)
  w.writeTuple(msg.track_namespace);
  w.writeString(msg.track_name);
  w.writeUint8(msg.subscriber_priority);
  w.writeVarInt(msg.group_order);
  w.writeVarInt(msg.forward);
  w.writeVarInt(msg.filter_type);
  const ft = Number(msg.filter_type);
  if (ft === 3 || ft === 4) {
    w.writeVarInt(msg.start_group!);
    w.writeVarInt(msg.start_object!);
  }
  if (ft === 4) {
    w.writeVarInt(msg.end_group!);
  }
  encodeParams(msg.parameters, w);
}

function encodeSubscribeOkPayload(
  msg: Draft12Message & { type: "subscribe_ok" },
  w: BufferWriter,
): void {
  w.writeVarInt(msg.request_id);
  w.writeVarInt(msg.track_alias);
  w.writeVarInt(msg.expires);
  w.writeVarInt(msg.group_order);
  w.writeVarInt(msg.content_exists);
  if (msg.content_exists === 1n && msg.largest_location) {
    w.writeVarInt(msg.largest_location.group);
    w.writeVarInt(msg.largest_location.object);
  }
  encodeParams(msg.parameters, w);
}

function encodeSubscribeErrorPayload(
  msg: Draft12Message & { type: "subscribe_error" },
  w: BufferWriter,
): void {
  w.writeVarInt(msg.request_id);
  w.writeVarInt(msg.error_code);
  w.writeString(msg.reason_phrase);
  // Draft-12: no track_alias in subscribe_error
}

function encodeSubscribeUpdatePayload(
  msg: Draft12Message & { type: "subscribe_update" },
  w: BufferWriter,
): void {
  w.writeVarInt(msg.request_id);
  w.writeVarInt(msg.start_group);
  w.writeVarInt(msg.start_object);
  w.writeVarInt(msg.end_group);
  w.writeUint8(msg.subscriber_priority);
  w.writeVarInt(msg.forward);
  encodeParams(msg.parameters, w);
}

function encodeSubscribeDonePayload(
  msg: Draft12Message & { type: "subscribe_done" },
  w: BufferWriter,
): void {
  w.writeVarInt(msg.request_id);
  w.writeVarInt(msg.status_code);
  w.writeVarInt(msg.stream_count);
  w.writeString(msg.reason_phrase);
}

function encodeUnsubscribePayload(
  msg: Draft12Message & { type: "unsubscribe" },
  w: BufferWriter,
): void {
  w.writeVarInt(msg.request_id);
}

function encodeAnnouncePayload(msg: Draft12Message & { type: "announce" }, w: BufferWriter): void {
  w.writeVarInt(msg.request_id);
  w.writeTuple(msg.track_namespace);
  encodeParams(msg.parameters, w);
}

function encodeAnnounceOkPayload(
  msg: Draft12Message & { type: "announce_ok" },
  w: BufferWriter,
): void {
  w.writeVarInt(msg.request_id);
}

function encodeAnnounceErrorPayload(
  msg: Draft12Message & { type: "announce_error" },
  w: BufferWriter,
): void {
  w.writeVarInt(msg.request_id);
  w.writeVarInt(msg.error_code);
  w.writeString(msg.reason_phrase);
}

function encodeUnannouncePayload(
  msg: Draft12Message & { type: "unannounce" },
  w: BufferWriter,
): void {
  w.writeTuple(msg.track_namespace);
}

function encodeAnnounceCancelPayload(
  msg: Draft12Message & { type: "announce_cancel" },
  w: BufferWriter,
): void {
  w.writeTuple(msg.track_namespace);
  w.writeVarInt(msg.error_code);
  w.writeString(msg.reason_phrase);
}

function encodeSubscribeAnnouncesPayload(
  msg: Draft12Message & { type: "subscribe_announces" },
  w: BufferWriter,
): void {
  w.writeVarInt(msg.request_id);
  w.writeTuple(msg.track_namespace_prefix);
  encodeParams(msg.parameters, w);
}

function encodeSubscribeAnnouncesOkPayload(
  msg: Draft12Message & { type: "subscribe_announces_ok" },
  w: BufferWriter,
): void {
  w.writeVarInt(msg.request_id);
}

function encodeSubscribeAnnouncesErrorPayload(
  msg: Draft12Message & { type: "subscribe_announces_error" },
  w: BufferWriter,
): void {
  w.writeVarInt(msg.request_id);
  w.writeVarInt(msg.error_code);
  w.writeString(msg.reason_phrase);
}

function encodeUnsubscribeAnnouncesPayload(
  msg: Draft12Message & { type: "unsubscribe_announces" },
  w: BufferWriter,
): void {
  w.writeTuple(msg.track_namespace_prefix);
}

function encodePublishPayload(msg: Draft12Message & { type: "publish" }, w: BufferWriter): void {
  w.writeVarInt(msg.request_id);
  w.writeTuple(msg.track_namespace);
  w.writeString(msg.track_name);
  w.writeVarInt(msg.track_alias);
  w.writeVarInt(msg.group_order);
  w.writeVarInt(msg.content_exists);
  if (msg.content_exists === 1n && msg.largest_location) {
    w.writeVarInt(msg.largest_location.group);
    w.writeVarInt(msg.largest_location.object);
  }
  w.writeVarInt(msg.forward);
  encodeParams(msg.parameters, w);
}

function encodePublishOkPayload(
  msg: Draft12Message & { type: "publish_ok" },
  w: BufferWriter,
): void {
  w.writeVarInt(msg.request_id);
  w.writeVarInt(msg.forward);
  w.writeUint8(msg.subscriber_priority);
  w.writeVarInt(msg.group_order);
  w.writeVarInt(msg.filter_type);
  const ft = Number(msg.filter_type);
  if (ft === 3 || ft === 4) {
    w.writeVarInt(msg.start_group!);
    w.writeVarInt(msg.start_object!);
  }
  if (ft === 4) {
    w.writeVarInt(msg.end_group!);
  }
  encodeParams(msg.parameters, w);
}

function encodePublishErrorPayload(
  msg: Draft12Message & { type: "publish_error" },
  w: BufferWriter,
): void {
  w.writeVarInt(msg.request_id);
  w.writeVarInt(msg.error_code);
  w.writeString(msg.reason_phrase);
}

function encodeFetchPayload(msg: Draft12Message & { type: "fetch" }, w: BufferWriter): void {
  w.writeVarInt(msg.request_id);
  w.writeUint8(msg.subscriber_priority);
  w.writeVarInt(msg.group_order);
  w.writeVarInt(msg.fetch_type);
  const ft = Number(msg.fetch_type);
  if (ft === 1 && msg.standalone) {
    w.writeTuple(msg.standalone.track_namespace);
    w.writeString(msg.standalone.track_name);
    w.writeVarInt(msg.standalone.start_group);
    w.writeVarInt(msg.standalone.start_object);
    w.writeVarInt(msg.standalone.end_group);
    w.writeVarInt(msg.standalone.end_object);
  } else if ((ft === 2 || ft === 3) && msg.joining) {
    w.writeVarInt(msg.joining.joining_subscribe_id);
    w.writeVarInt(msg.joining.joining_start);
  }
  encodeParams(msg.parameters, w);
}

function encodeFetchOkPayload(msg: Draft12Message & { type: "fetch_ok" }, w: BufferWriter): void {
  w.writeVarInt(msg.request_id);
  w.writeVarInt(msg.group_order);
  w.writeVarInt(msg.end_of_track);
  w.writeVarInt(msg.end_location.group);
  w.writeVarInt(msg.end_location.object);
  encodeParams(msg.parameters, w);
}

function encodeFetchErrorPayload(
  msg: Draft12Message & { type: "fetch_error" },
  w: BufferWriter,
): void {
  w.writeVarInt(msg.request_id);
  w.writeVarInt(msg.error_code);
  w.writeString(msg.reason_phrase);
}

function encodeFetchCancelPayload(
  msg: Draft12Message & { type: "fetch_cancel" },
  w: BufferWriter,
): void {
  w.writeVarInt(msg.request_id);
}

function encodeTrackStatusRequestPayload(
  msg: Draft12Message & { type: "track_status_request" },
  w: BufferWriter,
): void {
  w.writeVarInt(msg.request_id);
  w.writeTuple(msg.track_namespace);
  w.writeString(msg.track_name);
  encodeParams(msg.parameters, w);
}

function encodeTrackStatusPayload(
  msg: Draft12Message & { type: "track_status" },
  w: BufferWriter,
): void {
  w.writeVarInt(msg.request_id);
  w.writeVarInt(msg.status_code);
  w.writeVarInt(msg.largest_location.group);
  w.writeVarInt(msg.largest_location.object);
  encodeParams(msg.parameters, w);
}

function encodeGoAwayPayload(msg: Draft12Message & { type: "goaway" }, w: BufferWriter): void {
  w.writeString(msg.new_session_uri);
}

function encodeMaxRequestIdPayload(
  msg: Draft12Message & { type: "max_request_id" },
  w: BufferWriter,
): void {
  w.writeVarInt(msg.request_id);
}

function encodeRequestsBlockedPayload(
  msg: Draft12Message & { type: "requests_blocked" },
  w: BufferWriter,
): void {
  w.writeVarInt(msg.maximum_request_id);
}

// ─── Payload Decoders ──────────────────────────────────────────────────────────

function decodeClientSetupPayload(r: BufferReader): Draft12Message {
  const numVersions = Number(r.readVarInt());
  if (numVersions === 0) {
    throw new DecodeError("CONSTRAINT_VIOLATION", "supported_versions must not be empty", r.offset);
  }
  const supported_versions: bigint[] = [];
  for (let i = 0; i < numVersions; i++) supported_versions.push(r.readVarInt());
  const parameters = decodeSetupParams(r);
  return { type: "client_setup", supported_versions, parameters };
}

function decodeServerSetupPayload(r: BufferReader): Draft12Message {
  const selected_version = r.readVarInt();
  const parameters = decodeSetupParams(r);
  return { type: "server_setup", selected_version, parameters };
}

function decodeSubscribePayload(r: BufferReader): Draft12Message {
  const request_id = r.readVarInt();
  // Draft-12: no track_alias in subscribe
  const track_namespace = r.readTuple();
  const track_name = r.readString();
  const subscriber_priority = r.readUint8();
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
  if (ft === 3 || ft === 4) {
    start_group = r.readVarInt();
    start_object = r.readVarInt();
  }
  if (ft === 4) {
    end_group = r.readVarInt();
  }
  const parameters = decodeParams(r);
  const msg: Record<string, unknown> = {
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
  if (start_group !== undefined) msg.start_group = start_group;
  if (start_object !== undefined) msg.start_object = start_object;
  if (end_group !== undefined) msg.end_group = end_group;
  return msg as unknown as Draft12Message;
}

function decodeSubscribeOkPayload(r: BufferReader): Draft12Message {
  const request_id = r.readVarInt();
  const track_alias = r.readVarInt();
  const expires = r.readVarInt();
  const group_order = r.readVarInt();
  const content_exists = r.readVarInt();
  let largest_location: LargestLocation | undefined;
  if (content_exists === 1n) {
    const group = r.readVarInt();
    const object = r.readVarInt();
    largest_location = { group, object };
  }
  const parameters = decodeParams(r);
  const msg: Record<string, unknown> = {
    type: "subscribe_ok",
    request_id,
    track_alias,
    expires,
    group_order,
    content_exists,
    parameters,
  };
  if (largest_location) msg.largest_location = largest_location;
  return msg as unknown as Draft12Message;
}

function decodeSubscribeErrorPayload(r: BufferReader): Draft12Message {
  const request_id = r.readVarInt();
  const error_code = r.readVarInt();
  const reason_phrase = r.readString();
  // Draft-12: no track_alias in subscribe_error
  return { type: "subscribe_error", request_id, error_code, reason_phrase };
}

function decodeSubscribeUpdatePayload(r: BufferReader): Draft12Message {
  const request_id = r.readVarInt();
  const start_group = r.readVarInt();
  const start_object = r.readVarInt();
  const end_group = r.readVarInt();
  const subscriber_priority = r.readUint8();
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

function decodeSubscribeDonePayload(r: BufferReader): Draft12Message {
  const request_id = r.readVarInt();
  const status_code = r.readVarInt();
  const stream_count = r.readVarInt();
  const reason_phrase = r.readString();
  return { type: "subscribe_done", request_id, status_code, stream_count, reason_phrase };
}

function decodeUnsubscribePayload(r: BufferReader): Draft12Message {
  const request_id = r.readVarInt();
  return { type: "unsubscribe", request_id };
}

function decodeAnnouncePayload(r: BufferReader): Draft12Message {
  const request_id = r.readVarInt();
  const track_namespace = r.readTuple();
  const parameters = decodeParams(r);
  return { type: "announce", request_id, track_namespace, parameters };
}

function decodeAnnounceOkPayload(r: BufferReader): Draft12Message {
  const request_id = r.readVarInt();
  return { type: "announce_ok", request_id };
}

function decodeAnnounceErrorPayload(r: BufferReader): Draft12Message {
  const request_id = r.readVarInt();
  const error_code = r.readVarInt();
  const reason_phrase = r.readString();
  return { type: "announce_error", request_id, error_code, reason_phrase };
}

function decodeUnannouncePayload(r: BufferReader): Draft12Message {
  const track_namespace = r.readTuple();
  return { type: "unannounce", track_namespace };
}

function decodeAnnounceCancelPayload(r: BufferReader): Draft12Message {
  const track_namespace = r.readTuple();
  const error_code = r.readVarInt();
  const reason_phrase = r.readString();
  return { type: "announce_cancel", track_namespace, error_code, reason_phrase };
}

function decodeSubscribeAnnouncesPayload(r: BufferReader): Draft12Message {
  const request_id = r.readVarInt();
  const track_namespace_prefix = r.readTuple();
  const parameters = decodeParams(r);
  return { type: "subscribe_announces", request_id, track_namespace_prefix, parameters };
}

function decodeSubscribeAnnouncesOkPayload(r: BufferReader): Draft12Message {
  const request_id = r.readVarInt();
  return { type: "subscribe_announces_ok", request_id };
}

function decodeSubscribeAnnouncesErrorPayload(r: BufferReader): Draft12Message {
  const request_id = r.readVarInt();
  const error_code = r.readVarInt();
  const reason_phrase = r.readString();
  return { type: "subscribe_announces_error", request_id, error_code, reason_phrase };
}

function decodeUnsubscribeAnnouncesPayload(r: BufferReader): Draft12Message {
  const track_namespace_prefix = r.readTuple();
  return { type: "unsubscribe_announces", track_namespace_prefix };
}

function decodePublishPayload(r: BufferReader): Draft12Message {
  const request_id = r.readVarInt();
  const track_namespace = r.readTuple();
  const track_name = r.readString();
  const track_alias = r.readVarInt();
  const group_order = r.readVarInt();
  const content_exists = r.readVarInt();
  let largest_location: LargestLocation | undefined;
  if (content_exists === 1n) {
    const group = r.readVarInt();
    const object = r.readVarInt();
    largest_location = { group, object };
  }
  const forward = r.readVarInt();
  const parameters = decodeParams(r);
  const msg: Record<string, unknown> = {
    type: "publish",
    request_id,
    track_namespace,
    track_name,
    track_alias,
    group_order,
    content_exists,
    forward,
    parameters,
  };
  if (largest_location) msg.largest_location = largest_location;
  return msg as unknown as Draft12Message;
}

function decodePublishOkPayload(r: BufferReader): Draft12Message {
  const request_id = r.readVarInt();
  const forward = r.readVarInt();
  const subscriber_priority = r.readUint8();
  const group_order = r.readVarInt();
  const filter_type = r.readVarInt();
  const ft = Number(filter_type);
  let start_group: bigint | undefined;
  let start_object: bigint | undefined;
  let end_group: bigint | undefined;
  if (ft === 3 || ft === 4) {
    start_group = r.readVarInt();
    start_object = r.readVarInt();
  }
  if (ft === 4) {
    end_group = r.readVarInt();
  }
  const parameters = decodeParams(r);
  const msg: Record<string, unknown> = {
    type: "publish_ok",
    request_id,
    forward,
    subscriber_priority,
    group_order,
    filter_type,
    parameters,
  };
  if (start_group !== undefined) msg.start_group = start_group;
  if (start_object !== undefined) msg.start_object = start_object;
  if (end_group !== undefined) msg.end_group = end_group;
  return msg as unknown as Draft12Message;
}

function decodePublishErrorPayload(r: BufferReader): Draft12Message {
  const request_id = r.readVarInt();
  const error_code = r.readVarInt();
  const reason_phrase = r.readString();
  return { type: "publish_error", request_id, error_code, reason_phrase };
}

function decodeFetchPayload(r: BufferReader): Draft12Message {
  const request_id = r.readVarInt();
  const subscriber_priority = r.readUint8();
  const group_order = r.readVarInt();
  const fetch_type = r.readVarInt();
  const ft = Number(fetch_type);

  if (ft < 1 || ft > 3) {
    throw new DecodeError("CONSTRAINT_VIOLATION", `Invalid fetch_type: ${ft}`, r.offset);
  }

  let standalone: StandaloneFetch | undefined;
  let joining: JoiningFetch | undefined;

  if (ft === 1) {
    const track_namespace = r.readTuple();
    const track_name = r.readString();
    const start_group = r.readVarInt();
    const start_object = r.readVarInt();
    const end_group = r.readVarInt();
    const end_object = r.readVarInt();
    standalone = { track_namespace, track_name, start_group, start_object, end_group, end_object };
  } else {
    const joining_subscribe_id = r.readVarInt();
    const joining_start = r.readVarInt();
    joining = { joining_subscribe_id, joining_start };
  }

  const parameters = decodeParams(r);
  return {
    type: "fetch",
    request_id,
    subscriber_priority,
    group_order,
    fetch_type,
    standalone,
    joining,
    parameters,
  } as Draft12Fetch;
}

function decodeFetchOkPayload(r: BufferReader): Draft12Message {
  const request_id = r.readVarInt();
  const group_order = r.readVarInt();
  const end_of_track = r.readVarInt();
  const group = r.readVarInt();
  const object = r.readVarInt();
  const parameters = decodeParams(r);
  return {
    type: "fetch_ok",
    request_id,
    group_order,
    end_of_track,
    end_location: { group, object },
    parameters,
  };
}

function decodeFetchErrorPayload(r: BufferReader): Draft12Message {
  const request_id = r.readVarInt();
  const error_code = r.readVarInt();
  const reason_phrase = r.readString();
  return { type: "fetch_error", request_id, error_code, reason_phrase };
}

function decodeFetchCancelPayload(r: BufferReader): Draft12Message {
  const request_id = r.readVarInt();
  return { type: "fetch_cancel", request_id };
}

function decodeTrackStatusRequestPayload(r: BufferReader): Draft12Message {
  const request_id = r.readVarInt();
  const track_namespace = r.readTuple();
  const track_name = r.readString();
  const parameters = decodeParams(r);
  return { type: "track_status_request", request_id, track_namespace, track_name, parameters };
}

function decodeTrackStatusPayload(r: BufferReader): Draft12Message {
  const request_id = r.readVarInt();
  const status_code = r.readVarInt();
  const group = r.readVarInt();
  const object = r.readVarInt();
  const parameters = decodeParams(r);
  return {
    type: "track_status",
    request_id,
    status_code,
    largest_location: { group, object },
    parameters,
  };
}

function decodeGoAwayPayload(r: BufferReader): Draft12Message {
  const new_session_uri = r.readString();
  return { type: "goaway", new_session_uri };
}

function decodeMaxRequestIdPayload(r: BufferReader): Draft12Message {
  const request_id = r.readVarInt();
  return { type: "max_request_id", request_id };
}

function decodeRequestsBlockedPayload(r: BufferReader): Draft12Message {
  const maximum_request_id = r.readVarInt();
  return { type: "requests_blocked", maximum_request_id };
}

// ─── Payload dispatch tables ───────────────────────────────────────────────────

const payloadDecoders: ReadonlyMap<bigint, (r: BufferReader) => Draft12Message> = new Map([
  [MSG_CLIENT_SETUP, decodeClientSetupPayload],
  [MSG_SERVER_SETUP, decodeServerSetupPayload],
  [MSG_SUBSCRIBE, decodeSubscribePayload],
  [MSG_SUBSCRIBE_OK, decodeSubscribeOkPayload],
  [MSG_SUBSCRIBE_ERROR, decodeSubscribeErrorPayload],
  [MSG_SUBSCRIBE_UPDATE, decodeSubscribeUpdatePayload],
  [MSG_SUBSCRIBE_DONE, decodeSubscribeDonePayload],
  [MSG_UNSUBSCRIBE, decodeUnsubscribePayload],
  [MSG_ANNOUNCE, decodeAnnouncePayload],
  [MSG_ANNOUNCE_OK, decodeAnnounceOkPayload],
  [MSG_ANNOUNCE_ERROR, decodeAnnounceErrorPayload],
  [MSG_UNANNOUNCE, decodeUnannouncePayload],
  [MSG_ANNOUNCE_CANCEL, decodeAnnounceCancelPayload],
  [MSG_SUBSCRIBE_ANNOUNCES, decodeSubscribeAnnouncesPayload],
  [MSG_SUBSCRIBE_ANNOUNCES_OK, decodeSubscribeAnnouncesOkPayload],
  [MSG_SUBSCRIBE_ANNOUNCES_ERROR, decodeSubscribeAnnouncesErrorPayload],
  [MSG_UNSUBSCRIBE_ANNOUNCES, decodeUnsubscribeAnnouncesPayload],
  [MSG_PUBLISH, decodePublishPayload],
  [MSG_PUBLISH_OK, decodePublishOkPayload],
  [MSG_PUBLISH_ERROR, decodePublishErrorPayload],
  [MSG_FETCH, decodeFetchPayload],
  [MSG_FETCH_OK, decodeFetchOkPayload],
  [MSG_FETCH_ERROR, decodeFetchErrorPayload],
  [MSG_FETCH_CANCEL, decodeFetchCancelPayload],
  [MSG_TRACK_STATUS_REQUEST, decodeTrackStatusRequestPayload],
  [MSG_TRACK_STATUS, decodeTrackStatusPayload],
  [MSG_GOAWAY, decodeGoAwayPayload],
  [MSG_MAX_REQUEST_ID, decodeMaxRequestIdPayload],
  [MSG_REQUESTS_BLOCKED, decodeRequestsBlockedPayload],
]);

// ─── Public API ────────────────────────────────────────────────────────────────

/**
 * Encode a draft-12 control message.
 * Most messages use type(varint) + length(uint16 BE) + payload.
 * PUBLISH family uses type(varint) + length(varint) + payload.
 */
export function encodeMessage(message: Draft12Message): Uint8Array {
  const typeId = MESSAGE_ID_MAP.get(message.type);
  if (typeId === undefined) throw new Error(`Unknown message type: ${message.type}`);

  const payloadWriter = new BufferWriter();
  encodePayload(message, payloadWriter);
  const payload = payloadWriter.finishView();

  const writer = new BufferWriter(payload.byteLength + 16);
  writer.writeVarInt(typeId);

  if (payload.byteLength > 0xffff) {
    throw new Error(`Payload too large for 16-bit length: ${payload.byteLength}`);
  }
  writer.writeUint8((payload.byteLength >> 8) & 0xff);
  writer.writeUint8(payload.byteLength & 0xff);

  writer.writeBytes(payload);
  return writer.finish();
}

function encodePayload(msg: Draft12Message, w: BufferWriter): void {
  switch (msg.type) {
    case "client_setup":
      return encodeClientSetupPayload(msg, w);
    case "server_setup":
      return encodeServerSetupPayload(msg, w);
    case "subscribe":
      return encodeSubscribePayload(msg, w);
    case "subscribe_ok":
      return encodeSubscribeOkPayload(msg, w);
    case "subscribe_error":
      return encodeSubscribeErrorPayload(msg, w);
    case "subscribe_update":
      return encodeSubscribeUpdatePayload(msg, w);
    case "subscribe_done":
      return encodeSubscribeDonePayload(msg, w);
    case "unsubscribe":
      return encodeUnsubscribePayload(msg, w);
    case "announce":
      return encodeAnnouncePayload(msg, w);
    case "announce_ok":
      return encodeAnnounceOkPayload(msg, w);
    case "announce_error":
      return encodeAnnounceErrorPayload(msg, w);
    case "unannounce":
      return encodeUnannouncePayload(msg, w);
    case "announce_cancel":
      return encodeAnnounceCancelPayload(msg, w);
    case "subscribe_announces":
      return encodeSubscribeAnnouncesPayload(msg, w);
    case "subscribe_announces_ok":
      return encodeSubscribeAnnouncesOkPayload(msg, w);
    case "subscribe_announces_error":
      return encodeSubscribeAnnouncesErrorPayload(msg, w);
    case "unsubscribe_announces":
      return encodeUnsubscribeAnnouncesPayload(msg, w);
    case "publish":
      return encodePublishPayload(msg, w);
    case "publish_ok":
      return encodePublishOkPayload(msg, w);
    case "publish_error":
      return encodePublishErrorPayload(msg, w);
    case "fetch":
      return encodeFetchPayload(msg, w);
    case "fetch_ok":
      return encodeFetchOkPayload(msg, w);
    case "fetch_error":
      return encodeFetchErrorPayload(msg, w);
    case "fetch_cancel":
      return encodeFetchCancelPayload(msg, w);
    case "track_status_request":
      return encodeTrackStatusRequestPayload(msg, w);
    case "track_status":
      return encodeTrackStatusPayload(msg, w);
    case "goaway":
      return encodeGoAwayPayload(msg, w);
    case "max_request_id":
      return encodeMaxRequestIdPayload(msg, w);
    case "requests_blocked":
      return encodeRequestsBlockedPayload(msg, w);
    default: {
      const _exhaustive: never = msg;
      throw new Error(`Unhandled message type: ${(_exhaustive as Draft12Message).type}`);
    }
  }
}

/**
 * Decode a draft-12 control message from bytes.
 */
export function decodeMessage(bytes: Uint8Array): DecodeResult<Draft12Message> {
  try {
    const reader = new BufferReader(bytes);
    const typeId = reader.readVarInt();

    // Read 16-bit big-endian payload length
    const lenHi = reader.readUint8();
    const lenLo = reader.readUint8();
    const payloadLength = (lenHi << 8) | lenLo;

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
    if (e instanceof DecodeError) return { ok: false, error: e };
    throw e;
  }
}

// ─── Data Stream Encoding/Decoding ─────────────────────────────────────────────

export { encodeSubgroupStream, encodeDatagram, encodeFetchStream, decodeSubgroupStream, decodeDatagram, decodeFetchStream, decodeDataStream } from "./data-streams.js";
import { encodeSubgroupStream, encodeDatagram, encodeFetchStream, decodeSubgroupStream, decodeDatagram, decodeFetchStream, decodeDataStream } from "./data-streams.js";

export function createStreamDecoder(): TransformStream<Uint8Array, Draft12Message> {
  let buffer = new Uint8Array(0);
  let offset = 0;
  return new TransformStream<Uint8Array, Draft12Message>({
    transform(chunk, controller) {
      if (offset > 0) {
        buffer = buffer.subarray(offset);
        offset = 0;
      }
      const newBuffer = new Uint8Array(buffer.length + chunk.length);
      newBuffer.set(buffer, 0);
      newBuffer.set(chunk, buffer.length);
      buffer = newBuffer;
      while (offset < buffer.length) {
        const result = decodeMessage(buffer.subarray(offset));
        if (!result.ok) {
          if (result.error.code === "UNEXPECTED_END") break;
          controller.error(result.error);
          return;
        }
        controller.enqueue(result.value);
        offset += result.bytesRead;
      }
    },
    flush(controller) {
      if (offset < buffer.length)
        controller.error(new DecodeError("UNEXPECTED_END", "Stream ended with incomplete data", 0));
    },
  });
}

// ─── Codec Factory ─────────────────────────────────────────────────────────────

export interface Draft12Codec extends BaseCodec<Draft12Message> {
  readonly draft: "draft-ietf-moq-transport-12";
  encodeSubgroupStream(stream: SubgroupStream): Uint8Array;
  encodeDatagram(dg: DatagramObject): Uint8Array;
  encodeFetchStream(stream: FetchStream): Uint8Array;
  decodeSubgroupStream(bytes: Uint8Array): DecodeResult<SubgroupStream>;
  decodeDatagram(bytes: Uint8Array): DecodeResult<DatagramObject>;
  decodeFetchStream(bytes: Uint8Array): DecodeResult<FetchStream>;
  decodeDataStream(
    streamType: "subgroup" | "datagram" | "fetch",
    bytes: Uint8Array,
  ): DecodeResult<Draft12DataStream>;
  createStreamDecoder(): TransformStream<Uint8Array, Draft12Message>;
}

export function createDraft12Codec(): Draft12Codec {
  return {
    draft: "draft-ietf-moq-transport-12",
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
  };
}
