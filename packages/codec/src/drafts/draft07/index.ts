export const DRAFT_VERSION = 0xff000007n

export type { DecodeErrorCode, DecodeResult } from '../../core/types.js'
// Re-export types consumers need
export { DecodeError } from '../../core/types.js'
export type { Draft07Codec } from './codec.js'
export {
  createDraft07Codec,
  decodeDatagram,
  decodeFetchStream,
  decodeSubgroupStream,
  encodeDatagram,
  encodeFetchStream,
  encodeSubgroupStream,
} from './codec.js'
export {
  MESSAGE_ID_MAP,
  MESSAGE_TYPE_MAP,
  MSG_ANNOUNCE,
  MSG_ANNOUNCE_CANCEL,
  MSG_ANNOUNCE_ERROR,
  MSG_ANNOUNCE_OK,
  MSG_CLIENT_SETUP,
  MSG_FETCH,
  MSG_FETCH_CANCEL,
  MSG_FETCH_ERROR,
  MSG_FETCH_HEADER,
  MSG_FETCH_OK,
  MSG_GOAWAY,
  MSG_MAX_SUBSCRIBE_ID,
  MSG_OBJECT_DATAGRAM,
  MSG_SERVER_SETUP,
  MSG_STREAM_HEADER_SUBGROUP,
  MSG_SUBSCRIBE,
  MSG_SUBSCRIBE_ANNOUNCES,
  MSG_SUBSCRIBE_ANNOUNCES_ERROR,
  MSG_SUBSCRIBE_ANNOUNCES_OK,
  MSG_SUBSCRIBE_DONE,
  MSG_SUBSCRIBE_ERROR,
  MSG_SUBSCRIBE_OK,
  MSG_SUBSCRIBE_UPDATE,
  MSG_TRACK_STATUS,
  MSG_TRACK_STATUS_REQUEST,
  MSG_UNANNOUNCE,
  MSG_UNSUBSCRIBE,
  MSG_UNSUBSCRIBE_ANNOUNCES,
  PARAM_AUTHORIZATION_INFO,
  PARAM_DELIVERY_TIMEOUT,
  PARAM_MAX_CACHE_DURATION,
  SETUP_PARAM_MAX_SUBSCRIBE_ID,
  SETUP_PARAM_PATH,
  SETUP_PARAM_ROLE,
} from './messages.js'
export {
  CLIENT_ONLY_MESSAGES,
  CONTROL_MESSAGES,
  DATA_MESSAGES,
  getLegalIncoming,
  getLegalOutgoing,
  SERVER_ONLY_MESSAGES,
} from './rules.js'
export type {
  Announce,
  AnnounceCancel,
  AnnounceError,
  AnnounceOk,
  ClientSetup,
  DatagramObject as Draft07DatagramObject,
  DataStreamEvent,
  DataStreamHeader,
  Draft07DataStream,
  Draft07Message,
  Draft07MessageType,
  Draft07Params,
  Draft07SetupParams,
  Fetch,
  FetchCancel,
  FetchError,
  FetchObjectPayload,
  FetchOk,
  FetchStream,
  FetchStreamHeader,
  GoAway,
  MaxSubscribeId,
  ObjectDatagram,
  ObjectPayload,
  ServerSetup,
  StreamHeaderSubgroup,
  SubgroupStream,
  SubgroupStreamHeader,
  Subscribe,
  SubscribeAnnounces,
  SubscribeAnnouncesError,
  SubscribeAnnouncesOk,
  SubscribeDone,
  SubscribeError,
  SubscribeOk,
  SubscribeUpdate,
  TrackStatus,
  TrackStatusRequest,
  Unannounce,
  UnknownParam,
  Unsubscribe,
  UnsubscribeAnnounces,
} from './types.js'
export { decodeVarInt, encodeVarInt } from './varint.js'

import type { DecodeResult } from '../../core/types.js'
import { createDraft07Codec } from './codec.js'
import type { Draft07Message } from './types.js'

const defaultCodec = createDraft07Codec()

export function encodeMessage(message: Draft07Message): Uint8Array {
  return defaultCodec.encodeMessage(message)
}

export function decodeMessage(bytes: Uint8Array): DecodeResult<Draft07Message> {
  return defaultCodec.decodeMessage(bytes)
}

export function createStreamDecoder(): TransformStream<Uint8Array, Draft07Message> {
  return defaultCodec.createStreamDecoder()
}
