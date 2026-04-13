import { BufferReader } from '../../core/buffer-reader.js'
import { BufferWriter } from '../../core/buffer-writer.js'
import { bytesToHex, hexToBytes } from '../../core/hex.js'
import type { BaseCodec, DecodeResult } from '../../core/types.js'
import { DecodeError } from '../../core/types.js'
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
  MSG_OBJECT_DATAGRAM,
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
  PARAM_AUTHORIZATION_INFO,
  PARAM_DELIVERY_TIMEOUT,
  PARAM_MAX_CACHE_DURATION,
  SETUP_PARAM_MAX_SUBSCRIBE_ID,
  SETUP_PARAM_PATH,
  SETUP_PARAM_ROLE,
} from './messages.js'
import type {
  Announce,
  AnnounceCancel,
  AnnounceError,
  AnnounceOk,
  ClientSetup,
  DatagramObject as Draft07DatagramObject,
  Draft07Message,
  Draft07Params,
  Draft07SetupParams,
  Fetch,
  FetchCancel,
  FetchError,
  FetchOk,
  FetchStream,
  GoAway,
  MaxSubscribeId,
  ObjectDatagram,
  ServerSetup,
  SubgroupStream,
  Subscribe,
  SubscribeAnnounces,
  SubscribeAnnouncesError,
  SubscribeAnnouncesOk,
  SubscribeDone,
  SubscribeError,
  SubscribeOk,
  SubscribeUpdate,
  TrackStatus,
  TrackStatusRequest,
  Unannounce,
  UnknownParam,
  Unsubscribe,
  UnsubscribeAnnounces,
} from './types.js'
import { decodeVarInt, encodeVarInt } from './varint.js'

const textEncoder = /* @__PURE__ */ new TextEncoder()
const textDecoder = /* @__PURE__ */ new TextDecoder()

// Data stream type IDs that NEVER appear as control messages.
// Note: 0x04 (stream_header_subgroup) excluded — shares ID with subscribe_ok.
// Note: 0x05 (fetch_header) excluded — shares ID with subscribe_error.
// Callers must use decodeSubgroupStream/decodeFetchStream directly.
const DATA_STREAM_TYPE_IDS: ReadonlySet<bigint> = new Set([MSG_OBJECT_DATAGRAM])

// ─── Setup Parameter Encoding/Decoding ────────────────────────────────────────

function encodeSetupParams(params: Draft07SetupParams, w: BufferWriter): void {
  let count = 0
  if (params.role !== undefined) count++
  if (params.path !== undefined) count++
  if (params.max_subscribe_id !== undefined) count++
  if (params.unknown) count += params.unknown.length

  w.writeVarInt(count)

  if (params.role !== undefined) {
    w.writeVarInt(SETUP_PARAM_ROLE)
    const tmpW = new BufferWriter(16)
    tmpW.writeVarInt(params.role)
    const raw = tmpW.finish()
    w.writeVarInt(raw.byteLength)
    w.writeBytes(raw)
  }
  if (params.path !== undefined) {
    w.writeVarInt(SETUP_PARAM_PATH)
    const encoded = textEncoder.encode(params.path)
    w.writeVarInt(encoded.byteLength)
    w.writeBytes(encoded)
  }
  if (params.max_subscribe_id !== undefined) {
    w.writeVarInt(SETUP_PARAM_MAX_SUBSCRIBE_ID)
    const tmpW = new BufferWriter(16)
    tmpW.writeVarInt(params.max_subscribe_id)
    const raw = tmpW.finish()
    w.writeVarInt(raw.byteLength)
    w.writeBytes(raw)
  }
  if (params.unknown) {
    for (const u of params.unknown) {
      w.writeVarInt(BigInt(u.id))
      const raw = hexToBytes(u.raw_hex)
      w.writeVarInt(raw.byteLength)
      w.writeBytes(raw)
    }
  }
}

function decodeSetupParams(r: BufferReader): Draft07SetupParams {
  const count = Number(r.readVarInt())
  const result: Draft07SetupParams = {}
  const unknown: UnknownParam[] = []

  for (let i = 0; i < count; i++) {
    const paramType = r.readVarInt()
    const length = Number(r.readVarInt())

    if (paramType === SETUP_PARAM_ROLE) {
      const blob = r.readBytes(length)
      const tmpReader = new BufferReader(blob)
      result.role = tmpReader.readVarInt()
    } else if (paramType === SETUP_PARAM_PATH) {
      const bytes = r.readBytes(length)
      result.path = textDecoder.decode(bytes)
    } else if (paramType === SETUP_PARAM_MAX_SUBSCRIBE_ID) {
      const blob = r.readBytes(length)
      const tmpReader = new BufferReader(blob)
      result.max_subscribe_id = tmpReader.readVarInt()
    } else {
      const bytes = r.readBytes(length)
      unknown.push({
        id: `0x${paramType.toString(16)}`,
        length,
        raw_hex: bytesToHex(bytes),
      })
    }
  }

  if (unknown.length > 0) result.unknown = unknown
  return result
}

