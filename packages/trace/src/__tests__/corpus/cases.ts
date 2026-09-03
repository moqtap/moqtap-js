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

import { MAX_ERROR_RAW_BYTES } from '../../recorder.js'
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
 * `length` bytes of a fixed, position-dependent pattern.
 *
 * Position-dependent rather than a repeated constant: a run of one byte value
 * cannot catch a copy that loses or duplicates a stretch in the middle, and a
 * period coprime with 256 means no alignment to a power-of-two boundary hides
 * an off-by-one either. `moqtap-trace`'s generator computes the same series.
 */
const pattern = (length: number): Uint8Array =>
  new Uint8Array(Array.from({ length }, (_, i) => (i * 37 + 11) & 0xff))

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
 * Known event types carrying keys no reader knows, and no reader ever will.
 *
 * Every key here begins `x-`, the prefix SPEC.md reserves for private use and
 * promises never to define. A fixture for a rule about unknown keys has to be
 * built from keys that cannot stop being unknown: a key a later revision
 * claims turns this into a test of something else, and a red test whose
 * fixture has gone stale invites weakening the assertion rather than replacing
 * the fixture.
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
      extra: { 'x-ta': 7, 'x-sg': 2 },
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
      extra: {
        'x-ta': 7,
        // A nested value, because "the key survives" has to mean the whole tree
        // survives. A shallow copy passes every flat case above and loses this.
        'x-nested': {
          blob: bytes(0x0f, 0xf0),
          inner: { depth: 3 },
          list: [1, 'two'],
        },
      },
    },
    {
      type: 'error',
      seq: 2,
      timestamp: 300,
      errorCode: 0,
      reason: 'undecodable control bytes',
      extra: { 'x-ek': 'decode', 'x-raw': bytes(0x99, 0x01) },
    },
  ],
}

/**
 * The three shapes a conforming `"msg"` takes.
 *
 * `"msg"` is the one Event 0 key whose contents no version of the spec fixes,
 * so its rules are about shape rather than content: a CBOR map, keyed in
 * snake_case, and an empty map rather than an omission when the recorder
 * decoded nothing. The empty-map event is the load-bearing one: a reader that
 * treats the omission as a malformed event discards an Event 0, which is a
 * type sampling MUST NOT drop.
 *
 * The fourth shape, a `"msg"` that is not a map at all, needs no case of its
 * own: all four `capture-*` recordings carry a Rust `Debug` string there, so
 * the corpus already holds real files exercising the tolerance rule.
 */
export const v2ControlMsgMap: Trace = {
  header: {
    protocol: 'moq-transport-19',
    perspective: 'client',
    detail: 'full',
    startTime: START_TIME,
    sessionId: 'v2-control-msg-map',
  },
  events: [
    {
      // Three value types in one map — integer, integer, byte string — so an
      // encoder that keeps only one CBOR shape verbatim is caught here rather
      // than in whichever field happened to be tested.
      type: 'control',
      seq: 0,
      timestamp: 100,
      direction: 0,
      messageType: 0x03,
      message: { request_id: 1, track_alias: 2, track_name: text('now') },
    },
    {
      // Nothing decoded, so an empty map. A writer that omits the key instead
      // produces a file the Rust reader dropped this event from entirely.
      type: 'control',
      seq: 1,
      timestamp: 200,
      direction: 1,
      messageType: 0x2f00,
      message: {},
    },
    {
      // Nested structure, because "preserve the map" has to mean the whole
      // tree and not just its top level.
      type: 'control',
      seq: 2,
      timestamp: 300,
      direction: 0,
      messageType: 0x16,
      message: { request_id: 3, parameters: { location_filter: [1, 2] } },
    },
  ],
}

/**
 * A `headers`-level trace where the stream-header identifiers are the only way
 * to group anything.
 *
 * This is what the four keys below exist for. At `"headers"` there are no
 * payload bytes to re-parse, so without them a recording could not answer
 * which track a stream belonged to — the level's whole purpose. One per type
 * covers all three scopes: `"sg"` on a subgroup, `"fri"` on a fetch, `"g"` on a
 * datagram, and `"ta"` on each.
 *
 * The three streams deliberately share a track alias. That is legal and
 * ordinary — one track delivered over a subgroup stream, a fetch and a
 * datagram — and it is why `"ta"` alone cannot key a flow: an argument that
 * sits here as a file rather than as prose.
 */
