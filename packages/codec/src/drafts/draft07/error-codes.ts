// Draft-07 error, status and termination code registries.

export const SessionErrorCode = {
  NoError: 0x0n,
  InternalError: 0x1n,
  Unauthorized: 0x2n,
  ProtocolViolation: 0x3n,
  DuplicateTrackAlias: 0x4n,
  ParameterLengthMismatch: 0x5n,
  TooManySubscribes: 0x6n,
  GoawayTimeout: 0x10n,
} as const
export type SessionErrorCodeValue = (typeof SessionErrorCode)[keyof typeof SessionErrorCode]

export const SubscribeErrorCode = {
  InternalError: 0x0n,
  InvalidRange: 0x1n,
  RetryTrackAlias: 0x2n,
  TrackDoesNotExist: 0x3n,
  Unauthorized: 0x4n,
  Timeout: 0x5n,
} as const
export type SubscribeErrorCodeValue = (typeof SubscribeErrorCode)[keyof typeof SubscribeErrorCode]

export const SubscribeDoneStatusCode = {
  Unsubscribed: 0x0n,
  InternalError: 0x1n,
  Unauthorized: 0x2n,
  TrackEnded: 0x3n,
  SubscriptionEnded: 0x4n,
  GoingAway: 0x5n,
  Expired: 0x6n,
} as const
export type SubscribeDoneStatusCodeValue =
  (typeof SubscribeDoneStatusCode)[keyof typeof SubscribeDoneStatusCode]

export const TrackStatusCode = {
  InProgress: 0x00n,
  TrackDoesNotExist: 0x01n,
  NotYetBegun: 0x02n,
  Finished: 0x03n,
  RelayStatusUnavailable: 0x04n,
} as const
export type TrackStatusCodeValue = (typeof TrackStatusCode)[keyof typeof TrackStatusCode]