// ─── Version-Specific Parameter Encoding/Decoding ─────────────────────────────

function encodeParams(params: Draft07Params, w: BufferWriter): void {
  let count = params.unknown ? params.unknown.length : 0
  if (params.authorization_info !== undefined) count++
  if (params.delivery_timeout !== undefined) count++
  if (params.max_cache_duration !== undefined) count++
  w.writeVarInt(count)

  if (params.authorization_info !== undefined) {
    w.writeVarInt(PARAM_AUTHORIZATION_INFO)
    const encoded = textEncoder.encode(params.authorization_info)
    w.writeVarInt(encoded.byteLength)
    w.writeBytes(encoded)
  }
  if (params.delivery_timeout !== undefined) {
    w.writeVarInt(PARAM_DELIVERY_TIMEOUT)
    const tmpW = new BufferWriter(16)
    tmpW.writeVarInt(params.delivery_timeout)
    const raw = tmpW.finish()
    w.writeVarInt(raw.byteLength)
    w.writeBytes(raw)
  }
  if (params.max_cache_duration !== undefined) {
    w.writeVarInt(PARAM_MAX_CACHE_DURATION)
    const tmpW = new BufferWriter(16)
    tmpW.writeVarInt(params.max_cache_duration)
    const raw = tmpW.finish()
    w.writeVarInt(raw.byteLength)
    w.writeBytes(raw)
  }
  if (params.unknown) {
    for (const u of params.unknown) {
      w.writeVarInt(BigInt(u.id))
      const raw = hexToBytes(u.raw_hex)
      w.writeVarInt(raw.byteLength)
      w.writeBytes(raw)
    }
  }
}

function decodeParams(r: BufferReader): Draft07Params {
  const count = Number(r.readVarInt())
  const result: Draft07Params = {}
  const unknown: UnknownParam[] = []

  for (let i = 0; i < count; i++) {
    const paramType = r.readVarInt()
    const length = Number(r.readVarInt())

    if (paramType === PARAM_AUTHORIZATION_INFO) {
      const bytes = r.readBytes(length)
      result.authorization_info = textDecoder.decode(bytes)
    } else if (paramType === PARAM_DELIVERY_TIMEOUT) {
      const blob = r.readBytes(length)
      const tmpReader = new BufferReader(blob)
      result.delivery_timeout = tmpReader.readVarInt()
    } else if (paramType === PARAM_MAX_CACHE_DURATION) {
      const blob = r.readBytes(length)
      const tmpReader = new BufferReader(blob)
      result.max_cache_duration = tmpReader.readVarInt()
    } else {
      const bytes = r.readBytes(length)
      unknown.push({
        id: `0x${paramType.toString(16)}`,
        length,
        raw_hex: bytesToHex(bytes),
      })
    }
  }

  if (unknown.length > 0) result.unknown = unknown
  return result
}

// ─── Payload Encoders ──────────────────────────────────────────────────────────

function encodeClientSetupPayload(msg: ClientSetup, writer: BufferWriter): void {
  writer.writeVarInt(msg.supported_versions.length)
  for (const version of msg.supported_versions) {
    writer.writeVarInt(version)
  }
  encodeSetupParams(msg.parameters, writer)
}

function encodeServerSetupPayload(msg: ServerSetup, writer: BufferWriter): void {
  writer.writeVarInt(msg.selected_version)
  encodeSetupParams(msg.parameters, writer)
}

function encodeSubscribePayload(msg: Subscribe, writer: BufferWriter): void {
  writer.writeVarInt(msg.subscribe_id)
  writer.writeVarInt(msg.track_alias)
  writer.writeTuple(msg.track_namespace)
  writer.writeString(msg.track_name)
  writer.writeUint8(msg.subscriber_priority)
  writer.writeUint8(msg.group_order)
  writer.writeVarInt(msg.filter_type)
  if (msg.filter_type === 3n || msg.filter_type === 4n) {
    writer.writeVarInt(msg.start_group!)
    writer.writeVarInt(msg.start_object!)
  }
  if (msg.filter_type === 4n) {
    writer.writeVarInt(msg.end_group!)
    writer.writeVarInt(msg.end_object!)
  }
  encodeParams(msg.parameters, writer)
}

