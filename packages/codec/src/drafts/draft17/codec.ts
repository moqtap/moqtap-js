import { BufferReader } from "../../core/buffer-reader.js";
import { BufferWriter } from "../../core/buffer-writer.js";
import type { BaseCodec, DecodeResult } from "../../core/types.js";
import { DecodeError } from "../../core/types.js";
import {
  MESSAGE_ID_MAP,
  MSG_FETCH,
  MSG_FETCH_OK,
  MSG_GOAWAY,
  MSG_NAMESPACE,
  MSG_NAMESPACE_DONE,
  MSG_PUBLISH,
  MSG_PUBLISH_BLOCKED,
  MSG_PUBLISH_DONE,
  MSG_PUBLISH_NAMESPACE,
  MSG_PUBLISH_OK,
  MSG_REQUEST_ERROR,
  MSG_REQUEST_OK,
  MSG_REQUEST_UPDATE,
  MSG_SETUP,
  MSG_SUBSCRIBE,
  MSG_SUBSCRIBE_NAMESPACE,
  MSG_SUBSCRIBE_OK,
  MSG_TRACK_STATUS,
  SETUP_OPT_AUTHORITY,
  SETUP_OPT_MAX_AUTH_TOKEN_CACHE_SIZE,
  SETUP_OPT_MOQT_IMPLEMENTATION,
  SETUP_OPT_PATH,
} from "./messages.js";
import type {
  DatagramObject,
  DataStreamEvent,
  Draft17DataStream,
  Draft17Fetch,
  Draft17Message,
  Draft17Params,
  Draft17SetupOptions,
  Draft17TrackProperties,
  FetchObjectPayload,
  FetchStream,
  FetchStreamHeader,
  JoiningFetch,
  ObjectPayload,
  StandaloneFetch,
  SubgroupStream,
  SubgroupStreamHeader,
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

// ─── Setup Options Encoding/Decoding (KVP, no count prefix) ─────────────────

function encodeSetupOptions(opts: Draft17SetupOptions, writer: BufferWriter): void {
  // Collect all options sorted by type ID
  const entries: Array<{ type: bigint; encode: (w: BufferWriter) => void }> = [];

  if (opts.path !== undefined) {
    entries.push({
      type: SETUP_OPT_PATH,
      encode: (w) => {
        const encoded = new TextEncoder().encode(opts.path!);
        w.writeVarInt(BigInt(encoded.byteLength));
        w.writeBytes(encoded);
      },
    });
  }
  if (opts.max_auth_token_cache_size !== undefined) {
    entries.push({
      type: SETUP_OPT_MAX_AUTH_TOKEN_CACHE_SIZE,
      encode: (w) => w.writeVarInt(opts.max_auth_token_cache_size!),
    });
  }
  if (opts.authority !== undefined) {
    entries.push({
      type: SETUP_OPT_AUTHORITY,
      encode: (w) => {
        const encoded = new TextEncoder().encode(opts.authority!);
        w.writeVarInt(BigInt(encoded.byteLength));
        w.writeBytes(encoded);
      },
    });
  }
  if (opts.moqt_implementation !== undefined) {
    entries.push({
      type: SETUP_OPT_MOQT_IMPLEMENTATION,
      encode: (w) => {
        const encoded = new TextEncoder().encode(opts.moqt_implementation!);
        w.writeVarInt(BigInt(encoded.byteLength));
        w.writeBytes(encoded);
      },
    });
  }
  if (opts.unknown) {
    for (const u of opts.unknown) {
      const id = BigInt(u.id);
      entries.push({
        type: id,
        encode: (w) => {
          if (id % 2n === 0n) {
            const raw = hexToBytes(u.raw_hex);
            const tmpReader = new BufferReader(raw);
            w.writeVarInt(tmpReader.readVarInt());
          } else {
            const raw = hexToBytes(u.raw_hex);
            w.writeVarInt(BigInt(raw.byteLength));
            w.writeBytes(raw);
          }
        },
      });
    }
  }

  // Sort by type (ascending) and write with delta encoding
  entries.sort((a, b) => (a.type < b.type ? -1 : a.type > b.type ? 1 : 0));
  let prevType = 0n;
  for (const entry of entries) {
    writer.writeVarInt(entry.type - prevType);
    entry.encode(writer);
    prevType = entry.type;
  }
}

function decodeSetupOptions(reader: BufferReader, payloadEnd: number): Draft17SetupOptions {
  const result: Draft17SetupOptions = {};
  const unknown: UnknownParam[] = [];
  let prevType = 0n;

  while (reader.offset < payloadEnd) {
    const delta = reader.readVarInt();
    const optType = prevType + delta;
    prevType = optType;

    if (optType % 2n === 0n) {
      // Even: single varint value
      const value = reader.readVarInt();
      if (optType === SETUP_OPT_MAX_AUTH_TOKEN_CACHE_SIZE) {
        result.max_auth_token_cache_size = value;
      } else {
        const tmpWriter = new BufferWriter(16);
        tmpWriter.writeVarInt(value);
        const raw = tmpWriter.finish();
        unknown.push({
          id: `0x${optType.toString(16)}`,
          length: raw.byteLength,
          raw_hex: bytesToHex(raw),
        });
      }
    } else {
      // Odd: length-prefixed bytes
      const length = Number(reader.readVarInt());
      const bytes = reader.readBytes(length);
      if (optType === SETUP_OPT_PATH) {
        result.path = new TextDecoder().decode(bytes);
      } else if (optType === SETUP_OPT_AUTHORITY) {
        result.authority = new TextDecoder().decode(bytes);
      } else if (optType === SETUP_OPT_MOQT_IMPLEMENTATION) {
        result.moqt_implementation = new TextDecoder().decode(bytes);
      } else {
        unknown.push({ id: `0x${optType.toString(16)}`, length, raw_hex: bytesToHex(bytes) });
      }
    }
  }

  if (unknown.length > 0) result.unknown = unknown;
  return result;
}

// ─── Message Parameter Encoding/Decoding (delta types, count prefix) ─────────

const PARAM_EXPIRES = 0x08n;
const PARAM_LARGEST_OBJECT = 0x09n;
const PARAM_SUBSCRIBER_PRIORITY = 0x20n;
const PARAM_SUBSCRIPTION_FILTER = 0x21n;
const PARAM_GROUP_ORDER = 0x22n;

function encodeParams(params: Draft17Params, writer: BufferWriter): void {
  // Collect and sort params by type
  const entries: Array<{ type: bigint; encode: (w: BufferWriter) => void }> = [];

  if (params.expires !== undefined) {
    entries.push({ type: PARAM_EXPIRES, encode: (w) => w.writeVarInt(params.expires!) });
  }
  if (params.largest_object !== undefined) {
    entries.push({
      type: PARAM_LARGEST_OBJECT,
      encode: (w) => {
        w.writeVarInt(params.largest_object!.group);
        w.writeVarInt(params.largest_object!.object);
      },
    });
  }
  if (params.subscriber_priority !== undefined) {
    entries.push({
      type: PARAM_SUBSCRIBER_PRIORITY,
      encode: (w) => w.writeUint8(Number(params.subscriber_priority!)),
    });
  }
  if (params.subscription_filter !== undefined) {
    entries.push({
      type: PARAM_SUBSCRIPTION_FILTER,
      encode: (w) => {
        const f = params.subscription_filter!;
        const tmpW = new BufferWriter(32);
        tmpW.writeVarInt(f.filter_type);
        if (f.filter_type === 3n || f.filter_type === 4n) {
          tmpW.writeVarInt(f.start_group!);
          tmpW.writeVarInt(f.start_object!);
        }
        if (f.filter_type === 4n) {
          tmpW.writeVarInt(f.end_group!);
        }
        const raw = tmpW.finish();
        w.writeVarInt(BigInt(raw.byteLength));
        w.writeBytes(raw);
      },
    });
  }
  if (params.group_order !== undefined) {
    entries.push({
      type: PARAM_GROUP_ORDER,
      encode: (w) => w.writeUint8(Number(params.group_order!)),
    });
  }

  // Unknown params
  if (params.unknown) {
    for (const u of params.unknown) {
      const id = BigInt(u.id);
      entries.push({
        type: id,
        encode: (w) => {
          const raw = hexToBytes(u.raw_hex);
          // For unknown params, we store raw bytes and re-emit them
          w.writeBytes(raw);
        },
      });
    }
  }

  entries.sort((a, b) => (a.type < b.type ? -1 : a.type > b.type ? 1 : 0));

  writer.writeVarInt(BigInt(entries.length));
  let prevType = 0n;
  for (const entry of entries) {
    writer.writeVarInt(entry.type - prevType);
    entry.encode(writer);
    prevType = entry.type;
  }
}

function decodeParams(reader: BufferReader): Draft17Params {
  const count = Number(reader.readVarInt());
  const result: Draft17Params = {};
  const unknown: UnknownParam[] = [];
  let prevType = 0n;

  for (let i = 0; i < count; i++) {
    const delta = reader.readVarInt();
    const paramType = prevType + delta;
    prevType = paramType;

    if (paramType === PARAM_EXPIRES) {
      result.expires = reader.readVarInt();
    } else if (paramType === PARAM_LARGEST_OBJECT) {
      // Location: 2 bare varints (not length-prefixed)
      const group = reader.readVarInt();
      const object = reader.readVarInt();
      result.largest_object = { group, object };
    } else if (paramType === PARAM_SUBSCRIBER_PRIORITY) {
      // uint8: single raw byte
      result.subscriber_priority = BigInt(reader.readUint8());
    } else if (paramType === PARAM_SUBSCRIPTION_FILTER) {
      // Length-prefixed
      const length = Number(reader.readVarInt());
      const startOff = reader.offset;
      const filter_type = reader.readVarInt();
      const filter: {
        filter_type: bigint;
        start_group?: bigint;
        start_object?: bigint;
        end_group?: bigint;
      } = { filter_type };
      if (filter_type === 3n || filter_type === 4n) {
        filter.start_group = reader.readVarInt();
        filter.start_object = reader.readVarInt();
      }
      if (filter_type === 4n) {
        filter.end_group = reader.readVarInt();
      }
      const consumed = reader.offset - startOff;
      if (consumed < length) reader.readBytes(length - consumed);
      result.subscription_filter = filter;
    } else if (paramType === PARAM_GROUP_ORDER) {
      // uint8: single raw byte
      result.group_order = BigInt(reader.readUint8());
    } else {
      // Unknown parameter — we don't know the encoding, protocol violation per spec
      // But for robustness, attempt even/odd heuristic
      if (paramType % 2n === 0n) {
        const value = reader.readVarInt();
        const tmpWriter = new BufferWriter(16);
        tmpWriter.writeVarInt(value);
        const raw = tmpWriter.finish();
        unknown.push({
          id: `0x${paramType.toString(16)}`,
          length: raw.byteLength,
          raw_hex: bytesToHex(raw),
        });
      } else {
        const length = Number(reader.readVarInt());
        const bytes = reader.readBytes(length);
        unknown.push({ id: `0x${paramType.toString(16)}`, length, raw_hex: bytesToHex(bytes) });
      }
    }
  }

  if (unknown.length > 0) result.unknown = unknown;
  return result;
}

// ─── Track Properties Encoding/Decoding (KVP, no count prefix) ──────────────

function encodeTrackProperties(props: Draft17TrackProperties, writer: BufferWriter): void {
  if (!props.unknown || props.unknown.length === 0) return;

  const entries = props.unknown.map((u) => ({ type: BigInt(u.id), raw: u }));
  entries.sort((a, b) => (a.type < b.type ? -1 : a.type > b.type ? 1 : 0));

  let prevType = 0n;
  for (const entry of entries) {
    writer.writeVarInt(entry.type - prevType);
    if (entry.type % 2n === 0n) {
      const raw = hexToBytes(entry.raw.raw_hex);
      const tmpReader = new BufferReader(raw);
      writer.writeVarInt(tmpReader.readVarInt());
    } else {
      const raw = hexToBytes(entry.raw.raw_hex);
      writer.writeVarInt(BigInt(raw.byteLength));
      writer.writeBytes(raw);
    }
    prevType = entry.type;
  }
}

function decodeTrackProperties(reader: BufferReader, payloadEnd: number): Draft17TrackProperties {
  const result: Draft17TrackProperties = {};
  const unknown: UnknownParam[] = [];
  let prevType = 0n;

  while (reader.offset < payloadEnd) {
    const delta = reader.readVarInt();
    const propType = prevType + delta;
    prevType = propType;

    if (propType % 2n === 0n) {
      const value = reader.readVarInt();
      const tmpWriter = new BufferWriter(16);
      tmpWriter.writeVarInt(value);
      const raw = tmpWriter.finish();
      unknown.push({
        id: `0x${propType.toString(16)}`,
        length: raw.byteLength,
        raw_hex: bytesToHex(raw),
      });
    } else {
      const length = Number(reader.readVarInt());
      const bytes = reader.readBytes(length);
      unknown.push({ id: `0x${propType.toString(16)}`, length, raw_hex: bytesToHex(bytes) });
    }
  }

  if (unknown.length > 0) result.unknown = unknown;
  return result;
}

// ─── Payload Encoders ──────────────────────────────────────────────────────────

function encodeSetupPayload(msg: Draft17Message & { type: "setup" }, w: BufferWriter): void {
  encodeSetupOptions(msg.options, w);
}

function encodeSubscribePayload(
  msg: Draft17Message & { type: "subscribe" },
  w: BufferWriter,
): void {
  w.writeVarInt(msg.request_id);
  w.writeVarInt(msg.required_request_id_delta);
  w.writeTuple(msg.track_namespace);
  w.writeString(msg.track_name);
  encodeParams(msg.parameters, w);
}

function encodeSubscribeOkPayload(
  msg: Draft17Message & { type: "subscribe_ok" },
  w: BufferWriter,
): void {
  w.writeVarInt(msg.track_alias);
  encodeParams(msg.parameters, w);
  encodeTrackProperties(msg.track_properties, w);
}

function encodeRequestUpdatePayload(
  msg: Draft17Message & { type: "request_update" },
  w: BufferWriter,
): void {
  w.writeVarInt(msg.request_id);
  w.writeVarInt(msg.required_request_id_delta);
  encodeParams(msg.parameters, w);
}

function encodePublishPayload(msg: Draft17Message & { type: "publish" }, w: BufferWriter): void {
  w.writeVarInt(msg.request_id);
  w.writeVarInt(msg.required_request_id_delta);
  w.writeTuple(msg.track_namespace);
  w.writeString(msg.track_name);
  w.writeVarInt(msg.track_alias);
  encodeParams(msg.parameters, w);
  encodeTrackProperties(msg.track_properties, w);
}

function encodePublishOkPayload(
  msg: Draft17Message & { type: "publish_ok" },
  w: BufferWriter,
): void {
  encodeParams(msg.parameters, w);
}

function encodePublishDonePayload(
  msg: Draft17Message & { type: "publish_done" },
  w: BufferWriter,
): void {
  w.writeVarInt(msg.status_code);
  w.writeVarInt(msg.stream_count);
  w.writeString(msg.reason_phrase);
}

function encodePublishNamespacePayload(
  msg: Draft17Message & { type: "publish_namespace" },
  w: BufferWriter,
): void {
  w.writeVarInt(msg.request_id);
  w.writeVarInt(msg.required_request_id_delta);
  w.writeTuple(msg.track_namespace);
  encodeParams(msg.parameters, w);
}

function encodeNamespacePayload(
  msg: Draft17Message & { type: "namespace" },
  w: BufferWriter,
): void {
  w.writeTuple(msg.namespace_suffix);
}

function encodeNamespaceDonePayload(
  msg: Draft17Message & { type: "namespace_done" },
  w: BufferWriter,
): void {
  w.writeTuple(msg.namespace_suffix);
}

function encodeSubscribeNamespacePayload(
  msg: Draft17Message & { type: "subscribe_namespace" },
  w: BufferWriter,
): void {
  w.writeVarInt(msg.request_id);
  w.writeVarInt(msg.required_request_id_delta);
  w.writeTuple(msg.namespace_prefix);
  w.writeVarInt(msg.subscribe_options);
  encodeParams(msg.parameters, w);
}

function encodePublishBlockedPayload(
  msg: Draft17Message & { type: "publish_blocked" },
  w: BufferWriter,
): void {
  w.writeTuple(msg.namespace_suffix);
  w.writeString(msg.track_name);
}

function encodeFetchPayload(msg: Draft17Message & { type: "fetch" }, w: BufferWriter): void {
  w.writeVarInt(msg.request_id);
  w.writeVarInt(msg.required_request_id_delta);
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
    w.writeVarInt(msg.joining.joining_request_id);
    w.writeVarInt(msg.joining.joining_start);
  }
  encodeParams(msg.parameters, w);
}

