// Draft-14 message type wire IDs

export const MSG_SUBSCRIBE_UPDATE    = 0x02n;
export const MSG_SUBSCRIBE           = 0x03n;
export const MSG_SUBSCRIBE_OK        = 0x04n;
export const MSG_SUBSCRIBE_ERROR     = 0x05n;
export const MSG_PUBLISH_NAMESPACE   = 0x06n;
export const MSG_PUBLISH_NAMESPACE_OK    = 0x07n;
export const MSG_PUBLISH_NAMESPACE_ERROR = 0x08n;
export const MSG_PUBLISH_NAMESPACE_DONE  = 0x09n;
export const MSG_UNSUBSCRIBE         = 0x0An;
export const MSG_PUBLISH_DONE        = 0x0Bn;
export const MSG_PUBLISH_NAMESPACE_CANCEL = 0x0Cn;
export const MSG_TRACK_STATUS        = 0x0Dn;
export const MSG_TRACK_STATUS_OK     = 0x0En;
export const MSG_TRACK_STATUS_ERROR  = 0x0Fn;
export const MSG_GOAWAY              = 0x10n;
export const MSG_SUBSCRIBE_NAMESPACE = 0x11n;
export const MSG_SUBSCRIBE_NAMESPACE_OK    = 0x12n;
export const MSG_SUBSCRIBE_NAMESPACE_ERROR = 0x13n;
export const MSG_UNSUBSCRIBE_NAMESPACE     = 0x14n;
export const MSG_MAX_REQUEST_ID      = 0x15n;
export const MSG_FETCH               = 0x16n;
export const MSG_FETCH_CANCEL        = 0x17n;
export const MSG_FETCH_OK            = 0x18n;
export const MSG_FETCH_ERROR         = 0x19n;
export const MSG_REQUESTS_BLOCKED    = 0x1An;
export const MSG_PUBLISH             = 0x1Dn;
export const MSG_PUBLISH_OK          = 0x1En;
export const MSG_PUBLISH_ERROR       = 0x1Fn;
export const MSG_CLIENT_SETUP        = 0x20n;
export const MSG_SERVER_SETUP        = 0x21n;

// Parameter type IDs
export const PARAM_ROLE             = 0x00n;
export const PARAM_PATH             = 0x01n;
export const PARAM_MAX_REQUEST_ID   = 0x02n;

// Map from wire ID to message type name
export const MESSAGE_TYPE_MAP: ReadonlyMap<bigint, string> = new Map([
  [MSG_CLIENT_SETUP, 'client_setup'],
  [MSG_SERVER_SETUP, 'server_setup'],
  [MSG_SUBSCRIBE, 'subscribe'],
  [MSG_SUBSCRIBE_OK, 'subscribe_ok'],
  [MSG_SUBSCRIBE_UPDATE, 'subscribe_update'],
  [MSG_SUBSCRIBE_ERROR, 'subscribe_error'],
  [MSG_UNSUBSCRIBE, 'unsubscribe'],
  [MSG_PUBLISH, 'publish'],
  [MSG_PUBLISH_OK, 'publish_ok'],
  [MSG_PUBLISH_ERROR, 'publish_error'],
  [MSG_PUBLISH_DONE, 'publish_done'],
  [MSG_PUBLISH_NAMESPACE, 'publish_namespace'],
  [MSG_PUBLISH_NAMESPACE_OK, 'publish_namespace_ok'],
  [MSG_PUBLISH_NAMESPACE_ERROR, 'publish_namespace_error'],
  [MSG_PUBLISH_NAMESPACE_DONE, 'publish_namespace_done'],
  [MSG_PUBLISH_NAMESPACE_CANCEL, 'publish_namespace_cancel'],
  [MSG_SUBSCRIBE_NAMESPACE, 'subscribe_namespace'],
  [MSG_SUBSCRIBE_NAMESPACE_OK, 'subscribe_namespace_ok'],
  [MSG_SUBSCRIBE_NAMESPACE_ERROR, 'subscribe_namespace_error'],
  [MSG_UNSUBSCRIBE_NAMESPACE, 'unsubscribe_namespace'],
  [MSG_FETCH, 'fetch'],
  [MSG_FETCH_OK, 'fetch_ok'],
  [MSG_FETCH_ERROR, 'fetch_error'],
  [MSG_FETCH_CANCEL, 'fetch_cancel'],
  [MSG_TRACK_STATUS, 'track_status'],
  [MSG_TRACK_STATUS_OK, 'track_status_ok'],
  [MSG_TRACK_STATUS_ERROR, 'track_status_error'],
  [MSG_GOAWAY, 'goaway'],
  [MSG_MAX_REQUEST_ID, 'max_request_id'],
  [MSG_REQUESTS_BLOCKED, 'requests_blocked'],
]);

// Reverse map from message type name to wire ID
export const MESSAGE_ID_MAP: ReadonlyMap<string, bigint> = new Map(
  [...MESSAGE_TYPE_MAP.entries()].map(([id, name]) => [name, id])
);