function encodeSubscribeOkPayload(msg: SubscribeOk, writer: BufferWriter): void {
  writer.writeVarInt(msg.subscribe_id)
  writer.writeVarInt(msg.expires)
  writer.writeUint8(msg.group_order)
  writer.writeUint8(msg.content_exists)
  if (msg.content_exists) {
    writer.writeVarInt(msg.largest_group_id!)
    writer.writeVarInt(msg.largest_object_id!)
  }
  encodeParams(msg.parameters, writer)
}

function encodeSubscribeErrorPayload(msg: SubscribeError, writer: BufferWriter): void {
  writer.writeVarInt(msg.subscribe_id)
  writer.writeVarInt(msg.error_code)
  writer.writeString(msg.reason_phrase)
  writer.writeVarInt(msg.track_alias)
}

function encodeSubscribeDonePayload(msg: SubscribeDone, writer: BufferWriter): void {
  writer.writeVarInt(msg.subscribe_id)
  writer.writeVarInt(msg.status_code)
  writer.writeString(msg.reason_phrase)
  writer.writeUint8(msg.content_exists)
  if (msg.content_exists) {
    writer.writeVarInt(msg.final_group!)
    writer.writeVarInt(msg.final_object!)
  }
}

function encodeSubscribeUpdatePayload(msg: SubscribeUpdate, writer: BufferWriter): void {
  writer.writeVarInt(msg.subscribe_id)
  writer.writeVarInt(msg.start_group)
  writer.writeVarInt(msg.start_object)
  writer.writeVarInt(msg.end_group)
  writer.writeVarInt(msg.end_object)
  writer.writeUint8(msg.subscriber_priority)
  encodeParams(msg.parameters, writer)
}

function encodeUnsubscribePayload(msg: Unsubscribe, writer: BufferWriter): void {
  writer.writeVarInt(msg.subscribe_id)
}

function encodeAnnouncePayload(msg: Announce, writer: BufferWriter): void {
  writer.writeTuple(msg.track_namespace)
  encodeParams(msg.parameters, writer)
}

function encodeAnnounceOkPayload(msg: AnnounceOk, writer: BufferWriter): void {
  writer.writeTuple(msg.track_namespace)
}

function encodeAnnounceErrorPayload(msg: AnnounceError, writer: BufferWriter): void {
  writer.writeTuple(msg.track_namespace)
  writer.writeVarInt(msg.error_code)
  writer.writeString(msg.reason_phrase)
}

function encodeAnnounceCancelPayload(msg: AnnounceCancel, writer: BufferWriter): void {
  writer.writeTuple(msg.track_namespace)
  writer.writeVarInt(msg.error_code)
  writer.writeString(msg.reason_phrase)
}

function encodeUnannouncePayload(msg: Unannounce, writer: BufferWriter): void {
  writer.writeTuple(msg.track_namespace)
}

function encodeTrackStatusRequestPayload(msg: TrackStatusRequest, writer: BufferWriter): void {
  writer.writeTuple(msg.track_namespace)
  writer.writeString(msg.track_name)
}

function encodeTrackStatusPayload(msg: TrackStatus, writer: BufferWriter): void {
  writer.writeTuple(msg.track_namespace)
  writer.writeString(msg.track_name)
  writer.writeVarInt(msg.status_code)
  writer.writeVarInt(msg.last_group_id)
  writer.writeVarInt(msg.last_object_id)
}

function encodeGoAwayPayload(msg: GoAway, writer: BufferWriter): void {
  writer.writeString(msg.new_session_uri)
}

function encodeSubscribeAnnouncesPayload(msg: SubscribeAnnounces, writer: BufferWriter): void {
  writer.writeTuple(msg.track_namespace_prefix)
  encodeParams(msg.parameters, writer)
}

function encodeSubscribeAnnouncesOkPayload(msg: SubscribeAnnouncesOk, writer: BufferWriter): void {
  writer.writeTuple(msg.track_namespace_prefix)
}

function encodeSubscribeAnnouncesErrorPayload(
  msg: SubscribeAnnouncesError,
  writer: BufferWriter,
): void {
  writer.writeTuple(msg.track_namespace_prefix)
  writer.writeVarInt(msg.error_code)
  writer.writeString(msg.reason_phrase)
}

function encodeUnsubscribeAnnouncesPayload(msg: UnsubscribeAnnounces, writer: BufferWriter): void {
  writer.writeTuple(msg.track_namespace_prefix)
}

function encodeMaxSubscribeIdPayload(msg: MaxSubscribeId, writer: BufferWriter): void {
  writer.writeVarInt(msg.subscribe_id)
}

