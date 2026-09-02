/**
 * The content of every corpus case this package authors.
 *
 * `moqtap-trace`'s `examples/generate_corpus.rs` builds the same cases from
 * the same values. That duplication is the point: the corpus test reads both
 * files and asserts they carry identical content, so a change made on one
 * side and not the other fails rather than drifts. Keep the two in step, and
 * keep the ordering identical — the assertion compares event lists
 * positionally.
 *
 * Values here are fixed rather than generated. A corpus whose bytes change
 * every time it is regenerated cannot be reviewed in a diff, and the whole
 * claim it backs is about bytes.
 */

import type { Trace, TraceEvent, TraceHeader } from '../../types.js'
import { TRACE_ID_LENGTH } from '../../types.js'

/**
 * 2026-01-01T00:00:00Z.
 *
 * Deliberately past 2^32: cbor-x encodes any number that large as a float64
 * unless told otherwise, and a decoder that reads only integers then finds
 * `startTime` missing. That was a real interop break, and it is now a
 * normative rule (SPEC.md, Interoperability) — so every corpus header
 * exercises it.
 */
export const START_TIME = 1767225600000

/** 16 bytes, the length the format fixes for a trace id. */
export const TRACE_ID = new Uint8Array(Array.from({ length: TRACE_ID_LENGTH }, (_, i) => i))

const bytes = (...values: number[]): Uint8Array => new Uint8Array(values)

const text = (value: string): Uint8Array => new TextEncoder().encode(value)

/**
 * Events legal in a version-1 file: types 0-7, no `"p"`, no `"segment"`, no
 * `"sampling"`, no `"relay-tap"`. Version 2 added everything else, so this
 * list is exactly what a pre-bump recorder could have written.
 */
function baseEvents(): TraceEvent[] {
  return [
    {
      type: 'control',
      seq: 0,
      timestamp: 0,
      direction: 0,
      messageType: 0x40,
      // snake_case, matching the shared codec vectors and the JS codec.
      message: { request_id: 1, track_alias: 2 },
      raw: bytes(0x40, 0x02, 0x01, 0x02),
    },
    { type: 'stream-opened', seq: 1, timestamp: 1500, streamId: 4n, direction: 1, streamType: 0 },
    {
      type: 'object-header',
      seq: 2,
      timestamp: 1600,
      streamId: 4n,
      groupId: 1n,
      objectId: 0n,
      publisherPriority: 128,
      objectStatus: 0,
    },
    {
      type: 'object-payload',
      seq: 3,
      timestamp: 1700,
      streamId: 4n,
      groupId: 1n,
      objectId: 0n,
      size: 5,
      payload: text('hello'),
    },
    { type: 'stream-closed', seq: 4, timestamp: 2000, streamId: 4n, errorCode: 0 },
    { type: 'state-change', seq: 5, timestamp: 2100, from: 'connected', to: 'closing' },
    { type: 'error', seq: 6, timestamp: 2200, errorCode: 0, reason: 'stream reset by peer' },
    { type: 'annotation', seq: 7, timestamp: 2300, label: 'note', data: 'corpus' },
  ]
}

/** Events version 2 added: peer lifecycle, subscription derivation. */
function v2OnlyEvents(): TraceEvent[] {
  return [
    {
      type: 'peer-connected',
      seq: 8,
      timestamp: 2400,
      peer: 'peer-a',
      endpoint: '127.0.0.1:50000',
      transport: 'raw-quic',
      role: 'subscriber',
      side: 'downstream',
    },
    {
      type: 'subscription-derivation',
      seq: 9,
      timestamp: 2500,
      peer: 'peer-a',
      upstream: { peer: 'origin', requestId: 1n },
      downstream: [
        { peer: 'peer-a', requestId: 7n },
        { peer: 'peer-b', requestId: 9n },
      ],
      kind: 'created',
      traceId: TRACE_ID,
      namespace: [text('example'), text('live')],
      trackName: text('now'),
      tDownstreamReceived: 2400,
      tUpstreamSent: 2410,
      tUpstreamOkReceived: 2480,
      tDownstreamOkSent: 2490,
    },
    {
      // Stream and group ids past 2^32, for the same reason START_TIME is:
      // these decode to bigint in JS and u64 in Rust, and an encoder that
      // demotes them to a float loses the low bits silently.
      type: 'object-header',
      seq: 10,
      timestamp: 2600,
      peer: 'peer-a',
      streamId: 4294967300n,
      groupId: 4294967296n,
      objectId: 1n,
      publisherPriority: 0,
      objectStatus: 0,
    },
    {
      type: 'peer-disconnected',
      seq: 11,
      timestamp: 2700,
      peer: 'peer-a',
      errorCode: 0,
      reason: 'bye',
    },
  ]
}

const V1_HEADER: TraceHeader = {
  protocol: 'moq-transport-14',
  perspective: 'client',
  detail: 'full',
  startTime: START_TIME,
  transport: 'webtransport',
  source: 'moqtap-corpus',
  endpoint: 'https://relay.example:4443',
  sessionId: 'v1-basic',
}

const V2_HEADER: TraceHeader = {
  protocol: 'moq-transport-16',
  perspective: 'relay-tap',
  detail: 'full',
  startTime: START_TIME,
  endTime: START_TIME + 5000,
  transport: 'raw-quic',
  source: 'moqtap-corpus',
  endpoint: '127.0.0.1:4443',
  sessionId: 'v2-basic',
}

