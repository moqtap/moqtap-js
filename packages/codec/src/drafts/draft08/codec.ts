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
  MSG_MAX_SUBSCRIBE_ID,
  MSG_SERVER_SETUP,
  MSG_SUBSCRIBE,
  MSG_SUBSCRIBE_ANNOUNCES,
  MSG_SUBSCRIBE_ANNOUNCES_ERROR,
  MSG_SUBSCRIBE_ANNOUNCES_OK,
  MSG_SUBSCRIBE_DONE,
  MSG_SUBSCRIBE_ERROR,
  MSG_SUBSCRIBE_OK,
  MSG_SUBSCRIBE_UPDATE,
  MSG_SUBSCRIBES_BLOCKED,
  MSG_TRACK_STATUS,
  MSG_TRACK_STATUS_REQUEST,
  MSG_UNANNOUNCE,
  MSG_UNSUBSCRIBE,
  MSG_UNSUBSCRIBE_ANNOUNCES,
  PARAM_AUTHORIZATION_INFO,
  PARAM_DELIVERY_TIMEOUT,
  PARAM_MAX_CACHE_DURATION,
  SETUP_PARAM_MAX_SUBSCRIBE_ID,
  SETUP_PARAM_PATH,
} from "./messages.js";
import type {
  DatagramObject,
  DatagramStatusObject,
  Draft08DataStream,
  Draft08Fetch,
  Draft08Message,
  Draft08Params,
  Draft08SetupParams,
  FetchObjectPayload,
  FetchStream,
  JoiningFetch,
  ObjectPayload,
  StandaloneFetch,
  SubgroupStream,
  UnknownParam,
} from "./types.js";

// ─── Helpers ───────────────────────────────────────────────────────────────────

function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    hex += (bytes[i] as number).toString(16).padStart(2, "0");
  }
  return hex;
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

// ─── Setup Parameter Encoding/Decoding (all type+length+value) ──────────────

function encodeSetupParams(params: Draft08SetupParams, w: BufferWriter): void {
  let count = 0;
  if (params.path !== undefined) count++;
  if (params.max_subscribe_id !== undefined) count++;
  if (params.unknown) count += params.unknown.length;

  w.writeVarInt(count);

  if (params.path !== undefined) {
    w.writeVarInt(SETUP_PARAM_PATH);
    const encoded = new TextEncoder().encode(params.path);
    w.writeVarInt(encoded.byteLength);
    w.writeBytes(encoded);
  }
  if (params.max_subscribe_id !== undefined) {
    w.writeVarInt(SETUP_PARAM_MAX_SUBSCRIBE_ID);
    const tmpW = new BufferWriter(16);
    tmpW.writeVarInt(params.max_subscribe_id);
    const raw = tmpW.finish();
    w.writeVarInt(raw.byteLength);
    w.writeBytes(raw);
  }
  // unknown params: all are type + length + raw_hex bytes
  if (params.unknown) {
    for (const u of params.unknown) {
      w.writeVarInt(BigInt(u.id));
      const raw = hexToBytes(u.raw_hex);
      w.writeVarInt(raw.byteLength);
      w.writeBytes(raw);
    }
  }
}

function decodeSetupParams(r: BufferReader): Draft08SetupParams {
  const count = Number(r.readVarInt());
  const result: Draft08SetupParams = {};
  const unknown: UnknownParam[] = [];

  for (let i = 0; i < count; i++) {
    const paramType = r.readVarInt();
    const length = Number(r.readVarInt());

    if (paramType === SETUP_PARAM_PATH) {
      const bytes = r.readBytes(length);
      result.path = new TextDecoder().decode(bytes);
    } else if (paramType === SETUP_PARAM_MAX_SUBSCRIBE_ID) {
      const blob = r.readBytes(length);
      const tmpReader = new BufferReader(blob);
      result.max_subscribe_id = tmpReader.readVarInt();
    } else {
      const bytes = r.readBytes(length);
      unknown.push({ id: `0x${paramType.toString(16)}`, length, raw_hex: bytesToHex(bytes) });
    }
  }

  if (unknown.length > 0) result.unknown = unknown;
  return result;
}

// ─── Version-Specific Parameter Encoding/Decoding (all type+length+value) ────

