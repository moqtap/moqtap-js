/**
 * @moqtap/collector — the shared contract.
 *
 * The single file every other module imports and nothing imports back. Type-only
 * apart from four frozen constants and two pure helpers, so it can never create
 * a cycle and costs the bundle only those six values.
 *
 * Three things the envelope format leaves open are settled here, because seven
 * modules settling them separately would be seven wire formats:
 *
 *  1. **Frame type discrimination.** The envelope is a bare `[u32 len][payload]`
 *     with JSON and raw frames interleaved and nothing to tell them apart. Bit
 *     31 of the length prefix is the tag: set = raw bytes, clear = JSON. Frame
 *     lengths are `< 2^31` by construction — a batch seals at ~32 KB and a
 *     beacon caps near 64 KB. See {@link FRAME_RAW_FLAG}.
 *  2. **Body self-description.** `sendBeacon` cannot set request headers, so it
 *     can send neither `Content-Encoding: gzip` nor an `Idempotency-Key`. An
 *     8-byte preamble carries the version and a gzip flag, and the first frame
 *     of every body is always a {@link BatchRecord} carrying the key. The
 *     `fetch()` path sets the header too, so ingest need not parse to dedupe.
 *  3. **Trigger config shape.** One object keyed by trigger kind, where absent
 *     means off — which also makes automated mode ship off by default, so a
 *     fresh install cannot generate spend nobody asked for. See
 *     {@link TriggerConfig}.
 *
 * The track-state decision lives here too: the rollup key is the raw number on
 * the wire, tagged with direction and an alias epoch. See {@link BucketKey}.
 * **No track name, namespace, status, reason phrase or lifecycle timestamp
 * appears anywhere in this file, and none may be added** — ingest joins them
 * from the control bytes the baseline already ships.
 *
 * Two constraints on how this package may reach `@moqtap/codec`:
 *
 *  - `trackAliasOf`/`requestIdOf` are reachable only through the root entry,
 *    which statically imports every draft. They must be copied, never
 *    imported; only the per-draft entries `@moqtap/codec/draft07` through
 *    `@moqtap/codec/draft21` may be imported -- never the root or
 *    `@moqtap/codec/session` -- and only through static literal specifiers.
 *  - `MoqtBufferReader` is exported from no public subpath, so
 *    {@link VarintReader} is the collector's own.
 *
 * {@link DraftAdapter} declares hand-rolled header walks rather than wiring the
 * codec's streaming decoders to it, and that is not about decoder quality: no
 * exported codec function reports a header's byte length without materialising
 * the payload, and the hand-rolled walk costs 170-240 ns per object against
 * 11.5-14.4 us. **Do not wire the streaming decoders to it.**
 */

/* ── clocks ───────────────────────────────────────────── */

/**
 * `performance.now()` milliseconds, relative to the session origin
 * ({@link ClockAnchor.originMono}).
 *
 * Stamped at the seam, synchronously, on the page's own data path — not one
 * message-hop later, which is what the extension does and what makes its
 * inter-arrival histograms measure the extension's queue as much as the
 * network.
 */
export type Mono = number

/** `Date.now()` milliseconds. Sent alongside {@link Mono}, never instead of it. */
export type Wall = number

export interface ClockSource {
  /** Monotonic. Never jumps, never corrected. */
  now(): Mono
  /** Wall clock. Sent alongside, reconciled at the edge, never silently corrected. */
  wall(): Wall
}

/**
 * Both clocks at session start. Every later {@link Mono} in the envelope is
 * relative to `originMono`, which is what lets ingest place a session on a
 * fleet timeline without trusting the device's wall clock.
 *
 * A divergence between the two that opens mid-session means the device slept;
 * that is reported as {@link RollupRecord.suspended}, an explanation rather
 * than an error.
 */
export interface ClockAnchor {
  readonly originMono: Mono
  readonly originWall: Wall
}

/* ── identity ───────────────────────────────────── */

/**
 * The four identity axes. `actorId` is still carried as a placeholder in the
 * metric definitions rather than resolved here.
 */
export interface Identity {
  /**
   * Whoever is at this end — a viewer, a broadcaster, or a service. **NOT
   * hashed**: accepted raw, treated as personal data, retention short.
   */
  readonly actorId?: string
  /** One logical session. May span several transports. */
  readonly sessionId: string
  /** One transport within the session. A reconnect makes a new one. */
  readonly connectionId: string
  readonly contentId?: string
}

/* ── transport seam ─────────────────────────────── */

/**
 * Which way the bytes were moving at the seam.
 *
 * Free at the interception point, and load-bearing twice: it separates the two
 * track-alias spaces of a bidirectional session (the alias is chosen by the
 * publisher from draft-12 and by the subscriber before it, so the two ends'
 * spaces are distinct but overlapping), and it is half of {@link BucketKey}.
 */
export type Direction = 'tx' | 'rx'

/** Who opened the stream. `local` = this endpoint, `remote` = the peer. */
export type StreamOrigin = 'local' | 'remote'

/**
 * What the collector keeps of the `WebTransport` constructor's options.
 *
 * Deliberately lossy. The certificate hashes are counted, never carried: they
 * are the one field in the options bag with any chance of being sensitive.
 */
export interface WebTransportOptionsInfo {
  readonly protocols?: string[]
  readonly congestionControl?: string
  readonly allowPooling?: boolean
  readonly requireUnreliable?: boolean
  /** Count only — never the hashes themselves. */
  readonly serverCertificateHashes?: number
}

export interface InterceptedSession {
  readonly id: string
  readonly url: string
  readonly anchor: ClockAnchor
  readonly options?: WebTransportOptionsInfo
}

export interface StreamChunk {
  readonly sessionId: string
  /**
   * Synthetic, per-session, assigned by the collector's own registry. **NOT the
   * QUIC stream id** — the WebTransport API never exposes it. Meaningful only
   * within one session's records, which is enough for the
   * `streamId -> pending request` map.
   */
  readonly streamId: number
  readonly direction: Direction
  readonly bidi: boolean
  /**
   * `bidi === true || the stream's FIRST chunk opened af 00`. Sticky per
   * `streamId` — only the first chunk may classify.
   *
   * From draft-17 the control plane is a *pair of unidirectional streams*, so
   * `bidi` alone misfiles the entire control plane as bulk on every draft this
   * package supports. `af 00` is SETUP's type `0x2F00` in MoQT's own varint;
   * `6f 00` is what RFC 9000 would produce, and reading it the wrong way round
   * yields a plausible number rather than an error — which is why getting it
   * wrong is silent.
   */
  readonly control: boolean
  /**
   * **Borrowed view onto the page's own buffer.** Valid only for the duration
   * of this call. Any consumer that retains it must copy: the page may write
   * through the same `ArrayBuffer` on its next frame, and a retained view
   * silently rewrites already-counted history.
   */
  readonly data: Uint8Array
  readonly at: Mono
  /** Only when `HookOptions.captureStacks` is on, which defaults to false. */
  readonly stack?: string
}