function encodeFetchPayload(msg: Fetch, writer: BufferWriter): void {
  writer.writeVarInt(msg.subscribe_id)
  writer.writeTuple(msg.track_namespace)
  writer.writeString(msg.track_name)
  writer.writeUint8(msg.subscriber_priority)
  writer.writeUint8(msg.group_order)
  writer.writeVarInt(msg.start_group)
  writer.writeVarInt(msg.start_object)
  writer.writeVarInt(msg.end_group)
  writer.writeVarInt(msg.end_object)
  encodeParams(msg.parameters, writer)
}

function encodeFetchOkPayload(msg: FetchOk, writer: BufferWriter): void {
  writer.writeVarInt(msg.subscribe_id)
  writer.writeUint8(msg.group_order)
  writer.writeUint8(msg.end_of_track)
  writer.writeVarInt(msg.largest_group_id)
  writer.writeVarInt(msg.largest_object_id)
  encodeParams(msg.parameters, writer)
}

function encodeFetchErrorPayload(msg: FetchError, writer: BufferWriter): void {
  writer.writeVarInt(msg.subscribe_id)
  writer.writeVarInt(msg.error_code)
  writer.writeString(msg.reason_phrase)
}

function encodeFetchCancelPayload(msg: FetchCancel, writer: BufferWriter): void {
  writer.writeVarInt(msg.subscribe_id)
}

// Data stream encoders (no type+length framing)
function encodeObjectPayload(
  msg: { object_status?: number; payload: Uint8Array },
  writer: BufferWriter,
): void {
  if (msg.payload.byteLength === 0) {
    writer.writeVarInt(0) // payloadLength = 0 signals objectStatus follows
    writer.writeVarInt(msg.object_status ?? 0)
  } else {
    writer.writeVarInt(msg.payload.byteLength)
    writer.writeBytes(msg.payload)
  }
}

function encodeObjectDatagram(msg: ObjectDatagram, writer: BufferWriter): void {
  writer.writeVarInt(MSG_OBJECT_DATAGRAM)
  writer.writeVarInt(msg.track_alias)
  writer.writeVarInt(msg.group_id)
  writer.writeVarInt(msg.object_id)
  writer.writeUint8(msg.publisher_priority)
  encodeObjectPayload(msg, writer)
}

// ─── Payload encode dispatch ──────────────────────────────────────────────────

function encodePayload(msg: Draft07Message, w: BufferWriter): void {
  switch (msg.type) {
    case 'client_setup':
      return encodeClientSetupPayload(msg, w)
    case 'server_setup':
      return encodeServerSetupPayload(msg, w)
    case 'subscribe':
      return encodeSubscribePayload(msg, w)
    case 'subscribe_ok':
      return encodeSubscribeOkPayload(msg, w)
    case 'subscribe_error':
      return encodeSubscribeErrorPayload(msg, w)
    case 'subscribe_update':
      return encodeSubscribeUpdatePayload(msg, w)
    case 'subscribe_done':
      return encodeSubscribeDonePayload(msg, w)
    case 'unsubscribe':
      return encodeUnsubscribePayload(msg, w)
    case 'announce':
      return encodeAnnouncePayload(msg, w)
    case 'announce_ok':
      return encodeAnnounceOkPayload(msg, w)
    case 'announce_error':
      return encodeAnnounceErrorPayload(msg, w)
    case 'unannounce':
      return encodeUnannouncePayload(msg, w)
    case 'announce_cancel':
      return encodeAnnounceCancelPayload(msg, w)
    case 'subscribe_announces':
      return encodeSubscribeAnnouncesPayload(msg, w)
    case 'subscribe_announces_ok':
      return encodeSubscribeAnnouncesOkPayload(msg, w)
    case 'subscribe_announces_error':
      return encodeSubscribeAnnouncesErrorPayload(msg, w)
    case 'unsubscribe_announces':
      return encodeUnsubscribeAnnouncesPayload(msg, w)
    case 'fetch':
      return encodeFetchPayload(msg, w)
    case 'fetch_ok':
      return encodeFetchOkPayload(msg, w)
    case 'fetch_error':
      return encodeFetchErrorPayload(msg, w)
    case 'fetch_cancel':
      return encodeFetchCancelPayload(msg, w)
    case 'track_status_request':
      return encodeTrackStatusRequestPayload(msg, w)
    case 'track_status':
      return encodeTrackStatusPayload(msg, w)
    case 'goaway':
      return encodeGoAwayPayload(msg, w)
    case 'max_subscribe_id':
      return encodeMaxSubscribeIdPayload(msg, w)
    default:
      throw new Error(`Unhandled message type: ${(msg as Draft07Message).type}`)
  }
}

// ─── Payload Decoders ──────────────────────────────────────────────────────────

