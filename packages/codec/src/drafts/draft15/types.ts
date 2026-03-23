// Draft-15 specific message types
// Field names use snake_case to match test vector JSON

// Unknown parameter for passthrough
export interface UnknownParam {
  readonly id: string; // e.g. "0x21"
  readonly length: number;
  readonly raw_hex: string; // e.g. "deadbeef"
}

// Setup parameters (constant namespace across versions)
export interface Draft15SetupParams {
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
export interface Draft15Params {
  expires?: bigint; // 0x08 even
  largest_object?: LargestObject; // 0x09 odd (length-prefixed)
  subscriber_priority?: bigint; // 0x20 even
  subscription_filter?: SubscriptionFilter; // 0x21 odd (length-prefixed)
  group_order?: bigint; // 0x22 even
  unknown?: UnknownParam[];
}

// Draft-15 message type tag union
export type Draft15MessageType =
  | "client_setup"
  | "server_setup"
  | "subscribe"
  | "subscribe_ok"
  | "subscribe_update"
  | "unsubscribe"
  | "publish"
  | "publish_ok"
  | "publish_done"
  | "publish_namespace"
  | "publish_namespace_done"
  | "publish_namespace_cancel"
  | "subscribe_namespace"
  | "unsubscribe_namespace"
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
export interface Draft15BaseMessage {
  readonly type: Draft15MessageType;
}

// Setup — ALPN handles version negotiation, no versions in messages
export interface Draft15ClientSetup extends Draft15BaseMessage {
  readonly type: "client_setup";
  readonly parameters: Draft15SetupParams;
}

export interface Draft15ServerSetup extends Draft15BaseMessage {
  readonly type: "server_setup";
  readonly parameters: Draft15SetupParams;
}

// Subscribe — fields moved to parameters
export interface Draft15Subscribe extends Draft15BaseMessage {
  readonly type: "subscribe";
  readonly request_id: bigint;
  readonly track_namespace: string[];
  readonly track_name: string;
  readonly parameters: Draft15Params;
}

export interface Draft15SubscribeOk extends Draft15BaseMessage {
  readonly type: "subscribe_ok";
  readonly request_id: bigint;
  readonly track_alias: bigint;
  readonly parameters: Draft15Params;
}

export interface Draft15SubscribeUpdate extends Draft15BaseMessage {
  readonly type: "subscribe_update";
  readonly request_id: bigint;
  readonly subscription_request_id: bigint;
  readonly parameters: Draft15Params;
}

export interface Draft15Unsubscribe extends Draft15BaseMessage {
  readonly type: "unsubscribe";
  readonly request_id: bigint;
}

// Publish
export interface Draft15Publish extends Draft15BaseMessage {
  readonly type: "publish";
  readonly request_id: bigint;
  readonly track_namespace: string[];
  readonly track_name: string;
  readonly track_alias: bigint;
  readonly parameters: Draft15Params;
}

export interface Draft15PublishOk extends Draft15BaseMessage {
  readonly type: "publish_ok";
  readonly request_id: bigint;
  readonly parameters: Draft15Params;
}

export interface Draft15PublishDone extends Draft15BaseMessage {
  readonly type: "publish_done";
  readonly request_id: bigint;
  readonly status_code: bigint;
  readonly stream_count: bigint;
  readonly reason_phrase: string;
}

// Namespace
export interface Draft15PublishNamespace extends Draft15BaseMessage {
  readonly type: "publish_namespace";
  readonly request_id: bigint;
  readonly track_namespace: string[];
  readonly parameters: Draft15Params;
}

export interface Draft15PublishNamespaceDone extends Draft15BaseMessage {
  readonly type: "publish_namespace_done";
  readonly track_namespace: string[];
}

export interface Draft15PublishNamespaceCancel extends Draft15BaseMessage {
  readonly type: "publish_namespace_cancel";
  readonly track_namespace: string[];
  readonly error_code: bigint;
  readonly reason_phrase: string;
}

export interface Draft15SubscribeNamespace extends Draft15BaseMessage {
  readonly type: "subscribe_namespace";
  readonly request_id: bigint;
  readonly namespace_prefix: string[];
  readonly parameters: Draft15Params;
}

export interface Draft15UnsubscribeNamespace extends Draft15BaseMessage {
  readonly type: "unsubscribe_namespace";
  readonly request_id: bigint;
}

// Fetch — restructured with fetch type variants
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

export interface Draft15Fetch extends Draft15BaseMessage {
  readonly type: "fetch";
  readonly request_id: bigint;
  readonly fetch_type: bigint;
  readonly standalone?: StandaloneFetch;
  readonly joining?: JoiningFetch;
  readonly parameters: Draft15Params;
}

export interface Draft15FetchOk extends Draft15BaseMessage {
  readonly type: "fetch_ok";
  readonly request_id: bigint;
  readonly end_of_track: number; // uint8
  readonly end_group: bigint;
  readonly end_object: bigint;
  readonly parameters: Draft15Params;
}

export interface Draft15FetchCancel extends Draft15BaseMessage {
  readonly type: "fetch_cancel";
  readonly request_id: bigint;
}

// Track Status — same format as Subscribe
export interface Draft15TrackStatus extends Draft15BaseMessage {
  readonly type: "track_status";
  readonly request_id: bigint;
  readonly track_namespace: string[];
  readonly track_name: string;
  readonly parameters: Draft15Params;
}

// Consolidated response messages
export interface Draft15RequestOk extends Draft15BaseMessage {
  readonly type: "request_ok";
  readonly request_id: bigint;
  readonly parameters: Draft15Params;
}

export interface Draft15RequestError extends Draft15BaseMessage {
  readonly type: "request_error";
  readonly request_id: bigint;
  readonly error_code: bigint;
  readonly reason_phrase: string;
}

// Session Control
export interface Draft15GoAway extends Draft15BaseMessage {
  readonly type: "goaway";
  readonly new_session_uri: string;
}

export interface Draft15MaxRequestId extends Draft15BaseMessage {
  readonly type: "max_request_id";
  readonly max_request_id: bigint;
}

export interface Draft15RequestsBlocked extends Draft15BaseMessage {
  readonly type: "requests_blocked";
  readonly maximum_request_id: bigint;
}

// Union of all draft-15 control messages
export type Draft15Message =
  | Draft15ClientSetup
  | Draft15ServerSetup
  | Draft15Subscribe
  | Draft15SubscribeOk
  | Draft15SubscribeUpdate
  | Draft15Unsubscribe
  | Draft15Publish
  | Draft15PublishOk
  | Draft15PublishDone
  | Draft15PublishNamespace
  | Draft15PublishNamespaceDone
  | Draft15PublishNamespaceCancel
  | Draft15SubscribeNamespace
  | Draft15UnsubscribeNamespace
  | Draft15Fetch
  | Draft15FetchOk
  | Draft15FetchCancel
  | Draft15TrackStatus
  | Draft15RequestOk
  | Draft15RequestError
  | Draft15GoAway
  | Draft15MaxRequestId
  | Draft15RequestsBlocked;

// Data stream types (same shape as draft-14 for now)
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

export type Draft15DataStream = SubgroupStream | DatagramObject | FetchStream;

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
