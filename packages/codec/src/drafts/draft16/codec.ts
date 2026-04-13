import { BufferReader } from '../../core/buffer-reader.js'
import { BufferWriter } from '../../core/buffer-writer.js'
import { bytesToHex, hexToBytes } from '../../core/hex.js'
import type { BaseCodec, DecodeResult } from '../../core/types.js'
import { DecodeError } from '../../core/types.js'
import {
  MESSAGE_ID_MAP,
  MSG_CLIENT_SETUP,
  MSG_FETCH,
  MSG_FETCH_CANCEL,
  MSG_FETCH_OK,
  MSG_GOAWAY,
  MSG_MAX_REQUEST_ID,
  MSG_NAMESPACE,
  MSG_NAMESPACE_DONE,
  MSG_PUBLISH,
  MSG_PUBLISH_DONE,
  MSG_PUBLISH_NAMESPACE,
  MSG_PUBLISH_NAMESPACE_CANCEL,
  MSG_PUBLISH_NAMESPACE_DONE,
  MSG_PUBLISH_OK,
  MSG_REQUEST_ERROR,
  MSG_REQUEST_OK,
  MSG_REQUEST_UPDATE,
  MSG_REQUESTS_BLOCKED,
  MSG_SERVER_SETUP,
  MSG_SUBSCRIBE,
  MSG_SUBSCRIBE_NAMESPACE,
  MSG_SUBSCRIBE_OK,
  MSG_TRACK_STATUS,
  MSG_UNSUBSCRIBE,
  SETUP_PARAM_AUTHORITY,
  SETUP_PARAM_AUTHORIZATION_TOKEN,
  SETUP_PARAM_MAX_AUTH_TOKEN_CACHE_SIZE,
  SETUP_PARAM_MAX_REQUEST_ID,
  SETUP_PARAM_MOQT_IMPLEMENTATION,
  SETUP_PARAM_PATH,
} from './messages.js'
import type {
  AuthorizationToken,
  DatagramObject,
  DataStreamEvent,
  Draft16DataStream,
  Draft16Fetch,
  Draft16Message,
  Draft16Params,
  Draft16SetupParams,
  Draft16TrackExtensions,
  FetchStream,
  FetchStreamHeader,
  JoiningFetch,
  ObjectPayload,
  StandaloneFetch,
  SubgroupStream,
  SubgroupStreamHeader,
  UnknownParam,
} from './types.js'

const textEncoder = /* @__PURE__ */ new TextEncoder()
const textDecoder = /* @__PURE__ */ new TextDecoder()

// ─── Setup Parameter Encoding/Decoding ──────────────────────────────────────────

function encodeSetupParams(params: Draft16SetupParams, writer: BufferWriter): void {
  let count = 0
  if (params.path !== undefined) count++
  if (params.max_request_id !== undefined) count++
  if (params.authorization_token !== undefined) count++
  if (params.max_auth_token_cache_size !== undefined) count++
  if (params.authority !== undefined) count++
  if (params.moqt_implementation !== undefined) count++
  if (params.unknown) count += params.unknown.length

  writer.writeVarInt(count)

  // PATH (0x01) - odd, length-prefixed bytes
  if (params.path !== undefined) {
    writer.writeVarInt(SETUP_PARAM_PATH)
    const encoded = textEncoder.encode(params.path)
    writer.writeVarInt(encoded.byteLength)
    writer.writeBytes(encoded)
  }

  // MAX_REQUEST_ID (0x02) - even, varint value
  if (params.max_request_id !== undefined) {
    writer.writeVarInt(SETUP_PARAM_MAX_REQUEST_ID)
    writer.writeVarInt(params.max_request_id)
  }

  // AUTHORIZATION_TOKEN (0x03) - odd, length-prefixed with nested structure
  if (params.authorization_token !== undefined) {
    writer.writeVarInt(SETUP_PARAM_AUTHORIZATION_TOKEN)
    const tmpW = new BufferWriter(64)
    encodeAuthorizationToken(params.authorization_token, tmpW)
    const raw = tmpW.finish()
    writer.writeVarInt(raw.byteLength)
    writer.writeBytes(raw)
  }

  // MAX_AUTH_TOKEN_CACHE_SIZE (0x04) - even, varint value
  if (params.max_auth_token_cache_size !== undefined) {
    writer.writeVarInt(SETUP_PARAM_MAX_AUTH_TOKEN_CACHE_SIZE)
    writer.writeVarInt(params.max_auth_token_cache_size)
  }

  // AUTHORITY (0x05) - odd, length-prefixed bytes
  if (params.authority !== undefined) {
    writer.writeVarInt(SETUP_PARAM_AUTHORITY)
    const encoded = textEncoder.encode(params.authority)
    writer.writeVarInt(encoded.byteLength)
    writer.writeBytes(encoded)
  }

  // MOQT_IMPLEMENTATION (0x07) - odd, length-prefixed bytes
  if (params.moqt_implementation !== undefined) {
    writer.writeVarInt(SETUP_PARAM_MOQT_IMPLEMENTATION)
    const encoded = textEncoder.encode(params.moqt_implementation)
    writer.writeVarInt(encoded.byteLength)
    writer.writeBytes(encoded)
  }

  // Unknown params
  if (params.unknown) {
    for (const u of params.unknown) {
      const id = BigInt(u.id)
      writer.writeVarInt(id)
      if (id % 2n === 0n) {
        const raw = hexToBytes(u.raw_hex)
        const tmpReader = new BufferReader(raw)
        const value = tmpReader.readVarInt()
        writer.writeVarInt(value)
      } else {
        const raw = hexToBytes(u.raw_hex)
        writer.writeVarInt(raw.byteLength)
        writer.writeBytes(raw)
      }
    }
  }
}

