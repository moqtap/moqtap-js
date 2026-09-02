import { Encoder } from 'cbor-x'
import { cborItemLength, MalformedCborError } from './cbor-scan.js'
import type {
  DerivationKind,
  DetailLevel,
  DropPolicy,
  Perspective,
  SamplingInfo,
  SegmentInfo,
  SubscriptionRef,
  Trace,
  TraceEvent,
  TraceHeader,
} from './types.js'
import { TRACE_ID_LENGTH } from './types.js'

// Use a CBOR codec configured for cross-language interop.
// Why: cbor-x's default `useRecords: true` enables a proprietary "record
// extension" that encodes JS objects as tagged structures rather than standard
// CBOR maps — unreadable by ciborium (Rust) and other spec-compliant decoders.
// The .moqtrace spec requires standard CBOR, so we disable records and encode
// as plain maps. `mapsAsObjects` is set so decoded maps come back as plain
// JS objects (matching the code that accesses fields via `obj.protocol`).
// `tagUint8Array: false` is the second half of the same requirement: by
// default cbor-x wraps every Uint8Array in tag 64 (RFC 8746 'uint8 typed
// array'), so a byte string is a tagged item rather than major type 2. A
// decoder reading the plain form sees no bytes at all — which silently emptied
// every payload-bearing field this package wrote: raw wire bytes, object
// payloads, track names, trace ids. Readers still accept the tagged form,
// because files carrying it already exist.
const codec = new Encoder({ useRecords: false, mapsAsObjects: true, tagUint8Array: false })
const encode = (value: unknown): Uint8Array => codec.encode(value)
const decode = (bytes: Uint8Array): unknown => codec.decode(bytes)

const MAGIC = new Uint8Array([0x4d, 0x4f, 0x51, 0x54, 0x52, 0x41, 0x43, 0x45]) // "MOQTRACE"

/** Format version this package writes. */
export const FORMAT_VERSION = 2

/**
 * Format versions this package reads.
 *
 * Version 1 is a non-segmented version 2 trace carrying none of the keys
 * version 2 added, so reading it costs nothing and keeps every capture taken
 * before the bump openable.
 */
export const SUPPORTED_VERSIONS: readonly number[] = [1, FORMAT_VERSION]

const PREAMBLE_SIZE = 16 // 8 magic + 4 version + 4 header length

// Event type string ↔ integer mapping
const EVENT_TYPE_TO_INT: Record<Exclude<TraceEvent['type'], 'unknown'>, number> = {
  control: 0,
  'stream-opened': 1,
  'stream-closed': 2,
  'object-header': 3,
  'object-payload': 4,
  'state-change': 5,
  error: 6,
  annotation: 7,
  'peer-connected': 8,
  'peer-disconnected': 9,
  'subscription-derivation': 10,
}

const INT_TO_EVENT_TYPE: Record<number, Exclude<TraceEvent['type'], 'unknown'>> = {
  0: 'control',
  1: 'stream-opened',
  2: 'stream-closed',
  3: 'object-header',
  4: 'object-payload',
  5: 'state-change',
  6: 'error',
  7: 'annotation',
  8: 'peer-connected',
  9: 'peer-disconnected',
  10: 'subscription-derivation',
}

/** Keys the common event fields own; everything else belongs to the variant. */
const COMMON_EVENT_KEYS = new Set(['n', 't', 'p', 'e'])

/**
 * One event map being decoded, and the keys the decode has taken from it.
 *
 * Everything left over is a key this version does not recognise, and goes to
 * `extra` rather than being dropped. "Left over" is narrower than "not owned by
 * this event type", and the difference is the whole point: a key the type owns
 * whose value is of a type the reader cannot use was not taken either, and is
 * preserved exactly as a key nobody had heard of would be — SPEC.md,
 * "A defined key whose value has an unusable type is treated as unrecognised."
 *
 * Only the decode writes to the set, so there is no separate list of owned keys
 * to keep in step with it. The list there used to be is what made adding
 * `"ta"`, `"sg"`, `"fri"` and `"g"` to Event 1 *reduce* what this reader
 * preserved: those keys counted as owned whatever they carried, so a
 * wrong-typed one was kept out of `extra` while the decode either threw on it,
 * losing the whole file, or coerced it into a value the file never carried.
 */
interface Decoding {
  readonly obj: Record<string, unknown>
  readonly used: Set<string>
}

/** Every key on a decoded event map that the decode did not take. */
function unrecognisedKeys(src: Decoding): Record<string, unknown> | undefined {
  let extra: Record<string, unknown> | undefined
  for (const [key, value] of Object.entries(src.obj)) {
    if (src.used.has(key)) continue
    extra ??= {}
    extra[key] = value
  }
  return extra
}

