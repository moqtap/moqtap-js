/**
 * Any string other than the ones named beside it.
 *
 * Unions built with this keep editor completion for the values this version
 * knows, while still accepting a value it does not. Nothing in the format
 * rejects an unrecognised string: new perspectives, detail levels and drop
 * policies may be added without a version bump, and a reader that refused one
 * would refuse a file it can otherwise read in full.
 */
type OtherString = string & Record<never, never>

export type DetailLevel =
  | 'control'
  | 'headers'
  | 'headers+sizes'
  | 'headers+data'
  | 'full'
  | OtherString

export type Perspective = 'client' | 'server' | 'observer' | 'relay-tap' | OtherString

/** Drop strategy a sampled source applied when it could not keep up. */
export type DropPolicy = 'head' | 'tail' | 'sampled' | OtherString

/** Length of a trace ID, in bytes. Fixed by the format. */
export const TRACE_ID_LENGTH = 16

/**
 * Per-segment metadata.
 *
 * Present only in segmented traces. A single-shot file must not carry it —
 * its absence is what tells a reader that sequence numbers and timestamps are
 * file-global rather than segment-local.
 */
export interface SegmentInfo {
  /** 0-based sequence number of this segment within the stream. */
  readonly sequence: number
  /** Nominal segment duration in milliseconds. A hint; the real one may differ. */
  readonly durationMs?: number
  /** Opaque identifier shared by every segment of the same logical stream. */
  readonly streamId?: string
  /** True if this segment continues a previous one with the same `streamId`. */
  readonly continues?: boolean
}

/**
 * Sampling and filtering metadata. Present only when events were dropped or
 * filtered at the source; its absence means the trace is complete relative to
 * its detail level.
 */
export interface SamplingInfo {
  /** Fraction of source events retained, in (0, 1]. */
  readonly effectiveRate?: number
  /** Per-segment cap that triggered drops, if rate-limited. */
  readonly maxEventsPerSec?: number
  /** Drop strategy applied when the cap was exceeded. */
  readonly dropPolicy?: DropPolicy
  /** Cumulative events dropped since `startTime`. */
  readonly droppedTotal?: number
  /** Events dropped within this segment only. */
  readonly droppedSegment?: number
  /** Source-side filter rule that selected events. */
  readonly rule?: string
  /** Language the rule is written in ('prefix', 'glob', 'cel'). */
  readonly ruleLang?: string
  /** Event type IDs the drop policy was applied to. */
  readonly appliesTo?: number[]
}

export interface TraceHeader {
  readonly protocol: string
  readonly perspective: Perspective
  readonly detail: DetailLevel
  /**
   * Recording start (Unix epoch milliseconds). In a segmented trace this is
   * the segment's start, not the stream's.
   */
  readonly startTime: number
  readonly endTime?: number
  readonly transport?: string
  readonly source?: string
  readonly endpoint?: string
  readonly sessionId?: string
  /** Present only when this header begins one segment of a segmented stream. */
  readonly segment?: SegmentInfo
  /** Present only when events were dropped or filtered at the source. */
  readonly sampling?: SamplingInfo
  readonly custom?: Record<string, unknown>
}

