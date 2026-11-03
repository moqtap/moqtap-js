import { type AuthRedaction, recordAuthValueSpan, redactWith } from '../../core/auth-redaction.js'
import { MoqtBufferReader as BufferReader } from '../../core/buffer-reader.js'
import { MoqtBufferWriter as BufferWriter } from '../../core/buffer-writer.js'
import { bytesToHex, hexToBytes } from '../../core/hex.js'
import type { ObjectProperty, ObjectPropertyInit } from '../../core/object-properties.js'
import type { BaseCodec, DecodeErrorCode, DecodeResult } from '../../core/types.js'
import { DecodeError } from '../../core/types.js'
import { SessionTerminationCode as Close } from './error-codes.js'
import {
  DEFAULT_MAX_CONTROL_MESSAGE_SIZE,
  ERROR_DETAIL_REDIRECT,
  ERROR_DETAIL_UNSUPPORTED_PROPERTY,
  MESSAGE_ID_MAP,
  MSG_FETCH,
  MSG_GOAWAY,
  MSG_NAMESPACE,
  MSG_NAMESPACE_DONE,
  MSG_PUBLISH,
  MSG_PUBLISH_DONE,
  MSG_PUBLISH_NAMESPACE,
  MSG_PUBLISH_SKIPPED,
  MSG_PUBLISH_STATE_NOTIFY,
  MSG_REQUEST_ERROR,
  MSG_REQUEST_OK,
  MSG_REQUEST_UPDATE,
  MSG_SETUP,
  MSG_SUBSCRIBE,
  MSG_SUBSCRIBE_NAMESPACE,
  MSG_SUBSCRIBE_OK,
  MSG_SUBSCRIBE_TRACKS,
  MSG_TRACK_STATUS,
  SETUP_OPT_AUTHORITY,
  SETUP_OPT_AUTHORIZATION_TOKEN,
  SETUP_OPT_MAX_AUTH_TOKEN_CACHE_SIZE,
  SETUP_OPT_MAX_CONTROL_MESSAGE_SIZE,
  SETUP_OPT_MAX_FILTER_RANGES,
  SETUP_OPT_MAX_REQUEST_UPDATES,
  SETUP_OPT_MOQT_IMPLEMENTATION,
  SETUP_OPT_PATH,
} from './messages.js'
import type {
  AuthorizationToken,
  DatagramObject,
  DataStreamEvent,
  Draft23DataStream,
  Draft23ErrorDetails,
  Draft23FillParameters,
  Draft23Message,
  Draft23Params,
  Draft23SetupOptions,
  Draft23TrackProperties,
  FetchStream,
  FetchStreamHeader,
  LocationFilter,
  ObjectPayload,
  RangeFilter,
  RangeFilterRange,
  Redirect,
  SubgroupStream,
  SubgroupStreamHeader,
  UnknownParam,
} from './types.js'

const textEncoder = /* @__PURE__ */ new TextEncoder()
const textDecoder = /* @__PURE__ */ new TextDecoder()

const REQUEST_ERROR_REDIRECT = 0x34n

/** The largest value MOQT's vi64 can carry (draft-23 Section 8.1, nine-byte form). */
const MAX_U64 = 0xffffffffffffffffn

/**
 * draft-23 Section 8.3: "The maximum length of a value is 2^16-1 bytes. If an
 * endpoint receives a length larger than the maximum, it MUST close the session
 * with FIELD_LENGTH_EXCEEDED."
 */
const KVP_MAX_VALUE_LENGTH = 0xffff

/**
 * `PUBLISH_DONE.Stream Count` "unknown" value, draft-23 Section 9.9: "If the
 * publisher is unable to set Stream Count to the exact number of streams opened
 * for the subscription, it MUST set Stream Count to 2^64 - 1." On the wire it
 * is `ff` and eight `ff` bytes. A `bigint`: it does not fit a `number`.
 */
export const UNKNOWN_STREAM_COUNT = 0xffffffffffffffffn

/** A decode failure carrying the draft-23 session termination code it calls for. */
function fail(code: DecodeErrorCode, close: bigint, message: string, offset: number): DecodeError {
  return new DecodeError(code, message, offset, close)
}

// ─── Key-Value-Pairs (draft-23 Section 8.3) ─────────────────────────────────

/**
 * The next Type in a Key-Value-Pair block. draft-23 Section 8.3: "The previous
 * Type value plus the Delta Type MUST NOT be greater than 2^64 - 1. If a Delta
 * Type is received that would be too large, the Session MUST be closed with
 * DELTA_ENCODING_OVERFLOW."
 */
function readKvpType(r: BufferReader, prevType: bigint): bigint {
  const type = prevType + r.readVarInt()
  if (type > MAX_U64) {
    throw fail(
      'CONSTRAINT_VIOLATION',
      Close.DeltaEncodingOverflow,
      'Key-Value-Pair Type exceeds 2^64 - 1',
      r.offset,
    )
  }
  return type
}

/** The Length of an odd-typed Key-Value-Pair, held to the Section 8.3 maximum. */
function readKvpLength(r: BufferReader): number {
  const length = r.readVarInt()
  if (length > BigInt(KVP_MAX_VALUE_LENGTH)) {
    throw fail(
      'CONSTRAINT_VIOLATION',
      Close.FieldLengthExceeded,
      `Key-Value-Pair Length ${length} exceeds 2^16-1`,
      r.offset,
    )
  }
  return Number(length)
}

/** Write an odd-typed Key-Value-Pair value, refusing one Section 8.3 caps. */
function writeKvpBytes(w: BufferWriter, bytes: Uint8Array): void {
  if (bytes.byteLength > KVP_MAX_VALUE_LENGTH) {
    throw new Error(`Key-Value-Pair value of ${bytes.byteLength} bytes exceeds 2^16-1`)
  }
  w.writeVarInt(BigInt(bytes.byteLength))
  w.writeBytes(bytes)
}

/** Re-emit a kept unknown Key-Value-Pair by the parity of its Type. */
function encodeUnknownKvp(u: UnknownParam, w: BufferWriter): void {
  const raw = hexToBytes(u.raw_hex)
  if (BigInt(u.id) % 2n === 0n) {
    w.writeVarInt(new BufferReader(raw).readVarInt())
  } else {
    writeKvpBytes(w, raw)
  }
}

function unknownEven(type: bigint, value: bigint): UnknownParam {
  const tmp = new BufferWriter(16)
  tmp.writeVarInt(value)
  const raw = tmp.finish()
  return { id: `0x${type.toString(16)}`, length: raw.byteLength, raw_hex: bytesToHex(raw) }
}

function unknownOdd(type: bigint, bytes: Uint8Array): UnknownParam {
  return { id: `0x${type.toString(16)}`, length: bytes.byteLength, raw_hex: bytesToHex(bytes) }
}

/** Write Key-Value-Pairs in ascending Type order, each Type a delta from the one before. */
function writeKvpEntries(
  entries: Array<{ type: bigint; encode: (w: BufferWriter) => void }>,
  writer: BufferWriter,
): void {
  entries.sort((a, b) => (a.type < b.type ? -1 : a.type > b.type ? 1 : 0))
  let prevType = 0n
  for (const entry of entries) {
    writer.writeVarInt(entry.type - prevType)
    entry.encode(writer)
    prevType = entry.type
  }
}

/**
 * A known Key-Value-Pair whose value does not match its Type. draft-23 Section
 * 8.3: "If a receiver understands a Type, and the following Value or
 * Length/Value does not match the serialization defined by that Type, the
 * receiver MUST close the session with MALFORMED_KEY_VALUE."
 */
function malformedKeyValue(message: string, offset: number): DecodeError {
  return fail('CONSTRAINT_VIOLATION', Close.MalformedKeyValue, message, offset)
}

// ─── Setup Options (draft-23 Section 9.1) ───────────────────────────────────

function encodeSetupOptions(opts: Draft23SetupOptions, writer: BufferWriter): void {
  const entries: Array<{ type: bigint; encode: (w: BufferWriter) => void }> = []

  if (opts.path !== undefined) {
    const path = opts.path
    entries.push({
      type: SETUP_OPT_PATH,
      encode: (w) => writeKvpBytes(w, textEncoder.encode(path)),
    })
  }
  for (const token of opts.authorization_token ?? []) {
    entries.push({
      type: SETUP_OPT_AUTHORIZATION_TOKEN,
      encode: (w) => writeKvpBytes(w, tokenBytes(token)),
    })
  }
  if (opts.max_auth_token_cache_size !== undefined) {
    const v = opts.max_auth_token_cache_size
    entries.push({ type: SETUP_OPT_MAX_AUTH_TOKEN_CACHE_SIZE, encode: (w) => w.writeVarInt(v) })
  }
  if (opts.authority !== undefined) {
    const authority = opts.authority
    entries.push({
      type: SETUP_OPT_AUTHORITY,
      encode: (w) => writeKvpBytes(w, textEncoder.encode(authority)),
    })
  }
  if (opts.max_filter_ranges !== undefined) {
    const v = opts.max_filter_ranges
    entries.push({ type: SETUP_OPT_MAX_FILTER_RANGES, encode: (w) => w.writeVarInt(v) })
  }
  if (opts.moqt_implementation !== undefined) {
    const impl = opts.moqt_implementation
    entries.push({
      type: SETUP_OPT_MOQT_IMPLEMENTATION,
      encode: (w) => writeKvpBytes(w, textEncoder.encode(impl)),
    })
  }
  if (opts.max_request_updates !== undefined) {
    const v = opts.max_request_updates
    entries.push({ type: SETUP_OPT_MAX_REQUEST_UPDATES, encode: (w) => w.writeVarInt(v) })
  }
  if (opts.max_control_message_size !== undefined) {
    const v = opts.max_control_message_size
    // Section 9.1.8: the value "MUST be at least 65535".
    if (v < DEFAULT_MAX_CONTROL_MESSAGE_SIZE) {
      throw new Error(`MAX_CONTROL_MESSAGE_SIZE ${v} is below the minimum of 65535`)
    }
    entries.push({
      type: SETUP_OPT_MAX_CONTROL_MESSAGE_SIZE,
      // An odd Type, so the value is Length-prefixed (Section 8.3): the Length,
      // then the one varint Section 9.1.8 defines.
      encode: (w) => {
        const tmp = new BufferWriter(16)
        tmp.writeVarInt(v)
        writeKvpBytes(w, tmp.finish())
      },
    })
  }
  for (const u of opts.unknown ?? []) {
    entries.push({ type: BigInt(u.id), encode: (w) => encodeUnknownKvp(u, w) })
  }

  writeKvpEntries(entries, writer)
}

