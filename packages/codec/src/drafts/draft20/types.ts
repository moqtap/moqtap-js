// Draft-20 specific message types

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

// Setup options (KVP encoding, no count prefix) — unchanged from draft-19
export interface Draft20SetupOptions {
  path?: string // 0x01 odd
  authorization_token?: AuthorizationToken // 0x03 odd
  max_auth_token_cache_size?: bigint // 0x04 even
  authority?: string // 0x05 odd
  max_filter_ranges?: bigint // 0x06 even
  moqt_implementation?: string // 0x07 odd
  max_request_updates?: bigint // 0x08 even
  unknown?: UnknownParam[]
}

/**
 * LOCATION_FILTER (0x21) — restructured in draft-20 (Section 5.1.2).
 *
 * The draft-19 `Filter Type` discriminator (0x1 Next Group Start / 0x2 Largest
 * Object / 0x3 AbsoluteStart / 0x4 AbsoluteRange) is gone; the shape is the
 * number of vi64 fields the value holds. The fields below carry the wire
 * values verbatim, unresolved:
 *
 *  - 1 field  → `start_group` alone is RELATIVE: start is
 *               {Largest Object.Group + 1 - start_group, 0}. Open-ended.
 *  - 2 fields → absolute start {start_group, start_object}, except that
 *               {0, 0} means the Next Object. Open-ended.
 *  - 3 fields → end group is `start_group + end_group_delta`; `end_object`
 *               omitted means every object in that group.
 *  - 4 fields → the fully specified INCLUSIVE range
 *               {start_group, start_object} … {start_group + end_group_delta,
 *               end_object}.
 *
 * `removed: true` is the `Length == 0` form, which in REQUEST_UPDATE removes an
 * existing filter.
 *
 * The range is inclusive at both ends. draft-19's "last Object, plus 1" and
 * "Object == 0 means the whole group" conventions are gone, so nothing here is
 * ever incremented or decremented on the way in or out.
 */
export interface LocationFilter {
  readonly start_group?: bigint
  readonly start_object?: bigint
  readonly end_group_delta?: bigint
  readonly end_object?: bigint
  readonly removed?: boolean // Length == 0: no filter / remove the filter
}

// Range Filter parameter (0x25-0x29). Selects Objects/Tracks by integer
// ranges over Object header fields or Property values.
export interface RangeFilterRange {
  readonly start: bigint
  readonly end?: bigint // omitted on the final Range = open-ended (no upper bound)
}

export interface RangeFilter {
  readonly set_id?: bigint
  readonly property_type?: bigint // only for OBJECT_PROPERTY_FILTER / TRACK_PROPERTY_FILTER
  readonly ranges?: RangeFilterRange[]
  readonly removed?: boolean // REQUEST_UPDATE length-0 form: remove this filter
}

// Largest object location parameter
export interface LargestObject {
  readonly group: bigint
  readonly object: bigint
}

/**
 * FILL_PARAMETERS (0x23) value — NEW in draft-20 (Section 10.2.15).
 *
 * A separate parameter scope carrying only the settings that differ from the
 * subscription's. Table 6 closes the list to exactly these eight types;
 * TRACK_PROPERTY_FILTER (0x29) is deliberately excluded.
 *
 * The mere presence of the parameter is what requests a fill fetch stream, so
 * an empty value is meaningful — it asks for a fill with everything inherited.
 */
export interface Draft20FillParameters {
  fill_timeout?: bigint // 0x0a varint
  subscriber_priority?: bigint // 0x20 uint8
  location_filter?: LocationFilter // 0x21 length-prefixed — selects the FILL range
  group_order?: bigint // 0x22 uint8
  subgroup_filter?: RangeFilter // 0x25 length-prefixed
  objectid_filter?: RangeFilter // 0x26 length-prefixed
  priority_filter?: RangeFilter // 0x27 length-prefixed
  object_property_filter?: RangeFilter // 0x28 length-prefixed
}

// Message Parameters (delta-encoded types, count-prefixed)
export interface Draft20Params {
  object_delivery_timeout?: bigint // 0x02 varint
  authorization_token?: AuthorizationToken // 0x03 length-prefixed nested
  rendezvous_timeout?: bigint // 0x04 varint
  subgroup_delivery_timeout?: bigint // 0x06 varint
  expires?: bigint // 0x08 varint
  largest_object?: LargestObject // 0x09 Location (2 bare varints, NOT length-prefixed)
  fill_timeout?: bigint // 0x0a varint
  forward?: bigint // 0x10 uint8
  subscriber_priority?: bigint // 0x20 uint8
  location_filter?: LocationFilter // 0x21 length-prefixed (restructured in draft-20)
  group_order?: bigint // 0x22 uint8
  fill_parameters?: Draft20FillParameters // 0x23 length-prefixed nested (NEW in draft-20)
  subgroup_filter?: RangeFilter // 0x25 length-prefixed
  objectid_filter?: RangeFilter // 0x26 length-prefixed
  priority_filter?: RangeFilter // 0x27 length-prefixed
  object_property_filter?: RangeFilter // 0x28 length-prefixed
  track_property_filter?: RangeFilter // 0x29 length-prefixed
  new_group_request?: bigint // 0x32 varint
  track_namespace_prefix?: string[] // 0x34 Track Namespace encoding
  include_properties?: bigint // 0x35 uint8, 0 or 1, default 1 (NEW in draft-20)
  unknown?: UnknownParam[]
}