function encodeFetchOkPayload(msg: Draft17Message & { type: "fetch_ok" }, w: BufferWriter): void {
  w.writeUint8(msg.end_of_track);
  w.writeVarInt(msg.end_group);
  w.writeVarInt(msg.end_object);
  encodeParams(msg.parameters, w);
  encodeTrackProperties(msg.track_properties, w);
}

function encodeTrackStatusPayload(
  msg: Draft17Message & { type: "track_status" },
  w: BufferWriter,
): void {
  w.writeVarInt(msg.request_id);
  w.writeVarInt(msg.required_request_id_delta);
  w.writeTuple(msg.track_namespace);
  w.writeString(msg.track_name);
  encodeParams(msg.parameters, w);
}

function encodeRequestOkPayload(
  msg: Draft17Message & { type: "request_ok" },
  w: BufferWriter,
): void {
  encodeParams(msg.parameters, w);
}

function encodeRequestErrorPayload(
  msg: Draft17Message & { type: "request_error" },
  w: BufferWriter,
): void {
  w.writeVarInt(msg.error_code);
  w.writeVarInt(msg.retry_interval);
  w.writeString(msg.reason_phrase);
}

function encodeGoAwayPayload(msg: Draft17Message & { type: "goaway" }, w: BufferWriter): void {
  w.writeString(msg.new_session_uri);
  w.writeVarInt(msg.timeout);
}