/**
 * MAX_CONTROL_MESSAGE_SIZE's value: draft-23 Section 9.1.8 says "The value is
 * encoded as a variable-length integer", and Type 0x09 is odd, so Section 8.3
 * frames it as "a sequence of Length bytes". The Length bytes must hold exactly
 * that one varint.
 *
 * A value below 65535 decodes as sent: Section 9.1.8 requires the sender to
 * send at least 65535 and names no action for a receiver that gets less.
 */
function decodeMaxControlMessageSize(bytes: Uint8Array, offset: number): bigint {
  const r = new BufferReader(bytes)
  let value: bigint
  try {
    value = r.readVarInt()
  } catch {
    throw malformedKeyValue('MAX_CONTROL_MESSAGE_SIZE does not hold a varint', offset)
  }
  if (r.remaining > 0) {
    throw malformedKeyValue(
      `MAX_CONTROL_MESSAGE_SIZE has ${r.remaining} byte(s) after its varint`,
      offset,
    )
  }
  return value
}

/**
 * A SETUP token that refers to an alias SETUP has not registered. SETUP is the
 * first message either endpoint sends, so the only aliases it can refer to are
 * those an earlier option of the same SETUP registers. draft-23 Section 8.9:
 * "The receiver of a message referencing an Alias that is not currently
 * registered MUST reject the message with UNKNOWN_AUTH_TOKEN_ALIAS." Section
 * 9.1.4: "If a server receives Alias Type DELETE (0x0) or USE_ALIAS (0x2) in a
 * SETUP message, it MUST close the session with ROLE_VIOLATION." The code
 * depends on the receiver's role, so without `role` it is left unnamed.
 */
function checkSetupTokenAlias(
  token: AuthorizationToken,
  registered: Set<bigint>,
  offset: number,
  role: 'client' | 'server' | undefined,
) {
  const alias = token.token_alias
  if (alias === undefined) return
  if (token.alias_type === 1n) {
    registered.add(alias)
    return
  }
  if (role === 'server') {
    throw fail(
      'INVALID_PARAMETER',
      Close.RoleViolation,
      `a server may not receive Alias Type ${token.alias_type} in SETUP`,
      offset,
    )
  }
  if (!registered.has(alias)) {
    throw new DecodeError(
      'INVALID_PARAMETER',
      `SETUP Authorization Token refers to alias ${alias}, which no earlier option registers`,
      offset,
      role === 'client' ? Close.UnknownAuthTokenAlias : undefined,
    )
  }
  if (token.alias_type === 0n) {
    registered.delete(alias)
  }
}

function decodeSetupOptions(
  reader: BufferReader,
  payloadEnd: number,
  role: 'client' | 'server' | undefined,
): Draft23SetupOptions {
  const result: Draft23SetupOptions = {}
  const unknown: UnknownParam[] = []
  const registered = new Set<bigint>()
  let prevType = 0n

  while (reader.offset < payloadEnd) {
    const optType = readKvpType(reader, prevType)
    prevType = optType

    if (optType % 2n === 0n) {
      const value = reader.readVarInt()
      if (optType === SETUP_OPT_MAX_AUTH_TOKEN_CACHE_SIZE) {
        result.max_auth_token_cache_size = value
      } else if (optType === SETUP_OPT_MAX_FILTER_RANGES) {
        result.max_filter_ranges = value
      } else if (optType === SETUP_OPT_MAX_REQUEST_UPDATES) {
        result.max_request_updates = value
      } else {
        // Section 9.1: "Receivers MUST ignore unrecognized Setup Options."
        // Kept for passthrough.
        unknown.push(unknownEven(optType, value))
      }
    } else {
      const length = readKvpLength(reader)
      const bytes = reader.readBytes(length)
      if (optType === SETUP_OPT_PATH) {
        result.path = textDecoder.decode(bytes)
      } else if (optType === SETUP_OPT_AUTHORIZATION_TOKEN) {
        const token = decodeAuthorizationToken(new BufferReader(bytes), reader.offset)
        noteAuthTokenValue(reader.offset - length, length, token)
        checkSetupTokenAlias(token, registered, reader.offset, role)
        result.authorization_token = [...(result.authorization_token ?? []), token]
      } else if (optType === SETUP_OPT_AUTHORITY) {
        result.authority = textDecoder.decode(bytes)
      } else if (optType === SETUP_OPT_MOQT_IMPLEMENTATION) {
        result.moqt_implementation = textDecoder.decode(bytes)
      } else if (optType === SETUP_OPT_MAX_CONTROL_MESSAGE_SIZE) {
        result.max_control_message_size = decodeMaxControlMessageSize(bytes, reader.offset)
      } else {
        unknown.push(unknownOdd(optType, bytes))
      }
    }
  }

  if (unknown.length > 0) result.unknown = unknown
  return result
}

// ─── Authorization Token (draft-23 Section 8.9) ─────────────────────────────

/** Alias Types 0x0-0x3, draft-23 Section 16.5, Table 12. */
const MAX_ALIAS_TYPE = 3n

function tokenBytes(token: AuthorizationToken): Uint8Array {
  const tmp = new BufferWriter(64)
  encodeAuthorizationToken(token, tmp)
  return tmp.finish()
}

function encodeAuthorizationToken(token: AuthorizationToken, w: BufferWriter): void {
  if (token.alias_type < 0n || token.alias_type > MAX_ALIAS_TYPE) {
    throw new Error(`Authorization Token Alias Type ${token.alias_type} is not defined`)
  }
  const aliasType = Number(token.alias_type)
  w.writeVarInt(token.alias_type)
  if (aliasType === 0 || aliasType === 1 || aliasType === 2) {
    w.writeVarInt(token.token_alias ?? 0n)
  }
  if (aliasType === 1 || aliasType === 3) {
    // The Token Value is not length-prefixed: it is the rest of the enclosing
    // parameter or option value (Section 8.9, Figure 5).
    w.writeVarInt(token.token_type ?? 0n)
    w.writeBytes(token.token_value ?? new Uint8Array(0))
  }
}

/**
 * Record where a Token Value sits, so it can be overwritten before the frame
 * reaches anything that keeps it. The Token Value is the tail of the Token, so
 * it ends where the enclosing value ends. DELETE and USE_ALIAS carry no value
 * and record nothing.
 */
function noteAuthTokenValue(
  valueStart: number,
  valueLength: number,
  token: AuthorizationToken,
): void {
  const value = token.token_value
  if (value === undefined || value.byteLength === 0) return
  recordAuthValueSpan(valueStart + valueLength - value.byteLength, value.byteLength)
}

/**
 * draft-23 Section 8.9: "If the Token structure cannot be decoded, including an
 * unknown Alias Type, the receiver MUST close the Session with
 * MALFORMED_AUTH_TOKEN."
 */
function decodeAuthorizationToken(r: BufferReader, offset: number): AuthorizationToken {
  try {
    const alias_type = r.readVarInt()
    if (alias_type > MAX_ALIAS_TYPE) {
      throw fail(
        'INVALID_PARAMETER',
        Close.MalformedAuthToken,
        `Authorization Token Alias Type ${alias_type} is not defined`,
        offset,
      )
    }
    const aliasType = Number(alias_type)
    const result: {
      alias_type: bigint
      token_alias?: bigint
      token_type?: bigint
      token_value?: Uint8Array
    } = { alias_type }
    if (aliasType === 0 || aliasType === 1 || aliasType === 2) {
      result.token_alias = r.readVarInt()
    }
    if (aliasType === 1 || aliasType === 3) {
      result.token_type = r.readVarInt()
      result.token_value = r.readBytes(r.remaining)
    }
    return result
  } catch (e) {
    if (e instanceof DecodeError && e.code === 'UNEXPECTED_END') {
      throw fail(
        'INVALID_PARAMETER',
        Close.MalformedAuthToken,
        'Authorization Token ends before its fields',
        offset,
      )
    }
    throw e
  }
}

// ─── Track Namespace and Track Name (draft-23 Sections 2.4.1 and 8.7) ───────

/** draft-23 Section 8.7: "The maximum total length of a Full Track Name is 4,096 bytes." */
const MAX_FULL_TRACK_NAME_LENGTH = 4096
/** draft-23 Section 8.7: "greater than 32 Track Namespace Fields". */
const MAX_NAMESPACE_FIELDS = 32

/** A decoded Track Namespace and the sum of its Field Lengths. */
interface NamespaceRead {
  readonly fields: string[]
  readonly length: number
}

/**
 * Read a Track Namespace, draft-23 Section 8.7: "If an endpoint receives a
 * Track Namespace Field with a Track Namespace Field Length of 0, it MUST close
 * the session with INVALID_TRACK_NAMESPACE. If an endpoint receives a Track
 * Namespace consisting of greater than 32 Track Namespace Fields, it MUST close
 * the session with INVALID_TRACK_NAMESPACE." and "If an endpoint receives a
 * Track Namespace or a Full Track Name exceeding 4,096 bytes, it MUST close the
 * session with FIELD_LENGTH_EXCEEDED."
 */
function readNamespace(r: BufferReader): NamespaceRead {
  const count = r.readVarInt()
  if (count > BigInt(MAX_NAMESPACE_FIELDS)) {
    throw fail(
      'CONSTRAINT_VIOLATION',
      Close.InvalidTrackNamespace,
      `Track Namespace has ${count} fields, more than 32`,
      r.offset,
    )
  }
  const fields: string[] = []
  let length = 0
  for (let i = 0n; i < count; i++) {
    const fieldLength = Number(r.readVarInt())
    if (fieldLength === 0) {
      throw fail(
        'CONSTRAINT_VIOLATION',
        Close.InvalidTrackNamespace,
        'Track Namespace Field has length 0',
        r.offset,
      )
    }
    length += fieldLength
    if (length > MAX_FULL_TRACK_NAME_LENGTH) {
      throw fail(
        'CONSTRAINT_VIOLATION',
        Close.FieldLengthExceeded,
        'Track Namespace exceeds 4,096 bytes',
        r.offset,
      )
    }
    fields.push(textDecoder.decode(r.readBytesView(fieldLength)))
  }
  return { fields, length }
}

function writeNamespace(w: BufferWriter, fields: readonly string[]): void {
  if (fields.length > MAX_NAMESPACE_FIELDS) {
    throw new Error(`Track Namespace has ${fields.length} fields, more than 32`)
  }
  let length = 0
  for (const field of fields) {
    const n = textEncoder.encode(field).byteLength
    if (n === 0) throw new Error('Track Namespace Field has length 0')
    length += n
  }
  if (length > MAX_FULL_TRACK_NAME_LENGTH) {
    throw new Error('Track Namespace exceeds 4,096 bytes')
  }
  w.writeTuple([...fields])
}

