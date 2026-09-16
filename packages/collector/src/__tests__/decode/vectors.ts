/**
 * Test vectors for the counting decoder, **encoded by `@moqtap/codec` itself**.
 *
 * Nothing here writes a byte by hand: every vector is built with the codec's own
 * `encodeSubgroupStream`, `encodeFetchStream`, `encodeDatagram` and
 * `encodeMessage`, so the tests measure this module against the shipped
 * encoder's draft-20 rather than a second hand-transcription, which would agree
 * with a wrong walk for exactly the same wrong reasons.
 *
 * The encoders are also the only honest way to build the case this module exists
 * for: a subgroup stream with a status object in the middle, which
 * `createSubgroupStreamDecoder` desynchronises on.
 */

import {
  type DatagramObject,
  type Draft20Message,
  encodeDatagram,
  encodeFetchStream,
  encodeMessage,
  encodeSubgroupStream,
  type FetchObjectPayload,
  type FetchStream,
  type ObjectPayload,
  type SubgroupStream,
} from '@moqtap/codec/draft20'
import type {
  BucketKey,
  ControlFrameEvent,
  CountingSink,
  ObjectSample,
  ParseFailureReason,
} from '../../types.js'

export { DRAFT20_ADAPTER } from '../../drafts/draft20/index.js'

/** A recognisable payload of `n` bytes. */
export function filled(n: number, seed = 0x40): Uint8Array {
  const b = new Uint8Array(n)
  for (let i = 0; i < n; i++) b[i] = (seed + i) & 0xff
  return b
}

export interface ObjSpec {
  readonly id: bigint
  /** Payload length. `0` with no `status` still encodes an Object Status of 0. */
  readonly bytes?: number
  readonly status?: bigint
  readonly props?: Record<string, bigint>
}

function objectPayload(o: ObjSpec): ObjectPayload {
  const len = o.bytes ?? 0
  const base = {
    type: 'object' as const,
    byteOffset: 0,
    payloadByteOffset: 0,
    objectId: o.id,
    payloadLength: len,
    payload: filled(len),
    extensionData: new Uint8Array(0),
  }
  const withStatus = o.status === undefined ? base : { ...base, status: o.status }
  return o.props === undefined ? withStatus : { ...withStatus, objectProperties: o.props }
}

export interface SubgroupSpec {
  readonly alias: bigint
  readonly group: bigint
  /**
   * SUBGROUP_HEADER Type Flags. `0x10` is the minimum legal value: bit 4 set,
   * SUBGROUP_ID_MODE `0b00`, DEFAULT_PRIORITY clear so the Priority byte is
   * present. `0x11` adds PROPERTIES; `0x30` drops the Priority byte.
   */
  readonly headerType?: number
  readonly subgroupId?: bigint
  readonly objects: readonly ObjSpec[]
}

export function subgroupStream(s: SubgroupSpec): SubgroupStream {
  return {
    type: 'subgroup',
    headerType: s.headerType ?? 0x10,
    trackAlias: s.alias,
    groupId: s.group,
    subgroupId: s.subgroupId ?? 0n,
    publisherPriority: 128,
    objects: s.objects.map(objectPayload),
  }
}

export function subgroupBytes(s: SubgroupSpec): Uint8Array {
  return encodeSubgroupStream(subgroupStream(s))
}

export interface FetchObjSpec {
  readonly group: bigint
  readonly id: bigint
  readonly bytes?: number
  /**
   * Serialization Flags. `0x0c` — Group ID Delta present, Object ID Delta
   * present, Subgroup ID mode `0b00` — is the ordinary shape and the one the
   * first object on a stream is required to use (draft-20 §11.4.4.1: "The first
   * Object MUST include a Group ID Delta and Object ID Delta").
   */
  readonly flags?: number
}

function fetchObject(o: FetchObjSpec): FetchObjectPayload {
  const len = o.bytes ?? 0
  return {
    type: 'object',
    byteOffset: 0,
    payloadByteOffset: 0,
    serializationFlags: o.flags ?? 0x0c,
    groupId: o.group,
    subgroupId: 0n,
    objectId: o.id,
    publisherPriority: 128,
    payloadLength: len,
    payload: filled(len),
    extensionData: new Uint8Array(0),
  }
}

export function fetchStream(requestId: bigint, objects: readonly FetchObjSpec[]): FetchStream {
  return { type: 'fetch', requestId, objects: objects.map(fetchObject) }
}

export function fetchBytes(requestId: bigint, objects: readonly FetchObjSpec[]): Uint8Array {
  return encodeFetchStream(fetchStream(requestId, objects))
}

export interface DatagramSpec {
  readonly alias: bigint
  readonly group: bigint
  readonly id: bigint
  readonly bytes?: number
  /** Type Flags. `0x00` is the plain form: Object ID and Priority both present. */
  readonly type?: number
  readonly status?: bigint
}

