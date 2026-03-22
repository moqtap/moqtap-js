// Draft-14 specific message types
// Field names use snake_case to match test vector JSON

// Parameter types for draft-14
export interface UnknownParam {
  readonly id: string; // e.g. "0x21"
  readonly length: number;
  readonly raw_hex: string; // e.g. "deadbeef"
}

export interface Draft14Params {
  role?: bigint;
  path?: string;
  max_request_id?: bigint;
  unknown?: UnknownParam[];
}

// Draft-14 message type tag union
export type Draft14MessageType =
  | "client_setup"
  | "server_setup"
  | "subscribe"
  | "subscribe_ok"
  | "subscribe_update"
  | "subscribe_error"
  | "unsubscribe"
  | "publish"
  | "publish_ok"
  | "publish_error"
  | "publish_done"
  | "publish_namespace"
  | "publish_namespace_ok"
  | "publish_namespace_error"
  | "publish_namespace_done"
  | "publish_namespace_cancel"
  | "subscribe_namespace"
  | "subscribe_namespace_ok"
  | "subscribe_namespace_error"
  | "unsubscribe_namespace"
  | "fetch"
  | "fetch_ok"
  | "fetch_error"
  | "fetch_cancel"
  | "track_status"
  | "track_status_ok"
  | "track_status_error"
  | "goaway"
  | "max_request_id"
  | "requests_blocked";

// Base
export interface Draft14BaseMessage {
  readonly type: Draft14MessageType;
}

// Setup
export interface Draft14ClientSetup extends Draft14BaseMessage {
  readonly type: "client_setup";
  readonly supported_versions: bigint[];
  readonly parameters: Draft14Params;
}

export interface Draft14ServerSetup extends Draft14BaseMessage {
  readonly type: "server_setup";
  readonly selected_version: bigint;
  readonly parameters: Draft14Params;
}

// Subscribe
export interface Draft14Subscribe extends Draft14BaseMessage {
  readonly type: "subscribe";
  readonly request_id: bigint;
  readonly track_namespace: string[];
  readonly track_name: string;
  readonly subscriber_priority: bigint;
  readonly group_order: bigint;
  readonly forward: bigint;
  readonly filter_type: bigint;
  readonly start_group?: bigint;
  readonly start_object?: bigint;
  readonly end_group?: bigint;
  readonly parameters: Draft14Params;
}

export interface Draft14SubscribeOk extends Draft14BaseMessage {
  readonly type: "subscribe_ok";
  readonly request_id: bigint;
  readonly track_alias: bigint;
  readonly expires: bigint;
  readonly group_order: bigint;
  readonly content_exists: bigint;
  readonly largest_group?: bigint;
  readonly largest_object?: bigint;
  readonly parameters: Draft14Params;
}

export interface Draft14SubscribeUpdate extends Draft14BaseMessage {
  readonly type: "subscribe_update";
  readonly request_id: bigint;
  readonly start_group: bigint;
  readonly start_object: bigint;
  readonly end_group: bigint;
  readonly subscriber_priority: bigint;
  readonly forward: bigint;
  readonly parameters: Draft14Params;
}

export interface Draft14SubscribeError extends Draft14BaseMessage {
  readonly type: "subscribe_error";
  readonly request_id: bigint;
  readonly error_code: bigint;
  readonly reason_phrase: string;
}

export interface Draft14Unsubscribe extends Draft14BaseMessage {
  readonly type: "unsubscribe";
  readonly request_id: bigint;
}

// Publish
export interface Draft14Publish extends Draft14BaseMessage {
  readonly type: "publish";
  readonly request_id: bigint;
  readonly track_namespace: string[];
  readonly track_name: string;
  readonly forward: bigint;
  readonly parameters: Draft14Params;
}

export interface Draft14PublishOk extends Draft14BaseMessage {
  readonly type: "publish_ok";
  readonly request_id: bigint;
  readonly track_alias: bigint;
  readonly forward: bigint;
  readonly parameters: Draft14Params;
}

export interface Draft14PublishError extends Draft14BaseMessage {
  readonly type: "publish_error";
  readonly request_id: bigint;
  readonly error_code: bigint;
  readonly reason_phrase: string;
}

export interface Draft14PublishDone extends Draft14BaseMessage {
  readonly type: "publish_done";
  readonly request_id: bigint;
  readonly status_code: bigint;
  readonly reason_phrase: string;
}

// Namespace
export interface Draft14PublishNamespace extends Draft14BaseMessage {
  readonly type: "publish_namespace";
  readonly request_id: bigint;
  readonly track_namespace: string[];
  readonly parameters: Draft14Params;
}

export interface Draft14PublishNamespaceOk extends Draft14BaseMessage {
  readonly type: "publish_namespace_ok";
  readonly request_id: bigint;
  readonly parameters: Draft14Params;
}

export interface Draft14PublishNamespaceError extends Draft14BaseMessage {
  readonly type: "publish_namespace_error";
  readonly request_id: bigint;
  readonly error_code: bigint;
  readonly reason_phrase: string;
}

export interface Draft14PublishNamespaceDone extends Draft14BaseMessage {
  readonly type: "publish_namespace_done";
  readonly request_id: bigint;
  readonly status_code: bigint;
  readonly reason_phrase: string;
}