function decodeSetupParams(reader: BufferReader): Draft16SetupParams {
  const count = Number(reader.readVarInt())
  const result: Draft16SetupParams = {}
  const unknown: UnknownParam[] = []

  for (let i = 0; i < count; i++) {
    const paramType = reader.readVarInt()

    if (paramType % 2n === 0n) {
      const value = reader.readVarInt()
      if (paramType === SETUP_PARAM_MAX_REQUEST_ID) {
        result.max_request_id = value
      } else if (paramType === SETUP_PARAM_MAX_AUTH_TOKEN_CACHE_SIZE) {
        result.max_auth_token_cache_size = value
      } else {
        const tmpWriter = new BufferWriter(16)
        tmpWriter.writeVarInt(value)
        const raw = tmpWriter.finish()
        unknown.push({
          id: `0x${paramType.toString(16)}`,
          length: raw.byteLength,
          raw_hex: bytesToHex(raw),
        })
      }
    } else {
      const length = Number(reader.readVarInt())
      const bytes = reader.readBytes(length)
      if (paramType === SETUP_PARAM_PATH) {
        result.path = textDecoder.decode(bytes)
      } else if (paramType === SETUP_PARAM_AUTHORIZATION_TOKEN) {
        result.authorization_token = decodeAuthorizationToken(new BufferReader(bytes))
      } else if (paramType === SETUP_PARAM_AUTHORITY) {
        result.authority = textDecoder.decode(bytes)
      } else if (paramType === SETUP_PARAM_MOQT_IMPLEMENTATION) {
        result.moqt_implementation = textDecoder.decode(bytes)
      } else {
        unknown.push({
          id: `0x${paramType.toString(16)}`,
          length,
          raw_hex: bytesToHex(bytes),
        })
      }
    }
  }

  if (unknown.length > 0) {
    result.unknown = unknown
  }

  return result
}

// ─── Authorization Token Encoding/Decoding ────────────────────────────────────

function encodeAuthorizationToken(token: AuthorizationToken, w: BufferWriter): void {
  w.writeVarInt(token.alias_type)
  const aliasType = Number(token.alias_type)
  if (aliasType === 0 || aliasType === 1) {
    w.writeVarInt(token.token_alias!)
  }
  if (aliasType === 1 || aliasType === 3) {
    w.writeVarInt(token.token_type!)
    const tokenBytes = hexToBytes(token.token_value_hex!)
    w.writeBytes(tokenBytes)
  }
}

function decodeAuthorizationToken(r: BufferReader): AuthorizationToken {
  const alias_type = r.readVarInt()
  const aliasType = Number(alias_type)
  const result: Record<string, unknown> = { alias_type }
  if (aliasType === 0 || aliasType === 1) {
    result.token_alias = r.readVarInt()
  }
  if (aliasType === 1 || aliasType === 3) {
    result.token_type = r.readVarInt()
    const tokenBytes = r.readBytesView(r.remaining)
    result.token_value_hex = bytesToHex(tokenBytes)
  }
  return result as unknown as AuthorizationToken
}

// ─── Version-Specific Parameter Encoding/Decoding ───────────────────────────────

const PARAM_DELIVERY_TIMEOUT = 0x02n
const PARAM_AUTHORIZATION_TOKEN = 0x03n
const PARAM_MAX_CACHE_DURATION = 0x04n
const PARAM_EXPIRES = 0x08n
const PARAM_LARGEST_OBJECT = 0x09n
const PARAM_PUBLISHER_PRIORITY = 0x0en
const PARAM_FORWARD = 0x10n
const PARAM_SUBSCRIBER_PRIORITY = 0x20n
const PARAM_SUBSCRIPTION_FILTER = 0x21n
const PARAM_GROUP_ORDER = 0x22n
const PARAM_DYNAMIC_GROUPS = 0x30n
const PARAM_NEW_GROUP_REQUEST = 0x32n

// Track extension IDs (same encoding as params, but separate namespace)
const TRACK_EXT_DELIVERY_TIMEOUT = 0x02n
const TRACK_EXT_MAX_CACHE_DURATION = 0x04n
const TRACK_EXT_DEFAULT_PUBLISHER_PRIORITY = 0x0en

function encodeTrackExtensions(ext: Draft16TrackExtensions, writer: BufferWriter): void {
  if (ext.delivery_timeout !== undefined) {
    writer.writeVarInt(TRACK_EXT_DELIVERY_TIMEOUT)
    writer.writeVarInt(ext.delivery_timeout)
  }
  if (ext.max_cache_duration !== undefined) {
    writer.writeVarInt(TRACK_EXT_MAX_CACHE_DURATION)
    writer.writeVarInt(ext.max_cache_duration)
  }
  if (ext.default_publisher_priority !== undefined) {
    writer.writeVarInt(TRACK_EXT_DEFAULT_PUBLISHER_PRIORITY)
    writer.writeVarInt(ext.default_publisher_priority)
  }
  if (ext.unknown) {
    for (const u of ext.unknown) {
      const id = BigInt(u.id)
      writer.writeVarInt(id)
      if (id % 2n === 0n) {
        const raw = hexToBytes(u.raw_hex)
        const tmpReader = new BufferReader(raw)
        const value = tmpReader.readVarInt()
        writer.writeVarInt(value)
      } else {
        const raw = hexToBytes(u.raw_hex)
        writer.writeVarInt(raw.byteLength)
        writer.writeBytes(raw)
      }
    }
  }
}

