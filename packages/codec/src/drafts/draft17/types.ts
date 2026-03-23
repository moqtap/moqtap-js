// Draft-17 specific message types

// Unknown parameter for passthrough
export interface UnknownParam {
  readonly id: string; // e.g. "0x21"
  readonly length: number;
  readonly raw_hex: string;
}

// Setup options (KVP encoding, no count prefix)
export interface Draft17SetupOptions {
  path?: string; // 0x01 odd
  max_auth_token_cache_size?: bigint; // 0x04 even
  authority?: string; // 0x05 odd
  moqt_implementation?: string; // 0x07 odd
  unknown?: UnknownParam[];
}

// Subscription filter parameter
export interface SubscriptionFilter {
  readonly filter_type: bigint;
  readonly start_group?: bigint;
  readonly start_object?: bigint;
  readonly end_group?: bigint;
}

// Largest object location parameter
export interface LargestObject {
  readonly group: bigint;
  readonly object: bigint;
}

// Version-specific parameters (delta-encoded types, count-prefixed)
export interface Draft17Params {
  expires?: bigint; // 0x08 varint
  largest_object?: LargestObject; // 0x09 Location (2 bare varints)
  subscriber_priority?: bigint; // 0x20 uint8
  subscription_filter?: SubscriptionFilter; // 0x21 length-prefixed
  group_order?: bigint; // 0x22 uint8
  unknown?: UnknownParam[];
}

// Track properties (KVP encoding, no count prefix, read until end of payload)
export interface Draft17TrackProperties {
  unknown?: UnknownParam[];
}

// Draft-17 message type tag union
export type Draft17MessageType =
  | "setup"
  | "subscribe"
  | "subscribe_ok"
  | "request_update"
  | "publish"
  | "publish_ok"
  | "publish_done"
  | "publish_namespace"
  | "namespace"
  | "namespace_done"
  | "subscribe_namespace"
  | "publish_blocked"
  | "fetch"
  | "fetch_ok"
  | "track_status"
  | "request_ok"
  | "request_error"
  | "goaway";

// Base
export interface Draft17BaseMessage {
  readonly type: Draft17MessageType;
}

// Setup — single unified message (0x2F00)
export interface Draft17Setup extends Draft17BaseMessage {
  readonly type: "setup";
  readonly options: Draft17SetupOptions;
}

// Subscribe — fields moved to parameters, added required_request_id_delta
export interface Draft17Subscribe extends Draft17BaseMessage {
  readonly type: "subscribe";
  readonly request_id: bigint;
  readonly required_request_id_delta: bigint;
  readonly track_namespace: string[];
  readonly track_name: string;
  readonly parameters: Draft17Params;
}

export interface Draft17SubscribeOk extends Draft17BaseMessage {
  readonly type: "subscribe_ok";
  readonly track_alias: bigint;
  readonly parameters: Draft17Params;
  readonly track_properties: Draft17TrackProperties;
}

export interface Draft17RequestUpdate extends Draft17BaseMessage {
  readonly type: "request_update";
  readonly request_id: bigint;
  readonly required_request_id_delta: bigint;
  readonly parameters: Draft17Params;
}

// Publish
export interface Draft17Publish extends Draft17BaseMessage {
  readonly type: "publish";
  readonly request_id: bigint;
  readonly required_request_id_delta: bigint;
  readonly track_namespace: string[];
  readonly track_name: string;
  readonly track_alias: bigint;
  readonly parameters: Draft17Params;
  readonly track_properties: Draft17TrackProperties;
}

export interface Draft17PublishOk extends Draft17BaseMessage {
  readonly type: "publish_ok";
  readonly parameters: Draft17Params;
}

export interface Draft17PublishDone extends Draft17BaseMessage {
  readonly type: "publish_done";
  readonly status_code: bigint;
  readonly stream_count: bigint;
  readonly reason_phrase: string;
}

// Namespace
export interface Draft17PublishNamespace extends Draft17BaseMessage {
  readonly type: "publish_namespace";
  readonly request_id: bigint;
  readonly required_request_id_delta: bigint;
  readonly track_namespace: string[];
  readonly parameters: Draft17Params;
}

export interface Draft17Namespace extends Draft17BaseMessage {
  readonly type: "namespace";
  readonly namespace_suffix: string[];
}

export interface Draft17NamespaceDone extends Draft17BaseMessage {
  readonly type: "namespace_done";
  readonly namespace_suffix: string[];
}