/**
 * Read a Track Name after its Track Namespace. draft-23 Section 2.4.1: "Each
 * Track Name MUST contain at least one byte. If an endpoint receives a Track
 * Name with a length of 0, it MUST close the session with a
 * PROTOCOL_VIOLATION."
 */
function readTrackName(r: BufferReader, namespaceLength: number): string {
  const length = Number(r.readVarInt())
  if (length === 0) {
    throw fail('CONSTRAINT_VIOLATION', Close.ProtocolViolation, 'Track Name has length 0', r.offset)
  }
  if (namespaceLength + length > MAX_FULL_TRACK_NAME_LENGTH) {
    throw fail(
      'CONSTRAINT_VIOLATION',
      Close.FieldLengthExceeded,
      'Full Track Name exceeds 4,096 bytes',
      r.offset,
    )
  }
  return textDecoder.decode(r.readBytesView(length))
}

function writeTrackName(w: BufferWriter, namespace: readonly string[], name: string): void {
  const encoded = textEncoder.encode(name)
  if (encoded.byteLength === 0) throw new Error('Track Name must contain at least one byte')
  let length = encoded.byteLength
  for (const field of namespace) length += textEncoder.encode(field).byteLength
  if (length > MAX_FULL_TRACK_NAME_LENGTH) throw new Error('Full Track Name exceeds 4,096 bytes')
  w.writeVarInt(BigInt(encoded.byteLength))
  w.writeBytes(encoded)
}

/**
 * Reason Phrase, draft-23 Section 8.5: "The reason phrase length has a maximum
 * value of 1024 bytes. If an endpoint receives a length exceeding the maximum,
 * it MUST close the session with FIELD_LENGTH_EXCEEDED."
 */
const MAX_REASON_PHRASE_LENGTH = 1024

function readReasonPhrase(r: BufferReader): string {
  const length = r.readVarInt()
  if (length > BigInt(MAX_REASON_PHRASE_LENGTH)) {
    throw fail(
      'CONSTRAINT_VIOLATION',
      Close.FieldLengthExceeded,
      `Reason Phrase of ${length} bytes exceeds 1024`,
      r.offset,
    )
  }
  return textDecoder.decode(r.readBytesView(Number(length)))
}

function writeReasonPhrase(w: BufferWriter, phrase: string): void {
  const encoded = textEncoder.encode(phrase)
  if (encoded.byteLength > MAX_REASON_PHRASE_LENGTH) {
    throw new Error(`Reason Phrase of ${encoded.byteLength} bytes exceeds 1024`)
  }
  w.writeVarInt(BigInt(encoded.byteLength))
  w.writeBytes(encoded)
}

// ─── Message Parameter types (draft-23 Section 16.7, Table 14) ──────────────

const PARAM_OBJECT_DELIVERY_TIMEOUT = 0x02n
const PARAM_AUTHORIZATION_TOKEN = 0x03n
const PARAM_RENDEZVOUS_TIMEOUT = 0x04n
const PARAM_SUBGROUP_DELIVERY_TIMEOUT = 0x06n
const PARAM_EXPIRES = 0x08n
const PARAM_LARGEST_OBJECT = 0x09n
const PARAM_FILL_TIMEOUT = 0x0an
const PARAM_PAUSED = 0x11n
const PARAM_SUBSCRIBER_PRIORITY = 0x20n
const PARAM_LOCATION_FILTER = 0x21n
const PARAM_GROUP_ORDER = 0x22n
const PARAM_FILL_PARAMETERS = 0x23n
const PARAM_SUBGROUP_FILTER = 0x25n
const PARAM_OBJECTID_FILTER = 0x26n
const PARAM_PRIORITY_FILTER = 0x27n
const PARAM_OBJECT_PROPERTY_FILTER = 0x28n
const PARAM_TRACK_PROPERTY_FILTER = 0x29n
const PARAM_NEW_GROUP_REQUEST = 0x32n
const PARAM_TRACK_NAMESPACE_PREFIX = 0x34n
const PARAM_INCLUDE_PROPERTIES = 0x35n
const PARAM_SUBSCRIBE_TRACKS_ID = 0x36n

/**
 * The scope key for the parameters inside FILL_PARAMETERS. draft-23 Section
 * 9.19.15: "The value of FILL_PARAMETERS is a separate parameter scope.
 * Parameters inside it are not considered to appear in the enclosing message
 * for the purposes of Section 9.19, so a Parameter Type MAY appear both in the
 * message and inside FILL_PARAMETERS."
 */
const FILL_SCOPE = 'fill_parameters'

/**
 * A Message Parameter failure. Each one closes the session with
 * INVALID_PARAMETER unless the draft names another code; see draft-23 Section
 * 12.2: "INVALID_PARAMETER (0x305): A Message Parameter (Section 9.19) is
 * unknown, duplicated, not allowed in the message, or has a value outside its
 * allowed range."
 */
function invalidParameter(
  message: string,
  offset: number,
  close: bigint = Close.InvalidParameter,
): DecodeError {
  return fail('INVALID_PARAMETER', close, message, offset)
}

// ─── Range Filters (draft-23 Sections 3.3.2 and 8.6) ────────────────────────
// SetID (8), an optional Property Type (vi64) for the Object and Track
// Property filters, then delta-encoded inclusive Start/End pairs, the last End
// optional. "When Length is 0, there is no filter and no further fields are
// present." (Section 8.6)

function encodeRangeFilter(filter: RangeFilter, hasProperty: boolean, w: BufferWriter): void {
  if (filter.removed) {
    w.writeVarInt(0n)
    return
  }
  const tmpW = new BufferWriter(32)
  tmpW.writeUint8(Number(filter.set_id ?? 0n))
  if (hasProperty) {
    tmpW.writeVarInt(filter.property_type ?? 0n)
  }
  // Section 8.6: "Each Start is delta encoded from the prior Range's End (or
  // from 0 for the first Range), and End is delta encoded from its own Start."
  let prevEnd = 0n
  for (const range of filter.ranges ?? []) {
    tmpW.writeVarInt(range.start - prevEnd)
    if (range.end !== undefined) {
      tmpW.writeVarInt(range.end - range.start)
      prevEnd = range.end
    }
  }
  const raw = tmpW.finish()
  w.writeVarInt(BigInt(raw.byteLength))
  w.writeBytes(raw)
}

function decodeRangeFilter(reader: BufferReader, hasProperty: boolean): RangeFilter {
  const length = Number(reader.readVarInt())
  if (length === 0) {
    return { removed: true }
  }
  const end = reader.offset + length
  const set_id = BigInt(reader.readUint8())
  let property_type: bigint | undefined
  if (hasProperty) {
    property_type = reader.readVarInt()
  }
  const ranges: RangeFilterRange[] = []
  let prevEnd = 0n
  while (reader.offset < end) {
    const start = reader.readVarInt() + prevEnd
    if (reader.offset < end) {
      const rangeEnd = reader.readVarInt() + start
      ranges.push({ start, end: rangeEnd })
      prevEnd = rangeEnd
    } else {
      ranges.push({ start })
    }
  }
  if (reader.offset !== end) {
    throw invalidParameter('Range Filter fields run past its Length', reader.offset)
  }
  return property_type !== undefined ? { set_id, property_type, ranges } : { set_id, ranges }
}

// ─── LOCATION_FILTER (0x21), draft-23 Section 9.19.9 ────────────────────────

/**
 * How many vi64 fields follow each Location Filter Type, indexed by the type.
 * draft-23 Section 9.19.9 and Table 6: 0x00 and 0x05 carry none, 0x01
 * StartGroup alone, and 0x02, 0x03 and 0x04 the first two, three and four of
 * StartGroup, StartObject, EndGroupDelta, EndObject.
 */
const LOCATION_FILTER_FIELD_COUNTS: readonly number[] = [0, 1, 2, 3, 4, 0]

function locationFilterFieldCount(filterType: bigint): number | undefined {
  return filterType >= 0n && filterType < BigInt(LOCATION_FILTER_FIELD_COUNTS.length)
    ? LOCATION_FILTER_FIELD_COUNTS[Number(filterType)]
    : undefined
}

/**
 * Write the Location Filter Type, then exactly the fields that type defines.
 * draft-23 Section 9.19.9: "The Location Filter Type dictates which optional
 * variable-length integer fields follow, and how they are interpreted." A
 * filter whose fields do not match its type is refused, because the peer would
 * read a different number of fields than were sent.
 */
function encodeLocationFilter(f: LocationFilter, w: BufferWriter): void {
  const count = locationFilterFieldCount(f.filter_type)
  if (count === undefined) {
    throw new Error(`LOCATION_FILTER type ${f.filter_type} is not one of 0x00 through 0x05`)
  }
  const fields = [f.start_group, f.start_object, f.end_group_delta, f.end_object]
  for (const [i, field] of fields.entries()) {
    if ((field !== undefined) !== i < count) {
      throw new Error(
        `LOCATION_FILTER type ${f.filter_type} carries exactly ${count} field(s): start_group, start_object, end_group_delta, end_object in that order`,
      )
    }
  }
  if (
    f.start_group !== undefined &&
    f.end_group_delta !== undefined &&
    f.start_group + f.end_group_delta > MAX_U64
  ) {
    throw new Error('StartGroup + EndGroupDelta exceeds 2^64 - 1')
  }
  w.writeVarInt(f.filter_type)
  for (const field of fields.slice(0, count)) w.writeVarInt(field as bigint)
}

/**
 * Read the Location Filter Type, then the number of fields Table 6 gives it.
 * The value has no length of its own, so the type is what bounds it.
 *
 *  - Any type above 0x05: "If an endpoint receives any other Location Filter
 *    Type, it MUST close the session with INVALID_PARAMETER."
 *  - "If StartGroup + EndGroupDelta exceeds 2^64 - 1, the endpoint MUST close
 *    the session with DELTA_ENCODING_OVERFLOW."
 *  - Fields that run past the end of the message leave it unparseable,
 *    MALFORMED_MESSAGE.
 */