function decodeClientSetupPayload(reader: BufferReader): Draft07Message {
  const numVersions = reader.readVarInt()
  if (numVersions === 0n) {
    throw new DecodeError(
      'CONSTRAINT_VIOLATION',
      'supported_versions must not be empty',
      reader.offset,
    )
  }
  const supported_versions: bigint[] = []
  for (let i = 0n; i < numVersions; i++) {
    supported_versions.push(reader.readVarInt())
  }
  const parameters = decodeSetupParams(reader)
  return { type: 'client_setup', supported_versions, parameters }
}

function decodeServerSetupPayload(reader: BufferReader): Draft07Message {
  const selected_version = reader.readVarInt()
  const parameters = decodeSetupParams(reader)
  return { type: 'server_setup', selected_version, parameters }
}

function decodeSubscribePayload(reader: BufferReader): Draft07Message {
  const subscribe_id = reader.readVarInt()
  const track_alias = reader.readVarInt()
  const track_namespace = reader.readTuple()
  const track_name = reader.readString()
  const subscriber_priority = reader.readUint8()
  const group_order = reader.readUint8()
  const filter_type = reader.readVarInt()

  if (filter_type < 1n || filter_type > 4n) {
    throw new DecodeError(
      'CONSTRAINT_VIOLATION',
      `Invalid filter type: ${filter_type}`,
      reader.offset,
    )
  }

  const base = {
    type: 'subscribe' as const,
    subscribe_id,
    track_alias,
    track_namespace,
    track_name,
    subscriber_priority,
    group_order,
    filter_type,
    parameters: undefined as unknown as Draft07Params,
  }

  if (filter_type === 3n) {
    const start_group = reader.readVarInt()
    const start_object = reader.readVarInt()
    base.parameters = decodeParams(reader)
    return { ...base, start_group, start_object }
  }
  if (filter_type === 4n) {
    const start_group = reader.readVarInt()
    const start_object = reader.readVarInt()
    const end_group = reader.readVarInt()
    const end_object = reader.readVarInt()
    base.parameters = decodeParams(reader)
    return { ...base, start_group, start_object, end_group, end_object }
  }

  base.parameters = decodeParams(reader)
  return base
}

function decodeSubscribeOkPayload(reader: BufferReader): Draft07Message {
  const subscribe_id = reader.readVarInt()
  const expires = reader.readVarInt()
  const group_order = reader.readUint8()
  const content_exists = reader.readUint8()

  if (content_exists) {
    const largest_group_id = reader.readVarInt()
    const largest_object_id = reader.readVarInt()
    const parameters = decodeParams(reader)
    return {
      type: 'subscribe_ok' as const,
      subscribe_id,
      expires,
      group_order,
      content_exists,
      largest_group_id,
      largest_object_id,
      parameters,
    }
  }

  const parameters = decodeParams(reader)
  return {
    type: 'subscribe_ok' as const,
    subscribe_id,
    expires,
    group_order,
    content_exists,
    parameters,
  }
}

function decodeSubscribeErrorPayload(reader: BufferReader): Draft07Message {
  const subscribe_id = reader.readVarInt()
  const error_code = reader.readVarInt()
  const reason_phrase = reader.readString()
  const track_alias = reader.readVarInt()
  return {
    type: 'subscribe_error',
    subscribe_id,
    error_code,
    reason_phrase,
    track_alias,
  }
}

function decodeSubscribeDonePayload(reader: BufferReader): Draft07Message {
  const subscribe_id = reader.readVarInt()
  const status_code = reader.readVarInt()
  const reason_phrase = reader.readString()
  const content_exists = reader.readUint8()

  if (content_exists) {
    const final_group = reader.readVarInt()
    const final_object = reader.readVarInt()
    return {
      type: 'subscribe_done' as const,
      subscribe_id,
      status_code,
      reason_phrase,
      content_exists,
      final_group,
      final_object,
    }
  }

  return {
    type: 'subscribe_done' as const,
    subscribe_id,
    status_code,
    reason_phrase,
    content_exists,
  }
}

function decodeSubscribeUpdatePayload(reader: BufferReader): Draft07Message {
  const subscribe_id = reader.readVarInt()
  const start_group = reader.readVarInt()
  const start_object = reader.readVarInt()
  const end_group = reader.readVarInt()
  const end_object = reader.readVarInt()
  const subscriber_priority = reader.readUint8()
  const parameters = decodeParams(reader)
  return {
    type: 'subscribe_update',
    subscribe_id,
    start_group,
    start_object,
    end_group,
    end_object,
    subscriber_priority,
    parameters,
  }
}

function decodeUnsubscribePayload(reader: BufferReader): Draft07Message {
  const subscribe_id = reader.readVarInt()
  return { type: 'unsubscribe', subscribe_id }
}

