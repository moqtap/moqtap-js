// Draft-23 message types

// An unknown Setup Option, Property or Error Detail, kept for passthrough.
export interface UnknownParam {
  readonly id: string // e.g. "0x21"
  readonly length: number
  readonly raw_hex: string
}

/**
 * Token structure, draft-23 Section 8.9, Figure 5. Carried by the
 * AUTHORIZATION TOKEN parameter (Section 9.19.2) and Setup Option
 * (Section 9.1.4).
 */
export interface AuthorizationToken {
  readonly alias_type: bigint // 0=DELETE, 1=REGISTER, 2=USE_ALIAS, 3=USE_VALUE
  readonly token_alias?: bigint // present for DELETE(0), REGISTER(1), USE_ALIAS(2)
  readonly token_type?: bigint // present for REGISTER(1), USE_VALUE(3)
  readonly token_value?: Uint8Array // present for REGISTER(1), USE_VALUE(3)
}

// Setup Options (Key-Value-Pairs spanning the SETUP body, draft-23 Section 9.1)
export interface Draft23SetupOptions {
  path?: string // 0x01 odd
  authorization_token?: readonly AuthorizationToken[] // 0x03 odd
  max_auth_token_cache_size?: bigint // 0x04 even
  authority?: string // 0x05 odd
  max_filter_ranges?: bigint // 0x06 even
  moqt_implementation?: string // 0x07 odd
  max_request_updates?: bigint // 0x08 even
  /**
   * 0x09, draft-23 Section 9.1.8: "The value is encoded as a variable-length
   * integer and MUST be at least 65535. If not present, the default value is
   * 65535." The type is odd, so on the wire the value is a Length followed by
   * that one vi64.
   */
  max_control_message_size?: bigint
  unknown?: UnknownParam[]
}

/**
 * LOCATION_FILTER (0x21), draft-23 Section 9.19.9 and Table 6; semantics in
 * Section 3.3.1.
 *
 * `filter_type` is the Location Filter Type, and it alone decides which of the
 * four fields are present. The fields carry the wire values verbatim,
 * unresolved:
 *
 *  - 0x00 None: no fields, and there is no Location Filter. Inside
 *    FILL_PARAMETERS it makes the fill range "the entire track up to Largest
 *    Object" (Section 3.4).
 *  - 0x01 Relative Start: `start_group` alone, relative: the start is
 *    {Largest Object.Group + 1 - start_group, 0}. Open-ended.
 *  - 0x02 Absolute Start: {start_group, start_object}. Open-ended.
 *  - 0x03 Absolute Start, Group End: as 0x02, ending with the last Object of
 *    Group `start_group + end_group_delta`.
 *  - 0x04 Absolute Range: the inclusive range {start_group, start_object} …
 *    {start_group + end_group_delta, end_object}.
 *  - 0x05 Next Object: no fields. Open-ended.
 */
export interface LocationFilter {
  readonly filter_type: bigint
  readonly start_group?: bigint
  readonly start_object?: bigint
  readonly end_group_delta?: bigint
  readonly end_object?: bigint
}

// Range Filter (0x25-0x29), draft-23 Section 3.3.2, Section 8.6.
export interface RangeFilterRange {
  readonly start: bigint
  readonly end?: bigint // omitted on the final Range = open-ended (no upper bound)
}

export interface RangeFilter {
  readonly set_id?: bigint
  readonly property_type?: bigint // only for OBJECT_PROPERTY_FILTER / TRACK_PROPERTY_FILTER
  readonly ranges?: RangeFilterRange[]
  readonly removed?: boolean // Length 0: no filter, which removes one in REQUEST_UPDATE
}

// Location value of LARGEST_OBJECT (0x09)
export interface LargestObject {
  readonly group: bigint
  readonly object: bigint
}