interface BaseEvent {
  /**
   * Monotonically increasing sequence number. Segment-local in a segmented
   * trace, so ordering across segments is `(segment.sequence, seq)`.
   */
  readonly seq: number
  /** Microseconds since the containing segment's `startTime`. */
  readonly timestamp: number
  /**
   * Which peer this event pertains to.
   *
   * Required when the perspective is `'relay-tap'`, where one trace covers
   * many concurrent sessions; omitted otherwise. The identifier is
   * source-local: the same string in two traces from different sources does
   * not name the same peer.
   */
  readonly peer?: string
  /**
   * Keys on this event that this version of the package does not recognise,
   * kept verbatim.
   *
   * Optional keys may be added to an existing event type without a format
   * version bump, so "unknown keys MUST be ignored" is a rule about *reading
   * past* them. It is not a licence to drop them: a tool that reads a trace
   * and writes it back — a redaction pass, a filter, an annotated download —
   * would otherwise emit a valid file that looks like it never carried them,
   * and one tool's ignorance would become permanent for every reader
   * downstream of it.
   *
   * A key this version *does* know counts as unrecognised when its value is of
   * a type the field cannot hold — a `"ta"` carrying text, say. It is kept
   * here rather than coerced into the field or dropped, and written back
   * unchanged, exactly as a key nobody had heard of would be. Knowing more
   * about a key must not mean preserving it less.
   *
   * {@link UnknownEvent} already does this for an event type the package
   * cannot name. This is the same guarantee one level down, for a key on a
   * type it can. It is always absent on an `UnknownEvent`, whose `fields`
   * hold every non-common key already.
   */
  readonly extra?: Record<string, unknown>
}

export interface ControlMessageEvent extends BaseEvent {
  readonly type: 'control'
  readonly direction: 0 | 1
  readonly messageType: number
  /**
   * The message's decoded fields — the `"msg"` field of Event 0.
   *
   * A writer MUST produce a map here, keyed in snake_case (`request_id`,
   * `track_alias`), and an empty one when it decoded nothing. A *reader* has
   * to accept less, because files written before the format said so exist:
   * every `capture-*` case in the conformance corpus carries a Rust `Debug`
   * rendering of the message instead — `'Draft16(ClientSetup(ClientSetup {
   * parameters: [] }))'` — and the format requires such a value to be handed
   * back unchanged rather than rejected or replaced.
   *
   * So the type is `unknown`, not `Record<string, unknown>`. The `Record` was
   * a lie the compiler could not catch: `event.message.request_id` typechecks
   * against a string and reads `undefined` at runtime, on exactly the files
   * this rule exists for. Narrow before reading keys — {@link
   * controlMessageFields} does it correctly.
   */
  readonly message: unknown
  readonly raw?: Uint8Array
  /**
   * QUIC stream the message travelled on.
   *
   * Optional, and only meaningful for a recorder that knows it. It matters
   * from draft-17, where the control plane is no longer one stream: each
   * request gets its own bidirectional stream and responses carry no request
   * id, so the stream is the only thing tying a response to its request.
   */
  readonly streamId?: bigint
}

/**
 * The decoded fields of a control message, or `undefined` when its `"msg"` is
 * not a map and there are no fields to address.
 *
 * Provided because the narrowing is easy to get wrong once per call site and
 * silently: `typeof message === 'object'` also admits `null`, a CBOR array,
 * and a byte string, each of which would then be typed as a field map and
 * read back `undefined` for every key. A caller that skips the check entirely
 * gets the bug this function exists to prevent — see
 * {@link ControlMessageEvent.message}.
 */
export function controlMessageFields(message: unknown): Record<string, unknown> | undefined {
  if (message === null || typeof message !== 'object') return undefined
  if (Array.isArray(message) || ArrayBuffer.isView(message)) return undefined
  return message as Record<string, unknown>
}

