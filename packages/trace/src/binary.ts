import { Encoder } from 'cbor-x'
import type { DetailLevel, Perspective, Trace, TraceEvent, TraceHeader } from './types.js'

// Use a CBOR codec configured for cross-language interop.
// Why: cbor-x's default `useRecords: true` enables a proprietary "record
// extension" that encodes JS objects as tagged structures rather than standard
// CBOR maps — unreadable by ciborium (Rust) and other spec-compliant decoders.
// The .moqtrace spec requires standard CBOR, so we disable records and encode
// as plain maps. `mapsAsObjects` is set so decoded maps come back as plain
// JS objects (matching the code that accesses fields via `obj.protocol`).
const codec = new Encoder({ useRecords: false, mapsAsObjects: true })
const encode = (value: unknown): Uint8Array => codec.encode(value)
const decode = (bytes: Uint8Array): unknown => codec.decode(bytes)
const decodeMultiple = (bytes: Uint8Array, cb: (value: unknown) => void): void => {
  codec.decodeMultiple(bytes, cb as (value: unknown) => boolean | undefined)
}

const MAGIC = new Uint8Array([0x4d, 0x4f, 0x51, 0x54, 0x52, 0x41, 0x43, 0x45]) // "MOQTRACE"
const FORMAT_VERSION = 1
const PREAMBLE_SIZE = 16 // 8 magic + 4 version + 4 header length

// Event type string ↔ integer mapping
const EVENT_TYPE_TO_INT: Record<TraceEvent['type'], number> = {
  control: 0,
  'stream-opened': 1,
  'stream-closed': 2,
  'object-header': 3,
  'object-payload': 4,
  'state-change': 5,
  error: 6,
  annotation: 7,
}

const INT_TO_EVENT_TYPE: Record<number, TraceEvent['type']> = {
  0: 'control',
  1: 'stream-opened',
  2: 'stream-closed',
  3: 'object-header',
  4: 'object-payload',
  5: 'state-change',
  6: 'error',
  7: 'annotation',
}

// --- Header serialization ---

function headerToCbor(header: TraceHeader): Record<string, unknown> {
  const map: Record<string, unknown> = {
    protocol: header.protocol,
    perspective: header.perspective,
    detail: header.detail,
    startTime: header.startTime,
  }
  if (header.endTime != null) map.endTime = header.endTime
  if (header.transport != null) map.transport = header.transport
  if (header.source != null) map.source = header.source
  if (header.endpoint != null) map.endpoint = header.endpoint
  if (header.sessionId != null) map.sessionId = header.sessionId
  if (header.custom != null) map.custom = header.custom
  return map
}

function cborToHeader(obj: Record<string, unknown>): TraceHeader {
  return {
    protocol: obj.protocol as string,
    perspective: obj.perspective as Perspective,
    detail: obj.detail as DetailLevel,
    startTime: obj.startTime as number,
    ...(obj.endTime != null ? { endTime: obj.endTime as number } : {}),
    ...(obj.transport != null ? { transport: obj.transport as string } : {}),
    ...(obj.source != null ? { source: obj.source as string } : {}),
    ...(obj.endpoint != null ? { endpoint: obj.endpoint as string } : {}),
    ...(obj.sessionId != null ? { sessionId: obj.sessionId as string } : {}),
    ...(obj.custom != null ? { custom: obj.custom as Record<string, unknown> } : {}),
  }
}

// --- Event serialization ---

function eventToCbor(event: TraceEvent): Record<string, unknown> {
  const base: Record<string, unknown> = {
    n: event.seq,
    t: event.timestamp,
    e: EVENT_TYPE_TO_INT[event.type],
  }

  switch (event.type) {
    case 'control': {
      base.d = event.direction
      base.mt = event.messageType
      base.msg = event.message
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
      base.ec = event.errorCode
      break
    }
    case 'object-header': {
      base.sid = event.streamId
      base.g = event.groupId
      base.o = event.objectId
      base.pp = event.publisherPriority
      base.os = event.objectStatus
      break
    }
    case 'object-payload': {
      base.sid = event.streamId
      base.g = event.groupId
      base.o = event.objectId
      base.sz = event.size
      if (event.payload != null) base.pl = event.payload
      break
    }
    case 'state-change': {
      base.from = event.from
      base.to = event.to
      break
    }
    case 'error': {
      base.ec = event.errorCode
      base.reason = event.reason
      break
    }
    case 'annotation': {
      base.label = event.label
      if (event.data !== undefined) base.data = event.data
      break
    }
  }

  return base
}