export interface Draft17SubscribeNamespace extends Draft17BaseMessage {
  readonly type: "subscribe_namespace";
  readonly request_id: bigint;
  readonly required_request_id_delta: bigint;
  readonly namespace_prefix: string[];
  readonly subscribe_options: bigint;
  readonly parameters: Draft17Params;
}

// New in draft-17: PUBLISH_BLOCKED
export interface Draft17PublishBlocked extends Draft17BaseMessage {
  readonly type: "publish_blocked";
  readonly namespace_suffix: string[];
  readonly track_name: string;
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
  readonly joining_request_id: bigint;
  readonly joining_start: bigint;
}

export interface Draft17Fetch extends Draft17BaseMessage {
  readonly type: "fetch";
  readonly request_id: bigint;
  readonly required_request_id_delta: bigint;
  readonly fetch_type: bigint;
  readonly standalone?: StandaloneFetch;
  readonly joining?: JoiningFetch;
  readonly parameters: Draft17Params;
}

export interface Draft17FetchOk extends Draft17BaseMessage {
  readonly type: "fetch_ok";
  readonly end_of_track: number; // uint8
  readonly end_group: bigint;
  readonly end_object: bigint;
  readonly parameters: Draft17Params;
  readonly track_properties: Draft17TrackProperties;
}

// Track Status — same format as subscribe in draft-17
export interface Draft17TrackStatus extends Draft17BaseMessage {
  readonly type: "track_status";
  readonly request_id: bigint;
  readonly required_request_id_delta: bigint;
  readonly track_namespace: string[];
  readonly track_name: string;
  readonly parameters: Draft17Params;
}

// Consolidated response messages — no request_id in draft-17
export interface Draft17RequestOk extends Draft17BaseMessage {
  readonly type: "request_ok";
  readonly parameters: Draft17Params;
}

export interface Draft17RequestError extends Draft17BaseMessage {
  readonly type: "request_error";
  readonly error_code: bigint;
  readonly retry_interval: bigint;
  readonly reason_phrase: string;
}

// Session Control
export interface Draft17GoAway extends Draft17BaseMessage {
  readonly type: "goaway";
  readonly new_session_uri: string;
  readonly timeout: bigint;
}

// Union of all draft-17 control messages
export type Draft17Message =
  | Draft17Setup
  | Draft17Subscribe
  | Draft17SubscribeOk
  | Draft17RequestUpdate
  | Draft17Publish
  | Draft17PublishOk
  | Draft17PublishDone
  | Draft17PublishNamespace
  | Draft17Namespace
  | Draft17NamespaceDone
  | Draft17SubscribeNamespace
  | Draft17PublishBlocked
  | Draft17Fetch
  | Draft17FetchOk
  | Draft17TrackStatus
  | Draft17RequestOk
  | Draft17RequestError
  | Draft17GoAway;

// Data stream types (same as draft-16)
export interface ObjectPayload {
  readonly type: "object";
  readonly objectId: bigint;
  readonly payloadLength: number;
  readonly status?: bigint;
  readonly payload: Uint8Array;
}

export interface SubgroupStream {
  readonly type: "subgroup";
  readonly headerType: number;
  readonly trackAlias: bigint;
  readonly groupId: bigint;
  readonly subgroupId: bigint;
  readonly publisherPriority: number;
  readonly objects: ObjectPayload[];
}

export interface DatagramObject {
  readonly type: "datagram";
  readonly datagramType: number;
  readonly trackAlias: bigint;
  readonly groupId: bigint;
  readonly objectId: bigint;
  readonly publisherPriority: number;
  readonly endOfGroup?: boolean;
  readonly objectStatus?: bigint;
  readonly payloadLength: number;
  readonly payload: Uint8Array;
}

export interface FetchObjectPayload extends ObjectPayload {
  readonly serializationFlags: number;
  readonly groupId: bigint;
  readonly subgroupId: bigint;
  readonly publisherPriority: number;
}

export interface FetchStream {
  readonly type: "fetch";
  readonly requestId: bigint;
  readonly objects: FetchObjectPayload[];
}

export type Draft17DataStream = SubgroupStream | DatagramObject | FetchStream;

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
  readonly requestId: bigint;
}

export type DataStreamHeader = SubgroupStreamHeader | FetchStreamHeader;
export type DataStreamEvent = DataStreamHeader | ObjectPayload;
