// Draft-07 message types
// Field names use snake_case to match test vector JSON

// Unknown parameter for passthrough
export interface UnknownParam {
  readonly id: string // e.g. "0x21"
  readonly length: number
  readonly raw_hex: string
}

// Setup parameters (ROLE, PATH, MAX_SUBSCRIBE_ID)
export interface Draft07SetupParams {
  role?: bigint // 0x00
  path?: string // 0x01
  max_subscribe_id?: bigint // 0x02
  unknown?: UnknownParam[]
}

// Version-specific parameters
export interface Draft07Params {
  authorization_info?: string // 0x02
  delivery_timeout?: bigint // 0x03
  max_cache_duration?: bigint // 0x04
  unknown?: UnknownParam[]
}

// All Draft-07 message type tags
export type Draft07MessageType =
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
  | 'fetch_cancel'

// Base message interface
export interface Draft07BaseMessage {
  readonly type: Draft07MessageType
}

// Setup messages
export interface ClientSetup extends Draft07BaseMessage {
  readonly type: 'client_setup'
  readonly supported_versions: bigint[]
  readonly parameters: Draft07SetupParams
}

export interface ServerSetup extends Draft07BaseMessage {
  readonly type: 'server_setup'
  readonly selected_version: bigint
  readonly parameters: Draft07SetupParams
}

// Subscribe messages
export interface Subscribe extends Draft07BaseMessage {
  readonly type: 'subscribe'
  readonly subscribe_id: bigint
  readonly track_alias: bigint
  readonly track_namespace: string[]
  readonly track_name: string
  readonly subscriber_priority: number
  readonly group_order: number // uint8: 0=original, 1=ascending, 2=descending
  readonly filter_type: bigint // varint: 1=latest_group, 2=latest_object, 3=absolute_start, 4=absolute_range
  readonly start_group?: bigint
  readonly start_object?: bigint
  readonly end_group?: bigint
  readonly end_object?: bigint
  readonly parameters: Draft07Params
}

export interface SubscribeOk extends Draft07BaseMessage {
  readonly type: 'subscribe_ok'
  readonly subscribe_id: bigint
  readonly expires: bigint
  readonly group_order: number // uint8
  readonly content_exists: number // uint8
  readonly largest_group_id?: bigint
  readonly largest_object_id?: bigint
  readonly parameters: Draft07Params
}

export interface SubscribeError extends Draft07BaseMessage {
  readonly type: 'subscribe_error'
  readonly subscribe_id: bigint
  readonly error_code: bigint
  readonly reason_phrase: string
  readonly track_alias: bigint
}

export interface SubscribeDone extends Draft07BaseMessage {
  readonly type: 'subscribe_done'
  readonly subscribe_id: bigint
  readonly status_code: bigint
  readonly reason_phrase: string
  readonly content_exists: number // uint8
  readonly final_group?: bigint
  readonly final_object?: bigint
}

export interface SubscribeUpdate extends Draft07BaseMessage {
  readonly type: 'subscribe_update'
  readonly subscribe_id: bigint
  readonly start_group: bigint
  readonly start_object: bigint
  readonly end_group: bigint
  readonly end_object: bigint
  readonly subscriber_priority: number
  readonly parameters: Draft07Params
}

export interface Unsubscribe extends Draft07BaseMessage {
  readonly type: 'unsubscribe'
  readonly subscribe_id: bigint
}

// Announce messages
export interface Announce extends Draft07BaseMessage {
  readonly type: 'announce'
  readonly track_namespace: string[]
  readonly parameters: Draft07Params
}

export interface AnnounceOk extends Draft07BaseMessage {
  readonly type: 'announce_ok'
  readonly track_namespace: string[]
}

export interface AnnounceError extends Draft07BaseMessage {
  readonly type: 'announce_error'
  readonly track_namespace: string[]
  readonly error_code: bigint
  readonly reason_phrase: string
}

export interface AnnounceCancel extends Draft07BaseMessage {
  readonly type: 'announce_cancel'
  readonly track_namespace: string[]
  readonly error_code: bigint
  readonly reason_phrase: string
}

export interface Unannounce extends Draft07BaseMessage {
  readonly type: 'unannounce'
  readonly track_namespace: string[]
}

// Track status
export interface TrackStatusRequest extends Draft07BaseMessage {
  readonly type: 'track_status_request'
  readonly track_namespace: string[]
  readonly track_name: string
}

export interface TrackStatus extends Draft07BaseMessage {
  readonly type: 'track_status'
  readonly track_namespace: string[]
  readonly track_name: string
  readonly status_code: bigint
  readonly last_group_id: bigint
  readonly last_object_id: bigint
}

// Object/stream messages
export interface ObjectStream extends Draft07BaseMessage {
  readonly type: 'object_stream'
  readonly track_alias: bigint
  readonly group_id: bigint
  readonly object_id: bigint
  readonly publisher_priority: number
  readonly object_status?: number
  readonly payload: Uint8Array
}

