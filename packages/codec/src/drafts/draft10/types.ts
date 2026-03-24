// Draft-09 specific message types
// Field names use snake_case to match test vector JSON

// Unknown parameter for passthrough
export interface UnknownParam {
  readonly id: string; // e.g. "0x21"
  readonly length: number;
  readonly raw_hex: string;
}

// Setup parameters (PATH, MAX_SUBSCRIBE_ID)
export interface Draft10SetupParams {
  path?: string; // 0x01
  max_subscribe_id?: bigint; // 0x02
  unknown?: UnknownParam[];
}

// Version-specific parameters
export interface Draft10Params {
  authorization_info?: string; // 0x02
  delivery_timeout?: bigint; // 0x03
  max_cache_duration?: bigint; // 0x04
  unknown?: UnknownParam[];
}

// Draft-09 message type tag union
export type Draft10MessageType =
  | "client_setup"
  | "server_setup"
  | "subscribe"
  | "subscribe_ok"
  | "subscribe_error"
  | "subscribe_update"
  | "subscribe_done"
  | "unsubscribe"
  | "announce"
  | "announce_ok"
  | "announce_error"
  | "unannounce"
  | "announce_cancel"
  | "subscribe_announces"
  | "subscribe_announces_ok"
  | "subscribe_announces_error"
  | "unsubscribe_announces"
  | "fetch"
  | "fetch_ok"
  | "fetch_error"
  | "fetch_cancel"
  | "track_status_request"
  | "track_status"
  | "goaway"
  | "max_subscribe_id"
  | "subscribes_blocked";

// Base
export interface Draft10BaseMessage {
  readonly type: Draft10MessageType;
}

// Setup
export interface Draft10ClientSetup extends Draft10BaseMessage {
  readonly type: "client_setup";
  readonly supported_versions: bigint[];
  readonly parameters: Draft10SetupParams;
}

export interface Draft10ServerSetup extends Draft10BaseMessage {
  readonly type: "server_setup";
  readonly selected_version: bigint;
  readonly parameters: Draft10SetupParams;
}

// Subscribe
export interface Draft10Subscribe extends Draft10BaseMessage {
  readonly type: "subscribe";
  readonly subscribe_id: bigint;
  readonly track_alias: bigint;
  readonly track_namespace: string[];
  readonly track_name: string;
  readonly subscriber_priority: number; // uint8
  readonly group_order: number; // uint8
  readonly filter_type: bigint;
  readonly start_group?: bigint;
  readonly start_object?: bigint;
  readonly end_group?: bigint;
  readonly parameters: Draft10Params;
}

export interface Draft10SubscribeOk extends Draft10BaseMessage {
  readonly type: "subscribe_ok";
  readonly subscribe_id: bigint;
  readonly expires: bigint;
  readonly group_order: number; // uint8
  readonly content_exists: number; // uint8
  readonly largest_group_id?: bigint;
  readonly largest_object_id?: bigint;
  readonly parameters: Draft10Params;
}

export interface Draft10SubscribeError extends Draft10BaseMessage {
  readonly type: "subscribe_error";
  readonly subscribe_id: bigint;
  readonly error_code: bigint;
  readonly reason_phrase: string;
  readonly track_alias: bigint;
}

export interface Draft10SubscribeDone extends Draft10BaseMessage {
  readonly type: "subscribe_done";
  readonly subscribe_id: bigint;
  readonly status_code: bigint;
  readonly stream_count: bigint;
  readonly reason_phrase: string;
}

export interface Draft10SubscribeUpdate extends Draft10BaseMessage {
  readonly type: "subscribe_update";
  readonly subscribe_id: bigint;
  readonly start_group: bigint;
  readonly start_object: bigint;
  readonly end_group: bigint;
  readonly subscriber_priority: number; // uint8
  readonly parameters: Draft10Params;
}

export interface Draft10Unsubscribe extends Draft10BaseMessage {
  readonly type: "unsubscribe";
  readonly subscribe_id: bigint;
}

