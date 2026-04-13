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
  PARAM_MOQT_IMPLEMENTATION,
  PARAM_PATH,
  PARAM_ROLE,
} from './messages.js'
import type {
  AuthorizationToken,
  DatagramObject,
  DataStreamEvent,
  Draft14DataStream,
  Draft14Message,
  Draft14Params,
  FetchStream,
  FetchStreamHeader,
  Location,
  ObjectPayload,
  SubgroupStream,
  SubgroupStreamHeader,
  UnknownParam,
} from './types.js'
import { FetchType, FilterType } from './types.js'

const textEncoder = /* @__PURE__ */ new TextEncoder()
const textDecoder = /* @__PURE__ */ new TextDecoder()

// ─── Parameter Constants ──────────────────────────────────────────────────────

// Setup-only parameter IDs (CLIENT_SETUP / SERVER_SETUP)
const PARAM_AUTHORITY = 0x05n
const PARAM_MAX_AUTH_TOKEN_CACHE_SIZE = 0x04n

// Message parameter IDs (SUBSCRIBE, PUBLISH, etc.)
const PARAM_DELIVERY_TIMEOUT = 0x02n
const PARAM_AUTHORIZATION_TOKEN = 0x03n
const PARAM_MAX_CACHE_DURATION = 0x04n

// ─── Parameter Encoding/Decoding ───────────────────────────────────────────────

function encodeSetupParams(params: Draft14Params, writer: BufferWriter): void {
  let count = 0
  if (params.role !== undefined) count++
  if (params.path !== undefined) count++
  if (params.max_request_id !== undefined) count++
  if (params.authorization_token !== undefined) count++
  if (params.authority !== undefined) count++
  if (params.max_auth_token_cache_size !== undefined) count++
  if (params.moqt_implementation !== undefined) count++
  if (params.unknown) count += params.unknown.length

  writer.writeVarInt(count)

  if (params.role !== undefined) {
    writer.writeVarInt(PARAM_ROLE)
    writer.writeVarInt(params.role)
  }
  if (params.path !== undefined) {
    writer.writeVarInt(PARAM_PATH)
    const encoded = textEncoder.encode(params.path)
    writer.writeVarInt(encoded.byteLength)
    writer.writeBytes(encoded)
  }
  if (params.max_request_id !== undefined) {
    writer.writeVarInt(PARAM_MAX_REQUEST_ID)
    writer.writeVarInt(params.max_request_id)
  }
  if (params.authorization_token !== undefined) {
    writer.writeVarInt(PARAM_AUTHORIZATION_TOKEN)
    const tok = params.authorization_token
    const tmpWriter = new BufferWriter(64)
    tmpWriter.writeVarInt(tok.alias_type)
    if (tok.token_type !== undefined) {
      tmpWriter.writeVarInt(tok.token_type)
    }
    if (tok.token_value !== undefined) {
      tmpWriter.writeBytes(hexToBytes(tok.token_value))
    }
    if (tok.token_alias !== undefined) {
      tmpWriter.writeVarInt(tok.token_alias)
    }
    const tokenBytes = tmpWriter.finish()
    writer.writeVarInt(tokenBytes.byteLength)
    writer.writeBytes(tokenBytes)
  }
  if (params.max_auth_token_cache_size !== undefined) {
    writer.writeVarInt(PARAM_MAX_AUTH_TOKEN_CACHE_SIZE)
    writer.writeVarInt(params.max_auth_token_cache_size)
  }
  if (params.authority !== undefined) {
    writer.writeVarInt(PARAM_AUTHORITY)
    const encoded = textEncoder.encode(params.authority)
    writer.writeVarInt(encoded.byteLength)
    writer.writeBytes(encoded)
  }
  if (params.moqt_implementation !== undefined) {
    writer.writeVarInt(PARAM_MOQT_IMPLEMENTATION)
    const encoded = textEncoder.encode(params.moqt_implementation)
    writer.writeVarInt(encoded.byteLength)
    writer.writeBytes(encoded)
  }
  if (params.unknown) {
    for (const u of params.unknown) {
      const id = BigInt(u.id)
      writer.writeVarInt(id)
      const raw = hexToBytes(u.raw_hex)
      writer.writeVarInt(raw.byteLength)
      writer.writeBytes(raw)
    }
  }
}