export interface DatagramChunk {
  readonly sessionId: string
  readonly direction: Direction
  /** Borrowed view — see {@link StreamChunk.data}. */
  readonly data: Uint8Array
  readonly at: Mono
}

/**
 * Send-side backpressure, sampled at `writer.ready`.
 *
 * The only pressure signal a publish-only session has: the release pacer's
 * input is object arrival rate, and a publisher has none arriving. That
 * fallback is this package's decision rather than the spec's, and is
 * unvalidated.
 */
export interface WriterPressure {
  readonly sessionId: string
  readonly streamId: number
  readonly readyLatencyMs: number
  readonly desiredSize: number | null
  readonly at: Mono
}

/**
 * The seam's callback surface.
 *
 * IMPLEMENTATION CONTRACT: every method runs **synchronously on the page's own
 * data path** — `onStreamData` fires *before* the page's write reaches the
 * transport. An implementation must be a bounded enqueue and nothing else.
 * Parsing, hashing, compression or allocation here is latency the customer's
 * player pays, and the non-interference guarantee is unmeetable by
 * construction if any of it happens on this thread of control.
 *
 * Every method must also be total: a throw here lands in the page's own stack.
 * The hook wraps each call and routes failures to `HookOptions.onInternalError`.
 */
export interface TransportObserver {
  onSessionOpen(s: InterceptedSession): void
  /** The negotiated `session.protocol`, available only after `ready`. */
  onSessionProtocol?(sessionId: string, protocol: string): void
  onSessionClose(sessionId: string, reason: string, at: Mono): void
  onStreamOpen?(sessionId: string, streamId: number, bidi: boolean, o: StreamOrigin): void
  onStreamData(c: StreamChunk): void
  onStreamClose(sessionId: string, streamId: number, at: Mono): void
  onStreamError(sessionId: string, streamId: number, error: unknown): void
  onDatagram?(c: DatagramChunk): void
  onWriterPressure?(p: WriterPressure): void
  onSendStats?(sessionId: string, streamId: number, bytesAcknowledged: number, at: Mono): void
}

export interface HookOptions {
  /**
   * `new Error().stack` per bidi write. Default **false**: from draft-17 a bidi
   * stream is per-request, so stacks would be captured on the control plane's
   * hot path for no diagnostic gain.
   */
  readonly captureStacks?: boolean
  /**
   * Default `() => crypto.randomUUID()`. Feeds `sha256(sessionId:segmentSeq)`,
   * so a collision is a silently discarded and under-billed session at ingest,
   * which dedupes exactly. The extension's `Date.now() + counter` form is not
   * good enough for this and is deliberately not carried over.
   */
  readonly sessionId?: () => string
  readonly clock?: ClockSource
  /** Every internal throw lands here. Never into the page. */
  readonly onInternalError?: (err: unknown) => void
}

/* ── drafts ─────────────────────────────────────────────── */

/**
 * The drafts this package parses: all fifteen `@moqtap/codec` speaks.
 *
 * Fifteen entries, **one chunk each**. Each is behind a static literal
 * `import()` specifier in `DRAFT_LOADERS`, and a session downloads the one its
 * peer negotiated and no others — the root `@moqtap/codec` entry, which
 * statically imports every draft at 39.6 KB gz against 5.3 KB for one, must
 * never be reachable from any collector module.
 *
 * The range starts at 07 because that is where `@moqtap/codec` starts. Drafts 04
 * through 06 have implementations in the field and no decoder in this workspace,
 * so they degrade to transport-only metrics like any other unrecognised
 * protocol.
 */
export type SupportedDraft = 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18 | 19 | 20 | 21

/**
 * Any decoded control message, from any draft.
 *
 * Declared exactly as `@moqtap/codec`'s `core/accessors.ts` declares it, so the
 * field-spelling accessors port across unchanged. The codec's control messages
 * spell their fields in **snake_case** (`request_id`, `track_alias`) while its
 * data-stream types use camelCase (`requestId`, `trackAlias`), so a reader that
 * assumes one spelling reads `undefined` from half the wire — which is why the
 * copied accessors must try both.
 *
 * **Widen decoded messages with {@link asAnyMessage}, never by assignment.**
 */
export type AnyMessage = Readonly<Record<string, unknown>>

/**
 * Widen a decoded codec message to {@link AnyMessage}.
 *
 * Necessary, not cosmetic. The codec's message types are `interface`s, and
 * TypeScript grants an implicit index signature only to *type aliases*, so
 * `Draft20Message` is **not** assignable to `Record<string, unknown>`:
 *
 * ```
 * error TS2322: Type 'Draft20Message' is not assignable to type
 *   'Readonly<Record<string, unknown>>'.
 *   Index signature for type 'string' is missing in type 'Draft20Setup'.
 * ```
 *
 * One helper here beats an `as unknown as` at every decode site in three
 * modules.
 */
export function asAnyMessage(msg: object): AnyMessage {
  return msg as AnyMessage
}

/**
 * The "more bytes needed" sentinel for every incremental reader.
 *
 * A unique symbol, so `x === NEED` is exact and no decoded value can ever
 * impersonate it. **Import it; never re-declare it.** A second
 * `Symbol('need')` in another module is a different value AND a different
 * type, so every `=== NEED` check across that boundary silently returns false
 * and every buffered prefix is treated as a decoded value.
 */
export const NEED: unique symbol = Symbol('need')
export type Need = typeof NEED

export interface VarintReader {
  /**
   * Returns {@link NEED} when the buffer holds a legal *prefix* of an encoding
   * and cannot yet complete it. Must never throw and must never return a
   * partial value: The whole point is that the two varint families disagree
   * on the same bytes and return plausible wrong numbers rather than failing.
   */
  read(b: Uint8Array, i: number): { value: bigint; next: number } | Need
}

export interface DecodedControl {
  /**
   * `null` when the frame did not decode — an unknown or extension codepoint,
   * or a malformed payload. Counted and skipped, never fatal: the codec's
   * `createStreamDecoder` calls `controller.error()` on `UNKNOWN_MESSAGE_TYPE`
   * and kills the control plane for the whole session, which is precisely the
   * behaviour this shape exists to avoid.
   */
  readonly value: AnyMessage | null
  /**
   * Bytes the frame occupied. On a decode failure the codec reports nothing, so
   * this is the length the manual framer already measured — control frames are
   * `varint type` + `uint16 BE length` + payload in every supported draft, which
   * is why the framer can always skip a frame it cannot decode.
   */
  readonly bytesRead: number
}

/** What a data stream's first byte suggests it is. See {@link DraftAdapter.sniff}. */
export type StreamKind = 'control' | 'subgroup' | 'fetch' | 'unknown'