export function datagramBytes(d: DatagramSpec): Uint8Array {
  const len = d.bytes ?? 0
  const base: DatagramObject = {
    type: 'datagram',
    datagramType: d.type ?? 0x00,
    trackAlias: d.alias,
    groupId: d.group,
    objectId: d.id,
    publisherPriority: 128,
    payloadLength: len,
    payload: filled(len),
  }
  return encodeDatagram(d.status === undefined ? base : { ...base, objectStatus: d.status })
}

/* ── control messages ────────────────────────────────────────────────────── */

export function subscribeBytes(requestId: bigint, name = 'video'): Uint8Array {
  return encodeMessage({
    type: 'subscribe',
    request_id: requestId,
    track_namespace: ['moqtap', 'test'],
    track_name: name,
    parameters: {},
  })
}

export function subscribeOkBytes(alias: bigint): Uint8Array {
  return encodeMessage({
    type: 'subscribe_ok',
    track_alias: alias,
    parameters: {},
    track_properties: {},
  })
}

export function publishBytes(requestId: bigint, alias: bigint, name = 'video'): Uint8Array {
  return encodeMessage({
    type: 'publish',
    request_id: requestId,
    track_namespace: ['moqtap', 'test'],
    track_name: name,
    track_alias: alias,
    parameters: {},
    track_properties: {},
  })
}

export function publishDoneBytes(): Uint8Array {
  return encodeMessage({
    type: 'publish_done',
    status_code: 0n,
    stream_count: 1n,
    reason_phrase: '',
  })
}

export function encodeControl(msg: Draft20Message): Uint8Array {
  return encodeMessage(msg)
}

/**
 * A control frame with a Message Type no draft-20 decoder knows.
 *
 * The case `createStreamDecoder` turns into `controller.error()` and this module
 * has to survive: `type (vi64) + uint16 length + body`, framed correctly,
 * decodable never.
 */
export function unknownControlFrame(payload: Uint8Array = filled(4)): Uint8Array {
  // 0x3f3f is not assigned in draft-20's message table. As a MoQT vi64 it is the
  // two-byte `bf 3f` (one leading 1 bit), so the frame is well formed.
  const frame = new Uint8Array(2 + 2 + payload.length)
  frame[0] = 0xbf
  frame[1] = 0x3f
  frame[2] = (payload.length >> 8) & 0xff
  frame[3] = payload.length & 0xff
  frame.set(payload, 4)
  return frame
}

export function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  let n = 0
  for (const p of parts) n += p.length
  const out = new Uint8Array(n)
  let i = 0
  for (const p of parts) {
    out.set(p, i)
    i += p.length
  }
  return out
}

/** Split into fixed-size chunks, the way a transport delivers them. */
export function chunks(b: Uint8Array, size: number): Uint8Array[] {
  if (size >= b.length) return [b]
  const out: Uint8Array[] = []
  for (let i = 0; i < b.length; i += size) out.push(b.subarray(i, Math.min(i + size, b.length)))
  return out
}

/* ── a sink that remembers, for assertions ───────────────────────────────── */

export interface RecordedControl {
  readonly dir: string
  readonly streamId: number
  readonly at: number
  /** A **copy**: `ControlFrameEvent.bytes` is borrowed and may be rewritten. */
  readonly bytes: Uint8Array
  readonly message: Record<string, unknown> | null
}

export class Recorder implements CountingSink {
  readonly objects: ObjectSample[] = []
  readonly control: RecordedControl[] = []
  readonly failures: { key: BucketKey | null; reason: ParseFailureReason }[] = []
  readonly latencies: { kind: string; ms: number }[] = []
  readonly shared: BucketKey[] = []

  onObject(s: ObjectSample): void {
    this.objects.push(s)
  }

  onControlFrame(e: ControlFrameEvent): void {
    this.control.push({
      dir: e.dir,
      streamId: e.streamId,
      at: e.at,
      bytes: e.bytes.slice(),
      message: e.message === null ? null : (e.message as Record<string, unknown>),
    })
  }

  onParseFailure(key: BucketKey | null, reason: ParseFailureReason): void {
    this.failures.push({ key, reason })
  }

  /** The optional rollup extension the dispatcher bridges to. */
  observeControlLatency(kind: string, ms: number): void {
    this.latencies.push({ kind, ms })
  }

  /** The optional rollup extension for the shared-alias flag. */
  markShared(key: BucketKey): void {
    this.shared.push(key)
  }

  get reasons(): ParseFailureReason[] {
    return this.failures.map((f) => f.reason)
  }

  get totalPayloadBytes(): number {
    return this.objects.reduce((n, o) => n + o.payloadBytes, 0)
  }

  get totalHeaderBytes(): number {
    return this.objects.reduce((n, o) => n + o.headerBytes, 0)
  }
}