/** A version-1 file: only the keys and event types version 1 defined. */
export const v1Basic: Trace = { header: V1_HEADER, events: baseEvents() }

/**
 * A non-segmented version-2 file, exercising every event type and both
 * normative encoding rules.
 *
 * The perspective is `relay-tap`, which is why every version-2 event carries
 * `"p"`: the format requires it there.
 */
export const v2Basic: Trace = {
  header: V2_HEADER,
  events: [...baseEvents(), ...v2OnlyEvents()],
}

/**
 * Three segments of one stream.
 *
 * This is the only thing version 2 exists for: a version-1 reader walking
 * this file decodes the `M` of the second segment's magic as a CBOR byte
 * string and desynchronizes. Sequence numbers and timestamps restart per
 * segment, which is what `"segment"` in the header announces.
 */
export const v2Segmented: Trace[] = [0, 1, 2].map((sequence) => ({
  header: {
    protocol: 'moq-transport-16',
    perspective: 'observer',
    detail: 'headers',
    startTime: START_TIME + sequence * 1000,
    sessionId: 'v2-segmented',
    segment: {
      sequence,
      durationMs: 1000,
      streamId: 'corpus-stream',
      continues: sequence > 0,
    },
  },
  events: [
    {
      type: 'object-header',
      seq: 0,
      timestamp: 100,
      streamId: 4n,
      groupId: BigInt(sequence),
      objectId: 0n,
      publisherPriority: 128,
      objectStatus: 0,
    },
    {
      type: 'annotation',
      seq: 1,
      timestamp: 200,
      label: 'segment',
      data: sequence,
    },
  ],
}))

/**
 * A file carrying an event type no reader knows.
 *
 * New event types may be added without a version bump, so a reader must keep
 * this one — fields intact — rather than drop or relabel it. Dropping makes
 * one tool's ignorance permanent for everything downstream of it.
 */
export const v2UnknownEvent: Trace = {
  header: {
    protocol: 'moq-transport-16',
    perspective: 'observer',
    detail: 'headers',
    startTime: START_TIME,
    sessionId: 'v2-unknown-event',
  },
  events: [
    { type: 'stream-opened', seq: 0, timestamp: 100, streamId: 4n, direction: 1, streamType: 0 },
    {
      type: 'unknown',
      seq: 1,
      timestamp: 200,
      eventType: 99,
      // A text value, an integer and a byte string, so a reader that keeps
      // only one CBOR shape verbatim is caught.
      fields: { note: 'from the future', count: 3, blob: bytes(0xde, 0xad, 0xbe, 0xef) },
    },
    { type: 'stream-closed', seq: 2, timestamp: 300, streamId: 4n, errorCode: 0 },
  ],
}

/**
 * A file whose perspective is not one of the four this revision names.
 *
 * New perspectives may be added without a bump, so this must read, keeping
 * the string verbatim. The protocol identifier is the RFC-phase spelling the
 * spec defines, which no draft-number regex matches.
 */
export const v2UnknownPerspective: Trace = {
  header: {
    protocol: 'moq-transport-rfc9999',
    perspective: 'sidecar',
    detail: 'headers+sizes',
    startTime: START_TIME,
    sessionId: 'v2-unknown-perspective',
  },
  events: [
    { type: 'state-change', seq: 0, timestamp: 100, from: 'init', to: 'connected' },
    { type: 'annotation', seq: 1, timestamp: 200, label: 'perspective', data: 'sidecar' },
  ],
}

/**
 * A file whose *known* event types carry keys no reader knows.
 *
 * The keys are real proposals rather than invented ones — `"ta"` and `"sg"` on
 * a stream open, `"ek"` and `"raw"` on an error — so this case doubles as
 * evidence that today's readers keep them, which is what makes those proposals
 * additive rather than breaking.
 *
 * The failure it guards is quiet: a reader may ignore an unrecognised key, but
 * a reader that *drops* one turns any read-modify-write — a redaction pass, a
 * filter, an annotated download — into a file that looks like it never carried
 * the key at all.
 */
export const v2ExtraKeys: Trace = {
  header: {
    protocol: 'moq-transport-19',
    perspective: 'observer',
    detail: 'full',
    startTime: START_TIME,
    sessionId: 'v2-extra-keys',
  },
  events: [
    {
      type: 'stream-opened',
      seq: 0,
      timestamp: 100,
      streamId: 4n,
      direction: 1,
      streamType: 0,
      extra: { ta: 7, sg: 2 },
    },
    {
      type: 'object-header',
      seq: 1,
      timestamp: 200,
      streamId: 4n,
      groupId: 1n,
      objectId: 0n,
      publisherPriority: 128,
      objectStatus: 0,
      extra: { ta: 7 },
    },
    {
      type: 'error',
      seq: 2,
      timestamp: 300,
      errorCode: 0,
      reason: 'undecodable control bytes',
      extra: { ek: 'decode', raw: bytes(0x99, 0x01) },
    },
  ],
}

/** Every single-segment case both implementations author, by directory name. */
export const AUTHORED_CASES: Readonly<Record<string, Trace>> = {
  'v1-basic': v1Basic,
  'v2-basic': v2Basic,
  'v2-unknown-event': v2UnknownEvent,
  'v2-unknown-perspective': v2UnknownPerspective,
  'v2-extra-keys': v2ExtraKeys,
}

/** Cases whose file is a segmented stream rather than a single trace. */
export const SEGMENTED_CASES: Readonly<Record<string, Trace[]>> = {
  'v2-segmented': v2Segmented,
}