/** The stream ended part-way through an item — the file was truncated. */
export class TruncatedTraceError extends Error {
  /** Byte offset at which the incomplete item begins. */
  readonly offset: number
  /**
   * Everything that decoded before the cut, one entry per segment. A
   * truncated trace is still evidence, and the events before the cut are
   * exactly as valid as they were.
   */
  readonly segments: Trace[]

  constructor(offset: number, segments: Trace[]) {
    super(`Trace truncated: the item starting at byte ${offset} is incomplete`)
    this.name = 'TruncatedTraceError'
    this.offset = offset
    this.segments = segments
  }

  /** What decoded, flattened as {@link readMoqtrace} would return it. */
  get trace(): Trace | undefined {
    return flatten(this.segments)
  }
}

// --- Header serialization ---

function segmentToCbor(segment: SegmentInfo): Record<string, unknown> {
  const map: Record<string, unknown> = { sequence: int(segment.sequence) }
  if (segment.durationMs != null) map.durationMs = int(segment.durationMs)
  if (segment.streamId != null) map.streamId = segment.streamId
  if (segment.continues != null) map.continues = segment.continues
  return map
}

function cborToSegment(obj: Record<string, unknown>): SegmentInfo {
  return {
    sequence: Number(obj.sequence ?? 0),
    ...(obj.durationMs != null ? { durationMs: Number(obj.durationMs) } : {}),
    ...(obj.streamId != null ? { streamId: obj.streamId as string } : {}),
    ...(obj.continues != null ? { continues: obj.continues as boolean } : {}),
  }
}

function samplingToCbor(sampling: SamplingInfo): Record<string, unknown> {
  const map: Record<string, unknown> = {}
  if (sampling.effectiveRate != null) map.effectiveRate = sampling.effectiveRate
  if (sampling.maxEventsPerSec != null) map.maxEventsPerSec = int(sampling.maxEventsPerSec)
  if (sampling.dropPolicy != null) map.dropPolicy = sampling.dropPolicy
  if (sampling.droppedTotal != null) map.droppedTotal = int(sampling.droppedTotal)
  if (sampling.droppedSegment != null) map.droppedSegment = int(sampling.droppedSegment)
  if (sampling.rule != null) map.rule = sampling.rule
  if (sampling.ruleLang != null) map.ruleLang = sampling.ruleLang
  if (sampling.appliesTo != null) map.appliesTo = sampling.appliesTo.map(int)
  return map
}

function cborToSampling(obj: Record<string, unknown>): SamplingInfo {
  return {
    ...(obj.effectiveRate != null ? { effectiveRate: Number(obj.effectiveRate) } : {}),
    ...(obj.maxEventsPerSec != null ? { maxEventsPerSec: Number(obj.maxEventsPerSec) } : {}),
    ...(obj.dropPolicy != null ? { dropPolicy: obj.dropPolicy as DropPolicy } : {}),
    ...(obj.droppedTotal != null ? { droppedTotal: Number(obj.droppedTotal) } : {}),
    ...(obj.droppedSegment != null ? { droppedSegment: Number(obj.droppedSegment) } : {}),
    ...(obj.rule != null ? { rule: obj.rule as string } : {}),
    ...(obj.ruleLang != null ? { ruleLang: obj.ruleLang as string } : {}),
    ...(obj.appliesTo != null ? { appliesTo: (obj.appliesTo as number[]).map(Number) } : {}),
  }
}

function headerToCbor(header: TraceHeader): Record<string, unknown> {
  const map: Record<string, unknown> = {
    protocol: header.protocol,
    perspective: header.perspective,
    detail: header.detail,
    startTime: int(header.startTime),
  }
  if (header.endTime != null) map.endTime = int(header.endTime)
  if (header.transport != null) map.transport = header.transport
  if (header.source != null) map.source = header.source
  if (header.endpoint != null) map.endpoint = header.endpoint
  if (header.sessionId != null) map.sessionId = header.sessionId
  if (header.segment != null) map.segment = segmentToCbor(header.segment)
  if (header.sampling != null) map.sampling = samplingToCbor(header.sampling)
  if (header.custom != null) map.custom = header.custom
  return map
}