function encodeParams(params: Draft08Params, w: BufferWriter): void {
  let count = params.unknown ? params.unknown.length : 0;
  if (params.authorization_info !== undefined) count++;
  if (params.delivery_timeout !== undefined) count++;
  if (params.max_cache_duration !== undefined) count++;
  w.writeVarInt(count);

  if (params.authorization_info !== undefined) {
    w.writeVarInt(PARAM_AUTHORIZATION_INFO);
    const encoded = new TextEncoder().encode(params.authorization_info);
    w.writeVarInt(encoded.byteLength);
    w.writeBytes(encoded);
  }
  if (params.delivery_timeout !== undefined) {
    w.writeVarInt(PARAM_DELIVERY_TIMEOUT);
    const tmpW = new BufferWriter(16);
    tmpW.writeVarInt(params.delivery_timeout);
    const raw = tmpW.finish();
    w.writeVarInt(raw.byteLength);
    w.writeBytes(raw);
  }
  if (params.max_cache_duration !== undefined) {
    w.writeVarInt(PARAM_MAX_CACHE_DURATION);
    const tmpW = new BufferWriter(16);
    tmpW.writeVarInt(params.max_cache_duration);
    const raw = tmpW.finish();
    w.writeVarInt(raw.byteLength);
    w.writeBytes(raw);
  }
  if (params.unknown) {
    for (const u of params.unknown) {
      w.writeVarInt(BigInt(u.id));
      const raw = hexToBytes(u.raw_hex);
      w.writeVarInt(raw.byteLength);
      w.writeBytes(raw);
    }
  }
}

function decodeParams(r: BufferReader): Draft08Params {
  const count = Number(r.readVarInt());
  const result: Draft08Params = {};
  const unknown: UnknownParam[] = [];

  for (let i = 0; i < count; i++) {
    const paramType = r.readVarInt();
    const length = Number(r.readVarInt());

    if (paramType === PARAM_AUTHORIZATION_INFO) {
      const bytes = r.readBytes(length);
      result.authorization_info = new TextDecoder().decode(bytes);
    } else if (paramType === PARAM_DELIVERY_TIMEOUT) {
      const blob = r.readBytes(length);
      const tmpReader = new BufferReader(blob);
      result.delivery_timeout = tmpReader.readVarInt();
    } else if (paramType === PARAM_MAX_CACHE_DURATION) {
      const blob = r.readBytes(length);
      const tmpReader = new BufferReader(blob);
      result.max_cache_duration = tmpReader.readVarInt();
    } else {
      const bytes = r.readBytes(length);
      unknown.push({ id: `0x${paramType.toString(16)}`, length, raw_hex: bytesToHex(bytes) });
    }
  }

  if (unknown.length > 0) result.unknown = unknown;
  return result;
}

// ─── Payload Encoders ──────────────────────────────────────────────────────────

function encodeClientSetupPayload(
  msg: Draft08Message & { type: "client_setup" },
  w: BufferWriter,
): void {
  w.writeVarInt(msg.supported_versions.length);
  for (const v of msg.supported_versions) w.writeVarInt(v);
  encodeSetupParams(msg.parameters, w);
}

function encodeServerSetupPayload(
  msg: Draft08Message & { type: "server_setup" },
  w: BufferWriter,
): void {
  w.writeVarInt(msg.selected_version);
  encodeSetupParams(msg.parameters, w);
}

function encodeSubscribePayload(
  msg: Draft08Message & { type: "subscribe" },
  w: BufferWriter,
): void {
  w.writeVarInt(msg.subscribe_id);
  w.writeVarInt(msg.track_alias);
  w.writeTuple(msg.track_namespace);
  w.writeString(msg.track_name);
  w.writeUint8(msg.subscriber_priority);
  w.writeUint8(msg.group_order);
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
  msg: Draft08Message & { type: "subscribe_ok" },
  w: BufferWriter,
): void {
  w.writeVarInt(msg.subscribe_id);
  w.writeVarInt(msg.expires);
  w.writeUint8(msg.group_order);
  w.writeUint8(msg.content_exists);
  if (msg.content_exists === 1) {
    w.writeVarInt(msg.largest_group_id!);
    w.writeVarInt(msg.largest_object_id!);
  }
  encodeParams(msg.parameters, w);
}

function encodeSubscribeErrorPayload(
  msg: Draft08Message & { type: "subscribe_error" },
  w: BufferWriter,
): void {
  w.writeVarInt(msg.subscribe_id);
  w.writeVarInt(msg.error_code);
  w.writeString(msg.reason_phrase);
  w.writeVarInt(msg.track_alias);
}