export interface StreamOpenedEvent extends BaseEvent {
  readonly type: 'stream-opened'
  readonly streamId: bigint
  readonly direction: 0 | 1
  readonly streamType: 0 | 1 | 2
  /**
   * Track alias the stream carries. Written whenever the recorder knows it.
   *
   * The stream header carries the alias and no detail level records that
   * header's bytes, so before this field a `'headers'` recording could not say
   * which track a stream belonged to — which is most of what the level exists
   * to answer, and there was nothing left to re-parse it from.
   *
   * `bigint`, and so are the three fields below, unlike this event's
   * `direction` and `streamType`. Those two are small enumerations that a
   * narrow type suits; these four are wire identifiers with the same range as
   * {@link ObjectHeaderEvent}'s `groupId`, `objectId` and `streamId`, and
   * readers compare the two events. Typed as `number` here, a match would read
   * as a mismatch: `streamOpened.groupId === objectHeader.groupId` evaluates
   * `42 === 42n`, which is `false`, with no error, for every pair of values
   * that are in fact the same.
   *
   * Absent when the file's `"ta"` was not an unsigned integer — and the same
   * for the three fields below. Such a value belongs to no field here, so it
   * stays verbatim in {@link BaseEvent.extra} and is written back as it came.
   * It is never coerced on the way in: `true` and the text `"4"` are not track
   * alias 1 and track alias 4, however willingly `BigInt` converts them.
   */
  readonly trackAlias?: bigint
  /**
   * Subgroup ID, on a subgroup stream (`streamType === 0`).
   *
   * A writer must not set it on another stream type, where nothing supplies
   * it. A reader that meets one there keeps it rather than rejecting the
   * event: an out-of-scope key makes one field meaningless, not the file
   * unreadable, and discarding the event throws away every other field on it —
   * all of which were fine. That is about the key being in the wrong place; a
   * `"sg"` of the wrong *shape* is not held here at all, but in
   * {@link BaseEvent.extra}.
   */
  readonly subgroupId?: bigint
  /**
   * Fetch request ID, on a fetch stream (`streamType === 2`).
   *
   * A writer MUST set it there. It is the only correlation between the stream
   * and the FETCH that asked for it, and without it a fetch stream cannot be
   * attributed to a request at all. A reader must nevertheless accept a fetch
   * stream that lacks one — every recording made before the key existed lacks
   * it — for the same reason as the `'msg'` asymmetry on
   * {@link ControlMessageEvent.message}: writers conform, readers tolerate.
   */
  readonly fetchRequestId?: bigint
  /**
   * Group ID, on a datagram stream (`streamType === 1`).
   *
   * Scoped to datagrams because on a subgroup stream every object carries the
   * same group by construction, so a copy here would be a second field with no
   * independent source. Where an {@link ObjectHeaderEvent} for the same stream
   * disagrees, that event wins and this is not corruption: this copy is a
   * convenience for a reader that has not yet seen an object.
   */
  readonly groupId?: bigint
}

export interface StreamClosedEvent extends BaseEvent {
  readonly type: 'stream-closed'
  readonly streamId: bigint
  readonly errorCode: number
}

export interface ObjectHeaderEvent extends BaseEvent {
  readonly type: 'object-header'
  readonly streamId: bigint
  readonly groupId: bigint
  readonly objectId: bigint
  readonly publisherPriority: number
  readonly objectStatus: number
}

export interface ObjectPayloadEvent extends BaseEvent {
  readonly type: 'object-payload'
  readonly streamId: bigint
  readonly groupId: bigint
  readonly objectId: bigint
  readonly size: number
  readonly payload?: Uint8Array
}

export interface StateChangeEvent extends BaseEvent {
  readonly type: 'state-change'
  readonly from: string
  readonly to: string
}

export interface TraceErrorEvent extends BaseEvent {
  readonly type: 'error'
  readonly errorCode: number
  readonly reason: string
}

export interface AnnotationEvent extends BaseEvent {
  readonly type: 'annotation'
  readonly label: string
  readonly data: unknown
}

/** Role a peer is acting in at connection time. */
export type PeerRole = 'publisher' | 'subscriber' | 'both' | OtherString

/**
 * Which end of a relay a peer sits on.
 *
 * This is the direction the connection was made in, not the direction
 * subscriptions flow. For subscription causality see
 * {@link SubscriptionDerivationEvent}.
 */
export type Side = 'downstream' | 'upstream' | OtherString

/**
 * A new peer session was established. Emitted only by `'relay-tap'` sources;
 * the peer it identifies is on the event's `peer` field.
 */
export interface PeerConnectedEvent extends BaseEvent {
  readonly type: 'peer-connected'
  readonly endpoint?: string
  readonly transport?: string
  readonly role?: PeerRole
  readonly side?: Side
}

/** A peer session ended. Emitted only by `'relay-tap'` sources. */
export interface PeerDisconnectedEvent extends BaseEvent {
  readonly type: 'peer-disconnected'
  readonly errorCode: number
  readonly reason?: string
}

