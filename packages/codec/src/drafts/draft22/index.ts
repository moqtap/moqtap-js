// Draft-22 codec entry point
//
// Draft-22 differs from draft-21 on the wire in one parameter. LOCATION_FILTER
// (0x21) carries no length: it begins with a Location Filter Type, which
// decides how many fields follow (Section 9.20.9, Table 6). {0, 0} under type
// 0x02 is an absolute start, and the Next Object is type 0x05. Every other
// message, data stream, code point and registry matches draft-21's.

/**
 * Draft-22's real identifier is the protocol string `moqt-22`.
 *
 * draft-22 Section 6.2: "MOQT uses ALPN in QUIC and 'WT-Available-Protocols' in
 * WebTransport ([WebTransport], Section 3.3) to perform version negotiation.
 * […] ALPNs used to identify IETF drafts are created by appending the draft
 * number to 'moqt-'. […] Note: Draft versions prior to -15 all used moq-00
 * ALPN, followed by version negotiation in the SETUP messages."
 *
 * So this is what a draft-22 peer actually negotiates with, and it is the only
 * identifier that appears anywhere in a draft-22 session.
 */
export const PROTOCOL_STRING = 'moqt-22'

/**
 * The `0xff000000 + N` identifier for draft 22.
 *
 * **This is a derived identifier, not an observed wire value.** No draft-22
 * peer ever sends it. The `0xff0000NN` scheme belonged to the SETUP-time
 * version negotiation that drafts before -15 used; from draft-15 on the version
 * is negotiated by ALPN / `WT-Available-Protocols` and no version number
 * appears on the wire at all. It is kept only so that code indexing drafts by a
 * numeric key — {@link DRAFT_VERSIONS} in the package root, trace formats,
 * anything that predates the change — has a stable key for draft-22.
 *
 * Anything that reports a version to a user should report
 * {@link PROTOCOL_STRING} instead, and should not claim to have observed this
 * number.
 */
export const DRAFT_VERSION = 0xff000016n

export type { AuthRedaction } from '../../core/auth-redaction.js'
export { REDACTION_FILL } from '../../core/auth-redaction.js'
export type { Draft22Codec } from './codec.js'
export {
  createDataStreamDecoder,
  createDraft22Codec,
  createFetchStreamDecoder,
  createStreamDecoder,
  createSubgroupStreamDecoder,
  decodeDatagram,
  decodeDataStream,
  decodeFetchStream,
  decodeMessage,
  decodeSubgroupStream,
  encodeDatagram,
  encodeFetchStream,
  encodeMessage,
  encodeSubgroupStream,
  redactAuthTokens,
  UNKNOWN_STREAM_COUNT,
} from './codec.js'
export type {
  DataStreamResetCodeValue,
  PublishDoneCodeValue,
  RequestErrorCodeValue,
  SessionTerminationCodeValue,
} from './error-codes.js'
export {
  DataStreamResetCode,
  PublishDoneCode,
  RETIRED_PUBLISH_DONE_CODES,
  RETIRED_REQUEST_ERROR_CODES,
  RETIRED_SESSION_TERMINATION_CODES,
  RequestErrorCode,
  SessionTerminationCode,
} from './error-codes.js'

export {
  MESSAGE_ID_MAP,
  MESSAGE_TYPE_MAP,
  MSG_FETCH,
  MSG_FETCH_OK,
  MSG_GOAWAY,
  MSG_NAMESPACE,
  MSG_NAMESPACE_DONE,
  MSG_PUBLISH,
  MSG_PUBLISH_DONE,
  MSG_PUBLISH_NAMESPACE,
  MSG_PUBLISH_OK,
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

export {
  BIDIRECTIONAL_MESSAGES,
  CLIENT_ONLY_MESSAGES,
  CONTROL_MESSAGES,
  getLegalIncoming,
  getLegalOutgoing,
  REQUEST_STREAM_OPENERS,
  SERVER_ONLY_MESSAGES,
} from './rules.js'
export type {
  FillFetchStreamPhase,
  FillFetchStreamState,
  ProtocolViolation,
  PublisherSide,
  RequestKind,
  SessionPhase,
  SideEffect,
  TransitionResult,
  ValidationResult,
} from './session.js'
export { createDraft22SessionState, Draft22SessionFSM } from './session.js'

export type {
  DatagramObject,
  DataStreamEvent,
  DataStreamHeader,
  Draft22BaseMessage,
  Draft22DataStream,
  Draft22Fetch,
  Draft22FetchOk,
  Draft22FillParameters,
  Draft22GoAway,
  Draft22Message,
  Draft22MessageType,
  Draft22Namespace,
  Draft22NamespaceDone,
  Draft22Params,
  Draft22Publish,
  Draft22PublishDone,
  Draft22PublishNamespace,
  Draft22PublishSkipped,
  Draft22PublishStateNotify,
  Draft22RequestError,
  Draft22RequestOk,
  Draft22RequestUpdate,
  Draft22Setup,
  Draft22SetupOptions,
  Draft22Subscribe,
  Draft22SubscribeNamespace,
  Draft22SubscribeOk,
  Draft22SubscribeTracks,
  Draft22TrackProperties,
  Draft22TrackStatus,
  FetchObjectPayload,
  FetchStream,
  FetchStreamHeader,
  LargestObject,
  LocationFilter,
  ObjectPayload,
  RangeFilter,
  RangeFilterRange,
  Redirect,
  SubgroupStream,
  SubgroupStreamHeader,
  UnknownParam,
} from './types.js'