// ─── Payload Decoders ──────────────────────────────────────────────────────────

function decodeSetupPayload(r: BufferReader, payloadEnd: number): Draft17Message {
  const options = decodeSetupOptions(r, payloadEnd);
  return { type: "setup", options };
}

function decodeSubscribePayload(r: BufferReader): Draft17Message {
  const request_id = r.readVarInt();
  const required_request_id_delta = r.readVarInt();
  const track_namespace = r.readTuple();
  const track_name = r.readString();
  const parameters = decodeParams(r);
  return {
    type: "subscribe",
    request_id,
    required_request_id_delta,
    track_namespace,
    track_name,
    parameters,
  };
}

function decodeSubscribeOkPayload(r: BufferReader, payloadEnd: number): Draft17Message {
  const track_alias = r.readVarInt();
  const parameters = decodeParams(r);
  const track_properties = decodeTrackProperties(r, payloadEnd);
  return { type: "subscribe_ok", track_alias, parameters, track_properties };
}

function decodeRequestUpdatePayload(r: BufferReader): Draft17Message {
  const request_id = r.readVarInt();
  const required_request_id_delta = r.readVarInt();
  const parameters = decodeParams(r);
  return { type: "request_update", request_id, required_request_id_delta, parameters };
}

function decodePublishPayload(r: BufferReader, payloadEnd: number): Draft17Message {
  const request_id = r.readVarInt();
  const required_request_id_delta = r.readVarInt();
  const track_namespace = r.readTuple();
  const track_name = r.readString();
  const track_alias = r.readVarInt();
  const parameters = decodeParams(r);
  const track_properties = decodeTrackProperties(r, payloadEnd);
  return {
    type: "publish",
    request_id,
    required_request_id_delta,
    track_namespace,
    track_name,
    track_alias,
    parameters,
    track_properties,
  };
}

