import { Encoder } from 'cbor-x'
import { cborItemLength, MalformedCborError } from './cbor-scan.js'
import type {
  DerivationKind,
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
//
// `mapsAsObjects` has one cost this package cannot pay off, and it belongs
// here, where the decoder is chosen, rather than where the damage shows.
// cbor-x runs every decoded map key through an internal `safeKey`, which
// rewrites the text key `"__proto__"` to `"__proto_"` and stringifies a
// non-text key. Both are silent, both happen before any code in this file
// runs, and either can collide with a real key of the rewritten name and lose
// a value: a map carrying both `"__proto__"` and `"__proto_"` decodes to one
// entry, and so does one carrying both `1` and `"1"`. There is no option for
// it — in cbor-x 1.6.4 `safeKey` is unconditional on every `mapsAsObjects:
// true` path, and the one decoder that skips it is `mapsAsObjects: false`,
// which hands back a `Map` for every map in the file and is a different reader
// from this one. So a store here faithfully re-emits the renamed key, and this
// reader writes `"__proto_"` where the file said `"__proto__"` — including
// inside `"custom"`, which it otherwise hands back key for key, and inside any
// preserved value at any depth. SPEC.md, "Shapes a CBOR library may normalise
// before you see them", part 3: the normalisation happens below this
// implementation, so the reader is not non-conformant and nothing may depend
// on the outcome — but it is not invisible either, and the Rust reader keeps
// the two keys apart. The *write* half of the same key is ours, and is not
// excused: see {@link setKey}.
const codec = new Encoder({ useRecords: false, mapsAsObjects: true, tagUint8Array: false })
const encode = (value: unknown): Uint8Array => codec.encode(value)
export const decode = (bytes: Uint8Array): unknown => codec.decode(bytes)

export const MAGIC = new Uint8Array([0x4d, 0x4f, 0x51, 0x54, 0x52, 0x41, 0x43, 0x45]) // "MOQTRACE"

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

export const PREAMBLE_SIZE = 16 // 8 magic + 4 version + 4 header length

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
 * One decoded map — an event, the header, or one of the header's inner maps —
 * and the keys the decode has taken from it.
 *
 * Everything left over is a key this version does not recognise, and goes to
 * `extra` rather than being dropped. "Left over" is narrower than "not named by
 * this document", and the difference is the whole point: a defined key whose
 * value is of a type the reader cannot use was not taken either, and is
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

/**
 * Put a key carried by a file onto a plain object, as an own property.
 *
 * `target[key] = value` is not this, for one key in the whole of JavaScript.
 * `__proto__` reaches the accessor `Object.prototype` defines, which sets the
 * object's prototype instead of creating a property: `Object.hasOwn(target,
 * '__proto__')` is then false, `Object.entries` does not list it, and the
 * entry is gone. A caller whose store came from `JSON.parse('{"__proto__":
 * "x"}')` — a real own property on the way in, since JSON has no such
 * special case — therefore wrote a file with the key missing, silently, on
 * the one code path whose entire purpose is preservation.
 *
 * `defineProperty` makes the own property for every key alike, and cbor-x
 * encodes it: a store entry named `__proto__` reaches the file as the text key
 * `"__proto__"`, which is what the Rust implementation writes for the same
 * trace. Used for every key that comes from a file or from a store — never for
 * a field name this format defines, which is a literal in the source and can
 * be neither `__proto__` nor anything else surprising.
 *
 * This is only the write half. Reading `"__proto__"` back out of that file
 * hands us `"__proto_"`, below this code and past helping — see the note on
 * the codec above.
 */
function setKey(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  })
}

/** Every key on a decoded map that the decode did not take. */
function unrecognisedKeys(src: Decoding): Record<string, unknown> | undefined {
  let extra: Record<string, unknown> | undefined
  for (const [key, value] of Object.entries(src.obj)) {
    if (src.used.has(key)) continue
    extra ??= {}
    setKey(extra, key, value)
  }
  return extra
}