function decodeTrackExtensions(reader: BufferReader): Draft16TrackExtensions {
  const result: Draft16TrackExtensions = {}
  const unknown: UnknownParam[] = []

  while (reader.remaining > 0) {
    const extType = reader.readVarInt()
    if (extType === TRACK_EXT_DELIVERY_TIMEOUT) {
      result.delivery_timeout = reader.readVarInt()
    } else if (extType === TRACK_EXT_MAX_CACHE_DURATION) {
      result.max_cache_duration = reader.readVarInt()
    } else if (extType === TRACK_EXT_DEFAULT_PUBLISHER_PRIORITY) {
      result.default_publisher_priority = reader.readVarInt()
    } else if (extType % 2n === 0n) {
      const value = reader.readVarInt()
      const tmpWriter = new BufferWriter(16)
      tmpWriter.writeVarInt(value)
      const raw = tmpWriter.finish()
      unknown.push({
        id: `0x${extType.toString(16)}`,
        length: raw.byteLength,
        raw_hex: bytesToHex(raw),
      })
    } else {
      const length = Number(reader.readVarInt())
      const bytes = reader.readBytes(length)
      unknown.push({
        id: `0x${extType.toString(16)}`,
        length,
        raw_hex: bytesToHex(bytes),
      })
    }
  }

  if (unknown.length > 0) {
    result.unknown = unknown
  }

  return result
}

function encodeParams(params: Draft16Params, writer: BufferWriter): void {
  let count = params.unknown ? params.unknown.length : 0
  if (params.delivery_timeout !== undefined) count++
  if (params.authorization_token !== undefined) count++
  if (params.max_cache_duration !== undefined) count++
  if (params.expires !== undefined) count++
  if (params.largest_object !== undefined) count++
  if (params.publisher_priority !== undefined) count++
  if (params.forward !== undefined) count++
  if (params.subscriber_priority !== undefined) count++
  if (params.subscription_filter !== undefined) count++
  if (params.group_order !== undefined) count++
  if (params.dynamic_groups !== undefined) count++
  if (params.new_group_request !== undefined) count++
  writer.writeVarInt(count)

  if (params.delivery_timeout !== undefined) {
    writer.writeVarInt(PARAM_DELIVERY_TIMEOUT)
    writer.writeVarInt(params.delivery_timeout)
  }
  if (params.authorization_token !== undefined) {
    writer.writeVarInt(PARAM_AUTHORIZATION_TOKEN)
    const tmpW = new BufferWriter(64)
    encodeAuthorizationToken(params.authorization_token, tmpW)
    const raw = tmpW.finish()
    writer.writeVarInt(raw.byteLength)
    writer.writeBytes(raw)
  }
  if (params.max_cache_duration !== undefined) {
    writer.writeVarInt(PARAM_MAX_CACHE_DURATION)
    writer.writeVarInt(params.max_cache_duration)
  }
  if (params.expires !== undefined) {
    writer.writeVarInt(PARAM_EXPIRES)
    writer.writeVarInt(params.expires)
  }
  if (params.largest_object !== undefined) {
    writer.writeVarInt(PARAM_LARGEST_OBJECT)
    const tmpW = new BufferWriter(16)
    tmpW.writeVarInt(params.largest_object.group)
    tmpW.writeVarInt(params.largest_object.object)
    const raw = tmpW.finish()
    writer.writeVarInt(raw.byteLength)
    writer.writeBytes(raw)
  }
  if (params.publisher_priority !== undefined) {
    writer.writeVarInt(PARAM_PUBLISHER_PRIORITY)
    writer.writeVarInt(params.publisher_priority)
  }
  if (params.forward !== undefined) {
    writer.writeVarInt(PARAM_FORWARD)
    writer.writeVarInt(params.forward)
  }
  if (params.subscriber_priority !== undefined) {
    writer.writeVarInt(PARAM_SUBSCRIBER_PRIORITY)
    writer.writeVarInt(params.subscriber_priority)
  }
  if (params.subscription_filter !== undefined) {
    writer.writeVarInt(PARAM_SUBSCRIPTION_FILTER)
    const tmpW = new BufferWriter(32)
    const f = params.subscription_filter
    tmpW.writeVarInt(f.filter_type)
    if (f.filter_type === 3n || f.filter_type === 4n) {
      tmpW.writeVarInt(f.start_group!)
      tmpW.writeVarInt(f.start_object!)
    }
    if (f.filter_type === 4n) {
      tmpW.writeVarInt(f.end_group!)
    }
    const raw = tmpW.finish()
    writer.writeVarInt(raw.byteLength)
    writer.writeBytes(raw)
  }
  if (params.group_order !== undefined) {
    writer.writeVarInt(PARAM_GROUP_ORDER)
    writer.writeVarInt(params.group_order)
  }
  if (params.dynamic_groups !== undefined) {
    writer.writeVarInt(PARAM_DYNAMIC_GROUPS)
    writer.writeVarInt(params.dynamic_groups)
  }
  if (params.new_group_request !== undefined) {
    writer.writeVarInt(PARAM_NEW_GROUP_REQUEST)
    writer.writeVarInt(params.new_group_request)
  }

  if (params.unknown) {
    for (const u of params.unknown) {
      const id = BigInt(u.id)
      writer.writeVarInt(id)
      if (id % 2n === 0n) {
        const raw = hexToBytes(u.raw_hex)
        const tmpReader = new BufferReader(raw)
        const value = tmpReader.readVarInt()
        writer.writeVarInt(value)
      } else {
        const raw = hexToBytes(u.raw_hex)
        writer.writeVarInt(raw.byteLength)
        writer.writeBytes(raw)
      }
    }
  }
}

