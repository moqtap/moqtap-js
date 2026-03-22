// Draft identifiers
export type Draft = 'draft-ietf-moq-transport-07' | 'draft-ietf-moq-transport-14';
export type DraftShorthand = '07' | '14';

// All MoQT message type tags
export type MoqtMessageType =
  | 'client_setup'
  | 'server_setup'
  | 'subscribe'
  | 'subscribe_ok'
  | 'subscribe_error'
  | 'subscribe_done'
  | 'subscribe_update'
  | 'unsubscribe'
  | 'announce'
  | 'announce_ok'
  | 'announce_error'
  | 'announce_cancel'
  | 'unannounce'
  | 'track_status_request'
  | 'track_status'
  | 'object_stream'
  | 'object_datagram'
  | 'stream_header_track'
  | 'stream_header_group'
  | 'stream_header_subgroup'
  | 'goaway'
  | 'subscribe_announces'
  | 'subscribe_announces_ok'
  | 'subscribe_announces_error'
  | 'unsubscribe_announces'
  | 'max_subscribe_id'
  | 'fetch'
  | 'fetch_ok'
  | 'fetch_error'
  | 'fetch_cancel';

// Base message interface
export interface BaseMessage {
  readonly type: MoqtMessageType;
}

// Setup messages
export interface ClientSetup extends BaseMessage {
  readonly type: 'client_setup';
  readonly supportedVersions: bigint[];
  readonly parameters: Map<bigint, Uint8Array>;
}

export interface ServerSetup extends BaseMessage {
  readonly type: 'server_setup';
  readonly selectedVersion: bigint;
  readonly parameters: Map<bigint, Uint8Array>;
}

// Subscribe messages
export interface Subscribe extends BaseMessage {
  readonly type: 'subscribe';
  readonly subscribeId: bigint;
  readonly trackAlias: bigint;
  readonly trackNamespace: string[];
  readonly trackName: string;
  readonly subscriberPriority: number;
  readonly groupOrder: GroupOrderValue;
  readonly filterType: FilterType;
  readonly startGroup?: bigint;
  readonly startObject?: bigint;
  readonly endGroup?: bigint;
  readonly endObject?: bigint;
  readonly parameters: Map<bigint, Uint8Array>;
}

export type FilterType = 'latest_group' | 'latest_object' | 'absolute_start' | 'absolute_range';

export interface SubscribeOk extends BaseMessage {
  readonly type: 'subscribe_ok';
  readonly subscribeId: bigint;
  readonly expires: bigint;
  readonly groupOrder: GroupOrderValue;
  readonly contentExists: boolean;
  readonly largestGroupId?: bigint;
  readonly largestObjectId?: bigint;
  readonly parameters: Map<bigint, Uint8Array>;
}

export type GroupOrderValue = 'ascending' | 'descending' | 'original';

export interface SubscribeError extends BaseMessage {
  readonly type: 'subscribe_error';
  readonly subscribeId: bigint;
  readonly errorCode: bigint;
  readonly reasonPhrase: string;
  readonly trackAlias: bigint;
}

export interface SubscribeDone extends BaseMessage {
  readonly type: 'subscribe_done';
  readonly subscribeId: bigint;
  readonly statusCode: bigint;
  readonly reasonPhrase: string;
  readonly contentExists: boolean;
  readonly finalGroupId?: bigint;
  readonly finalObjectId?: bigint;
}

export interface SubscribeUpdate extends BaseMessage {
  readonly type: 'subscribe_update';
  readonly subscribeId: bigint;
  readonly startGroup: bigint;
  readonly startObject: bigint;
  readonly endGroup: bigint;
  readonly endObject: bigint;
  readonly subscriberPriority: number;
  readonly parameters: Map<bigint, Uint8Array>;
}

export interface Unsubscribe extends BaseMessage {
  readonly type: 'unsubscribe';
  readonly subscribeId: bigint;
}

// Announce messages
export interface Announce extends BaseMessage {
  readonly type: 'announce';
  readonly trackNamespace: string[];
  readonly parameters: Map<bigint, Uint8Array>;
}

export interface AnnounceOk extends BaseMessage {
  readonly type: 'announce_ok';
  readonly trackNamespace: string[];
}

export interface AnnounceError extends BaseMessage {
  readonly type: 'announce_error';
  readonly trackNamespace: string[];
  readonly errorCode: bigint;
  readonly reasonPhrase: string;
}

export interface AnnounceCancel extends BaseMessage {
  readonly type: 'announce_cancel';
  readonly trackNamespace: string[];
  readonly errorCode: bigint;
  readonly reasonPhrase: string;
}

export interface Unannounce extends BaseMessage {
  readonly type: 'unannounce';
  readonly trackNamespace: string[];
}

// Track status
export interface TrackStatusRequest extends BaseMessage {
  readonly type: 'track_status_request';
  readonly trackNamespace: string[];
  readonly trackName: string;
}

export interface TrackStatus extends BaseMessage {
  readonly type: 'track_status';
  readonly trackNamespace: string[];
  readonly trackName: string;
  readonly statusCode: bigint;
  readonly lastGroupId: bigint;
  readonly lastObjectId: bigint;
}

// Object/stream messages
export interface ObjectStream extends BaseMessage {
  readonly type: 'object_stream';
  readonly subscribeId: bigint;
  readonly trackAlias: bigint;
  readonly groupId: bigint;
  readonly objectId: bigint;
  readonly publisherPriority: number;
  readonly objectStatus?: number;
  readonly payload: Uint8Array;
}