/**
 * What a draft's auth mask did to one control frame.
 *
 * Structurally the codec's `AuthRedaction`, restated here rather than imported
 * so that `types.ts` — which the always-loaded entry pulls — names no draft of
 * `@moqtap/codec`. The adapters live in the lazy per-draft chunks and are the
 * only modules in this package that import the codec at all.
 */
export interface ControlRedaction {
  /** The frame, every Token Value overwritten, exactly as long as the input. */
  readonly bytes: Uint8Array
  /** How many Token Values were overwritten. */
  readonly redacted: number
  /**
   * A span could not be applied: our offsets and the frame disagree.
   *
   * A defect rather than a wire condition, and the frame's raw bytes must not
   * be shipped — the one thing that is certain is that a token was seen and
   * its position is not trusted.
   */
  readonly incomplete: boolean
  /**
   * Whether the message parsed all the way through.
   *
   * An unknown or extension codepoint is something a peer is allowed to send,
   * and those are shipped raw on purpose rather than losing the control
   * plane over one of them — but a message that cannot be parsed is a message
   * whose parameters cannot be walked, so `redacted === 0` there means nothing
   * was found, not that there is nothing there. Counted, so the gap is a
   * number rather than a sentence nobody wrote down.
   */
  readonly decoded: boolean
}

/**
 * The only surface the decoder sees of a loaded draft module.
 *
 * Everything a *counting* decoder needs and nothing that would drag an encoder
 * in: every reader returns byte counts and ids, and none returns, views or
 * retains a payload. "Parse an object header, update counters, discard",
 * expressed as a type rather than as a discipline.
 *
 * Every method must be total. A malformed stream is counted as a parse failure
 * ({@link ParseFailureReason}) and abandoned; nothing here throws into the page.
 */
export interface DraftAdapter {
  readonly draft: SupportedDraft
  /**
   * The ALPN / `WT-Available-Protocols` string this draft negotiates with.
   *
   * From draft-15 that is `moqt-NN` and it is the only draft identifier a
   * session carries: the version appears nowhere on the wire. **Before
   * draft-15 it is `moq-00` for all eight of them**, so it identifies the
   * family and not the draft, and the draft comes from the selected version in
   * SERVER_SETUP instead (`src/draft/setup-probe.ts`). Eight adapters therefore
   * carry the same string here, and {@link draft} is what tells them apart.
   *
   * Every adapter takes this from `PROTOCOL_STRINGS`. Only
   * `@moqtap/codec/draft20` exports a `PROTOCOL_STRING` of its own, so sourcing
   * it from the codec would be a rule with one instance.
   */
  readonly protocolString: string
  readonly varint: VarintReader
  /** Decode ONE complete, already-framed control message. Never throws. */
  decodeControl(frame: Uint8Array): DecodedControl
  /**
   * Overwrite every Authorization Token value in ONE complete control frame,
   * before anything else sees it. Never throws.
   *
   * **Required, deliberately.** An optional member would let a new draft's
   * adapter ship without a mask and be silently unmasked; required means the
   * compiler asks the question when the draft is added, which is the only
   * moment anyone is thinking about it.
   */
  redactAuthTokens(frame: Uint8Array): ControlRedaction
  /**
   * Whole datagram in hand. Returns `null` on a parse failure — count, do not
   * throw. The codec's `decodeDatagram` returns a `DecodeResult` whose payload
   * is a **view** onto the caller's buffer; the adapter must reduce it to
   * counts and let the view go.
   */
  decodeDatagram(bytes: Uint8Array): DatagramCounts | null
  /**
   * First-byte stream sniff. **Heuristic, not authoritative.** MoQT permits
   * non-minimal varint encodings, so a subgroup header type of `0x10` may
   * legally arrive as the two-byte `0x8010`, whose first byte sniffs as
   * nothing. `'unknown'` is an ordinary outcome, not an error.
   */
  sniff(firstByte: number): StreamKind
  /**
   * End offset of the control frame starting at `i`, or {@link NEED} when the
   * buffer does not hold all of it yet.
   *
   * Per draft because the length field differs: a varint in drafts 07-10, a
   * 16-bit big-endian field from draft-11. A framer that assumes the second
   * silently mis-frames every control message on the four oldest drafts, so the
   * question belongs to the adapter, where a new draft has to answer it.
   */
  controlFrameEnd(b: Uint8Array, i: number): number | Need
  /** Per-draft subgroup header walk. Returns byte counts only; payload is skipped. */
  readSubgroupHeader(b: Uint8Array, i: number): SubgroupHeaderInfo | Need
  readSubgroupObject(
    b: Uint8Array,
    i: number,
    st: SubgroupHeaderInfo,
    prev: ObjectCursor,
  ): ObjectHeaderInfo | Need
  readFetchHeader(b: Uint8Array, i: number): FetchHeaderInfo | Need
  readFetchObject(b: Uint8Array, i: number, prev: ObjectCursor): ObjectHeaderInfo | Need
}

export interface SubgroupHeaderInfo {
  readonly trackAlias: bigint
  readonly groupId: bigint
  /**
   * Bit 0 of the header Type Flags. Every object on the stream then carries a
   * Properties Length the walk must skip; without it the per-object walk
   * desynchronises on the first object.
   */
  readonly propertiesPresent: boolean
  readonly headerBytes: number
  readonly next: number
}

export interface FetchHeaderInfo {
  /**
   * The Request ID of the message that opened the stream — **not necessarily a
   * FETCH**. In draft-20 a fill fetch stream carries the Request ID of the
   * SUBSCRIBE or REQUEST_UPDATE that requested the fill. That is why
   * `kind: 'fetch'` buckets are natively stable and need no epoch: the id is
   * the only thing on the stream, and ingest chains it back through the
   * control records, which carry the stream id.
   */
  readonly requestId: bigint
  readonly headerBytes: number
  readonly next: number
}

/**
 * Mutable walk state carried between objects on one data stream.
 *
 * Required, not an optimisation: both stream types delta-encode. A subgroup
 * object's id is `prevObjectId + 1 + delta` after the first, and a fetch
 * object's group and object ids resolve against the previous object's. Subgroup
 * id and publisher priority are
 * deliberately absent — they are read positionally when their flag bits are set
 * and never needed to *resolve* an id, so the counting decoder does not track
 * them.
 */
export interface ObjectCursor {
  first: boolean
  prevObjectId: bigint
  prevGroupId: bigint
}

export interface ObjectHeaderInfo {
  readonly objectId: bigint
  readonly groupId: bigint
  readonly payloadLength: number
  /**
   * Present only when `payloadLength === 0`, where a varint Object Status
   * occupies the position a payload would have. **This branch is the one
   * `createSubgroupStreamDecoder` omits**, and omitting it desynchronises every
   * byte after the first status object.
   */
  readonly status?: bigint
  readonly headerBytes: number
  /** Offset of the next object's first byte: payload skipped, never viewed. */
  readonly next: number
}