function decodeParams(reader: BufferReader): Draft16Params {
  const count = Number(reader.readVarInt())
  const result: Draft16Params = {}
  const unknown: UnknownParam[] = []

  for (let i = 0; i < count; i++) {
    const paramType = reader.readVarInt()

    if (paramType === PARAM_DELIVERY_TIMEOUT) {
      result.delivery_timeout = reader.readVarInt()
    } else if (paramType === PARAM_AUTHORIZATION_TOKEN) {
      const length = Number(reader.readVarInt())
      const tokenBytes = reader.readBytes(length)
      result.authorization_token = decodeAuthorizationToken(new BufferReader(tokenBytes))
    } else if (paramType === PARAM_MAX_CACHE_DURATION) {
      result.max_cache_duration = reader.readVarInt()
    } else if (paramType === PARAM_EXPIRES) {
      result.expires = reader.readVarInt()
    } else if (paramType === PARAM_PUBLISHER_PRIORITY) {
      result.publisher_priority = reader.readVarInt()
    } else if (paramType === PARAM_FORWARD) {
      result.forward = reader.readVarInt()
    } else if (paramType === PARAM_SUBSCRIBER_PRIORITY) {
      result.subscriber_priority = reader.readVarInt()
    } else if (paramType === PARAM_GROUP_ORDER) {
      result.group_order = reader.readVarInt()
    } else if (paramType === PARAM_DYNAMIC_GROUPS) {
      result.dynamic_groups = reader.readVarInt()
    } else if (paramType === PARAM_NEW_GROUP_REQUEST) {
      result.new_group_request = reader.readVarInt()
    } else if (paramType === PARAM_LARGEST_OBJECT) {
      const length = Number(reader.readVarInt())
      const startOff = reader.offset
      const group = reader.readVarInt()
      const object = reader.readVarInt()
      const consumed = reader.offset - startOff
      if (consumed < length) reader.readBytes(length - consumed)
      result.largest_object = { group, object }
    } else if (paramType === PARAM_SUBSCRIPTION_FILTER) {
      const length = Number(reader.readVarInt())
      const startOff = reader.offset
      const filter_type = reader.readVarInt()
      const filter: {
        filter_type: bigint
        start_group?: bigint
        start_object?: bigint
        end_group?: bigint
      } = { filter_type }
      if (filter_type === 3n || filter_type === 4n) {
        filter.start_group = reader.readVarInt()
        filter.start_object = reader.readVarInt()
      }
      if (filter_type === 4n) {
        filter.end_group = reader.readVarInt()
      }
      const consumed = reader.offset - startOff
      if (consumed < length) reader.readBytes(length - consumed)
      result.subscription_filter = filter
    } else if (paramType % 2n === 0n) {
      const value = reader.readVarInt()
      const tmpWriter = new BufferWriter(16)
      tmpWriter.writeVarInt(value)
      const raw = tmpWriter.finish()
      unknown.push({
        id: `0x${paramType.toString(16)}`,
        length: raw.byteLength,
        raw_hex: bytesToHex(raw),
      })
    } else {
      const length = Number(reader.readVarInt())
      const bytes = reader.readBytes(length)
      unknown.push({
        id: `0x${paramType.toString(16)}`,
        length,
        raw_hex: bytesToHex(bytes),
      })
    }
  }

  if (unknown.length > 0) {
    result.unknown = unknown
  }

  return result
}

// ─── Payload Encoders ──────────────────────────────────────────────────────────

function encodeClientSetupPayload(
  msg: Draft16Message & { type: 'client_setup' },
  w: BufferWriter,
): void {
  encodeSetupParams(msg.parameters, w)
}

function encodeServerSetupPayload(
  msg: Draft16Message & { type: 'server_setup' },
  w: BufferWriter,
): void {
  encodeSetupParams(msg.parameters, w)
}

function encodeSubscribePayload(
  msg: Draft16Message & { type: 'subscribe' },
  w: BufferWriter,
): void {
  w.writeVarInt(msg.request_id)
  w.writeTuple(msg.track_namespace)
  w.writeString(msg.track_name)
  encodeParams(msg.parameters, w)
}

function encodeSubscribeOkPayload(
  msg: Draft16Message & { type: 'subscribe_ok' },
  w: BufferWriter,
): void {
  w.writeVarInt(msg.request_id)
  w.writeVarInt(msg.track_alias)
  encodeParams(msg.parameters, w)
  if (msg.track_extensions) encodeTrackExtensions(msg.track_extensions, w)
}

function encodeRequestUpdatePayload(
  msg: Draft16Message & { type: 'request_update' },
  w: BufferWriter,
): void {
  w.writeVarInt(msg.request_id)
  w.writeVarInt(msg.existing_request_id)
  encodeParams(msg.parameters, w)
}

function encodeUnsubscribePayload(
  msg: Draft16Message & { type: 'unsubscribe' },
  w: BufferWriter,
): void {
  w.writeVarInt(msg.request_id)
}