// Announce
export interface Draft10Announce extends Draft10BaseMessage {
  readonly type: "announce";
  readonly track_namespace: string[];
  readonly parameters: Draft10Params;
}

export interface Draft10AnnounceOk extends Draft10BaseMessage {
  readonly type: "announce_ok";
  readonly track_namespace: string[];
}

export interface Draft10AnnounceError extends Draft10BaseMessage {
  readonly type: "announce_error";
  readonly track_namespace: string[];
  readonly error_code: bigint;
  readonly reason_phrase: string;
}

export interface Draft10Unannounce extends Draft10BaseMessage {
  readonly type: "unannounce";
  readonly track_namespace: string[];
}

export interface Draft10AnnounceCancel extends Draft10BaseMessage {
  readonly type: "announce_cancel";
  readonly track_namespace: string[];
  readonly error_code: bigint;
  readonly reason_phrase: string;
}

// Subscribe Announces
export interface Draft10SubscribeAnnounces extends Draft10BaseMessage {
  readonly type: "subscribe_announces";
  readonly track_namespace_prefix: string[];
  readonly parameters: Draft10Params;
}

export interface Draft10SubscribeAnnouncesOk extends Draft10BaseMessage {
  readonly type: "subscribe_announces_ok";
  readonly track_namespace_prefix: string[];
}

export interface Draft10SubscribeAnnouncesError extends Draft10BaseMessage {
  readonly type: "subscribe_announces_error";
  readonly track_namespace_prefix: string[];
  readonly error_code: bigint;
  readonly reason_phrase: string;
}

export interface Draft10UnsubscribeAnnounces extends Draft10BaseMessage {
  readonly type: "unsubscribe_announces";
  readonly track_namespace_prefix: string[];
}

// Fetch
export interface StandaloneFetch {
  readonly track_namespace: string[];
  readonly track_name: string;
  readonly start_group: bigint;
  readonly start_object: bigint;
  readonly end_group: bigint;
  readonly end_object: bigint;
}

export interface JoiningFetch {
  readonly joining_subscribe_id: bigint;
  readonly preceding_group_offset: bigint;
}

export interface Draft10Fetch extends Draft10BaseMessage {
  readonly type: "fetch";
  readonly subscribe_id: bigint;
  readonly subscriber_priority: number; // uint8
  readonly group_order: number; // uint8
  readonly fetch_type: bigint;
  readonly standalone?: StandaloneFetch;
  readonly joining?: JoiningFetch;
  readonly parameters: Draft10Params;
}

export interface Draft10FetchOk extends Draft10BaseMessage {
  readonly type: "fetch_ok";
  readonly subscribe_id: bigint;
  readonly group_order: number; // uint8
  readonly end_of_track: number; // uint8
  readonly largest_group_id: bigint;
  readonly largest_object_id: bigint;
  readonly parameters: Draft10Params;
}

export interface Draft10FetchError extends Draft10BaseMessage {
  readonly type: "fetch_error";
  readonly subscribe_id: bigint;
  readonly error_code: bigint;
  readonly reason_phrase: string;
}

export interface Draft10FetchCancel extends Draft10BaseMessage {
  readonly type: "fetch_cancel";
  readonly subscribe_id: bigint;
}

// Track Status
export interface Draft10TrackStatusRequest extends Draft10BaseMessage {
  readonly type: "track_status_request";
  readonly track_namespace: string[];
  readonly track_name: string;
}

export interface Draft10TrackStatus extends Draft10BaseMessage {
  readonly type: "track_status";
  readonly track_namespace: string[];
  readonly track_name: string;
  readonly status_code: bigint;
  readonly last_group_id: bigint;
  readonly last_object_id: bigint;
}

// Session Control
export interface Draft10GoAway extends Draft10BaseMessage {
  readonly type: "goaway";
  readonly new_session_uri: string;
}

export interface Draft10MaxSubscribeId extends Draft10BaseMessage {
  readonly type: "max_subscribe_id";
  readonly subscribe_id: bigint;
}