export interface ObjectDatagram extends BaseMessage {
  readonly type: 'object_datagram';
  readonly subscribeId: bigint;
  readonly trackAlias: bigint;
  readonly groupId: bigint;
  readonly objectId: bigint;
  readonly publisherPriority: number;
  readonly objectStatus?: number;
  readonly payload: Uint8Array;
}

export interface StreamHeaderTrack extends BaseMessage {
  readonly type: 'stream_header_track';
  readonly subscribeId: bigint;
  readonly trackAlias: bigint;
  readonly publisherPriority: number;
}

export interface StreamHeaderGroup extends BaseMessage {
  readonly type: 'stream_header_group';
  readonly subscribeId: bigint;
  readonly trackAlias: bigint;
  readonly groupId: bigint;
  readonly publisherPriority: number;
}

export interface StreamHeaderSubgroup extends BaseMessage {
  readonly type: 'stream_header_subgroup';
  readonly subscribeId: bigint;
  readonly trackAlias: bigint;
  readonly groupId: bigint;
  readonly subgroupId: bigint;
  readonly publisherPriority: number;
}

// GoAway
export interface GoAway extends BaseMessage {
  readonly type: 'goaway';
  readonly newSessionUri: string;
}

// Subscribe Announces
export interface SubscribeAnnounces extends BaseMessage {
  readonly type: 'subscribe_announces';
  readonly trackNamespace: string[];
  readonly parameters: Map<bigint, Uint8Array>;
}

export interface SubscribeAnnouncesOk extends BaseMessage {
  readonly type: 'subscribe_announces_ok';
  readonly trackNamespace: string[];
}

export interface SubscribeAnnouncesError extends BaseMessage {
  readonly type: 'subscribe_announces_error';
  readonly trackNamespace: string[];
  readonly errorCode: bigint;
  readonly reasonPhrase: string;
}

// Unsubscribe Announces
export interface UnsubscribeAnnounces extends BaseMessage {
  readonly type: 'unsubscribe_announces';
  readonly trackNamespace: string[];
}

// Max Subscribe ID
export interface MaxSubscribeId extends BaseMessage {
  readonly type: 'max_subscribe_id';
  readonly subscribeId: bigint;
}

// Fetch
export interface Fetch extends BaseMessage {
  readonly type: 'fetch';
  readonly subscribeId: bigint;
  readonly trackNamespace: string[];
  readonly trackName: string;
  readonly subscriberPriority: number;
  readonly groupOrder: GroupOrderValue;
  readonly startGroup: bigint;
  readonly startObject: bigint;
  readonly endGroup: bigint;
  readonly endObject: bigint;
  readonly parameters: Map<bigint, Uint8Array>;
}

export interface FetchOk extends BaseMessage {
  readonly type: 'fetch_ok';
  readonly subscribeId: bigint;
  readonly groupOrder: GroupOrderValue;
  readonly endOfTrack: boolean;
  readonly largestGroupId: bigint;
  readonly largestObjectId: bigint;
  readonly parameters: Map<bigint, Uint8Array>;
}

export interface FetchError extends BaseMessage {
  readonly type: 'fetch_error';
  readonly subscribeId: bigint;
  readonly errorCode: bigint;
  readonly reasonPhrase: string;
}

export interface FetchCancel extends BaseMessage {
  readonly type: 'fetch_cancel';
  readonly subscribeId: bigint;
}

// Union type of all messages
export type MoqtMessage =
  | ClientSetup
  | ServerSetup
  | Subscribe
  | SubscribeOk
  | SubscribeError
  | SubscribeDone
  | SubscribeUpdate
  | Unsubscribe
  | Announce
  | AnnounceOk
  | AnnounceError
  | AnnounceCancel
  | Unannounce
  | TrackStatusRequest
  | TrackStatus
  | ObjectStream
  | ObjectDatagram
  | StreamHeaderTrack
  | StreamHeaderGroup
  | StreamHeaderSubgroup
  | GoAway
  | SubscribeAnnounces
  | SubscribeAnnouncesOk
  | SubscribeAnnouncesError
  | UnsubscribeAnnounces
  | MaxSubscribeId
  | Fetch
  | FetchOk
  | FetchError
  | FetchCancel;

// Base codec interface — draft-specific codecs extend this
export interface BaseCodec<M = MoqtMessage> {
  readonly draft: Draft;
  encodeMessage(message: M): Uint8Array;
  decodeMessage(bytes: Uint8Array): DecodeResult<M>;
}

// Full codec interface for drafts that support varint + stream decode
export interface Codec extends BaseCodec<MoqtMessage> {
  encodeVarInt(value: number | bigint): Uint8Array;
  decodeVarInt(bytes: Uint8Array, offset?: number): DecodeResult<bigint>;
  createStreamDecoder(): TransformStream<Uint8Array, MoqtMessage>;
}

export interface CodecOptions {
  draft: Draft | DraftShorthand;
}

// Result types
export type DecodeResult<T> =
  | { ok: true; value: T; bytesRead: number }
  | { ok: false; error: DecodeError };

export type DecodeErrorCode =
  | 'UNEXPECTED_END'
  | 'INVALID_VARINT'
  | 'UNKNOWN_MESSAGE_TYPE'
  | 'INVALID_PARAMETER'
  | 'CONSTRAINT_VIOLATION';

export class DecodeError extends Error {
  readonly code: DecodeErrorCode;
  readonly offset: number;

  constructor(code: DecodeErrorCode, message: string, offset: number) {
    super(message);
    this.name = 'DecodeError';
    this.code = code;
    this.offset = offset;
  }
}