function encodeSubscribeUpdatePayload(
  msg: Draft08Message & { type: "subscribe_update" },
  w: BufferWriter,
): void {
  w.writeVarInt(msg.subscribe_id);
  w.writeVarInt(msg.start_group);
  w.writeVarInt(msg.start_object);
  w.writeVarInt(msg.end_group);
  w.writeUint8(msg.subscriber_priority);
  encodeParams(msg.parameters, w);
}

function encodeSubscribeDonePayload(
  msg: Draft08Message & { type: "subscribe_done" },
  w: BufferWriter,
): void {
  w.writeVarInt(msg.subscribe_id);
  w.writeVarInt(msg.status_code);
  w.writeVarInt(msg.stream_count);
  w.writeString(msg.reason_phrase);
}

function encodeUnsubscribePayload(
  msg: Draft08Message & { type: "unsubscribe" },
  w: BufferWriter,
): void {
  w.writeVarInt(msg.subscribe_id);
}

function encodeAnnouncePayload(msg: Draft08Message & { type: "announce" }, w: BufferWriter): void {
  w.writeTuple(msg.track_namespace);
  encodeParams(msg.parameters, w);
}

function encodeAnnounceOkPayload(
  msg: Draft08Message & { type: "announce_ok" },
  w: BufferWriter,
): void {
  w.writeTuple(msg.track_namespace);
}

function encodeAnnounceErrorPayload(
  msg: Draft08Message & { type: "announce_error" },
  w: BufferWriter,
): void {
  w.writeTuple(msg.track_namespace);
  w.writeVarInt(msg.error_code);
  w.writeString(msg.reason_phrase);
}

function encodeUnannouncePayload(
  msg: Draft08Message & { type: "unannounce" },
  w: BufferWriter,
): void {
  w.writeTuple(msg.track_namespace);
}

function encodeAnnounceCancelPayload(
  msg: Draft08Message & { type: "announce_cancel" },
  w: BufferWriter,
): void {
  w.writeTuple(msg.track_namespace);
  w.writeVarInt(msg.error_code);
  w.writeString(msg.reason_phrase);
}

function encodeSubscribeAnnouncesPayload(
  msg: Draft08Message & { type: "subscribe_announces" },
  w: BufferWriter,
): void {
  w.writeTuple(msg.track_namespace_prefix);
  encodeParams(msg.parameters, w);
}

function encodeSubscribeAnnouncesOkPayload(
  msg: Draft08Message & { type: "subscribe_announces_ok" },
  w: BufferWriter,
): void {
  w.writeTuple(msg.track_namespace_prefix);
}

function encodeSubscribeAnnouncesErrorPayload(
  msg: Draft08Message & { type: "subscribe_announces_error" },
  w: BufferWriter,
): void {
  w.writeTuple(msg.track_namespace_prefix);
  w.writeVarInt(msg.error_code);
  w.writeString(msg.reason_phrase);
}

function encodeUnsubscribeAnnouncesPayload(
  msg: Draft08Message & { type: "unsubscribe_announces" },
  w: BufferWriter,
): void {
  w.writeTuple(msg.track_namespace_prefix);
}

function encodeFetchPayload(msg: Draft08Message & { type: "fetch" }, w: BufferWriter): void {
  w.writeVarInt(msg.subscribe_id);
  w.writeUint8(msg.subscriber_priority);
  w.writeUint8(msg.group_order);
  w.writeVarInt(msg.fetch_type);
  const ft = Number(msg.fetch_type);
  if (ft === 1 && msg.standalone) {
    w.writeTuple(msg.standalone.track_namespace);
    w.writeString(msg.standalone.track_name);
    w.writeVarInt(msg.standalone.start_group);
    w.writeVarInt(msg.standalone.start_object);
    w.writeVarInt(msg.standalone.end_group);
    w.writeVarInt(msg.standalone.end_object);
  } else if (ft === 2 && msg.joining) {
    w.writeVarInt(msg.joining.joining_subscribe_id);
    w.writeVarInt(msg.joining.preceding_group_offset);
  }
  encodeParams(msg.parameters, w);
}

function encodeFetchOkPayload(msg: Draft08Message & { type: "fetch_ok" }, w: BufferWriter): void {
  w.writeVarInt(msg.subscribe_id);
  w.writeUint8(msg.group_order);
  w.writeUint8(msg.end_of_track);
  w.writeVarInt(msg.largest_group_id);
  w.writeVarInt(msg.largest_object_id);
  encodeParams(msg.parameters, w);
}