export interface DatagramCounts {
  readonly trackAlias: bigint
  readonly groupId: bigint
  readonly objectId: bigint
  readonly headerBytes: number
  readonly payloadBytes: number
  readonly status?: bigint
}

/* ── the bucket key: the track-state decision ─────────────────────── */

/**
 * `alias` — a subgroup stream or a datagram, keyed by Track Alias.
 * `fetch` — a fetch stream, keyed by the Request ID that opened it, because
 * `FetchStreamHeader` carries nothing else.
 */
export type BucketKind = 'alias' | 'fetch'

/**
 * The rollup bucket key, and the whole of the client's track state.
 *
 * `id` is the raw wire number the data-stream header already carries —
 * `trackAlias` for subgroup and datagram streams, `requestId` for fetch
 * streams. `dir` comes free from the seam and separates the two alias spaces of
 * a bidirectional session. `epoch` is bumped when the control plane rebinds a
 * *live* alias to a different request.
 *
 * The epoch exists because alias uniqueness is genuinely weak: draft-20 forbids
 * only *simultaneous* reuse ("The same Track Alias MUST NOT be used by a
 * publisher to refer to two different Tracks simultaneously in the same
 * session") and permits sequential rebinding once the prior subscription has
 * closed. Two tracks summed into one interval row under one raw alias are
 * unrecoverable at ingest, and the same mixing poisons the per-track median
 * that opens the billable capture windows — so the failure reaches the
 * invoice. Fifteen lines of epoch counter close it.
 *
 * The separate {@link RollupTrackWire.shared} flag covers the other case track
 * state has to answer: two concurrent subscriptions to the same track MAY share
 * one alias, and the publisher then sends each object once per subscription.
 * Disambiguating *that* needs each subscription's filter evaluated against
 * every object header on the device, which nothing proposed for this package
 * does. The flag tells ingest the resulting duplicates are structural rather
 * than a fault, at three lines instead of per-object filter evaluation.
 *
 * **NO NAME, NAMESPACE, STATUS, REASON PHRASE OR LIFECYCLE TIMESTAMP EVER
 * LEAVES THE DEVICE.** Ingest joins them from the control bytes the baseline
 * already ships, where a control-plane reparse is required to exist anyway.
 */
export interface BucketKey {
  readonly dir: Direction
  readonly kind: BucketKind
  readonly id: bigint
  readonly epoch: number
}

/** Stable string form: `${dir}:${kind}:${id}:${epoch}`. */
export type BucketKeyString = string

/**
 * The canonical string form of a {@link BucketKey}.
 *
 * The one place the key is stringified. Map keys, columnar `cols.key` entries
 * and `hdr` record keys must all agree byte for byte or ingest re-splits one
 * track into several, so nothing may build this string by hand.
 */
export function bucketKeyString(k: BucketKey): BucketKeyString {
  return `${k.dir}:${k.kind}:${k.id}:${k.epoch}`
}

/**
 * Abstract exchange kinds. Latencies key on these, never on wire message
 * names: draft-15 unifies `request_ok`/`request_error` where earlier drafts have
 * per-request-type responses, so a metric keyed on message names fragments
 * across fifteen drafts and cannot be compared.
 */
export type ExchangeKind =
  | 'subscribe'
  | 'fetch'
  | 'announce'
  | 'track-status'
  | 'publish'
  | 'setup'
  | 'other'

/**
 * One outstanding request, keyed by the bidirectional stream it was sent on.
 *
 * From draft-17 each request gets its own bidi stream and **responses
 * carry no request id** — draft-20's SUBSCRIBE_OK has `track_alias` and
 * parameters and no id at all. The
 * stream is the only thing tying a response to its request, so without this map
 * *no* latency is computable on drafts 17-21.
 */
export interface PendingRequest {
  readonly requestId: bigint
  readonly kind: ExchangeKind
  readonly sentMono: Mono
  readonly dir: Direction
}

/**
 * What the decoder asks for a bucket key, and the only control-plane state the
 * client keeps. Implemented by `TrackKeys` in the decode module.
 *
 * `applyControl` must read **only** the fields {@link BucketKey} needs — track
 * alias, request id, message kind. Reading a name or a namespace out of a
 * decoded message here would put it one field access from the wire and defeat
 * the whole point of keying on the raw alias.
 */
export interface TrackKeyResolver {
  /** `null` when the bucket cap has been reached — counted, never silently merged. */
  aliasKey(dir: Direction, alias: bigint): BucketKey | null
  fetchKey(dir: Direction, requestId: bigint): BucketKey | null
  applyControl(msg: AnyMessage, dir: Direction, streamId: number, at: Mono): void
  pendingFor(streamId: number): PendingRequest | undefined
  /** Feeds {@link TerminalRecord}'s counters. */
  readonly bucketsRefused: number
}

/* ── decoder → rollup ───────────────────────────────────────── */

/**
 * One counted object. **Never retained** — the rollup folds it into counters
 * and histograms and drops it. "the expensive thing is not observing
 * objects, it is recording one event per object."
 */
export interface ObjectSample {
  readonly key: BucketKey
  readonly groupId: bigint
  readonly objectId: bigint
  readonly headerBytes: number
  readonly payloadBytes: number
  /** Present on a status object (`payloadLength === 0`), absent otherwise. */
  readonly status?: bigint
  readonly at: Mono
}

export interface ControlFrameEvent {
  readonly dir: Direction
  readonly streamId: number
  readonly at: Mono
  /**
   * The exact frame, type byte through payload end. **Borrowed** — the sink
   * copies if it retains. Shipped raw at baseline whether or not it decoded,
   * so an unknown or extension codepoint is counted and skipped rather than
   * killing the control plane.
   */
  readonly bytes: Uint8Array
  /** `null` when the frame did not decode: unknown codepoint, or malformed payload. */
  readonly message: AnyMessage | null
}

export type ParseFailureReason =
  | 'unknown-message-type'
  | 'malformed-control'
  // The auth mask reported a span it could not apply, so the
  // frame's raw bytes were dropped rather than shipped. Its own bucket
  // because it is a defect in our offset arithmetic, not a malformed peer.
  | 'redaction-failed'
  | 'malformed-datagram'
  | 'subgroup-desync'
  | 'fetch-desync'
  | 'unknown-stream-type'
  | 'bucket-cap'

/**
 * What the counting decoder writes into. Implemented by `RollupEngine`.
 *
 * The decoder and the rollup meet here and nowhere else — the two modules share
 * this interface and no file.
 */
export interface CountingSink {
  onObject(s: ObjectSample): void
  onControlFrame(e: ControlFrameEvent): void
  /** `key` is `null` when the failure happened before a bucket could be resolved. */
  onParseFailure(key: BucketKey | null, reason: ParseFailureReason): void
}