function decodeAnnouncePayload(reader: BufferReader): Draft07Message {
  const track_namespace = reader.readTuple()
  const parameters = decodeParams(reader)
  return { type: 'announce', track_namespace, parameters }
}

function decodeAnnounceOkPayload(reader: BufferReader): Draft07Message {
  const track_namespace = reader.readTuple()
  return { type: 'announce_ok', track_namespace }
}

function decodeAnnounceErrorPayload(reader: BufferReader): Draft07Message {
  const track_namespace = reader.readTuple()
  const error_code = reader.readVarInt()
  const reason_phrase = reader.readString()
  return { type: 'announce_error', track_namespace, error_code, reason_phrase }
}

function decodeAnnounceCancelPayload(reader: BufferReader): Draft07Message {
  const track_namespace = reader.readTuple()
  const error_code = reader.readVarInt()
  const reason_phrase = reader.readString()
  return { type: 'announce_cancel', track_namespace, error_code, reason_phrase }
}

function decodeUnannouncePayload(reader: BufferReader): Draft07Message {
  const track_namespace = reader.readTuple()
  return { type: 'unannounce', track_namespace }
}

function decodeTrackStatusRequestPayload(reader: BufferReader): Draft07Message {
  const track_namespace = reader.readTuple()
  const track_name = reader.readString()
  return { type: 'track_status_request', track_namespace, track_name }
}

function decodeTrackStatusPayload(reader: BufferReader): Draft07Message {
  const track_namespace = reader.readTuple()
  const track_name = reader.readString()
  const status_code = reader.readVarInt()
  const last_group_id = reader.readVarInt()
  const last_object_id = reader.readVarInt()
  return {
    type: 'track_status',
    track_namespace,
    track_name,
    status_code,
    last_group_id,
    last_object_id,
  }
}

function decodeGoAwayPayload(reader: BufferReader): Draft07Message {
  const new_session_uri = reader.readString()
  return { type: 'goaway', new_session_uri }
}

function decodeSubscribeAnnouncesPayload(reader: BufferReader): Draft07Message {
  const track_namespace_prefix = reader.readTuple()
  const parameters = decodeParams(reader)
  return { type: 'subscribe_announces', track_namespace_prefix, parameters }
}

function decodeSubscribeAnnouncesOkPayload(reader: BufferReader): Draft07Message {
  const track_namespace_prefix = reader.readTuple()
  return { type: 'subscribe_announces_ok', track_namespace_prefix }
}

function decodeSubscribeAnnouncesErrorPayload(reader: BufferReader): Draft07Message {
  const track_namespace_prefix = reader.readTuple()
  const error_code = reader.readVarInt()
  const reason_phrase = reader.readString()
  return {
    type: 'subscribe_announces_error',
    track_namespace_prefix,
    error_code,
    reason_phrase,
  }
}

function decodeUnsubscribeAnnouncesPayload(reader: BufferReader): Draft07Message {
  const track_namespace_prefix = reader.readTuple()
  return { type: 'unsubscribe_announces', track_namespace_prefix }
}

function decodeMaxSubscribeIdPayload(reader: BufferReader): Draft07Message {
  const subscribe_id = reader.readVarInt()
  return { type: 'max_subscribe_id', subscribe_id }
}

function decodeFetchPayload(reader: BufferReader): Draft07Message {
  const subscribe_id = reader.readVarInt()
  const track_namespace = reader.readTuple()
  const track_name = reader.readString()
  const subscriber_priority = reader.readUint8()
  const group_order = reader.readUint8()
  const start_group = reader.readVarInt()
  const start_object = reader.readVarInt()
  const end_group = reader.readVarInt()
  const end_object = reader.readVarInt()
  const parameters = decodeParams(reader)
  return {
    type: 'fetch' as const,
    subscribe_id,
    track_namespace,
    track_name,
    subscriber_priority,
    group_order,
    start_group,
    start_object,
    end_group,
    end_object,
    parameters,
  }
}

function decodeFetchOkPayload(reader: BufferReader): Draft07Message {
  const subscribe_id = reader.readVarInt()
  const group_order = reader.readUint8()
  const end_of_track = reader.readUint8()
  const largest_group_id = reader.readVarInt()
  const largest_object_id = reader.readVarInt()
  const parameters = decodeParams(reader)
  return {
    type: 'fetch_ok' as const,
    subscribe_id,
    group_order,
    end_of_track,
    largest_group_id,
    largest_object_id,
    parameters,
  }
}