function cborToHeader(obj: Record<string, unknown>): TraceHeader {
  return {
    protocol: obj.protocol as string,
    perspective: obj.perspective as Perspective,
    detail: obj.detail as DetailLevel,
    startTime: Number(obj.startTime),
    ...(obj.endTime != null ? { endTime: Number(obj.endTime) } : {}),
    ...(obj.transport != null ? { transport: obj.transport as string } : {}),
    ...(obj.source != null ? { source: obj.source as string } : {}),
    ...(obj.endpoint != null ? { endpoint: obj.endpoint as string } : {}),
    ...(obj.sessionId != null ? { sessionId: obj.sessionId as string } : {}),
    ...(obj.segment != null
      ? { segment: cborToSegment(obj.segment as Record<string, unknown>) }
      : {}),
    ...(obj.sampling != null
      ? { sampling: cborToSampling(obj.sampling as Record<string, unknown>) }
      : {}),
    ...(obj.custom != null ? { custom: obj.custom as Record<string, unknown> } : {}),
  }
}

// --- Event serialization ---

function subscriptionRefToCbor(ref: SubscriptionRef): [string, bigint] {
  return [ref.peer, ref.requestId]
}

function cborToSubscriptionRef(value: unknown): SubscriptionRef {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new Error('Subscription reference must be [peer, requestId]')
  }
  // Both halves are required, so an unusable one is a malformed event rather
  // than something to route elsewhere — there is no subscription to name
  // without them. Checked rather than converted, for the reason `asUint` gives:
  // `BigInt(true)` is `1n`, a request id no file ever carried.
  const peer = asText(value[0])
  const requestId = asUint(value[1])
  if (peer == null || requestId == null) {
    throw new Error('Subscription reference must be a [text, unsigned integer] pair')
  }
  return { peer, requestId }
}

/**
 * Normalise a decoded byte string to a plain `Uint8Array` that owns its bytes.
 *
 * The decoder hands back a Node `Buffer` on one platform and a `Uint8Array` on
 * another, and either may be a view onto the buffer being read — so without
 * the copy, a payload would alias the caller's input and change under it.
 */
function toBytes(value: unknown): Uint8Array {
  return value instanceof Uint8Array
    ? new Uint8Array(value)
    : new Uint8Array(value as ArrayLike<number>)
}

/**
 * Write an integral value as a CBOR integer rather than a float.
 *
 * cbor-x encodes any JS number past 32 bits as a float64, which every
 * epoch-millisecond timestamp is. That is legal CBOR, but it means the two
 * implementations of this format wrote different major types for the same
 * value — and a decoder reading only integers found `startTime` missing and
 * rejected the file. Handing the encoder a BigInt gets an integer out.
 */
function int(value: number): number | bigint {
  const outsideInt32 = value > 0xffffffff || value < -0x80000000
  return Number.isInteger(value) && outsideInt32 ? BigInt(value) : value
}

/**
 * Write a trace id, refusing any length but the one the format fixes.
 *
 * A wrong-length value is not something to pad or truncate: the identifier
 * exists so two implementations independently derive byte-identical values for
 * one subscription chain, and reshaping it breaks exactly the property it is
 * there for. The reader's counterpart is {@link asTraceId}, which keeps a
 * wrong-length value instead of refusing it — `"traceId"` is optional, and an
 * optional key's type never fails a file.
 */
function checkTraceId(value: unknown): Uint8Array {
  const bytes = toBytes(value)
  if (bytes.length !== TRACE_ID_LENGTH) {
    throw new Error(`traceId is ${bytes.length} bytes, must be ${TRACE_ID_LENGTH}`)
  }
  return bytes
}

