import { Encoder } from 'cbor-x'
import { cborItemLength, MalformedCborError } from './cbor-scan.js'
import type {
  DerivationKind,
  DetailLevel,
  DropPolicy,
  PeerRole,
  Perspective,
  SamplingInfo,
  SegmentInfo,
  Side,
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
 * The keys each known event type owns, in the order it writes them.
 *
 * Everything else on such an event is a key this version does not recognise,
 * and goes to `extra` rather than being dropped. Adding a key to an event type
 * means adding it here too — a key read into a named field but missing from
 * this list would be written twice, once from the field and once from `extra`.
 *
 * An unknown event type is absent: `UnknownEvent.fields` already holds every
 * non-common key on it, so nothing is collected into `extra` there.
 */
const VARIANT_KEYS: Record<number, ReadonlySet<string>> = {
  0: new Set(['d', 'mt', 'msg', 'sid', 'raw']),
  1: new Set(['sid', 'd', 'st']),
  2: new Set(['sid', 'ec']),
  3: new Set(['sid', 'g', 'o', 'pp', 'os']),
  4: new Set(['sid', 'g', 'o', 'sz', 'pl']),
  5: new Set(['from', 'to']),
  6: new Set(['ec', 'reason']),
  7: new Set(['label', 'data']),
  8: new Set(['endpoint', 'transport', 'role', 'side']),
  9: new Set(['ec', 'reason']),
  10: new Set(['u', 'd', 'kind', 'traceId', 'ns', 'tn', 'tdr', 'tus', 'tuo', 'tdo']),
}

/** Every key on a decoded event map that neither the common fields nor its type owns. */
function unrecognisedKeys(
  obj: Record<string, unknown>,
  eventType: number,
): Record<string, unknown> | undefined {
  const owned = VARIANT_KEYS[eventType]
  if (owned == null) return undefined

  let extra: Record<string, unknown> | undefined
  for (const [key, value] of Object.entries(obj)) {
    if (COMMON_EVENT_KEYS.has(key) || owned.has(key)) continue
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
  return { peer: value[0] as string, requestId: BigInt(value[1] as bigint | number) }
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
 * Read a trace id, refusing any length but the one the format fixes.
 *
 * A wrong-length value is malformed rather than something to pad or truncate:
 * the identifier exists so two implementations independently derive
 * byte-identical values for one subscription chain, and a reader that quietly
 * reshapes it breaks exactly the property it is there for.
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
      base.msg = event.message
      if (event.streamId != null) base.sid = event.streamId
      if (event.raw != null) base.raw = event.raw
      break
    }
    case 'stream-opened': {
      base.sid = event.streamId
      base.d = event.direction
      base.st = event.streamType
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
  // file stays diffable against one written without them. A key the type owns
  // is written from the field, so an `extra` entry repeating it is dropped:
  // a CBOR map with a duplicate key is malformed, and the field is what a
  // reader produced.
  if (event.type !== 'unknown' && event.extra != null) {
    const owned = VARIANT_KEYS[EVENT_TYPE_TO_INT[event.type]]
    for (const [key, value] of Object.entries(event.extra)) {
      if (COMMON_EVENT_KEYS.has(key) || owned?.has(key)) continue
      base[key] = value
    }
  }

  return base
}

/**
 * Decode one event, keeping any key its type does not own.
 *
 * The keys are kept on the event rather than dropped so that reading a trace
 * and writing it back does not quietly strip what a newer writer put there.
 * An `UnknownEvent` is returned untouched: its `fields` already hold every
 * non-common key, and adding them to `extra` too would write each one twice.
 */
function cborToEvent(obj: Record<string, unknown>): TraceEvent {
  const event = decodeEvent(obj)
  if (event.type === 'unknown') return event

  const extra = unrecognisedKeys(obj, EVENT_TYPE_TO_INT[event.type])
  return extra == null ? event : { ...event, extra }
}

function decodeEvent(obj: Record<string, unknown>): TraceEvent {
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
        direction: obj.d as 0 | 1,
        messageType: Number(obj.mt ?? 0),
        message: (obj.msg ?? {}) as Record<string, unknown>,
        ...(obj.sid != null ? { streamId: BigInt(obj.sid as bigint | number) } : {}),
        ...(obj.raw != null ? { raw: toBytes(obj.raw) } : {}),
      }

    case 'stream-opened':
      return {
        type: 'stream-opened' as const,
        seq,
        timestamp,
        ...peerFields,
        streamId: BigInt(obj.sid as bigint | number),
        direction: obj.d as 0 | 1,
        streamType: obj.st as 0 | 1 | 2,
      }

    case 'stream-closed':
      return {
        type: 'stream-closed' as const,
        seq,
        timestamp,
        ...peerFields,
        streamId: BigInt(obj.sid as bigint | number),
        errorCode: Number(obj.ec ?? 0),
      }

    case 'object-header':
      return {
        type: 'object-header' as const,
        seq,
        timestamp,
        ...peerFields,
        streamId: BigInt(obj.sid as bigint | number),
        groupId: BigInt(obj.g as bigint | number),
        objectId: BigInt(obj.o as bigint | number),
        publisherPriority: Number(obj.pp ?? 0),
        objectStatus: Number(obj.os ?? 0),
      }

    case 'object-payload':
      return {
        type: 'object-payload' as const,
        seq,
        timestamp,
        ...peerFields,
        streamId: BigInt(obj.sid as bigint | number),
        groupId: BigInt(obj.g as bigint | number),
        objectId: BigInt(obj.o as bigint | number),
        size: Number(obj.sz ?? 0),
        ...(obj.pl != null ? { payload: toBytes(obj.pl) } : {}),
      }

    case 'state-change':
      return {
        type: 'state-change' as const,
        seq,
        timestamp,
        ...peerFields,
        from: obj.from as string,
        to: obj.to as string,
      }

    case 'error':
      return {
        type: 'error' as const,
        seq,
        timestamp,
        ...peerFields,
        errorCode: Number(obj.ec ?? 0),
        reason: (obj.reason ?? '') as string,
      }

    case 'annotation':
      return {
        type: 'annotation' as const,
        seq,
        timestamp,
        ...peerFields,
        label: (obj.label ?? '') as string,
        data: obj.data,
      }

    case 'peer-connected':
      return {
        type: 'peer-connected' as const,
        seq,
        timestamp,
        ...peerFields,
        ...(obj.endpoint != null ? { endpoint: obj.endpoint as string } : {}),
        ...(obj.transport != null ? { transport: obj.transport as string } : {}),
        ...(obj.role != null ? { role: obj.role as PeerRole } : {}),
        ...(obj.side != null ? { side: obj.side as Side } : {}),
      }

    case 'peer-disconnected':
      return {
        type: 'peer-disconnected' as const,
        seq,
        timestamp,
        ...peerFields,
        errorCode: Number(obj.ec ?? 0),
        ...(obj.reason != null ? { reason: obj.reason as string } : {}),
      }

    case 'subscription-derivation':
      return {
        type: 'subscription-derivation' as const,
        seq,
        timestamp,
        ...peerFields,
        upstream: cborToSubscriptionRef(obj.u),
        downstream: ((obj.d ?? []) as unknown[]).map(cborToSubscriptionRef),
        kind: (obj.kind ?? '') as DerivationKind,
        ...(obj.traceId != null ? { traceId: checkTraceId(obj.traceId) } : {}),
        ...(obj.ns != null ? { namespace: (obj.ns as unknown[]).map(toBytes) } : {}),
        ...(obj.tn != null ? { trackName: toBytes(obj.tn) } : {}),
        ...(obj.tdr != null ? { tDownstreamReceived: Number(obj.tdr) } : {}),
        ...(obj.tus != null ? { tUpstreamSent: Number(obj.tus) } : {}),
        ...(obj.tuo != null ? { tUpstreamOkReceived: Number(obj.tuo) } : {}),
        ...(obj.tdo != null ? { tDownstreamOkSent: Number(obj.tdo) } : {}),
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