function decodeLocationFilter(reader: BufferReader): LocationFilter {
  const overrun = (what: string) =>
    invalidParameter(`LOCATION_FILTER ${what}`, reader.offset, Close.MalformedMessage)
  let filter_type: bigint
  try {
    filter_type = reader.readVarInt()
  } catch (e) {
    if (!(e instanceof DecodeError) || e.code !== 'UNEXPECTED_END') throw e
    throw overrun('type runs past the end of the message')
  }
  const count = locationFilterFieldCount(filter_type)
  if (count === undefined) {
    throw invalidParameter(
      `LOCATION_FILTER type ${filter_type} is not one of 0x00 through 0x05`,
      reader.offset,
    )
  }

  const fields: bigint[] = []
  for (let i = 0; i < count; i++) {
    try {
      fields.push(reader.readVarInt())
    } catch (e) {
      if (!(e instanceof DecodeError) || e.code !== 'UNEXPECTED_END') throw e
      throw overrun(`type ${filter_type} needs ${count} field(s) but the message ends after ${i}`)
    }
  }

  const filter: {
    filter_type: bigint
    start_group?: bigint
    start_object?: bigint
    end_group_delta?: bigint
    end_object?: bigint
  } = { filter_type }
  if (count >= 1) filter.start_group = fields[0] as bigint
  if (count >= 2) filter.start_object = fields[1] as bigint
  if (count >= 3) filter.end_group_delta = fields[2] as bigint
  if (count >= 4) filter.end_object = fields[3] as bigint

  if (
    filter.start_group !== undefined &&
    filter.end_group_delta !== undefined &&
    filter.start_group + filter.end_group_delta > MAX_U64
  ) {
    throw invalidParameter(
      'StartGroup + EndGroupDelta exceeds 2^64 - 1',
      reader.offset,
      Close.DeltaEncodingOverflow,
    )
  }

  return filter
}

/**
 * Which messages each Message Parameter may appear in, read out of draft-23's
 * per-parameter definitions (Sections 9.19.2 to 9.19.22), which agree with the
 * per-message lists of Sections 9.3 to 9.18. Section 9.19.1: "If a parameter
 * appears in some other type of message, the receiving endpoint MUST close the
 * session with INVALID_PARAMETER."
 *
 * Each set is the union over every kind of request a message can serve.
 * Section 9.3 narrows REQUEST_OK, and Section 9.5 narrows REQUEST_UPDATE, by
 * the request answered or updated, which the frame does not carry: those lists
 * are `checkRequestOk` and `checkRequestUpdate` in `rules.ts`, applied by the
 * session state machine.
 *
 * No parameter definition names NAMESPACE, so its parameter block admits none.
 *
 * `fill_parameters` in a set means the type is one of the eight Table 7 permits
 * inside FILL_PARAMETERS (Section 9.19.15).
 */
const PARAMETER_SCOPE = new Map<bigint, ReadonlySet<string>>([
  // 9.19.4: "It MAY appear in a SUBSCRIBE, PUBLISH, SUBSCRIBE_TRACKS, or
  // REQUEST_UPDATE (for a subscription) message."
  [
    PARAM_OBJECT_DELIVERY_TIMEOUT,
    new Set(['subscribe', 'publish', 'subscribe_tracks', 'request_update']),
  ],
  // 9.19.2: "It MAY appear in a PUBLISH, SUBSCRIBE, REQUEST_UPDATE,
  // SUBSCRIBE_NAMESPACE, SUBSCRIBE_TRACKS, PUBLISH_NAMESPACE, TRACK_STATUS or
  // FETCH message."
  [
    PARAM_AUTHORIZATION_TOKEN,
    new Set([
      'publish',
      'subscribe',
      'request_update',
      'subscribe_namespace',
      'subscribe_tracks',
      'publish_namespace',
      'track_status',
      'fetch',
    ]),
  ],
  // 9.19.6: "It MAY appear in a SUBSCRIBE message."
  [PARAM_RENDEZVOUS_TIMEOUT, new Set(['subscribe'])],
  // 9.19.3: as OBJECT_DELIVERY_TIMEOUT.
  [
    PARAM_SUBGROUP_DELIVERY_TIMEOUT,
    new Set(['subscribe', 'publish', 'subscribe_tracks', 'request_update']),
  ],
  // 9.19.16: "It MAY appear in PUBLISH, SUBSCRIBE_OK, FETCH_OK, or any
  // REQUEST_OK."
  [PARAM_EXPIRES, new Set(['publish', 'subscribe_ok', 'request_ok'])],
  // 9.19.17: "It MAY appear in SUBSCRIBE_OK, PUBLISH, REQUEST_UPDATE_OK,
  // TRACK_STATUS_OK, FETCH_OK, or PUBLISH_STATE_NOTIFY."
  [
    PARAM_LARGEST_OBJECT,
    new Set(['subscribe_ok', 'publish', 'request_ok', 'publish_state_notify']),
  ],
  // 9.19.5: "It MAY appear in a FETCH message, or inside a FILL_PARAMETERS
  // parameter".
  [PARAM_FILL_TIMEOUT, new Set(['fetch', FILL_SCOPE])],
  // 9.19.18: "It MAY appear in SUBSCRIBE, REQUEST_UPDATE (for a subscription or
  // a SUBSCRIBE_TRACKS request), PUBLISH, SUBSCRIBE_TRACKS and
  // PUBLISH_STATE_NOTIFY."
  [
    PARAM_PAUSED,
    new Set(['subscribe', 'request_update', 'publish', 'subscribe_tracks', 'publish_state_notify']),
  ],
  // 9.19.7: "It MAY appear in a SUBSCRIBE, PUBLISH, SUBSCRIBE_TRACKS, FETCH, or
  // REQUEST_UPDATE (for a subscription or FETCH), or inside a FILL_PARAMETERS
  // parameter".
  [
    PARAM_SUBSCRIBER_PRIORITY,
    new Set(['subscribe', 'publish', 'subscribe_tracks', 'fetch', 'request_update', FILL_SCOPE]),
  ],
  // 9.19.9: "MAY appear in a FETCH, SUBSCRIBE, PUBLISH, SUBSCRIBE_TRACKS,
  // REQUEST_UPDATE (for a subscription) or PUBLISH_STATE_NOTIFY message, or
  // inside a FILL_PARAMETERS parameter".
  [
    PARAM_LOCATION_FILTER,
    new Set([
      'fetch',
      'subscribe',
      'publish',
      'subscribe_tracks',
      'request_update',
      'publish_state_notify',
      FILL_SCOPE,
    ]),
  ],
  // 9.19.8: "It MAY appear in a SUBSCRIBE, PUBLISH, SUBSCRIBE_TRACKS, or FETCH,
  // or inside a FILL_PARAMETERS parameter".
  [PARAM_GROUP_ORDER, new Set(['subscribe', 'publish', 'subscribe_tracks', 'fetch', FILL_SCOPE])],
  // 9.19.15: "MAY appear in a SUBSCRIBE, SUBSCRIBE_TRACKS, PUBLISH, or
  // REQUEST_UPDATE (for a subscription) message." Not in Table 7, so never
  // inside itself.
  [PARAM_FILL_PARAMETERS, new Set(['subscribe', 'subscribe_tracks', 'publish', 'request_update'])],
  // 3.3.2: "All other filter parameters MAY appear multiple times in a FETCH,
  // SUBSCRIBE, SUBSCRIBE_TRACKS, or REQUEST_UPDATE (on a subscription, from the
  // subscriber only) message." Table 7 admits them inside FILL_PARAMETERS.
  [
    PARAM_SUBGROUP_FILTER,
    new Set(['fetch', 'subscribe', 'subscribe_tracks', 'request_update', FILL_SCOPE]),
  ],
  [
    PARAM_OBJECTID_FILTER,
    new Set(['fetch', 'subscribe', 'subscribe_tracks', 'request_update', FILL_SCOPE]),
  ],
  [
    PARAM_PRIORITY_FILTER,
    new Set(['fetch', 'subscribe', 'subscribe_tracks', 'request_update', FILL_SCOPE]),
  ],
  [
    PARAM_OBJECT_PROPERTY_FILTER,
    new Set(['fetch', 'subscribe', 'subscribe_tracks', 'request_update', FILL_SCOPE]),
  ],
  // 3.3.2: "The Track Property filter parameter MAY appear multiple times in a
  // SUBSCRIBE_TRACKS message or REQUEST_UPDATE for it." Not in Table 7.
  [PARAM_TRACK_PROPERTY_FILTER, new Set(['subscribe_tracks', 'request_update'])],
  // 9.19.19: "It MAY appear in SUBSCRIBE or REQUEST_UPDATE for a subscription."
  [PARAM_NEW_GROUP_REQUEST, new Set(['subscribe', 'request_update'])],
  // 9.19.20: "It MAY appear in REQUEST_UPDATE for a SUBSCRIBE_NAMESPACE or
  // SUBSCRIBE_TRACKS request."
  [PARAM_TRACK_NAMESPACE_PREFIX, new Set(['request_update'])],
  // 9.19.22: "It MAY appear in SUBSCRIBE, TRACK_STATUS, FETCH or
  // SUBSCRIBE_TRACKS."
  [PARAM_INCLUDE_PROPERTIES, new Set(['subscribe', 'track_status', 'fetch', 'subscribe_tracks'])],
  // 9.19.21: "It appears only in a PUBLISH sent as a result of a
  // SUBSCRIBE_TRACKS".
  [PARAM_SUBSCRIBE_TRACKS_ID, new Set(['publish'])],
])

/**
 * The types a message may carry more than once. draft-23 Section 9.19:
 * "Senders MUST NOT repeat the same Parameter Type in a message unless the
 * parameter definition explicitly allows multiple instances of that type to be
 * sent in a single message. Receivers SHOULD check that there are no unexpected
 * duplicate parameters and close the session with INVALID_PARAMETER if found."
 * Section 8.9: "An Authorization Token MAY be repeated within a message"; the
 * five Range Filters by Section 3.3.2.
 */
const REPEATABLE_PARAMETERS: ReadonlySet<bigint> = new Set([
  PARAM_AUTHORIZATION_TOKEN,
  PARAM_SUBGROUP_FILTER,
  PARAM_OBJECTID_FILTER,
  PARAM_PRIORITY_FILTER,
  PARAM_OBJECT_PROPERTY_FILTER,
  PARAM_TRACK_PROPERTY_FILTER,
])

/** Refuse a parameter the message may not carry, the encoder's half of Section 9.19.1. */
function requireInScope(type: bigint, messageType: string): void {
  const scope = PARAMETER_SCOPE.get(type)
  if (scope !== undefined && !scope.has(messageType)) {
    throw new Error(`Message Parameter 0x${type.toString(16)} may not appear in ${messageType}`)
  }
}

function writeUint8Param(w: BufferWriter, value: bigint, name: string): void {
  if (value < 0n || value > 255n) throw new Error(`${name} is a uint8, got ${value}`)
  w.writeUint8(Number(value))
}

