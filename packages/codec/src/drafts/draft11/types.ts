// Draft-11 specific message types
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
  readonly token_value: Uint8Array
}

// Setup parameters (PATH, MAX_REQUEST_ID) — same even/odd encoding as later drafts
export interface Draft11SetupParams {
  path?: string // 0x01 odd
  max_request_id?: bigint // 0x02 even
  unknown?: UnknownParam[]
}

// Version-specific parameters — even/odd convention
export interface Draft11Params {
  authorization_token?: AuthorizationToken // 0x01 odd
  delivery_timeout?: bigint // 0x02 even
  max_cache_duration?: bigint // 0x04 even
  unknown?: UnknownParam[]
}

// Largest object location
export interface LargestLocation {
  readonly group: bigint
  readonly object: bigint
}

// Draft-11 message type tag union
export type Draft11MessageType =
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
  | 'track_status_request'
  | 'track_status'
  | 'goaway'
  | 'max_request_id'
  | 'requests_blocked'

// Base
export interface Draft11BaseMessage {
  readonly type: Draft11MessageType
}

// Setup — versions negotiated in messages
export interface Draft11ClientSetup extends Draft11BaseMessage {
  readonly type: 'client_setup'
  readonly supported_versions: bigint[]
  readonly parameters: Draft11SetupParams
}

export interface Draft11ServerSetup extends Draft11BaseMessage {
  readonly type: 'server_setup'
  readonly selected_version: bigint
  readonly parameters: Draft11SetupParams
}

// Subscribe
export interface Draft11Subscribe extends Draft11BaseMessage {
  readonly type: 'subscribe'
  readonly request_id: bigint
  readonly track_alias: bigint
  readonly track_namespace: string[]
  readonly track_name: string
  readonly subscriber_priority: number // uint8
  readonly group_order: number // uint8
  readonly forward: bigint
  readonly filter_type: bigint
  readonly start_group?: bigint
  readonly start_object?: bigint
  readonly end_group?: bigint
  readonly parameters: Draft11Params
}

export interface Draft11SubscribeOk extends Draft11BaseMessage {
  readonly type: 'subscribe_ok'
  readonly request_id: bigint
  readonly expires: bigint
  readonly group_order: number // uint8
  readonly content_exists: bigint
  readonly largest_location?: LargestLocation
  readonly parameters: Draft11Params
}

export interface Draft11SubscribeError extends Draft11BaseMessage {
  readonly type: 'subscribe_error'
  readonly request_id: bigint
  readonly error_code: bigint
  readonly reason_phrase: string
  readonly track_alias: bigint
}

export interface Draft11SubscribeUpdate extends Draft11BaseMessage {
  readonly type: 'subscribe_update'
  readonly request_id: bigint
  readonly start_group: bigint
  readonly start_object: bigint
  readonly end_group: bigint
  readonly subscriber_priority: number // uint8
  readonly forward: bigint
  readonly parameters: Draft11Params
}

export interface Draft11SubscribeDone extends Draft11BaseMessage {
  readonly type: 'subscribe_done'
  readonly request_id: bigint
  readonly status_code: bigint
  readonly stream_count: bigint
  readonly reason_phrase: string
}

export interface Draft11Unsubscribe extends Draft11BaseMessage {
  readonly type: 'unsubscribe'
  readonly request_id: bigint
}

// Announce
export interface Draft11Announce extends Draft11BaseMessage {
  readonly type: 'announce'
  readonly request_id: bigint
  readonly track_namespace: string[]
  readonly parameters: Draft11Params
}

export interface Draft11AnnounceOk extends Draft11BaseMessage {
  readonly type: 'announce_ok'
  readonly request_id: bigint
}

export interface Draft11AnnounceError extends Draft11BaseMessage {
  readonly type: 'announce_error'
  readonly request_id: bigint
  readonly error_code: bigint
  readonly reason_phrase: string
}

export interface Draft11Unannounce extends Draft11BaseMessage {
  readonly type: 'unannounce'
  readonly track_namespace: string[]
}

export interface Draft11AnnounceCancel extends Draft11BaseMessage {
  readonly type: 'announce_cancel'
  readonly track_namespace: string[]
  readonly error_code: bigint
  readonly reason_phrase: string
}