/* ── histograms ──────────────────────────────────────────────────────────── */

/**
 * The histograms this package emits.
 *
 * The encoding is fixed: log-spaced boundaries **identical for every emitter**,
 * so merging is elementwise addition and a fleet-wide p95 is exact to one
 * bucket width. Durations 17 buckets 1 ms → 65 s; sizes 20 buckets 1 B →
 * 512 KB; u16 counts, sparse-encoded.
 *
 * **No percentile is ever computed on the device**, because a device-side p95
 * cannot be merged with another device's afterwards.
 *
 * `groupOpenMs` is the only *data-plane* timing a consumer cannot reconstruct:
 * it is built from per-object arrival times, which reach ingest only inside
 * `hdr`, and `hdr` is elevated-only and droppable, so a baseline session ships
 * no evidence for it. Widening this union means widening `BOUNDARIES` with it.
 *
 * A per-subgroup count is absent because nothing carries the identity it needs
 * — `SubgroupHeaderInfo` has no subgroup id, the same gap that stops
 * `outOfOrder` being counted within a group.
 */
export type HistogramKind =
  | 'interArrivalMs'
  | 'deliveryMs'
  | 'objectSizeBytes'
  | 'groupCadenceMs'
  | 'groupOpenMs'
  | 'stallMs'
  | 'controlLatencyMs'
  | 'writerReadyMs'

/**
 * Sparse: parallel arrays of bucket index and count. Merged by elementwise add.
 *
 * `n` and `sum` are not optional and not decoration: every mean has to ship
 * its denominator, because a per-session mean averaged across
 * sessions without weighting makes short broken sessions dominate the fleet
 * number — exactly the sessions whose numbers mean least.
 */
export interface HistogramWire {
  readonly i: readonly number[]
  readonly c: readonly number[]
  /** Denominator ships with every mean. */
  readonly n: number
  readonly sum: number
}

/**
 * A customer-defined metric, recorded through `observe()`.
 *
 * `agg` is declared, never inferred. A pre-computed percentile is
 * refused by construction: there is no `percentile` aggregation, because one
 * device's p95 cannot be merged with another's.
 */
export interface MetricDefinition {
  readonly unit: string
  readonly agg: 'sum' | 'gauge' | 'histogram'
  readonly buckets?: readonly number[]
}

/* ── configuration ──────────────────────────────── */

/**
 * The detail dial. An **ordered lattice**, and the order is load-bearing:
 * The ceiling and {@link TRIGGER_CAPTURE_LEVEL} are both positions on this
 * list rather than flags, so "a trigger may raise detail but never past
 * `headers`" is a comparison instead of a special case.
 *
 * `baseline` is always on and always the same — control-plane bytes plus the
 * rollup, measured at 1.8 KB gzipped per ten-minute session. Everything above
 * it counts toward billable usage.
 */
export const DETAIL_LEVELS = ['baseline', 'headers', 'headers+sizes', 'headers+data'] as const
export type DetailLevel = (typeof DETAIL_LEVELS)[number]

export type TriggerKind = 'stall' | 'trackSwitch' | 'cadence'

/**
 * Flight-recorder triggers. **Absent means OFF, and all three default to
 * absent**, so automated mode ships off and a fresh install can never generate
 * spend the customer did not ask for.
 *
 * This object shape is the resolution of the contradiction: the section
 * shows `triggers: ['stall', 'trackSwitch', 'cadence']` in one fragment and
 * `{ multiple: 3 }` in another, and no single shape admits both.
 *
 * `cadence.multiple` is a multiple of *the track's own observed median*
 * interval, not an absolute millisecond figure: `{ multiple: 3 }` fires at
 * 6,000 ms on a 2 s GOP and 750 ms on a 250 ms one, from one key, without the
 * customer knowing their own GOP length. `minSamples` is the warm-up — until
 * the median is established the trigger must not fire at all.
 */
export interface TriggerConfig {
  readonly stall?: { readonly afterMs: number }
  readonly trackSwitch?: Record<string, never>
  readonly cadence?: { readonly multiple: number; readonly minSamples: number }
}

export interface FlightRecorderConfig {
  /**
   * Memory budget on the customer's device — `'32MB'` or a byte count.
   * **Bounded in bytes, never in seconds**: how many seconds a depth
   * buys depends on object rate and bitrate, and advertising a duration would
   * be advertising a number this package does not control.
   *
   * The ring carries payloads, so this is a memory budget and nothing else: it
   * is never persisted and never uploaded as-is.
   */
  readonly depth: string | number
  readonly triggers: TriggerConfig
  /**
   * The **post-event timeout**: how long a triggered capture window stays
   * elevated with nobody closing it.
   *
   * It is a backstop, not the primary mechanism. A window closes on the
   * application calling `resolve()`, on the ring filling, on the page
   * unloading, or on this timeout — and there is deliberately no fifth
   * condition, because "the fault recovered" is a player-level judgement this
   * package does not have. It sees objects arriving, not a rebuffer ending, so
   * a collector that inferred recovery would close early on a stall still
   * happening and hold open through one that had ended.
   *
   * Short on purpose: it bounds the cost of a developer who arms a trigger and
   * never resolves it, and the pre-trigger ring already holds the part of the
   * story a longer window could not recover anyway.
   */
  readonly windowMs: number
}

/**
 * What the session is *about* — descriptive, optional, and shipped once in the
 * setup record rather than on every record.
 *
 * Grouped because they behave identically and are decided together: none of
 * them changes what the collector does, and all of them change how a session is
 * found later.
 */
export interface SessionContext {
  /**
   * Accepted raw, never hashed, **treated as personal data**. The field
   * with real privacy weight, and the one no default can be right for.
   */
  readonly actorId?: string
  readonly contentId?: string
  readonly environment?: string
  readonly release?: string
}

/** The rollup: how often it closes, and how many tracks it will follow. */
export interface MetricsConfig {
  readonly intervalMs: number
  /**
   * Distinct tracks followed before the overrun policy fires. **Detect,
   * never silently truncate**: reaching this counts and alarms
   * rather than quietly dropping the next track.
   */
  readonly maxTracks: number
}

/** Spend, and only spend. */
export interface BudgetConfig {
  /**
   * The spend ceiling, denominated in elevated minutes because that is the
   * metering axis. Reaching it drops to baseline and refuses further
   * elevation for the session.
   */
  readonly elevatedMinutes: number
}