// Track properties (KVP encoding, no count prefix, read until end of payload)
export interface Draft20TrackProperties {
  object_delivery_timeout?: bigint // 0x02 even varint
  max_cache_duration?: bigint // 0x04 even varint
  subgroup_delivery_timeout?: bigint // 0x06 even varint
  immutable_properties?: Uint8Array // 0x0b odd length-prefixed
  default_publisher_priority?: bigint // 0x0e even varint
  default_publisher_group_order?: bigint // 0x22 even varint
  dynamic_groups?: bigint // 0x30 even varint
  unknown?: UnknownParam[]
}

// Draft-20 message type tag union
export type Draft20MessageType =
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
  | 'fetch_ok'
  | 'track_status'
  | 'request_ok'
  | 'request_error'
  | 'goaway'

// Base
export interface Draft20BaseMessage {
  readonly type: Draft20MessageType
}

// Setup — single unified message (0x2F00)
export interface Draft20Setup extends Draft20BaseMessage {
  readonly type: 'setup'
  readonly options: Draft20SetupOptions
}

export interface Draft20Subscribe extends Draft20BaseMessage {
  readonly type: 'subscribe'
  readonly request_id: bigint
  readonly track_namespace: string[]
  readonly track_name: string
  readonly parameters: Draft20Params
}

export interface Draft20SubscribeOk extends Draft20BaseMessage {
  readonly type: 'subscribe_ok'
  readonly track_alias: bigint
  readonly parameters: Draft20Params
  readonly track_properties: Draft20TrackProperties
}

export interface Draft20RequestUpdate extends Draft20BaseMessage {
  readonly type: 'request_update'
  readonly request_id: bigint
  readonly parameters: Draft20Params
}

/**
 * PUBLISH_STATE_NOTIFY (0x22) — NEW in draft-20, Section 10.10.
 *
 * No Request ID: the message is identified by the subscription's bidirectional
 * stream it arrives on, like SUBSCRIBE_OK, PUBLISH_DONE and FETCH_OK.
 */
export interface Draft20PublishStateNotify extends Draft20BaseMessage {
  readonly type: 'publish_state_notify'
  readonly parameters: Draft20Params
}

export interface Draft20Publish extends Draft20BaseMessage {
  readonly type: 'publish'
  readonly request_id: bigint
  readonly track_namespace: string[]
  readonly track_name: string
  readonly track_alias: bigint
  readonly parameters: Draft20Params
  readonly track_properties: Draft20TrackProperties
}

export interface Draft20PublishDone extends Draft20BaseMessage {
  readonly type: 'publish_done'
  readonly status_code: bigint
  /**
   * Number of streams opened for the subscription, including empty subgroups
   * and — new in draft-20 — fill fetch streams (Section 10.12), or the
   * `UNKNOWN_STREAM_COUNT` sentinel exported from `codec.ts` (2^64 - 1, raised
   * from draft-19's 2^62 - 1) when the publisher cannot state it exactly.
   *
   * `bigint`, not `number`: the sentinel does not fit a double.
   */
  readonly stream_count: bigint
  readonly reason_phrase: string
}

export interface Draft20PublishNamespace extends Draft20BaseMessage {
  readonly type: 'publish_namespace'
  readonly request_id: bigint
  readonly track_namespace: string[]
  readonly parameters: Draft20Params
}

export interface Draft20Namespace extends Draft20BaseMessage {
  readonly type: 'namespace'
  readonly namespace_suffix: string[]
}

export interface Draft20NamespaceDone extends Draft20BaseMessage {
  readonly type: 'namespace_done'
  readonly namespace_suffix: string[]
}

export interface Draft20SubscribeNamespace extends Draft20BaseMessage {
  readonly type: 'subscribe_namespace'
  readonly request_id: bigint
  readonly namespace_prefix: string[]
  readonly parameters: Draft20Params
}

export interface Draft20SubscribeTracks extends Draft20BaseMessage {
  readonly type: 'subscribe_tracks'
  readonly request_id: bigint
  readonly namespace_prefix: string[]
  readonly parameters: Draft20Params
}

export interface Draft20PublishSkipped extends Draft20BaseMessage {
  readonly type: 'publish_skipped'
  readonly namespace_suffix: string[]
  readonly track_name: string
}

