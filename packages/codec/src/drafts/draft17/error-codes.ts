export const SessionTerminationCode = {
  NoError: 0x0n,
  InternalError: 0x1n,
  Unauthorized: 0x2n,
  ProtocolViolation: 0x3n,
  InvalidRequestId: 0x4n,
  DuplicateTrackAlias: 0x5n,
  KeyValueFormattingError: 0x6n,
  InvalidRequiredRequestId: 0x7n,
  InvalidPath: 0x8n,
  MalformedPath: 0x9n,
  GoawayTimeout: 0x10n,
  ControlMessageTimeout: 0x11n,
  DataStreamTimeout: 0x12n,
  AuthTokenCacheOverflow: 0x13n,
  DuplicateAuthTokenAlias: 0x14n,
  VersionNegotiationFailed: 0x15n,
  MalformedAuthToken: 0x16n,
  UnknownAuthTokenAlias: 0x17n,
  ExpiredAuthToken: 0x18n,
  InvalidAuthority: 0x19n,
  MalformedAuthority: 0x1an,
} as const
export type SessionTerminationCodeValue =
  (typeof SessionTerminationCode)[keyof typeof SessionTerminationCode]

export const RequestErrorCode = {
  InternalError: 0x0n,
  Unauthorized: 0x1n,
  Timeout: 0x2n,
  NotSupported: 0x3n,
  MalformedAuthToken: 0x4n,
  ExpiredAuthToken: 0x5n,
  GoingAway: 0x6n,
  ExcessiveLoad: 0x9n,
  DoesNotExist: 0x10n,
  InvalidRange: 0x11n,
  MalformedTrack: 0x12n,
  DuplicateSubscription: 0x19n,
  Uninterested: 0x20n,
  PrefixOverlap: 0x30n,
  NamespaceTooLarge: 0x31n,
  InvalidJoiningRequestId: 0x32n,
} as const
export type RequestErrorCodeValue = (typeof RequestErrorCode)[keyof typeof RequestErrorCode]

export const PublishDoneCode = {
  InternalError: 0x0n,
  Unauthorized: 0x1n,
  TrackEnded: 0x2n,
  SubscriptionEnded: 0x3n,
  GoingAway: 0x4n,
  Expired: 0x5n,
  TooFarBehind: 0x6n,
  UpdateFailed: 0x8n,
  ExcessiveLoad: 0x9n,
  MalformedTrack: 0x12n,
} as const
export type PublishDoneCodeValue = (typeof PublishDoneCode)[keyof typeof PublishDoneCode]

export const DataStreamResetCode = {
  InternalError: 0x0n,
  Cancelled: 0x1n,
  DeliveryTimeout: 0x2n,
  SessionClosed: 0x3n,
  UnknownObjectStatus: 0x4n,
  TooFarBehind: 0x5n,
  ExcessiveLoad: 0x9n,
  MalformedTrack: 0x12n,
} as const
export type DataStreamResetCodeValue =
  (typeof DataStreamResetCode)[keyof typeof DataStreamResetCode]