function encodePublishPayload(msg: Draft16Message & { type: 'publish' }, w: BufferWriter): void {
  w.writeVarInt(msg.request_id)
  w.writeTuple(msg.track_namespace)
  w.writeString(msg.track_name)
  w.writeVarInt(msg.track_alias)
  encodeParams(msg.parameters, w)
  if (msg.track_extensions) encodeTrackExtensions(msg.track_extensions, w)
}

function encodePublishOkPayload(
  msg: Draft16Message & { type: 'publish_ok' },
  w: BufferWriter,
): void {
  w.writeVarInt(msg.request_id)
  encodeParams(msg.parameters, w)
}

function encodePublishDonePayload(
  msg: Draft16Message & { type: 'publish_done' },
  w: BufferWriter,
): void {
  w.writeVarInt(msg.request_id)
  w.writeVarInt(msg.status_code)
  w.writeVarInt(msg.stream_count)
  w.writeString(msg.reason_phrase)
}

function encodePublishNamespacePayload(
  msg: Draft16Message & { type: 'publish_namespace' },
  w: BufferWriter,
): void {
  w.writeVarInt(msg.request_id)
  w.writeTuple(msg.track_namespace)
  encodeParams(msg.parameters, w)
}

// Draft-16: simplified to just request_id
function encodePublishNamespaceDonePayload(
  msg: Draft16Message & { type: 'publish_namespace_done' },
  w: BufferWriter,
): void {
  w.writeVarInt(msg.request_id)
}

// Draft-16: changed to request_id + error_code + reason_phrase
function encodePublishNamespaceCancelPayload(
  msg: Draft16Message & { type: 'publish_namespace_cancel' },
  w: BufferWriter,
): void {
  w.writeVarInt(msg.request_id)
  w.writeVarInt(msg.error_code)
  w.writeString(msg.reason_phrase)
}

// Draft-16: added subscribe_options
function encodeSubscribeNamespacePayload(
  msg: Draft16Message & { type: 'subscribe_namespace' },
  w: BufferWriter,
): void {
  w.writeVarInt(msg.request_id)
  w.writeTuple(msg.namespace_prefix)
  w.writeVarInt(msg.subscribe_options)
  encodeParams(msg.parameters, w)
}

// New in draft-16
function encodeNamespacePayload(
  msg: Draft16Message & { type: 'namespace' },
  w: BufferWriter,
): void {
  w.writeTuple(msg.namespace_suffix)
}

// New in draft-16
function encodeNamespaceDonePayload(
  msg: Draft16Message & { type: 'namespace_done' },
  w: BufferWriter,
): void {
  w.writeTuple(msg.namespace_suffix)
}

function encodeFetchPayload(msg: Draft16Message & { type: 'fetch' }, w: BufferWriter): void {
  w.writeVarInt(msg.request_id)
  w.writeVarInt(msg.fetch_type)
  const ft = Number(msg.fetch_type)
  if (ft === 1 && msg.standalone) {
    w.writeTuple(msg.standalone.track_namespace)
    w.writeString(msg.standalone.track_name)
    w.writeVarInt(msg.standalone.start_group)
    w.writeVarInt(msg.standalone.start_object)
    w.writeVarInt(msg.standalone.end_group)
    w.writeVarInt(msg.standalone.end_object)
  } else if ((ft === 2 || ft === 3) && msg.joining) {
    w.writeVarInt(msg.joining.joining_request_id)
    w.writeVarInt(msg.joining.joining_start)
  }
  encodeParams(msg.parameters, w)
}

function encodeFetchOkPayload(msg: Draft16Message & { type: 'fetch_ok' }, w: BufferWriter): void {
  w.writeVarInt(msg.request_id)
  w.writeUint8(msg.end_of_track)
  w.writeVarInt(msg.end_group)
  w.writeVarInt(msg.end_object)
  encodeParams(msg.parameters, w)
  if (msg.track_extensions) encodeTrackExtensions(msg.track_extensions, w)
}

function encodeFetchCancelPayload(
  msg: Draft16Message & { type: 'fetch_cancel' },
  w: BufferWriter,
): void {
  w.writeVarInt(msg.request_id)
}

function encodeTrackStatusPayload(
  msg: Draft16Message & { type: 'track_status' },
  w: BufferWriter,
): void {
  w.writeVarInt(msg.request_id)
  w.writeTuple(msg.track_namespace)
  w.writeString(msg.track_name)
  encodeParams(msg.parameters, w)
}

function encodeRequestOkPayload(
  msg: Draft16Message & { type: 'request_ok' },
  w: BufferWriter,
): void {
  w.writeVarInt(msg.request_id)
  encodeParams(msg.parameters, w)
}

// Draft-16: added retry_interval
function encodeRequestErrorPayload(
  msg: Draft16Message & { type: 'request_error' },
  w: BufferWriter,
): void {
  w.writeVarInt(msg.request_id)
  w.writeVarInt(msg.error_code)
  w.writeVarInt(msg.retry_interval)
  w.writeString(msg.reason_phrase)
}

function encodeGoAwayPayload(msg: Draft16Message & { type: 'goaway' }, w: BufferWriter): void {
  w.writeString(msg.new_session_uri)
}

function encodeMaxRequestIdPayload(
  msg: Draft16Message & { type: 'max_request_id' },
  w: BufferWriter,
): void {
  w.writeVarInt(msg.max_request_id)
}