/**
 * Write a map's unrecognised-key store back into it, after its own keys.
 *
 * Last, so the map's own keys keep the positions a reader expects and the file
 * stays diffable against one written without a store. An entry naming a key the
 * map already wrote is dropped: a CBOR map carrying one key twice is a map no
 * two readers need agree on, and the field is what a reader produced.
 *
 * The test is what the map *wrote*, not which keys the format defines. A
 * defined key whose value the reader could not use is held in the store and no
 * field wrote it, so on a defined-key test it would be dropped here — silently
 * undoing the preservation the read side had just performed.
 */
function withStore(
  map: Record<string, unknown>,
  store: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (store == null) return map
  for (const [key, value] of Object.entries(store)) {
    if (Object.hasOwn(map, key)) continue
    setKey(map, key, value)
  }
  return map
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

/**
 * A header carried no usable value for a key there is no header without.
 *
 * Five keys reach here: the four the format requires — `"protocol"`,
 * `"perspective"`, `"detail"`, `"startTime"` — and `"segment.sequence"`, the
 * sole ordering key of a segmented stream. Every other key in the header is
 * optional, and an optional key's value never fails a file: an unusable one
 * goes to the store its map keeps and the read continues.
 *
 * The alternative is worse than the error. A reader that fills a missing
 * required key with `undefined`, an empty string or `0` returns a header the
 * file never carried, and nothing downstream can tell it from a real one — a
 * fabricated trace reported as evidence. `"segment.sequence"` is the sharpest
 * case: the default `0` turns a segment whose place in the stream is unknown
 * into one that claims to be first.
 *
 * Malformed here means malformed for *that segment*. {@link ReadOptions.recover}
 * skips it and carries on at the next one, on the same terms as a malformed
 * event.
 *
 * The writer throws the same error for the same key, before it emits anything.
 * `"startTime"` and `"segment.sequence"` are `number` fields and TypeScript
 * admits `-5` and `1.5` into both, so a header built by hand could be written
 * to a file this package's own reader then refused — a writer emitting files
 * only some other tool can open, out of a caller mistake nothing reported at
 * the point it was made. One error type for both directions because it is one
 * fault about one key, and a read-modify-write catches it once.
 */
export class MalformedHeaderError extends Error {
  /** The key at fault, dotted for one inside `"segment"`. */
  readonly key: string

  /**
   * @param key the key at fault
   * @param fault what was wrong with it, as a predicate on the key
   */
  constructor(key: string, fault: string) {
    // Absent and present-but-unusable are the same outcome — there is no
    // header to construct either way — but they are different faults, and one
    // message for both told whoever has to fix the file the wrong thing.
    // "must be a text string" on a header that carries no `"protocol"` at all
    // sends them looking at a value that is not there, and it is the message a
    // person debugging a broken capture reads.
    super(`Malformed header: ${JSON.stringify(key)} ${fault}`)
    this.name = 'MalformedHeaderError'
    this.key = key
  }
}

// --- Header serialization ---

/**
 * Write a required header integer, or refuse to write the file.
 *
 * The writer's half of {@link requireHeaderUint}, and deliberately the same
 * test: `"startTime"` and `"segment.sequence"` are the two header keys read as
 * unsigned integers *and* required, so a negative or fractional one produces a
 * file whose own reader throws `MalformedHeaderError` on it. This package
 * emitting a trace it cannot open is a worse failure than a rejected call —
 * the file is written, the process exits 0, and the fault surfaces wherever
 * someone later tries to read it, if anyone does. The Rust implementation
 * cannot reach the state at all: its field is a `u64`.
 *
 * It refuses only these two, and only the field. Every other integer in the
 * header is optional, and a negative `"endTime"` written into one is read back
 * into that map's store rather than failing the read — the value survives and
 * so does the file, which is the contract the reader already states for an
 * optional key. A store entry is never checked here either, for the reason
 * SPEC.md gives for ranking a reader's obligations above a writer's: a value
 * routed to a store is one the reader could not use and must hand back
 * unchanged, and a writer that validated it would delete exactly what the
 * store exists to carry. So a file that legitimately carries such a value can
 * still be read, edited and written back — nothing that survives a read is
 * refused on the way out.
 */
function requiredUint(value: number, reportedAs: string): number | bigint {
  if (!Number.isInteger(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) {
    throw new MalformedHeaderError(reportedAs, 'must be an unsigned integer')
  }
  return int(value)
}

function segmentToCbor(segment: SegmentInfo): Record<string, unknown> {
  const map: Record<string, unknown> = {
    sequence: requiredUint(segment.sequence, 'segment.sequence'),
  }
  if (segment.durationMs != null) map.durationMs = int(segment.durationMs)
  if (segment.streamId != null) map.streamId = segment.streamId
  if (segment.continues != null) map.continues = segment.continues
  return withStore(map, segment.extra)
}

/**
 * Read the `"segment"` map, or answer `undefined` for a value that is not one.
 *
 * `undefined` leaves the key untaken, so a `"segment"` that is not a map goes
 * to the *header's* store and the trace reads as non-segmented — which is what
 * the format asks for. Failing the file instead would turn one unreadable
 * metadata value into the loss of every event behind it.
 *
 * `"sequence"` is the exception, and the only key inside here that can fail a
 * header: it is the sole ordering key of a segmented stream, so a reader that
 * cannot read it cannot place the segment, and the `0` this function used to
 * default to invents an order the file never had.
 */
function cborToSegment(value: unknown): SegmentInfo | undefined {
  const obj = asMap(value)
  if (obj == null) return undefined
  const src: Decoding = { obj, used: new Set() }
  const segment: SegmentInfo = {
    sequence: requireHeaderUint(src, 'sequence', 'segment.sequence'),
    ...optional(src, 'durationMs', 'durationMs', asUintNumber),
    ...optional(src, 'streamId', 'streamId', asText),
    ...optional(src, 'continues', 'continues', asBoolean),
  }
  const extra = unrecognisedKeys(src)
  return extra == null ? segment : { ...segment, extra }
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
  return withStore(map, sampling.extra)
}

/** The same for `"sampling"`; every key inside it is optional. */
function cborToSampling(value: unknown): SamplingInfo | undefined {
  const obj = asMap(value)
  if (obj == null) return undefined
  const src: Decoding = { obj, used: new Set() }
  const sampling: SamplingInfo = {
    // A rate is a fraction, so this is the one header number that is not an
    // integer — and the one whose range the format states, so it is the one
    // key here checked for more than its type. It is tested rather than
    // converted: `Number('half')` is `NaN`, a rate no file carried and none
    // can be written back from.
    ...optional(src, 'effectiveRate', 'effectiveRate', asRate),
    ...optional(src, 'maxEventsPerSec', 'maxEventsPerSec', asUintNumber),
    ...optional(src, 'dropPolicy', 'dropPolicy', asText),
    ...optional(src, 'droppedTotal', 'droppedTotal', asUintNumber),
    ...optional(src, 'droppedSegment', 'droppedSegment', asUintNumber),
    ...optional(src, 'rule', 'rule', asText),
    ...optional(src, 'ruleLang', 'ruleLang', asText),
    ...optional(src, 'appliesTo', 'appliesTo', asUintNumbers),
  }
  const extra = unrecognisedKeys(src)
  return extra == null ? sampling : { ...sampling, extra }
}

function headerToCbor(header: TraceHeader): Record<string, unknown> {
  const map: Record<string, unknown> = {
    protocol: header.protocol,
    perspective: header.perspective,
    detail: header.detail,
    startTime: requiredUint(header.startTime, 'startTime'),
  }
  if (header.endTime != null) map.endTime = int(header.endTime)
  if (header.transport != null) map.transport = header.transport
  if (header.source != null) map.source = header.source
  if (header.endpoint != null) map.endpoint = header.endpoint
  if (header.sessionId != null) map.sessionId = header.sessionId
  if (header.segment != null) map.segment = segmentToCbor(header.segment)
  if (header.sampling != null) map.sampling = samplingToCbor(header.sampling)
  if (header.custom != null) map.custom = header.custom
  return withStore(map, header.extra)
}

/**
 * Decode the header, keeping every key the decode could not use.
 *
 * Three maps here have keys the format names — this one, `"segment"` and
 * `"sampling"` — and each keeps its own store, because a private key on
 * `"segment"` and a key of the same name at the top level are different keys.
 * `"custom"` keeps none: every key in it belongs to whoever wrote the trace.
 *
 * The four required keys throw rather than default. Everything else that is
 * unusable stays in the store of the map it appeared in, and the read
 * continues: an optional key's type never fails a file.
 *
 * @throws {MalformedHeaderError} when a required key is absent or unusable.
 */
export function cborToHeader(obj: Record<string, unknown>): TraceHeader {
  const src: Decoding = { obj, used: new Set() }
  const header: TraceHeader = {
    protocol: requireHeaderText(src, 'protocol'),
    perspective: requireHeaderText(src, 'perspective'),
    detail: requireHeaderText(src, 'detail'),
    startTime: requireHeaderUint(src, 'startTime'),
    ...optional(src, 'endTime', 'endTime', asUintNumber),
    ...optional(src, 'transport', 'transport', asText),
    ...optional(src, 'source', 'source', asText),
    ...optional(src, 'endpoint', 'endpoint', asText),
    ...optional(src, 'sessionId', 'sessionId', asText),
    ...optional(src, 'segment', 'segment', cborToSegment),
    ...optional(src, 'sampling', 'sampling', cborToSampling),
    // Not `Record<string, unknown>` by assertion but by test. A `"custom"`
    // that is not a map used to reach this field wearing that type, so the
    // first caller to iterate its keys met a shape it was told could not
    // occur. The bytes survive either way; only one of the two keeps the
    // field's type true.
    ...optional(src, 'custom', 'custom', asMap),
  }
  const extra = unrecognisedKeys(src)
  return extra == null ? header : { ...header, extra }
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
      if (event.streamId != null) base.sid = event.streamId
      if (event.errorKind != null) base.ek = event.errorKind
      if (event.rawLength != null) base.rawlen = int(event.rawLength)
      // Written at whatever length it arrived. The format caps `"raw"` at 4096
      // bytes and this is deliberately not where that happens: a serializer
      // cannot tell an event a recorder just built from observed bytes from one
      // that arrived by being read, so a cap here would either truncate
      // evidence on a rewrite or refuse a file the reader was required to
      // accept — whichever it did, it would do to the wrong events. The cap
      // belongs where the event is constructed from bytes, which in this
      // package is `recordError` in `recorder.ts`.
      if (event.raw != null) base.raw = event.raw
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
        setKey(base, key, value)
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
      setKey(base, key, value)
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

/** A CBOR boolean. */
function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

/**
 * A CBOR number, for the one header key defined as a float.
 *
 * Non-finite values are refused along with everything that is not a number:
 * CBOR can carry a NaN or an infinity, but neither is a fraction of the events
 * retained, and a field holding one states a rate the file never gave.
 *
 * No test covers the finite check, and none can: {@link asRate} is the only
 * caller, and its `> 0 && <= 1` already rejects NaN and both infinities, so
 * deleting `Number.isFinite` here changes no observable behaviour today. It
 * stays because the redundancy belongs to the caller and not to this function.
 * `asRate` bounds its key by meaning, which the format does for that key and
 * for no other; the next float key added here would arrive through this type
 * test with no range behind it, and would take a NaN into its field. Rather
 * than a test that cannot fail, this note.
 */
function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * A sampling rate: a number in `(0.0, 1.0]`, and no other number.
 *
 * The one value in the header the format bounds by meaning rather than by
 * type, and the bound is checked here because consumers divide by it. A `0.0`
 * handed to a caller reconstructing true event counts is a division by zero,
 * and a `1.5` is a count larger than what was recorded — each a wrong answer
 * produced silently, from a header the reader had already decided to trust.
 *
 * The interval is open at `0` and closed at `1`, so `1.0` — "no rate-based
 * dropping", the commonest value there is — passes and `0.0` does not. A value
 * outside it is unusable on an optional key, so it goes to the sampling map's
 * store with its bytes intact rather than failing the file. NaN fails both
 * comparisons, which is the wanted answer twice over: it is in no interval,
 * and it is no fraction of the events retained.
 */
function asRate(value: unknown): number | undefined {
  const rate = asNumber(value)
  return rate != null && rate > 0 && rate <= 1 ? rate : undefined
}

/**
 * A CBOR array of unsigned integers — the shape `"sampling.appliesTo"` takes.
 *
 * All or nothing, like {@link asByteStrings}. An array with one element that is
 * not an event type ID is unusable *entire*: this key names the types a drop
 * policy touched, and readers may treat every type absent from it as complete,
 * so keeping `[3, 5]` out of `[3, "x", 5]` would report a sampled type as fully
 * recorded — the opposite of what the file said, stated just as confidently.
 */
function asUintNumbers(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined
  const ids: number[] = []
  for (const item of value) {
    const id = asUintNumber(item)
    if (id == null) return undefined
    ids.push(id)
  }
  return ids
}

/**
 * A CBOR map, as the plain object this codec decodes one to.
 *
 * `typeof value === 'object'` is not the test: it also admits `null`, an array,
 * a byte string and a tagged value, each of which would then be handed back as
 * a field map and read `undefined` for every key. The prototype is what
 * separates them — a decoded map is a plain object, and everything else this
 * decoder produces for a non-map is an instance of something. A `Map` fails the
 * same test, which is right for the same reason: a reader that cannot hold a
 * map exactly must route it to a store rather than hand back a shape its own
 * declared type denies.
 */
function asMap(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) return undefined
  return value as Record<string, unknown>
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
 * Take a required header text key, or fail the header.
 *
 * The reader used to assert the type instead — `obj.protocol as string` — which
 * let a header with no `"protocol"` reach a caller with `undefined` sitting in
 * a field declared `string`, and re-encode as CBOR `undefined`, a shape the
 * format tells writers never to produce.
 */
function requireHeaderText(src: Decoding, key: string): string {
  const present = Object.hasOwn(src.obj, key)
  const value = asText(take(src, key))
  if (value == null) {
    throw new MalformedHeaderError(key, present ? 'must be a text string' : 'is missing')
  }
  return value
}

/**
 * Take a required header integer key, or fail the header.
 *
 * @param reportedAs the key's name in the error, dotted for one inside
 *   `"segment"`, where `"sequence"` alone would not say which map it was in.
 */
function requireHeaderUint(src: Decoding, key: string, reportedAs = key): number {
  const present = Object.hasOwn(src.obj, key)
  const value = asUintNumber(take(src, key))
  if (value == null) {
    throw new MalformedHeaderError(
      reportedAs,
      present ? 'must be an unsigned integer' : 'is missing',
    )
  }
  return value
}

/**
 * Take an optional key, as the property to spread onto the event or header map
 * being built — or nothing at all, when the key is absent or carries a value of
 * a type this reader cannot use.
 *
 * Those two cases build the same result and differ in what they leave behind:
 * an absent key leaves nothing, an unusable one stays untaken and is preserved
 * verbatim as an unrecognised key. Neither throws. The events around this one
 * decoded fine, and one key's type is no reason to lose them.
 *
 * `read` may itself throw, which is how `"segment.sequence"` fails a header
 * from inside an otherwise optional `"segment"`.
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
export function cborToEvent(obj: Record<string, unknown>): TraceEvent {
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
      if (!COMMON_EVENT_KEYS.has(key)) setKey(fields, key, value)
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
        // Optional, so an unusable value costs the key and not the event: the
        // error code and reason are the point of the event and are fine.
        // `asUint` rather than a conversion, for the reason Event 1 gives —
        // `BigInt(true)` is `1n`, a stream this file never named.
        ...optional(src, 'sid', 'streamId', asUint),
        // An error kind this version has never heard of is still text, and
        // still kept: the vocabulary is open and `ErrorKind` widens to any
        // string for exactly that. What `asText` refuses is a value that is
        // not text at all.
        ...optional(src, 'ek', 'errorKind', asText),
        ...optional(src, 'rawlen', 'rawLength', asUintNumber),
        // No length check. The 4096-byte cap binds a recorder; a reader that
        // refused a longer value — or shortened it — would reject a file it was
        // required to accept, or destroy the evidence the field exists to
        // carry.
        ...optional(src, 'raw', 'raw', asByteString),
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

export function startsWithMagic(bytes: Uint8Array, offset: number): boolean {
  if (offset + MAGIC.length > bytes.length) return false
  for (let i = 0; i < MAGIC.length; i++) {
    if (bytes[offset + i] !== MAGIC[i]) return false
  }
  return true
}

/**
 * Read and check a segment preamble, for a buffer that holds the whole file.
 *
 * **"Too short" means truncated here, and that is only true of a whole file.**
 * A caller reading a complete buffer has everything the file will ever have,
 * so a preamble that runs off the end is a cut recording. A caller reading a
 * *stream* is in the opposite situation: a short buffer is the ordinary state
 * between two chunks, and the missing bytes are on their way. An incremental
 * reader that reuses this function would report a truncation on every chunk
 * boundary.
 *
 * The distinction is invisible from the name, which is why it is written down:
 * `createMoqtraceReader` does its own length checks for this reason and shares
 * only the parts that carry meaning — the version check and `cborToHeader`.
 */
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

  /**
   * Called once for each region `recover` skipped.
   *
   * Without it a recovered read cannot be told from a clean one: the return
   * type carries no error channel, so a trace that lost a segment and a trace
   * that never had one are the same value.
   */
  readonly onRecovered?: (region: RecoveredRegion) => void
}

/** A region `recover` could not read. */
export interface RecoveredRegion {
  /** Byte offset the unreadable region began at. */
  readonly offset: number

  /**
   * What was lost: `header` drops the whole segment, `event` cuts the segment
   * in progress short, `truncated` means the item ran past end of file.
   */
  readonly kind: 'header' | 'event' | 'truncated'

  /**
   * Offset the read resumed at, or `undefined` when no further segment
   * followed — everything from `offset` on was then discarded.
   */
  readonly resumedAt: number | undefined

  /** The decode failure, absent when the region was merely truncated. */
  readonly cause?: unknown
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

  // Reports the skip before resuming, including the case where nothing follows
  // it: discarding the tail of a file is the largest loss recovery can inflict
  // and the one a caller most needs told about.
  const skip = (from: number, kind: RecoveredRegion['kind'], cause?: unknown): number => {
    const next = findNextSegment(bytes, from + 1)
    options?.onRecovered?.({ offset: from, kind, resumedAt: next < 0 ? undefined : next, cause })
    return next
  }

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
      let header: TraceHeader
      try {
        header = cborToHeader(decode(headerBytes) as Record<string, unknown>)
      } catch (error) {
        // A header this reader cannot build is malformed for *that segment*,
        // and the segment is not presented as read — the alternative is a
        // header the file never carried, which nothing downstream can tell
        // from a real one. `recover` skips to the next segment, on the same
        // terms as a malformed event; without it the read stops here.
        if (!recover) throw error
        const next = skip(offset, 'header', error)
        if (next < 0) return segments
        offset = next
        continue
      }
      events = []
      segments.push({ header, events })
      offset = start + headerLength
      continue
    }

    let length: number | null
    let failure: unknown
    try {
      length = cborItemLength(bytes, offset)
    } catch (error) {
      if (!recover || !(error instanceof MalformedCborError)) throw error
      length = null
      failure = error
    }

    if (length != null) {
      try {
        const item = decode(bytes.subarray(offset, offset + length))
        events.push(cborToEvent(item as Record<string, unknown>))
        offset += length
        continue
      } catch (error) {
        if (!recover) throw error
        failure = error
      }
    } else if (!recover) {
      throw new TruncatedTraceError(offset, segments)
    }

    // No failure means `cborItemLength` returned null: the item runs past the
    // end of the file rather than being malformed where it sits.
    const next = skip(offset, failure === undefined ? 'truncated' : 'event', failure)
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
 * @throws {MalformedHeaderError} if a segment header carries no usable value
 *   for a required key. Pass `recover` to skip that segment instead.
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
 *
 * @throws {MalformedHeaderError} as {@link readMoqtrace} does.
 */
export function readMoqtraceSegments(bytes: Uint8Array, options?: ReadOptions): Trace[] {
  return readSegments(bytes, options)
}

/**
 * Read only the header from a .moqtrace file (fast metadata peek).
 *
 * In a segmented file this is the first segment's header.
 *
 * @throws {MalformedHeaderError} if that header carries no usable value for a
 *   required key. There is no partial header to hand back and no later segment
 *   to fall forward to, so this one always throws.
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
