// Draft-23 codec entry point

/**
 * Draft-23's identifier is the protocol string `moqt-23`. draft-23 Section 6.2:
 * "MOQT uses ALPN in QUIC and "WT-Available-Protocols" in WebTransport
 * ([WebTransport], Section 3.3) to perform version negotiation. [...] ALPNs
 * used to identify IETF drafts are created by appending the draft number to
 * "moqt-"."
 */
export const PROTOCOL_STRING = 'moqt-23'

/**
 * The `0xff000000 + N` key for draft 23.
 *
 * **A derived identifier, not a wire value.** No draft-23 peer sends it: the
 * version is negotiated by ALPN / `WT-Available-Protocols`. It exists so code
 * that indexes drafts by number ({@link DRAFT_VERSIONS} in the package root,
 * trace formats) has a stable key. Report {@link PROTOCOL_STRING} to users.
 */
export const DRAFT_VERSION = 0xff000017n

export type { AuthRedaction } from '../../core/auth-redaction.js'
export { REDACTION_FILL } from '../../core/auth-redaction.js'
export type { FetchGroupOrder } from '../../core/group-order.js'
export type { ObjectProperty, ObjectPropertyInit } from '../../core/object-properties.js'
export type { ControlMessageOptions, Draft23Codec } from './codec.js'
export {
  createDataStreamDecoder,
  createDraft23Codec,
  createFetchStreamDecoder,
  createStreamDecoder,
  createSubgroupStreamDecoder,
  decodeDatagram,
  decodeDataStream,
  decodeFetchStream,
  decodeMessage,
  decodeObjectProperties,
  decodeSubgroupStream,
  encodeDatagram,
  encodeFetchStream,
  encodeMessage,
  encodeObjectProperties,
  encodeSubgroupStream,
  malformedTrackPropertiesReason,
  malformedTrackReason,
  redactAuthTokens,
  UNKNOWN_STREAM_COUNT,
} from './codec.js'
export type {
  DataStreamResetCodeValue,
  ErrorDetailTypeValue,
  PublishDoneCodeValue,
  RequestErrorCodeValue,
  SessionTerminationCodeValue,
} from './error-codes.js'
export {
  DataStreamResetCode,
  ErrorDetailType,
  PublishDoneCode,
  RETIRED_DATA_STREAM_RESET_CODES,
  RETIRED_PUBLISH_DONE_CODES,
  RETIRED_REQUEST_ERROR_CODES,
  RETIRED_SESSION_TERMINATION_CODES,
  RequestErrorCode,
  SessionTerminationCode,
  sessionTerminationCategory,
} from './error-codes.js'

export {
  DEFAULT_MAX_CONTROL_MESSAGE_SIZE,
  ERROR_DETAIL_REDIRECT,
  ERROR_DETAIL_UNSUPPORTED_PROPERTY,
  MESSAGE_ID_MAP,
  MESSAGE_TYPE_MAP,
  MSG_FETCH,
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
  SETUP_OPT_MAX_CONTROL_MESSAGE_SIZE,
  SETUP_OPT_MAX_FILTER_RANGES,
  SETUP_OPT_MAX_REQUEST_UPDATES,
  SETUP_OPT_MOQT_IMPLEMENTATION,
  SETUP_OPT_PATH,
} from './messages.js'

export type { RequestOkKind, RequestUpdateTarget, RuleViolation } from './rules.js'
export {
  BIDIRECTIONAL_MESSAGES,
  CLIENT_ONLY_MESSAGES,
  CONTROL_MESSAGES,
  checkRequestOk,
  checkRequestUpdate,
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
export { createDraft23SessionState, Draft23SessionFSM } from './session.js'

export type {
  DatagramObject,
  DataStreamEvent,
  DataStreamHeader,
  Draft23BaseMessage,
  Draft23DataStream,
  Draft23ErrorDetails,
  Draft23Fetch,
  Draft23FillParameters,
  Draft23GoAway,
  Draft23Message,
  Draft23MessageType,
  Draft23Namespace,
  Draft23NamespaceDone,
  Draft23Params,
  Draft23Publish,
  Draft23PublishDone,
  Draft23PublishNamespace,
  Draft23PublishSkipped,
  Draft23PublishStateNotify,
  Draft23RequestError,
  Draft23RequestOk,
  Draft23RequestUpdate,
  Draft23Setup,
  Draft23SetupOptions,
  Draft23Subscribe,
  Draft23SubscribeNamespace,
  Draft23SubscribeOk,
  Draft23SubscribeTracks,
  Draft23TrackProperties,
  Draft23TrackStatus,
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