function encodeParams(params: Draft23Params, writer: BufferWriter, messageType: string): void {
  const entries: Array<{ type: bigint; encode: (w: BufferWriter) => void }> = []
  const push = (type: bigint, encode: (w: BufferWriter) => void) => {
    requireInScope(type, messageType)
    entries.push({ type, encode })
  }

  if (params.object_delivery_timeout !== undefined) {
    const v = params.object_delivery_timeout
    push(PARAM_OBJECT_DELIVERY_TIMEOUT, (w) => w.writeVarInt(v))
  }
  for (const token of params.authorization_token ?? []) {
    // Section 9.19.2: "uses Length-prefixed encoding".
    push(PARAM_AUTHORIZATION_TOKEN, (w) => {
      const raw = tokenBytes(token)
      w.writeVarInt(BigInt(raw.byteLength))
      w.writeBytes(raw)
    })
  }
  if (params.rendezvous_timeout !== undefined) {
    const v = params.rendezvous_timeout
    push(PARAM_RENDEZVOUS_TIMEOUT, (w) => w.writeVarInt(v))
  }
  if (params.subgroup_delivery_timeout !== undefined) {
    const v = params.subgroup_delivery_timeout
    push(PARAM_SUBGROUP_DELIVERY_TIMEOUT, (w) => w.writeVarInt(v))
  }
  if (params.expires !== undefined) {
    const v = params.expires
    push(PARAM_EXPIRES, (w) => w.writeVarInt(v))
  }
  if (params.largest_object !== undefined) {
    // Section 9.19.17: "is a Location", which Section 9.19 defines as "Two
    // consecutive varints (Group, Object)". No length, odd Type or not: the
    // Key-Value-Pair parity rule does not apply to Message Parameters.
    const { group, object } = params.largest_object
    push(PARAM_LARGEST_OBJECT, (w) => {
      w.writeVarInt(group)
      w.writeVarInt(object)
    })
  }
  if (params.fill_timeout !== undefined) {
    const v = params.fill_timeout
    push(PARAM_FILL_TIMEOUT, (w) => w.writeVarInt(v))
  }
  if (params.paused !== undefined) {
    const v = params.paused
    if (v !== 0n && v !== 1n) throw new Error(`PAUSED accepts only 0 or 1, got ${v}`)
    push(PARAM_PAUSED, (w) => w.writeUint8(Number(v)))
  }
  if (params.subscriber_priority !== undefined) {
    const v = params.subscriber_priority
    push(PARAM_SUBSCRIBER_PRIORITY, (w) => writeUint8Param(w, v, 'SUBSCRIBER_PRIORITY'))
  }
  if (params.location_filter !== undefined) {
    const f = params.location_filter
    push(PARAM_LOCATION_FILTER, (w) => encodeLocationFilter(f, w))
  }
  if (params.group_order !== undefined) {
    const v = params.group_order
    if (v !== 1n && v !== 2n) throw new Error(`GROUP_ORDER accepts only 1 or 2, got ${v}`)
    push(PARAM_GROUP_ORDER, (w) => w.writeUint8(Number(v)))
  }
  if (params.fill_parameters !== undefined) {
    const inner = params.fill_parameters as Draft23Params
    // Section 9.19.15: "Its value is a Number of Parameters (vi64) followed by
    // that many Parameters". No byte length: the inner block is written in
    // place, with its own Type Delta chain starting from 0, and the outer
    // parameter after it deltas from 0x23.
    push(PARAM_FILL_PARAMETERS, (w) => encodeParams(inner, w, FILL_SCOPE))
  }
  for (const filter of params.subgroup_filter ?? []) {
    push(PARAM_SUBGROUP_FILTER, (w) => encodeRangeFilter(filter, false, w))
  }
  for (const filter of params.objectid_filter ?? []) {
    push(PARAM_OBJECTID_FILTER, (w) => encodeRangeFilter(filter, false, w))
  }
  for (const filter of params.priority_filter ?? []) {
    push(PARAM_PRIORITY_FILTER, (w) => encodeRangeFilter(filter, false, w))
  }
  for (const filter of params.object_property_filter ?? []) {
    push(PARAM_OBJECT_PROPERTY_FILTER, (w) => encodeRangeFilter(filter, true, w))
  }
  for (const filter of params.track_property_filter ?? []) {
    push(PARAM_TRACK_PROPERTY_FILTER, (w) => encodeRangeFilter(filter, true, w))
  }
  if (params.new_group_request !== undefined) {
    const v = params.new_group_request
    push(PARAM_NEW_GROUP_REQUEST, (w) => w.writeVarInt(v))
  }
  if (params.track_namespace_prefix !== undefined) {
    // Section 9.19.20: "uses the Track Namespace encoding described in Section
    // 8.7", which states its own field count; there is no byte length.
    const prefix = params.track_namespace_prefix
    push(PARAM_TRACK_NAMESPACE_PREFIX, (w) => writeNamespace(w, prefix))
  }
  if (params.include_properties !== undefined) {
    const v = params.include_properties
    if (v !== 0n && v !== 1n) throw new Error(`INCLUDE_PROPERTIES accepts only 0 or 1, got ${v}`)
    push(PARAM_INCLUDE_PROPERTIES, (w) => w.writeUint8(Number(v)))
  }
  if (params.subscribe_tracks_id !== undefined) {
    const v = params.subscribe_tracks_id
    push(PARAM_SUBSCRIBE_TRACKS_ID, (w) => w.writeVarInt(v))
  }
  for (const u of params.unknown ?? []) {
    // A parameter this codec does not know is re-emitted byte for byte.
    entries.push({ type: BigInt(u.id), encode: (w) => w.writeBytes(hexToBytes(u.raw_hex)) })
  }

  entries.sort((a, b) => (a.type < b.type ? -1 : a.type > b.type ? 1 : 0))
  writer.writeVarInt(BigInt(entries.length))
  let prevType = 0n
  for (const entry of entries) {
    writer.writeVarInt(entry.type - prevType)
    entry.encode(writer)
    prevType = entry.type
  }
}

/** A uint8 parameter that admits only `allowed`. */
function readBoundedUint8(reader: BufferReader, name: string, allowed: readonly bigint[]): bigint {
  const value = BigInt(reader.readUint8())
  if (!allowed.includes(value)) {
    throw invalidParameter(
      `${name} accepts only ${allowed.join(' or ')}, got ${value}`,
      reader.offset,
    )
  }
  return value
}

function decodeParams(reader: BufferReader, messageType: string): Draft23Params {
  const count = reader.readVarInt()
  const result: Draft23Params = {}
  const seen = new Set<bigint>()
  let prevType = 0n

  for (let i = 0n; i < count; i++) {
    // Section 9.19: "If the resulting Type would be greater than 2^64 - 1, the
    // endpoint MUST close the session with DELTA_ENCODING_OVERFLOW."
    const paramType = prevType + reader.readVarInt()
    if (paramType > MAX_U64) {
      throw invalidParameter(
        'Parameter Type exceeds 2^64 - 1',
        reader.offset,
        Close.DeltaEncodingOverflow,
      )
    }
    prevType = paramType

    const scope = PARAMETER_SCOPE.get(paramType)
    if (scope === undefined) {
      // Section 9.19: "All Message Parameters MUST be defined in the negotiated
      // version of MOQT or negotiated via Setup Options. An endpoint that
      // receives an unknown Message Parameter MUST close the session with
      // INVALID_PARAMETER." Its encoding comes from its definition, so an
      // unknown one cannot be skipped either.
      throw invalidParameter(
        `Unknown Message Parameter type 0x${paramType.toString(16)}`,
        reader.offset,
      )
    }
    if (!scope.has(messageType)) {
      throw invalidParameter(
        `Message Parameter 0x${paramType.toString(16)} may not appear in ${messageType}`,
        reader.offset,
      )
    }
    if (seen.has(paramType) && !REPEATABLE_PARAMETERS.has(paramType)) {
      throw invalidParameter(
        `Message Parameter 0x${paramType.toString(16)} appears more than once`,
        reader.offset,
      )
    }
    seen.add(paramType)

    if (paramType === PARAM_OBJECT_DELIVERY_TIMEOUT) {
      result.object_delivery_timeout = reader.readVarInt()
    } else if (paramType === PARAM_AUTHORIZATION_TOKEN) {
      const length = Number(reader.readVarInt())
      const bytes = reader.readBytes(length)
      const token = decodeAuthorizationToken(new BufferReader(bytes), reader.offset)
      noteAuthTokenValue(reader.offset - length, length, token)
      result.authorization_token = [...(result.authorization_token ?? []), token]
    } else if (paramType === PARAM_RENDEZVOUS_TIMEOUT) {
      result.rendezvous_timeout = reader.readVarInt()
    } else if (paramType === PARAM_SUBGROUP_DELIVERY_TIMEOUT) {
      result.subgroup_delivery_timeout = reader.readVarInt()
    } else if (paramType === PARAM_EXPIRES) {
      result.expires = reader.readVarInt()
    } else if (paramType === PARAM_LARGEST_OBJECT) {
      const group = reader.readVarInt()
      const object = reader.readVarInt()
      result.largest_object = { group, object }
    } else if (paramType === PARAM_FILL_TIMEOUT) {
      result.fill_timeout = reader.readVarInt()
    } else if (paramType === PARAM_PAUSED) {
      // Section 9.19.18: "The allowed values are 0 (unpaused) or 1 (paused). If
      // an endpoint receives a value outside this range, it MUST close the
      // session with INVALID_PARAMETER."
      result.paused = readBoundedUint8(reader, 'PAUSED', [0n, 1n])
    } else if (paramType === PARAM_SUBSCRIBER_PRIORITY) {
      result.subscriber_priority = BigInt(reader.readUint8())
    } else if (paramType === PARAM_LOCATION_FILTER) {
      result.location_filter = decodeLocationFilter(reader)
    } else if (paramType === PARAM_GROUP_ORDER) {
      // Section 9.19.8: "The allowed values are Ascending (0x1) or Descending
      // (0x2). If an endpoint receives a value outside this range, it MUST
      // close the session with INVALID_PARAMETER."
      result.group_order = readBoundedUint8(reader, 'GROUP_ORDER', [1n, 2n])
    } else if (paramType === PARAM_FILL_PARAMETERS) {
      // Section 9.19.15: "An endpoint that receives a parameter inside
      // FILL_PARAMETERS that is not listed above MUST close the session with
      // INVALID_PARAMETER." That is the FILL_SCOPE entries of PARAMETER_SCOPE.
      result.fill_parameters = decodeParams(reader, FILL_SCOPE) as Draft23FillParameters
    } else if (paramType === PARAM_SUBGROUP_FILTER) {
      result.subgroup_filter = [...(result.subgroup_filter ?? []), decodeRangeFilter(reader, false)]
    } else if (paramType === PARAM_OBJECTID_FILTER) {
      result.objectid_filter = [...(result.objectid_filter ?? []), decodeRangeFilter(reader, false)]
    } else if (paramType === PARAM_PRIORITY_FILTER) {
      result.priority_filter = [...(result.priority_filter ?? []), decodeRangeFilter(reader, false)]
    } else if (paramType === PARAM_OBJECT_PROPERTY_FILTER) {
      result.object_property_filter = [
        ...(result.object_property_filter ?? []),
        decodeRangeFilter(reader, true),
      ]
    } else if (paramType === PARAM_TRACK_PROPERTY_FILTER) {
      result.track_property_filter = [
        ...(result.track_property_filter ?? []),
        decodeRangeFilter(reader, true),
      ]
    } else if (paramType === PARAM_NEW_GROUP_REQUEST) {
      result.new_group_request = reader.readVarInt()
    } else if (paramType === PARAM_TRACK_NAMESPACE_PREFIX) {
      result.track_namespace_prefix = readNamespace(reader).fields
    } else if (paramType === PARAM_INCLUDE_PROPERTIES) {
      // Section 9.19.22: "The allowed values are 0 (do not send Properties) or
      // 1 (send Properties), and the default is 1. If an endpoint receives a
      // value outside this range, it MUST close the session with
      // INVALID_PARAMETER."
      result.include_properties = readBoundedUint8(reader, 'INCLUDE_PROPERTIES', [0n, 1n])
    } else if (paramType === PARAM_SUBSCRIBE_TRACKS_ID) {
      result.subscribe_tracks_id = reader.readVarInt()
    }
  }

  return result
}