function eventToCbor(event: TraceEvent): Record<string, unknown> {
  const base: Record<string, unknown> = {
    n: int(event.seq),
    t: int(event.timestamp),
  }
  if (event.peer != null) base.p = event.peer
  if (event.type !== 'unknown') base.e = EVENT_TYPE_TO_INT[event.type]

  switch (event.type) {
    case 'control': {
      base.d = event.direction
      base.mt = int(event.messageType)
      // Always written, even when nothing was decoded: Event 0 is one of the
      // types sampling must not drop, so a reader strict enough to treat a
      // missing "msg" as a malformed event would discard exactly the events
      // the format promises to keep. `undefined` is the one value not passed
      // through — it encodes as CBOR `undefined`, which is not a map, and it
      // means a caller left the field off rather than that a file carried it.
      // Every other value is written as it stands, so a text `"msg"` read out
      // of a pre-spec recording goes back to disk as the same text.
      base.msg = event.message === undefined ? {} : event.message
      if (event.streamId != null) base.sid = event.streamId
      if (event.raw != null) base.raw = event.raw
      break
    }
    case 'stream-opened': {
      base.sid = event.streamId
      base.d = event.direction
      base.st = event.streamType
      // Written only when set, and each is scoped to one stream type: a
      // subgroup id on a fetch stream, or a group id on a subgroup stream,
      // names something the header it came from never carried.
      if (event.trackAlias != null) base.ta = event.trackAlias
      if (event.subgroupId != null) base.sg = event.subgroupId
      if (event.fetchRequestId != null) base.fri = event.fetchRequestId
      if (event.groupId != null) base.g = event.groupId
      break
    }
    case 'stream-closed': {
      base.sid = event.streamId
      base.ec = int(event.errorCode)
      break
    }
    case 'object-header': {
      base.sid = event.streamId
      base.g = event.groupId
      base.o = event.objectId
      base.pp = int(event.publisherPriority)
      base.os = int(event.objectStatus)
      break
    }
    case 'object-payload': {
      base.sid = event.streamId
      base.g = event.groupId
      base.o = event.objectId
      base.sz = int(event.size)
      if (event.payload != null) base.pl = event.payload
      break
    }
    case 'state-change': {
      base.from = event.from
      base.to = event.to
      break
    }
    case 'error': {
      base.ec = int(event.errorCode)
      base.reason = event.reason
      break
    }
    case 'annotation': {
      base.label = event.label
      if (event.data !== undefined) base.data = event.data
      break
    }
    case 'peer-connected': {
      if (event.endpoint != null) base.endpoint = event.endpoint
      if (event.transport != null) base.transport = event.transport
      if (event.role != null) base.role = event.role
      if (event.side != null) base.side = event.side
      break
    }
    case 'peer-disconnected': {
      base.ec = int(event.errorCode)
      if (event.reason != null) base.reason = event.reason
      break
    }
    case 'subscription-derivation': {
      base.u = subscriptionRefToCbor(event.upstream)
      base.d = event.downstream.map(subscriptionRefToCbor)
      base.kind = event.kind
      if (event.traceId != null) base.traceId = checkTraceId(event.traceId)
      if (event.namespace != null) base.ns = event.namespace
      if (event.trackName != null) base.tn = event.trackName
      if (event.tDownstreamReceived != null) base.tdr = int(event.tDownstreamReceived)
      if (event.tUpstreamSent != null) base.tus = int(event.tUpstreamSent)
      if (event.tUpstreamOkReceived != null) base.tuo = int(event.tUpstreamOkReceived)
      if (event.tDownstreamOkSent != null) base.tdo = int(event.tDownstreamOkSent)
      break
    }
    case 'unknown': {
      base.e = event.eventType
      for (const [key, value] of Object.entries(event.fields)) {
        base[key] = value
      }
      break
    }
  }

  // Last, so the event's own keys keep the positions a reader expects and the
  // file stays diffable against one written without them. An entry naming a key
  // this event already wrote from a field is dropped: a CBOR map with a
  // duplicate key is malformed, and the field is what a reader produced.
  //
  // The test is what the event *wrote*, not what its type owns. A defined key
  // whose value the reader could not use is held in `extra` and no field wrote
  // it, so on the owned-key test it would be dropped here — silently undoing
  // the preservation the read side had just performed.
  if (event.type !== 'unknown' && event.extra != null) {
    for (const [key, value] of Object.entries(event.extra)) {
      if (COMMON_EVENT_KEYS.has(key) || Object.hasOwn(base, key)) continue
      base[key] = value
    }
  }

  return base
}

// --- Reading one key ---
//
// Each of these answers `undefined` for a value it cannot use, and the caller
// then leaves the key untaken so that `unrecognisedKeys` preserves it.
//
// They are type *tests*, not conversion attempts. The distinction is not
// pedantic even where a conversion throws on the obvious cases: `BigInt`
// answers `1n` for `true` and `4n` for the text `"4"`, so a `try`/`catch`
// around it would still put an identifier on the event that the file never
// carried — and the Rust reader, which coerces neither, would then read the
// same file differently.

/** A CBOR unsigned integer, as a `bigint`. */
function asUint(value: unknown): bigint | undefined {
  if (typeof value === 'bigint') return value >= 0n ? value : undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return undefined
  return BigInt(value)
}

/**
 * The same, where the field it feeds is a JS `number`.
 *
 * A value past `Number.MAX_SAFE_INTEGER` is refused rather than rounded: the
 * rounded number is not what the file said, and refusing keeps the digits
 * intact in `extra`.
 */
function asUintNumber(value: unknown): number | undefined {
  const int = asUint(value)
  return int == null || int > BigInt(Number.MAX_SAFE_INTEGER) ? undefined : Number(int)
}

