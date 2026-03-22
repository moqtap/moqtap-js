export { encodeVarInt, decodeVarInt } from './varint.js';
export { createDraft07Codec } from './codec.js';
export { encodeParameters, decodeParameters } from './parameters.js';
export { MESSAGE_TYPE_IDS, MESSAGE_ID_TO_TYPE } from './messages.js';
export {
  CONTROL_MESSAGES,
  DATA_MESSAGES,
  CLIENT_ONLY_MESSAGES,
  SERVER_ONLY_MESSAGES,
  getLegalOutgoing,
  getLegalIncoming,
} from './rules.js';

// Re-export types consumers need
export type {
  MoqtMessage,
  DecodeResult,
  DecodeErrorCode,
  ClientSetup,
  ServerSetup,
  Subscribe,
  SubscribeOk,
  SubscribeError,
  SubscribeDone,
  Unsubscribe,
  Announce,
  AnnounceOk,
  AnnounceError,
  AnnounceCancel,
  Unannounce,
  TrackStatusRequest,
  TrackStatus,
  ObjectStream,
  ObjectDatagram,
  StreamHeaderTrack,
  StreamHeaderGroup,
  StreamHeaderSubgroup,
  GoAway,
  SubscribeAnnounces,
  SubscribeAnnouncesOk,
  SubscribeAnnouncesError,
  Fetch,
  FetchOk,
  FetchError,
  FetchCancel,
  SubscribeUpdate,
  UnsubscribeAnnounces,
  MaxSubscribeId,
  FilterType,
  GroupOrderValue,
  MoqtMessageType,
} from '../../core/types.js';
export { DecodeError } from '../../core/types.js';

import { createDraft07Codec } from './codec.js';
import type { DecodeResult, MoqtMessage } from '../../core/types.js';

const defaultCodec = createDraft07Codec();

export function encodeMessage(message: MoqtMessage): Uint8Array {
  return defaultCodec.encodeMessage(message);
}

export function decodeMessage(bytes: Uint8Array): DecodeResult<MoqtMessage> {
  return defaultCodec.decodeMessage(bytes);
}

export function createStreamDecoder(): TransformStream<Uint8Array, MoqtMessage> {
  return defaultCodec.createStreamDecoder();
}