// ─── Track Properties (draft-23 Sections 8.4 and 10) ────────────────────────

const TPROP_OBJECT_DELIVERY_TIMEOUT = 0x02n
const TPROP_MAX_CACHE_DURATION = 0x04n
const TPROP_SUBGROUP_DELIVERY_TIMEOUT = 0x06n
const TPROP_IMMUTABLE_PROPERTIES = 0x0bn
const TPROP_DEFAULT_PUBLISHER_PRIORITY = 0x0en
const TPROP_DEFAULT_PUBLISHER_GROUP_ORDER = 0x22n
const TPROP_DYNAMIC_GROUPS = 0x30n

function encodeTrackProperties(props: Draft23TrackProperties, writer: BufferWriter): void {
  const entries: Array<{ type: bigint; encode: (w: BufferWriter) => void }> = []
  const even = (type: bigint, value: bigint | undefined) => {
    if (value !== undefined) entries.push({ type, encode: (w) => w.writeVarInt(value) })
  }

  even(TPROP_OBJECT_DELIVERY_TIMEOUT, props.object_delivery_timeout)
  even(TPROP_MAX_CACHE_DURATION, props.max_cache_duration)
  even(TPROP_SUBGROUP_DELIVERY_TIMEOUT, props.subgroup_delivery_timeout)
  if (props.immutable_properties !== undefined) {
    const raw = props.immutable_properties
    entries.push({ type: TPROP_IMMUTABLE_PROPERTIES, encode: (w) => writeKvpBytes(w, raw) })
  }
  even(TPROP_DEFAULT_PUBLISHER_PRIORITY, props.default_publisher_priority)
  even(TPROP_DEFAULT_PUBLISHER_GROUP_ORDER, props.default_publisher_group_order)
  even(TPROP_DYNAMIC_GROUPS, props.dynamic_groups)
  for (const u of props.unknown ?? []) {
    entries.push({ type: BigInt(u.id), encode: (w) => encodeUnknownKvp(u, w) })
  }

  writeKvpEntries(entries, writer)
}

type EvenTrackProperty =
  | 'object_delivery_timeout'
  | 'max_cache_duration'
  | 'subgroup_delivery_timeout'
  | 'default_publisher_priority'
  | 'default_publisher_group_order'
  | 'dynamic_groups'

const EVEN_TRACK_PROPERTIES: ReadonlyMap<bigint, EvenTrackProperty> = new Map([
  [TPROP_OBJECT_DELIVERY_TIMEOUT, 'object_delivery_timeout'],
  [TPROP_MAX_CACHE_DURATION, 'max_cache_duration'],
  [TPROP_SUBGROUP_DELIVERY_TIMEOUT, 'subgroup_delivery_timeout'],
  [TPROP_DEFAULT_PUBLISHER_PRIORITY, 'default_publisher_priority'],
  [TPROP_DEFAULT_PUBLISHER_GROUP_ORDER, 'default_publisher_group_order'],
  [TPROP_DYNAMIC_GROUPS, 'dynamic_groups'],
])

function checkTrackPropertyValue(propType: bigint, value: bigint, offset: number): void {
  if (propType === TPROP_DEFAULT_PUBLISHER_PRIORITY && value > 255n) {
    // Section 10.4: "If an endpoint receives a value above 255, it MUST close
    // the session with MALFORMED_KEY_VALUE."
    throw malformedKeyValue(`DEFAULT_PUBLISHER_PRIORITY ${value} is above 255`, offset)
  }
  if (propType === TPROP_DEFAULT_PUBLISHER_GROUP_ORDER && value !== 1n && value !== 2n) {
    // Section 10.5: "The allowed values are Ascending (0x1) or Descending
    // (0x2). If an endpoint receives a value outside this range, it MUST close
    // the session with MALFORMED_KEY_VALUE."
    throw malformedKeyValue(
      `DEFAULT_PUBLISHER_GROUP_ORDER accepts only 1 or 2, got ${value}`,
      offset,
    )
  }
  if (propType === TPROP_DYNAMIC_GROUPS && value > 1n) {
    // Section 10.6: "If an endpoint receives a value larger than 1, it MUST
    // close the session with MALFORMED_KEY_VALUE."
    throw malformedKeyValue(`DYNAMIC_GROUPS ${value} is larger than 1`, offset)
  }
}

/**
 * Unknown Properties are kept and passed on, as Section 8.4 says. A repeat of
 * a known Property is kept in `unknown` as well: Section 8.4 has the receiver
 * "treat the Track as malformed", which is not a decode failure, so the repeat
 * stays visible to `malformedTrackPropertiesReason`.
 */
function decodeTrackProperties(reader: BufferReader, payloadEnd: number): Draft23TrackProperties {
  const result: Draft23TrackProperties = {}
  const unknown: UnknownParam[] = []
  let prevType = 0n

  while (reader.offset < payloadEnd) {
    const propType = readKvpType(reader, prevType)
    prevType = propType

    if (propType % 2n === 0n) {
      const value = reader.readVarInt()
      checkTrackPropertyValue(propType, value, reader.offset)
      const field = EVEN_TRACK_PROPERTIES.get(propType)
      if (field !== undefined && result[field] === undefined) result[field] = value
      else unknown.push(unknownEven(propType, value))
    } else {
      const length = readKvpLength(reader)
      const bytes = reader.readBytes(length)
      if (propType === TPROP_IMMUTABLE_PROPERTIES && result.immutable_properties === undefined) {
        result.immutable_properties = bytes
      } else {
        unknown.push(unknownOdd(propType, bytes))
      }
    }
  }

  if (unknown.length > 0) result.unknown = unknown
  return result
}

// ─── REQUEST_ERROR Error Details (draft-23 Section 9.4.2) ───────────────────

function encodeRedirect(redirect: Redirect): Uint8Array {
  const w = new BufferWriter(64)
  const uri = textEncoder.encode(redirect.connect_uri)
  w.writeVarInt(BigInt(uri.byteLength))
  w.writeBytes(uri)
  writeNamespace(w, redirect.track_namespace)
  // Section 9.4.2.1: the Track Name "MUST be empty" for a namespace-scoped
  // request, so the Section 2.4.1 at-least-one-byte rule does not reach here.
  const name = textEncoder.encode(redirect.track_name)
  w.writeVarInt(BigInt(name.byteLength))
  w.writeBytes(name)
  return w.finish()
}

/**
 * The REDIRECT Error Detail value, draft-23 Section 9.4.2.1: "Connect URI
 * Length (vi64), Connect URI (..), Track Namespace (..), Track Name Length
 * (vi64), Track Name (..)", exactly filling the detail's Length.
 */
function decodeRedirect(bytes: Uint8Array, offset: number): Redirect {
  const r = new BufferReader(bytes)
  try {
    const uriLength = Number(r.readVarInt())
    const connect_uri = textDecoder.decode(r.readBytesView(uriLength))
    const ns = readNamespace(r)
    const nameLength = Number(r.readVarInt())
    if (ns.length + nameLength > MAX_FULL_TRACK_NAME_LENGTH) {
      throw fail(
        'CONSTRAINT_VIOLATION',
        Close.FieldLengthExceeded,
        'Redirect target exceeds 4,096 bytes',
        offset,
      )
    }
    const track_name = textDecoder.decode(r.readBytesView(nameLength))
    if (r.remaining > 0) {
      throw malformedKeyValue(`REDIRECT Error Detail has ${r.remaining} trailing byte(s)`, offset)
    }
    return { connect_uri, track_namespace: ns.fields, track_name }
  } catch (e) {
    if (e instanceof DecodeError && e.code === 'UNEXPECTED_END') {
      throw malformedKeyValue('REDIRECT Error Detail ends before its fields', offset)
    }
    throw e
  }
}

function encodeErrorDetails(details: Draft23ErrorDetails, writer: BufferWriter): void {
  const entries: Array<{ type: bigint; encode: (w: BufferWriter) => void }> = []
  if (details.redirect !== undefined) {
    const value = encodeRedirect(details.redirect)
    entries.push({ type: ERROR_DETAIL_REDIRECT, encode: (w) => writeKvpBytes(w, value) })
  }
  for (const property of details.unsupported_property ?? []) {
    entries.push({
      type: ERROR_DETAIL_UNSUPPORTED_PROPERTY,
      encode: (w) => w.writeVarInt(property),
    })
  }
  for (const u of details.unknown ?? []) {
    entries.push({ type: BigInt(u.id), encode: (w) => encodeUnknownKvp(u, w) })
  }
  writeKvpEntries(entries, writer)
}

