// Draft-13 specific message types
// Field names use snake_case to match test vector JSON

// Unknown parameter for passthrough
export interface UnknownParam {
  readonly id: string // e.g. "0x21"
  readonly length: number
  readonly raw_hex: string
}

// Authorization token parameter
// alias_type: 0=DELETE, 1=REGISTER, 2=USE_ALIAS, 3=USE_VALUE
export interface AuthorizationToken {
  readonly alias_type: bigint
  readonly token_alias?: bigint // present for DELETE(0), REGISTER(1), USE_ALIAS(2)
  readonly token_type?: bigint // present for USE_VALUE(3), REGISTER(1)
  readonly token_value?: Uint8Array // present for USE_VALUE(3), REGISTER(1)
}

// Setup parameters (PATH, MAX_REQUEST_ID, AUTHORIZATION_TOKEN, MAX_AUTH_TOKEN_CACHE_SIZE)
export interface Draft13SetupParams {
  path?: string // 0x01 odd
  max_request_id?: bigint // 0x02 even
  authorization_token?: AuthorizationToken // 0x03 odd
  max_auth_token_cache_size?: bigint // 0x04 even
  unknown?: UnknownParam[]
}

// Version-specific parameters — even/odd convention
export interface Draft13Params {
  delivery_timeout?: bigint // 0x02 even
  authorization_token?: AuthorizationToken // 0x03 odd
  max_cache_duration?: bigint // 0x04 even
  unknown?: UnknownParam[]
}

// Largest object location
export interface LargestLocation {
  readonly group: bigint
  readonly object: bigint
}

// Draft-13 message type tag union
export type Draft13MessageType =
  | 'client_setup'
  | 'server_setup'
  | 'subscribe'
  | 'subscribe_ok'
  | 'subscribe_error'
  | 'subscribe_update'
  | 'subscribe_done'
  | 'unsubscribe'
  | 'announce'
  | 'announce_ok'
  | 'announce_error'
  | 'unannounce'
  | 'announce_cancel'
  | 'subscribe_namespace'
  | 'subscribe_namespace_ok'
  | 'subscribe_namespace_error'
  | 'unsubscribe_namespace'
  | 'fetch'
  | 'fetch_ok'
  | 'fetch_error'
  | 'fetch_cancel'
  | 'publish'
  | 'publish_ok'
  | 'publish_error'
  | 'track_status'
  | 'track_status_ok'
  | 'track_status_error'
  | 'goaway'
  | 'max_request_id'
  | 'requests_blocked'

// Base
export interface Draft13BaseMessage {
  readonly type: Draft13MessageType
}

// Setup — versions negotiated in messages
export interface Draft13ClientSetup extends Draft13BaseMessage {
  readonly type: 'client_setup'
  readonly supported_versions: bigint[]
  readonly parameters: Draft13SetupParams
}

export interface Draft13ServerSetup extends Draft13BaseMessage {
  readonly type: 'server_setup'
  readonly selected_version: bigint
  readonly parameters: Draft13SetupParams
}

// Subscribe — no track_alias in subscribe (moved to subscribe_ok)
export interface Draft13Subscribe extends Draft13BaseMessage {
  readonly type: 'subscribe'
  readonly request_id: bigint
  readonly track_namespace: string[]
  readonly track_name: string
  readonly subscriber_priority: number // uint8
  readonly group_order: number // uint8
  readonly forward: bigint
  readonly filter_type: bigint
  readonly start_group?: bigint
  readonly start_object?: bigint
  readonly end_group?: bigint
  readonly parameters: Draft13Params
}

export interface Draft13SubscribeOk extends Draft13BaseMessage {
  readonly type: 'subscribe_ok'
  readonly request_id: bigint
  readonly track_alias: bigint
  readonly expires: bigint
  readonly group_order: number // uint8
  readonly content_exists: bigint
  readonly largest_location?: LargestLocation
  readonly parameters: Draft13Params
}

export interface Draft13SubscribeError extends Draft13BaseMessage {
  readonly type: 'subscribe_error'
  readonly request_id: bigint
  readonly error_code: bigint
  readonly reason_phrase: string
}

export interface Draft13SubscribeUpdate extends Draft13BaseMessage {
  readonly type: 'subscribe_update'
  readonly request_id: bigint
  readonly start_group: bigint
  readonly start_object: bigint
  readonly end_group: bigint
  readonly subscriber_priority: number // uint8
  readonly forward: bigint
  readonly parameters: Draft13Params
}

export interface Draft13SubscribeDone extends Draft13BaseMessage {
  readonly type: 'subscribe_done'
  readonly request_id: bigint
  readonly status_code: bigint
  readonly stream_count: bigint
  readonly reason_phrase: string
}