/**
 * FETCH (0x16) — the byte layout was rewritten in draft-20 (Section 10.13).
 *
 * Gone: the `Fetch Type` field and its enum, the `Standalone Fetch` and
 * `Joining Fetch` structures, and the inline `Start Location` / `End Location`.
 * Track Namespace and Track Name are inline fields of FETCH itself, and the
 * range travels in the LOCATION_FILTER parameter. A FETCH with no
 * LOCATION_FILTER covers {0,0} through Largest Object, inclusive.
 *
 * The codepoint did not change, so a draft-19 decoder fed one of these reads
 * the Number of Track Namespace Fields count as a Fetch Type and mis-parses in
 * silence. There is no in-band version signal that catches it.
 */
export interface Draft20Fetch extends Draft20BaseMessage {
  readonly type: 'fetch'
  readonly request_id: bigint
  readonly track_namespace: string[]
  readonly track_name: string
  readonly parameters: Draft20Params
}

/**
 * FETCH_OK (0x18) — bytes identical to draft-19, meaning changed.
 *
 * `end_group` / `end_object` are the INCLUSIVE end of the range the response
 * covers: the last Object actually covered. draft-19's "the last Object, plus
 * 1; or 0 to indicate the entire Group" is gone (draft-20 Section 10.14 with
 * Section 5.1.2). The same bytes mean a different object under the two drafts,
 * and nothing on the wire distinguishes them.
 */
export interface Draft20FetchOk extends Draft20BaseMessage {
  readonly type: 'fetch_ok'
  readonly end_of_track: number // uint8
  readonly end_group: bigint
  readonly end_object: bigint
  readonly parameters: Draft20Params
  readonly track_properties: Draft20TrackProperties
}

// Track Status — same format as SUBSCRIBE with the type set to 0xD
export interface Draft20TrackStatus extends Draft20BaseMessage {
  readonly type: 'track_status'
  readonly request_id: bigint
  readonly track_namespace: string[]
  readonly track_name: string
  readonly parameters: Draft20Params
}

// REQUEST_OK — also the PUBLISH_OK / REQUEST_UPDATE_OK / TRACK_STATUS_OK alias
export interface Draft20RequestOk extends Draft20BaseMessage {
  readonly type: 'request_ok'
  readonly parameters: Draft20Params
  readonly track_properties: Draft20TrackProperties
}

/**
 * Redirect structure, used inside REQUEST_ERROR when error_code = REDIRECT (0x34).
 *
 * draft-20 Section 10.6.1 names the namespace/name pair "the Redirect target"
 * and dropped draft-19's rule that a zero-length pair meant "reuse the values
 * from the original request". An empty namespace and name are now a literal
 * empty namespace and name.
 */
export interface Redirect {
  readonly connect_uri: string
  readonly track_namespace: string[]
  readonly track_name: string
}

export interface Draft20RequestError extends Draft20BaseMessage {
  readonly type: 'request_error'
  readonly error_code: bigint
  readonly retry_interval: bigint
  readonly reason_phrase: string
  readonly redirect?: Redirect
}

export interface Draft20GoAway extends Draft20BaseMessage {
  readonly type: 'goaway'
  readonly new_session_uri: string
  readonly timeout: bigint
}

// Union of all draft-20 control messages
export type Draft20Message =
  | Draft20Setup
  | Draft20Subscribe
  | Draft20SubscribeOk
  | Draft20RequestUpdate
  | Draft20PublishStateNotify
  | Draft20Publish
  | Draft20PublishDone
  | Draft20PublishNamespace
  | Draft20Namespace
  | Draft20NamespaceDone
  | Draft20SubscribeNamespace
  | Draft20SubscribeTracks
  | Draft20PublishSkipped
  | Draft20Fetch
  | Draft20FetchOk
  | Draft20TrackStatus
  | Draft20RequestOk
  | Draft20RequestError
  | Draft20GoAway

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
  readonly extensionData: Uint8Array
  readonly objectProperties?: Record<string, bigint>
  readonly payload: Uint8Array
}

export interface SubgroupStream {
  readonly type: 'subgroup'
  /** SUBGROUP_HEADER `Type Flags` (draft-20 Section 11.4.2). */
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
  /** OBJECT_DATAGRAM `Type Flags` (draft-20 Section 11.3.1). */
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
  /** The Group ID Delta as it appeared on the wire, before delta resolution. */
  readonly groupIdDelta?: bigint
  readonly subgroupId: bigint
  readonly publisherPriority: number
  readonly objectProperties?: Record<string, bigint>
}

export interface FetchStream {
  readonly type: 'fetch'
  /**
   * The Request ID of the message that opened the stream. In draft-20 that is
   * not necessarily a FETCH: a fill fetch stream (Section 5.1.3) carries the
   * Request ID of the SUBSCRIBE or REQUEST_UPDATE that requested the fill.
   */
  readonly requestId: bigint
  readonly objects: FetchObjectPayload[]
}

export type Draft20DataStream = SubgroupStream | DatagramObject | FetchStream

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
