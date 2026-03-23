// Draft-08 specific message types
// Field names use snake_case to match test vector JSON

// Unknown parameter for passthrough
export interface UnknownParam {
  readonly id: string; // e.g. "0x21"
  readonly length: number;
  readonly raw_hex: string;
}

// Setup parameters (PATH, MAX_SUBSCRIBE_ID)
export interface Draft08SetupParams {
  path?: string; // 0x01
  max_subscribe_id?: bigint; // 0x02
  unknown?: UnknownParam[];
}

// Version-specific parameters
export interface Draft08Params {
  authorization_info?: string; // 0x02
  delivery_timeout?: bigint; // 0x03
  max_cache_duration?: bigint; // 0x04
  unknown?: UnknownParam[];
}

// Draft-08 message type tag union
export type Draft08MessageType =
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
export interface Draft08BaseMessage {
  readonly type: Draft08MessageType;
}

// Setup
export interface Draft08ClientSetup extends Draft08BaseMessage {
  readonly type: "client_setup";
  readonly supported_versions: bigint[];
  readonly parameters: Draft08SetupParams;
}

export interface Draft08ServerSetup extends Draft08BaseMessage {
  readonly type: "server_setup";
  readonly selected_version: bigint;
  readonly parameters: Draft08SetupParams;
}

// Subscribe
export interface Draft08Subscribe extends Draft08BaseMessage {
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
  readonly parameters: Draft08Params;
}

export interface Draft08SubscribeOk extends Draft08BaseMessage {
  readonly type: "subscribe_ok";
  readonly subscribe_id: bigint;
  readonly expires: bigint;
  readonly group_order: number; // uint8
  readonly content_exists: number; // uint8
  readonly largest_group_id?: bigint;
  readonly largest_object_id?: bigint;
  readonly parameters: Draft08Params;
}

export interface Draft08SubscribeError extends Draft08BaseMessage {
  readonly type: "subscribe_error";
  readonly subscribe_id: bigint;
  readonly error_code: bigint;
  readonly reason_phrase: string;
  readonly track_alias: bigint;
}

export interface Draft08SubscribeDone extends Draft08BaseMessage {
  readonly type: "subscribe_done";
  readonly subscribe_id: bigint;
  readonly status_code: bigint;
  readonly stream_count: bigint;
  readonly reason_phrase: string;
}

export interface Draft08SubscribeUpdate extends Draft08BaseMessage {
  readonly type: "subscribe_update";
  readonly subscribe_id: bigint;
  readonly start_group: bigint;
  readonly start_object: bigint;
  readonly end_group: bigint;
  readonly subscriber_priority: number; // uint8
  readonly parameters: Draft08Params;
}

export interface Draft08Unsubscribe extends Draft08BaseMessage {
  readonly type: "unsubscribe";
  readonly subscribe_id: bigint;
}

// Announce
export interface Draft08Announce extends Draft08BaseMessage {
  readonly type: "announce";
  readonly track_namespace: string[];
  readonly parameters: Draft08Params;
}

export interface Draft08AnnounceOk extends Draft08BaseMessage {
  readonly type: "announce_ok";
  readonly track_namespace: string[];
}

export interface Draft08AnnounceError extends Draft08BaseMessage {
  readonly type: "announce_error";
  readonly track_namespace: string[];
  readonly error_code: bigint;
  readonly reason_phrase: string;
}

export interface Draft08Unannounce extends Draft08BaseMessage {
  readonly type: "unannounce";
  readonly track_namespace: string[];
}

export interface Draft08AnnounceCancel extends Draft08BaseMessage {
  readonly type: "announce_cancel";
  readonly track_namespace: string[];
  readonly error_code: bigint;
  readonly reason_phrase: string;
}

// Subscribe Announces
export interface Draft08SubscribeAnnounces extends Draft08BaseMessage {
  readonly type: "subscribe_announces";
  readonly track_namespace_prefix: string[];
  readonly parameters: Draft08Params;
}

export interface Draft08SubscribeAnnouncesOk extends Draft08BaseMessage {
  readonly type: "subscribe_announces_ok";
  readonly track_namespace_prefix: string[];
}

export interface Draft08SubscribeAnnouncesError extends Draft08BaseMessage {
  readonly type: "subscribe_announces_error";
  readonly track_namespace_prefix: string[];
  readonly error_code: bigint;
  readonly reason_phrase: string;
}