function encodeRequestsBlockedPayload(
  msg: Draft16Message & { type: 'requests_blocked' },
  w: BufferWriter,
): void {
  w.writeVarInt(msg.maximum_request_id)
}

// ─── Payload Decoders ──────────────────────────────────────────────────────────

function decodeClientSetupPayload(r: BufferReader): Draft16Message {
  const parameters = decodeSetupParams(r)
  return { type: 'client_setup', parameters }
}

function decodeServerSetupPayload(r: BufferReader): Draft16Message {
  const parameters = decodeSetupParams(r)
  return { type: 'server_setup', parameters }
}

function decodeSubscribePayload(r: BufferReader): Draft16Message {
  const request_id = r.readVarInt()
  const track_namespace = r.readTuple()
  const track_name = r.readString()
  const parameters = decodeParams(r)
  return {
    type: 'subscribe',
    request_id,
    track_namespace,
    track_name,
    parameters,
  }
}

function decodeSubscribeOkPayload(r: BufferReader): Draft16Message {
  const request_id = r.readVarInt()
  const track_alias = r.readVarInt()
  const parameters = decodeParams(r)
  const result: Record<string, unknown> = {
    type: 'subscribe_ok',
    request_id,
    track_alias,
    parameters,
  }
  if (r.remaining > 0) {
    result.track_extensions = decodeTrackExtensions(r)
  }
  return result as unknown as Draft16Message
}

function decodeRequestUpdatePayload(r: BufferReader): Draft16Message {
  const request_id = r.readVarInt()
  const existing_request_id = r.readVarInt()
  const parameters = decodeParams(r)
  return { type: 'request_update', request_id, existing_request_id, parameters }
}

function decodeUnsubscribePayload(r: BufferReader): Draft16Message {
  const request_id = r.readVarInt()
  return { type: 'unsubscribe', request_id }
}

function decodePublishPayload(r: BufferReader): Draft16Message {
  const request_id = r.readVarInt()
  const track_namespace = r.readTuple()
  const track_name = r.readString()
  const track_alias = r.readVarInt()
  const parameters = decodeParams(r)
  const result: Record<string, unknown> = {
    type: 'publish',
    request_id,
    track_namespace,
    track_name,
    track_alias,
    parameters,
  }
  if (r.remaining > 0) {
    result.track_extensions = decodeTrackExtensions(r)
  }
  return result as unknown as Draft16Message
}

function decodePublishOkPayload(r: BufferReader): Draft16Message {
  const request_id = r.readVarInt()
  const parameters = decodeParams(r)
  return { type: 'publish_ok', request_id, parameters }
}

function decodePublishDonePayload(r: BufferReader): Draft16Message {
  const request_id = r.readVarInt()
  const status_code = r.readVarInt()
  const stream_count = r.readVarInt()
  const reason_phrase = r.readString()
  return {
    type: 'publish_done',
    request_id,
    status_code,
    stream_count,
    reason_phrase,
  }
}

function decodePublishNamespacePayload(r: BufferReader): Draft16Message {
  const request_id = r.readVarInt()
  const track_namespace = r.readTuple()
  const parameters = decodeParams(r)
  return { type: 'publish_namespace', request_id, track_namespace, parameters }
}

// Draft-16: simplified to just request_id
function decodePublishNamespaceDonePayload(r: BufferReader): Draft16Message {
  const request_id = r.readVarInt()
  return { type: 'publish_namespace_done', request_id }
}

// Draft-16: changed to request_id + error_code + reason_phrase
function decodePublishNamespaceCancelPayload(r: BufferReader): Draft16Message {
  const request_id = r.readVarInt()
  const error_code = r.readVarInt()
  const reason_phrase = r.readString()
  return {
    type: 'publish_namespace_cancel',
    request_id,
    error_code,
    reason_phrase,
  }
}

// Draft-16: added subscribe_options
function decodeSubscribeNamespacePayload(r: BufferReader): Draft16Message {
  const request_id = r.readVarInt()
  const namespace_prefix = r.readTuple()
  const subscribe_options = r.readVarInt()
  const parameters = decodeParams(r)
  return {
    type: 'subscribe_namespace',
    request_id,
    namespace_prefix,
    subscribe_options,
    parameters,
  }
}

// New in draft-16
function decodeNamespacePayload(r: BufferReader): Draft16Message {
  const namespace_suffix = r.readTuple()
  return { type: 'namespace', namespace_suffix }
}

// New in draft-16
function decodeNamespaceDonePayload(r: BufferReader): Draft16Message {
  const namespace_suffix = r.readTuple()
  return { type: 'namespace_done', namespace_suffix }
}

function decodeFetchPayload(r: BufferReader): Draft16Message {
  const request_id = r.readVarInt()
  const fetch_type = r.readVarInt()
  const ft = Number(fetch_type)

  if (ft < 1 || ft > 3) {
    throw new DecodeError('CONSTRAINT_VIOLATION', `Invalid fetch_type: ${ft}`, r.offset)
  }

  let standalone: StandaloneFetch | undefined
  let joining: JoiningFetch | undefined

  if (ft === 1) {
    const track_namespace = r.readTuple()
    const track_name = r.readString()
    const start_group = r.readVarInt()
    const start_object = r.readVarInt()
    const end_group = r.readVarInt()
    const end_object = r.readVarInt()
    standalone = {
      track_namespace,
      track_name,
      start_group,
      start_object,
      end_group,
      end_object,
    }
  } else {
    const joining_request_id = r.readVarInt()
    const joining_start = r.readVarInt()
    joining = { joining_request_id, joining_start }
  }

  const parameters = decodeParams(r)

  return {
    type: 'fetch',
    request_id,
    fetch_type,
    standalone,
    joining,
    parameters,
  } as Draft16Fetch
}