function encodeFetchErrorPayload(
  msg: Draft08Message & { type: "fetch_error" },
  w: BufferWriter,
): void {
  w.writeVarInt(msg.subscribe_id);
  w.writeVarInt(msg.error_code);
  w.writeString(msg.reason_phrase);
}

function encodeFetchCancelPayload(
  msg: Draft08Message & { type: "fetch_cancel" },
  w: BufferWriter,
): void {
  w.writeVarInt(msg.subscribe_id);
}

function encodeTrackStatusRequestPayload(
  msg: Draft08Message & { type: "track_status_request" },
  w: BufferWriter,
): void {
  w.writeTuple(msg.track_namespace);
  w.writeString(msg.track_name);
}

function encodeTrackStatusPayload(
  msg: Draft08Message & { type: "track_status" },
  w: BufferWriter,
): void {
  w.writeTuple(msg.track_namespace);
  w.writeString(msg.track_name);
  w.writeVarInt(msg.status_code);
  w.writeVarInt(msg.last_group_id);
  w.writeVarInt(msg.last_object_id);
}

function encodeGoAwayPayload(msg: Draft08Message & { type: "goaway" }, w: BufferWriter): void {
  w.writeString(msg.new_session_uri);
}

function encodeMaxSubscribeIdPayload(
  msg: Draft08Message & { type: "max_subscribe_id" },
  w: BufferWriter,
): void {
  w.writeVarInt(msg.subscribe_id);
}

function encodeSubscribesBlockedPayload(
  msg: Draft08Message & { type: "subscribes_blocked" },
  w: BufferWriter,
): void {
  w.writeVarInt(msg.maximum_subscribe_id);
}

// ─── Payload Decoders ──────────────────────────────────────────────────────────

function decodeClientSetupPayload(r: BufferReader): Draft08Message {
  const numVersions = Number(r.readVarInt());
  if (numVersions === 0) {
    throw new DecodeError("CONSTRAINT_VIOLATION", "supported_versions must not be empty", r.offset);
  }
  const supported_versions: bigint[] = [];
  for (let i = 0; i < numVersions; i++) supported_versions.push(r.readVarInt());
  const parameters = decodeSetupParams(r);
  return { type: "client_setup", supported_versions, parameters };
}

function decodeServerSetupPayload(r: BufferReader): Draft08Message {
  const selected_version = r.readVarInt();
  const parameters = decodeSetupParams(r);
  return { type: "server_setup", selected_version, parameters };
}

function decodeSubscribePayload(r: BufferReader): Draft08Message {
  const subscribe_id = r.readVarInt();
  const track_alias = r.readVarInt();
  const track_namespace = r.readTuple();
  const track_name = r.readString();
  const subscriber_priority = r.readUint8();
  const group_order = r.readUint8();
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
    subscribe_id,
    track_alias,
    track_namespace,
    track_name,
    subscriber_priority,
    group_order,
    filter_type,
    parameters,
  };
  if (start_group !== undefined) msg.start_group = start_group;
  if (start_object !== undefined) msg.start_object = start_object;
  if (end_group !== undefined) msg.end_group = end_group;
  return msg as unknown as Draft08Message;
}

function decodeSubscribeOkPayload(r: BufferReader): Draft08Message {
  const subscribe_id = r.readVarInt();
  const expires = r.readVarInt();
  const group_order = r.readUint8();
  const content_exists = r.readUint8();
  let largest_group_id: bigint | undefined;
  let largest_object_id: bigint | undefined;
  if (content_exists === 1) {
    largest_group_id = r.readVarInt();
    largest_object_id = r.readVarInt();
  }
  const parameters = decodeParams(r);
  const msg: Record<string, unknown> = {
    type: "subscribe_ok",
    subscribe_id,
    expires,
    group_order,
    content_exists,
    parameters,
  };
  if (largest_group_id !== undefined) msg.largest_group_id = largest_group_id;
  if (largest_object_id !== undefined) msg.largest_object_id = largest_object_id;
  return msg as unknown as Draft08Message;
}

function decodeSubscribeErrorPayload(r: BufferReader): Draft08Message {
  const subscribe_id = r.readVarInt();
  const error_code = r.readVarInt();
  const reason_phrase = r.readString();
  const track_alias = r.readVarInt();
  return { type: "subscribe_error", subscribe_id, error_code, reason_phrase, track_alias };
}