function decodePublishOkPayload(r: BufferReader): Draft17Message {
  const parameters = decodeParams(r);
  return { type: "publish_ok", parameters };
}

function decodePublishDonePayload(r: BufferReader): Draft17Message {
  const status_code = r.readVarInt();
  const stream_count = r.readVarInt();
  const reason_phrase = r.readString();
  return { type: "publish_done", status_code, stream_count, reason_phrase };
}

function decodePublishNamespacePayload(r: BufferReader): Draft17Message {
  const request_id = r.readVarInt();
  const required_request_id_delta = r.readVarInt();
  const track_namespace = r.readTuple();
  const parameters = decodeParams(r);
  return {
    type: "publish_namespace",
    request_id,
    required_request_id_delta,
    track_namespace,
    parameters,
  };
}

function decodeNamespacePayload(r: BufferReader): Draft17Message {
  const namespace_suffix = r.readTuple();
  return { type: "namespace", namespace_suffix };
}

function decodeNamespaceDonePayload(r: BufferReader): Draft17Message {
  const namespace_suffix = r.readTuple();
  return { type: "namespace_done", namespace_suffix };
}

function decodeSubscribeNamespacePayload(r: BufferReader): Draft17Message {
  const request_id = r.readVarInt();
  const required_request_id_delta = r.readVarInt();
  const namespace_prefix = r.readTuple();
  const subscribe_options = r.readVarInt();
  const parameters = decodeParams(r);
  return {
    type: "subscribe_namespace",
    request_id,
    required_request_id_delta,
    namespace_prefix,
    subscribe_options,
    parameters,
  };
}