/** Everything about getting bytes off the device. */
export interface UploadConfig {
  readonly intervalMs: number
  readonly byteThreshold: number
  /** The front-loaded schedule: `ready`, then +5 s, +15 s, +45 s. */
  readonly earlyFlushesMs: readonly number[]
  readonly maxAttempts: number
  /**
   * How long one upload request may go unanswered before it is abandoned and
   * treated as a transient failure.
   *
   * A blackholed or tarpitted endpoint accepts the socket and answers nobody,
   * and `fetch` has no timeout of its own, so without this a single request is
   * pending for the life of the page. It bounds one *request*, not the drain:
   * `stopDrainDeadlineMs` is what bounds `stop()`.
   */
  readonly timeoutMs: number
  /**
   * How long `stop()` may spend draining the outbox before it gives up and
   * resolves anyway.
   *
   * `timeoutMs` alone is not enough — `maxAttempts` requests plus backoff is far
   * past any deadline a page tearing down can wait for — so the drain carries
   * its own overall deadline. Expiry is not data loss: the chunk stays queued
   * and persisted, which is exactly what the store is for.
   */
  readonly stopDrainDeadlineMs: number
  /** The cap on a `sendBeacon` payload. */
  readonly beaconMaxBytes: number
}

/** The IndexedDB backlog, sized by what is waiting to upload. */
export interface StorageConfig {
  readonly quotaBytes: number
}

/**
 * The `init()` argument, and the only place configuration lives — not a
 * global, not a `data-` attribute, not build-time substitution. It is the only
 * form that gives a TypeScript user completion, supports per-session values not
 * known at build time, and puts the whole configuration at one call site where
 * a reviewer can see it.
 */
export interface CollectorConfig {
  readonly apiKey: string
  /**
   * Where uploads go. Absent means the hosted ingest
   * ({@link DEFAULT_ENDPOINT}); set it to send to your own collector or a
   * first-party proxy. Whichever origin is in force is the one `connect-src`
   * entry the page needs.
   *
   * Supplied-but-empty is fatal rather than defaulted: that is a typo in an
   * override, and defaulting past it would send traffic somewhere unchosen.
   */
  readonly endpoint?: string
  readonly sessionId?: string
  readonly detail?: DetailLevel
  /**
   * Static pin for builds that cannot dynamic-import. It **selects among
   * literal specifiers the bundler can already see** — it does not substitute
   * anything, which is how it coexists with the "not build-time
   * substitution".
   *
   * On disagreement between the pin and the negotiated protocol the
   * adapter is withheld entirely. Two incompatible varint families disagree on
   * the same bytes and return plausible wrong numbers, and a dashboard full of
   * plausible wrong numbers is worse than one with a gap in it.
   */
  readonly drafts?: readonly SupportedDraft[]
  readonly context?: SessionContext
  readonly metrics?: Partial<MetricsConfig>
  readonly flightRecorder?: Partial<FlightRecorderConfig>
  readonly budget?: Partial<BudgetConfig>
  readonly upload?: Partial<UploadConfig>
  readonly storage?: Partial<StorageConfig>
  readonly limits?: Partial<Limits>
  readonly privacy?: Partial<PrivacyConfig>
  readonly onInternalError?: (err: unknown) => void
}

/**
 * **Safety valves a healthy integration never touches.**
 *
 * Deliberately narrow. A bag of unrelated numbers — transport caps beside
 * decoder caps beside buffer sizes beside flush cadence beside upload retry
 * policy beside a teardown deadline — leaves a reader unable to tell which knob
 * belongs to which decision, so anything a customer might deliberately set
 * lives in {@link MetricsConfig}, {@link UploadConfig} or
 * {@link BudgetConfig}; what is left fires only on something going wrong.
 *
 * The no-silent-constants rule still governs every one of them: a named key, a
 * recorded default, and a one-line provenance string. That rule is why the
 * hard-coded numbers live here rather than in the code that uses them — the
 * 8-transport cap, the 5,000/s — and why the dormant ring, which nothing sizes
 * at all, has a key.
 */
export interface Limits {
  readonly maxConcurrentTransports: number
  readonly controlRatePerSec: number
  readonly dormantRingBytes: number
  /** Header bytes buffered before a stream is declared desynchronised, never more. */
  readonly maxHeaderSlackBytes: number
}

/** What never leaves the device. */
export interface PrivacyConfig {
  /**
   * Overwrite Authorization Token values before they reach anything that keeps
   * them. **Defaults to on.**
   *
   * The opposite default is one where the safe outcome requires having thought
   * about it, and the people most likely not to have thought about it are
   * exactly the ones running a trial. Turning it off is a deliberate act by
   * somebody who has decided their tokens may be shipped to our ingest.
   */
  readonly maskAuthParams: boolean
}

/**
 * A {@link CollectorConfig} with every default applied.
 *
 * Spelled out rather than derived from `Required<Omit<…>>`, which reaches only
 * the top level and leaves every nested bag's own fields optional. Each field
 * here is required all the way down, so a bag `resolveConfig` forgets to fill
 * is a compile error rather than an `undefined` a consumer papers over.
 *
 * `context` is required-but-empty rather than absent: an unset `actorId` is
 * `''`, so the setup record has one shape and not two.
 */
export interface ResolvedConfig {
  readonly apiKey: string
  readonly endpoint: string
  readonly sessionId: string
  readonly detail: DetailLevel
  readonly drafts: readonly SupportedDraft[]
  readonly context: Required<SessionContext>
  readonly metrics: MetricsConfig
  readonly flightRecorder: FlightRecorderConfig
  readonly budget: BudgetConfig
  readonly upload: UploadConfig
  readonly storage: StorageConfig
  readonly limits: Limits
  readonly privacy: PrivacyConfig
}

/* ── envelope records ─────────────────────────────────────────────── */

/**
 * Bit 31 of a frame's u32 length prefix. **Set = raw bytes, clear = JSON.**
 *
 * The envelope is `[u32 len][payload]` with JSON and raw frames interleaved and
 * no way to tell them apart; this is that missing tag. Frame lengths are `< 2^31`
 * by construction — a batch seals at ~32 KB and a beacon caps near 64 KB
 * — so bit 31 is free.
 *
 * **Read it with `>>> 0`, never with a `===` on `&`.** JavaScript's bitwise
 * operators coerce to int32, so `(0x80000004 & FRAME_RAW_FLAG)` is
 * `-2147483648`: truthy, but never `=== FRAME_RAW_FLAG`. Use
 * `(prefix & FRAME_RAW_FLAG) !== 0` for the flag and
 * `(prefix & FRAME_LENGTH_MASK) >>> 0` for the length.
 */
export const FRAME_RAW_FLAG = 0x8000_0000

/** The length half of a frame prefix, once {@link FRAME_RAW_FLAG} is masked off. */
export const FRAME_LENGTH_MASK = 0x7fff_ffff

export type RecordType =
  | 'batch'
  | 'setup'
  | 'rollup'
  | 'ctrl'
  | 'hdr'
  | 'flight'
  | 'note'
  | 'terminal'
  | 'escalation'

