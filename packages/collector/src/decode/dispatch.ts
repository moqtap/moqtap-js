/**
 * One stream in, the right counting decoder chosen, nothing retained.
 *
 * The dispatcher holds exactly one thing per stream — the decoder for it — and
 * that decoder holds O(1) state, so a session's decode memory is proportional to
 * its *open streams* and never to its objects.
 *
 * Two properties are load-bearing and easy to get wrong:
 *
 *  1. **A bidirectional stream is two byte streams under one id.** The seam
 *     assigns one synthetic id per stream (`StreamRegistry.next`), and a request
 *     stream carries the request one way and the response the other. Feeding
 *     both into one {@link ControlFramer} desynchronises it on the first
 *     response, so the decoder table is keyed by `(streamId, direction)` while
 *     the pending map stays keyed by `streamId` alone — the whole point of that
 *     map being that the stream, not a field, ties a response to its request.
 *  2. **The first chunk classifies, and only the first.** MoQT gives
 *     unidirectional streams a leading type — `0x05` FETCH_HEADER,
 *     `0b0XX1XXXX` SUBGROUP_HEADER, `0x2F00` SETUP, `0x132B3E28` PADDING — and
 *     a first byte is a *heuristic*: MoQT permits non-minimal varints, so a
 *     subgroup type of `0x10` may legally arrive as the two-byte `0x8010`, whose
 *     first byte sniffs as nothing. `'unknown'` is an ordinary outcome, counted
 *     once and then ignored for the life of the stream rather than retried per
 *     chunk.
 *
 * Also the module's replay entry point: {@link replay} runs this decoder over
 * recorded bytes so parse-and-discard cost is measured on the real code rather
 * than estimated.
 */

import { exchangeKindOf, requestIdOf } from '../draft/protocol.js'
import type {
  BucketKey,
  ControlFrameEvent,
  CountingSink,
  DatagramChunk,
  Direction,
  DraftAdapter,
  ExchangeKind,
  Mono,
  ObjectSample,
  ParseFailureReason,
  StreamChunk,
  StreamKind,
} from '../types.js'
import { ControlFramer } from './control-framer.js'
import { countDatagram } from './datagram-counter.js'
import { FetchCounter } from './fetch-counter.js'
import { SubgroupCounter } from './subgroup-counter.js'
import { TrackKeys } from './track-key.js'

export type { StreamKind }

/**
 * Draft-agnostic first-byte sniff, for callers that have no adapter yet — the
 * copy the seam uses during the dynamic-import await. The dispatcher itself uses
 * {@link DraftAdapter.sniff}, so a future draft can disagree without touching
 * this file.
 *
 *  - `0xaf` opens a draft-17+ unidirectional control stream: SETUP's `0x2F00` in
 *    MoQT's vi64. (`6f 00` is RFC 9000's spelling of the same number.)
 *  - `0x05` is FETCH_HEADER.
 *  - SUBGROUP_HEADER is any value below `0x80` with bit 4 set whose
 *    SUBGROUP_ID_MODE is not the reserved `0b11` (draft-20 §11.4.2's three
 *    invalidity rules).
 */
export function sniffStream(firstByte: number): StreamKind {
  if (firstByte === 0xaf) return 'control'
  if (firstByte === 0x05) return 'fetch'
  if (firstByte < 0x80 && (firstByte & 0x10) !== 0 && (firstByte & 0x06) !== 0x06) {
    return 'subgroup'
  }
  return 'unknown'
}

/** What a stream's decoder must offer the dispatcher. */
interface StreamCounter {
  push(chunk: Uint8Array, at: Mono): void
  end(): void
}

interface Entry {
  readonly kind: StreamKind
  readonly counter: StreamCounter | null
}

/**
 * Optional methods a {@link CountingSink} may also provide.
 *
 * Two measurements have no channel through `CountingSink`: `ControlFrameEvent`
 * carries neither an exchange kind nor a latency, and neither `BucketKey` nor
 * `ObjectSample` carries the shared-alias flag track state resolves
 * (`RollupTrackWire.shared`). The rollup engine exposes both as methods; the
 * dispatcher uses them when they are there and works unchanged when they are not.
 */
export interface RollupExtensions {
  observeControlLatency?(kind: ExchangeKind, ms: number): void
  markShared?(key: BucketKey): void
}