function decodeFetchErrorPayload(reader: BufferReader): Draft07Message {
  const subscribe_id = reader.readVarInt()
  const error_code = reader.readVarInt()
  const reason_phrase = reader.readString()
  return { type: 'fetch_error', subscribe_id, error_code, reason_phrase }
}

function decodeFetchCancelPayload(reader: BufferReader): Draft07Message {
  const subscribe_id = reader.readVarInt()
  return { type: 'fetch_cancel', subscribe_id }
}

function decodeObjectDatagram(reader: BufferReader): ObjectDatagram {
  const track_alias = reader.readVarInt()
  const group_id = reader.readVarInt()
  const object_id = reader.readVarInt()
  const publisher_priority = reader.readUint8()
  const payloadLength = Number(reader.readVarInt())
  if (payloadLength === 0) {
    // Object Status follows when payload length is 0
    const object_status = reader.remaining > 0 ? Number(reader.readVarInt()) : 0
    return {
      type: 'object_datagram' as const,
      track_alias,
      group_id,
      object_id,
      publisher_priority,
      object_status,
      payload: new Uint8Array(0),
    }
  }
  const payload = reader.readBytesView(payloadLength)
  return {
    type: 'object_datagram' as const,
    track_alias,
    group_id,
    object_id,
    publisher_priority,
    payload,
  }
}

// ─── Payload dispatch tables ──────────────────────────────────────────────────

type Decoder = (reader: BufferReader) => Draft07Message

const payloadDecoders: ReadonlyMap<bigint, Decoder> = new Map([
  [MSG_CLIENT_SETUP, decodeClientSetupPayload],
  [MSG_SERVER_SETUP, decodeServerSetupPayload],
  [MSG_SUBSCRIBE, decodeSubscribePayload],
  [MSG_SUBSCRIBE_OK, decodeSubscribeOkPayload],
  [MSG_SUBSCRIBE_ERROR, decodeSubscribeErrorPayload],
  [MSG_SUBSCRIBE_DONE, decodeSubscribeDonePayload],
  [MSG_SUBSCRIBE_UPDATE, decodeSubscribeUpdatePayload],
  [MSG_UNSUBSCRIBE, decodeUnsubscribePayload],
  [MSG_ANNOUNCE, decodeAnnouncePayload],
  [MSG_ANNOUNCE_OK, decodeAnnounceOkPayload],
  [MSG_ANNOUNCE_ERROR, decodeAnnounceErrorPayload],
  [MSG_ANNOUNCE_CANCEL, decodeAnnounceCancelPayload],
  [MSG_UNANNOUNCE, decodeUnannouncePayload],
  [MSG_TRACK_STATUS_REQUEST, decodeTrackStatusRequestPayload],
  [MSG_TRACK_STATUS, decodeTrackStatusPayload],
  [MSG_GOAWAY, decodeGoAwayPayload],
  [MSG_SUBSCRIBE_ANNOUNCES, decodeSubscribeAnnouncesPayload],
  [MSG_SUBSCRIBE_ANNOUNCES_OK, decodeSubscribeAnnouncesOkPayload],
  [MSG_SUBSCRIBE_ANNOUNCES_ERROR, decodeSubscribeAnnouncesErrorPayload],
  [MSG_UNSUBSCRIBE_ANNOUNCES, decodeUnsubscribeAnnouncesPayload],
  [MSG_MAX_SUBSCRIBE_ID, decodeMaxSubscribeIdPayload],
  [MSG_FETCH, decodeFetchPayload],
  [MSG_FETCH_OK, decodeFetchOkPayload],
  [MSG_FETCH_ERROR, decodeFetchErrorPayload],
  [MSG_FETCH_CANCEL, decodeFetchCancelPayload],
])

// Data stream decoders keyed by wire ID (for disambiguation)
const dataStreamDecoders = new Map<bigint, Decoder>([[MSG_OBJECT_DATAGRAM, decodeObjectDatagram]])

// ─── Public API ────────────────────────────────────────────────────────────────

function encodeMessage(message: Draft07Message): Uint8Array {
  // Check if it's a data stream message (no type+length framing)
  if (message.type === 'object_datagram') {
    const writer = new BufferWriter()
    encodeObjectDatagram(message as ObjectDatagram, writer)
    return writer.finish()
  }

  // Control message: type + length + payload framing
  const typeId = MESSAGE_ID_MAP.get(message.type)
  if (typeId === undefined) {
    throw new Error(`Unknown message type: ${message.type}`)
  }

  const payloadWriter = new BufferWriter()
  encodePayload(message, payloadWriter)
  const payload = payloadWriter.finishView()

  const writer = new BufferWriter(payload.byteLength + 16)
  writer.writeVarInt(typeId)
  writer.writeVarInt(payload.byteLength)
  writer.writeBytes(payload)
  return writer.finish()
}

