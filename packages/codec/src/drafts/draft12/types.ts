// Draft-12 specific message types
// Field names use snake_case to match test vector JSON

// Unknown parameter for passthrough
export interface UnknownParam {
  readonly id: string // e.g. "0x21"
  readonly length: number
  readonly raw_hex: string
}

// Authorization token parameter
export interface AuthorizationToken {
  readonly alias_type: bigint
  readonly token_type: bigint
  readonly token_value: string
}

// Setup parameters (PATH, MAX_REQUEST_ID) — same even/odd encoding as later drafts
export interface Draft12SetupParams {
  path?: string // 0x01 odd
  max_request_id?: bigint // 0x02 even
  authorization_token?: AuthorizationToken // 0x03 odd
  unknown?: UnknownParam[]
}

// Version-specific parameters — even/odd convention
export interface Draft12Params {
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

// Draft-12 message type tag union
export type Draft12MessageType =
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
  | 'subscribe_announces'
  | 'subscribe_announces_ok'
  | 'subscribe_announces_error'
  | 'unsubscribe_announces'
  | 'fetch'
  | 'fetch_ok'
  | 'fetch_error'
  | 'fetch_cancel'
  | 'publish'
  | 'publish_ok'
  | 'publish_error'
  | 'track_status_request'
  | 'track_status'
  | 'goaway'
  | 'max_request_id'
  | 'requests_blocked'

// Base
export interface Draft12BaseMessage {
  readonly type: Draft12MessageType
}

// Setup — versions negotiated in messages
export interface Draft12ClientSetup extends Draft12BaseMessage {
  readonly type: 'client_setup'
  readonly supported_versions: bigint[]
  readonly parameters: Draft12SetupParams
}

export interface Draft12ServerSetup extends Draft12BaseMessage {
  readonly type: 'server_setup'
  readonly selected_version: bigint
  readonly parameters: Draft12SetupParams
}

// Subscribe — no track_alias in subscribe (moved to subscribe_ok)
export interface Draft12Subscribe extends Draft12BaseMessage {
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
  readonly parameters: Draft12Params
}

export interface Draft12SubscribeOk extends Draft12BaseMessage {
  readonly type: 'subscribe_ok'
  readonly request_id: bigint
  readonly track_alias: bigint
  readonly expires: bigint
  readonly group_order: number // uint8
  readonly content_exists: bigint
  readonly largest_location?: LargestLocation
  readonly parameters: Draft12Params
}

export interface Draft12SubscribeError extends Draft12BaseMessage {
  readonly type: 'subscribe_error'
  readonly request_id: bigint
  readonly error_code: bigint
  readonly reason_phrase: string
}

export interface Draft12SubscribeUpdate extends Draft12BaseMessage {
  readonly type: 'subscribe_update'
  readonly request_id: bigint
  readonly start_group: bigint
  readonly start_object: bigint
  readonly end_group: bigint
  readonly subscriber_priority: number // uint8
  readonly forward: bigint
  readonly parameters: Draft12Params
}

export interface Draft12SubscribeDone extends Draft12BaseMessage {
  readonly type: 'subscribe_done'
  readonly request_id: bigint
  readonly status_code: bigint
  readonly stream_count: bigint
  readonly reason_phrase: string
}

export interface Draft12Unsubscribe extends Draft12BaseMessage {
  readonly type: 'unsubscribe'
  readonly request_id: bigint
}

// Announce
export interface Draft12Announce extends Draft12BaseMessage {
  readonly type: 'announce'
  readonly request_id: bigint
  readonly track_namespace: string[]
  readonly parameters: Draft12Params
}

export interface Draft12AnnounceOk extends Draft12BaseMessage {
  readonly type: 'announce_ok'
  readonly request_id: bigint
}

export interface Draft12AnnounceError extends Draft12BaseMessage {
  readonly type: 'announce_error'
  readonly request_id: bigint
  readonly error_code: bigint
  readonly reason_phrase: string
}

export interface Draft12Unannounce extends Draft12BaseMessage {
  readonly type: 'unannounce'
  readonly track_namespace: string[]
}

export interface Draft12AnnounceCancel extends Draft12BaseMessage {
  readonly type: 'announce_cancel'
  readonly track_namespace: string[]
  readonly error_code: bigint
  readonly reason_phrase: string
}

// Subscribe Announces
export interface Draft12SubscribeAnnounces extends Draft12BaseMessage {
  readonly type: 'subscribe_announces'
  readonly request_id: bigint
  readonly track_namespace_prefix: string[]
  readonly parameters: Draft12Params
}

export interface Draft12SubscribeAnnouncesOk extends Draft12BaseMessage {
  readonly type: 'subscribe_announces_ok'
  readonly request_id: bigint
}

export interface Draft12SubscribeAnnouncesError extends Draft12BaseMessage {
  readonly type: 'subscribe_announces_error'
  readonly request_id: bigint
  readonly error_code: bigint
  readonly reason_phrase: string
}

export interface Draft12UnsubscribeAnnounces extends Draft12BaseMessage {
  readonly type: 'unsubscribe_announces'
  readonly track_namespace_prefix: string[]
}

// Publish (new in draft-12)
export interface Draft12Publish extends Draft12BaseMessage {
  readonly type: 'publish'
  readonly request_id: bigint
  readonly track_namespace: string[]
  readonly track_name: string
  readonly track_alias: bigint
  readonly group_order: number // uint8
  readonly content_exists: bigint
  readonly largest_location?: LargestLocation
  readonly forward: bigint
  readonly parameters: Draft12Params
}

export interface Draft12PublishOk extends Draft12BaseMessage {
  readonly type: 'publish_ok'
  readonly request_id: bigint
  readonly forward: bigint
  readonly subscriber_priority: number // uint8
  readonly group_order: number // uint8
  readonly filter_type: bigint
  readonly start_group?: bigint
  readonly start_object?: bigint
  readonly end_group?: bigint
  readonly parameters: Draft12Params
}

export interface Draft12PublishError extends Draft12BaseMessage {
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

export interface Draft12Fetch extends Draft12BaseMessage {
  readonly type: 'fetch'
  readonly request_id: bigint
  readonly subscriber_priority: number // uint8
  readonly group_order: number // uint8
  readonly fetch_type: bigint
  readonly standalone?: StandaloneFetch
  readonly joining?: JoiningFetch
  readonly parameters: Draft12Params
}

export interface Draft12FetchOk extends Draft12BaseMessage {
  readonly type: 'fetch_ok'
  readonly request_id: bigint
  readonly group_order: number // uint8
  readonly end_of_track: bigint
  readonly end_location: LargestLocation
  readonly parameters: Draft12Params
}

export interface Draft12FetchError extends Draft12BaseMessage {
  readonly type: 'fetch_error'
  readonly request_id: bigint
  readonly error_code: bigint
  readonly reason_phrase: string
}

export interface Draft12FetchCancel extends Draft12BaseMessage {
  readonly type: 'fetch_cancel'
  readonly request_id: bigint
}

// Track Status
export interface Draft12TrackStatusRequest extends Draft12BaseMessage {
  readonly type: 'track_status_request'
  readonly request_id: bigint
  readonly track_namespace: string[]
  readonly track_name: string
  readonly parameters: Draft12Params
}

export interface Draft12TrackStatus extends Draft12BaseMessage {
  readonly type: 'track_status'
  readonly request_id: bigint
  readonly status_code: bigint
  readonly largest_location: LargestLocation
  readonly parameters: Draft12Params
}

// Session Control
export interface Draft12GoAway extends Draft12BaseMessage {
  readonly type: 'goaway'
  readonly new_session_uri: string
}

export interface Draft12MaxRequestId extends Draft12BaseMessage {
  readonly type: 'max_request_id'
  readonly request_id: bigint
}

export interface Draft12RequestsBlocked extends Draft12BaseMessage {
  readonly type: 'requests_blocked'
  readonly maximum_request_id: bigint
}

// Union of all draft-12 control messages
export type Draft12Message =
  | Draft12ClientSetup
  | Draft12ServerSetup
  | Draft12Subscribe
  | Draft12SubscribeOk
  | Draft12SubscribeError
  | Draft12SubscribeUpdate
  | Draft12SubscribeDone
  | Draft12Unsubscribe
  | Draft12Announce
  | Draft12AnnounceOk
  | Draft12AnnounceError
  | Draft12Unannounce
  | Draft12AnnounceCancel
  | Draft12SubscribeAnnounces
  | Draft12SubscribeAnnouncesOk
  | Draft12SubscribeAnnouncesError
  | Draft12UnsubscribeAnnounces
  | Draft12Publish
  | Draft12PublishOk
  | Draft12PublishError
  | Draft12Fetch
  | Draft12FetchOk
  | Draft12FetchError
  | Draft12FetchCancel
  | Draft12TrackStatusRequest
  | Draft12TrackStatus
  | Draft12GoAway
  | Draft12MaxRequestId
  | Draft12RequestsBlocked

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
  readonly streamTypeId: number // 0x00-0x03
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

export type Draft12DataStream = SubgroupStream | DatagramObject | FetchStream

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