/**
 * FILL_PARAMETERS (0x23) value, draft-23 Section 9.19.15: "Its value is a
 * Number of Parameters (vi64) followed by that many Parameters that apply to
 * the fill fetch stream (see Section 3.4)". Table 7 permits exactly these
 * eight types inside it.
 *
 * Presence is what requests a fill fetch stream, so an empty value is
 * meaningful.
 */
export interface Draft23FillParameters {
  fill_timeout?: bigint // 0x0a varint
  subscriber_priority?: bigint // 0x20 uint8
  location_filter?: LocationFilter // 0x21 type-led, no length
  group_order?: bigint // 0x22 uint8
  // A filter parameter carries one SetID, so two alternatives over the same
  // field need two parameters (Section 3.3.2). A single filter is a
  // one-element list.
  subgroup_filter?: readonly RangeFilter[] // 0x25 length-prefixed
  objectid_filter?: readonly RangeFilter[] // 0x26 length-prefixed
  priority_filter?: readonly RangeFilter[] // 0x27 length-prefixed
  object_property_filter?: readonly RangeFilter[] // 0x28 length-prefixed
}

// Message Parameters (draft-23 Section 9.19, Table 14)
export interface Draft23Params {
  object_delivery_timeout?: bigint // 0x02 varint
  authorization_token?: readonly AuthorizationToken[] // 0x03 length-prefixed Token
  rendezvous_timeout?: bigint // 0x04 varint
  subgroup_delivery_timeout?: bigint // 0x06 varint
  expires?: bigint // 0x08 varint
  largest_object?: LargestObject // 0x09 Location (two bare varints)
  fill_timeout?: bigint // 0x0a varint
  /** 0x11 uint8, draft-23 Section 9.19.18: "0 (unpaused) or 1 (paused)". */
  paused?: bigint
  subscriber_priority?: bigint // 0x20 uint8
  location_filter?: LocationFilter // 0x21 type-led, no length; see LocationFilter
  group_order?: bigint // 0x22 uint8
  fill_parameters?: Draft23FillParameters // 0x23 count-prefixed parameter block
  // A filter parameter carries one SetID, so two alternatives over the same
  // field need two parameters (Section 3.3.2). A single filter is a
  // one-element list.
  subgroup_filter?: readonly RangeFilter[] // 0x25 length-prefixed
  objectid_filter?: readonly RangeFilter[] // 0x26 length-prefixed
  priority_filter?: readonly RangeFilter[] // 0x27 length-prefixed
  object_property_filter?: readonly RangeFilter[] // 0x28 length-prefixed
  track_property_filter?: readonly RangeFilter[] // 0x29 length-prefixed
  new_group_request?: bigint // 0x32 varint
  track_namespace_prefix?: string[] // 0x34 Track Namespace encoding
  include_properties?: bigint // 0x35 uint8, 0 or 1
  /**
   * 0x36 varint, draft-23 Section 9.19.21: "It appears only in a PUBLISH sent
   * as a result of a SUBSCRIBE_TRACKS, and contains that SUBSCRIBE_TRACKS's
   * Request ID."
   */
  subscribe_tracks_id?: bigint
  unknown?: UnknownParam[]
}

// Track Properties (Key-Value-Pairs to the end of the message, draft-23 Section 8.4)
export interface Draft23TrackProperties {
  object_delivery_timeout?: bigint // 0x02 even varint
  max_cache_duration?: bigint // 0x04 even varint
  subgroup_delivery_timeout?: bigint // 0x06 even varint
  immutable_properties?: Uint8Array // 0x0b odd length-prefixed
  default_publisher_priority?: bigint // 0x0e even varint
  default_publisher_group_order?: bigint // 0x22 even varint
  dynamic_groups?: bigint // 0x30 even varint
  unknown?: UnknownParam[]
}

/**
 * The value of the REDIRECT Error Detail, draft-23 Section 9.4.2.1: the
 * Connect URI and "The Track Namespace and Track Name to use for the
 * redirected request, together referred to as the Redirect target."
 */