export interface RecordBase {
  readonly t: RecordType
  /** Monotonic ms from the session anchor ({@link ClockAnchor.originMono}). */
  readonly ts: Mono
  /**
   * Which detail level produced this record. Ingest attributes billable bytes
   * by it, so it is on every record and never inferred from context.
   */
  readonly lvl: DetailLevel
}

/**
 * **ALWAYS the first frame of every body**, on both the `fetch()` and
 * `sendBeacon` paths.
 *
 * It carries the idempotency key that `sendBeacon` cannot put in a header,
 * since that path sets no request headers at all. The `fetch()` path sets
 * `Idempotency-Key` as well, so ingest
 * can dedupe without decompressing, but the frame is authoritative and always
 * present.
 *
 * `segmentSeq` is persisted **with** the chunk, never held in memory: a
 * sequence that resets on reload produces a fresh key per
 * retry and double-counts into the invoice.
 */
export interface BatchRecord extends RecordBase {
  readonly t: 'batch'
  readonly sessionId: string
  readonly segmentSeq: number
  /** `sha256(sessionId + ':' + segmentSeq)`, lowercase hex. */
  readonly idempotencyKey: string
  /**
   * `true` when the key came from the non-secure-context fallback rather than
   * `crypto.subtle`. A fallback key has different collision properties and
   * ingest dedupes exactly, so it must be told rather than left to guess.
   */
  readonly keyFallback?: boolean
  readonly wall: Wall
  readonly v: 1
}

/** Sent once per session. */
export interface SetupRecord extends RecordBase {
  readonly t: 'setup'
  readonly draft: SupportedDraft | null
  readonly protocol: string | null
  /**
   * A **SET**, never one role: role is a property of a track, not of a
   * session, and one session is routinely both.
   */
  readonly roles: readonly ('publisher' | 'subscriber')[]
  readonly anchor: ClockAnchor
  readonly identity: Identity
  /** Carried on every session: "did this regress in 4.2.1" is the second question asked. */
  readonly environment?: string
  readonly release?: string
  readonly collectorVersion: string
  /**
   * `true` when a worker never handshook. **Fail closed:** reporting a
   * partial session as complete is worse than reporting nothing.
   */
  readonly partial: boolean
  /**
   * Set only on an **in-process reconnect**, where the linkage is observed
   * fact. A page reload or process restart destroys that knowledge and only
   * the server can recover it, from `actorId` + `contentId` + time adjacency —
   * so `by` records which mechanism produced the link, because a heuristic join
   * inherits every false match `actorId` reuse can produce and the person
   * chasing the incident needs to know which they are looking at.
   */
  readonly continuedFrom?: { readonly sessionId: string; readonly by: 'collector' }
  /** The loud failure. Set means: transport-only metrics, raw control bytes still shipped. */
  readonly degraded?: 'draft-mismatch' | 'import-failed' | 'unsupported-protocol'
}

/**
 * One track's interval row.
 *
 * `key.v` is the {@link BucketKey} id as a **decimal string**, not a number:
 * the id is a `bigint` (aliases and request ids are vi64) and `JSON.stringify`
 * throws on a bigint. A `number` would silently lose precision past 2^53.
 *
 * Field names are short but descriptive on purpose: JSON field names are
 * the most compressible bytes on the wire and the reason 22.6× is reachable, so
 * shortening them past readability trades debuggability for nothing.
 */
export interface RollupTrackWire {
  readonly key: {
    readonly d: Direction
    readonly k: BucketKind
    readonly v: string
    readonly e: number
  }
  /**
   * Two concurrent subscriptions share this alias, so `duplicates` here are
   * **structural** — draft-20 requires the publisher to send the object once
   * per matching subscription even when they share an alias — rather than a
   * fault. Ingest must not alert on them.
   */
  readonly shared?: boolean
  /** Bounds the interval for ingest and lets it detect ambiguity. 16 bytes per bucket. */
  readonly firstSeen: Mono
  readonly lastSeen: Mono
  readonly objects: number
  readonly payloadBytes: number
  readonly headerBytes: number
  readonly groups: number
  readonly groupGaps: number
  readonly outOfOrder: number
  readonly duplicates: number
  readonly statusObjects: number
  readonly parseFailures: number
  /**
   * `pub.blockedMs`: total time this interval the page spent awaiting
   * `writer.ready` on a stream carrying this track. **Send side only**, and
   * omitted rather than sent as `0`, because a receive track can never have it
   * and a row per rx track saying so is bytes for nothing.
   *
   * A local scheduling fact: no byte on the wire records that a sender waited,
   * so this exists only if taken at the seam. Attribution is best-effort —
   * pressure sampled before the stream's subgroup header has been written has
   * no track to belong to yet, and lands in the session-level `writerReadyMs`
   * histogram alone. That histogram remains the total; this is the split.
   */
  readonly blockedMs?: number
  /**
   * `pub.ackedBytes`: bytes the transport confirmed delivered on streams
   * carrying this track, summed over the interval as **deltas** of the QUIC
   * stat, which is itself cumulative per stream.
   *
   * Chromium-only (`WebTransportSendStream.getStats()`), so its absence is
   * ordinary and never a fault. Send side only, and omitted when zero for the
   * same reason as {@link blockedMs}.
   */
  readonly ackedBytes?: number
  readonly hist: Partial<Record<HistogramKind, HistogramWire>>
}

/**
 * The interval rollup, computed at **every** detail level including
 * baseline — `detail` and `metrics.interval` are decoupled, which is what makes
 * the 1.8 KB baseline still report per-track object rate, bitrate, cadence,
 * gaps, duplicates, stalls and control latencies.
 */
export interface RollupRecord extends RecordBase {
  readonly t: 'rollup'
  readonly v: 1
  readonly seq: number
  readonly startMono: Mono
  readonly endMono: Mono
  readonly tracks: readonly RollupTrackWire[]
  /** Session-wide counters, name → value. Flat by design: it merges by addition. */
  readonly session: Readonly<Record<string, number>>
  /** Monotonic/wall divergence — the device slept. An explanation, not an error. */
  readonly suspended?: boolean
  readonly custom?: readonly CustomMetricWire[]
}

/**
 * A customer metric, folded to fixed cost per interval regardless of how many
 * times `observe()` was called.
 */
export interface CustomMetricWire {
  readonly name: string
  readonly unit: string
  readonly agg: MetricDefinition['agg']
  readonly labels?: Readonly<Record<string, string>>
  readonly value?: number
  readonly hist?: HistogramWire
}

/**
 * A control frame, **immediately followed by exactly one raw frame** carrying
 * its bytes. Baseline: the control plane is shipped raw so ingest
 * can reparse it server-side, which is what lets every name and namespace stay
 * off the device.
 */
