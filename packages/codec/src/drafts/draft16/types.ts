// Draft-16 specific message types
// Field names use snake_case to match test vector JSON

// Unknown parameter for passthrough
export interface UnknownParam {
  readonly id: string; // e.g. "0x21"
  readonly length: number;
  readonly raw_hex: string; // e.g. "deadbeef"
}

// Setup parameters (constant namespace across versions)
export interface Draft16SetupParams {
  path?: string; // 0x01 odd
  max_request_id?: bigint; // 0x02 even
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

// Version-specific parameters (well-known + unknown)
export interface Draft16Params {
  expires?: bigint; // 0x08 even
  largest_object?: LargestObject; // 0x09 odd (length-prefixed)
  subscriber_priority?: bigint; // 0x20 even
  subscription_filter?: SubscriptionFilter; // 0x21 odd (length-prefixed)
  group_order?: bigint; // 0x22 even
  unknown?: UnknownParam[];
}

// Draft-16 message type tag union
export type Draft16MessageType =
  | "client_setup"
  | "server_setup"
  | "subscribe"
  | "subscribe_ok"
  | "request_update"
  | "unsubscribe"
  | "publish"
  | "publish_ok"
  | "publish_done"
  | "publish_namespace"
  | "publish_namespace_done"
  | "publish_namespace_cancel"
  | "subscribe_namespace"
  | "namespace"
  | "namespace_done"
  | "fetch"
  | "fetch_ok"
  | "fetch_cancel"
  | "track_status"
  | "request_ok"
  | "request_error"
  | "goaway"
  | "max_request_id"
  | "requests_blocked";

// Base
export interface Draft16BaseMessage {
  readonly type: Draft16MessageType;
}

// Setup — ALPN handles version negotiation, no versions in messages
export interface Draft16ClientSetup extends Draft16BaseMessage {
  readonly type: "client_setup";
  readonly parameters: Draft16SetupParams;
}

export interface Draft16ServerSetup extends Draft16BaseMessage {
  readonly type: "server_setup";
  readonly parameters: Draft16SetupParams;
}

// Subscribe — fields moved to parameters
export interface Draft16Subscribe extends Draft16BaseMessage {
  readonly type: "subscribe";
  readonly request_id: bigint;
  readonly track_namespace: string[];
  readonly track_name: string;
  readonly parameters: Draft16Params;
}

export interface Draft16SubscribeOk extends Draft16BaseMessage {
  readonly type: "subscribe_ok";
  readonly request_id: bigint;
  readonly track_alias: bigint;
  readonly parameters: Draft16Params;
}

// Renamed from subscribe_update in draft-15
export interface Draft16RequestUpdate extends Draft16BaseMessage {
  readonly type: "request_update";
  readonly request_id: bigint;
  readonly existing_request_id: bigint;
  readonly parameters: Draft16Params;
}

export interface Draft16Unsubscribe extends Draft16BaseMessage {
  readonly type: "unsubscribe";
  readonly request_id: bigint;
}

// Publish
export interface Draft16Publish extends Draft16BaseMessage {
  readonly type: "publish";
  readonly request_id: bigint;
  readonly track_namespace: string[];
  readonly track_name: string;
  readonly track_alias: bigint;
  readonly parameters: Draft16Params;
}

export interface Draft16PublishOk extends Draft16BaseMessage {
  readonly type: "publish_ok";
  readonly request_id: bigint;
  readonly parameters: Draft16Params;
}

export interface Draft16PublishDone extends Draft16BaseMessage {
  readonly type: "publish_done";
  readonly request_id: bigint;
  readonly status_code: bigint;
  readonly stream_count: bigint;
  readonly reason_phrase: string;
}

// Namespace
export interface Draft16PublishNamespace extends Draft16BaseMessage {
  readonly type: "publish_namespace";
  readonly request_id: bigint;
  readonly track_namespace: string[];
  readonly parameters: Draft16Params;
}

// Simplified in draft-16: just request_id
export interface Draft16PublishNamespaceDone extends Draft16BaseMessage {
  readonly type: "publish_namespace_done";
  readonly request_id: bigint;
}

// Changed in draft-16: request_id + error_code + reason_phrase
export interface Draft16PublishNamespaceCancel extends Draft16BaseMessage {
  readonly type: "publish_namespace_cancel";
  readonly request_id: bigint;
  readonly error_code: bigint;
  readonly reason_phrase: string;
}

// subscribe_namespace gains subscribe_options in draft-16
export interface Draft16SubscribeNamespace extends Draft16BaseMessage {
  readonly type: "subscribe_namespace";
  readonly request_id: bigint;
  readonly namespace_prefix: string[];
  readonly subscribe_options: bigint;
  readonly parameters: Draft16Params;
}

// New in draft-16: NAMESPACE message
export interface Draft16Namespace extends Draft16BaseMessage {
  readonly type: "namespace";
  readonly namespace_suffix: string[];
}

// New in draft-16: NAMESPACE_DONE message
export interface Draft16NamespaceDone extends Draft16BaseMessage {
  readonly type: "namespace_done";
  readonly namespace_suffix: string[];
}

// unsubscribe_namespace is REMOVED in draft-16

// Fetch — same structure as draft-15
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

export interface Draft16Fetch extends Draft16BaseMessage {
  readonly type: "fetch";
  readonly request_id: bigint;
  readonly fetch_type: bigint;
  readonly standalone?: StandaloneFetch;
  readonly joining?: JoiningFetch;
  readonly parameters: Draft16Params;
}

export interface Draft16FetchOk extends Draft16BaseMessage {
  readonly type: "fetch_ok";
  readonly request_id: bigint;
  readonly end_of_track: number; // uint8
  readonly end_group: bigint;
  readonly end_object: bigint;
  readonly parameters: Draft16Params;
}

export interface Draft16FetchCancel extends Draft16BaseMessage {
  readonly type: "fetch_cancel";
  readonly request_id: bigint;
}

// Track Status
export interface Draft16TrackStatus extends Draft16BaseMessage {
  readonly type: "track_status";
  readonly request_id: bigint;
  readonly track_namespace: string[];
  readonly track_name: string;
  readonly parameters: Draft16Params;
}

// Consolidated response messages
export interface Draft16RequestOk extends Draft16BaseMessage {
  readonly type: "request_ok";
  readonly request_id: bigint;
  readonly parameters: Draft16Params;
}

// request_error gains retry_interval in draft-16
export interface Draft16RequestError extends Draft16BaseMessage {
  readonly type: "request_error";
  readonly request_id: bigint;
  readonly error_code: bigint;
  readonly retry_interval: bigint;
  readonly reason_phrase: string;
}

// Session Control
export interface Draft16GoAway extends Draft16BaseMessage {
  readonly type: "goaway";
  readonly new_session_uri: string;
}

export interface Draft16MaxRequestId extends Draft16BaseMessage {
  readonly type: "max_request_id";
  readonly max_request_id: bigint;
}

export interface Draft16RequestsBlocked extends Draft16BaseMessage {
  readonly type: "requests_blocked";
  readonly maximum_request_id: bigint;
}

// Union of all draft-16 control messages
export type Draft16Message =
  | Draft16ClientSetup
  | Draft16ServerSetup
  | Draft16Subscribe
  | Draft16SubscribeOk
  | Draft16RequestUpdate
  | Draft16Unsubscribe
  | Draft16Publish
  | Draft16PublishOk
  | Draft16PublishDone
  | Draft16PublishNamespace
  | Draft16PublishNamespaceDone
  | Draft16PublishNamespaceCancel
  | Draft16SubscribeNamespace
  | Draft16Namespace
  | Draft16NamespaceDone
  | Draft16Fetch
  | Draft16FetchOk
  | Draft16FetchCancel
  | Draft16TrackStatus
  | Draft16RequestOk
  | Draft16RequestError
  | Draft16GoAway
  | Draft16MaxRequestId
  | Draft16RequestsBlocked;

// Data stream types (same as draft-15)
export interface ObjectPayload {
  readonly type: "object";
  readonly objectId: bigint;
  readonly payloadLength: number;
  readonly status?: bigint;
  readonly payload: Uint8Array;
}

export interface SubgroupStream {
  readonly type: "subgroup";
  readonly headerType: number; // stream type byte (0x10-0x1D or 0x30-0x3D)
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

export type Draft16DataStream = SubgroupStream | DatagramObject | FetchStream;

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