function decodeSubscribeUpdatePayload(r: BufferReader): Draft08Message {
  const subscribe_id = r.readVarInt();
  const start_group = r.readVarInt();
  const start_object = r.readVarInt();
  const end_group = r.readVarInt();
  const subscriber_priority = r.readUint8();
  const parameters = decodeParams(r);
  return {
    type: "subscribe_update",
    subscribe_id,
    start_group,
    start_object,
    end_group,
    subscriber_priority,
    parameters,
  };
}

function decodeSubscribeDonePayload(r: BufferReader): Draft08Message {
  const subscribe_id = r.readVarInt();
  const status_code = r.readVarInt();
  const stream_count = r.readVarInt();
  const reason_phrase = r.readString();
  return { type: "subscribe_done", subscribe_id, status_code, stream_count, reason_phrase };
}

function decodeUnsubscribePayload(r: BufferReader): Draft08Message {
  const subscribe_id = r.readVarInt();
  return { type: "unsubscribe", subscribe_id };
}

function decodeAnnouncePayload(r: BufferReader): Draft08Message {
  const track_namespace = r.readTuple();
  const parameters = decodeParams(r);
  return { type: "announce", track_namespace, parameters };
}

function decodeAnnounceOkPayload(r: BufferReader): Draft08Message {
  const track_namespace = r.readTuple();
  return { type: "announce_ok", track_namespace };
}

function decodeAnnounceErrorPayload(r: BufferReader): Draft08Message {
  const track_namespace = r.readTuple();
  const error_code = r.readVarInt();
  const reason_phrase = r.readString();
  return { type: "announce_error", track_namespace, error_code, reason_phrase };
}

function decodeUnannouncePayload(r: BufferReader): Draft08Message {
  const track_namespace = r.readTuple();
  return { type: "unannounce", track_namespace };
}

function decodeAnnounceCancelPayload(r: BufferReader): Draft08Message {
  const track_namespace = r.readTuple();
  const error_code = r.readVarInt();
  const reason_phrase = r.readString();
  return { type: "announce_cancel", track_namespace, error_code, reason_phrase };
}

function decodeSubscribeAnnouncesPayload(r: BufferReader): Draft08Message {
  const track_namespace_prefix = r.readTuple();
  const parameters = decodeParams(r);
  return { type: "subscribe_announces", track_namespace_prefix, parameters };
}

function decodeSubscribeAnnouncesOkPayload(r: BufferReader): Draft08Message {
  const track_namespace_prefix = r.readTuple();
  return { type: "subscribe_announces_ok", track_namespace_prefix };
}

function decodeSubscribeAnnouncesErrorPayload(r: BufferReader): Draft08Message {
  const track_namespace_prefix = r.readTuple();
  const error_code = r.readVarInt();
  const reason_phrase = r.readString();
  return { type: "subscribe_announces_error", track_namespace_prefix, error_code, reason_phrase };
}

function decodeUnsubscribeAnnouncesPayload(r: BufferReader): Draft08Message {
  const track_namespace_prefix = r.readTuple();
  return { type: "unsubscribe_announces", track_namespace_prefix };
}

function decodeFetchPayload(r: BufferReader): Draft08Message {
  const subscribe_id = r.readVarInt();
  const subscriber_priority = r.readUint8();
  const group_order = r.readUint8();
  const fetch_type = r.readVarInt();
  const ft = Number(fetch_type);

  if (ft < 1 || ft > 2) {
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
    const preceding_group_offset = r.readVarInt();
    joining = { joining_subscribe_id, preceding_group_offset };
  }

  const parameters = decodeParams(r);
  return {
    type: "fetch",
    subscribe_id,
    subscriber_priority,
    group_order,
    fetch_type,
    standalone,
    joining,
    parameters,
  } as Draft08Fetch;
}

function decodeFetchOkPayload(r: BufferReader): Draft08Message {
  const subscribe_id = r.readVarInt();
  const group_order = r.readUint8();
  const end_of_track = r.readUint8();
  const largest_group_id = r.readVarInt();
  const largest_object_id = r.readVarInt();
  const parameters = decodeParams(r);
  return {
    type: "fetch_ok",
    subscribe_id,
    group_order,
    end_of_track,
    largest_group_id,
    largest_object_id,
    parameters,
  };
}