export const v2HeadersLevelFlow: Trace = {
  header: {
    protocol: 'moq-transport-19',
    perspective: 'observer',
    detail: 'headers',
    startTime: START_TIME,
    sessionId: 'v2-headers-level-flow',
  },
  events: [
    {
      type: 'stream-opened',
      seq: 0,
      timestamp: 100,
      streamId: 4n,
      direction: 1,
      streamType: 0,
      trackAlias: 9n,
      subgroupId: 2n,
    },
    {
      type: 'object-header',
      seq: 1,
      timestamp: 150,
      streamId: 4n,
      groupId: 7n,
      objectId: 0n,
      publisherPriority: 128,
      objectStatus: 0,
    },
    {
      // `"fri"` is the only correlation between a fetch stream and the FETCH
      // that asked for it, which is why it is the one key a writer MUST emit.
      type: 'stream-opened',
      seq: 2,
      timestamp: 200,
      streamId: 8n,
      direction: 1,
      streamType: 2,
      trackAlias: 9n,
      fetchRequestId: 42n,
    },
    {
      // A datagram carries its group on the stream-opened event, because there
      // is no subgroup stream to hang it off. Note that `"sid"` here names a
      // stream a datagram never opened, which is why a stream id alone cannot
      // identify a flow.
      type: 'stream-opened',
      seq: 3,
      timestamp: 300,
      streamId: 12n,
      direction: 1,
      streamType: 1,
      trackAlias: 9n,
      groupId: 4294967296n,
    },
  ],
}

/**
 * The three unrecognised-key stores in the header, and the rules that reach
 * into them.
 *
 * Three maps here have keys the format names — the header itself, `"segment"`
 * and `"sampling"` — and each keeps its own store. It is the only file in the
 * corpus carrying an unrecognised *header* key, and without one the whole
 * mechanism could be deleted with every corpus test still green: a round trip
 * checks a reader against its own encoder, and an encoder that writes no store
 * agrees with a decoder that reads none.
 *
 * Five claims, each of which fails differently:
 *
 * - `"x-scope"` sits in all three maps with three different values. A reader
 *   that merged the stores emits the segment's private key at the top level,
 *   and the file then says something it never said.
 * - `"x-tree"` is a map holding an array, a byte string and a null, because
 *   preservation has to be structural. A shallow copy passes every flat
 *   assertion above and loses exactly this.
 * - `"transport": 42` is a key this format *defines*, carrying a value no
 *   reader can use. It reaches the store through the ordinary field path —
 *   {@link TraceHeader.transport} reads as absent — which is how the
 *   wrong-typed-key rule gets exercised by a file both generators can author.
 * - `"x-scale"` is `1.0` and goes out as a CBOR integer. SPEC.md's encoding
 *   rules bind every value a writer emits, stored ones included: `ciborium`
 *   holds a float here and has to convert, while `cbor-x` cannot represent the
 *   distinction at all. It is the one value in the corpus where the two could
 *   silently disagree.
 * - `"x-blob"` is a byte string written as major type 2. The Rust generator
 *   holds it under RFC 8746's tag 64 and unwraps it on the way out; this one
 *   cannot hold a tag, so both files carry the same two bytes.
 *
 * Every genuinely-unknown key is `"x-"` prefixed, the range SPEC.md reserves
 * for private use, so no future revision can claim one and turn this fixture
 * into a test of something else.
 *
 * The header carries `"segment"` because a store needs a map to live in, and
 * `"sampling"` for the same reason. Neither is decoration: this is the first
 * segment of a stream that stopped after one, filtered by a source-side rule,
 * which is what a rotating recorder's first file looks like.
 */
