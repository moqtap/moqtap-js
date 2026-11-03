// Draft-23 error, status and Error Detail registries.
//
// draft-23 Section 13: "Receipt of an unknown error code in any error context
// (Session Termination, REQUEST_ERROR, PUBLISH_DONE, or Data Stream Reset) MUST
// be treated as equivalent to INTERNAL_ERROR for that context. An endpoint MUST
// NOT close the session because it received an unknown error code in a
// REQUEST_ERROR or PUBLISH_DONE." None of the tables below is a decode gate.
//
// Session termination codes reach 0x401, so they are bigints like every other
// code here, never bytes.

import { isGrease } from './messages.js'

/** draft-23 Section 16.12.1, Table 20 (definitions in Section 12.2). */
export const SessionTerminationCode = {
  NoError: 0x0n,
  InternalError: 0x1n,
  Unauthorized: 0x2n,
  ProtocolViolation: 0x3n,
  InvalidRequestId: 0x4n,
  DuplicateTrackAlias: 0x5n,
  MalformedKeyValue: 0x6n,
  InvalidPath: 0x8n,
  MalformedPath: 0x9n,
  GoawayTimeout: 0x10n,
  ControlMessageTimeout: 0x11n,
  DataStreamTimeout: 0x12n,
  AuthTokenCacheOverflow: 0x13n,
  DuplicateAuthTokenAlias: 0x14n,
  MalformedAuthToken: 0x16n,
  UnknownAuthTokenAlias: 0x17n,
  ExpiredAuthToken: 0x18n,
  InvalidAuthority: 0x19n,
  MalformedAuthority: 0x1an,
  TooManyRequestUpdates: 0x1bn,
  InvalidStreamHeader: 0x200n,
  MalformedObject: 0x201n,
  InvalidObjectStatus: 0x202n,
  TruncatedObject: 0x203n,
  MalformedMessage: 0x300n,
  InvalidField: 0x301n,
  InvalidTrackNamespace: 0x302n,
  UnexpectedMessage: 0x303n,
  RoleViolation: 0x304n,
  InvalidParameter: 0x305n,
  ClosedControlStream: 0x306n,
  DeltaEncodingOverflow: 0x400n,
  FieldLengthExceeded: 0x401n,
} as const
export type SessionTerminationCodeValue =
  (typeof SessionTerminationCode)[keyof typeof SessionTerminationCode]

/** draft-23 Section 16.12.2, Table 21 (definitions in Section 12.3). */
export const RequestErrorCode = {
  InternalError: 0x0n,
  Unauthorized: 0x1n,
  Timeout: 0x2n,
  NotSupported: 0x3n,
  MalformedAuthToken: 0x4n,
  ExpiredAuthToken: 0x5n,
  GoingAway: 0x6n,
  ExcessiveLoad: 0x9n,
  Unavailable: 0xan,
  DoesNotExist: 0x10n,
  InvalidRange: 0x11n,
  MalformedTrack: 0x12n,
  Uninterested: 0x20n,
  NamespaceTooLarge: 0x31n,
  UnsupportedExtension: 0x33n,
  Redirect: 0x34n,
  ConflictingFilters: 0x35n,
  InvalidFilter: 0x36n,
} as const
export type RequestErrorCodeValue = (typeof RequestErrorCode)[keyof typeof RequestErrorCode]

/** draft-23 Section 16.12.3, Table 22 (definitions in Section 12.4). */
export const PublishDoneCode = {
  InternalError: 0x0n,
  Unauthorized: 0x1n,
  TrackEnded: 0x2n,
  GoingAway: 0x4n,
  TooFarBehind: 0x5n,
  Expired: 0x6n,
  ExpiredAuthToken: 0x7n,
  UpdateFailed: 0x8n,
  ExcessiveLoad: 0x9n,
  MalformedTrack: 0x12n,
} as const
export type PublishDoneCodeValue = (typeof PublishDoneCode)[keyof typeof PublishDoneCode]

/** draft-23 Section 16.12.4, Table 23 (definitions in Section 12.5). */
export const DataStreamResetCode = {
  InternalError: 0x0n,
  Cancelled: 0x1n,
  DeliveryTimeout: 0x2n,
  SessionClosed: 0x3n,
  GoingAway: 0x4n,
  TooFarBehind: 0x5n,
  ExpiredAuthToken: 0x7n,
  ExcessiveLoad: 0x9n,
  MalformedTrack: 0x12n,
} as const
export type DataStreamResetCodeValue =
  (typeof DataStreamResetCode)[keyof typeof DataStreamResetCode]

/** draft-23 Section 16.11, Table 19 (definitions in Section 9.4.2). */
export const ErrorDetailType = {
  Redirect: 0x01n,
  UnsupportedProperty: 0x02n,
} as const
export type ErrorDetailTypeValue = (typeof ErrorDetailType)[keyof typeof ErrorDetailType]

/**
 * The category a session termination code's range gives it, draft-23 Section
 * 12.2: "Codes from 0x200 to 0x4FF are organized into ranges by category:",
 * "0x200-0x2FF: Data stream and datagram errors", "0x300-0x3FF: Control stream
 * and control message errors", "0x400-0x4FF: Errors that can occur in either",
 * and "The values reserved for greasing (Section 13) that fall within these
 * ranges are not assigned to a category."
 *
 * Undefined outside the ranges and for a grease value. An unknown code inside
 * a range is still equivalent to INTERNAL_ERROR (Section 13); the category
 * only says what kind of error it reports.
 */
export function sessionTerminationCategory(
  code: bigint,
): 'data' | 'control' | 'either' | undefined {
  if (isGrease(code)) return undefined
  if (code >= 0x200n && code <= 0x2ffn) return 'data'
  if (code >= 0x300n && code <= 0x3ffn) return 'control'
  if (code >= 0x400n && code <= 0x4ffn) return 'either'
  return undefined
}

/*
 * Codes an earlier draft assigned and draft-23 does not. Draft-23 keeps no
 * RESERVED row for them, so each is an unknown code under the Section 13 rule
 * above. The sets are advisory: nothing in the decode path consults them.
 */
export const RETIRED_SESSION_TERMINATION_CODES: ReadonlySet<bigint> = new Set([
  0x15n, // VERSION_NEGOTIATION_FAILED, last assigned in draft-19
])

export const RETIRED_REQUEST_ERROR_CODES: ReadonlySet<bigint> = new Set([
  0x30n, // PREFIX_OVERLAP, last assigned in draft-22
  0x32n, // INVALID_JOINING_REQUEST_ID, last assigned in draft-19
])

export const RETIRED_PUBLISH_DONE_CODES: ReadonlySet<bigint> = new Set([
  0x3n, // SUBSCRIPTION_ENDED, last assigned in draft-19
])

export const RETIRED_DATA_STREAM_RESET_CODES: ReadonlySet<bigint> = new Set([
  0x6n, // UNKNOWN_OBJECT_STATUS, last assigned in draft-22
])
