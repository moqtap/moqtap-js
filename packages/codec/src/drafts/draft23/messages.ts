// Draft-23 message type wire IDs (draft-23 Section 9, Table 5).
//
// Table 5 lists 0x18 as "RESERVED (FETCH_OK in <= 22)": a FETCH is answered
// by REQUEST_OK (Section 9.3), so 0x18 is an unknown type here.

export const MSG_REQUEST_UPDATE = 0x02n
export const MSG_SUBSCRIBE = 0x03n
export const MSG_SUBSCRIBE_OK = 0x04n
export const MSG_REQUEST_ERROR = 0x05n
export const MSG_PUBLISH_NAMESPACE = 0x06n
export const MSG_REQUEST_OK = 0x07n
export const MSG_NAMESPACE = 0x08n
export const MSG_PUBLISH_DONE = 0x0bn
export const MSG_TRACK_STATUS = 0x0dn
export const MSG_NAMESPACE_DONE = 0x0en
export const MSG_PUBLISH_SKIPPED = 0x0fn
export const MSG_GOAWAY = 0x10n
export const MSG_FETCH = 0x16n
export const MSG_PUBLISH = 0x1dn
export const MSG_PUBLISH_STATE_NOTIFY = 0x22n
// draft-23 Section 1.5: "This document uses the shorthand PUBLISH_OK,
// FETCH_OK, REQUEST_UPDATE_OK, TRACK_STATUS_OK, SUBSCRIBE_NAMESPACE_OK,
// SUBSCRIBE_TRACKS_OK and PUBLISH_NAMESPACE_OK to refer to a REQUEST_OK sent in
// response to the corresponding request type."
export const MSG_PUBLISH_OK = MSG_REQUEST_OK
export const MSG_SUBSCRIBE_NAMESPACE = 0x50n
export const MSG_SUBSCRIBE_TRACKS = 0x51n
export const MSG_SETUP = 0x2f00n

// Setup Option types (draft-23 Section 16.4, Table 11).
export const SETUP_OPT_PATH = 0x01n
export const SETUP_OPT_AUTHORIZATION_TOKEN = 0x03n
export const SETUP_OPT_MAX_AUTH_TOKEN_CACHE_SIZE = 0x04n
export const SETUP_OPT_AUTHORITY = 0x05n
export const SETUP_OPT_MAX_FILTER_RANGES = 0x06n
export const SETUP_OPT_MOQT_IMPLEMENTATION = 0x07n
export const SETUP_OPT_MAX_REQUEST_UPDATES = 0x08n
export const SETUP_OPT_MAX_CONTROL_MESSAGE_SIZE = 0x09n

/**
 * draft-23 Section 9.1.8: "The value is encoded as a variable-length integer
 * and MUST be at least 65535. If not present, the default value is 65535."
 */
export const DEFAULT_MAX_CONTROL_MESSAGE_SIZE = 65535n

/** draft-23 Section 13: "Grease values follow the pattern 0x7f * N + 0x9D". */
export function isGrease(code: bigint): boolean {
  return code >= 0x9dn && (code - 0x9dn) % 0x7fn === 0n
}

// Error Detail types (draft-23 Section 16.11, Table 19).
export const ERROR_DETAIL_REDIRECT = 0x01n
export const ERROR_DETAIL_UNSUPPORTED_PROPERTY = 0x02n

// Map from wire ID to message type name
export const MESSAGE_TYPE_MAP: ReadonlyMap<bigint, string> = new Map([
  [MSG_SETUP, 'setup'],
  [MSG_SUBSCRIBE, 'subscribe'],
  [MSG_SUBSCRIBE_OK, 'subscribe_ok'],
  [MSG_REQUEST_UPDATE, 'request_update'],
  [MSG_PUBLISH_STATE_NOTIFY, 'publish_state_notify'],
  [MSG_PUBLISH, 'publish'],
  [MSG_PUBLISH_DONE, 'publish_done'],
  [MSG_PUBLISH_NAMESPACE, 'publish_namespace'],
  [MSG_NAMESPACE, 'namespace'],
  [MSG_NAMESPACE_DONE, 'namespace_done'],
  [MSG_SUBSCRIBE_NAMESPACE, 'subscribe_namespace'],
  [MSG_SUBSCRIBE_TRACKS, 'subscribe_tracks'],
  [MSG_PUBLISH_SKIPPED, 'publish_skipped'],
  [MSG_FETCH, 'fetch'],
  [MSG_TRACK_STATUS, 'track_status'],
  [MSG_REQUEST_OK, 'request_ok'],
  [MSG_REQUEST_ERROR, 'request_error'],
  [MSG_GOAWAY, 'goaway'],
])

// Reverse map from message type name to wire ID
export const MESSAGE_ID_MAP: ReadonlyMap<string, bigint> = new Map(
  [...MESSAGE_TYPE_MAP.entries()].map(([id, name]) => [name, id]),
)