export const v2HeaderExtra: Trace = {
  header: {
    protocol: 'moq-transport-19',
    perspective: 'observer',
    detail: 'full',
    startTime: START_TIME,
    sessionId: 'v2-header-extra',
    // No `transport` field: the header's `"transport"` key is in the store
    // below, carrying an integer, and a field holding it as well would put the
    // key in the map twice.
    segment: {
      sequence: 0,
      streamId: 'corpus-header-extra',
      continues: false,
      extra: {
        'x-scope': 'segment',
        'x-blob': bytes(0xca, 0xfe),
      },
    },
    sampling: {
      // Integral, so it is written as a CBOR integer — the normative rule,
      // on the one header key the format types as a float.
      effectiveRate: 1.0,
      rule: 'example/live',
      ruleLang: 'prefix',
      appliesTo: [3, 4],
      extra: {
        'x-scope': 'sampling',
        'x-scale': 1.0,
      },
    },
    extra: {
      'x-scope': 'header',
      'x-tree': {
        list: [1, 'two'],
        blob: bytes(0x0f, 0xf0),
        gap: null,
      },
      transport: 42,
    },
  },
  // Deliberately storeless: every unrecognised key in this file is in the
  // header, so a store found on an event here is a reader putting one where it
  // does not belong.
  events: [
    { type: 'stream-opened', seq: 0, timestamp: 100, streamId: 4n, direction: 1, streamType: 0 },
    {
      type: 'object-header',
      seq: 1,
      timestamp: 150,
      streamId: 4n,
      groupId: 7n,
      objectId: 0n,
      publisherPriority: 128,
      objectStatus: 0,
    },
  ],
}

/**
 * Event 6 carrying the bytes behind an error, at and below the cap.
 *
 * The corpus case SPEC.md asks for by name: the cap on `"raw"` is a number a
 * reader can test, and "the corpus can hold a case proving the cap was applied
 * rather than merely described". Nothing else here proves it. A cap stated in
 * prose and a cap applied by two encoders are different claims, and only the
 * second one survives someone moving the constant.
 *
 * The first error event is the load-bearing one: `raw` is exactly
 * `MAX_ERROR_RAW_BYTES` while `rawLength` says 9000. That pair is the whole
 * mechanism — a reader learns the capture is partial, and by how much, from
 * two numbers that disagree. It also drags the 16-bit CBOR byte-string length
 * form (`0x59` + two bytes) into the corpus, which no other case reaches: every
 * other byte string here is under 256 bytes and takes the `0x58` form. That is
 * the length prefix two encoders are most likely to disagree about.
 *
 * The second is an error with no bytes at all and no stream, the shape a
 * transport failure takes: every optional key absent, and the event still an
 * error a reader must keep. The third carries a kind
 * outside the vocabulary this revision names and a *complete* capture, its
 * `rawLength` equal to its own length — the signal that says "not truncated",
 * which only means something because the first event can say otherwise.
 *
 * `full`, necessarily: `"raw"` reaches no lower level.
 */
export const v2ErrorWithRaw: Trace = {
  header: {
    protocol: 'moq-transport-19',
    perspective: 'observer',
    detail: 'full',
    startTime: START_TIME,
    sessionId: 'v2-error-with-raw',
  },
  events: [
    { type: 'stream-opened', seq: 0, timestamp: 100, streamId: 4n, direction: 1, streamType: 0 },
    {
      type: 'error',
      seq: 1,
      timestamp: 200,
      errorCode: 0,
      reason: 'object decode failed mid-stream',
      streamId: 4n,
      errorKind: 'decode',
      rawLength: 9000,
      raw: pattern(MAX_ERROR_RAW_BYTES),
    },
    {
      type: 'error',
      seq: 2,
      timestamp: 300,
      errorCode: 2,
      reason: 'uni stream pipe: connection lost',
      errorKind: 'transport',
    },
    {
      type: 'error',
      seq: 3,
      timestamp: 400,
      errorCode: 0,
      reason: 'control message rejected by the fuzz harness',
      streamId: 0n,
      errorKind: 'x-fuzzer',
      rawLength: 12,
      raw: pattern(12),
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
  'v2-control-msg-map': v2ControlMsgMap,
  'v2-headers-level-flow': v2HeadersLevelFlow,
  'v2-header-extra': v2HeaderExtra,
  'v2-error-with-raw': v2ErrorWithRaw,
}

/** Cases whose file is a segmented stream rather than a single trace. */
export const SEGMENTED_CASES: Readonly<Record<string, Trace[]>> = {
  'v2-segmented': v2Segmented,
}