function decodeFetchErrorPayload(r: BufferReader): Draft08Message {
  const subscribe_id = r.readVarInt();
  const error_code = r.readVarInt();
  const reason_phrase = r.readString();
  return { type: "fetch_error", subscribe_id, error_code, reason_phrase };
}

function decodeFetchCancelPayload(r: BufferReader): Draft08Message {
  const subscribe_id = r.readVarInt();
  return { type: "fetch_cancel", subscribe_id };
}

function decodeTrackStatusRequestPayload(r: BufferReader): Draft08Message {
  const track_namespace = r.readTuple();
  const track_name = r.readString();
  return { type: "track_status_request", track_namespace, track_name };
}

function decodeTrackStatusPayload(r: BufferReader): Draft08Message {
  const track_namespace = r.readTuple();
  const track_name = r.readString();
  const status_code = r.readVarInt();
  const last_group_id = r.readVarInt();
  const last_object_id = r.readVarInt();
  return {
    type: "track_status",
    track_namespace,
    track_name,
    status_code,
    last_group_id,
    last_object_id,
  };
}

function decodeGoAwayPayload(r: BufferReader): Draft08Message {
  const new_session_uri = r.readString();
  return { type: "goaway", new_session_uri };
}

function decodeMaxSubscribeIdPayload(r: BufferReader): Draft08Message {
  const subscribe_id = r.readVarInt();
  return { type: "max_subscribe_id", subscribe_id };
}

function decodeSubscribesBlockedPayload(r: BufferReader): Draft08Message {
  const maximum_subscribe_id = r.readVarInt();
  return { type: "subscribes_blocked", maximum_subscribe_id };
}

// ─── Payload dispatch tables ───────────────────────────────────────────────────

const payloadDecoders: ReadonlyMap<bigint, (r: BufferReader) => Draft08Message> = new Map([
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
  [MSG_FETCH, decodeFetchPayload],
  [MSG_FETCH_OK, decodeFetchOkPayload],
  [MSG_FETCH_ERROR, decodeFetchErrorPayload],
  [MSG_FETCH_CANCEL, decodeFetchCancelPayload],
  [MSG_TRACK_STATUS_REQUEST, decodeTrackStatusRequestPayload],
  [MSG_TRACK_STATUS, decodeTrackStatusPayload],
  [MSG_GOAWAY, decodeGoAwayPayload],
  [MSG_MAX_SUBSCRIBE_ID, decodeMaxSubscribeIdPayload],
  [MSG_SUBSCRIBES_BLOCKED, decodeSubscribesBlockedPayload],
]);

// ─── Public API ────────────────────────────────────────────────────────────────

/**
 * Encode a draft-08 control message.
 * All messages use varint type + varint length + payload framing.
 */
export function encodeMessage(message: Draft08Message): Uint8Array {
  const typeId = MESSAGE_ID_MAP.get(message.type);
  if (typeId === undefined) throw new Error(`Unknown message type: ${message.type}`);

  const payloadWriter = new BufferWriter();
  encodePayload(message, payloadWriter);
  const payload = payloadWriter.finish();

  const writer = new BufferWriter();
  writer.writeVarInt(typeId);
  writer.writeVarInt(payload.byteLength);
  writer.writeBytes(payload);
  return writer.finish();
}

function encodePayload(msg: Draft08Message, w: BufferWriter): void {
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
    case "max_subscribe_id":
      return encodeMaxSubscribeIdPayload(msg, w);
    case "subscribes_blocked":
      return encodeSubscribesBlockedPayload(msg, w);
    default: {
      const _exhaustive: never = msg;
      throw new Error(`Unhandled message type: ${(_exhaustive as Draft08Message).type}`);
    }
  }
}

/**
 * Decode a draft-08 control message from bytes.
 * All messages use varint type + varint length + payload framing.
 */