function decodeFetchOkPayload(r: BufferReader): Draft16Message {
  const request_id = r.readVarInt()
  const end_of_track = r.readUint8()
  const end_group = r.readVarInt()
  const end_object = r.readVarInt()
  const parameters = decodeParams(r)
  const result: Record<string, unknown> = {
    type: 'fetch_ok',
    request_id,
    end_of_track,
    end_group,
    end_object,
    parameters,
  }
  if (r.remaining > 0) {
    result.track_extensions = decodeTrackExtensions(r)
  }
  return result as unknown as Draft16Message
}

function decodeFetchCancelPayload(r: BufferReader): Draft16Message {
  const request_id = r.readVarInt()
  return { type: 'fetch_cancel', request_id }
}

function decodeTrackStatusPayload(r: BufferReader): Draft16Message {
  const request_id = r.readVarInt()
  const track_namespace = r.readTuple()
  const track_name = r.readString()
  const parameters = decodeParams(r)
  return {
    type: 'track_status',
    request_id,
    track_namespace,
    track_name,
    parameters,
  }
}

function decodeRequestOkPayload(r: BufferReader): Draft16Message {
  const request_id = r.readVarInt()
  const parameters = decodeParams(r)
  return { type: 'request_ok', request_id, parameters }
}

// Draft-16: added retry_interval
function decodeRequestErrorPayload(r: BufferReader): Draft16Message {
  const request_id = r.readVarInt()
  const error_code = r.readVarInt()
  const retry_interval = r.readVarInt()
  const reason_phrase = r.readString()
  return {
    type: 'request_error',
    request_id,
    error_code,
    retry_interval,
    reason_phrase,
  }
}

function decodeGoAwayPayload(r: BufferReader): Draft16Message {
  const new_session_uri = r.readString()
  return { type: 'goaway', new_session_uri }
}

function decodeMaxRequestIdPayload(r: BufferReader): Draft16Message {
  const max_request_id = r.readVarInt()
  return { type: 'max_request_id', max_request_id }
}

function decodeRequestsBlockedPayload(r: BufferReader): Draft16Message {
  const maximum_request_id = r.readVarInt()
  return { type: 'requests_blocked', maximum_request_id }
}

// ─── Payload dispatch tables ───────────────────────────────────────────────────

const payloadDecoders: ReadonlyMap<bigint, (r: BufferReader) => Draft16Message> = new Map([
  [MSG_CLIENT_SETUP, decodeClientSetupPayload],
  [MSG_SERVER_SETUP, decodeServerSetupPayload],
  [MSG_SUBSCRIBE, decodeSubscribePayload],
  [MSG_SUBSCRIBE_OK, decodeSubscribeOkPayload],
  [MSG_REQUEST_UPDATE, decodeRequestUpdatePayload],
  [MSG_UNSUBSCRIBE, decodeUnsubscribePayload],
  [MSG_PUBLISH, decodePublishPayload],
  [MSG_PUBLISH_OK, decodePublishOkPayload],
  [MSG_PUBLISH_DONE, decodePublishDonePayload],
  [MSG_PUBLISH_NAMESPACE, decodePublishNamespacePayload],
  [MSG_PUBLISH_NAMESPACE_DONE, decodePublishNamespaceDonePayload],
  [MSG_PUBLISH_NAMESPACE_CANCEL, decodePublishNamespaceCancelPayload],
  [MSG_SUBSCRIBE_NAMESPACE, decodeSubscribeNamespacePayload],
  [MSG_NAMESPACE, decodeNamespacePayload],
  [MSG_NAMESPACE_DONE, decodeNamespaceDonePayload],
  [MSG_FETCH, decodeFetchPayload],
  [MSG_FETCH_OK, decodeFetchOkPayload],
  [MSG_FETCH_CANCEL, decodeFetchCancelPayload],
  [MSG_TRACK_STATUS, decodeTrackStatusPayload],
  [MSG_REQUEST_OK, decodeRequestOkPayload],
  [MSG_REQUEST_ERROR, decodeRequestErrorPayload],
  [MSG_GOAWAY, decodeGoAwayPayload],
  [MSG_MAX_REQUEST_ID, decodeMaxRequestIdPayload],
  [MSG_REQUESTS_BLOCKED, decodeRequestsBlockedPayload],
])

// ─── Public API ────────────────────────────────────────────────────────────────

/**
 * Encode a draft-16 control message with type(varint) + length(uint16 BE) + payload.
 */
export function encodeMessage(message: Draft16Message): Uint8Array {
  const typeId = MESSAGE_ID_MAP.get(message.type)
  if (typeId === undefined) {
    throw new Error(`Unknown message type: ${message.type}`)
  }

  const payloadWriter = new BufferWriter()
  encodePayload(message, payloadWriter)
  const payload = payloadWriter.finishView()

  if (payload.byteLength > 0xffff) {
    throw new Error(`Payload too large for 16-bit length: ${payload.byteLength}`)
  }

  const writer = new BufferWriter(payload.byteLength + 16)
  writer.writeVarInt(typeId)
  writer.writeUint8((payload.byteLength >> 8) & 0xff)
  writer.writeUint8(payload.byteLength & 0xff)
  writer.writeBytes(payload)

  return writer.finish()
}