/**
 * Error Details are Key-Value-Pairs "spanning the remainder of the message,
 * bounded by the message Length field" (draft-23 Section 9.4.1). Section 9.4.2:
 * "Senders MUST NOT repeat the same Error Detail type in a message unless the
 * type's definition explicitly allows multiple instances. Receivers MUST allow
 * duplicates of unknown Error Detail types." UNSUPPORTED_PROPERTY allows
 * multiple instances (Section 9.4.2.2). REDIRECT does not, and the Section
 * names no receiver action for a repeat, so a second one is kept as raw bytes
 * in `unknown` for the caller to judge.
 */
function decodeErrorDetails(reader: BufferReader, payloadEnd: number): Draft23ErrorDetails {
  const result: Draft23ErrorDetails = {}
  const unsupported: bigint[] = []
  const unknown: UnknownParam[] = []
  let prevType = 0n

  while (reader.offset < payloadEnd) {
    const type = readKvpType(reader, prevType)
    prevType = type
    if (type % 2n === 0n) {
      const value = reader.readVarInt()
      if (type === ERROR_DETAIL_UNSUPPORTED_PROPERTY) unsupported.push(value)
      else unknown.push(unknownEven(type, value))
    } else {
      const length = readKvpLength(reader)
      const bytes = reader.readBytes(length)
      if (type === ERROR_DETAIL_REDIRECT && result.redirect === undefined) {
        result.redirect = decodeRedirect(bytes, reader.offset)
      } else {
        unknown.push(unknownOdd(type, bytes))
      }
    }
  }

  if (unsupported.length > 0) result.unsupported_property = unsupported
  if (unknown.length > 0) result.unknown = unknown
  return result
}

// ─── Payload Encoders ──────────────────────────────────────────────────────────

/**
 * GOAWAY New Session URI, draft-23 Section 9.2: "The maximum length of the New
 * Session URI is 8,192 bytes. If an endpoint receives a length exceeding the
 * maximum, it MUST close the session with FIELD_LENGTH_EXCEEDED."
 */
const MAX_NEW_SESSION_URI_LENGTH = 8192

type Msg<T extends Draft23Message['type']> = Draft23Message & { type: T }

function encodeTrackRequest(
  msg: Msg<'subscribe' | 'fetch' | 'track_status'>,
  w: BufferWriter,
): void {
  w.writeVarInt(msg.request_id)
  writeNamespace(w, msg.track_namespace)
  writeTrackName(w, msg.track_namespace, msg.track_name)
  encodeParams(msg.parameters, w, msg.type)
}

function encodePayload(msg: Draft23Message, w: BufferWriter): void {
  switch (msg.type) {
    case 'setup':
      return encodeSetupOptions(msg.options, w)
    case 'subscribe':
    case 'fetch':
    case 'track_status':
      return encodeTrackRequest(msg, w)
    case 'subscribe_ok':
      w.writeVarInt(msg.track_alias)
      encodeParams(msg.parameters, w, msg.type)
      return encodeTrackProperties(msg.track_properties, w)
    case 'request_update':
      w.writeVarInt(msg.request_id)
      return encodeParams(msg.parameters, w, msg.type)
    case 'publish_state_notify':
      // No Request ID: the subscription's bidirectional stream identifies it.
      return encodeParams(msg.parameters, w, msg.type)
    case 'publish':
      w.writeVarInt(msg.request_id)
      writeNamespace(w, msg.track_namespace)
      writeTrackName(w, msg.track_namespace, msg.track_name)
      w.writeVarInt(msg.track_alias)
      encodeParams(msg.parameters, w, msg.type)
      return encodeTrackProperties(msg.track_properties, w)
    case 'publish_done':
      w.writeVarInt(msg.status_code)
      w.writeVarInt(msg.stream_count)
      return writeReasonPhrase(w, msg.reason_phrase)
    case 'publish_namespace':
      w.writeVarInt(msg.request_id)
      writeNamespace(w, msg.track_namespace)
      return encodeParams(msg.parameters, w, msg.type)
    case 'namespace':
      writeNamespace(w, msg.namespace_suffix)
      return encodeParams(msg.parameters, w, msg.type)
    case 'namespace_done':
      return writeNamespace(w, msg.namespace_suffix)
    case 'subscribe_namespace':
    case 'subscribe_tracks':
      w.writeVarInt(msg.request_id)
      writeNamespace(w, msg.namespace_prefix)
      return encodeParams(msg.parameters, w, msg.type)
    case 'publish_skipped':
      writeNamespace(w, msg.namespace_suffix)
      return writeTrackName(w, msg.namespace_suffix, msg.track_name)
    case 'request_ok':
      encodeParams(msg.parameters, w, msg.type)
      return encodeTrackProperties(msg.track_properties, w)
    case 'request_error':
      // Section 9.4.2.1: the REDIRECT Error Detail "MUST be present when the
      // Error Code is REDIRECT".
      if (msg.error_code === REQUEST_ERROR_REDIRECT && msg.error_details.redirect === undefined) {
        throw new Error('REQUEST_ERROR with Error Code REDIRECT needs a REDIRECT Error Detail')
      }
      w.writeVarInt(msg.error_code)
      w.writeVarInt(msg.retry_interval)
      writeReasonPhrase(w, msg.reason_phrase)
      return encodeErrorDetails(msg.error_details, w)
    case 'goaway': {
      const uri = textEncoder.encode(msg.new_session_uri)
      if (uri.byteLength > MAX_NEW_SESSION_URI_LENGTH) {
        throw new Error(`New Session URI of ${uri.byteLength} bytes exceeds 8,192`)
      }
      w.writeVarInt(BigInt(uri.byteLength))
      w.writeBytes(uri)
      return w.writeVarInt(msg.timeout)
    }
    default: {
      const _exhaustive: never = msg
      throw new Error(`Unhandled message type: ${(_exhaustive as Draft23Message).type}`)
    }
  }
}

// ─── Payload Decoders ──────────────────────────────────────────────────────────

function decodeTrackRequest(
  type: 'subscribe' | 'fetch' | 'track_status',
  r: BufferReader,
): Draft23Message {
  const request_id = r.readVarInt()
  const ns = readNamespace(r)
  const track_name = readTrackName(r, ns.length)
  const parameters = decodeParams(r, type)
  return { type, request_id, track_namespace: ns.fields, track_name, parameters }
}

function decodePayload(
  typeId: bigint,
  r: BufferReader,
  end: number,
  role: 'client' | 'server' | undefined,
): Draft23Message | undefined {
  if (typeId === MSG_SETUP) {
    return { type: 'setup', options: decodeSetupOptions(r, end, role) }
  }
  if (typeId === MSG_SUBSCRIBE) return decodeTrackRequest('subscribe', r)
  if (typeId === MSG_FETCH) return decodeTrackRequest('fetch', r)
  if (typeId === MSG_TRACK_STATUS) return decodeTrackRequest('track_status', r)
  if (typeId === MSG_SUBSCRIBE_OK) {
    const track_alias = r.readVarInt()
    const parameters = decodeParams(r, 'subscribe_ok')
    const track_properties = decodeTrackProperties(r, end)
    return { type: 'subscribe_ok', track_alias, parameters, track_properties }
  }
  if (typeId === MSG_REQUEST_UPDATE) {
    const request_id = r.readVarInt()
    return { type: 'request_update', request_id, parameters: decodeParams(r, 'request_update') }
  }
  if (typeId === MSG_PUBLISH_STATE_NOTIFY) {
    return { type: 'publish_state_notify', parameters: decodeParams(r, 'publish_state_notify') }
  }
  if (typeId === MSG_PUBLISH) {
    const request_id = r.readVarInt()
    const ns = readNamespace(r)
    const track_name = readTrackName(r, ns.length)
    const track_alias = r.readVarInt()
    const parameters = decodeParams(r, 'publish')
    const track_properties = decodeTrackProperties(r, end)
    return {
      type: 'publish',
      request_id,
      track_namespace: ns.fields,
      track_name,
      track_alias,
      parameters,
      track_properties,
    }
  }
  if (typeId === MSG_PUBLISH_DONE) {
    // An unassigned status code decodes: Section 13 treats it as INTERNAL_ERROR
    // and forbids closing the session over it.
    const status_code = r.readVarInt()
    const stream_count = r.readVarInt()
    const reason_phrase = readReasonPhrase(r)
    return { type: 'publish_done', status_code, stream_count, reason_phrase }
  }
  if (typeId === MSG_PUBLISH_NAMESPACE) {
    const request_id = r.readVarInt()
    const ns = readNamespace(r)
    const parameters = decodeParams(r, 'publish_namespace')
    return { type: 'publish_namespace', request_id, track_namespace: ns.fields, parameters }
  }
  if (typeId === MSG_NAMESPACE) {
    // Section 9.15, Figure 20: "Track Namespace Suffix (..), Number of
    // Parameters (vi64), Parameters (..) ..."
    const namespace_suffix = readNamespace(r).fields
    const parameters = decodeParams(r, 'namespace')
    return { type: 'namespace', namespace_suffix, parameters }
  }
  if (typeId === MSG_NAMESPACE_DONE) {
    return { type: 'namespace_done', namespace_suffix: readNamespace(r).fields }
  }
  if (typeId === MSG_SUBSCRIBE_NAMESPACE || typeId === MSG_SUBSCRIBE_TRACKS) {
    const type = typeId === MSG_SUBSCRIBE_NAMESPACE ? 'subscribe_namespace' : 'subscribe_tracks'
    const request_id = r.readVarInt()
    const namespace_prefix = readNamespace(r).fields
    const parameters = decodeParams(r, type)
    return { type, request_id, namespace_prefix, parameters }
  }
  if (typeId === MSG_PUBLISH_SKIPPED) {
    const ns = readNamespace(r)
    const track_name = readTrackName(r, ns.length)
    return { type: 'publish_skipped', namespace_suffix: ns.fields, track_name }
  }
  if (typeId === MSG_REQUEST_OK) {
    const parameters = decodeParams(r, 'request_ok')
    const track_properties = decodeTrackProperties(r, end)
    return { type: 'request_ok', parameters, track_properties }
  }
  if (typeId === MSG_REQUEST_ERROR) {
    // Unassigned error codes decode, as PUBLISH_DONE's do.
    const error_code = r.readVarInt()
    const retry_interval = r.readVarInt()
    const reason_phrase = readReasonPhrase(r)
    const error_details = decodeErrorDetails(r, end)
    // Section 9.4.2.1: "An endpoint that receives a REQUEST_ERROR with Error
    // Code REDIRECT and no REDIRECT Error Detail MUST close the session with
    // MALFORMED_MESSAGE."
    if (error_code === REQUEST_ERROR_REDIRECT && error_details.redirect === undefined) {
      throw fail(
        'CONSTRAINT_VIOLATION',
        Close.MalformedMessage,
        'REQUEST_ERROR with Error Code REDIRECT carries no REDIRECT Error Detail',
        r.offset,
      )
    }
    return { type: 'request_error', error_code, retry_interval, reason_phrase, error_details }
  }
  if (typeId === MSG_GOAWAY) {
    const uriLength = r.readVarInt()
    if (uriLength > BigInt(MAX_NEW_SESSION_URI_LENGTH)) {
      throw fail(
        'CONSTRAINT_VIOLATION',
        Close.FieldLengthExceeded,
        `New Session URI of ${uriLength} bytes exceeds 8,192`,
        r.offset,
      )
    }
    const new_session_uri = textDecoder.decode(r.readBytesView(Number(uriLength)))
    const timeout = r.readVarInt()
    return { type: 'goaway', new_session_uri, timeout }
  }
  return undefined
}