function decodePublishBlockedPayload(r: BufferReader): Draft17Message {
  const namespace_suffix = r.readTuple();
  const track_name = r.readString();
  return { type: "publish_blocked", namespace_suffix, track_name };
}

function decodeFetchPayload(r: BufferReader): Draft17Message {
  const request_id = r.readVarInt();
  const required_request_id_delta = r.readVarInt();
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
    const joining_request_id = r.readVarInt();
    const joining_start = r.readVarInt();
    joining = { joining_request_id, joining_start };
  }

  const parameters = decodeParams(r);

  return {
    type: "fetch",
    request_id,
    required_request_id_delta,
    fetch_type,
    standalone,
    joining,
    parameters,
  } as Draft17Fetch;
}

function decodeFetchOkPayload(r: BufferReader, payloadEnd: number): Draft17Message {
  const end_of_track = r.readUint8();
  const end_group = r.readVarInt();
  const end_object = r.readVarInt();
  const parameters = decodeParams(r);
  const track_properties = decodeTrackProperties(r, payloadEnd);
  return { type: "fetch_ok", end_of_track, end_group, end_object, parameters, track_properties };
}

function decodeTrackStatusPayload(r: BufferReader): Draft17Message {
  const request_id = r.readVarInt();
  const required_request_id_delta = r.readVarInt();
  const track_namespace = r.readTuple();
  const track_name = r.readString();
  const parameters = decodeParams(r);
  return {
    type: "track_status",
    request_id,
    required_request_id_delta,
    track_namespace,
    track_name,
    parameters,
  };
}

