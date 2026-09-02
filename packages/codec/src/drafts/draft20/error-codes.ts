// Draft-20 error and status code registries.
//
// Three codes were removed relative to draft-19 and none was added or
// renumbered. Each removal leaves an unassigned hole at the old codepoint,
// so the constants below are gone and the value is listed in the matching
// RETIRED_* set.
//
// The draft DOES say what a receiver does with an unassigned code, in
// Section 14: treat it as INTERNAL_ERROR for its context, and MUST NOT close
// the session over it in a REQUEST_ERROR or PUBLISH_DONE. So none of the sets
// below is a decode gate -- see the note above them.

/** draft-20 Section 15.11.1, Table 18 (prose Section 3.5). */
export const SessionTerminationCode = {
  NoError: 0x0n,
  InternalError: 0x1n,
  Unauthorized: 0x2n,
  ProtocolViolation: 0x3n,
  InvalidRequestId: 0x4n,
  DuplicateTrackAlias: 0x5n,
  KeyValueFormattingError: 0x6n,
  InvalidPath: 0x8n,
  MalformedPath: 0x9n,
  GoawayTimeout: 0x10n,
  ControlMessageTimeout: 0x11n,
  DataStreamTimeout: 0x12n,
  AuthTokenCacheOverflow: 0x13n,
  DuplicateAuthTokenAlias: 0x14n,
  // 0x15 VERSION_NEGOTIATION_FAILED — REMOVED in draft-20. Version negotiation
  // moved to ALPN / WT-Available-Protocols in draft-15, so there is no longer a
  // SETUP-time negotiation that can fail. See RETIRED_SESSION_TERMINATION_CODES.
  MalformedAuthToken: 0x16n,
  UnknownAuthTokenAlias: 0x17n,
  ExpiredAuthToken: 0x18n,
  InvalidAuthority: 0x19n,
  MalformedAuthority: 0x1an,
  TooManyRequestUpdates: 0x1bn,
} as const
export type SessionTerminationCodeValue =
  (typeof SessionTerminationCode)[keyof typeof SessionTerminationCode]

/** draft-20 Section 15.11.2, Table 19 (prose Section 10.6.2). */
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
  Uninterested: 0x20n,
  PrefixOverlap: 0x30n,
  NamespaceTooLarge: 0x31n,
  // 0x32 INVALID_JOINING_REQUEST_ID — REMOVED in draft-20 along with the whole
  // joining-fetch mechanism (draft-19 Section 10.12.2). A draft-20 FETCH names
  // its own track inline and never references another request, so there is no
  // joining Request ID left to be invalid. See RETIRED_REQUEST_ERROR_CODES.
  UnsupportedExtension: 0x33n,
  Redirect: 0x34n,
  ConflictingFilters: 0x35n,
  InvalidFilter: 0x36n,
} as const
export type RequestErrorCodeValue = (typeof RequestErrorCode)[keyof typeof RequestErrorCode]

/** draft-20 Section 15.11.3, Table 20 (prose Section 10.12). */
export const PublishDoneCode = {
  InternalError: 0x0n,
  Unauthorized: 0x1n,
  TrackEnded: 0x2n,
  // 0x3 SUBSCRIPTION_ENDED — REMOVED in draft-20. The behaviour went with it:
  // Section 5.1.2 now says "A publisher does not end a subscription solely
  // because the Largest Object advances past the end of the current Location
  // Filter", which is the only thing this code used to report.
  // See RETIRED_PUBLISH_DONE_CODES.
  GoingAway: 0x4n,
  TooFarBehind: 0x5n,
  Expired: 0x6n,
  UpdateFailed: 0x8n,
  ExcessiveLoad: 0x9n,
  MalformedTrack: 0x12n,
} as const
export type PublishDoneCodeValue = (typeof PublishDoneCode)[keyof typeof PublishDoneCode]

/** draft-20 Section 15.11.4, Table 21 (prose Section 3.3.4) — unchanged from draft-19. */
export const DataStreamResetCode = {
  InternalError: 0x0n,
  Cancelled: 0x1n,
  DeliveryTimeout: 0x2n,
  SessionClosed: 0x3n,
  GoingAway: 0x4n,
  TooFarBehind: 0x5n,
  UnknownObjectStatus: 0x6n,
  ExpiredAuthToken: 0x7n,
  ExcessiveLoad: 0x9n,
  MalformedTrack: 0x12n,
} as const
export type DataStreamResetCodeValue =
  (typeof DataStreamResetCode)[keyof typeof DataStreamResetCode]

/*
 * Retired codepoints.
 *
 * draft-20 states no rule for what a receiver does with a code that is not in
 * a registry, so the decoder does not police the registries in general: an
 * unrecognised-but-unassigned code may well be a codepoint a later draft
 * assigns, and refusing it would make this codec useless as an observer of a
 * newer peer.
 *
 * A code draft-19 assigned and draft-20 deleted is not refused either. It is
 * tempting to: such a code is not merely "unknown to us" but known to be wrong
 * for this version, and seeing one suggests the peer is speaking an older draft
 * on a connection that negotiated moqt-20. But Section 14's "MUST NOT close the
 * session because it received an unknown error code in a REQUEST_ERROR or
 * PUBLISH_DONE" draws no distinction between a code that was never assigned and
 * one that used to be, and the same paragraph is in draft-19 verbatim.
 *
 * So the sets below are advisory. They name what a caller may want to surface
 * — "this peer looks like draft-19" is a genuinely useful diagnostic — and
 * nothing in the decode path consults them.
 */
export const RETIRED_SESSION_TERMINATION_CODES: ReadonlySet<bigint> = new Set([
  0x15n, // VERSION_NEGOTIATION_FAILED (draft-19 Section 3.5)
])

export const RETIRED_REQUEST_ERROR_CODES: ReadonlySet<bigint> = new Set([
  0x32n, // INVALID_JOINING_REQUEST_ID (draft-19 Section 10.6.2)
])

export const RETIRED_PUBLISH_DONE_CODES: ReadonlySet<bigint> = new Set([
  0x3n, // SUBSCRIPTION_ENDED (draft-19 Section 10.11)
])