export interface CtrlRecord extends RecordBase {
  readonly t: 'ctrl'
  readonly dir: Direction
  readonly streamId: number
  /** Byte length of the raw frame that follows. */
  readonly n: number
  readonly kind?: ExchangeKind
  /** `false` when the frame was counted and skipped: unknown codepoint or malformed. */
  readonly decoded: boolean
}

/**
 * An object header, **elevated only, never at baseline**, followed by one raw
 * frame.
 *
 * A conformant `.moqtrace` export needs object header bytes with arrival times
 * unconditionally, and this record is elevated-only — so a baseline session
 * cannot produce that export. Unresolved, not overlooked.
 */
export interface HdrRecord extends RecordBase {
  readonly t: 'hdr'
  readonly key: RollupTrackWire['key']
  /** Byte length of the raw frame that follows. */
  readonly n: number
}

/**
 * One flight-recorder dump: the ring re-parsed at full resolution over
 * the trigger's window.
 *
 * **Columnar — parallel arrays, never one row per object.** One row per object
 * is the shape the O(1)-per-object budget exists to avoid, and it is avoided
 * here too: the dump is a
 * single record no matter how many objects the window held.
 *
 * Derived records cross the wire; the ring's payload bytes never do.
 */
export interface FlightRecord extends RecordBase {
  readonly t: 'flight'
  readonly trigger: TriggerKind
  readonly windowStart: Mono
  readonly windowEnd: Mono
  /** All six arrays have the same length. `key` entries are {@link bucketKeyString} output. */
  readonly cols: {
    readonly key: readonly string[]
    readonly at: readonly number[]
    readonly group: readonly number[]
    readonly object: readonly number[]
    readonly bytes: readonly number[]
    readonly deliveryMs: readonly number[]
  }
  /** The window did not fit; the ring had already overwritten its head. */
  readonly truncated: boolean
}

/** A customer annotation (`annotate()`). */
export interface NoteRecord extends RecordBase {
  readonly t: 'note'
  readonly name: string
  /** The `annotate()` payload, verbatim. Never inspected, never reshaped. */
  readonly data: unknown
}

/**
 * The last record of a session. Carries the drop and overrun counters,
 * because a collector that silently drops is worse than one that says so.
 */
export interface TerminalRecord extends RecordBase {
  readonly t: 'terminal'
  readonly reason: 'stop' | 'abort' | 'pagehide' | 'overrun' | 'session-close'
  readonly counters: {
    readonly ringEvicted: number
    readonly ringEvictedBytes: number
    readonly chunksDropped: number
    readonly bucketsRefused: number
    readonly parseFailures: number
    /** Record types that were sampled rather than kept whole. */
    readonly sampledTypes: readonly string[]
    readonly overrunAt?: Mono
    readonly overrunSignal?: string
  }
  /** `true` when the session is known to be incomplete. Fail closed. */
  readonly partial: boolean
}

/**
 * What raised or lowered detail, when, and by which trigger.
 *
 * `by` records the source because the metering axis is elevated duration, so
 * what opened the window is part of the bill.
 */
export type WindowClose = 'resolve' | 'timeout' | 'ring' | 'unload'

export interface EscalationRecord extends RecordBase {
  readonly t: 'escalation'
  readonly from: DetailLevel
  readonly to: DetailLevel
  readonly by:
    | { readonly kind: 'manual'; readonly reason?: string }
    | {
        readonly kind: 'trigger'
        readonly trigger: TriggerKind
        readonly key?: RollupTrackWire['key']
      }
    | { readonly kind: 'ceiling' }
    | {
        /**
         * The window ended on one of the four conditions that close one.
         *
         * Separate from `manual` because three of the four are not a person:
         * the ring turning over is the collector, the post-event timeout is the
         * config, and unload is the browser. A dashboard attributing spend has
         * to be able to tell "a developer ended this" from "this ended itself",
         * and one `manual` bucket cannot say which.
         */
        readonly kind: 'window'
        readonly closed: WindowClose
        /** Free text from `resolve(reason)`; absent unless the caller passed one. */
        readonly reason?: string
      }
  readonly elevatedMinutesUsed: number
  readonly ceilingMinutes: number
}

export type EnvelopeRecord =
  | BatchRecord
  | SetupRecord
  | RollupRecord
  | CtrlRecord
  | HdrRecord
  | FlightRecord
  | NoteRecord
  | TerminalRecord
  | EscalationRecord

/* ── sinks ────────────────────────────────────────────── */

/**
 * Where records go. Implemented by the flush queue; the rollup, the decoder and
 * the flight recorder write into it and know nothing else about the wire.
 */
export interface RecordSink {
  json(r: EnvelopeRecord): void
  /**
   * A raw frame. **MUST be preceded by its describing JSON record in the same
   * body** — a raw frame is unreadable without the `ctrl`/`hdr` record that
   * names it, and each POST is a complete self-contained frame stream,
   * so the pair may never straddle a body.
   */
  raw(bytes: Uint8Array): void
}

/**
 * Why a chunk was sealed. Sealing (the flush schedule) and releasing (the
 * pacer) are separate: the pacer may only slow *release*, never seal less
 * often, which is the only reading under which the "a crash loses at most 60
 * seconds" stays true.
 */
export type SealReason = 'ready' | 'early' | 'interval' | 'bytes' | 'stop' | 'pagehide' | 'terminal'

/**
 * The release pacer's input. Object arrival rate is the only pressure
 * signal the spec names; `writerReadyMs` is this package's fallback for
 * publish-only sessions, which have no arriving objects.
 */
export interface PressureSample {
  readonly objectsPerSec: number
  readonly writerReadyMs?: number
  readonly at: Mono
}

export interface UploadOutcome {
  readonly ok: boolean
  readonly status?: number
  /** Terminal: a 4xx is counted and the chunk dropped, never retried forever. */
  readonly terminal: boolean
  /** The server's wall clock, for the four-timestamp handshake. */
  readonly serverWallMs?: number
}

/**
 * `usage()` — the collector's own volume, by level.
 *
 * A budgeting aid and explicitly **not** the invoice: the billable meter is
 * what actually arrives at ingest, and a client self-report is not a
 * trust boundary. `isEstimate: true` is a literal so it cannot be unset.
 */
export interface UsageReport {
  readonly bytesByLevel: Readonly<Record<DetailLevel, number>>
  /**
   * The increment: **whole seconds, rounded down, one-second minimum, per
   * capture window.** A 4.9 s window contributes 4, a 200 ms window contributes
   * 1, and two 200 ms windows contribute 2 — the rounding is per window and
   * cannot be recovered from a session total, which is why the seconds are
   * counted rather than derived from a duration at the point of display.
   */
  readonly elevatedSeconds: number
  /** {@link UsageReport.elevatedSeconds} in the unit the ceiling is set in. */
  readonly elevatedMinutes: number
  readonly bytesPerElevatedMinute: number
  /** A budgeting aid. The billable meter is what arrives at ingest. */
  readonly isEstimate: true
}