/** A CBOR text string. */
function asText(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** A CBOR byte string, copied by {@link toBytes} so it owns its bytes. */
function asByteString(value: unknown): Uint8Array | undefined {
  return value instanceof Uint8Array ? toBytes(value) : undefined
}

/** A CBOR array of byte strings — the shape a track namespace takes. */
function asByteStrings(value: unknown): Uint8Array[] | undefined {
  if (!Array.isArray(value)) return undefined
  const parts: Uint8Array[] = []
  for (const item of value) {
    const bytes = asByteString(item)
    if (bytes == null) return undefined
    parts.push(bytes)
  }
  return parts
}

/**
 * A trace id: {@link TRACE_ID_LENGTH} bytes and no other length.
 *
 * The reader's half of {@link checkTraceId}. It keeps a wrong-length value
 * rather than throwing, because `"traceId"` is optional and an optional key's
 * type never fails a file; the value then survives in `extra` with its bytes
 * intact, which a padded or truncated field would not.
 */
function asTraceId(value: unknown): Uint8Array | undefined {
  const bytes = asByteString(value)
  return bytes?.length === TRACE_ID_LENGTH ? bytes : undefined
}

/** Take a key's value as it stands, whatever shape it has. */
function take(src: Decoding, key: string): unknown {
  src.used.add(key)
  return src.obj[key]
}

/**
 * Take a required integer key, or fail the event.
 *
 * The one case where an unusable value is not routed to `extra`: without the
 * key there is no event to build, so the event is malformed exactly as it
 * would be with the key absent. That is as far as it goes — a *file* is never
 * failed over an optional key's type.
 */
function requireUint(src: Decoding, key: string): bigint {
  const value = asUint(take(src, key))
  if (value == null) {
    throw new Error(`Event key ${JSON.stringify(key)} must be an unsigned integer`)
  }
  return value
}

/**
 * Take an optional key, as the property to spread onto the event — or nothing
 * at all, when the key is absent or carries a value of a type this reader
 * cannot use.
 *
 * Those two cases build the same event and differ in what they leave behind:
 * an absent key leaves nothing, an unusable one stays untaken and is preserved
 * verbatim as an unrecognised key. Neither throws. The events around this one
 * decoded fine, and one key's type is no reason to lose them.
 */
function optional<K extends string, V>(
  src: Decoding,
  key: string,
  name: K,
  read: (value: unknown) => V | undefined,
): { [P in K]?: V } {
  const usable = read(src.obj[key])
  if (usable === undefined) return {} as { [P in K]?: V }
  src.used.add(key)
  return { [name]: usable } as { [P in K]?: V }
}

/**
 * Decode one event, keeping every key the decode could not use.
 *
 * Those keys are kept on the event rather than dropped so that reading a trace
 * and writing it back does not quietly strip what a newer writer put there.
 * Two kinds land there, and the second is the one easily lost: a key this
 * version has never heard of, and a key it knows whose value is of a type it
 * cannot use — a text `"ta"`, say. Both are unrecognised as far as meaning
 * goes, and both are written back unchanged.
 *
 * An `UnknownEvent` is returned untouched: its `fields` already hold every
 * non-common key, and adding them to `extra` too would write each one twice.
 */
function cborToEvent(obj: Record<string, unknown>): TraceEvent {
  const src: Decoding = { obj, used: new Set(COMMON_EVENT_KEYS) }
  const event = decodeEvent(src)
  if (event.type === 'unknown') return event

  const extra = unrecognisedKeys(src)
  return extra == null ? event : { ...event, extra }
}

function decodeEvent(src: Decoding): TraceEvent {
  const obj = src.obj
  const seq = Number(obj.n ?? 0)
  const timestamp = Number(obj.t ?? 0)
  const peerFields = obj.p != null ? { peer: obj.p as string } : {}
  const eventType = INT_TO_EVENT_TYPE[obj.e as number]

  if (eventType == null) {
    // New event types may be added without a version bump. Dropping one — or
    // relabelling it as an annotation, which an earlier revision of this file
    // did — makes this reader's ignorance permanent for every reader
    // downstream of it, because a read-modify-write then rewrites the type.
    const fields: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(obj)) {
      if (!COMMON_EVENT_KEYS.has(key)) fields[key] = value
    }
    return {
      type: 'unknown' as const,
      seq,
      timestamp,
      ...peerFields,
      eventType: Number(obj.e ?? -1),
      fields,
    }
  }

  switch (eventType) {
    case 'control':
      return {
        type: 'control' as const,
        seq,
        timestamp,
        ...peerFields,
        direction: take(src, 'd') as 0 | 1,
        messageType: Number(take(src, 'mt') ?? 0),
        // Handed over exactly as it decoded. A `"msg"` that is not a map is
        // still the only decode the recording has — the corpus captures carry
        // a Rust `Debug` string here — and the format requires a reader to
        // preserve it rather than reject the event or substitute a map. That
        // includes `null`, which is a value a writer chose to put on the wire,
        // not an absence; absence is the single case normalised, to `{}`, so
        // that a caller reading keys off a conforming file never meets
        // `undefined`. It is the one key with no unusable shape: the field's
        // type is `unknown`, so every value is one it can hold.
        message: Object.hasOwn(obj, 'msg') ? take(src, 'msg') : {},
        ...optional(src, 'sid', 'streamId', asUint),
        ...optional(src, 'raw', 'raw', asByteString),
      }

    case 'stream-opened':
      return {
        type: 'stream-opened' as const,
        seq,
        timestamp,
        ...peerFields,
        streamId: requireUint(src, 'sid'),
        direction: take(src, 'd') as 0 | 1,
        streamType: take(src, 'st') as 0 | 1 | 2,
        // `bigint`, not `number`, even though a writer that used a narrow CBOR
        // integer hands these back as JS numbers. They are the same
        // identifiers an object-header event carries, and that event converts;
        // leaving one a number here makes `opened.groupId === header.groupId`
        // read `42 === 42n` and answer `false` for values that match.
        //
        // Tested rather than converted, and optional rather than required.
        // `BigInt(obj.ta)` threw on a text or fractional value and took the
        // whole file down with it, since nothing catches one event's decode; it
        // answered `1n` for `true` and `4n` for `"4"`, inventing an identifier
        // the file never carried; and the owned-key list then kept the
        // survivors out of `extra`, so adding these four keys *lost* values
        // this reader had preserved before it knew them. A value of any other
        // shape now stays where it was, on the event as an unrecognised key.
        ...optional(src, 'ta', 'trackAlias', asUint),
        ...optional(src, 'sg', 'subgroupId', asUint),
        ...optional(src, 'fri', 'fetchRequestId', asUint),
        ...optional(src, 'g', 'groupId', asUint),
      }

    case 'stream-closed':
      return {
        type: 'stream-closed' as const,
        seq,
        timestamp,
        ...peerFields,
        streamId: requireUint(src, 'sid'),
        errorCode: Number(take(src, 'ec') ?? 0),
      }

    case 'object-header':
      return {
        type: 'object-header' as const,
        seq,
        timestamp,
        ...peerFields,
        streamId: requireUint(src, 'sid'),
        groupId: requireUint(src, 'g'),
        objectId: requireUint(src, 'o'),
        publisherPriority: Number(take(src, 'pp') ?? 0),
        objectStatus: Number(take(src, 'os') ?? 0),
      }

    case 'object-payload':
      return {
        type: 'object-payload' as const,
        seq,
        timestamp,
        ...peerFields,
        streamId: requireUint(src, 'sid'),
        groupId: requireUint(src, 'g'),
        objectId: requireUint(src, 'o'),
        size: Number(take(src, 'sz') ?? 0),
        ...optional(src, 'pl', 'payload', asByteString),
      }

    case 'state-change':
      return {
        type: 'state-change' as const,
        seq,
        timestamp,
        ...peerFields,
        from: take(src, 'from') as string,
        to: take(src, 'to') as string,
      }

    case 'error':
      return {
        type: 'error' as const,
        seq,
        timestamp,
        ...peerFields,
        errorCode: Number(take(src, 'ec') ?? 0),
        reason: (take(src, 'reason') ?? '') as string,
      }

    case 'annotation':
      return {
        type: 'annotation' as const,
        seq,
        timestamp,
        ...peerFields,
        label: (take(src, 'label') ?? '') as string,
        data: take(src, 'data'),
      }

    case 'peer-connected':
      return {
        type: 'peer-connected' as const,
        seq,
        timestamp,
        ...peerFields,
        ...optional(src, 'endpoint', 'endpoint', asText),
        ...optional(src, 'transport', 'transport', asText),
        // A role or side this version has never heard of is still text, and
        // still kept: the unions they widen to exist for exactly that. What
        // `asText` refuses is a value that is not text at all.
        ...optional(src, 'role', 'role', asText),
        ...optional(src, 'side', 'side', asText),
      }

    case 'peer-disconnected':
      return {
        type: 'peer-disconnected' as const,
        seq,
        timestamp,
        ...peerFields,
        errorCode: Number(take(src, 'ec') ?? 0),
        ...optional(src, 'reason', 'reason', asText),
      }

    case 'subscription-derivation':
      return {
        type: 'subscription-derivation' as const,
        seq,
        timestamp,
        ...peerFields,
        upstream: cborToSubscriptionRef(take(src, 'u')),
        downstream: ((take(src, 'd') ?? []) as unknown[]).map(cborToSubscriptionRef),
        kind: (take(src, 'kind') ?? '') as DerivationKind,
        ...optional(src, 'traceId', 'traceId', asTraceId),
        ...optional(src, 'ns', 'namespace', asByteStrings),
        ...optional(src, 'tn', 'trackName', asByteString),
        ...optional(src, 'tdr', 'tDownstreamReceived', asUintNumber),
        ...optional(src, 'tus', 'tUpstreamSent', asUintNumber),
        ...optional(src, 'tuo', 'tUpstreamOkReceived', asUintNumber),
        ...optional(src, 'tdo', 'tDownstreamOkSent', asUintNumber),
      }
  }
}

