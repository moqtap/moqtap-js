// Draft-11 error, status and termination code registries.

export const SessionErrorCode = {
  NoError: 0x0n,
  InternalError: 0x1n,
  Unauthorized: 0x2n,
  ProtocolViolation: 0x3n,
  InvalidRequestId: 0x4n,
  DuplicateTrackAlias: 0x5n,
  KeyValueFormattingError: 0x6n,
  TooManyRequests: 0x7n,
  InvalidPath: 0x8n,
  MalformedPath: 0x9n,
  GoawayTimeout: 0x10n,
  ControlMessageTimeout: 0x11n,
  DataStreamTimeout: 0x12n,
  AuthTokenCacheOverflow: 0x13n,
  DuplicateAuthTokenAlias: 0x14n,
  VersionNegotiationFailed: 0x15n,
} as const
export type SessionErrorCodeValue = (typeof SessionErrorCode)[keyof typeof SessionErrorCode]

export const SubscribeErrorCode = {
  InternalError: 0x0n,
  Unauthorized: 0x1n,
  Timeout: 0x2n,
  NotSupported: 0x3n,
  TrackDoesNotExist: 0x4n,
  InvalidRange: 0x5n,
  RetryTrackAlias: 0x6n,
  MalformedAuthToken: 0x10n,
  UnknownAuthTokenAlias: 0x11n,
  ExpiredAuthToken: 0x12n,
} as const
export type SubscribeErrorCodeValue = (typeof SubscribeErrorCode)[keyof typeof SubscribeErrorCode]

export const SubscribeDoneStatusCode = {
  InternalError: 0x0n,
  Unauthorized: 0x1n,
  TrackEnded: 0x2n,
  SubscriptionEnded: 0x3n,
  GoingAway: 0x4n,
  Expired: 0x5n,
  TooFarBehind: 0x6n,
} as const
export type SubscribeDoneStatusCodeValue =
  (typeof SubscribeDoneStatusCode)[keyof typeof SubscribeDoneStatusCode]

export const FetchErrorCode = {
  InternalError: 0x0n,
  Unauthorized: 0x1n,
  Timeout: 0x2n,
  NotSupported: 0x3n,
  TrackDoesNotExist: 0x4n,
  InvalidRange: 0x5n,
  NoObjects: 0x6n,
  InvalidJoiningSubscribeId: 0x7n,
  MalformedAuthToken: 0x10n,
  UnknownAuthTokenAlias: 0x11n,
  ExpiredAuthToken: 0x12n,
} as const
export type FetchErrorCodeValue = (typeof FetchErrorCode)[keyof typeof FetchErrorCode]

export const AnnounceErrorCode = {
  InternalError: 0x0n,
  Unauthorized: 0x1n,
  Timeout: 0x2n,
  NotSupported: 0x3n,
  Uninterested: 0x4n,
  MalformedAuthToken: 0x10n,
  UnknownAuthTokenAlias: 0x11n,
  ExpiredAuthToken: 0x12n,
} as const
export type AnnounceErrorCodeValue = (typeof AnnounceErrorCode)[keyof typeof AnnounceErrorCode]

export const SubscribeAnnouncesErrorCode = {
  InternalError: 0x0n,
  Unauthorized: 0x1n,
  Timeout: 0x2n,
  NotSupported: 0x3n,
  NamespacePrefixUnknown: 0x4n,
  NamespacePrefixOverlap: 0x5n,
  MalformedAuthToken: 0x10n,
  UnknownAuthTokenAlias: 0x11n,
  ExpiredAuthToken: 0x12n,
} as const
export type SubscribeAnnouncesErrorCodeValue =
  (typeof SubscribeAnnouncesErrorCode)[keyof typeof SubscribeAnnouncesErrorCode]

export const TrackStatusCode = {
  InProgress: 0x00n,
  TrackDoesNotExist: 0x01n,
  NotYetBegun: 0x02n,
  Finished: 0x03n,
  RelayStatusUnavailable: 0x04n,
} as const
export type TrackStatusCodeValue = (typeof TrackStatusCode)[keyof typeof TrackStatusCode]

export const StreamResetErrorCode = {
  InternalError: 0x0n,
  Cancelled: 0x1n,
  DeliveryTimeout: 0x2n,
  SessionClosed: 0x3n,
} as const
export type StreamResetErrorCodeValue =
  (typeof StreamResetErrorCode)[keyof typeof StreamResetErrorCode]