function decodeRequestOkPayload(r: BufferReader): Draft17Message {
  const parameters = decodeParams(r);
  return { type: "request_ok", parameters };
}

function decodeRequestErrorPayload(r: BufferReader): Draft17Message {
  const error_code = r.readVarInt();
  const retry_interval = r.readVarInt();
  const reason_phrase = r.readString();
  return { type: "request_error", error_code, retry_interval, reason_phrase };
}

function decodeGoAwayPayload(r: BufferReader): Draft17Message {
  const new_session_uri = r.readString();
  const timeout = r.readVarInt();
  return { type: "goaway", new_session_uri, timeout };
}

// ─── Public API ────────────────────────────────────────────────────────────────

/**
 * Encode a draft-17 control message with type(varint) + length(uint16 BE) + payload.
 */
export function encodeMessage(message: Draft17Message): Uint8Array {
  const typeId = MESSAGE_ID_MAP.get(message.type);
  if (typeId === undefined) {
    throw new Error(`Unknown message type: ${message.type}`);
  }

  const payloadWriter = new BufferWriter();
  encodePayload(message, payloadWriter);
  const payload = payloadWriter.finish();

  if (payload.byteLength > 0xffff) {
    throw new Error(`Payload too large for 16-bit length: ${payload.byteLength}`);
  }

  const writer = new BufferWriter();
  writer.writeVarInt(typeId);
  writer.writeUint8((payload.byteLength >> 8) & 0xff);
  writer.writeUint8(payload.byteLength & 0xff);
  writer.writeBytes(payload);

  return writer.finish();
}

function encodePayload(msg: Draft17Message, w: BufferWriter): void {
  switch (msg.type) {
    case "setup":
      return encodeSetupPayload(msg, w);
    case "subscribe":
      return encodeSubscribePayload(msg, w);
    case "subscribe_ok":
      return encodeSubscribeOkPayload(msg, w);
    case "request_update":
      return encodeRequestUpdatePayload(msg, w);
    case "publish":
      return encodePublishPayload(msg, w);
    case "publish_ok":
      return encodePublishOkPayload(msg, w);
    case "publish_done":
      return encodePublishDonePayload(msg, w);
    case "publish_namespace":
      return encodePublishNamespacePayload(msg, w);
    case "namespace":
      return encodeNamespacePayload(msg, w);
    case "namespace_done":
      return encodeNamespaceDonePayload(msg, w);
    case "subscribe_namespace":
      return encodeSubscribeNamespacePayload(msg, w);
    case "publish_blocked":
      return encodePublishBlockedPayload(msg, w);
    case "fetch":
      return encodeFetchPayload(msg, w);
    case "fetch_ok":
      return encodeFetchOkPayload(msg, w);
    case "track_status":
      return encodeTrackStatusPayload(msg, w);
    case "request_ok":
      return encodeRequestOkPayload(msg, w);
    case "request_error":
      return encodeRequestErrorPayload(msg, w);
    case "goaway":
      return encodeGoAwayPayload(msg, w);
    default: {
      const _exhaustive: never = msg;
      throw new Error(`Unhandled message type: ${(_exhaustive as Draft17Message).type}`);
    }
  }
}

/**
 * Decode a draft-17 control message from bytes (type + uint16 length + payload).
 */