export interface Redirect {
  readonly connect_uri: string
  readonly track_namespace: string[]
  readonly track_name: string
}

/**
 * REQUEST_ERROR Error Details, draft-23 Section 9.4.1: Key-Value-Pairs
 * "spanning the remainder of the message"; their rules are in Section 9.4.2.
 *
 * "Receivers MUST ignore unknown Error Detail types, and MUST ignore a known
 * Error Detail type that accompanies an Error Code it is not defined for." Both
 * are still decoded and kept here; ignoring them is the reader's decision.
 */
export interface Draft23ErrorDetails {
  redirect?: Redirect // 0x01 odd
  /**
   * 0x02 even, one Property Type per instance. Section 9.4.2.2: "Multiple
   * instances of this type are allowed."
   */
  unsupported_property?: readonly bigint[]
  /** Unknown types, and any REDIRECT after the first, as raw bytes. */
  unknown?: UnknownParam[]
}

// Draft-23 message type tag union
export type Draft23MessageType =
  | 'setup'
  | 'subscribe'
  | 'subscribe_ok'
  | 'request_update'
  | 'publish_state_notify'
  | 'publish'
  | 'publish_done'
  | 'publish_namespace'
  | 'namespace'
  | 'namespace_done'
  | 'subscribe_namespace'
  | 'subscribe_tracks'
  | 'publish_skipped'
  | 'fetch'
  | 'track_status'
  | 'request_ok'
  | 'request_error'
  | 'goaway'

// Base
export interface Draft23BaseMessage {
  readonly type: Draft23MessageType
}

// SETUP (0x2F00), draft-23 Section 9.1
export interface Draft23Setup extends Draft23BaseMessage {
  readonly type: 'setup'
  readonly options: Draft23SetupOptions
}

export interface Draft23Subscribe extends Draft23BaseMessage {
  readonly type: 'subscribe'
  readonly request_id: bigint
  readonly track_namespace: string[]
  readonly track_name: string
  readonly parameters: Draft23Params
}

export interface Draft23SubscribeOk extends Draft23BaseMessage {
  readonly type: 'subscribe_ok'
  readonly track_alias: bigint
  readonly parameters: Draft23Params
  readonly track_properties: Draft23TrackProperties
}

export interface Draft23RequestUpdate extends Draft23BaseMessage {
  readonly type: 'request_update'
  readonly request_id: bigint
  readonly parameters: Draft23Params
}

/**
 * PUBLISH_STATE_NOTIFY (0x22), draft-23 Section 9.10. No Request ID: the
 * subscription's bidirectional stream identifies it.
 */
export interface Draft23PublishStateNotify extends Draft23BaseMessage {
  readonly type: 'publish_state_notify'
  readonly parameters: Draft23Params
}

export interface Draft23Publish extends Draft23BaseMessage {
  readonly type: 'publish'
  readonly request_id: bigint
  readonly track_namespace: string[]
  readonly track_name: string
  readonly track_alias: bigint
  readonly parameters: Draft23Params
  readonly track_properties: Draft23TrackProperties
}

export interface Draft23PublishDone extends Draft23BaseMessage {
  readonly type: 'publish_done'
  readonly status_code: bigint
  /**
   * Number of streams opened for the subscription, including fill fetch
   * streams (Section 9.9), or `UNKNOWN_STREAM_COUNT` (2^64 - 1) when the
   * publisher cannot state it exactly. `bigint`: the sentinel does not fit a
   * double.
   */
  readonly stream_count: bigint
  readonly reason_phrase: string
}

export interface Draft23PublishNamespace extends Draft23BaseMessage {
  readonly type: 'publish_namespace'
  readonly request_id: bigint
  /**
   * The field draft-23 Section 9.13 names Track Namespace Prefix: "A Track
   * Namespace as defined in Section 8.7, matched as a prefix (see
   * Section 2.4.2)". Keyed `track_namespace` so that consumers read every draft alike.
   */
  readonly track_namespace: string[]
  readonly parameters: Draft23Params
}

