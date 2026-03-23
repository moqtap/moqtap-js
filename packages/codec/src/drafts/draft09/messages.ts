// Draft-09 message type wire IDs

export const MSG_SUBSCRIBE_UPDATE = 0x02n;
export const MSG_SUBSCRIBE = 0x03n;
export const MSG_SUBSCRIBE_OK = 0x04n;
export const MSG_SUBSCRIBE_ERROR = 0x05n;
export const MSG_ANNOUNCE = 0x06n;
export const MSG_ANNOUNCE_OK = 0x07n;
export const MSG_ANNOUNCE_ERROR = 0x08n;
export const MSG_UNANNOUNCE = 0x09n;
export const MSG_UNSUBSCRIBE = 0x0an;
export const MSG_SUBSCRIBE_DONE = 0x0bn;
export const MSG_ANNOUNCE_CANCEL = 0x0cn;
export const MSG_TRACK_STATUS_REQUEST = 0x0dn;
export const MSG_TRACK_STATUS = 0x0en;
export const MSG_GOAWAY = 0x10n;
export const MSG_SUBSCRIBE_ANNOUNCES = 0x11n;
export const MSG_SUBSCRIBE_ANNOUNCES_OK = 0x12n;
export const MSG_SUBSCRIBE_ANNOUNCES_ERROR = 0x13n;
export const MSG_UNSUBSCRIBE_ANNOUNCES = 0x14n;
export const MSG_MAX_SUBSCRIBE_ID = 0x15n;
export const MSG_FETCH = 0x16n;
export const MSG_FETCH_CANCEL = 0x17n;
export const MSG_FETCH_OK = 0x18n;
export const MSG_FETCH_ERROR = 0x19n;
export const MSG_SUBSCRIBES_BLOCKED = 0x1an;
export const MSG_CLIENT_SETUP = 0x40n;
export const MSG_SERVER_SETUP = 0x41n;

// Setup parameter type IDs
export const SETUP_PARAM_PATH = 0x01n;
export const SETUP_PARAM_MAX_SUBSCRIBE_ID = 0x02n;

// Version-specific parameter type IDs
export const PARAM_AUTHORIZATION_INFO = 0x02n;
export const PARAM_DELIVERY_TIMEOUT = 0x03n;
export const PARAM_MAX_CACHE_DURATION = 0x04n;

// Map from wire ID to message type name
export const MESSAGE_TYPE_MAP: ReadonlyMap<bigint, string> = new Map([
  [MSG_CLIENT_SETUP, "client_setup"],
  [MSG_SERVER_SETUP, "server_setup"],
  [MSG_SUBSCRIBE, "subscribe"],
  [MSG_SUBSCRIBE_OK, "subscribe_ok"],
  [MSG_SUBSCRIBE_ERROR, "subscribe_error"],
  [MSG_SUBSCRIBE_UPDATE, "subscribe_update"],
  [MSG_SUBSCRIBE_DONE, "subscribe_done"],
  [MSG_UNSUBSCRIBE, "unsubscribe"],
  [MSG_ANNOUNCE, "announce"],
  [MSG_ANNOUNCE_OK, "announce_ok"],
  [MSG_ANNOUNCE_ERROR, "announce_error"],
  [MSG_UNANNOUNCE, "unannounce"],
  [MSG_ANNOUNCE_CANCEL, "announce_cancel"],
  [MSG_SUBSCRIBE_ANNOUNCES, "subscribe_announces"],
  [MSG_SUBSCRIBE_ANNOUNCES_OK, "subscribe_announces_ok"],
  [MSG_SUBSCRIBE_ANNOUNCES_ERROR, "subscribe_announces_error"],
  [MSG_UNSUBSCRIBE_ANNOUNCES, "unsubscribe_announces"],
  [MSG_FETCH, "fetch"],
  [MSG_FETCH_OK, "fetch_ok"],
  [MSG_FETCH_ERROR, "fetch_error"],
  [MSG_FETCH_CANCEL, "fetch_cancel"],
  [MSG_TRACK_STATUS_REQUEST, "track_status_request"],
  [MSG_TRACK_STATUS, "track_status"],
  [MSG_GOAWAY, "goaway"],
  [MSG_MAX_SUBSCRIBE_ID, "max_subscribe_id"],
  [MSG_SUBSCRIBES_BLOCKED, "subscribes_blocked"],
]);

// Reverse map
export const MESSAGE_ID_MAP: ReadonlyMap<string, bigint> = new Map(
  [...MESSAGE_TYPE_MAP.entries()].map(([id, name]) => [name, id]),
);