export interface DispatcherOptions {
  /** Header bytes a data stream may carry across a chunk boundary. */
  readonly slackBytes?: number
  /**
   * `privacy.maskAuthParams`. **Omitted means on**, so a caller who forgets to
   * thread the config through gets the safe behaviour rather than the leaky one.
   */
  readonly maskAuthParams?: boolean
}

export class StreamDispatcher {
  /** Keyed by `streamId * 2 + directionBit`: see the header's point 1. */
  private readonly streams = new Map<number, Entry>()
  private readonly observeLatency: ((kind: ExchangeKind, ms: number) => void) | undefined
  private readonly slackBytes: number | undefined
  private readonly maskAuthParams: boolean

  constructor(
    private readonly a: DraftAdapter,
    private readonly keys: TrackKeys,
    private readonly sink: CountingSink,
    opts?: DispatcherOptions,
  ) {
    this.slackBytes = opts?.slackBytes
    this.maskAuthParams = opts?.maskAuthParams ?? true
    const ext = sink as CountingSink & RollupExtensions
    this.observeLatency =
      typeof ext.observeControlLatency === 'function'
        ? ext.observeControlLatency.bind(ext)
        : undefined
    if (keys.onShared === undefined && typeof ext.markShared === 'function') {
      keys.onShared = ext.markShared.bind(ext)
    }
  }

  /** Open streams currently holding a decoder. Bounded by the peer's streams. */
  get openStreams(): number {
    return this.streams.size
  }

  /**
   * Which track a data stream is carrying, or `null`.
   *
   * The only way to attribute a *transport-level* fact — `writer.ready`
   * pressure, `bytesAcknowledged` — to a track, because the transport seam knows
   * stream ids and nothing else. `null` is ordinary: a control stream, a subgroup
   * header not yet written (so no alias read), or a key the bucket cap refused.
   * Treat it as "not attributable *yet*", never as an error. Reads
   * already-decoded state; parses nothing.
   */
  trackForStream(streamId: number, dir: Direction): BucketKey | null {
    const e = this.streams.get(slot(streamId, dir))
    if (e === undefined) return null
    const c = e.counter
    if (c instanceof SubgroupCounter || c instanceof FetchCounter) return c.bucketKey
    return null
  }

  onStreamData(c: StreamChunk): void {
    const k = slot(c.streamId, c.direction)
    let e = this.streams.get(k)
    if (e === undefined) {
      // An empty first chunk classifies nothing. Waiting costs one map miss;
      // guessing costs the stream.
      if (c.data.length === 0) return
      e = this.open(c)
      this.streams.set(k, e)
    }
    e.counter?.push(c.data, c.at)
  }

  onStreamClose(streamId: number): void {
    for (const dir of DIRECTIONS) {
      const k = slot(streamId, dir)
      const e = this.streams.get(k)
      if (e === undefined) continue
      e.counter?.end()
      // A fetch bucket's cap slot is freed here and nowhere else. Request ids
      // are never reused within a session, so without this a long-running
      // session's finished fetches would eventually crowd out its live tracks.
      if (e.counter instanceof FetchCounter) {
        const key = e.counter.bucketKey
        if (key !== null) this.keys.releaseFetch(key.dir, key.id)
      }
      this.streams.delete(k)
    }
    // A closed stream ends the request it carried, which is what makes the
    // next different request id on the same alias a rebind rather than a second
    // live subscription.
    this.keys.closeStream(streamId)
  }

  onDatagram(c: DatagramChunk): void {
    countDatagram(c.direction, c.data, c.at, this.keys, this.sink, this.a)
  }

  private open(c: StreamChunk): Entry {
    // The seam's classification wins: `StreamChunk.control` is
    // `bidi || the first chunk opened af 00`, which is the whole of the
    // draft-17+ control plane. Sniffing only decides among data streams.
    const kind: StreamKind = c.control ? 'control' : this.a.sniff(c.data[0] as number)
    const opts = this.slackBytes === undefined ? undefined : { slackBytes: this.slackBytes }

    switch (kind) {
      case 'control':
        return {
          kind,
          counter: new ControlFramer(
            c.direction,
            c.streamId,
            this.a,
            this.controlSink(),
            this.maskAuthParams,
          ),
        }
      case 'subgroup':
        return {
          kind,
          counter: new SubgroupCounter(c.direction, this.keys, this.sink, this.a.varint, opts),
        }
      case 'fetch':
        return {
          kind,
          counter: new FetchCounter(c.direction, this.keys, this.sink, this.a.varint, {
            ...opts,
            draft: this.a.draft,
          }),
        }
      default:
        // A padding stream (`0x132B3E28`) lands here, as does any type
        // a later draft adds and any subgroup header that used a non-minimal
        // varint. Counted once, then ignored — never buffered, never retried.
        this.sink.onParseFailure(null, 'unknown-stream-type')
        return { kind: 'unknown', counter: null }
    }
  }