function cborToEvent(obj: Record<string, unknown>): TraceEvent {
  const eventType = INT_TO_EVENT_TYPE[obj.e as number]
  if (eventType == null) {
    // Unknown event type — skip per spec (return annotation as fallback)
    return {
      type: 'annotation',
      seq: Number(obj.n ?? 0),
      timestamp: Number(obj.t ?? 0),
      label: `unknown-event-${obj.e}`,
      data: obj,
    }
  }

  const seq = Number(obj.n ?? 0)
  const timestamp = Number(obj.t ?? 0)

  switch (eventType) {
    case 'control':
      return {
        type: 'control' as const,
        seq,
        timestamp,
        direction: obj.d as 0 | 1,
        messageType: Number(obj.mt ?? 0),
        message: (obj.msg ?? {}) as Record<string, unknown>,
        ...(obj.raw != null ? { raw: obj.raw as Uint8Array } : {}),
      }

    case 'stream-opened':
      return {
        type: 'stream-opened' as const,
        seq,
        timestamp,
        streamId: BigInt(obj.sid as bigint | number),
        direction: obj.d as 0 | 1,
        streamType: obj.st as 0 | 1 | 2,
      }

    case 'stream-closed':
      return {
        type: 'stream-closed' as const,
        seq,
        timestamp,
        streamId: BigInt(obj.sid as bigint | number),
        errorCode: Number(obj.ec ?? 0),
      }

    case 'object-header':
      return {
        type: 'object-header' as const,
        seq,
        timestamp,
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
        streamId: BigInt(obj.sid as bigint | number),
        groupId: BigInt(obj.g as bigint | number),
        objectId: BigInt(obj.o as bigint | number),
        size: Number(obj.sz ?? 0),
        ...(obj.pl != null ? { payload: obj.pl as Uint8Array } : {}),
      }

    case 'state-change':
      return {
        type: 'state-change' as const,
        seq,
        timestamp,
        from: obj.from as string,
        to: obj.to as string,
      }

    case 'error':
      return {
        type: 'error' as const,
        seq,
        timestamp,
        errorCode: Number(obj.ec ?? 0),
        reason: (obj.reason ?? '') as string,
      }

    case 'annotation':
      return {
        type: 'annotation' as const,
        seq,
        timestamp,
        label: (obj.label ?? '') as string,
        data: obj.data,
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

function validatePreamble(bytes: Uint8Array): {
  version: number
  headerLength: number
} {
  if (bytes.length < PREAMBLE_SIZE) {
    throw new Error('File too short: expected at least 16 bytes')
  }

  for (let i = 0; i < 8; i++) {
    if (bytes[i] !== MAGIC[i]) {
      throw new Error('Invalid magic bytes: not a .moqtrace file')
    }
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const version = view.getUint32(8, true)
  if (version !== FORMAT_VERSION) {
    throw new Error(`Unsupported format version: ${version} (expected ${FORMAT_VERSION})`)
  }

  const headerLength = view.getUint32(12, true)
  if (PREAMBLE_SIZE + headerLength > bytes.length) {
    throw new Error('File truncated: header extends beyond file')
  }

  return { version, headerLength }
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
 * Read a complete .moqtrace file from bytes.
 */
export function readMoqtrace(bytes: Uint8Array): Trace {
  const { headerLength } = validatePreamble(bytes)

  const headerBytes = bytes.slice(PREAMBLE_SIZE, PREAMBLE_SIZE + headerLength)
  const header = cborToHeader(decode(headerBytes) as Record<string, unknown>)

  const eventBytes = bytes.slice(PREAMBLE_SIZE + headerLength)
  const events: TraceEvent[] = []

  if (eventBytes.length > 0) {
    decodeMultiple(eventBytes, (obj: unknown) => {
      events.push(cborToEvent(obj as Record<string, unknown>))
    })
  }

  return { header, events }
}

/**
 * Read only the header from a .moqtrace file (fast metadata peek).
 */
export function readMoqtraceHeader(bytes: Uint8Array): TraceHeader {
  const { headerLength } = validatePreamble(bytes)
  const headerBytes = bytes.slice(PREAMBLE_SIZE, PREAMBLE_SIZE + headerLength)
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
  }
}
