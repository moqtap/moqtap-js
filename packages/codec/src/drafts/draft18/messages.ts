// Draft-18 message type wire IDs

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
export const MSG_PUBLISH_BLOCKED = 0x0fn
export const MSG_GOAWAY = 0x10n
export const MSG_FETCH = 0x16n
export const MSG_FETCH_OK = 0x18n
export const MSG_PUBLISH = 0x1dn
// In draft-18 PUBLISH_OK is an alias for REQUEST_OK (0x07). Kept as alias.
export const MSG_PUBLISH_OK = MSG_REQUEST_OK
export const MSG_SUBSCRIBE_NAMESPACE = 0x50n
export const MSG_SUBSCRIBE_TRACKS = 0x51n
export const MSG_SETUP = 0x2f00n

// Setup option type IDs (KVP encoding, constant across versions)
export const SETUP_OPT_PATH = 0x01n
export const SETUP_OPT_AUTHORIZATION_TOKEN = 0x03n
export const SETUP_OPT_MAX_AUTH_TOKEN_CACHE_SIZE = 0x04n
export const SETUP_OPT_AUTHORITY = 0x05n
export const SETUP_OPT_MOQT_IMPLEMENTATION = 0x07n

// Map from wire ID to message type name
export const MESSAGE_TYPE_MAP: ReadonlyMap<bigint, string> = new Map([
  [MSG_SETUP, 'setup'],
  [MSG_SUBSCRIBE, 'subscribe'],
  [MSG_SUBSCRIBE_OK, 'subscribe_ok'],
  [MSG_REQUEST_UPDATE, 'request_update'],
  [MSG_PUBLISH, 'publish'],
  [MSG_PUBLISH_DONE, 'publish_done'],
  [MSG_PUBLISH_NAMESPACE, 'publish_namespace'],
  [MSG_NAMESPACE, 'namespace'],
  [MSG_NAMESPACE_DONE, 'namespace_done'],
  [MSG_SUBSCRIBE_NAMESPACE, 'subscribe_namespace'],
  [MSG_SUBSCRIBE_TRACKS, 'subscribe_tracks'],
  [MSG_PUBLISH_BLOCKED, 'publish_blocked'],
  [MSG_FETCH, 'fetch'],
  [MSG_FETCH_OK, 'fetch_ok'],
  [MSG_TRACK_STATUS, 'track_status'],
  [MSG_REQUEST_OK, 'request_ok'],
  [MSG_REQUEST_ERROR, 'request_error'],
  [MSG_GOAWAY, 'goaway'],
])

// Reverse map from message type name to wire ID
export const MESSAGE_ID_MAP: ReadonlyMap<string, bigint> = new Map(
  [...MESSAGE_TYPE_MAP.entries()].map(([id, name]) => [name, id]),
)