// --- Preamble helpers ---

function writePreamble(headerCbor: Uint8Array): Uint8Array {
  const buf = new Uint8Array(PREAMBLE_SIZE + headerCbor.length)
  buf.set(MAGIC, 0)
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  view.setUint32(8, FORMAT_VERSION, true)
  view.setUint32(12, headerCbor.length, true)
  buf.set(headerCbor, PREAMBLE_SIZE)
  return buf
}

function startsWithMagic(bytes: Uint8Array, offset: number): boolean {
  if (offset + MAGIC.length > bytes.length) return false
  for (let i = 0; i < MAGIC.length; i++) {
    if (bytes[offset + i] !== MAGIC[i]) return false
  }
  return true
}

function validatePreamble(
  bytes: Uint8Array,
  offset = 0,
): {
  version: number
  headerLength: number
} {
  if (bytes.length - offset < PREAMBLE_SIZE) {
    throw new Error('File too short: expected at least 16 bytes')
  }

  if (!startsWithMagic(bytes, offset)) {
    throw new Error('Invalid magic bytes: not a .moqtrace file')
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const version = view.getUint32(offset + 8, true)
  if (!SUPPORTED_VERSIONS.includes(version)) {
    throw new Error(
      `Unsupported format version: ${version} (supported: ${SUPPORTED_VERSIONS.join(', ')})`,
    )
  }

  const headerLength = view.getUint32(offset + 12, true)
  if (offset + PREAMBLE_SIZE + headerLength > bytes.length) {
    throw new Error('File truncated: header extends beyond file')
  }

  return { version, headerLength }
}

// --- Reading ---

/** Options shared by the readers. */
export interface ReadOptions {
  /**
   * On a truncated or corrupt region, skip forward to the next segment and
   * carry on instead of throwing.
   *
   * This is the recovery segmentation exists to offer: one damaged segment
   * costs that segment rather than the rest of the capture. It can only help
   * a segmented trace — there is nothing to resynchronize to in a single
   * segment, so a damaged one still ends the read, just without an error.
   */
  readonly recover?: boolean
}

function flatten(segments: Trace[]): Trace | undefined {
  const first = segments[0]
  if (first == null) return undefined
  if (segments.length === 1) return first
  return { header: first.header, events: segments.flatMap((segment) => segment.events) }
}

/** Scan forward for the next segment preamble; -1 if there is none. */
function findNextSegment(bytes: Uint8Array, from: number): number {
  for (let offset = from; offset + MAGIC.length <= bytes.length; offset++) {
    if (startsWithMagic(bytes, offset)) return offset
  }
  return -1
}

function readSegments(bytes: Uint8Array, options?: ReadOptions): Trace[] {
  const recover = options?.recover ?? false
  const segments: Trace[] = []
  let events: TraceEvent[] = []
  let offset = 0

  // The first thing in the buffer must be a preamble; failing that, the
  // errors below name why rather than reporting a stray byte.
  validatePreamble(bytes, 0)

  while (offset < bytes.length) {
    // Checked only here, at a real item boundary. The same eight bytes inside
    // a captured payload are not a segment start, and treating them as one
    // would split a trace that was never segmented.
    if (startsWithMagic(bytes, offset)) {
      const { headerLength } = validatePreamble(bytes, offset)
      const start = offset + PREAMBLE_SIZE
      const headerBytes = bytes.subarray(start, start + headerLength)
      events = []
      segments.push({
        header: cborToHeader(decode(headerBytes) as Record<string, unknown>),
        events,
      })
      offset = start + headerLength
      continue
    }

    let length: number | null
    try {
      length = cborItemLength(bytes, offset)
    } catch (error) {
      if (!recover || !(error instanceof MalformedCborError)) throw error
      length = null
    }

    if (length != null) {
      try {
        const item = decode(bytes.subarray(offset, offset + length))
        events.push(cborToEvent(item as Record<string, unknown>))
        offset += length
        continue
      } catch (error) {
        if (!recover) throw error
      }
    } else if (!recover) {
      throw new TruncatedTraceError(offset, segments)
    }

    const next = findNextSegment(bytes, offset + 1)
    if (next < 0) return segments
    offset = next
  }

  return segments
}

// --- Public API ---

/**
 * Write a complete trace to .moqtrace binary format.
 */
export function writeMoqtrace(trace: Trace): Uint8Array {
  const headerCbor = encode(headerToCbor(trace.header))
  const preamble = writePreamble(headerCbor)

  const eventChunks: Uint8Array[] = []
  let totalEventBytes = 0
  for (const event of trace.events) {
    const chunk = encode(eventToCbor(event))
    eventChunks.push(chunk)
    totalEventBytes += chunk.length
  }

  const result = new Uint8Array(preamble.length + totalEventBytes)
  result.set(preamble, 0)
  let offset = preamble.length
  for (const chunk of eventChunks) {
    result.set(chunk, offset)
    offset += chunk.length
  }

  return result
}

/**
 * Write several segments back to back as one segmented `.moqtrace` stream.
 *
 * Every segment header must carry {@link SegmentInfo}. That field is what
 * tells a reader the sequence numbers and timestamps it is about to see
 * restart at zero; a segmented stream written without it reads as a run of
 * complete files whose timeline jumps backwards at every boundary, and
 * nothing downstream can detect that it happened.
 */
export function writeMoqtraceSegments(segments: Trace[]): Uint8Array {
  const chunks = segments.map((segment, index) => {
    if (segment.header.segment == null) {
      throw new Error(`Segment ${index} has no 'segment' metadata in its header`)
    }
    return writeMoqtrace(segment)
  })

  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const result = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.length
  }
  return result
}