  /**
   * The control sink: alias epochs and latencies, computed from frames the
   * framer has already decoded. The decode is in the budget regardless — the
   * server-side reparse, the draft check and the pending map all need it — so
   * reading these off it makes the epoch map free.
   */
  private controlSink(): CountingSink {
    const outer = this.sink
    const keys = this.keys
    const observe = this.observeLatency
    return {
      onObject(s: ObjectSample): void {
        outer.onObject(s)
      },
      onControlFrame(e): void {
        const msg = e.message
        if (msg !== null) {
          keys.applyControl(msg, e.dir, e.streamId, e.at)
          // A draft-17+ response carries no request id at all, so "no id"
          // is exactly how a response is recognised, and the stream is what ties
          // it to its request.
          if (requestIdOf(msg) === undefined) {
            const lat = keys.noteResponse(e.streamId, e.dir, exchangeKindOf(msg), e.at)
            if (lat !== undefined) observe?.(lat.kind, lat.latencyMs)
          }
        }
        outer.onControlFrame(e)
      },
      onParseFailure(key: BucketKey | null, reason: ParseFailureReason): void {
        outer.onParseFailure(key, reason)
      },
    }
  }
}

const DIRECTIONS: readonly Direction[] = ['tx', 'rx']

function slot(streamId: number, dir: Direction): number {
  return streamId * 2 + (dir === 'tx' ? 0 : 1)
}

/* ── replay ────────────────────────────────────── */

export type ReplayEvent =
  | { readonly type: 'stream'; readonly chunk: StreamChunk }
  | { readonly type: 'datagram'; readonly chunk: DatagramChunk }
  | { readonly type: 'close'; readonly streamId: number }

/** One recorded stream, as a capture holds it: bytes plus how they arrived. */
export interface RecordedStream {
  readonly streamId: number
  readonly dir: Direction
  readonly bytes: Uint8Array
  /** `bidi || the first chunk opened af 00` — what the seam stamps. */
  readonly control?: boolean
  readonly bidi?: boolean
  /** Monotonic arrival of the first chunk. Chunks after it are `at + index`. */
  readonly at?: Mono
  /**
   * Split into fixed-size chunks to model arrival. Boundary handling — the
   * header carry and the payload skip counter — is the code most likely to be
   * slow, and a single-chunk replay never exercises it.
   */
  readonly chunkBytes?: number
  /** Emit a close event after the last chunk. Defaults to true. */
  readonly close?: boolean
}

export interface ReplayOptions {
  readonly keys?: TrackKeys
  /** Defaults to a counting-only sink, so a benchmark measures the decoder. */
  readonly sink?: CountingSink
  readonly maxBuckets?: number
  readonly slackBytes?: number
  /** Passes over the same events, for a benchmark that needs a warm JIT. */
  readonly repeat?: number
}

export interface ReplayStats {
  readonly bytes: number
  readonly chunks: number
  readonly objects: number
  readonly objectHeaderBytes: number
  readonly objectPayloadBytes: number
  readonly controlFrames: number
  readonly controlBytes: number
  readonly parseFailures: number
  readonly bucketsRefused: number
  readonly elapsedMs: number
  /** Decoder throughput over the replayed bytes. */
  readonly megabytesPerSecond: number
  /** Nanoseconds of decode per counted object. */
  readonly nanosecondsPerObject: number
}

/**
 * A sink that counts and keeps nothing — the O(1) rule taken literally.
 *
 * The default for {@link replay}: with the real rollup attached, a benchmark
 * measures the rollup's histograms too; with this one it measures the decode.
 */
export class CountingStats implements CountingSink {
  objects = 0
  headerBytes = 0
  payloadBytes = 0
  controlFrames = 0
  controlBytes = 0
  failures = 0
  readonly failuresByReason = new Map<ParseFailureReason, number>()