function decodeMessage(bytes: Uint8Array): DecodeResult<Draft07Message> {
  try {
    const reader = new BufferReader(bytes, 0)
    const typeId = reader.readVarInt()

    // Check if this is a data stream type (no length framing)
    if (DATA_STREAM_TYPE_IDS.has(typeId)) {
      const decoder = dataStreamDecoders.get(typeId)
      if (!decoder) {
        return {
          ok: false,
          error: new DecodeError(
            'UNKNOWN_MESSAGE_TYPE',
            `Unknown data stream type ID: 0x${typeId.toString(16)}`,
            0,
          ),
        }
      }
      const message = decoder(reader)
      return { ok: true, value: message, bytesRead: reader.offset }
    }

    // Control message: read length, then decode payload from bounded sub-reader
    const payloadLength = Number(reader.readVarInt())

    if (reader.remaining < payloadLength) {
      return {
        ok: false,
        error: new DecodeError(
          'UNEXPECTED_END',
          `Not enough bytes for payload: need ${payloadLength}, have ${reader.remaining}`,
          reader.offset,
        ),
      }
    }

    const payloadBytes = reader.readBytes(payloadLength)
    const totalBytesRead = reader.offset

    const decoder = payloadDecoders.get(typeId)
    if (!decoder) {
      return {
        ok: false,
        error: new DecodeError(
          'UNKNOWN_MESSAGE_TYPE',
          `Unknown message type ID: 0x${typeId.toString(16)}`,
          0,
        ),
      }
    }

    const payloadReader = new BufferReader(payloadBytes, 0)
    const message = decoder(payloadReader)
    return { ok: true, value: message, bytesRead: totalBytesRead }
  } catch (e) {
    if (e instanceof DecodeError) {
      return { ok: false, error: e }
    }
    throw e
  }
}

export {
  decodeDatagram,
  decodeFetchStream,
  decodeSubgroupStream,
  encodeDatagram,
  encodeFetchStream,
  encodeSubgroupStream,
} from './data-streams.js'

import {
  decodeDatagram,
  decodeFetchStream,
  decodeSubgroupStream,
  encodeDatagram,
  encodeFetchStream,
  encodeSubgroupStream,
} from './data-streams.js'

export function createStreamDecoder(): TransformStream<Uint8Array, Draft07Message> {
  let buffer = new Uint8Array(0)
  let offset = 0
  return new TransformStream<Uint8Array, Draft07Message>({
    transform(chunk, controller) {
      if (offset > 0) {
        buffer = buffer.subarray(offset)
        offset = 0
      }
      const newBuffer = new Uint8Array(buffer.length + chunk.length)
      newBuffer.set(buffer, 0)
      newBuffer.set(chunk, buffer.length)
      buffer = newBuffer
      while (offset < buffer.length) {
        const result = decodeMessage(buffer.subarray(offset))
        if (!result.ok) {
          if (result.error.code === 'UNEXPECTED_END') break
          controller.error(result.error)
          return
        }
        controller.enqueue(result.value)
        offset += result.bytesRead
      }
    },
    flush(controller) {
      if (offset < buffer.length) {
        controller.error(
          new DecodeError('UNEXPECTED_END', 'Stream ended with incomplete message data', 0),
        )
      }
    },
  })
}

// ─── Codec Factory ────────────────────────────────────────────────────────────

export interface Draft07Codec extends BaseCodec<Draft07Message> {
  readonly draft: '07'
  encodeVarInt(value: number | bigint): Uint8Array
  decodeVarInt(bytes: Uint8Array, offset?: number): DecodeResult<bigint>
  encodeSubgroupStream(stream: SubgroupStream): Uint8Array
  decodeSubgroupStream(bytes: Uint8Array): DecodeResult<SubgroupStream>
  encodeDatagram(dg: Draft07DatagramObject): Uint8Array
  decodeDatagram(bytes: Uint8Array): DecodeResult<Draft07DatagramObject>
  encodeFetchStream(stream: FetchStream): Uint8Array
  decodeFetchStream(bytes: Uint8Array): DecodeResult<FetchStream>
  createStreamDecoder(): TransformStream<Uint8Array, Draft07Message>
}

export function createDraft07Codec(): Draft07Codec {
  return {
    draft: '07',
    encodeMessage,
    decodeMessage,
    encodeVarInt,
    decodeVarInt,
    createStreamDecoder,
    encodeSubgroupStream,
    decodeSubgroupStream,
    encodeDatagram,
    decodeDatagram,
    encodeFetchStream,
    decodeFetchStream,
  }
}

// Export data-stream decoder map for callers that need to disambiguate
export { dataStreamDecoders }