function encodePayload(msg: Draft16Message, w: BufferWriter): void {
  switch (msg.type) {
    case 'client_setup':
      return encodeClientSetupPayload(msg, w)
    case 'server_setup':
      return encodeServerSetupPayload(msg, w)
    case 'subscribe':
      return encodeSubscribePayload(msg, w)
    case 'subscribe_ok':
      return encodeSubscribeOkPayload(msg, w)
    case 'request_update':
      return encodeRequestUpdatePayload(msg, w)
    case 'unsubscribe':
      return encodeUnsubscribePayload(msg, w)
    case 'publish':
      return encodePublishPayload(msg, w)
    case 'publish_ok':
      return encodePublishOkPayload(msg, w)
    case 'publish_done':
      return encodePublishDonePayload(msg, w)
    case 'publish_namespace':
      return encodePublishNamespacePayload(msg, w)
    case 'publish_namespace_done':
      return encodePublishNamespaceDonePayload(msg, w)
    case 'publish_namespace_cancel':
      return encodePublishNamespaceCancelPayload(msg, w)
    case 'subscribe_namespace':
      return encodeSubscribeNamespacePayload(msg, w)
    case 'namespace':
      return encodeNamespacePayload(msg, w)
    case 'namespace_done':
      return encodeNamespaceDonePayload(msg, w)
    case 'fetch':
      return encodeFetchPayload(msg, w)
    case 'fetch_ok':
      return encodeFetchOkPayload(msg, w)
    case 'fetch_cancel':
      return encodeFetchCancelPayload(msg, w)
    case 'track_status':
      return encodeTrackStatusPayload(msg, w)
    case 'request_ok':
      return encodeRequestOkPayload(msg, w)
    case 'request_error':
      return encodeRequestErrorPayload(msg, w)
    case 'goaway':
      return encodeGoAwayPayload(msg, w)
    case 'max_request_id':
      return encodeMaxRequestIdPayload(msg, w)
    case 'requests_blocked':
      return encodeRequestsBlockedPayload(msg, w)
    default: {
      const _exhaustive: never = msg
      throw new Error(`Unhandled message type: ${(_exhaustive as Draft16Message).type}`)
    }
  }
}

/**
 * Decode a draft-16 control message from bytes (type + uint16 length + payload).
 */
export function decodeMessage(bytes: Uint8Array): DecodeResult<Draft16Message> {
  try {
    const reader = new BufferReader(bytes)
    const typeId = reader.readVarInt()

    const lenHi = reader.readUint8()
    const lenLo = reader.readUint8()
    const payloadLength = (lenHi << 8) | lenLo

    const payloadBytes = reader.readBytes(payloadLength)
    const payloadReader = new BufferReader(payloadBytes)

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

    const message = decoder(payloadReader)
    return { ok: true, value: message, bytesRead: reader.offset }
  } catch (e) {
    if (e instanceof DecodeError) {
      return { ok: false, error: e }
    }
    throw e
  }
}

// ─── Data Stream Encoding/Decoding (re-exported from data-streams.ts) ───────

import {
  createDataStreamDecoder,
  createFetchStreamDecoder,
  createSubgroupStreamDecoder,
  decodeDatagram,
  decodeDataStream,
  decodeFetchStream,
  decodeSubgroupStream,
  encodeDatagram,
  encodeFetchStream,
  encodeSubgroupStream,
} from './data-streams.js'

export {
  createDataStreamDecoder,
  createFetchStreamDecoder,
  createSubgroupStreamDecoder,
  decodeDatagram,
  decodeDataStream,
  decodeFetchStream,
  decodeSubgroupStream,
  encodeDatagram,
  encodeFetchStream,
  encodeSubgroupStream,
}

// ─── Stream Decoders ───────────────────────────────────────────────────────────

export function createStreamDecoder(): TransformStream<Uint8Array, Draft16Message> {
  let buffer = new Uint8Array(0)
  let offset = 0

  return new TransformStream<Uint8Array, Draft16Message>({
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
          if (result.error.code === 'UNEXPECTED_END') {
            break
          }
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

// ─── Codec Factory ─────────────────────────────────────────────────────────────

export interface Draft16Codec extends BaseCodec<Draft16Message> {
  readonly draft: '16'
  encodeSubgroupStream(stream: SubgroupStream): Uint8Array
  encodeDatagram(dg: DatagramObject): Uint8Array
  encodeFetchStream(stream: FetchStream): Uint8Array
  decodeSubgroupStream(bytes: Uint8Array): DecodeResult<SubgroupStream>
  decodeDatagram(bytes: Uint8Array): DecodeResult<DatagramObject>
  decodeFetchStream(bytes: Uint8Array): DecodeResult<FetchStream>
  decodeDataStream(
    streamType: 'subgroup' | 'datagram' | 'fetch',
    bytes: Uint8Array,
  ): DecodeResult<Draft16DataStream>
  createStreamDecoder(): TransformStream<Uint8Array, Draft16Message>
  createSubgroupStreamDecoder(): TransformStream<Uint8Array, SubgroupStreamHeader | ObjectPayload>
  createFetchStreamDecoder(): TransformStream<Uint8Array, FetchStreamHeader | ObjectPayload>
  createDataStreamDecoder(): TransformStream<Uint8Array, DataStreamEvent>
}

export function createDraft16Codec(): Draft16Codec {
  return {
    draft: '16',
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
  }
}
