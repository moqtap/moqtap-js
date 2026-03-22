// Re-export types consumers need
export type {
  Announce,
  AnnounceCancel,
  AnnounceError,
  AnnounceOk,
  ClientSetup,
  DecodeErrorCode,
  DecodeResult,
  Fetch,
  FetchCancel,
  FetchError,
  FetchOk,
  FilterType,
  GoAway,
  GroupOrderValue,
  MaxSubscribeId,
  MoqtMessage,
  MoqtMessageType,
  ObjectDatagram,
  ObjectStream,
  ServerSetup,
  StreamHeaderGroup,
  StreamHeaderSubgroup,
  StreamHeaderTrack,
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
  Unsubscribe,
  UnsubscribeAnnounces,
} from "../../core/types.js";
export { DecodeError } from "../../core/types.js";
export { createDraft07Codec } from "./codec.js";
export { MESSAGE_ID_TO_TYPE, MESSAGE_TYPE_IDS } from "./messages.js";
export { decodeParameters, encodeParameters } from "./parameters.js";
export {
  CLIENT_ONLY_MESSAGES,
  CONTROL_MESSAGES,
  DATA_MESSAGES,
  getLegalIncoming,
  getLegalOutgoing,
  SERVER_ONLY_MESSAGES,
} from "./rules.js";
export { decodeVarInt, encodeVarInt } from "./varint.js";

import type { DecodeResult, MoqtMessage } from "../../core/types.js";
import { createDraft07Codec } from "./codec.js";

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