export interface Draft13Unsubscribe extends Draft13BaseMessage {
  readonly type: 'unsubscribe'
  readonly request_id: bigint
}

// Announce
export interface Draft13Announce extends Draft13BaseMessage {
  readonly type: 'announce'
  readonly request_id: bigint
  readonly track_namespace: string[]
  readonly parameters: Draft13Params
}

export interface Draft13AnnounceOk extends Draft13BaseMessage {
  readonly type: 'announce_ok'
  readonly request_id: bigint
}

export interface Draft13AnnounceError extends Draft13BaseMessage {
  readonly type: 'announce_error'
  readonly request_id: bigint
  readonly error_code: bigint
  readonly reason_phrase: string
}

export interface Draft13Unannounce extends Draft13BaseMessage {
  readonly type: 'unannounce'
  readonly track_namespace: string[]
}

export interface Draft13AnnounceCancel extends Draft13BaseMessage {
  readonly type: 'announce_cancel'
  readonly track_namespace: string[]
  readonly error_code: bigint
  readonly reason_phrase: string
}

// Subscribe Namespace (renamed from subscribe_announces in draft-12)
export interface Draft13SubscribeNamespace extends Draft13BaseMessage {
  readonly type: 'subscribe_namespace'
  readonly request_id: bigint
  readonly track_namespace_prefix: string[]
  readonly parameters: Draft13Params
}

export interface Draft13SubscribeNamespaceOk extends Draft13BaseMessage {
  readonly type: 'subscribe_namespace_ok'
  readonly request_id: bigint
}

export interface Draft13SubscribeNamespaceError extends Draft13BaseMessage {
  readonly type: 'subscribe_namespace_error'
  readonly request_id: bigint
  readonly error_code: bigint
  readonly reason_phrase: string
}

export interface Draft13UnsubscribeNamespace extends Draft13BaseMessage {
  readonly type: 'unsubscribe_namespace'
  readonly track_namespace_prefix: string[]
}

// Publish (same as draft-12)
export interface Draft13Publish extends Draft13BaseMessage {
  readonly type: 'publish'
  readonly request_id: bigint
  readonly track_namespace: string[]
  readonly track_name: string
  readonly track_alias: bigint
  readonly group_order: number // uint8
  readonly content_exists: bigint
  readonly largest_location?: LargestLocation
  readonly forward: bigint
  readonly parameters: Draft13Params
}

export interface Draft13PublishOk extends Draft13BaseMessage {
  readonly type: 'publish_ok'
  readonly request_id: bigint
  readonly forward: bigint
  readonly subscriber_priority: number // uint8
  readonly group_order: number // uint8
  readonly filter_type: bigint
  readonly start_group?: bigint
  readonly start_object?: bigint
  readonly end_group?: bigint
  readonly parameters: Draft13Params
}

export interface Draft13PublishError extends Draft13BaseMessage {
  readonly type: 'publish_error'
  readonly request_id: bigint
  readonly error_code: bigint
  readonly reason_phrase: string
}

// Fetch
export interface StandaloneFetch {
  readonly track_namespace: string[]
  readonly track_name: string
  readonly start_group: bigint
  readonly start_object: bigint
  readonly end_group: bigint
  readonly end_object: bigint
}

export interface JoiningFetch {
  readonly joining_subscribe_id: bigint
  readonly joining_start: bigint
}

export interface Draft13Fetch extends Draft13BaseMessage {
  readonly type: 'fetch'
  readonly request_id: bigint
  readonly subscriber_priority: number // uint8
  readonly group_order: number // uint8
  readonly fetch_type: bigint
  readonly standalone?: StandaloneFetch
  readonly joining?: JoiningFetch
  readonly parameters: Draft13Params
}

export interface Draft13FetchOk extends Draft13BaseMessage {
  readonly type: 'fetch_ok'
  readonly request_id: bigint
  readonly group_order: number // uint8
  readonly end_of_track: bigint
  readonly end_location: LargestLocation
  readonly parameters: Draft13Params
}

export interface Draft13FetchError extends Draft13BaseMessage {
  readonly type: 'fetch_error'
  readonly request_id: bigint
  readonly error_code: bigint
  readonly reason_phrase: string
}

export interface Draft13FetchCancel extends Draft13BaseMessage {
  readonly type: 'fetch_cancel'
  readonly request_id: bigint
}