/**
 * NAMESPACE (0x8), draft-23 Section 9.15: "When Parameters of a NAMESPACE
 * change, the NAMESPACE message is sent again with the updated Parameters."
 */
export interface Draft23Namespace extends Draft23BaseMessage {
  readonly type: 'namespace'
  readonly namespace_suffix: string[]
  readonly parameters: Draft23Params
}

export interface Draft23NamespaceDone extends Draft23BaseMessage {
  readonly type: 'namespace_done'
  readonly namespace_suffix: string[]
}

export interface Draft23SubscribeNamespace extends Draft23BaseMessage {
  readonly type: 'subscribe_namespace'
  readonly request_id: bigint
  readonly namespace_prefix: string[]
  readonly parameters: Draft23Params
}

export interface Draft23SubscribeTracks extends Draft23BaseMessage {
  readonly type: 'subscribe_tracks'
  readonly request_id: bigint
  readonly namespace_prefix: string[]
  readonly parameters: Draft23Params
}

export interface Draft23PublishSkipped extends Draft23BaseMessage {
  readonly type: 'publish_skipped'
  readonly namespace_suffix: string[]
  readonly track_name: string
}

/**
 * FETCH (0x16), draft-23 Section 9.11. The range travels in the
 * LOCATION_FILTER parameter; without one a FETCH covers {0, 0} through
 * Largest Object, inclusive (Section 3.2).
 */
export interface Draft23Fetch extends Draft23BaseMessage {
  readonly type: 'fetch'
  readonly request_id: bigint
  readonly track_namespace: string[]
  readonly track_name: string
  readonly parameters: Draft23Params
}

// TRACK_STATUS (0xD), draft-23 Section 9.12: "identical to the SUBSCRIBE message"
export interface Draft23TrackStatus extends Draft23BaseMessage {
  readonly type: 'track_status'
  readonly request_id: bigint
  readonly track_namespace: string[]
  readonly track_name: string
  readonly parameters: Draft23Params
}

/**
 * REQUEST_OK (0x7), draft-23 Section 9.3: the PUBLISH_OK, FETCH_OK,
 * REQUEST_UPDATE_OK, TRACK_STATUS_OK, SUBSCRIBE_NAMESPACE_OK,
 * SUBSCRIBE_TRACKS_OK and PUBLISH_NAMESPACE_OK of Section 1.5. The frame does
 * not say which; see `checkRequestOk` in `rules.ts`.
 */
export interface Draft23RequestOk extends Draft23BaseMessage {
  readonly type: 'request_ok'
  readonly parameters: Draft23Params
  readonly track_properties: Draft23TrackProperties
}

export interface Draft23RequestError extends Draft23BaseMessage {
  readonly type: 'request_error'
  readonly error_code: bigint
  readonly retry_interval: bigint
  readonly reason_phrase: string
  readonly error_details: Draft23ErrorDetails
}

export interface Draft23GoAway extends Draft23BaseMessage {
  readonly type: 'goaway'
  readonly new_session_uri: string
  readonly timeout: bigint
}

// Union of all draft-23 control messages
export type Draft23Message =
  | Draft23Setup
  | Draft23Subscribe
  | Draft23SubscribeOk
  | Draft23RequestUpdate
  | Draft23PublishStateNotify
  | Draft23Publish
  | Draft23PublishDone
  | Draft23PublishNamespace
  | Draft23Namespace
  | Draft23NamespaceDone
  | Draft23SubscribeNamespace
  | Draft23SubscribeTracks
  | Draft23PublishSkipped
  | Draft23Fetch
  | Draft23TrackStatus
  | Draft23RequestOk
  | Draft23RequestError
  | Draft23GoAway

// ─── Data stream types ──────────────────────────────────────────────────────