export function decodeMessage(bytes: Uint8Array): DecodeResult<Draft17Message> {
  try {
    const reader = new BufferReader(bytes);
    const typeId = reader.readVarInt();

    const lenHi = reader.readUint8();
    const lenLo = reader.readUint8();
    const payloadLength = (lenHi << 8) | lenLo;

    const payloadStart = reader.offset;
    const _payloadEnd = payloadStart + payloadLength;
    const payloadBytes = reader.readBytes(payloadLength);
    const payloadReader = new BufferReader(payloadBytes);

    let message: Draft17Message;

    if (typeId === MSG_SETUP) {
      message = decodeSetupPayload(payloadReader, payloadLength);
    } else if (typeId === MSG_SUBSCRIBE) {
      message = decodeSubscribePayload(payloadReader);
    } else if (typeId === MSG_SUBSCRIBE_OK) {
      message = decodeSubscribeOkPayload(payloadReader, payloadLength);
    } else if (typeId === MSG_REQUEST_UPDATE) {
      message = decodeRequestUpdatePayload(payloadReader);
    } else if (typeId === MSG_PUBLISH) {
      message = decodePublishPayload(payloadReader, payloadLength);
    } else if (typeId === MSG_PUBLISH_OK) {
      message = decodePublishOkPayload(payloadReader);
    } else if (typeId === MSG_PUBLISH_DONE) {
      message = decodePublishDonePayload(payloadReader);
    } else if (typeId === MSG_PUBLISH_NAMESPACE) {
      message = decodePublishNamespacePayload(payloadReader);
    } else if (typeId === MSG_NAMESPACE) {
      message = decodeNamespacePayload(payloadReader);
    } else if (typeId === MSG_NAMESPACE_DONE) {
      message = decodeNamespaceDonePayload(payloadReader);
    } else if (typeId === MSG_SUBSCRIBE_NAMESPACE) {
      message = decodeSubscribeNamespacePayload(payloadReader);
    } else if (typeId === MSG_PUBLISH_BLOCKED) {
      message = decodePublishBlockedPayload(payloadReader);
    } else if (typeId === MSG_FETCH) {
      message = decodeFetchPayload(payloadReader);
    } else if (typeId === MSG_FETCH_OK) {
      message = decodeFetchOkPayload(payloadReader, payloadLength);
    } else if (typeId === MSG_TRACK_STATUS) {
      message = decodeTrackStatusPayload(payloadReader);
    } else if (typeId === MSG_REQUEST_OK) {
      message = decodeRequestOkPayload(payloadReader);
    } else if (typeId === MSG_REQUEST_ERROR) {
      message = decodeRequestErrorPayload(payloadReader);
    } else if (typeId === MSG_GOAWAY) {
      message = decodeGoAwayPayload(payloadReader);
    } else {
      return {
        ok: false,
        error: new DecodeError(
          "UNKNOWN_MESSAGE_TYPE",
          `Unknown message type ID: 0x${typeId.toString(16)}`,
          0,
        ),
      };
    }

    return { ok: true, value: message, bytesRead: reader.offset };
  } catch (e) {
    if (e instanceof DecodeError) {
      return { ok: false, error: e };
    }
    throw e;
  }
}

// ─── Data Stream Encoding/Decoding (same as draft-16) ───────────────────────

const FETCH_STREAM_TYPE = 0x05n;

export function encodeSubgroupStream(stream: SubgroupStream): Uint8Array {
  const w = new BufferWriter();
  const streamType = stream.headerType;
  w.writeVarInt(BigInt(streamType));

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
    w.writeUint8(obj.serializationFlags);
    const flags = obj.serializationFlags;
    if (flags & 0x08) w.writeVarInt(obj.groupId);
    const subgroupEncoding = flags & 0x03;
    if (subgroupEncoding === 0x03) w.writeVarInt(obj.subgroupId);
    if (flags & 0x04) w.writeVarInt(obj.objectId);
    if (flags & 0x10) w.writeUint8(obj.publisherPriority);
    w.writeVarInt(BigInt(obj.payloadLength));
    if (obj.payloadLength === 0) {
      w.writeVarInt(obj.status ?? 0n);
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

    if (
      !((streamType >= 0x10 && streamType <= 0x1d) || (streamType >= 0x30 && streamType <= 0x3d))
    ) {
      return {
        ok: false,
        error: new DecodeError(
          "CONSTRAINT_VIOLATION",
          `Expected subgroup stream type 0x10-0x1D or 0x30-0x3D, got 0x${streamType.toString(16)}`,
          0,
        ),
      };
    }

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
      const payloadLength = Number(r.readVarInt());
      let payload: Uint8Array;
      let status: bigint | undefined;
      if (payloadLength === 0) {
        status = r.readVarInt();
        payload = new Uint8Array(0);
      } else {
        payload = r.readBytes(payloadLength);
      }
      const obj: ObjectPayload = { type: "object", objectId, payloadLength, payload };
      if (status !== undefined) (obj as Record<string, unknown>).status = status;
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

    if (endOfGroup) (result as Record<string, unknown>).endOfGroup = true;
    if (objectStatus !== undefined) (result as Record<string, unknown>).objectStatus = objectStatus;

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
      const flags = r.readUint8();
      const subgroupEncoding = flags & 0x03;
      const objectIdPresent = (flags & 0x04) !== 0;
      const groupIdPresent = (flags & 0x08) !== 0;
      const priorityPresent = (flags & 0x10) !== 0;
      const extensionsPresent = (flags & 0x20) !== 0;

      if (flags & 0xc0) {
        return {
          ok: false,
          error: new DecodeError(
            "CONSTRAINT_VIOLATION",
            "Reserved bits set in fetch object flags",
            r.offset,
          ),
        };
      }

      let groupId = prevGroupId;
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

      let subgroupId = prevSubgroupId;
      if (subgroupEncoding === 0x00) {
        subgroupId = 0n;
      } else if (subgroupEncoding === 0x01) {
        subgroupId = prevSubgroupId;
      } else if (subgroupEncoding === 0x02) {
        subgroupId = prevSubgroupId + 1n;
      } else if (subgroupEncoding === 0x03) {
        subgroupId = r.readVarInt();
      }

      let objectId = prevObjectId + 1n;
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
          r.readBytes(extLen);
        }
      }

      const payloadLength = Number(r.readVarInt());
      let payload: Uint8Array;
      let status: bigint | undefined;
      if (payloadLength > 0) {
        payload = r.readBytes(payloadLength);
      } else {
        status = r.readVarInt();
        payload = new Uint8Array(0);
      }

      const obj: FetchObjectPayload = {
        type: "object",
        serializationFlags: flags,
        groupId,
        subgroupId,
        objectId,
        publisherPriority: prevPriority,
        payloadLength,
        payload,
      };
      if (status !== undefined) (obj as Record<string, unknown>).status = status;
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