export interface ObjectDatagram extends Draft07BaseMessage {
  readonly type: 'object_datagram'
  readonly track_alias: bigint
  readonly group_id: bigint
  readonly object_id: bigint
  readonly publisher_priority: number
  readonly object_status?: number
  readonly payload: Uint8Array
}

export interface StreamHeaderTrack extends Draft07BaseMessage {
  readonly type: 'stream_header_track'
  readonly track_alias: bigint
  readonly publisher_priority: number
}

export interface StreamHeaderGroup extends Draft07BaseMessage {
  readonly type: 'stream_header_group'
  readonly track_alias: bigint
  readonly group_id: bigint
  readonly publisher_priority: number
}

export interface StreamHeaderSubgroup extends Draft07BaseMessage {
  readonly type: 'stream_header_subgroup'
  readonly track_alias: bigint
  readonly group_id: bigint
  readonly subgroup_id: bigint
  readonly publisher_priority: number
}

// GoAway
export interface GoAway extends Draft07BaseMessage {
  readonly type: 'goaway'
  readonly new_session_uri: string
}

// Subscribe Announces
export interface SubscribeAnnounces extends Draft07BaseMessage {
  readonly type: 'subscribe_announces'
  readonly track_namespace_prefix: string[]
  readonly parameters: Draft07Params
}

export interface SubscribeAnnouncesOk extends Draft07BaseMessage {
  readonly type: 'subscribe_announces_ok'
  readonly track_namespace_prefix: string[]
}

export interface SubscribeAnnouncesError extends Draft07BaseMessage {
  readonly type: 'subscribe_announces_error'
  readonly track_namespace_prefix: string[]
  readonly error_code: bigint
  readonly reason_phrase: string
}

// Unsubscribe Announces
export interface UnsubscribeAnnounces extends Draft07BaseMessage {
  readonly type: 'unsubscribe_announces'
  readonly track_namespace_prefix: string[]
}

// Max Subscribe ID
export interface MaxSubscribeId extends Draft07BaseMessage {
  readonly type: 'max_subscribe_id'
  readonly subscribe_id: bigint
}

// Fetch
export interface Fetch extends Draft07BaseMessage {
  readonly type: 'fetch'
  readonly subscribe_id: bigint
  readonly track_namespace: string[]
  readonly track_name: string
  readonly subscriber_priority: number
  readonly group_order: number // uint8
  readonly start_group: bigint
  readonly start_object: bigint
  readonly end_group: bigint
  readonly end_object: bigint
  readonly parameters: Draft07Params
}

export interface FetchOk extends Draft07BaseMessage {
  readonly type: 'fetch_ok'
  readonly subscribe_id: bigint
  readonly group_order: number // uint8
  readonly end_of_track: number // uint8
  readonly largest_group_id: bigint
  readonly largest_object_id: bigint
  readonly parameters: Draft07Params
}

export interface FetchError extends Draft07BaseMessage {
  readonly type: 'fetch_error'
  readonly subscribe_id: bigint
  readonly error_code: bigint
  readonly reason_phrase: string
}

export interface FetchCancel extends Draft07BaseMessage {
  readonly type: 'fetch_cancel'
  readonly subscribe_id: bigint
}

// Union type of all Draft-07 messages
export type Draft07Message =
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
  | FetchCancel

// Draft-07 data stream types

export interface ObjectPayload {
  readonly type: 'object'
  readonly objectId: bigint
  readonly payloadLength: number
  readonly status?: bigint
  readonly payload: Uint8Array
  readonly byteOffset: number
  readonly payloadByteOffset: number
}

export interface SubgroupStream {
  readonly type: 'subgroup'
  readonly streamTypeId: 0x04
  readonly trackAlias: bigint
  readonly groupId: bigint
  readonly subgroupId: bigint
  readonly publisherPriority: number
  readonly objects: ObjectPayload[]
}

export interface DatagramObject {
  readonly type: 'datagram'
  readonly streamTypeId: 0x01
  readonly trackAlias: bigint
  readonly groupId: bigint
  readonly objectId: bigint
  readonly publisherPriority: number
  readonly payloadLength: number
  readonly status?: bigint
  readonly payload: Uint8Array
}

export interface FetchObjectPayload {
  readonly type: 'object'
  readonly groupId: bigint
  readonly subgroupId: bigint
  readonly objectId: bigint
  readonly publisherPriority: number
  readonly payloadLength: number
  readonly status?: bigint
  readonly payload: Uint8Array
  readonly byteOffset: number
  readonly payloadByteOffset: number
}

export interface FetchStream {
  readonly type: 'fetch'
  readonly subscribeId: bigint
  readonly objects: FetchObjectPayload[]
}

export type Draft07DataStream = SubgroupStream | DatagramObject | FetchStream

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
  readonly subscribeId: bigint
}

export type DataStreamHeader = SubgroupStreamHeader | FetchStreamHeader
export type DataStreamEvent = DataStreamHeader | ObjectPayload