// ─── Public API ────────────────────────────────────────────────────────────────

/**
 * Options for the control-message framing, draft-23 Section 9: "An endpoint
 * MUST NOT send a control message with a length larger than the peer's
 * MAX_CONTROL_MESSAGE_SIZE (Section 9.1.8). If an endpoint receives a control
 * message with a length larger than its MAX_CONTROL_MESSAGE_SIZE, it MUST close
 * the session with FIELD_LENGTH_EXCEEDED."
 *
 * The limit is compared with the Message Length field, the body's byte count.
 * Omitted, no limit is applied, except to SETUP, which is always held to 65535:
 * Section 9.1.8, "Until an endpoint receives the peer's SETUP, it uses the
 * default value, including for SETUP itself." An observer of someone else's
 * session does not know what either endpoint advertised. An endpoint passes its
 * own advertised value when decoding and the peer's when encoding, 65535 until
 * the peer's SETUP arrives.
 *
 * `role` is the decoding endpoint's role. It names the close code of a SETUP
 * Authorization Token refusal, which differs between client and server.
 */
export interface ControlMessageOptions {
  readonly maxControlMessageSize?: bigint
  readonly role?: 'client' | 'server'
}

/** Encode a draft-23 control message: Type (vi64), Length (vi64), body. */
export function encodeMessage(
  message: Draft23Message,
  options?: ControlMessageOptions,
): Uint8Array {
  const typeId = MESSAGE_ID_MAP.get(message.type)
  if (typeId === undefined) {
    throw new Error(`Unknown message type: ${message.type}`)
  }

  const payloadWriter = new BufferWriter()
  encodePayload(message, payloadWriter)
  const payload = payloadWriter.finishView()

  const limit =
    message.type === 'setup' ? DEFAULT_MAX_CONTROL_MESSAGE_SIZE : options?.maxControlMessageSize
  if (limit !== undefined && BigInt(payload.byteLength) > limit) {
    throw new Error(
      `Message body of ${payload.byteLength} bytes exceeds MAX_CONTROL_MESSAGE_SIZE ${limit}`,
    )
  }

  const writer = new BufferWriter(payload.byteLength + 16)
  writer.writeVarInt(typeId)
  writer.writeVarInt(BigInt(payload.byteLength))
  writer.writeBytes(payload)
  return writer.finish()
}

/**
 * Decode one draft-23 control message from the start of `bytes`.
 *
 * Failures, by what the draft says the receiver does:
 *
 *  - The frame is not all there yet: `UNEXPECTED_END`, with no `closeCode`, so
 *    a stream decoder waits for more bytes.
 *  - Section 9: "An endpoint that receives an unknown message type MUST close
 *    the session with UNEXPECTED_MESSAGE." That includes 0x18, "RESERVED
 *    (FETCH_OK in <= 22)" in Table 5.
 *  - Section 9: "If the length does not match the length of the Message Body,
 *    the receiver MUST close the session with MALFORMED_MESSAGE." Both ways:
 *    a body that ends before its fields do, and bytes left after them.
 *  - Everything else carries the code its own rule names.
 */
export function decodeMessage(
  bytes: Uint8Array,
  options?: ControlMessageOptions,
): DecodeResult<Draft23Message> {
  try {
    const reader = new BufferReader(bytes)
    const typeId = reader.readVarInt()
    const length = reader.readVarInt()

    // Section 9.1.8: "Until an endpoint receives the peer's SETUP, it uses the
    // default value, including for SETUP itself." So no SETUP is larger.
    const limit =
      typeId === MSG_SETUP ? DEFAULT_MAX_CONTROL_MESSAGE_SIZE : options?.maxControlMessageSize
    if (limit !== undefined && length > limit) {
      throw fail(
        'CONSTRAINT_VIOLATION',
        Close.FieldLengthExceeded,
        `Message Length ${length} exceeds MAX_CONTROL_MESSAGE_SIZE ${limit}`,
        reader.offset,
      )
    }
    if (length > BigInt(reader.remaining)) {
      throw new DecodeError(
        'UNEXPECTED_END',
        `Message Length ${length} but only ${reader.remaining} byte(s) follow`,
        reader.offset,
      )
    }
    const payloadLength = Number(length)
    const payloadBytes = reader.readBytes(payloadLength)
    const payloadReader = new BufferReader(payloadBytes)

    let message: Draft23Message | undefined
    try {
      message = decodePayload(typeId, payloadReader, payloadLength, options?.role)
    } catch (e) {
      if (e instanceof DecodeError && e.code === 'UNEXPECTED_END') {
        throw fail(
          'CONSTRAINT_VIOLATION',
          Close.MalformedMessage,
          `Message body ends before its fields do: ${e.message}`,
          e.offset,
        )
      }
      throw e
    }
    if (message === undefined) {
      return {
        ok: false,
        error: fail(
          'UNKNOWN_MESSAGE_TYPE',
          Close.UnexpectedMessage,
          `Unknown message type ID: 0x${typeId.toString(16)}`,
          0,
        ),
      }
    }
    if (payloadReader.remaining > 0) {
      throw fail(
        'CONSTRAINT_VIOLATION',
        Close.MalformedMessage,
        `${payloadReader.remaining} byte(s) left after the ${message.type} body`,
        payloadReader.offset,
      )
    }

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
  decodeObjectProperties,
  decodeSubgroupStream,
  encodeDatagram,
  encodeFetchStream,
  encodeObjectProperties,
  encodeSubgroupStream,
  malformedTrackPropertiesReason,
  malformedTrackReason,
} from './data-streams.js'

export {
  createDataStreamDecoder,
  createFetchStreamDecoder,
  createSubgroupStreamDecoder,
  decodeDatagram,
  decodeDataStream,
  decodeFetchStream,
  decodeObjectProperties,
  decodeSubgroupStream,
  encodeDatagram,
  encodeFetchStream,
  encodeObjectProperties,
  encodeSubgroupStream,
  malformedTrackPropertiesReason,
  malformedTrackReason,
}

// ─── Stream Decoders ───────────────────────────────────────────────────────────

/**
 * Decode a control or request stream incrementally. With
 * `maxControlMessageSize`, a frame whose Length exceeds it fails as soon as the
 * Length has arrived, rather than being buffered.
 */
export function createStreamDecoder(
  options?: ControlMessageOptions,
): TransformStream<Uint8Array, Draft23Message> {
  let buffer = new Uint8Array(0)
  let offset = 0

  return new TransformStream<Uint8Array, Draft23Message>({
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
        const result = decodeMessage(buffer.subarray(offset), options)
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

export interface Draft23Codec extends BaseCodec<Draft23Message> {
  readonly draft: '23'
  encodeMessage(message: Draft23Message, options?: ControlMessageOptions): Uint8Array
  decodeMessage(bytes: Uint8Array, options?: ControlMessageOptions): DecodeResult<Draft23Message>
  encodeSubgroupStream(stream: SubgroupStream): Uint8Array
  encodeDatagram(dg: DatagramObject): Uint8Array
  encodeFetchStream(stream: FetchStream): Uint8Array
  decodeSubgroupStream(bytes: Uint8Array): DecodeResult<SubgroupStream>
  decodeDatagram(bytes: Uint8Array): DecodeResult<DatagramObject>
  decodeFetchStream(bytes: Uint8Array): DecodeResult<FetchStream>
  decodeObjectProperties(bytes: Uint8Array): DecodeResult<ObjectProperty[]>
  encodeObjectProperties(props: readonly ObjectPropertyInit[]): Uint8Array
  decodeDataStream(
    streamType: 'subgroup' | 'datagram' | 'fetch',
    bytes: Uint8Array,
  ): DecodeResult<Draft23DataStream>
  createStreamDecoder(options?: ControlMessageOptions): TransformStream<Uint8Array, Draft23Message>
  createSubgroupStreamDecoder(): TransformStream<Uint8Array, SubgroupStreamHeader | ObjectPayload>
  createFetchStreamDecoder(): TransformStream<Uint8Array, FetchStreamHeader | ObjectPayload>
  createDataStreamDecoder(): TransformStream<Uint8Array, DataStreamEvent>
}

export function createDraft23Codec(): Draft23Codec {
  return {
    draft: '23',
    encodeMessage,
    decodeMessage,
    encodeSubgroupStream,
    encodeDatagram,
    encodeFetchStream,
    decodeSubgroupStream,
    decodeDatagram,
    decodeFetchStream,
    decodeObjectProperties,
    encodeObjectProperties,
    decodeDataStream,
    createStreamDecoder,
    createSubgroupStreamDecoder,
    createFetchStreamDecoder,
    createDataStreamDecoder,
  }
}

/**
 * Overwrite every Authorization Token value in a draft-23 control frame.
 *
 * One decode, whose output is discarded: the point is to learn where the
 * tokens were. A caller that also wants the message decodes the redacted frame.
 * A frame that fails to decode is still redacted as far as the decode got.
 *
 * See {@link AuthRedaction.incomplete} for the one result a caller must not
 * treat as clean, and {@link AuthRedaction.decoded} for the residual it cannot
 * close.
 */
export function redactAuthTokens(bytes: Uint8Array): AuthRedaction {
  let payloadStart: number
  try {
    const probe = new BufferReader(bytes)
    probe.readVarInt()
    probe.readVarInt()
    payloadStart = probe.offset
  } catch {
    // Too short to carry a message header, and so too short for the parameters
    // that carry a token. Reported as not decoded rather than as clean.
    return { bytes, redacted: 0, incomplete: false, decoded: false }
  }
  return redactWith(bytes, payloadStart, () => decodeMessage(bytes).ok)
}