/**
 * A `(peer, request id)` pair naming one subscription on one peer.
 *
 * Request ids are unique only within a peer's session, so neither half
 * identifies a subscription on its own.
 */
export interface SubscriptionRef {
  readonly peer: string
  readonly requestId: bigint
}

/** How an upstream subscription came to serve a downstream one. */
export type DerivationKind = 'created' | 'shared' | OtherString

/**
 * An upstream subscription was created or extended in causal response to
 * downstream ones. Emitted only by `'relay-tap'` sources.
 *
 * This is the primitive multi-hop correlation is built from: a collector
 * reconstructs an end-to-end tree from these links plus the trace ids
 * propagated along them.
 *
 * The four timestamps share the `timestamp` field's timebase — the emitting
 * source's own clock. Differences between them are meaningful with no
 * cross-hop clock agreement, which is the point: they measure how long one
 * hop took. Never subtract one source's timestamp from another's.
 *
 * A source emits the event as soon as the downstream SUBSCRIBE arrives,
 * carrying whichever timestamps it has, and may emit it again for the same
 * pair as the rest arrive. Treat a later event for the same pair as an update
 * to the earlier one, not as a second derivation.
 */
export interface SubscriptionDerivationEvent extends BaseEvent {
  readonly type: 'subscription-derivation'
  readonly upstream: SubscriptionRef
  /** Every downstream subscription currently served by `upstream`. */
  readonly downstream: SubscriptionRef[]
  readonly kind: DerivationKind
  /**
   * Trace id propagated along the subscription chain: exactly
   * {@link TRACE_ID_LENGTH} raw bytes, never hex- or base64-encoded, so two
   * implementations produce identical values for the same chain.
   */
  readonly traceId?: Uint8Array
  /** Track namespace the subscription targets, one entry per field. */
  readonly namespace?: Uint8Array[]
  readonly trackName?: Uint8Array
  /** When the downstream SUBSCRIBE was received. */
  readonly tDownstreamReceived?: number
  /** When the upstream SUBSCRIBE was sent. Absent for a terminal subscription. */
  readonly tUpstreamSent?: number
  /** When SUBSCRIBE_OK arrived from upstream. */
  readonly tUpstreamOkReceived?: number
  /** When SUBSCRIBE_OK was sent downstream. */
  readonly tDownstreamOkSent?: number
}

/**
 * An event whose type this version of the package does not know.
 *
 * New event types may be added without a format version bump, so a reader
 * that dropped or relabelled them would make one tool's ignorance permanent
 * for everything downstream of it. The fields are kept verbatim, so an
 * unknown event survives a read-modify-write round trip intact.
 */
export interface UnknownEvent extends BaseEvent {
  readonly type: 'unknown'
  /** The `"e"` discriminant that was read. */
  readonly eventType: number
  /** Every key from the event map other than `n`, `t`, `p` and `e`. */
  readonly fields: Record<string, unknown>
}

export type TraceEvent =
  | ControlMessageEvent
  | StreamOpenedEvent
  | StreamClosedEvent
  | ObjectHeaderEvent
  | ObjectPayloadEvent
  | StateChangeEvent
  | TraceErrorEvent
  | AnnotationEvent
  | PeerConnectedEvent
  | PeerDisconnectedEvent
  | SubscriptionDerivationEvent
  | UnknownEvent

export interface Trace {
  readonly header: TraceHeader
  readonly events: TraceEvent[]
}

export interface RecorderOptions {
  readonly detail: DetailLevel
  readonly protocol: string
  readonly perspective: Perspective
  readonly transport?: string
  readonly source?: string
  readonly endpoint?: string
  readonly sessionId?: string
  readonly maxEvents?: number
  readonly clock?: () => number
  /** Map message type name (e.g. 'subscribe') to wire ID (e.g. 0x03). Required for session-layer recording. */
  readonly messageTypeId?: (name: string) => number
}