  onObject(s: ObjectSample): void {
    this.objects++
    this.headerBytes += s.headerBytes
    this.payloadBytes += s.payloadBytes
  }

  onControlFrame(e: ControlFrameEvent): void {
    this.controlFrames++
    this.controlBytes += e.bytes.length
  }

  onParseFailure(_key: BucketKey | null, reason: ParseFailureReason): void {
    this.failures++
    this.failuresByReason.set(reason, (this.failuresByReason.get(reason) ?? 0) + 1)
  }
}

/** Build the events one recorded stream produces at the seam. */
export function recordedStreamEvents(s: RecordedStream): ReplayEvent[] {
  const events: ReplayEvent[] = []
  const size = s.chunkBytes !== undefined && s.chunkBytes > 0 ? s.chunkBytes : s.bytes.length
  const control = s.control ?? s.bidi ?? false
  const base = s.at ?? 0
  let i = 0
  let n = 0
  do {
    events.push({
      type: 'stream',
      chunk: {
        sessionId: 'replay',
        streamId: s.streamId,
        direction: s.dir,
        bidi: s.bidi ?? false,
        control,
        data: s.bytes.subarray(i, Math.min(i + size, s.bytes.length)),
        at: base + n,
      },
    })
    i += size
    n++
  } while (i < s.bytes.length)
  if (s.close !== false) events.push({ type: 'close', streamId: s.streamId })
  return events
}

/**
 * Replay recorded bytes through the real decoder and report what it cost.
 *
 * Builds nothing a live session would not build — the same
 * {@link StreamDispatcher}, the same {@link TrackKeys}, the same walks — so the
 * numbers are this implementation's, not an estimate of it. Pass `sink` to
 * measure the decoder *and* the rollup together.
 */
export function replay(
  events: Iterable<ReplayEvent>,
  adapter: DraftAdapter,
  opts?: ReplayOptions,
): ReplayStats {
  const repeat = Math.max(1, Math.trunc(opts?.repeat ?? 1))
  // A generator is single-use; more than one pass over one has to materialise.
  const list: Iterable<ReplayEvent> =
    repeat > 1 && !Array.isArray(events) ? Array.from(events) : events

  const stats = new CountingStats()
  const sink = opts?.sink ?? stats
  const keys =
    opts?.keys ??
    new TrackKeys(opts?.maxBuckets === undefined ? undefined : { maxBuckets: opts.maxBuckets })
  const dispatcherOpts =
    opts?.slackBytes === undefined ? undefined : { slackBytes: opts.slackBytes }

  let bytes = 0
  let chunks = 0
  const started = now()
  for (let pass = 0; pass < repeat; pass++) {
    // A fresh dispatcher per pass: stream ids repeat across passes, and a
    // dispatcher that had already classified them would replay the second pass
    // through the first pass's decoders.
    const d = new StreamDispatcher(adapter, keys, sink, dispatcherOpts)
    for (const ev of list) {
      switch (ev.type) {
        case 'stream':
          bytes += ev.chunk.data.length
          chunks++
          d.onStreamData(ev.chunk)
          break
        case 'datagram':
          bytes += ev.chunk.data.length
          chunks++
          d.onDatagram(ev.chunk)
          break
        default:
          d.onStreamClose(ev.streamId)
          break
      }
    }
  }
  const elapsedMs = now() - started

  return {
    bytes,
    chunks,
    objects: stats.objects,
    objectHeaderBytes: stats.headerBytes,
    objectPayloadBytes: stats.payloadBytes,
    controlFrames: stats.controlFrames,
    controlBytes: stats.controlBytes,
    parseFailures: stats.failures,
    bucketsRefused: keys.bucketsRefused,
    elapsedMs,
    megabytesPerSecond: elapsedMs > 0 ? bytes / 1e3 / elapsedMs : Number.POSITIVE_INFINITY,
    nanosecondsPerObject:
      stats.objects > 0 ? (elapsedMs * 1e6) / stats.objects : Number.POSITIVE_INFINITY,
  }
}

/** {@link replay} over whole recorded streams. */
export function replayStreams(
  streams: Iterable<RecordedStream>,
  adapter: DraftAdapter,
  opts?: ReplayOptions,
): ReplayStats {
  const events: ReplayEvent[] = []
  for (const s of streams) events.push(...recordedStreamEvents(s))
  return replay(events, adapter, opts)
}

function now(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now()
}