/**
 * Read a complete .moqtrace file from bytes.
 *
 * A segmented file is flattened: the returned header is the first segment's,
 * and the events of every segment follow in order. Use
 * {@link readMoqtraceSegments} to see the boundaries — you need them to order
 * events across segments, since `seq` and `timestamp` restart in each.
 *
 * @throws {TruncatedTraceError} if the file stops part-way through an item.
 *   The error carries everything that decoded before the cut.
 */
export function readMoqtrace(bytes: Uint8Array, options?: ReadOptions): Trace {
  const trace = flatten(readSegments(bytes, options))
  if (trace == null) {
    throw new Error('Invalid magic bytes: not a .moqtrace file')
  }
  return trace
}

/**
 * Read a .moqtrace file as its segments, one entry per segment.
 *
 * A non-segmented file yields exactly one entry, whose header carries no
 * `segment` field.
 */
export function readMoqtraceSegments(bytes: Uint8Array, options?: ReadOptions): Trace[] {
  return readSegments(bytes, options)
}

/**
 * Read only the header from a .moqtrace file (fast metadata peek).
 *
 * In a segmented file this is the first segment's header.
 */
export function readMoqtraceHeader(bytes: Uint8Array): TraceHeader {
  const { headerLength } = validatePreamble(bytes)
  const headerBytes = bytes.subarray(PREAMBLE_SIZE, PREAMBLE_SIZE + headerLength)
  return cborToHeader(decode(headerBytes) as Record<string, unknown>)
}

