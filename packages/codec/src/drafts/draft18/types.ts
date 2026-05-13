// Draft-18 specific message types

// Unknown parameter for passthrough
export interface UnknownParam {
  readonly id: string // e.g. "0x21"
  readonly length: number
  readonly raw_hex: string
}

// Authorization token parameter (nested structure within length-prefixed param)
export interface AuthorizationToken {
  readonly alias_type: bigint // 0=DELETE, 1=REGISTER, 2=USE_ALIAS, 3=USE_VALUE
  readonly token_alias?: bigint // present for DELETE(0), REGISTER(1), USE_ALIAS(2)
  readonly token_type?: bigint // present for REGISTER(1), USE_VALUE(3)
  readonly token_value?: Uint8Array // present for REGISTER(1), USE_VALUE(3)
}

// Setup options (KVP encoding, no count prefix)
export interface Draft18SetupOptions {
  path?: string // 0x01 odd
  authorization_token?: AuthorizationToken // 0x03 odd
  max_auth_token_cache_size?: bigint // 0x04 even
  authority?: string // 0x05 odd
  moqt_implementation?: string // 0x07 odd
  unknown?: UnknownParam[]
}

// Subscription filter parameter
export interface SubscriptionFilter {
  readonly filter_type: bigint
  readonly start_group?: bigint
  readonly start_object?: bigint
  readonly end_group?: bigint
}

// Largest object location parameter
export interface LargestObject {
  readonly group: bigint
  readonly object: bigint
}

// Version-specific parameters (delta-encoded types, count-prefixed)
export interface Draft18Params {
  object_delivery_timeout?: bigint // 0x02 varint (renamed from delivery_timeout in draft-17)
  authorization_token?: AuthorizationToken // 0x03 length-prefixed nested
  rendezvous_timeout?: bigint // 0x04 varint
  subgroup_delivery_timeout?: bigint // 0x06 varint (NEW in draft-18)
  expires?: bigint // 0x08 varint
  largest_object?: LargestObject // 0x09 Location (2 bare varints)
  fill_timeout?: bigint // 0x0a varint (NEW in draft-18)
  forward?: bigint // 0x10 uint8 (was varint in draft-17)
  subscriber_priority?: bigint // 0x20 uint8
  subscription_filter?: SubscriptionFilter // 0x21 length-prefixed
  group_order?: bigint // 0x22 uint8
  new_group_request?: bigint // 0x32 varint
  track_namespace_prefix?: string[] // 0x34 Track Namespace encoding (NEW in draft-18)
  unknown?: UnknownParam[]
}

// Track properties (KVP encoding, no count prefix, read until end of payload)
export interface Draft18TrackProperties {
  object_delivery_timeout?: bigint // 0x02 even varint (renamed from delivery_timeout)
  max_cache_duration?: bigint // 0x04 even varint
  subgroup_delivery_timeout?: bigint // 0x06 even varint (NEW in draft-18)
  immutable_properties?: Uint8Array // 0x0b odd length-prefixed
  default_publisher_priority?: bigint // 0x0e even varint
  default_publisher_group_order?: bigint // 0x22 even varint
  dynamic_groups?: bigint // 0x30 even varint
  unknown?: UnknownParam[]
}

// Draft-18 message type tag union
export type Draft18MessageType =
  | 'setup'
  | 'subscribe'
  | 'subscribe_ok'
  | 'request_update'
  | 'publish'
  | 'publish_done'
  | 'publish_namespace'
  | 'namespace'
  | 'namespace_done'
  | 'subscribe_namespace'
  | 'subscribe_tracks'
  | 'publish_blocked'
  | 'fetch'
  | 'fetch_ok'
  | 'track_status'
  | 'request_ok'
  | 'request_error'
  | 'goaway'

// Base
export interface Draft18BaseMessage {
  readonly type: Draft18MessageType
}

// Setup — single unified message (0x2F00)
export interface Draft18Setup extends Draft18BaseMessage {
  readonly type: 'setup'
  readonly options: Draft18SetupOptions
}

// Subscribe — Required Request ID Delta REMOVED in draft-18
export interface Draft18Subscribe extends Draft18BaseMessage {
  readonly type: 'subscribe'
  readonly request_id: bigint
  readonly track_namespace: string[]
  readonly track_name: string
  readonly parameters: Draft18Params
}

export interface Draft18SubscribeOk extends Draft18BaseMessage {
  readonly type: 'subscribe_ok'
  readonly track_alias: bigint
  readonly parameters: Draft18Params
  readonly track_properties: Draft18TrackProperties
}

export interface Draft18RequestUpdate extends Draft18BaseMessage {
  readonly type: 'request_update'
  readonly request_id: bigint
  readonly parameters: Draft18Params
}

// Publish
export interface Draft18Publish extends Draft18BaseMessage {
  readonly type: 'publish'
  readonly request_id: bigint
  readonly track_namespace: string[]
  readonly track_name: string
  readonly track_alias: bigint
  readonly parameters: Draft18Params
  readonly track_properties: Draft18TrackProperties
}

export interface Draft18PublishDone extends Draft18BaseMessage {
  readonly type: 'publish_done'
  readonly status_code: bigint
  readonly stream_count: bigint
  readonly reason_phrase: string
}

// Namespace
export interface Draft18PublishNamespace extends Draft18BaseMessage {
  readonly type: 'publish_namespace'
  readonly request_id: bigint
  readonly track_namespace: string[]
  readonly parameters: Draft18Params
}