// Subscribe Announces
export interface Draft11SubscribeAnnounces extends Draft11BaseMessage {
  readonly type: 'subscribe_announces'
  readonly request_id: bigint
  readonly track_namespace_prefix: string[]
  readonly parameters: Draft11Params
}

export interface Draft11SubscribeAnnouncesOk extends Draft11BaseMessage {
  readonly type: 'subscribe_announces_ok'
  readonly request_id: bigint
}

export interface Draft11SubscribeAnnouncesError extends Draft11BaseMessage {
  readonly type: 'subscribe_announces_error'
  readonly request_id: bigint
  readonly error_code: bigint
  readonly reason_phrase: string
}

export interface Draft11UnsubscribeAnnounces extends Draft11BaseMessage {
  readonly type: 'unsubscribe_announces'
  readonly track_namespace_prefix: string[]
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

export interface Draft11Fetch extends Draft11BaseMessage {
  readonly type: 'fetch'
  readonly request_id: bigint
  readonly subscriber_priority: number // uint8
  readonly group_order: number // uint8
  readonly fetch_type: bigint
  readonly standalone?: StandaloneFetch
  readonly joining?: JoiningFetch
  readonly parameters: Draft11Params
}

export interface Draft11FetchOk extends Draft11BaseMessage {
  readonly type: 'fetch_ok'
  readonly request_id: bigint
  readonly group_order: number // uint8
  readonly end_of_track: bigint
  readonly end_location: LargestLocation
  readonly parameters: Draft11Params
}

export interface Draft11FetchError extends Draft11BaseMessage {
  readonly type: 'fetch_error'
  readonly request_id: bigint
  readonly error_code: bigint
  readonly reason_phrase: string
}

export interface Draft11FetchCancel extends Draft11BaseMessage {
  readonly type: 'fetch_cancel'
  readonly request_id: bigint
}

// Track Status
export interface Draft11TrackStatusRequest extends Draft11BaseMessage {
  readonly type: 'track_status_request'
  readonly request_id: bigint
  readonly track_namespace: string[]
  readonly track_name: string
  readonly parameters: Draft11Params
}

export interface Draft11TrackStatus extends Draft11BaseMessage {
  readonly type: 'track_status'
  readonly request_id: bigint
  readonly status_code: bigint
  readonly largest_location: LargestLocation
  readonly parameters: Draft11Params
}

// Session Control
export interface Draft11GoAway extends Draft11BaseMessage {
  readonly type: 'goaway'
  readonly new_session_uri: string
}

export interface Draft11MaxRequestId extends Draft11BaseMessage {
  readonly type: 'max_request_id'
  readonly request_id: bigint
}

export interface Draft11RequestsBlocked extends Draft11BaseMessage {
  readonly type: 'requests_blocked'
  readonly maximum_request_id: bigint
}

// Union of all draft-11 control messages
export type Draft11Message =
  | Draft11ClientSetup
  | Draft11ServerSetup
  | Draft11Subscribe
  | Draft11SubscribeOk
  | Draft11SubscribeError
  | Draft11SubscribeUpdate
  | Draft11SubscribeDone
  | Draft11Unsubscribe
  | Draft11Announce
  | Draft11AnnounceOk
  | Draft11AnnounceError
  | Draft11Unannounce
  | Draft11AnnounceCancel
  | Draft11SubscribeAnnounces
  | Draft11SubscribeAnnouncesOk
  | Draft11SubscribeAnnouncesError
  | Draft11UnsubscribeAnnounces
  | Draft11Fetch
  | Draft11FetchOk
  | Draft11FetchError
  | Draft11FetchCancel
  | Draft11TrackStatusRequest
  | Draft11TrackStatus
  | Draft11GoAway
  | Draft11MaxRequestId
  | Draft11RequestsBlocked

// Data stream types
export interface ObjectPayload {
  readonly type: 'object'
  readonly byteOffset: number
  readonly payloadByteOffset: number
  readonly objectId: bigint
  readonly extensionHeadersLength?: bigint
  readonly extensionData: Uint8Array
  readonly payloadLength: number
  readonly status?: bigint
  readonly payload: Uint8Array
}

export interface SubgroupStream {
  readonly type: 'subgroup'
  readonly streamTypeId: number // 0x08-0x0D
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

export type Draft11DataStream = SubgroupStream | DatagramObject | FetchStream

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