export interface Draft10SubscribesBlocked extends Draft10BaseMessage {
  readonly type: "subscribes_blocked";
  readonly maximum_subscribe_id: bigint;
}

// Union of all draft-10 control messages
export type Draft10Message =
  | Draft10ClientSetup
  | Draft10ServerSetup
  | Draft10Subscribe
  | Draft10SubscribeOk
  | Draft10SubscribeError
  | Draft10SubscribeUpdate
  | Draft10SubscribeDone
  | Draft10Unsubscribe
  | Draft10Announce
  | Draft10AnnounceOk
  | Draft10AnnounceError
  | Draft10Unannounce
  | Draft10AnnounceCancel
  | Draft10SubscribeAnnounces
  | Draft10SubscribeAnnouncesOk
  | Draft10SubscribeAnnouncesError
  | Draft10UnsubscribeAnnounces
  | Draft10Fetch
  | Draft10FetchOk
  | Draft10FetchError
  | Draft10FetchCancel
  | Draft10TrackStatusRequest
  | Draft10TrackStatus
  | Draft10GoAway
  | Draft10MaxSubscribeId
  | Draft10SubscribesBlocked;

// Data stream types
export interface ObjectPayload {
  readonly type: "object";
  readonly byteOffset: number;
  readonly payloadByteOffset: number;
  readonly objectId: bigint;
  readonly extensionHeadersLength: bigint;
  readonly extensionData: Uint8Array;
  readonly payloadLength: number;
  readonly status?: bigint;
  readonly payload: Uint8Array;
}

export interface SubgroupStream {
  readonly type: "subgroup";
  readonly streamTypeId: 0x04;
  readonly trackAlias: bigint;
  readonly groupId: bigint;
  readonly subgroupId: bigint;
  readonly publisherPriority: number;
  readonly objects: ObjectPayload[];
}

export interface DatagramObject {
  readonly type: "datagram";
  readonly streamTypeId: 0x01;
  readonly trackAlias: bigint;
  readonly groupId: bigint;
  readonly objectId: bigint;
  readonly publisherPriority: number;
  readonly extensionHeadersLength: bigint;
  readonly extensionData: Uint8Array;
  readonly payload: Uint8Array;
}

export interface DatagramStatusObject {
  readonly type: "datagram_status";
  readonly streamTypeId: 0x02;
  readonly trackAlias: bigint;
  readonly groupId: bigint;
  readonly objectId: bigint;
  readonly publisherPriority: number;
  readonly extensionHeadersLength: bigint;
  readonly extensionData: Uint8Array;
  readonly objectStatus: bigint;
}

export interface FetchObjectPayload {
  readonly type: "object";
  readonly byteOffset: number;
  readonly payloadByteOffset: number;
  readonly groupId: bigint;
  readonly subgroupId: bigint;
  readonly objectId: bigint;
  readonly publisherPriority: number;
  readonly extensionHeadersLength: bigint;
  readonly extensionData: Uint8Array;
  readonly payloadLength: number;
  readonly status?: bigint;
  readonly payload: Uint8Array;
}

export interface FetchStream {
  readonly type: "fetch";
  readonly subscribeId: bigint;
  readonly objects: FetchObjectPayload[];
}

export type Draft10DataStream =
  | SubgroupStream
  | DatagramObject
  | DatagramStatusObject
  | FetchStream;

// Streaming data stream decoder types
export interface SubgroupStreamHeader {
  readonly type: "subgroup_header";
  readonly trackAlias: bigint;
  readonly groupId: bigint;
  readonly subgroupId: bigint;
  readonly publisherPriority: number;
}

export interface FetchStreamHeader {
  readonly type: "fetch_header";
  readonly subscribeId: bigint;
}

export type DataStreamHeader = SubgroupStreamHeader | FetchStreamHeader;
export type DataStreamEvent = DataStreamHeader | ObjectPayload;