export interface Draft18Namespace extends Draft18BaseMessage {
  readonly type: 'namespace'
  readonly namespace_suffix: string[]
}

export interface Draft18NamespaceDone extends Draft18BaseMessage {
  readonly type: 'namespace_done'
  readonly namespace_suffix: string[]
}

// SUBSCRIBE_NAMESPACE — type 0x50, subscribe_options field removed in draft-18
export interface Draft18SubscribeNamespace extends Draft18BaseMessage {
  readonly type: 'subscribe_namespace'
  readonly request_id: bigint
  readonly namespace_prefix: string[]
  readonly parameters: Draft18Params
}

// SUBSCRIBE_TRACKS — NEW in draft-18, type 0x51
export interface Draft18SubscribeTracks extends Draft18BaseMessage {
  readonly type: 'subscribe_tracks'
  readonly request_id: bigint
  readonly namespace_prefix: string[]
  readonly parameters: Draft18Params
}

export interface Draft18PublishBlocked extends Draft18BaseMessage {
  readonly type: 'publish_blocked'
  readonly namespace_suffix: string[]
  readonly track_name: string
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
  readonly joining_request_id: bigint
  readonly joining_start: bigint
}

export interface Draft18Fetch extends Draft18BaseMessage {
  readonly type: 'fetch'
  readonly request_id: bigint
  readonly fetch_type: bigint
  readonly standalone?: StandaloneFetch
  readonly joining?: JoiningFetch
  readonly parameters: Draft18Params
}

export interface Draft18FetchOk extends Draft18BaseMessage {
  readonly type: 'fetch_ok'
  readonly end_of_track: number // uint8
  readonly end_group: bigint
  readonly end_object: bigint
  readonly parameters: Draft18Params
  readonly track_properties: Draft18TrackProperties
}

// Track Status — same format as subscribe in draft-18 (without required_request_id_delta)
export interface Draft18TrackStatus extends Draft18BaseMessage {
  readonly type: 'track_status'
  readonly request_id: bigint
  readonly track_namespace: string[]
  readonly track_name: string
  readonly parameters: Draft18Params
}

// REQUEST_OK — gained trailing Track Properties in draft-18
export interface Draft18RequestOk extends Draft18BaseMessage {
  readonly type: 'request_ok'
  readonly parameters: Draft18Params
  readonly track_properties: Draft18TrackProperties
}

// Redirect structure (used inside REQUEST_ERROR when error_code = REDIRECT 0x34)
export interface Redirect {
  readonly connect_uri: string
  readonly track_namespace: string[]
  readonly track_name: string
}

export interface Draft18RequestError extends Draft18BaseMessage {
  readonly type: 'request_error'
  readonly error_code: bigint
  readonly retry_interval: bigint
  readonly reason_phrase: string
  readonly redirect?: Redirect
}

// Session Control
export interface Draft18GoAway extends Draft18BaseMessage {
  readonly type: 'goaway'
  readonly new_session_uri: string
  readonly timeout: bigint
  readonly request_id?: bigint // Present only on control stream in draft-18
}

// Union of all draft-18 control messages
export type Draft18Message =
  | Draft18Setup
  | Draft18Subscribe
  | Draft18SubscribeOk
  | Draft18RequestUpdate
  | Draft18Publish
  | Draft18PublishDone
  | Draft18PublishNamespace
  | Draft18Namespace
  | Draft18NamespaceDone
  | Draft18SubscribeNamespace
  | Draft18SubscribeTracks
  | Draft18PublishBlocked
  | Draft18Fetch
  | Draft18FetchOk
  | Draft18TrackStatus
  | Draft18RequestOk
  | Draft18RequestError
  | Draft18GoAway

// Data stream types
export interface ObjectPayload {
  readonly type: 'object'
  readonly byteOffset: number
  readonly payloadByteOffset: number
  readonly objectId: bigint
  readonly payloadLength: number
  readonly status?: bigint
  readonly extensionData: Uint8Array
  readonly objectProperties?: Record<string, bigint>
  readonly payload: Uint8Array
}

export interface SubgroupStream {
  readonly type: 'subgroup'
  readonly headerType: number
  readonly trackAlias: bigint
  readonly groupId: bigint
  readonly subgroupId: bigint
  readonly publisherPriority: number
  readonly endOfGroup?: boolean
  readonly firstObject?: boolean
  readonly objects: ObjectPayload[]
}

export interface DatagramObject {
  readonly type: 'datagram'
  readonly datagramType: number
  readonly trackAlias: bigint
  readonly groupId: bigint
  readonly objectId: bigint
  readonly publisherPriority: number
  readonly endOfGroup?: boolean
  readonly objectStatus?: bigint
  readonly objectProperties?: Record<string, bigint>
  readonly payloadLength: number
  readonly payload: Uint8Array
}

export interface FetchObjectPayload extends ObjectPayload {
  readonly serializationFlags: number
  readonly groupId: bigint
  readonly subgroupId: bigint
  readonly publisherPriority: number
  readonly objectProperties?: Record<string, bigint>
}

export interface FetchStream {
  readonly type: 'fetch'
  readonly requestId: bigint
  readonly objects: FetchObjectPayload[]
}

export type Draft18DataStream = SubgroupStream | DatagramObject | FetchStream

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