export function decodeMessage(bytes: Uint8Array): DecodeResult<Draft08Message> {
  try {
    const reader = new BufferReader(bytes);
    const typeId = reader.readVarInt();
    const payloadLength = Number(reader.readVarInt());
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
    // extension count
    w.writeVarInt(0);
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
  // extension count
  w.writeVarInt(0);
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
    // extension count
    w.writeVarInt(0);
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
      const objectId = r.readVarInt();
      // skip extensions
      const extensionCount = Number(r.readVarInt());
      for (let i = 0; i < extensionCount; i++) {
        r.readVarInt(); // extension type
        const extLen = Number(r.readVarInt());
        r.readBytes(extLen); // extension value
      }
      const payloadLength = Number(r.readVarInt());
      let payload: Uint8Array;
      let status: bigint | undefined;
      if (payloadLength === 0) {
        status = r.readVarInt();
        payload = new Uint8Array(0);
      } else {
        payload = r.readBytes(payloadLength);
      }
      const obj: ObjectPayload = {
        type: "object",
        objectId,
        extensionCount: BigInt(extensionCount),
        payloadLength,
        payload,
      };
      if (status !== undefined) (obj as Record<string, unknown>).status = status;
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
    // skip extensions
    const extensionCount = Number(r.readVarInt());
    for (let i = 0; i < extensionCount; i++) {
      r.readVarInt(); // extension type
      const extLen = Number(r.readVarInt());
      r.readBytes(extLen); // extension value
    }
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
      const groupId = r.readVarInt();
      const subgroupId = r.readVarInt();
      const objectId = r.readVarInt();
      const publisherPriority = r.readUint8();
      // skip extensions
      const extensionCount = Number(r.readVarInt());
      for (let i = 0; i < extensionCount; i++) {
        r.readVarInt(); // extension type
        const extLen = Number(r.readVarInt());
        r.readBytes(extLen); // extension value
      }
      const payloadLength = Number(r.readVarInt());
      let payload: Uint8Array;
      let status: bigint | undefined;
      if (payloadLength === 0) {
        status = r.readVarInt();
        payload = new Uint8Array(0);
      } else {
        payload = r.readBytes(payloadLength);
      }
      const obj: FetchObjectPayload = {
        type: "object",
        groupId,
        subgroupId,
        objectId,
        publisherPriority,
        extensionCount: BigInt(extensionCount),
        payloadLength,
        payload,
      };
      if (status !== undefined) (obj as Record<string, unknown>).status = status;
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

export function createStreamDecoder(): TransformStream<Uint8Array, Draft08Message> {
  let buffer = new Uint8Array(0);
  return new TransformStream<Uint8Array, Draft08Message>({
    transform(chunk, controller) {
      const newBuffer = new Uint8Array(buffer.length + chunk.length);
      newBuffer.set(buffer, 0);
      newBuffer.set(chunk, buffer.length);
      buffer = newBuffer;
      while (buffer.length > 0) {
        const result = decodeMessage(buffer);
        if (!result.ok) {
          if (result.error.code === "UNEXPECTED_END") break;
          controller.error(result.error);
          return;
        }
        controller.enqueue(result.value);
        buffer = buffer.slice(result.bytesRead);
      }
    },
    flush(controller) {
      if (buffer.length > 0)
        controller.error(new DecodeError("UNEXPECTED_END", "Stream ended with incomplete data", 0));
    },
  });
}

// ─── Codec Factory ─────────────────────────────────────────────────────────────

export interface Draft08Codec extends BaseCodec<Draft08Message> {
  readonly draft: "draft-ietf-moq-transport-08";
  encodeSubgroupStream(stream: SubgroupStream): Uint8Array;
  encodeDatagram(dg: DatagramObject): Uint8Array;
  encodeDatagramStatus(dg: DatagramStatusObject): Uint8Array;
  encodeFetchStream(stream: FetchStream): Uint8Array;
  decodeSubgroupStream(bytes: Uint8Array): DecodeResult<SubgroupStream>;
  decodeDatagram(bytes: Uint8Array): DecodeResult<DatagramObject>;
  decodeDatagramStatus(bytes: Uint8Array): DecodeResult<DatagramStatusObject>;
  decodeFetchStream(bytes: Uint8Array): DecodeResult<FetchStream>;
  decodeDataStream(
    streamType: "subgroup" | "datagram" | "datagram_status" | "fetch",
    bytes: Uint8Array,
  ): DecodeResult<Draft08DataStream>;
  createStreamDecoder(): TransformStream<Uint8Array, Draft08Message>;
}

export function createDraft08Codec(): Draft08Codec {
  return {
    draft: "draft-ietf-moq-transport-08",
    encodeMessage,
    decodeMessage,
    encodeSubgroupStream,
    encodeDatagram,
    encodeDatagramStatus,
    encodeFetchStream,
    decodeSubgroupStream,
    decodeDatagram,
    decodeDatagramStatus,
    decodeFetchStream,
    decodeDataStream,
    createStreamDecoder,
  };
}
