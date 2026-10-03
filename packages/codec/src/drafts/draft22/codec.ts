import {
  type AuthRedaction,
  recordAuthValueSpan,
  redactWith,
  withoutAuthValueSpans,
} from '../../core/auth-redaction.js'
import { MoqtBufferReader as BufferReader } from '../../core/buffer-reader.js'
import { MoqtBufferWriter as BufferWriter } from '../../core/buffer-writer.js'
import { bytesToHex, hexToBytes } from '../../core/hex.js'
import type { BaseCodec, DecodeResult } from '../../core/types.js'
import { DecodeError } from '../../core/types.js'
import {
  MESSAGE_ID_MAP,
  MSG_FETCH,
  MSG_FETCH_OK,
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
  SETUP_OPT_MAX_FILTER_RANGES,
  SETUP_OPT_MAX_REQUEST_UPDATES,
  SETUP_OPT_MOQT_IMPLEMENTATION,
  SETUP_OPT_PATH,
} from './messages.js'
import type {
  AuthorizationToken,
  DatagramObject,
  DataStreamEvent,
  Draft22DataStream,
  Draft22FillParameters,
  Draft22Message,
  Draft22Params,
  Draft22SetupOptions,
  Draft22TrackProperties,
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

/** The largest value MOQT's vi64 can carry (draft-22 Section 8.1, nine-byte form). */
const MAX_U64 = 0xffffffffffffffffn

/**
 * `PUBLISH_DONE.Stream Count` "unknown" sentinel — draft-22 Section 9.9.
 *
 * draft-19 used `2^62 - 1`; draft-20 raised it to `2^64 - 1`. Both are
 * encodable because MOQT's vi64 (Section 8.1) is a leading-ones-length
 * prefix reaching a full 64 bits in nine bytes — it is NOT the QUIC varint and
 * has no `2^62 - 1` ceiling. On the wire this is `ff` followed by eight `ff`
 * bytes.
 *
 * JS `bigint` is required: `2^64 - 1` does not fit a `number`, and comparing a
 * `Number(stream_count)` against this sentinel would be wrong for every value
 * above `2^53`.
 *
 * Note (SPEC-DELTA Section 11 Q14): unlike the old `2^62 - 1` marker, this
 * value is also a well-formed exact count. There is no longer any headroom
 * that separates "unknown" from "absurdly many streams"; the draft does not
 * acknowledge the collision.
 */
export const UNKNOWN_STREAM_COUNT = 0xffffffffffffffffn

// ─── Setup Options Encoding/Decoding (KVP, no count prefix) ─────────────────

function encodeSetupOptions(opts: Draft22SetupOptions, writer: BufferWriter): void {
  // Collect all options sorted by type ID
  const entries: Array<{ type: bigint; encode: (w: BufferWriter) => void }> = []

  if (opts.path !== undefined) {
    entries.push({
      type: SETUP_OPT_PATH,
      encode: (w) => {
        const encoded = textEncoder.encode(opts.path!)
        w.writeVarInt(BigInt(encoded.byteLength))
        w.writeBytes(encoded)
      },
    })
  }
  for (const token of opts.authorization_token ?? []) {
    entries.push({
      type: SETUP_OPT_AUTHORIZATION_TOKEN,
      encode: (w) => {
        const tmpW = new BufferWriter(64)
        encodeAuthorizationToken(token, tmpW)
        const raw = tmpW.finish()
        w.writeVarInt(BigInt(raw.byteLength))
        w.writeBytes(raw)
      },
    })
  }
  if (opts.max_auth_token_cache_size !== undefined) {
    entries.push({
      type: SETUP_OPT_MAX_AUTH_TOKEN_CACHE_SIZE,
      encode: (w) => w.writeVarInt(opts.max_auth_token_cache_size!),
    })
  }
  if (opts.authority !== undefined) {
    entries.push({
      type: SETUP_OPT_AUTHORITY,
      encode: (w) => {
        const encoded = textEncoder.encode(opts.authority!)
        w.writeVarInt(BigInt(encoded.byteLength))
        w.writeBytes(encoded)
      },
    })
  }
  if (opts.max_filter_ranges !== undefined) {
    entries.push({
      type: SETUP_OPT_MAX_FILTER_RANGES,
      encode: (w) => w.writeVarInt(opts.max_filter_ranges!),
    })
  }
  if (opts.moqt_implementation !== undefined) {
    entries.push({
      type: SETUP_OPT_MOQT_IMPLEMENTATION,
      encode: (w) => {
        const encoded = textEncoder.encode(opts.moqt_implementation!)
        w.writeVarInt(BigInt(encoded.byteLength))
        w.writeBytes(encoded)
      },
    })
  }
  if (opts.max_request_updates !== undefined) {
    entries.push({
      type: SETUP_OPT_MAX_REQUEST_UPDATES,
      encode: (w) => w.writeVarInt(opts.max_request_updates!),
    })
  }
  if (opts.unknown) {
    for (const u of opts.unknown) {
      const id = BigInt(u.id)
      entries.push({
        type: id,
        encode: (w) => {
          if (id % 2n === 0n) {
            const raw = hexToBytes(u.raw_hex)
            const tmpReader = new BufferReader(raw)
            w.writeVarInt(tmpReader.readVarInt())
          } else {
            const raw = hexToBytes(u.raw_hex)
            w.writeVarInt(BigInt(raw.byteLength))
            w.writeBytes(raw)
          }
        },
      })
    }
  }

  // Sort by type (ascending) and write with delta encoding
  entries.sort((a, b) => (a.type < b.type ? -1 : a.type > b.type ? 1 : 0))
  let prevType = 0n
  for (const entry of entries) {
    writer.writeVarInt(entry.type - prevType)
    entry.encode(writer)
    prevType = entry.type
  }
}

function decodeSetupOptions(reader: BufferReader, payloadEnd: number): Draft22SetupOptions {
  const result: Draft22SetupOptions = {}
  const unknown: UnknownParam[] = []
  let prevType = 0n

  while (reader.offset < payloadEnd) {
    const delta = reader.readVarInt()
    const optType = prevType + delta
    prevType = optType

    if (optType % 2n === 0n) {
      // Even: single varint value
      const value = reader.readVarInt()
      if (optType === SETUP_OPT_MAX_AUTH_TOKEN_CACHE_SIZE) {
        result.max_auth_token_cache_size = value
      } else if (optType === SETUP_OPT_MAX_FILTER_RANGES) {
        result.max_filter_ranges = value
      } else if (optType === SETUP_OPT_MAX_REQUEST_UPDATES) {
        result.max_request_updates = value
      } else {
        // Section 9.1: "endpoints MUST ignore unknown Setup Options" — kept
        // for passthrough rather than discarded, but never an error.
        const tmpWriter = new BufferWriter(16)
        tmpWriter.writeVarInt(value)
        const raw = tmpWriter.finish()
        unknown.push({
          id: `0x${optType.toString(16)}`,
          length: raw.byteLength,
          raw_hex: bytesToHex(raw),
        })
      }
    } else {
      // Odd: length-prefixed bytes
      const length = Number(reader.readVarInt())
      const bytes = reader.readBytes(length)
      if (optType === SETUP_OPT_PATH) {
        result.path = textDecoder.decode(bytes)
      } else if (optType === SETUP_OPT_AUTHORIZATION_TOKEN) {
        const token = decodeAuthorizationToken(new BufferReader(bytes))
        noteAuthTokenValue(reader.offset - length, length, token)
        result.authorization_token = [...(result.authorization_token ?? []), token]
      } else if (optType === SETUP_OPT_AUTHORITY) {
        result.authority = textDecoder.decode(bytes)
      } else if (optType === SETUP_OPT_MOQT_IMPLEMENTATION) {
        result.moqt_implementation = textDecoder.decode(bytes)
      } else {
        unknown.push({
          id: `0x${optType.toString(16)}`,
          length,
          raw_hex: bytesToHex(bytes),
        })
      }
    }
  }

  if (unknown.length > 0) result.unknown = unknown
  return result
}

// ─── Authorization Token Encoding/Decoding ────────────────────────────────────

function encodeAuthorizationToken(token: AuthorizationToken, w: BufferWriter): void {
  const aliasType = Number(token.alias_type)
  w.writeVarInt(token.alias_type)
  if (aliasType === 0 || aliasType === 1 || aliasType === 2) {
    // DELETE, REGISTER, USE_ALIAS: token_alias present
    w.writeVarInt(token.token_alias ?? 0n)
  }
  if (aliasType === 1 || aliasType === 3) {
    // REGISTER, USE_VALUE: token_type + token_value present. The Token Value is
    // NOT length-prefixed inside the Token structure; it consumes the remainder
    // of the outer length-prefixed buffer (draft-22 Sections 8.9 and 9.20.2).
    w.writeVarInt(token.token_type ?? 0n)
    const tv = token.token_value ?? new Uint8Array(0)
    w.writeBytes(tv)
  }
}

/**
 * Record where a Token Value sits, so it can be overwritten before the frame
 * reaches anything that keeps it.
 *
 * The span falls out of the decode with no second walk. The Token Value is the
 * tail of the Token structure — draft-22 Section 8.9, Figure 4: it is NOT
 * length-prefixed inside the Token and consumes the remainder of the outer
 * length-prefixed parameter value. So its start is the parameter value's end
 * minus the value's own length, and the fields before it (Alias Type, Token
 * Alias, Token Type) are left alone deliberately: they are structure, not
 * secret, and they are what distinguishes a session that failed to
 * authenticate from one that never tried.
 *
 * DELETE (0x0) and USE_ALIAS (0x2) carry no value at all, so they record
 * nothing and their frames pass through untouched.
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

function decodeAuthorizationToken(r: BufferReader): AuthorizationToken {
  const alias_type = r.readVarInt()
  const aliasType = Number(alias_type)
  const result: AuthorizationToken = { alias_type }

  if (aliasType === 0 || aliasType === 1 || aliasType === 2) {
    ;(result as { token_alias: bigint }).token_alias = r.readVarInt()
  }
  if (aliasType === 1 || aliasType === 3) {
    ;(result as { token_type: bigint }).token_type = r.readVarInt()
    // Token Value extends to the end of the outer length-prefixed buffer
    const bytes = r.readBytes(r.remaining)
    ;(result as { token_value: Uint8Array }).token_value = bytes
  }

  return result
}

// ─── Tuple (Track Namespace) encode/decode for params ────────────────────────

function encodeNamespaceTuple(ns: string[], w: BufferWriter): void {
  w.writeVarInt(BigInt(ns.length))
  for (const part of ns) {
    const encoded = textEncoder.encode(part)
    w.writeVarInt(BigInt(encoded.byteLength))
    w.writeBytes(encoded)
  }
}

function decodeNamespaceTuple(r: BufferReader): string[] {
  const count = Number(r.readVarInt())
  const parts: string[] = []
  for (let i = 0; i < count; i++) {
    const len = Number(r.readVarInt())
    parts.push(textDecoder.decode(r.readBytes(len)))
  }
  return parts
}

// ─── Message Parameter type codes (draft-22 Section 16.7, Table 14) ─────────

const PARAM_OBJECT_DELIVERY_TIMEOUT = 0x02n
const PARAM_AUTHORIZATION_TOKEN = 0x03n
const PARAM_RENDEZVOUS_TIMEOUT = 0x04n
const PARAM_SUBGROUP_DELIVERY_TIMEOUT = 0x06n
const PARAM_EXPIRES = 0x08n
const PARAM_LARGEST_OBJECT = 0x09n
const PARAM_FILL_TIMEOUT = 0x0an
const PARAM_FORWARD = 0x10n
const PARAM_SUBSCRIBER_PRIORITY = 0x20n
const PARAM_LOCATION_FILTER = 0x21n
const PARAM_GROUP_ORDER = 0x22n
const PARAM_FILL_PARAMETERS = 0x23n // NEW in draft-20
const PARAM_SUBGROUP_FILTER = 0x25n
const PARAM_OBJECTID_FILTER = 0x26n
const PARAM_PRIORITY_FILTER = 0x27n
const PARAM_OBJECT_PROPERTY_FILTER = 0x28n
const PARAM_TRACK_PROPERTY_FILTER = 0x29n
const PARAM_NEW_GROUP_REQUEST = 0x32n
const PARAM_TRACK_NAMESPACE_PREFIX = 0x34n
const PARAM_INCLUDE_PROPERTIES = 0x35n // NEW in draft-20

/**
 * The pseudo message-type used for the parameter scope inside FILL_PARAMETERS.
 *
 * DECISION (DECISIONS.md D2, SPEC-DELTA Section 11 Q2): the nested value is a
 * *separate parameter scope*. draft-22 Section 9.20.15 says "Parameters inside
 * it are not considered to appear in the enclosing message for the purposes of
 * Section 9.20, so a Parameter Type MAY appear both in the message and inside
 * FILL_PARAMETERS." Modelling it as its own scope key falls straight out of
 * that sentence — but the draft never states the consequence explicitly.
 */
const FILL_SCOPE = 'fill_parameters'

// ─── Range Filter Encoding/Decoding (draft-22 Section 3.3.2) ────────────────
// A Range Filter's length-prefixed value is: SetID (uint8), an optional
// Property Type (varint, only for the Object/Track Property filters), then a
// sequence of delta-encoded inclusive Start/End Range pairs. The final End may
// be omitted (bounded by the length prefix) to indicate an open upper bound.
// In REQUEST_UPDATE a length-0 value removes the filter.
//
// Unchanged from draft-19: same codepoints, same field order, same delta
// arithmetic. What changed is applicability — PUBLISH_OK was dropped from
// every one of them, and 0x25-0x28 may now nest inside FILL_PARAMETERS.

function encodeRangeFilter(filter: RangeFilter, hasProperty: boolean, w: BufferWriter): void {
  if (filter.removed) {
    // REQUEST_UPDATE removal form: zero-length value
    w.writeVarInt(0n)
    return
  }
  const tmpW = new BufferWriter(32)
  tmpW.writeUint8(Number(filter.set_id ?? 0n))
  if (hasProperty) {
    tmpW.writeVarInt(filter.property_type ?? 0n)
  }
  let prevEnd = 0n
  for (const range of filter.ranges ?? []) {
    tmpW.writeVarInt(range.start - prevEnd)
    if (range.end !== undefined) {
      // Ranges are inclusive Start/End pairs; End is delta-encoded from its
      // own Start with no adjustment. Nothing here is offset by one.
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
    // REQUEST_UPDATE removal form
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
  return property_type !== undefined ? { set_id, property_type, ranges } : { set_id, ranges }
}

// ─── LOCATION_FILTER (0x21) — draft-22 Section 9.20.9 ───────────────────────

/**
 * How many vi64 fields follow each Location Filter Type, indexed by the type.
 *
 * draft-22 Section 9.20.9, Table 6: 0x00 None and 0x05 Next Object carry no
 * fields, 0x01 Relative Start carries StartGroup alone, and 0x02, 0x03 and 0x04
 * carry the first two, three and four of StartGroup, StartObject, EndGroupDelta,
 * EndObject. "Any other Location Filter Type is a PROTOCOL_VIOLATION."
 */
const LOCATION_FILTER_FIELD_COUNTS: readonly number[] = [0, 1, 2, 3, 4, 0]

/** The field count for a Location Filter Type, or undefined for one Table 6 does not define. */
function locationFilterFieldCount(filterType: bigint): number | undefined {
  return filterType >= 0n && filterType < BigInt(LOCATION_FILTER_FIELD_COUNTS.length)
    ? LOCATION_FILTER_FIELD_COUNTS[Number(filterType)]
    : undefined
}

/**
 * Encode a LOCATION_FILTER value: the Location Filter Type, then exactly the
 * fields that type defines.
 *
 * Section 9.20.9: "The Location Filter Type dictates which optional variable-length integer
 * fields follow, and how they are interpreted." The type is never inferred
 * from which fields are set, because 0x00 and 0x05 both carry none, and 0x02
 * {0, 0} is an absolute start at the beginning of the track rather than the
 * Next Object. A filter whose fields do not match its type is refused rather
 * than written, since the peer would read a different number of fields than
 * were sent and misparse every parameter after it.
 *
 * There is no Length in front of the value and no `+ 1` on `end_object`:
 * draft-22 Section 3.3.1 says "A Location filter specifies an inclusive range
 * of Locations". draft-19 Section 10.12.1 encoded a fetch end as "the end
 * Location, plus 1", so an encoder ported forward with its arithmetic intact
 * fetches one object too many (DECISIONS.md D4).
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
  w.writeVarInt(f.filter_type)
  for (const field of fields.slice(0, count)) w.writeVarInt(field as bigint)
}

/**
 * Decode a LOCATION_FILTER value: read the Location Filter Type, then the
 * number of fields Table 6 gives it.
 *
 * The value carries no length of its own. Section 9.20 says a parameter's
 * "encoding is specified by each parameter definition", and this one's is a
 * type followed by zero to four fields, so the type is the only thing that
 * bounds it. A decoder that treated 0x21 as length-prefixed would read the
 * type as a byte count and desynchronise every parameter after it.
 *
 * Three ways to fail, kept apart:
 *  - a type above 0x05 is a PROTOCOL_VIOLATION by the sentence quoted on
 *    {@link LOCATION_FILTER_FIELD_COUNTS}; it is a CONSTRAINT_VIOLATION here,
 *    as the out-of-range filter types of earlier drafts are;
 *  - a type or fields that run past the end of the message make the
 *    parameter itself malformed, an INVALID_PARAMETER;
 *  - StartGroup + EndGroupDelta above 2^64 - 1 is a CONSTRAINT_VIOLATION.
 */
function decodeLocationFilter(reader: BufferReader): LocationFilter {
  // The message's Length covers these bytes, so running out here is a
  // malformed parameter, not a frame still arriving: an UNEXPECTED_END would
  // make a stream decoder wait for bytes that belong to the next message.
  let filter_type: bigint
  try {
    filter_type = reader.readVarInt()
  } catch (e) {
    if (!(e instanceof DecodeError) || e.code !== 'UNEXPECTED_END') throw e
    throw new DecodeError(
      'INVALID_PARAMETER',
      'LOCATION_FILTER type runs past the end of the message',
      reader.offset,
    )
  }
  const count = locationFilterFieldCount(filter_type)
  if (count === undefined) {
    throw new DecodeError(
      'CONSTRAINT_VIOLATION',
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
      throw new DecodeError(
        'INVALID_PARAMETER',
        `LOCATION_FILTER type ${filter_type} needs ${count} field(s) but the message ends after ${i}`,
        reader.offset,
      )
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

  if (filter.start_group !== undefined && filter.end_group_delta !== undefined) {
    // Section 9.20.9: "If StartGroup + EndGroupDelta exceeds 2^64 - 1, the
    // endpoint MUST close the session with a PROTOCOL_VIOLATION." The sum is
    // the absolute End Group; EndGroupDelta is delta encoded from StartGroup
    // but both groups are absolute, not relative to Largest Object.
    if (filter.start_group + filter.end_group_delta > MAX_U64) {
      throw new DecodeError(
        'CONSTRAINT_VIOLATION',
        'StartGroup + EndGroupDelta exceeds 2^64 - 1',
        reader.offset,
      )
    }
  }

  return filter
}

/**
 * Which messages each Message Parameter may appear in.
 *
 * Section 9.20.1: "Each Message Parameter definition indicates the message
 * types in which it can appear, and each control message definition lists the
 * parameters it allows. If a parameter appears in some other type of message,
 * the receiving endpoint MUST close the connection with a PROTOCOL_VIOLATION."
 *
 * Read out of draft-22's per-parameter sections, which agree with the
 * per-message lists. SUBSCRIBE_TRACKS takes two more (below). `request_ok`
 * is also PUBLISH_OK, REQUEST_UPDATE_OK, TRACK_STATUS_OK,
 * SUBSCRIBE_NAMESPACE_OK, SUBSCRIBE_TRACKS_OK and PUBLISH_NAMESPACE_OK, and
 * carries only EXPIRES (0x08) and LARGEST_OBJECT (0x09). Subscription
 * parameters travel on PUBLISH (initial values) and REQUEST_UPDATE (changes).
 *
 * Each set is the union over every kind of request a message can serve.
 * Section 9.3 narrows REQUEST_OK, and Section 9.5 narrows REQUEST_UPDATE, per
 * kind of request answered or updated, but the frame does not say which
 * request that is, so a codec cannot apply those lists. The session FSM
 * applies the FILL_PARAMETERS one; the rest are not enforced anywhere in this
 * package.
 *
 * SUBSCRIBE_TRACKS also admits LOCATION_FILTER (0x21) and FILL_PARAMETERS
 * (0x23), which neither Section 9.18's list nor their own definitions name.
 * Section 3.6.2 says the subscriber "can specify a Location Filter and
 * optionally include FILL_PARAMETERS in the SUBSCRIBE_TRACKS", and refusing
 * what the draft tells a subscriber to send would close sessions with
 * conforming peers. That conflict has been there since draft-20, and it is
 * the only one: Section 3.6.2's "Any Parameter that can be specified on a
 * Subscription (ie: in SUBSCRIBE) is valid in SUBSCRIBE_TRACKS, unless
 * otherwise specified" yields to the per-parameter definitions, which do
 * specify otherwise for OBJECT_DELIVERY_TIMEOUT, RENDEZVOUS_TIMEOUT,
 * SUBGROUP_DELIVERY_TIMEOUT, SUBSCRIBER_PRIORITY and NEW_GROUP_REQUEST.
 *
 * `fill_parameters` in a set means the type is one of the eight Table 7 permits
 * inside FILL_PARAMETERS (Section 9.20.15). TRACK_PROPERTY_FILTER (0x29) is
 * deliberately not among them.
 */
const PARAMETER_SCOPE = new Map<bigint, Set<string>>([
  // 0x02 OBJECT_DELIVERY_TIMEOUT (9.20.4).
  [PARAM_OBJECT_DELIVERY_TIMEOUT, new Set(['subscribe', 'publish', 'request_update'])],
  // 0x03 AUTHORIZATION_TOKEN (9.20.2) — any request that needs authorization.
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
  // 0x04 RENDEZVOUS_TIMEOUT (9.20.6) — "MAY appear in a SUBSCRIBE message".
  [PARAM_RENDEZVOUS_TIMEOUT, new Set(['subscribe'])],
  // 0x06 SUBGROUP_DELIVERY_TIMEOUT (9.20.3).
  [PARAM_SUBGROUP_DELIVERY_TIMEOUT, new Set(['subscribe', 'publish', 'request_update'])],
  // 0x08 EXPIRES (9.20.16) — the one parameter PUBLISH_OK may carry.
  [PARAM_EXPIRES, new Set(['subscribe_ok', 'publish', 'request_ok'])],
  // 0x09 LARGEST_OBJECT (9.20.17).
  [
    PARAM_LARGEST_OBJECT,
    new Set(['subscribe_ok', 'publish', 'request_ok', 'publish_state_notify']),
  ],
  // 0x0A FILL_TIMEOUT (9.20.5) — FETCH, or nested inside FILL_PARAMETERS.
  [PARAM_FILL_TIMEOUT, new Set(['fetch', FILL_SCOPE])],
  // 0x10 FORWARD (9.20.18).
  [
    PARAM_FORWARD,
    new Set(['subscribe', 'request_update', 'publish', 'subscribe_tracks', 'publish_state_notify']),
  ],
  // 0x20 SUBSCRIBER_PRIORITY (9.20.7).
  [
    PARAM_SUBSCRIBER_PRIORITY,
    new Set(['subscribe', 'publish', 'fetch', 'request_update', FILL_SCOPE]),
  ],
  // 0x21 LOCATION_FILTER (9.20.9), and SUBSCRIBE_TRACKS by Section 3.6.2.
  [
    PARAM_LOCATION_FILTER,
    new Set([
      'fetch',
      'subscribe',
      'subscribe_tracks',
      'publish',
      'request_update',
      'publish_state_notify',
      FILL_SCOPE,
    ]),
  ],
  // 0x22 GROUP_ORDER (9.20.8).
  [PARAM_GROUP_ORDER, new Set(['subscribe', 'publish', 'subscribe_tracks', 'fetch', FILL_SCOPE])],
  // 0x23 FILL_PARAMETERS (9.20.15), and SUBSCRIBE_TRACKS by Section 3.6.2 —
  // subscriptions only, and never nested in itself: a FETCH already is a
  // fetch, so it has nothing to fill.
  [PARAM_FILL_PARAMETERS, new Set(['subscribe', 'subscribe_tracks', 'request_update'])],
  // 0x25-0x28 range filters (3.3.2) — permitted inside FILL_PARAMETERS (Table 7).
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
  // 0x29 TRACK_PROPERTY_FILTER (3.3.2, 9.20.14) — NOT permitted inside
  // FILL_PARAMETERS: Table 7 omits it. A relay forwarding a downstream
  // FILL_PARAMETERS upstream has to strip it rather than trip this rule.
  [PARAM_TRACK_PROPERTY_FILTER, new Set(['subscribe_tracks', 'request_update'])],
  // 0x32 NEW_GROUP_REQUEST (9.20.19).
  [PARAM_NEW_GROUP_REQUEST, new Set(['subscribe', 'request_update'])],
  // 0x34 TRACK_NAMESPACE_PREFIX (9.20.20) — REQUEST_UPDATE for a namespace subscription.
  [PARAM_TRACK_NAMESPACE_PREFIX, new Set(['request_update'])],
  // 0x35 INCLUDE_PROPERTIES (9.20.21).
  [PARAM_INCLUDE_PROPERTIES, new Set(['subscribe', 'track_status', 'fetch', 'subscribe_tracks'])],
])

function encodeParams(params: Draft22Params, writer: BufferWriter): void {
  // Collect and sort params by type
  const entries: Array<{ type: bigint; encode: (w: BufferWriter) => void }> = []

  if (params.object_delivery_timeout !== undefined) {
    entries.push({
      type: PARAM_OBJECT_DELIVERY_TIMEOUT,
      encode: (w) => w.writeVarInt(params.object_delivery_timeout!),
    })
  }
  for (const token of params.authorization_token ?? []) {
    entries.push({
      type: PARAM_AUTHORIZATION_TOKEN,
      encode: (w) => {
        const tmpW = new BufferWriter(64)
        encodeAuthorizationToken(token, tmpW)
        const raw = tmpW.finish()
        w.writeVarInt(BigInt(raw.byteLength))
        w.writeBytes(raw)
      },
    })
  }
  if (params.rendezvous_timeout !== undefined) {
    entries.push({
      type: PARAM_RENDEZVOUS_TIMEOUT,
      encode: (w) => w.writeVarInt(params.rendezvous_timeout!),
    })
  }
  if (params.subgroup_delivery_timeout !== undefined) {
    entries.push({
      type: PARAM_SUBGROUP_DELIVERY_TIMEOUT,
      encode: (w) => w.writeVarInt(params.subgroup_delivery_timeout!),
    })
  }
  if (params.expires !== undefined) {
    entries.push({
      type: PARAM_EXPIRES,
      encode: (w) => w.writeVarInt(params.expires!),
    })
  }
  if (params.largest_object !== undefined) {
    entries.push({
      type: PARAM_LARGEST_OBJECT,
      // A Location is "Two consecutive varints (Group, Object)", which is a
      // different value encoding from "Length-prefixed". Nothing states the
      // length, so nothing writes one — even though 0x09 is odd, because the
      // Key-Value-Pair odd/even rule does not apply to Message Parameters.
      encode: (w) => {
        w.writeVarInt(params.largest_object!.group)
        w.writeVarInt(params.largest_object!.object)
      },
    })
  }
  if (params.fill_timeout !== undefined) {
    entries.push({
      type: PARAM_FILL_TIMEOUT,
      encode: (w) => w.writeVarInt(params.fill_timeout!),
    })
  }
  if (params.forward !== undefined) {
    entries.push({
      type: PARAM_FORWARD,
      encode: (w) => w.writeUint8(Number(params.forward!)),
    })
  }
  if (params.subscriber_priority !== undefined) {
    entries.push({
      type: PARAM_SUBSCRIBER_PRIORITY,
      encode: (w) => w.writeUint8(Number(params.subscriber_priority!)),
    })
  }
  if (params.location_filter !== undefined) {
    entries.push({
      type: PARAM_LOCATION_FILTER,
      encode: (w) => encodeLocationFilter(params.location_filter!, w),
    })
  }
  if (params.group_order !== undefined) {
    entries.push({
      type: PARAM_GROUP_ORDER,
      encode: (w) => w.writeUint8(Number(params.group_order!)),
    })
  }
  if (params.fill_parameters !== undefined) {
    entries.push({
      type: PARAM_FILL_PARAMETERS,
      encode: (w) => {
        // DECISION (DECISIONS.md D1, SPEC-DELTA Section 11 Q1): the value is a
        // full parameter block and therefore BEGINS with Number of Parameters.
        // Section 9.20.15 calls it "a sequence of Parameters ... encoded as if
        // they were Parameters for a separate message"; Section 9.20 defines a
        // parameter block as count-bounded rather than length-bounded, because
        // unknown parameters cannot be skipped. The draft does not state the
        // consequence, and the outer length prefix makes the count look
        // redundant — but a block encoded "as if they were Parameters for a
        // separate message" is a block with the count. An empty FILL_PARAMETERS is therefore Length 1
        // carrying the single byte 0x00, NOT Length 0.
        //
        // DECISION (D2): encodeParams starts its own Type Delta chain from 0,
        // and the caller's chain is untouched — the outer parameter after
        // FILL_PARAMETERS deltas from 0x23, not from the last inner type.
        const tmpW = new BufferWriter(64)
        encodeParams(params.fill_parameters as Draft22Params, tmpW)
        const raw = tmpW.finish()
        w.writeVarInt(BigInt(raw.byteLength))
        w.writeBytes(raw)
      },
    })
  }
  for (const filter of params.subgroup_filter ?? []) {
    entries.push({
      type: PARAM_SUBGROUP_FILTER,
      encode: (w) => encodeRangeFilter(filter, false, w),
    })
  }
  for (const filter of params.objectid_filter ?? []) {
    entries.push({
      type: PARAM_OBJECTID_FILTER,
      encode: (w) => encodeRangeFilter(filter, false, w),
    })
  }
  for (const filter of params.priority_filter ?? []) {
    entries.push({
      type: PARAM_PRIORITY_FILTER,
      encode: (w) => encodeRangeFilter(filter, false, w),
    })
  }
  for (const filter of params.object_property_filter ?? []) {
    entries.push({
      type: PARAM_OBJECT_PROPERTY_FILTER,
      encode: (w) => encodeRangeFilter(filter, true, w),
    })
  }
  for (const filter of params.track_property_filter ?? []) {
    entries.push({
      type: PARAM_TRACK_PROPERTY_FILTER,
      encode: (w) => encodeRangeFilter(filter, true, w),
    })
  }
  if (params.new_group_request !== undefined) {
    entries.push({
      type: PARAM_NEW_GROUP_REQUEST,
      encode: (w) => w.writeVarInt(params.new_group_request!),
    })
  }
  if (params.track_namespace_prefix !== undefined) {
    entries.push({
      type: PARAM_TRACK_NAMESPACE_PREFIX,
      // The parameter "uses the Track Namespace encoding", which is a tuple
      // that states its own field count. That is not the Length-prefixed
      // encoding, so there is no byte length ahead of it.
      encode: (w) => {
        encodeNamespaceTuple(params.track_namespace_prefix!, w)
      },
    })
  }
  if (params.include_properties !== undefined) {
    entries.push({
      type: PARAM_INCLUDE_PROPERTIES,
      // uint8: one raw byte, 0 or 1 (draft-22 Section 9.20.21).
      encode: (w) => w.writeUint8(Number(params.include_properties!)),
    })
  }

  // Unknown params
  if (params.unknown) {
    for (const u of params.unknown) {
      const id = BigInt(u.id)
      entries.push({
        type: id,
        encode: (w) => {
          const raw = hexToBytes(u.raw_hex)
          // For unknown params, we store raw bytes and re-emit them
          w.writeBytes(raw)
        },
      })
    }
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

function decodeParams(reader: BufferReader, messageType: string): Draft22Params {
  const count = Number(reader.readVarInt())
  const result: Draft22Params = {}
  let prevType = 0n

  for (let i = 0; i < count; i++) {
    const delta = reader.readVarInt()
    const paramType = prevType + delta
    prevType = paramType

    const scope = PARAMETER_SCOPE.get(paramType)
    if (scope !== undefined && !scope.has(messageType)) {
      throw new DecodeError(
        'CONSTRAINT_VIOLATION',
        `Message Parameter 0x${paramType.toString(16)} may not appear in ${messageType}`,
        reader.offset,
      )
    }

    if (paramType === PARAM_OBJECT_DELIVERY_TIMEOUT) {
      result.object_delivery_timeout = reader.readVarInt()
    } else if (paramType === PARAM_AUTHORIZATION_TOKEN) {
      const length = Number(reader.readVarInt())
      const bytes = reader.readBytes(length)
      const token = decodeAuthorizationToken(new BufferReader(bytes))
      noteAuthTokenValue(reader.offset - length, length, token)
      result.authorization_token = [...(result.authorization_token ?? []), token]
    } else if (paramType === PARAM_RENDEZVOUS_TIMEOUT) {
      result.rendezvous_timeout = reader.readVarInt()
    } else if (paramType === PARAM_SUBGROUP_DELIVERY_TIMEOUT) {
      result.subgroup_delivery_timeout = reader.readVarInt()
    } else if (paramType === PARAM_EXPIRES) {
      result.expires = reader.readVarInt()
    } else if (paramType === PARAM_LARGEST_OBJECT) {
      // Location: 2 bare varints (not length-prefixed)
      const group = reader.readVarInt()
      const object = reader.readVarInt()
      result.largest_object = { group, object }
    } else if (paramType === PARAM_FILL_TIMEOUT) {
      result.fill_timeout = reader.readVarInt()
    } else if (paramType === PARAM_FORWARD) {
      // uint8: single raw byte
      result.forward = BigInt(reader.readUint8())
    } else if (paramType === PARAM_SUBSCRIBER_PRIORITY) {
      // uint8: single raw byte
      result.subscriber_priority = BigInt(reader.readUint8())
    } else if (paramType === PARAM_LOCATION_FILTER) {
      result.location_filter = decodeLocationFilter(reader)
    } else if (paramType === PARAM_GROUP_ORDER) {
      // uint8: single raw byte
      result.group_order = BigInt(reader.readUint8())
    } else if (paramType === PARAM_FILL_PARAMETERS) {
      result.fill_parameters = decodeFillParameters(reader)
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
      // Track Namespace encoding, read in place: the tuple's own field count
      // bounds it.
      result.track_namespace_prefix = decodeNamespaceTuple(reader)
    } else if (paramType === PARAM_INCLUDE_PROPERTIES) {
      // Section 9.20.21: "The allowed values are 0 (do not send Properties) or
      // 1 (send Properties), and the default is 1. If an endpoint receives a
      // value outside this range, it MUST close the session with
      // PROTOCOL_VIOLATION."
      const value = BigInt(reader.readUint8())
      if (value !== 0n && value !== 1n) {
        throw new DecodeError(
          'CONSTRAINT_VIOLATION',
          `INCLUDE_PROPERTIES accepts only 0 or 1, got ${value}`,
          reader.offset,
        )
      }
      result.include_properties = value
    } else {
      // Section 9.20: "All Message Parameters MUST be defined in the negotiated
      // version of MOQT or negotiated via Setup Options. An endpoint that
      // receives an unknown Message Parameter MUST close the session with
      // PROTOCOL_VIOLATION."
      //
      // There is no skipping an unknown one and carrying on: the value's
      // encoding comes from its definition, so a receiver that does not know
      // the Type does not know how many bytes it spans either.
      throw new DecodeError(
        'INVALID_PARAMETER',
        `Unknown Message Parameter type 0x${paramType.toString(16)}`,
        reader.offset,
      )
    }
  }

  return result
}

/**
 * Decode a FILL_PARAMETERS (0x23) value — draft-22 Section 9.20.15.
 *
 * See the encoder for D1 (the value begins with Number of Parameters) and D2
 * (the Type Delta chain restarts here and the enclosing chain is unaffected).
 * The eight permitted inner types are expressed as the {@link FILL_SCOPE} entry
 * in {@link PARAMETER_SCOPE}, so "An endpoint that receives a parameter inside
 * FILL_PARAMETERS that is not listed above MUST close the session with
 * PROTOCOL_VIOLATION" falls out of the ordinary scope check.
 */
function decodeFillParameters(reader: BufferReader): Draft22FillParameters {
  const length = Number(reader.readVarInt())
  const valueBytes = reader.readBytes(length)
  const nested = new BufferReader(valueBytes)
  const params = withoutAuthValueSpans(() => decodeParams(nested, FILL_SCOPE))
  if (nested.remaining > 0) {
    // The parameter count and the byte length disagree. The draft does not say
    // what to do; leaving the slack unread would let a sender smuggle bytes no
    // receiver interprets, so refuse it.
    throw new DecodeError(
      'CONSTRAINT_VIOLATION',
      `FILL_PARAMETERS has ${nested.remaining} trailing byte(s) after its parameter block`,
      reader.offset,
    )
  }
  return params as Draft22FillParameters
}

// ─── Track Properties Encoding/Decoding (KVP, no count prefix) ──────────────

const TPROP_OBJECT_DELIVERY_TIMEOUT = 0x02n
const TPROP_MAX_CACHE_DURATION = 0x04n
const TPROP_SUBGROUP_DELIVERY_TIMEOUT = 0x06n
const TPROP_IMMUTABLE_PROPERTIES = 0x0bn
const TPROP_DEFAULT_PUBLISHER_PRIORITY = 0x0en
const TPROP_DEFAULT_PUBLISHER_GROUP_ORDER = 0x22n
const TPROP_DYNAMIC_GROUPS = 0x30n

function encodeTrackProperties(props: Draft22TrackProperties, writer: BufferWriter): void {
  const entries: Array<{ type: bigint; encode: (w: BufferWriter) => void }> = []

  if (props.object_delivery_timeout !== undefined) {
    entries.push({
      type: TPROP_OBJECT_DELIVERY_TIMEOUT,
      encode: (w) => w.writeVarInt(props.object_delivery_timeout!),
    })
  }
  if (props.max_cache_duration !== undefined) {
    entries.push({
      type: TPROP_MAX_CACHE_DURATION,
      encode: (w) => w.writeVarInt(props.max_cache_duration!),
    })
  }
  if (props.subgroup_delivery_timeout !== undefined) {
    entries.push({
      type: TPROP_SUBGROUP_DELIVERY_TIMEOUT,
      encode: (w) => w.writeVarInt(props.subgroup_delivery_timeout!),
    })
  }
  if (props.immutable_properties !== undefined) {
    entries.push({
      type: TPROP_IMMUTABLE_PROPERTIES,
      encode: (w) => {
        const raw = props.immutable_properties!
        w.writeVarInt(BigInt(raw.byteLength))
        w.writeBytes(raw)
      },
    })
  }
  if (props.default_publisher_priority !== undefined) {
    entries.push({
      type: TPROP_DEFAULT_PUBLISHER_PRIORITY,
      encode: (w) => w.writeVarInt(props.default_publisher_priority!),
    })
  }
  if (props.default_publisher_group_order !== undefined) {
    entries.push({
      type: TPROP_DEFAULT_PUBLISHER_GROUP_ORDER,
      encode: (w) => w.writeVarInt(props.default_publisher_group_order!),
    })
  }
  if (props.dynamic_groups !== undefined) {
    entries.push({
      type: TPROP_DYNAMIC_GROUPS,
      encode: (w) => w.writeVarInt(props.dynamic_groups!),
    })
  }

  if (props.unknown) {
    for (const u of props.unknown) {
      const id = BigInt(u.id)
      entries.push({
        type: id,
        encode: (w) => {
          if (id % 2n === 0n) {
            const raw = hexToBytes(u.raw_hex)
            const tmpReader = new BufferReader(raw)
            w.writeVarInt(tmpReader.readVarInt())
          } else {
            const raw = hexToBytes(u.raw_hex)
            w.writeVarInt(BigInt(raw.byteLength))
            w.writeBytes(raw)
          }
        },
      })
    }
  }

  entries.sort((a, b) => (a.type < b.type ? -1 : a.type > b.type ? 1 : 0))

  let prevType = 0n
  for (const entry of entries) {
    writer.writeVarInt(entry.type - prevType)
    entry.encode(writer)
    prevType = entry.type
  }
}

function decodeTrackProperties(reader: BufferReader, payloadEnd: number): Draft22TrackProperties {
  const result: Draft22TrackProperties = {}
  const unknown: UnknownParam[] = []
  let prevType = 0n

  while (reader.offset < payloadEnd) {
    const delta = reader.readVarInt()
    const propType = prevType + delta
    prevType = propType

    if (propType % 2n === 0n) {
      // Even: single varint value
      const value = reader.readVarInt()
      if (propType === TPROP_OBJECT_DELIVERY_TIMEOUT) {
        result.object_delivery_timeout = value
      } else if (propType === TPROP_MAX_CACHE_DURATION) {
        result.max_cache_duration = value
      } else if (propType === TPROP_SUBGROUP_DELIVERY_TIMEOUT) {
        result.subgroup_delivery_timeout = value
      } else if (propType === TPROP_DEFAULT_PUBLISHER_PRIORITY) {
        result.default_publisher_priority = value
      } else if (propType === TPROP_DEFAULT_PUBLISHER_GROUP_ORDER) {
        result.default_publisher_group_order = value
      } else if (propType === TPROP_DYNAMIC_GROUPS) {
        result.dynamic_groups = value
      } else {
        // Section 16.8: endpoints MUST ignore unknown Property types, skipping
        // them by the Key-Value-Pair odd/even rule. Kept for passthrough.
        const tmpWriter = new BufferWriter(16)
        tmpWriter.writeVarInt(value)
        const raw = tmpWriter.finish()
        unknown.push({
          id: `0x${propType.toString(16)}`,
          length: raw.byteLength,
          raw_hex: bytesToHex(raw),
        })
      }
    } else {
      // Odd: length-prefixed bytes
      const length = Number(reader.readVarInt())
      const bytes = reader.readBytes(length)
      if (propType === TPROP_IMMUTABLE_PROPERTIES) {
        result.immutable_properties = bytes
      } else {
        unknown.push({
          id: `0x${propType.toString(16)}`,
          length,
          raw_hex: bytesToHex(bytes),
        })
      }
    }
  }

  if (unknown.length > 0) result.unknown = unknown
  return result
}

// ─── Redirect Structure Encoding/Decoding ───────────────────────────────────

function encodeRedirect(redirect: Redirect, w: BufferWriter): void {
  const uri = textEncoder.encode(redirect.connect_uri)
  w.writeVarInt(BigInt(uri.byteLength))
  w.writeBytes(uri)
  w.writeTuple(redirect.track_namespace)
  w.writeString(redirect.track_name)
}

function decodeRedirect(r: BufferReader): Redirect {
  const uriLen = Number(r.readVarInt())
  const uriBytes = r.readBytes(uriLen)
  const connect_uri = textDecoder.decode(uriBytes)
  // draft-22 Section 9.4.1 names this pair "the Redirect target". draft-19's
  // rule that a zero-length namespace and name meant "reuse the values from the
  // original request" was deleted, so an empty pair is a literal empty pair.
  const track_namespace = r.readTuple()
  const track_name = r.readString()
  return { connect_uri, track_namespace, track_name }
}

// ─── Payload Encoders ──────────────────────────────────────────────────────────

function encodeSetupPayload(msg: Draft22Message & { type: 'setup' }, w: BufferWriter): void {
  encodeSetupOptions(msg.options, w)
}

function encodeSubscribePayload(
  msg: Draft22Message & { type: 'subscribe' },
  w: BufferWriter,
): void {
  w.writeVarInt(msg.request_id)
  w.writeTuple(msg.track_namespace)
  w.writeString(msg.track_name)
  encodeParams(msg.parameters, w)
}

function encodeSubscribeOkPayload(
  msg: Draft22Message & { type: 'subscribe_ok' },
  w: BufferWriter,
): void {
  w.writeVarInt(msg.track_alias)
  encodeParams(msg.parameters, w)
  encodeTrackProperties(msg.track_properties, w)
}

function encodeRequestUpdatePayload(
  msg: Draft22Message & { type: 'request_update' },
  w: BufferWriter,
): void {
  w.writeVarInt(msg.request_id)
  encodeParams(msg.parameters, w)
}

function encodePublishStateNotifyPayload(
  msg: Draft22Message & { type: 'publish_state_notify' },
  w: BufferWriter,
): void {
  // No Request ID: the subscription's bidirectional stream identifies it.
  encodeParams(msg.parameters, w)
}

function encodePublishPayload(msg: Draft22Message & { type: 'publish' }, w: BufferWriter): void {
  w.writeVarInt(msg.request_id)
  w.writeTuple(msg.track_namespace)
  w.writeString(msg.track_name)
  w.writeVarInt(msg.track_alias)
  encodeParams(msg.parameters, w)
  encodeTrackProperties(msg.track_properties, w)
}

function encodePublishDonePayload(
  msg: Draft22Message & { type: 'publish_done' },
  w: BufferWriter,
): void {
  w.writeVarInt(msg.status_code)
  // bigint all the way: UNKNOWN_STREAM_COUNT is 2^64 - 1 and MOQT's vi64
  // reaches it in nine bytes.
  w.writeVarInt(msg.stream_count)
  w.writeString(msg.reason_phrase)
}

function encodePublishNamespacePayload(
  msg: Draft22Message & { type: 'publish_namespace' },
  w: BufferWriter,
): void {
  w.writeVarInt(msg.request_id)
  w.writeTuple(msg.track_namespace)
  encodeParams(msg.parameters, w)
}

function encodeNamespacePayload(
  msg: Draft22Message & { type: 'namespace' },
  w: BufferWriter,
): void {
  w.writeTuple(msg.namespace_suffix)
}

function encodeNamespaceDonePayload(
  msg: Draft22Message & { type: 'namespace_done' },
  w: BufferWriter,
): void {
  w.writeTuple(msg.namespace_suffix)
}

function encodeSubscribeNamespacePayload(
  msg: Draft22Message & { type: 'subscribe_namespace' },
  w: BufferWriter,
): void {
  w.writeVarInt(msg.request_id)
  w.writeTuple(msg.namespace_prefix)
  encodeParams(msg.parameters, w)
}

function encodeSubscribeTracksPayload(
  msg: Draft22Message & { type: 'subscribe_tracks' },
  w: BufferWriter,
): void {
  w.writeVarInt(msg.request_id)
  w.writeTuple(msg.namespace_prefix)
  encodeParams(msg.parameters, w)
}

function encodePublishSkippedPayload(
  msg: Draft22Message & { type: 'publish_skipped' },
  w: BufferWriter,
): void {
  w.writeTuple(msg.namespace_suffix)
  w.writeString(msg.track_name)
}

/**
 * FETCH (0x16) — draft-22 Section 9.11, Figure 16.
 *
 * Track Namespace and Track Name are inline, in exactly the positions they
 * occupied inside draft-19's Standalone Fetch struct. There is no Fetch Type
 * ahead of them and no Start/End Location behind them: the range is a
 * LOCATION_FILTER parameter now, and it is inclusive (see
 * {@link encodeLocationFilter}).
 */
function encodeFetchPayload(msg: Draft22Message & { type: 'fetch' }, w: BufferWriter): void {
  w.writeVarInt(msg.request_id)
  w.writeTuple(msg.track_namespace)
  w.writeString(msg.track_name)
  encodeParams(msg.parameters, w)
}

function encodeFetchOkPayload(msg: Draft22Message & { type: 'fetch_ok' }, w: BufferWriter): void {
  w.writeUint8(msg.end_of_track)
  // End Location, written as given. draft-19 wrote "the last Object, plus 1"
  // here and used an Object of 0 to mean the whole group; draft-22 Section
  // 9.12 has neither, so this is the last Object the response covers and no
  // arithmetic is applied on the way out (DECISIONS.md D4).
  w.writeVarInt(msg.end_group)
  w.writeVarInt(msg.end_object)
  encodeParams(msg.parameters, w)
  encodeTrackProperties(msg.track_properties, w)
}

function encodeTrackStatusPayload(
  msg: Draft22Message & { type: 'track_status' },
  w: BufferWriter,
): void {
  w.writeVarInt(msg.request_id)
  w.writeTuple(msg.track_namespace)
  w.writeString(msg.track_name)
  encodeParams(msg.parameters, w)
}

function encodeRequestOkPayload(
  msg: Draft22Message & { type: 'request_ok' },
  w: BufferWriter,
): void {
  encodeParams(msg.parameters, w)
  encodeTrackProperties(msg.track_properties, w)
}

function encodeRequestErrorPayload(
  msg: Draft22Message & { type: 'request_error' },
  w: BufferWriter,
): void {
  w.writeVarInt(msg.error_code)
  w.writeVarInt(msg.retry_interval)
  w.writeString(msg.reason_phrase)
  if (msg.error_code === REQUEST_ERROR_REDIRECT && msg.redirect) {
    encodeRedirect(msg.redirect, w)
  }
}

function encodeGoAwayPayload(msg: Draft22Message & { type: 'goaway' }, w: BufferWriter): void {
  w.writeString(msg.new_session_uri)
  w.writeVarInt(msg.timeout)
}

// ─── Payload Decoders ──────────────────────────────────────────────────────────

function decodeSetupPayload(r: BufferReader, payloadEnd: number): Draft22Message {
  const options = decodeSetupOptions(r, payloadEnd)
  return { type: 'setup', options }
}

function decodeSubscribePayload(r: BufferReader): Draft22Message {
  const request_id = r.readVarInt()
  const track_namespace = r.readTuple()
  const track_name = r.readString()
  const parameters = decodeParams(r, 'subscribe')
  return {
    type: 'subscribe',
    request_id,
    track_namespace,
    track_name,
    parameters,
  }
}

function decodeSubscribeOkPayload(r: BufferReader, payloadEnd: number): Draft22Message {
  const track_alias = r.readVarInt()
  const parameters = decodeParams(r, 'subscribe_ok')
  const track_properties = decodeTrackProperties(r, payloadEnd)
  return { type: 'subscribe_ok', track_alias, parameters, track_properties }
}

function decodeRequestUpdatePayload(r: BufferReader): Draft22Message {
  const request_id = r.readVarInt()
  const parameters = decodeParams(r, 'request_update')
  return {
    type: 'request_update',
    request_id,
    parameters,
  }
}

function decodePublishStateNotifyPayload(r: BufferReader): Draft22Message {
  const parameters = decodeParams(r, 'publish_state_notify')
  return { type: 'publish_state_notify', parameters }
}

function decodePublishPayload(r: BufferReader, payloadEnd: number): Draft22Message {
  const request_id = r.readVarInt()
  const track_namespace = r.readTuple()
  const track_name = r.readString()
  const track_alias = r.readVarInt()
  const parameters = decodeParams(r, 'publish')
  const track_properties = decodeTrackProperties(r, payloadEnd)
  return {
    type: 'publish',
    request_id,
    track_namespace,
    track_name,
    track_alias,
    parameters,
    track_properties,
  }
}

function decodePublishDonePayload(r: BufferReader): Draft22Message {
  // An unassigned status code decodes. Section 13: "Receipt of an unknown error
  // code in any error context (Session Termination, REQUEST_ERROR,
  // PUBLISH_DONE, or Data Stream Reset) MUST be treated as equivalent to
  // INTERNAL_ERROR for that context. An endpoint MUST NOT close the session
  // because it received an unknown error code in a REQUEST_ERROR or
  // PUBLISH_DONE." A retired code is an unknown code, so refusing the frame
  // here would break that MUST NOT — and a decoder that refuses cannot hand the
  // message to anything that could apply the INTERNAL_ERROR reading.
  // RETIRED_PUBLISH_DONE_CODES stays exported for callers that want to flag the
  // peer as speaking an older draft; it is advisory, not a decode gate.
  const status_code = r.readVarInt()
  const stream_count = r.readVarInt()
  const reason_phrase = r.readString()
  return { type: 'publish_done', status_code, stream_count, reason_phrase }
}

function decodePublishNamespacePayload(r: BufferReader): Draft22Message {
  const request_id = r.readVarInt()
  const track_namespace = r.readTuple()
  const parameters = decodeParams(r, 'publish_namespace')
  return {
    type: 'publish_namespace',
    request_id,
    track_namespace,
    parameters,
  }
}

function decodeNamespacePayload(r: BufferReader): Draft22Message {
  const namespace_suffix = r.readTuple()
  return { type: 'namespace', namespace_suffix }
}

function decodeNamespaceDonePayload(r: BufferReader): Draft22Message {
  const namespace_suffix = r.readTuple()
  return { type: 'namespace_done', namespace_suffix }
}

function decodeSubscribeNamespacePayload(r: BufferReader): Draft22Message {
  const request_id = r.readVarInt()
  const namespace_prefix = r.readTuple()
  const parameters = decodeParams(r, 'subscribe_namespace')
  return {
    type: 'subscribe_namespace',
    request_id,
    namespace_prefix,
    parameters,
  }
}

function decodeSubscribeTracksPayload(r: BufferReader): Draft22Message {
  const request_id = r.readVarInt()
  const namespace_prefix = r.readTuple()
  const parameters = decodeParams(r, 'subscribe_tracks')
  return {
    type: 'subscribe_tracks',
    request_id,
    namespace_prefix,
    parameters,
  }
}

function decodePublishSkippedPayload(r: BufferReader): Draft22Message {
  const namespace_suffix = r.readTuple()
  const track_name = r.readString()
  return { type: 'publish_skipped', namespace_suffix, track_name }
}

function decodeFetchPayload(r: BufferReader): Draft22Message {
  // No Fetch Type varint here. The first field after Request ID is the Track
  // Namespace tuple's own field count — which is exactly the byte a draft-19
  // decoder would read as a Fetch Type. See the Draft22Fetch doc comment.
  const request_id = r.readVarInt()
  const track_namespace = r.readTuple()
  const track_name = r.readString()
  const parameters = decodeParams(r, 'fetch')
  return {
    type: 'fetch',
    request_id,
    track_namespace,
    track_name,
    parameters,
  }
}

function decodeFetchOkPayload(r: BufferReader, payloadEnd: number): Draft22Message {
  const end_of_track = r.readUint8()
  // Inclusive end. No decrement here, as no encoder incremented.
  const end_group = r.readVarInt()
  const end_object = r.readVarInt()
  const parameters = decodeParams(r, 'fetch_ok')
  const track_properties = decodeTrackProperties(r, payloadEnd)
  return {
    type: 'fetch_ok',
    end_of_track,
    end_group,
    end_object,
    parameters,
    track_properties,
  }
}

function decodeTrackStatusPayload(r: BufferReader): Draft22Message {
  const request_id = r.readVarInt()
  const track_namespace = r.readTuple()
  const track_name = r.readString()
  const parameters = decodeParams(r, 'track_status')
  return {
    type: 'track_status',
    request_id,
    track_namespace,
    track_name,
    parameters,
  }
}

function decodeRequestOkPayload(r: BufferReader, payloadEnd: number): Draft22Message {
  const parameters = decodeParams(r, 'request_ok')
  const track_properties = decodeTrackProperties(r, payloadEnd)
  return { type: 'request_ok', parameters, track_properties }
}

function decodeRequestErrorPayload(r: BufferReader, payloadEnd: number): Draft22Message {
  // Unassigned error codes decode — see decodePublishDonePayload for the
  // Section 13 rule this obeys. RETIRED_REQUEST_ERROR_CODES is advisory.
  const error_code = r.readVarInt()
  const retry_interval = r.readVarInt()
  const reason_phrase = r.readString()
  let redirect: Redirect | undefined
  if (error_code === REQUEST_ERROR_REDIRECT && r.offset < payloadEnd) {
    redirect = decodeRedirect(r)
  }
  if (redirect !== undefined) {
    return { type: 'request_error', error_code, retry_interval, reason_phrase, redirect }
  }
  return { type: 'request_error', error_code, retry_interval, reason_phrase }
}

function decodeGoAwayPayload(r: BufferReader): Draft22Message {
  const new_session_uri = r.readString()
  const timeout = r.readVarInt()
  return { type: 'goaway', new_session_uri, timeout }
}

// ─── Public API ────────────────────────────────────────────────────────────────

/**
 * Encode a draft-22 control message: type (vi64) + length (uint16 BE) + payload.
 */
export function encodeMessage(message: Draft22Message): Uint8Array {
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

function encodePayload(msg: Draft22Message, w: BufferWriter): void {
  switch (msg.type) {
    case 'setup':
      return encodeSetupPayload(msg, w)
    case 'subscribe':
      return encodeSubscribePayload(msg, w)
    case 'subscribe_ok':
      return encodeSubscribeOkPayload(msg, w)
    case 'request_update':
      return encodeRequestUpdatePayload(msg, w)
    case 'publish_state_notify':
      return encodePublishStateNotifyPayload(msg, w)
    case 'publish':
      return encodePublishPayload(msg, w)
    case 'publish_done':
      return encodePublishDonePayload(msg, w)
    case 'publish_namespace':
      return encodePublishNamespacePayload(msg, w)
    case 'namespace':
      return encodeNamespacePayload(msg, w)
    case 'namespace_done':
      return encodeNamespaceDonePayload(msg, w)
    case 'subscribe_namespace':
      return encodeSubscribeNamespacePayload(msg, w)
    case 'subscribe_tracks':
      return encodeSubscribeTracksPayload(msg, w)
    case 'publish_skipped':
      return encodePublishSkippedPayload(msg, w)
    case 'fetch':
      return encodeFetchPayload(msg, w)
    case 'fetch_ok':
      return encodeFetchOkPayload(msg, w)
    case 'track_status':
      return encodeTrackStatusPayload(msg, w)
    case 'request_ok':
      return encodeRequestOkPayload(msg, w)
    case 'request_error':
      return encodeRequestErrorPayload(msg, w)
    case 'goaway':
      return encodeGoAwayPayload(msg, w)
    default: {
      const _exhaustive: never = msg
      throw new Error(`Unhandled message type: ${(_exhaustive as Draft22Message).type}`)
    }
  }
}

/**
 * Decode a draft-22 control message from bytes (type + uint16 length + payload).
 */
export function decodeMessage(bytes: Uint8Array): DecodeResult<Draft22Message> {
  try {
    const reader = new BufferReader(bytes)
    const typeId = reader.readVarInt()

    const lenHi = reader.readUint8()
    const lenLo = reader.readUint8()
    const payloadLength = (lenHi << 8) | lenLo

    const payloadBytes = reader.readBytes(payloadLength)
    const payloadReader = new BufferReader(payloadBytes)

    let message: Draft22Message

    if (typeId === MSG_SETUP) {
      message = decodeSetupPayload(payloadReader, payloadLength)
    } else if (typeId === MSG_SUBSCRIBE) {
      message = decodeSubscribePayload(payloadReader)
    } else if (typeId === MSG_SUBSCRIBE_OK) {
      message = decodeSubscribeOkPayload(payloadReader, payloadLength)
    } else if (typeId === MSG_REQUEST_UPDATE) {
      message = decodeRequestUpdatePayload(payloadReader)
    } else if (typeId === MSG_PUBLISH_STATE_NOTIFY) {
      message = decodePublishStateNotifyPayload(payloadReader)
    } else if (typeId === MSG_PUBLISH) {
      message = decodePublishPayload(payloadReader, payloadLength)
    } else if (typeId === MSG_PUBLISH_DONE) {
      message = decodePublishDonePayload(payloadReader)
    } else if (typeId === MSG_PUBLISH_NAMESPACE) {
      message = decodePublishNamespacePayload(payloadReader)
    } else if (typeId === MSG_NAMESPACE) {
      message = decodeNamespacePayload(payloadReader)
    } else if (typeId === MSG_NAMESPACE_DONE) {
      message = decodeNamespaceDonePayload(payloadReader)
    } else if (typeId === MSG_SUBSCRIBE_NAMESPACE) {
      message = decodeSubscribeNamespacePayload(payloadReader)
    } else if (typeId === MSG_SUBSCRIBE_TRACKS) {
      message = decodeSubscribeTracksPayload(payloadReader)
    } else if (typeId === MSG_PUBLISH_SKIPPED) {
      message = decodePublishSkippedPayload(payloadReader)
    } else if (typeId === MSG_FETCH) {
      message = decodeFetchPayload(payloadReader)
    } else if (typeId === MSG_FETCH_OK) {
      message = decodeFetchOkPayload(payloadReader, payloadLength)
    } else if (typeId === MSG_TRACK_STATUS) {
      message = decodeTrackStatusPayload(payloadReader)
    } else if (typeId === MSG_REQUEST_OK) {
      message = decodeRequestOkPayload(payloadReader, payloadLength)
    } else if (typeId === MSG_REQUEST_ERROR) {
      message = decodeRequestErrorPayload(payloadReader, payloadLength)
    } else if (typeId === MSG_GOAWAY) {
      message = decodeGoAwayPayload(payloadReader)
    } else {
      // Section 9: "An endpoint that receives an unknown message type MUST
      // close the session."
      return {
        ok: false,
        error: new DecodeError(
          'UNKNOWN_MESSAGE_TYPE',
          `Unknown message type ID: 0x${typeId.toString(16)}`,
          0,
        ),
      }
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

export function createStreamDecoder(): TransformStream<Uint8Array, Draft22Message> {
  let buffer = new Uint8Array(0)
  let offset = 0

  return new TransformStream<Uint8Array, Draft22Message>({
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

export interface Draft22Codec extends BaseCodec<Draft22Message> {
  readonly draft: '22'
  encodeSubgroupStream(stream: SubgroupStream): Uint8Array
  encodeDatagram(dg: DatagramObject): Uint8Array
  encodeFetchStream(stream: FetchStream): Uint8Array
  decodeSubgroupStream(bytes: Uint8Array): DecodeResult<SubgroupStream>
  decodeDatagram(bytes: Uint8Array): DecodeResult<DatagramObject>
  decodeFetchStream(bytes: Uint8Array): DecodeResult<FetchStream>
  decodeDataStream(
    streamType: 'subgroup' | 'datagram' | 'fetch',
    bytes: Uint8Array,
  ): DecodeResult<Draft22DataStream>
  createStreamDecoder(): TransformStream<Uint8Array, Draft22Message>
  createSubgroupStreamDecoder(): TransformStream<Uint8Array, SubgroupStreamHeader | ObjectPayload>
  createFetchStreamDecoder(): TransformStream<Uint8Array, FetchStreamHeader | ObjectPayload>
  createDataStreamDecoder(): TransformStream<Uint8Array, DataStreamEvent>
}

export function createDraft22Codec(): Draft22Codec {
  return {
    draft: '22',
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

/**
 * Overwrite every Authorization Token value in a draft-22 control frame.
 *
 * One decode, whose *output is discarded*: the point is not to read the
 * message, it is to learn where the tokens were so the caller never has to hold
 * a frame that contains one. A caller that also wants the message should decode
 * the **redacted** frame with {@link decodeMessage}, which then cannot produce a
 * token value because there is no longer one in the bytes.
 *
 * A frame that fails to decode is still redacted as far as the decode got. That
 * is the useful direction to fail in: a value that was read is a value that was
 * exposed, whatever went wrong after it.
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
    probe.readUint8()
    probe.readUint8()
    payloadStart = probe.offset
  } catch {
    // Too short to carry a message header, and so too short for the parameters
    // that carry a token. Reported as not decoded rather than as clean: the
    // framer only ever emits complete frames, so a caller that gets here is
    // holding something this function did not check.
    return { bytes, redacted: 0, incomplete: false, decoded: false }
  }
  return redactWith(bytes, payloadStart, () => decodeMessage(bytes).ok)
}