// ─── Stream Decoders ───────────────────────────────────────────────────────────

export function createStreamDecoder(): TransformStream<Uint8Array, Draft17Message> {
  let buffer = new Uint8Array(0);

  return new TransformStream<Uint8Array, Draft17Message>({
    transform(chunk, controller) {
      const newBuffer = new Uint8Array(buffer.length + chunk.length);
      newBuffer.set(buffer, 0);
      newBuffer.set(chunk, buffer.length);
      buffer = newBuffer;

      while (buffer.length > 0) {
        const result = decodeMessage(buffer);
        if (!result.ok) {
          if (result.error.code === "UNEXPECTED_END") {
            break;
          }
          controller.error(result.error);
          return;
        }
        controller.enqueue(result.value);
        buffer = buffer.slice(result.bytesRead);
      }
    },

    flush(controller) {
      if (buffer.length > 0) {
        controller.error(
          new DecodeError("UNEXPECTED_END", "Stream ended with incomplete message data", 0),
        );
      }
    },
  });
}

export function createSubgroupStreamDecoder(): TransformStream<
  Uint8Array,
  SubgroupStreamHeader | ObjectPayload
> {
  let buffer = new Uint8Array(0);
  let headerEmitted = false;
  let prevObjectId = -1n;
  let firstObject = true;
  let _subgroupIsFirstObjId = false;

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
          const payloadLength = Number(r.readVarInt());
          const payload = payloadLength > 0 ? r.readBytes(payloadLength) : new Uint8Array(0);
          controller.enqueue({ type: "object", objectId, payloadLength, payload });
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
          const flags = r.readUint8();
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
          if (extensionsPresent) {
            const extLen = Number(r.readVarInt());
            if (extLen > 0) r.readBytes(extLen);
          }
          const payloadLength = Number(r.readVarInt());
          const payload = payloadLength > 0 ? r.readBytes(payloadLength) : new Uint8Array(0);
          controller.enqueue({ type: "object", objectId, payloadLength, payload });
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

// ─── Codec Factory ─────────────────────────────────────────────────────────────

export interface Draft17Codec extends BaseCodec<Draft17Message> {
  readonly draft: "draft-ietf-moq-transport-17";
  encodeSubgroupStream(stream: SubgroupStream): Uint8Array;
  encodeDatagram(dg: DatagramObject): Uint8Array;
  encodeFetchStream(stream: FetchStream): Uint8Array;
  decodeSubgroupStream(bytes: Uint8Array): DecodeResult<SubgroupStream>;
  decodeDatagram(bytes: Uint8Array): DecodeResult<DatagramObject>;
  decodeFetchStream(bytes: Uint8Array): DecodeResult<FetchStream>;
  decodeDataStream(
    streamType: "subgroup" | "datagram" | "fetch",
    bytes: Uint8Array,
  ): DecodeResult<Draft17DataStream>;
  createStreamDecoder(): TransformStream<Uint8Array, Draft17Message>;
  createSubgroupStreamDecoder(): TransformStream<Uint8Array, SubgroupStreamHeader | ObjectPayload>;
  createFetchStreamDecoder(): TransformStream<Uint8Array, FetchStreamHeader | ObjectPayload>;
  createDataStreamDecoder(): TransformStream<Uint8Array, DataStreamEvent>;
}

export function createDraft17Codec(): Draft17Codec {
  return {
    draft: "draft-ietf-moq-transport-17",
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