// Track Status (restructured in draft-13: request is SUBSCRIBE-like)
export interface Draft13TrackStatus extends Draft13BaseMessage {
  readonly type: 'track_status'
  readonly request_id: bigint
  readonly track_namespace: string[]
  readonly track_name: string
  readonly subscriber_priority: number // uint8
  readonly group_order: number // uint8
  readonly forward: bigint
  readonly filter_type: bigint
  readonly start_group?: bigint
  readonly start_object?: bigint
  readonly end_group?: bigint
  readonly parameters: Draft13Params
}

export interface Draft13TrackStatusOk extends Draft13BaseMessage {
  readonly type: 'track_status_ok'
  readonly request_id: bigint
  readonly track_alias: bigint
  readonly expires: bigint
  readonly group_order: number // uint8
  readonly content_exists: bigint
  readonly largest_location?: LargestLocation
  readonly parameters: Draft13Params
}

export interface Draft13TrackStatusError extends Draft13BaseMessage {
  readonly type: 'track_status_error'
  readonly request_id: bigint
  readonly error_code: bigint
  readonly reason_phrase: string
}

// Session Control
export interface Draft13GoAway extends Draft13BaseMessage {
  readonly type: 'goaway'
  readonly new_session_uri: string
}

export interface Draft13MaxRequestId extends Draft13BaseMessage {
  readonly type: 'max_request_id'
  readonly request_id: bigint
}

export interface Draft13RequestsBlocked extends Draft13BaseMessage {
  readonly type: 'requests_blocked'
  readonly maximum_request_id: bigint
}

// Union of all draft-13 control messages
export type Draft13Message =
  | Draft13ClientSetup
  | Draft13ServerSetup
  | Draft13Subscribe
  | Draft13SubscribeOk
  | Draft13SubscribeError
  | Draft13SubscribeUpdate
  | Draft13SubscribeDone
  | Draft13Unsubscribe
  | Draft13Announce
  | Draft13AnnounceOk
  | Draft13AnnounceError
  | Draft13Unannounce
  | Draft13AnnounceCancel
  | Draft13SubscribeNamespace
  | Draft13SubscribeNamespaceOk
  | Draft13SubscribeNamespaceError
  | Draft13UnsubscribeNamespace
  | Draft13Publish
  | Draft13PublishOk
  | Draft13PublishError
  | Draft13Fetch
  | Draft13FetchOk
  | Draft13FetchError
  | Draft13FetchCancel
  | Draft13TrackStatus
  | Draft13TrackStatusOk
  | Draft13TrackStatusError
  | Draft13GoAway
  | Draft13MaxRequestId
  | Draft13RequestsBlocked

// Data stream types
export interface ObjectPayload {
  readonly type: 'object'
  readonly byteOffset: number
  readonly payloadByteOffset: number
  readonly objectId: bigint
  readonly extensionHeadersLength?: bigint
  readonly payloadLength: number
  readonly status?: bigint
  readonly extensionData: Uint8Array
  readonly payload: Uint8Array
}

export interface SubgroupStream {
  readonly type: 'subgroup'
  readonly streamTypeId: number // 0x10-0x15, 0x18-0x1D
  readonly trackAlias: bigint
  readonly groupId: bigint
  readonly subgroupId: bigint
  readonly publisherPriority: number
  readonly objects: ObjectPayload[]
}

export interface DatagramObject {
  readonly type: 'datagram'
  readonly streamTypeId: number // 0x00-0x05
  readonly trackAlias: bigint
  readonly groupId: bigint
  readonly objectId: bigint
  readonly publisherPriority: number
  readonly extensionHeadersLength?: bigint
  readonly extensionData?: Uint8Array
  readonly objectStatus?: bigint
  readonly payloadLength: number
  readonly payload: Uint8Array
}

export interface FetchObjectPayload {
  readonly type: 'object'
  readonly byteOffset: number
  readonly payloadByteOffset: number
  readonly groupId: bigint
  readonly subgroupId: bigint
  readonly objectId: bigint
  readonly publisherPriority: number
  readonly extensionHeadersLength: bigint
  readonly extensionData: Uint8Array
  readonly payloadLength: number
  readonly payload: Uint8Array
}

export interface FetchStream {
  readonly type: 'fetch'
  readonly requestId: bigint
  readonly objects: FetchObjectPayload[]
}

export type Draft13DataStream = SubgroupStream | DatagramObject | FetchStream

// Streaming data stream decoder types
export interface SubgroupStreamHeader {
  readonly type: 'subgroup_header'
  readonly trackAlias: bigint
  readonly groupId: bigint
  readonly subgroupId: bigint
  readonly publisherPriority: number
}

export interface FetchStreamHeader {
  readonly type: 'fetch_header'
  readonly requestId: bigint
}

export type DataStreamHeader = SubgroupStreamHeader | FetchStreamHeader
export type DataStreamEvent = DataStreamHeader | ObjectPayload