/**
 * Streaming writer for building .moqtrace files incrementally.
 */
export interface MoqtraceWriter {
  /** Returns the file preamble (magic + version + header). Write this first. */
  preamble(): Uint8Array
  /** Encode a single event. Append the returned bytes after the preamble. */
  writeEvent(event: TraceEvent): Uint8Array
  /**
   * Begin a new segment: returns a fresh preamble to append after the
   * previous segment's last event.
   *
   * The header must carry {@link SegmentInfo} — see
   * {@link writeMoqtraceSegments} for why. It should keep the same
   * `protocol`, `perspective`, `detail` and `sessionId` as the segments
   * before it, and increment `segment.sequence`.
   */
  startSegment(header: TraceHeader): Uint8Array
}

export function createMoqtraceWriter(header: TraceHeader): MoqtraceWriter {
  const headerCbor = encode(headerToCbor(header))
  const preambleBytes = writePreamble(headerCbor)

  return {
    preamble(): Uint8Array {
      return preambleBytes
    },
    writeEvent(event: TraceEvent): Uint8Array {
      return encode(eventToCbor(event))
    },
    startSegment(next: TraceHeader): Uint8Array {
      if (next.segment == null) {
        throw new Error("A segment header must carry 'segment' metadata")
      }
      return writePreamble(encode(headerToCbor(next)))
    },
  }
}