export interface Draft14PublishNamespaceCancel extends Draft14BaseMessage {
  readonly type: "publish_namespace_cancel";
  readonly request_id: bigint;
}

export interface Draft14SubscribeNamespace extends Draft14BaseMessage {
  readonly type: "subscribe_namespace";
  readonly request_id: bigint;
  readonly namespace_prefix: string[];
  readonly parameters: Draft14Params;
}

export interface Draft14SubscribeNamespaceOk extends Draft14BaseMessage {
  readonly type: "subscribe_namespace_ok";
  readonly request_id: bigint;
  readonly parameters: Draft14Params;
}

export interface Draft14SubscribeNamespaceError extends Draft14BaseMessage {
  readonly type: "subscribe_namespace_error";
  readonly request_id: bigint;
  readonly error_code: bigint;
  readonly reason_phrase: string;
}

export interface Draft14UnsubscribeNamespace extends Draft14BaseMessage {
  readonly type: "unsubscribe_namespace";
  readonly request_id: bigint;
}

// Fetch
export interface Draft14Fetch extends Draft14BaseMessage {
  readonly type: "fetch";
  readonly request_id: bigint;
  readonly track_namespace: string[];
  readonly track_name: string;
  readonly start_group: bigint;
  readonly start_object: bigint;
  readonly end_group: bigint;
  readonly parameters: Draft14Params;
}

export interface Draft14FetchOk extends Draft14BaseMessage {
  readonly type: "fetch_ok";
  readonly request_id: bigint;
  readonly track_alias: bigint;
  readonly end_of_track: bigint;
  readonly parameters: Draft14Params;
}

export interface Draft14FetchError extends Draft14BaseMessage {
  readonly type: "fetch_error";
  readonly request_id: bigint;
  readonly error_code: bigint;
  readonly reason_phrase: string;
}

export interface Draft14FetchCancel extends Draft14BaseMessage {
  readonly type: "fetch_cancel";
  readonly request_id: bigint;
}

// Track Status
export interface Draft14TrackStatus extends Draft14BaseMessage {
  readonly type: "track_status";
  readonly request_id: bigint;
  readonly track_namespace: string[];
  readonly track_name: string;
  readonly parameters: Draft14Params;
}

export interface Draft14TrackStatusOk extends Draft14BaseMessage {
  readonly type: "track_status_ok";
  readonly request_id: bigint;
  readonly status_code: bigint;
  readonly largest_group?: bigint;
  readonly largest_object?: bigint;
  readonly parameters: Draft14Params;
}

export interface Draft14TrackStatusError extends Draft14BaseMessage {
  readonly type: "track_status_error";
  readonly request_id: bigint;
  readonly error_code: bigint;
  readonly reason_phrase: string;
}

// Session Control
export interface Draft14GoAway extends Draft14BaseMessage {
  readonly type: "goaway";
  readonly new_session_uri: string;
}

export interface Draft14MaxRequestId extends Draft14BaseMessage {
  readonly type: "max_request_id";
  readonly request_id: bigint;
}

export interface Draft14RequestsBlocked extends Draft14BaseMessage {
  readonly type: "requests_blocked";
  readonly request_id: bigint;
}

// Union of all draft-14 control messages
export type Draft14Message =
  | Draft14ClientSetup
  | Draft14ServerSetup
  | Draft14Subscribe
  | Draft14SubscribeOk
  | Draft14SubscribeUpdate
  | Draft14SubscribeError
  | Draft14Unsubscribe
  | Draft14Publish
  | Draft14PublishOk
  | Draft14PublishError
  | Draft14PublishDone
  | Draft14PublishNamespace
  | Draft14PublishNamespaceOk
  | Draft14PublishNamespaceError
  | Draft14PublishNamespaceDone
  | Draft14PublishNamespaceCancel
  | Draft14SubscribeNamespace
  | Draft14SubscribeNamespaceOk
  | Draft14SubscribeNamespaceError
  | Draft14UnsubscribeNamespace
  | Draft14Fetch
  | Draft14FetchOk
  | Draft14FetchError
  | Draft14FetchCancel
  | Draft14TrackStatus
  | Draft14TrackStatusOk
  | Draft14TrackStatusError
  | Draft14GoAway
  | Draft14MaxRequestId
  | Draft14RequestsBlocked;

// Data stream types (no type+length wrapper)
export interface ObjectPayload {
  readonly type: "object";
  readonly objectId: bigint;
  readonly payloadLength: number;
  readonly payload: Uint8Array;
}

export interface SubgroupStream {
  readonly type: "subgroup";
  readonly trackAlias: bigint;
  readonly groupId: bigint;
  readonly subgroupId: bigint;
  readonly publisherPriority: number;
  readonly objects: ObjectPayload[];
}

export interface DatagramObject {
  readonly type: "datagram";
  readonly trackAlias: bigint;
  readonly groupId: bigint;
  readonly objectId: bigint;
  readonly payloadLength: number;
  readonly payload: Uint8Array;
}

export interface FetchStream {
  readonly type: "fetch";
  readonly subscribeRequestId: bigint;
  readonly objects: ObjectPayload[];
}

export type Draft14DataStream = SubgroupStream | DatagramObject | FetchStream;

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
  readonly subscribeRequestId: bigint;
}

export type DataStreamHeader = SubgroupStreamHeader | FetchStreamHeader;
export type DataStreamEvent = DataStreamHeader | ObjectPayload;