export interface ObjectPayload {
  readonly type: 'object'
  readonly byteOffset: number
  readonly payloadByteOffset: number
  readonly objectId: bigint
  /** The Object ID Delta as it appeared on the wire, before delta resolution. */
  readonly objectIdDelta?: bigint
  readonly payloadLength: number
  readonly status?: bigint
  /** The raw property block, empty when none; decode with `decodeObjectProperties`. */
  readonly extensionData: Uint8Array
  /**
   * Absolute offset of the property block's first byte, past its length field.
   * Absent when the Object had no properties field at all.
   */
  readonly extensionDataByteOffset?: number
  readonly payload: Uint8Array
}

export interface SubgroupStream {
  readonly type: 'subgroup'
  /** SUBGROUP_HEADER `Type Flags` (draft-23 Section 11.3.1). */
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
  /** OBJECT_DATAGRAM `Type Flags` (draft-23 Section 11.2.1). */
  readonly datagramType: number
  readonly trackAlias: bigint
  readonly groupId: bigint
  readonly objectId: bigint
  readonly publisherPriority: number
  readonly endOfGroup?: boolean
  readonly objectStatus?: bigint
  /** The raw property block, absent when the PROPERTIES bit is clear; see `decodeObjectProperties`. */
  readonly extensionData?: Uint8Array
  /**
   * Absolute offset of the property block's first byte, past its length field.
   * Absent when the Object had no properties field at all.
   */
  readonly extensionDataByteOffset?: number
  readonly payloadLength: number
  readonly payload: Uint8Array
}

/**
 * One entry on a fetch stream after the FETCH_HEADER: an Object, or one of
 * the indicators of draft-23 Section 11.4.1, Table 8, told apart by
 * `serializationFlags`.
 *
 *  - An End of Range indicator (0x8C, 0x10C, 0x20C, 0x40C) carries the
 *    Location it ends at in `groupId` / `objectId`, the wire deltas in
 *    `groupIdDelta` / `objectIdDelta`, and an empty payload.
 *  - End of Group (0x80) and End of Track (0x81) have no fields on the wire
 *    (Section 11.4.2.2). `groupId` and `objectId` name the prior Object they
 *    mark as the last in its Group or Track, and there are no deltas.
 *
 * An indicator has no Subgroup ID or Priority of its own; it carries the last
 * actual Object's, which is what a following Object that references the prior
 * Object gets.
 */
export interface FetchObjectPayload extends ObjectPayload {
  readonly serializationFlags: number
  readonly groupId: bigint
  /** The Group ID Delta as it appeared on the wire, before delta resolution. */
  readonly groupIdDelta?: bigint
  readonly subgroupId: bigint
  readonly publisherPriority: number
}

export interface FetchStream {
  readonly type: 'fetch'
  /**
   * The Request ID of the message that opened the stream: a FETCH, or for a
   * fill fetch stream (Section 3.4) the subscription's SUBSCRIBE or PUBLISH,
   * or the REQUEST_UPDATE that requested a later fill.
   */
  readonly requestId: bigint
  readonly objects: FetchObjectPayload[]
}

export type Draft23DataStream = SubgroupStream | DatagramObject | FetchStream

// Streaming data stream decoder types
export interface SubgroupStreamHeader {
  readonly type: 'subgroup_header'
  /** SUBGROUP_HEADER `Type Flags`, the same value `SubgroupStream.headerType` carries. */
  readonly headerType: number
  readonly trackAlias: bigint
  readonly groupId: bigint
  /**
   * Under Subgroup Mode 0b01 this is the first Object's ID, which is why the
   * header is not emitted until that Object has been read.
   */
  readonly subgroupId: bigint
  readonly publisherPriority: number
  readonly endOfGroup?: boolean
  readonly firstObject?: boolean
}

export interface FetchStreamHeader {
  readonly type: 'fetch_header'
  readonly requestId: bigint
}

export type DataStreamHeader = SubgroupStreamHeader | FetchStreamHeader
export type DataStreamEvent = DataStreamHeader | ObjectPayload