export interface Draft08UnsubscribeAnnounces extends Draft08BaseMessage {
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

export interface Draft08Fetch extends Draft08BaseMessage {
  readonly type: "fetch";
  readonly subscribe_id: bigint;
  readonly subscriber_priority: number; // uint8
  readonly group_order: number; // uint8
  readonly fetch_type: bigint;
  readonly standalone?: StandaloneFetch;
  readonly joining?: JoiningFetch;
  readonly parameters: Draft08Params;
}

export interface Draft08FetchOk extends Draft08BaseMessage {
  readonly type: "fetch_ok";
  readonly subscribe_id: bigint;
  readonly group_order: number; // uint8
  readonly end_of_track: number; // uint8
  readonly largest_group_id: bigint;
  readonly largest_object_id: bigint;
  readonly parameters: Draft08Params;
}

export interface Draft08FetchError extends Draft08BaseMessage {
  readonly type: "fetch_error";
  readonly subscribe_id: bigint;
  readonly error_code: bigint;
  readonly reason_phrase: string;
}

export interface Draft08FetchCancel extends Draft08BaseMessage {
  readonly type: "fetch_cancel";
  readonly subscribe_id: bigint;
}

// Track Status
export interface Draft08TrackStatusRequest extends Draft08BaseMessage {
  readonly type: "track_status_request";
  readonly track_namespace: string[];
  readonly track_name: string;
}

export interface Draft08TrackStatus extends Draft08BaseMessage {
  readonly type: "track_status";
  readonly track_namespace: string[];
  readonly track_name: string;
  readonly status_code: bigint;
  readonly last_group_id: bigint;
  readonly last_object_id: bigint;
}

// Session Control
export interface Draft08GoAway extends Draft08BaseMessage {
  readonly type: "goaway";
  readonly new_session_uri: string;
}

export interface Draft08MaxSubscribeId extends Draft08BaseMessage {
  readonly type: "max_subscribe_id";
  readonly subscribe_id: bigint;
}

export interface Draft08SubscribesBlocked extends Draft08BaseMessage {
  readonly type: "subscribes_blocked";
  readonly maximum_subscribe_id: bigint;
}

// Union of all draft-08 control messages
export type Draft08Message =
  | Draft08ClientSetup
  | Draft08ServerSetup
  | Draft08Subscribe
  | Draft08SubscribeOk
  | Draft08SubscribeError
  | Draft08SubscribeUpdate
  | Draft08SubscribeDone
  | Draft08Unsubscribe
  | Draft08Announce
  | Draft08AnnounceOk
  | Draft08AnnounceError
  | Draft08Unannounce
  | Draft08AnnounceCancel
  | Draft08SubscribeAnnounces
  | Draft08SubscribeAnnouncesOk
  | Draft08SubscribeAnnouncesError
  | Draft08UnsubscribeAnnounces
  | Draft08Fetch
  | Draft08FetchOk
  | Draft08FetchError
  | Draft08FetchCancel
  | Draft08TrackStatusRequest
  | Draft08TrackStatus
  | Draft08GoAway
  | Draft08MaxSubscribeId
  | Draft08SubscribesBlocked;

// Data stream types
export interface ObjectPayload {
  readonly type: "object";
  readonly objectId: bigint;
  readonly extensionCount: bigint;
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
  readonly extensionCount: bigint;
  readonly objectStatus: bigint;
  readonly payloadLength: number;
  readonly payload: Uint8Array;
}

export interface DatagramStatusObject {
  readonly type: "datagram_status";
  readonly streamTypeId: 0x02;
  readonly trackAlias: bigint;
  readonly groupId: bigint;
  readonly objectId: bigint;
  readonly publisherPriority: number;
  readonly objectStatus: bigint;
}

export interface FetchObjectPayload {
  readonly type: "object";
  readonly groupId: bigint;
  readonly subgroupId: bigint;
  readonly objectId: bigint;
  readonly publisherPriority: number;
  readonly extensionCount: bigint;
  readonly payloadLength: number;
  readonly payload: Uint8Array;
}

export interface FetchStream {
  readonly type: "fetch";
  readonly subscribeId: bigint;
  readonly objects: FetchObjectPayload[];
}

export type Draft08DataStream =
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