function decodeSetupParams(reader: BufferReader): Draft14Params {
  const count = Number(reader.readVarInt())
  const result: Draft14Params = {}
  const unknown: UnknownParam[] = []

  for (let i = 0; i < count; i++) {
    const paramType = reader.readVarInt()

    if (paramType % 2n === 0n) {
      const value = reader.readVarInt()
      if (paramType === PARAM_ROLE) {
        result.role = value
      } else if (paramType === PARAM_MAX_REQUEST_ID) {
        result.max_request_id = value
      } else if (paramType === PARAM_MAX_AUTH_TOKEN_CACHE_SIZE) {
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
      if (paramType === PARAM_PATH) {
        result.path = textDecoder.decode(bytes)
      } else if (paramType === PARAM_AUTHORIZATION_TOKEN) {
        const tokenReader = new BufferReader(bytes)
        const alias_type = tokenReader.readVarInt()
        const tok: Record<string, unknown> = { alias_type }
        if (tokenReader.remaining > 0) {
          tok.token_type = tokenReader.readVarInt()
          if (tokenReader.remaining > 0) {
            const tokenValue = tokenReader.readBytesView(tokenReader.remaining)
            tok.token_value = bytesToHex(tokenValue)
          }
        }
        result.authorization_token = tok as unknown as AuthorizationToken
      } else if (paramType === PARAM_AUTHORITY) {
        result.authority = textDecoder.decode(bytes)
      } else if (paramType === PARAM_MOQT_IMPLEMENTATION) {
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

  if (unknown.length > 0) result.unknown = unknown
  return result
}

function encodeMessageParams(params: Draft14Params, writer: BufferWriter): void {
  let count = 0
  if (params.delivery_timeout !== undefined) count++
  if (params.authorization_token !== undefined) count++
  if (params.max_cache_duration !== undefined) count++
  if (params.unknown) count += params.unknown.length

  writer.writeVarInt(count)

  if (params.delivery_timeout !== undefined) {
    writer.writeVarInt(PARAM_DELIVERY_TIMEOUT)
    writer.writeVarInt(params.delivery_timeout)
  }
  if (params.authorization_token !== undefined) {
    writer.writeVarInt(PARAM_AUTHORIZATION_TOKEN)
    const tok = params.authorization_token
    const tmpWriter = new BufferWriter(64)
    tmpWriter.writeVarInt(tok.alias_type)
    if (tok.token_type !== undefined) {
      tmpWriter.writeVarInt(tok.token_type)
    }
    if (tok.token_value !== undefined) {
      tmpWriter.writeBytes(hexToBytes(tok.token_value))
    }
    if (tok.token_alias !== undefined) {
      tmpWriter.writeVarInt(tok.token_alias)
    }
    const tokenBytes = tmpWriter.finish()
    writer.writeVarInt(tokenBytes.byteLength)
    writer.writeBytes(tokenBytes)
  }
  if (params.max_cache_duration !== undefined) {
    writer.writeVarInt(PARAM_MAX_CACHE_DURATION)
    writer.writeVarInt(params.max_cache_duration)
  }
  if (params.unknown) {
    for (const u of params.unknown) {
      const id = BigInt(u.id)
      writer.writeVarInt(id)
      const raw = hexToBytes(u.raw_hex)
      writer.writeVarInt(raw.byteLength)
      writer.writeBytes(raw)
    }
  }
}

function decodeMessageParams(reader: BufferReader): Draft14Params {
  const count = Number(reader.readVarInt())
  const result: Draft14Params = {}
  const unknown: UnknownParam[] = []

  for (let i = 0; i < count; i++) {
    const paramType = reader.readVarInt()

    if (paramType % 2n === 0n) {
      const value = reader.readVarInt()
      if (paramType === PARAM_DELIVERY_TIMEOUT) {
        result.delivery_timeout = value
      } else if (paramType === PARAM_MAX_CACHE_DURATION) {
        result.max_cache_duration = value
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
      if (paramType === PARAM_AUTHORIZATION_TOKEN) {
        const tokenReader = new BufferReader(bytes)
        const alias_type = tokenReader.readVarInt()
        const tok: Record<string, unknown> = { alias_type }
        if (tokenReader.remaining > 0) {
          tok.token_type = tokenReader.readVarInt()
          if (tokenReader.remaining > 0) {
            const tokenValue = tokenReader.readBytesView(tokenReader.remaining)
            tok.token_value = bytesToHex(tokenValue)
          }
        }
        result.authorization_token = tok as unknown as AuthorizationToken
      } else {
        unknown.push({
          id: `0x${paramType.toString(16)}`,
          length,
          raw_hex: bytesToHex(bytes),
        })
      }
    }
  }

  if (unknown.length > 0) result.unknown = unknown
  return result
}

// ─── Payload Encoders ──────────────────────────────────────────────────────────

function encodeClientSetupPayload(
  msg: Draft14Message & { type: 'client_setup' },
  w: BufferWriter,
): void {
  w.writeVarInt(msg.supported_versions.length)
  for (const v of msg.supported_versions) {
    w.writeVarInt(v)
  }
  encodeSetupParams(msg.parameters, w)
}

function encodeServerSetupPayload(
  msg: Draft14Message & { type: 'server_setup' },
  w: BufferWriter,
): void {
  w.writeVarInt(msg.selected_version)
  encodeSetupParams(msg.parameters, w)
}

function encodeSubscribePayload(
  msg: Draft14Message & { type: 'subscribe' },
  w: BufferWriter,
): void {
  w.writeVarInt(msg.request_id)
  w.writeTuple(msg.track_namespace)
  w.writeString(msg.track_name)
  w.writeUint8(Number(msg.subscriber_priority))
  w.writeUint8(Number(msg.group_order))
  w.writeVarInt(msg.forward)
  w.writeVarInt(msg.filter_type)
  const ft = msg.filter_type
  if (ft >= FilterType.AbsoluteStart) {
    w.writeVarInt(msg.start_group!)
    w.writeVarInt(msg.start_object!)
  }
  if (ft === FilterType.AbsoluteRange) {
    w.writeVarInt(msg.end_group!)
  }
  encodeMessageParams(msg.parameters, w)
}

function encodeSubscribeOkPayload(
  msg: Draft14Message & { type: 'subscribe_ok' },
  w: BufferWriter,
): void {
  w.writeVarInt(msg.request_id)
  w.writeVarInt(msg.track_alias)
  w.writeVarInt(msg.expires)
  w.writeUint8(Number(msg.group_order))
  w.writeVarInt(msg.content_exists)
  if (msg.content_exists === 1n) {
    w.writeVarInt(msg.largest_location!.group)
    w.writeVarInt(msg.largest_location!.object)
  }
  encodeMessageParams(msg.parameters, w)
}

function encodeSubscribeUpdatePayload(
  msg: Draft14Message & { type: 'subscribe_update' },
  w: BufferWriter,
): void {
  w.writeVarInt(msg.request_id)
  w.writeVarInt(msg.subscription_request_id)
  w.writeVarInt(msg.start_group)
  w.writeVarInt(msg.start_object)
  w.writeVarInt(msg.end_group)
  w.writeUint8(Number(msg.subscriber_priority))
  w.writeVarInt(msg.forward)
  encodeMessageParams(msg.parameters, w)
}

function encodeSubscribeErrorPayload(
  msg: Draft14Message & { type: 'subscribe_error' },
  w: BufferWriter,
): void {
  w.writeVarInt(msg.request_id)
  w.writeVarInt(msg.error_code)
  w.writeString(msg.reason_phrase)
}

function encodeUnsubscribePayload(
  msg: Draft14Message & { type: 'unsubscribe' },
  w: BufferWriter,
): void {
  w.writeVarInt(msg.request_id)
}

function encodePublishPayload(msg: Draft14Message & { type: 'publish' }, w: BufferWriter): void {
  w.writeVarInt(msg.request_id)
  w.writeTuple(msg.track_namespace)
  w.writeString(msg.track_name)
  w.writeVarInt(msg.track_alias)
  w.writeUint8(Number(msg.group_order))
  w.writeVarInt(msg.content_exists)
  if (msg.content_exists === 1n) {
    w.writeVarInt(msg.largest_location!.group)
    w.writeVarInt(msg.largest_location!.object)
  }
  w.writeVarInt(msg.forward)
  encodeMessageParams(msg.parameters, w)
}

function encodePublishOkPayload(
  msg: Draft14Message & { type: 'publish_ok' },
  w: BufferWriter,
): void {
  w.writeVarInt(msg.request_id)
  w.writeVarInt(msg.forward)
  w.writeUint8(Number(msg.subscriber_priority))
  w.writeUint8(Number(msg.group_order))
  w.writeVarInt(msg.filter_type)
  const ft = msg.filter_type
  if (ft >= FilterType.AbsoluteStart) {
    w.writeVarInt(msg.start_group!)
    w.writeVarInt(msg.start_object!)
  }
  if (ft === FilterType.AbsoluteRange) {
    w.writeVarInt(msg.end_group!)
  }
  encodeMessageParams(msg.parameters, w)
}

function encodePublishErrorPayload(
  msg: Draft14Message & { type: 'publish_error' },
  w: BufferWriter,
): void {
  w.writeVarInt(msg.request_id)
  w.writeVarInt(msg.error_code)
  w.writeString(msg.reason_phrase)
}

function encodePublishDonePayload(
  msg: Draft14Message & { type: 'publish_done' },
  w: BufferWriter,
): void {
  w.writeVarInt(msg.request_id)
  w.writeVarInt(msg.status_code)
  w.writeVarInt(msg.stream_count)
  w.writeString(msg.reason_phrase)
}

function encodePublishNamespacePayload(
  msg: Draft14Message & { type: 'publish_namespace' },
  w: BufferWriter,
): void {
  w.writeVarInt(msg.request_id)
  w.writeTuple(msg.track_namespace)
  encodeMessageParams(msg.parameters, w)
}

function encodePublishNamespaceOkPayload(
  msg: Draft14Message & { type: 'publish_namespace_ok' },
  w: BufferWriter,
): void {
  w.writeVarInt(msg.request_id)
  encodeMessageParams(msg.parameters, w)
}

function encodePublishNamespaceErrorPayload(
  msg: Draft14Message & { type: 'publish_namespace_error' },
  w: BufferWriter,
): void {
  w.writeVarInt(msg.request_id)
  w.writeVarInt(msg.error_code)
  w.writeString(msg.reason_phrase)
}

function encodePublishNamespaceDonePayload(
  msg: Draft14Message & { type: 'publish_namespace_done' },
  w: BufferWriter,
): void {
  w.writeTuple(msg.track_namespace)
}

function encodePublishNamespaceCancelPayload(
  msg: Draft14Message & { type: 'publish_namespace_cancel' },
  w: BufferWriter,
): void {
  w.writeTuple(msg.track_namespace)
  w.writeVarInt(msg.error_code)
  w.writeString(msg.reason_phrase)
}

function encodeSubscribeNamespacePayload(
  msg: Draft14Message & { type: 'subscribe_namespace' },
  w: BufferWriter,
): void {
  w.writeVarInt(msg.request_id)
  w.writeTuple(msg.namespace_prefix)
  encodeMessageParams(msg.parameters, w)
}

function encodeSubscribeNamespaceOkPayload(
  msg: Draft14Message & { type: 'subscribe_namespace_ok' },
  w: BufferWriter,
): void {
  w.writeVarInt(msg.request_id)
  encodeMessageParams(msg.parameters, w)
}

function encodeSubscribeNamespaceErrorPayload(
  msg: Draft14Message & { type: 'subscribe_namespace_error' },
  w: BufferWriter,
): void {
  w.writeVarInt(msg.request_id)
  w.writeVarInt(msg.error_code)
  w.writeString(msg.reason_phrase)
}

function encodeUnsubscribeNamespacePayload(
  msg: Draft14Message & { type: 'unsubscribe_namespace' },
  w: BufferWriter,
): void {
  w.writeTuple(msg.track_namespace_prefix)
}

function encodeFetchPayload(msg: Draft14Message & { type: 'fetch' }, w: BufferWriter): void {
  w.writeVarInt(msg.request_id)
  w.writeUint8(Number(msg.subscriber_priority))
  w.writeUint8(Number(msg.group_order))
  w.writeVarInt(msg.fetch_type)
  const ft = msg.fetch_type
  if (ft === FetchType.Standalone) {
    w.writeTuple(msg.track_namespace!)
    w.writeString(msg.track_name!)
    w.writeVarInt(msg.start_group!)
    w.writeVarInt(msg.start_object!)
    w.writeVarInt(msg.end_group!)
    w.writeVarInt(msg.end_object!)
  } else {
    w.writeVarInt(msg.joining_request_id!)
    w.writeVarInt(msg.joining_start!)
  }
  encodeMessageParams(msg.parameters, w)
}

function encodeFetchOkPayload(msg: Draft14Message & { type: 'fetch_ok' }, w: BufferWriter): void {
  w.writeVarInt(msg.request_id)
  w.writeUint8(Number(msg.group_order))
  w.writeVarInt(msg.end_of_track)
  w.writeVarInt(msg.end_location.group)
  w.writeVarInt(msg.end_location.object)
  encodeMessageParams(msg.parameters, w)
}

function encodeFetchErrorPayload(
  msg: Draft14Message & { type: 'fetch_error' },
  w: BufferWriter,
): void {
  w.writeVarInt(msg.request_id)
  w.writeVarInt(msg.error_code)
  w.writeString(msg.reason_phrase)
}

function encodeFetchCancelPayload(
  msg: Draft14Message & { type: 'fetch_cancel' },
  w: BufferWriter,
): void {
  w.writeVarInt(msg.request_id)
}

function encodeTrackStatusPayload(
  msg: Draft14Message & { type: 'track_status' },
  w: BufferWriter,
): void {
  w.writeVarInt(msg.request_id)
  w.writeTuple(msg.track_namespace)
  w.writeString(msg.track_name)
  w.writeUint8(Number(msg.subscriber_priority))
  w.writeUint8(Number(msg.group_order))
  w.writeVarInt(msg.forward)
  w.writeVarInt(msg.filter_type)
  const ft = msg.filter_type
  if (ft >= FilterType.AbsoluteStart) {
    w.writeVarInt(msg.start_group!)
    w.writeVarInt(msg.start_object!)
  }
  encodeMessageParams(msg.parameters, w)
}

function encodeTrackStatusOkPayload(
  msg: Draft14Message & { type: 'track_status_ok' },
  w: BufferWriter,
): void {
  w.writeVarInt(msg.request_id)
  w.writeVarInt(msg.track_alias)
  w.writeVarInt(msg.expires)
  w.writeUint8(Number(msg.group_order))
  w.writeVarInt(msg.content_exists)
  if (msg.content_exists === 1n) {
    w.writeVarInt(msg.largest_location!.group)
    w.writeVarInt(msg.largest_location!.object)
  }
  encodeMessageParams(msg.parameters, w)
}

function encodeTrackStatusErrorPayload(
  msg: Draft14Message & { type: 'track_status_error' },
  w: BufferWriter,
): void {
  w.writeVarInt(msg.request_id)
  w.writeVarInt(msg.error_code)
  w.writeString(msg.reason_phrase)
}

function encodeGoAwayPayload(msg: Draft14Message & { type: 'goaway' }, w: BufferWriter): void {
  w.writeString(msg.new_session_uri)
}

function encodeMaxRequestIdPayload(
  msg: Draft14Message & { type: 'max_request_id' },
  w: BufferWriter,
): void {
  w.writeVarInt(msg.request_id)
}

function encodeRequestsBlockedPayload(
  msg: Draft14Message & { type: 'requests_blocked' },
  w: BufferWriter,
): void {
  w.writeVarInt(msg.request_id)
}

// ─── Payload Decoders ──────────────────────────────────────────────────────────

function decodeClientSetupPayload(r: BufferReader): Draft14Message {
  const numVersions = Number(r.readVarInt())
  if (numVersions === 0) {
    throw new DecodeError(
      'CONSTRAINT_VIOLATION',
      'CLIENT_SETUP must offer at least one version',
      r.offset,
    )
  }
  const supported_versions: bigint[] = []
  for (let i = 0; i < numVersions; i++) {
    supported_versions.push(r.readVarInt())
  }
  const parameters = decodeSetupParams(r)
  return { type: 'client_setup', supported_versions, parameters }
}

function decodeServerSetupPayload(r: BufferReader): Draft14Message {
  const selected_version = r.readVarInt()
  const parameters = decodeSetupParams(r)
  return { type: 'server_setup', selected_version, parameters }
}

function decodeSubscribePayload(r: BufferReader): Draft14Message {
  const request_id = r.readVarInt()
  const track_namespace = r.readTuple()
  const track_name = r.readString()
  const subscriber_priority = BigInt(r.readUint8())
  const group_order = BigInt(r.readUint8())
  const forward = r.readVarInt()
  const filter_type = r.readVarInt()

  if (filter_type < FilterType.NextGroupStart || filter_type > FilterType.AbsoluteRange) {
    throw new DecodeError('CONSTRAINT_VIOLATION', `Invalid filter_type: ${filter_type}`, r.offset)
  }

  let start_group: bigint | undefined
  let start_object: bigint | undefined
  let end_group: bigint | undefined

  if (filter_type >= FilterType.AbsoluteStart) {
    start_group = r.readVarInt()
    start_object = r.readVarInt()
  }
  if (filter_type === FilterType.AbsoluteRange) {
    end_group = r.readVarInt()
  }

  const parameters = decodeMessageParams(r)

  const msg: Draft14Message & { type: 'subscribe' } = {
    type: 'subscribe',
    request_id,
    track_namespace,
    track_name,
    subscriber_priority,
    group_order,
    forward,
    filter_type,
    parameters,
  }

  if (start_group !== undefined) {
    return { ...msg, start_group, start_object, end_group } as Draft14Message
  }

  return msg
}

function decodeSubscribeOkPayload(r: BufferReader): Draft14Message {
  const request_id = r.readVarInt()
  const track_alias = r.readVarInt()
  const expires = r.readVarInt()
  const group_order = BigInt(r.readUint8())
  const content_exists = r.readVarInt()

  let largest_location: Location | undefined
  if (content_exists === 1n) {
    largest_location = {
      group: r.readVarInt(),
      object: r.readVarInt(),
    }
  }

  const parameters = decodeMessageParams(r)

  return {
    type: 'subscribe_ok',
    request_id,
    track_alias,
    expires,
    group_order,
    content_exists,
    parameters,
    ...(largest_location !== undefined ? { largest_location } : {}),
  } as Draft14Message
}

function decodeSubscribeUpdatePayload(r: BufferReader): Draft14Message {
  const request_id = r.readVarInt()
  const subscription_request_id = r.readVarInt()
  const start_group = r.readVarInt()
  const start_object = r.readVarInt()
  const end_group = r.readVarInt()
  const subscriber_priority = BigInt(r.readUint8())
  const forward = r.readVarInt()
  const parameters = decodeMessageParams(r)
  return {
    type: 'subscribe_update',
    request_id,
    subscription_request_id,
    start_group,
    start_object,
    end_group,
    subscriber_priority,
    forward,
    parameters,
  }
}

function decodeSubscribeErrorPayload(r: BufferReader): Draft14Message {
  const request_id = r.readVarInt()
  const error_code = r.readVarInt()
  const reason_phrase = r.readString()
  return { type: 'subscribe_error', request_id, error_code, reason_phrase }
}

function decodeUnsubscribePayload(r: BufferReader): Draft14Message {
  const request_id = r.readVarInt()
  return { type: 'unsubscribe', request_id }
}

function decodePublishPayload(r: BufferReader): Draft14Message {
  const request_id = r.readVarInt()
  const track_namespace = r.readTuple()
  const track_name = r.readString()
  const track_alias = r.readVarInt()
  const group_order = BigInt(r.readUint8())
  const content_exists = r.readVarInt()
  let largest_location: Location | undefined
  if (content_exists === 1n) {
    largest_location = {
      group: r.readVarInt(),
      object: r.readVarInt(),
    }
  }
  const forward = r.readVarInt()
  const parameters = decodeMessageParams(r)
  return {
    type: 'publish',
    request_id,
    track_namespace,
    track_name,
    track_alias,
    group_order,
    content_exists,
    forward,
    parameters,
    ...(largest_location !== undefined ? { largest_location } : {}),
  } as Draft14Message
}

function decodePublishOkPayload(r: BufferReader): Draft14Message {
  const request_id = r.readVarInt()
  const forward = r.readVarInt()
  const subscriber_priority = BigInt(r.readUint8())
  const group_order = BigInt(r.readUint8())
  const filter_type = r.readVarInt()

  let start_group: bigint | undefined
  let start_object: bigint | undefined
  let end_group: bigint | undefined

  if (filter_type >= FilterType.AbsoluteStart) {
    start_group = r.readVarInt()
    start_object = r.readVarInt()
  }
  if (filter_type === FilterType.AbsoluteRange) {
    end_group = r.readVarInt()
  }

  const parameters = decodeMessageParams(r)

  const msg: Record<string, unknown> = {
    type: 'publish_ok',
    request_id,
    forward,
    subscriber_priority,
    group_order,
    filter_type,
    parameters,
  }
  if (start_group !== undefined) msg.start_group = start_group
  if (start_object !== undefined) msg.start_object = start_object
  if (end_group !== undefined) msg.end_group = end_group

  return msg as unknown as Draft14Message
}

function decodePublishErrorPayload(r: BufferReader): Draft14Message {
  const request_id = r.readVarInt()
  const error_code = r.readVarInt()
  const reason_phrase = r.readString()
  return { type: 'publish_error', request_id, error_code, reason_phrase }
}

function decodePublishDonePayload(r: BufferReader): Draft14Message {
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

function decodePublishNamespacePayload(r: BufferReader): Draft14Message {
  const request_id = r.readVarInt()
  const track_namespace = r.readTuple()
  const parameters = decodeMessageParams(r)
  return { type: 'publish_namespace', request_id, track_namespace, parameters }
}

function decodePublishNamespaceOkPayload(r: BufferReader): Draft14Message {
  const request_id = r.readVarInt()
  const parameters = decodeMessageParams(r)
  return { type: 'publish_namespace_ok', request_id, parameters }
}

function decodePublishNamespaceErrorPayload(r: BufferReader): Draft14Message {
  const request_id = r.readVarInt()
  const error_code = r.readVarInt()
  const reason_phrase = r.readString()
  return {
    type: 'publish_namespace_error',
    request_id,
    error_code,
    reason_phrase,
  }
}

function decodePublishNamespaceDonePayload(r: BufferReader): Draft14Message {
  const track_namespace = r.readTuple()
  return { type: 'publish_namespace_done', track_namespace }
}

function decodePublishNamespaceCancelPayload(r: BufferReader): Draft14Message {
  const track_namespace = r.readTuple()
  const error_code = r.readVarInt()
  const reason_phrase = r.readString()
  return {
    type: 'publish_namespace_cancel',
    track_namespace,
    error_code,
    reason_phrase,
  }
}

function decodeSubscribeNamespacePayload(r: BufferReader): Draft14Message {
  const request_id = r.readVarInt()
  const namespace_prefix = r.readTuple()
  const parameters = decodeMessageParams(r)
  return {
    type: 'subscribe_namespace',
    request_id,
    namespace_prefix,
    parameters,
  }
}

function decodeSubscribeNamespaceOkPayload(r: BufferReader): Draft14Message {
  const request_id = r.readVarInt()
  const parameters = decodeMessageParams(r)
  return { type: 'subscribe_namespace_ok', request_id, parameters }
}

function decodeSubscribeNamespaceErrorPayload(r: BufferReader): Draft14Message {
  const request_id = r.readVarInt()
  const error_code = r.readVarInt()
  const reason_phrase = r.readString()
  return {
    type: 'subscribe_namespace_error',
    request_id,
    error_code,
    reason_phrase,
  }
}

function decodeUnsubscribeNamespacePayload(r: BufferReader): Draft14Message {
  const track_namespace_prefix = r.readTuple()
  return { type: 'unsubscribe_namespace', track_namespace_prefix }
}

function decodeFetchPayload(r: BufferReader): Draft14Message {
  const request_id = r.readVarInt()
  const subscriber_priority = BigInt(r.readUint8())
  const group_order = BigInt(r.readUint8())
  const fetch_type = r.readVarInt()

  if (fetch_type < FetchType.Standalone || fetch_type > FetchType.AbsoluteJoining) {
    throw new DecodeError('CONSTRAINT_VIOLATION', `Invalid fetch_type: ${fetch_type}`, r.offset)
  }

  if (fetch_type === FetchType.Standalone) {
    const track_namespace = r.readTuple()
    const track_name = r.readString()
    const start_group = r.readVarInt()
    const start_object = r.readVarInt()
    const end_group = r.readVarInt()
    const end_object = r.readVarInt()
    const parameters = decodeMessageParams(r)
    return {
      type: 'fetch',
      request_id,
      subscriber_priority,
      group_order,
      fetch_type,
      track_namespace,
      track_name,
      start_group,
      start_object,
      end_group,
      end_object,
      parameters,
    }
  } else {
    const joining_request_id = r.readVarInt()
    const joining_start = r.readVarInt()
    const parameters = decodeMessageParams(r)
    return {
      type: 'fetch',
      request_id,
      subscriber_priority,
      group_order,
      fetch_type,
      joining_request_id,
      joining_start,
      parameters,
    }
  }
}

function decodeFetchOkPayload(r: BufferReader): Draft14Message {
  const request_id = r.readVarInt()
  const group_order = BigInt(r.readUint8())
  const end_of_track = r.readVarInt()
  const end_location: Location = {
    group: r.readVarInt(),
    object: r.readVarInt(),
  }
  const parameters = decodeMessageParams(r)
  return {
    type: 'fetch_ok',
    request_id,
    group_order,
    end_of_track,
    end_location,
    parameters,
  }
}

function decodeFetchErrorPayload(r: BufferReader): Draft14Message {
  const request_id = r.readVarInt()
  const error_code = r.readVarInt()
  const reason_phrase = r.readString()
  return { type: 'fetch_error', request_id, error_code, reason_phrase }
}

function decodeFetchCancelPayload(r: BufferReader): Draft14Message {
  const request_id = r.readVarInt()
  return { type: 'fetch_cancel', request_id }
}

function decodeTrackStatusPayload(r: BufferReader): Draft14Message {
  const request_id = r.readVarInt()
  const track_namespace = r.readTuple()
  const track_name = r.readString()
  const subscriber_priority = BigInt(r.readUint8())
  const group_order = BigInt(r.readUint8())
  const forward = r.readVarInt()
  const filter_type = r.readVarInt()

  let start_group: bigint | undefined
  let start_object: bigint | undefined
  if (filter_type >= FilterType.AbsoluteStart) {
    start_group = r.readVarInt()
    start_object = r.readVarInt()
  }

  const parameters = decodeMessageParams(r)

  const msg: Record<string, unknown> = {
    type: 'track_status',
    request_id,
    track_namespace,
    track_name,
    subscriber_priority,
    group_order,
    forward,
    filter_type,
    parameters,
  }
  if (start_group !== undefined) msg.start_group = start_group
  if (start_object !== undefined) msg.start_object = start_object

  return msg as unknown as Draft14Message
}

function decodeTrackStatusOkPayload(r: BufferReader): Draft14Message {
  const request_id = r.readVarInt()
  const track_alias = r.readVarInt()
  const expires = r.readVarInt()
  const group_order = BigInt(r.readUint8())
  const content_exists = r.readVarInt()

  let largest_location: Location | undefined
  if (content_exists === 1n) {
    largest_location = {
      group: r.readVarInt(),
      object: r.readVarInt(),
    }
  }

  const parameters = decodeMessageParams(r)

  return {
    type: 'track_status_ok',
    request_id,
    track_alias,
    expires,
    group_order,
    content_exists,
    parameters,
    ...(largest_location !== undefined ? { largest_location } : {}),
  } as Draft14Message
}

function decodeTrackStatusErrorPayload(r: BufferReader): Draft14Message {
  const request_id = r.readVarInt()
  const error_code = r.readVarInt()
  const reason_phrase = r.readString()
  return { type: 'track_status_error', request_id, error_code, reason_phrase }
}

function decodeGoAwayPayload(r: BufferReader): Draft14Message {
  const new_session_uri = r.readString()
  return { type: 'goaway', new_session_uri }
}

function decodeMaxRequestIdPayload(r: BufferReader): Draft14Message {
  const request_id = r.readVarInt()
  return { type: 'max_request_id', request_id }
}

function decodeRequestsBlockedPayload(r: BufferReader): Draft14Message {
  const request_id = r.readVarInt()
  return { type: 'requests_blocked', request_id }
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
])

// ─── Public API ────────────────────────────────────────────────────────────────

/**
 * Encode a draft-14 control message with type(varint) + length(uint16 BE) + payload.
 */
export function encodeMessage(message: Draft14Message): Uint8Array {
  const typeId = MESSAGE_ID_MAP.get(message.type)
  if (typeId === undefined) {
    throw new Error(`Unknown message type: ${message.type}`)
  }

  // Encode payload into a separate buffer
  const payloadWriter = new BufferWriter()
  encodePayload(message, payloadWriter)
  const payload = payloadWriter.finishView()

  if (payload.byteLength > 0xffff) {
    throw new Error(`Payload too large for 16-bit length: ${payload.byteLength}`)
  }

  // Write framed message: type(varint) + length(uint16 BE) + payload
  const writer = new BufferWriter(payload.byteLength + 16)
  writer.writeVarInt(typeId)
  writer.writeUint8((payload.byteLength >> 8) & 0xff)
  writer.writeUint8(payload.byteLength & 0xff)
  writer.writeBytes(payload)

  return writer.finish()
}

function encodePayload(msg: Draft14Message, w: BufferWriter): void {
  switch (msg.type) {
    case 'client_setup':
      return encodeClientSetupPayload(msg, w)
    case 'server_setup':
      return encodeServerSetupPayload(msg, w)
    case 'subscribe':
      return encodeSubscribePayload(msg, w)
    case 'subscribe_ok':
      return encodeSubscribeOkPayload(msg, w)
    case 'subscribe_update':
      return encodeSubscribeUpdatePayload(msg, w)
    case 'subscribe_error':
      return encodeSubscribeErrorPayload(msg, w)
    case 'unsubscribe':
      return encodeUnsubscribePayload(msg, w)
    case 'publish':
      return encodePublishPayload(msg, w)
    case 'publish_ok':
      return encodePublishOkPayload(msg, w)
    case 'publish_error':
      return encodePublishErrorPayload(msg, w)
    case 'publish_done':
      return encodePublishDonePayload(msg, w)
    case 'publish_namespace':
      return encodePublishNamespacePayload(msg, w)
    case 'publish_namespace_ok':
      return encodePublishNamespaceOkPayload(msg, w)
    case 'publish_namespace_error':
      return encodePublishNamespaceErrorPayload(msg, w)
    case 'publish_namespace_done':
      return encodePublishNamespaceDonePayload(msg, w)
    case 'publish_namespace_cancel':
      return encodePublishNamespaceCancelPayload(msg, w)
    case 'subscribe_namespace':
      return encodeSubscribeNamespacePayload(msg, w)
    case 'subscribe_namespace_ok':
      return encodeSubscribeNamespaceOkPayload(msg, w)
    case 'subscribe_namespace_error':
      return encodeSubscribeNamespaceErrorPayload(msg, w)
    case 'unsubscribe_namespace':
      return encodeUnsubscribeNamespacePayload(msg, w)
    case 'fetch':
      return encodeFetchPayload(msg, w)
    case 'fetch_ok':
      return encodeFetchOkPayload(msg, w)
    case 'fetch_error':
      return encodeFetchErrorPayload(msg, w)
    case 'fetch_cancel':
      return encodeFetchCancelPayload(msg, w)
    case 'track_status':
      return encodeTrackStatusPayload(msg, w)
    case 'track_status_ok':
      return encodeTrackStatusOkPayload(msg, w)
    case 'track_status_error':
      return encodeTrackStatusErrorPayload(msg, w)
    case 'goaway':
      return encodeGoAwayPayload(msg, w)
    case 'max_request_id':
      return encodeMaxRequestIdPayload(msg, w)
    case 'requests_blocked':
      return encodeRequestsBlockedPayload(msg, w)
    default: {
      const _exhaustive: never = msg
      throw new Error(`Unhandled message type: ${(_exhaustive as Draft14Message).type}`)
    }
  }
}

/**
 * Decode a draft-14 control message from bytes (type + uint16 length + payload).
 */
export function decodeMessage(bytes: Uint8Array): DecodeResult<Draft14Message> {
  try {
    const reader = new BufferReader(bytes)
    const typeId = reader.readVarInt()

    // Read 16-bit big-endian payload length
    const lenHi = reader.readUint8()
    const lenLo = reader.readUint8()
    const payloadLength = (lenHi << 8) | lenLo

    // Read exactly payloadLength bytes
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

// ─── Data Stream Re-exports ───────────────────────────────────────���───────────

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

/**
 * Create a TransformStream that decodes a continuous byte stream (e.g. the
 * WebTransport bidirectional control stream) into individual Draft14Message
 * objects.  Uses the varint(type) + uint16_BE(length) + payload framing.
 */
export function createStreamDecoder(): TransformStream<Uint8Array, Draft14Message> {
  let buffer = new Uint8Array(0)
  let offset = 0

  return new TransformStream<Uint8Array, Draft14Message>({
    transform(chunk, controller) {
      // Compact before accumulating new data
      if (offset > 0) {
        buffer = buffer.subarray(offset)
        offset = 0
      }
      const newBuffer = new Uint8Array(buffer.length + chunk.length)
      newBuffer.set(buffer, 0)
      newBuffer.set(chunk, buffer.length)
      buffer = newBuffer

      // Try to decode messages from the buffer
      while (offset < buffer.length) {
        const result = decodeMessage(buffer.subarray(offset))
        if (!result.ok) {
          if (result.error.code === 'UNEXPECTED_END') {
            // Need more data -- wait for next chunk
            break
          }
          // Fatal decode error
          controller.error(result.error)
          return
        }
        controller.enqueue(result.value)
        // Advance offset past the consumed bytes
        offset += result.bytesRead
      }
    },

    flush(controller) {
      // If there is remaining data in the buffer, it is a truncated message
      if (offset < buffer.length) {
        controller.error(
          new DecodeError('UNEXPECTED_END', 'Stream ended with incomplete message data', 0),
        )
      }
    },
  })
}

// ─── Codec Factory ─────────────────────────────────────────────────────────────

export interface Draft14Codec extends BaseCodec<Draft14Message> {
  readonly draft: '14'
  encodeSubgroupStream(stream: SubgroupStream): Uint8Array
  encodeDatagram(dg: DatagramObject): Uint8Array
  encodeFetchStream(stream: FetchStream): Uint8Array
  decodeSubgroupStream(bytes: Uint8Array): DecodeResult<SubgroupStream>
  decodeDatagram(bytes: Uint8Array): DecodeResult<DatagramObject>
  decodeFetchStream(bytes: Uint8Array): DecodeResult<FetchStream>
  decodeDataStream(
    streamType: 'subgroup' | 'datagram' | 'fetch',
    bytes: Uint8Array,
  ): DecodeResult<Draft14DataStream>
  createStreamDecoder(): TransformStream<Uint8Array, Draft14Message>
  createSubgroupStreamDecoder(): TransformStream<Uint8Array, SubgroupStreamHeader | ObjectPayload>
  createFetchStreamDecoder(): TransformStream<Uint8Array, FetchStreamHeader | ObjectPayload>
  createDataStreamDecoder(): TransformStream<Uint8Array, DataStreamEvent>
}

export function createDraft14Codec(): Draft14Codec {
  return {
    draft: '14',
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
