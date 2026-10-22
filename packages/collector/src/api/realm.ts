/**
 * What one realm observes: the page, or a worker linked to it.
 *
 * A realm owns the transport hook's observer, one counting decoder and one
 * rollup per connection, the flight-recorder ring and the triggers. It turns
 * what it sees into records and writes them into its host's sink. It seals,
 * stores and uploads nothing: in the page the host is the runtime that does
 * those, and in a worker the host is the probe that forwards the frames to the
 * page.
 *
 * Three rules govern everything below.
 *
 * **1. The seam is a bounded enqueue and nothing else.** `types.ts` states the
 * contract: "every method runs synchronously on the page's own data path —
 * `onStreamData` fires *before* the page's write reaches the transport". So the
 * observer methods here copy, count and return: no `await`, no compression, no
 * storage call, and no timer started on that thread of control.
 *
 * **2. Nothing throws into the page.** Every observer method is wrapped, and
 * every failure goes to the host's error handler.
 *
 * **3. The overrun policy is a state, not a degradation.** Control frames and
 * the connection records are **non-droppable**; per-object detail is
 * droppable. When even the non-droppable set cannot be kept up with, the realm
 * stops observing and tells its host, which ends the instance.
 */

import { StreamDispatcher, TrackKeys } from '../decode/index.js'
import {
  type DraftSet,
  degradedReasonOf,
  draftNumberOfVersion,
  draftOfVersion,
  LEGACY_PROTOCOL,
  readSetupFrame,
  resolveDraft,
} from '../draft/index.js'
import { FlightRecorder, TriggerEngine, type TriggerEvent } from '../recorder/index.js'
import { ByteRing, parseByteDepth, type RingEntry } from '../ring/index.js'
import { RollupEngine } from '../rollup/index.js'
import type { TransportHook } from '../transport/index.js'
import {
  type BucketKey,
  bucketKeyWire,
  type ClockSource,
  type ConnCloseCause,
  type ConnCloseRecord,
  type ConnOpenRecord,
  type ConnOptions,
  type ControlFrameEvent,
  type DatagramChunk,
  type DetailLevel,
  type Direction,
  type DraftAdapter,
  type EndCounters,
  type EnvelopeRecord,
  type ExchangeKind,
  type HdrRecord,
  type InterceptedSession,
  type Mono,
  type ObjectSample,
  type ParseFailureReason,
  type PressureSample,
  type Realm,
  type RecordSink,
  type RecordType,
  type ResolvedConfig,
  type Role,
  type RollupRecord,
  type SessionCloseInfo,
  type StreamChunk,
  type SupportedDraft,
  type TransportObserver,
  type WebTransportOptionsInfo,
  type WriterPressure,
} from '../types.js'
import { levelIndex } from './defaults.js'
import { DORMANT_DATAGRAM_STREAM_ID, drainDormant } from './dormant.js'
import { type EarlyConnection, halfOf } from './early.js'

/**
 * The droppable set, and the whole of it.
 *
 * "**Never sample a non-droppable type.** Under pressure, sample only the
 * droppable ones, and record exactly which." A dropped record must not change
 * the meaning of one that survives:
 *
 *  - `ctrl` is **non-droppable**: the control plane is what ingest reparses to
 *    recover every track name, namespace and status the client deliberately does
 *    not ship. A rollup row whose binding message was dropped is a row
 *    ingest cannot name.
 *  - `conn-open`, `conn-close`, `setup`, `end`, `link`, `life` and `escalation`
 *    are **non-droppable**: a handful per connection or per instance, and each
 *    one explains every record around it.
 *  - `rollup` is **non-droppable**: already O(1) per interval, and its counters
 *    are cumulative, so a dropped one is a hole in a total rather than a missing
 *    sample.
 *  - `hdr`, `flight` and `note` are **droppable**: per-object detail and
 *    customer annotations, each of which is one of many.
 */
const DROPPABLE: ReadonlySet<RecordType> = new Set<RecordType>(['hdr', 'flight', 'note'])

/**
 * How many send streams may hold ack state at once.
 *
 * A closed stream's entry is dropped as soon as its final reading lands, so
 * this only bounds the pathological case: a stream aborted between its last
 * probe and a reading that never comes. Closed entries are swept first, and
 * insertion order makes the sweep the oldest ones.
 */
const MAX_ACK_STREAMS = 256

/** From this level an `hdr` record carries the payload size. */
const SIZES = levelIndex('headers+sizes')

/** The `sampledTypes` entry for control bytes lost before the session attached. */
const EARLY_CONTROL = 'early-control'

/** The slice of the resolved config a realm reads. A worker gets exactly this from its page. */
export type RealmConfig = Pick<
  ResolvedConfig,
  'metrics' | 'flightRecorder' | 'limits' | 'privacy' | 'upload' | 'context'
>

/** Where a realm's records go, and who it tells about what it sees. */
export interface RealmHost {
  /**
   * The buffer records are written into. `pendingBytes` drives the droppable
   * gate: what the buffer will cost to upload, which a host that compresses
   * before it forwards weighs below its raw size.
   */
  readonly sink: RecordSink & { readonly pendingBytes: number }
  /** The detail level records are stamped with. */
  level(): DetailLevel
  /** A trigger fired. Called before the flight dump, so the dump carries the raised level. */
  onTrigger(e: TriggerEvent): void
  /** A connection's draft is known, or known to be unusable: the first upload is worth making. */
  onConnReady(): void
  /** A connection closed and its last records are written. */
  onConnClosed(): void
  /** The control plane outran the collector. The realm has already stopped observing. */
  onOverrun(atMono: Mono, signal: string): void
  /** The release pacer's input. */
  onPressure(p: PressureSample): void
  /** A byte was written to the sink: the seal schedule counts them. */
  onBytes(n: number): void
  onError(err: unknown): void
}

export interface RealmOptions {
  readonly realm: Realm
  readonly config: RealmConfig
  readonly hook: TransportHook
  readonly drafts: DraftSet
  readonly host: RealmHost
  /** The session anchor's monotonic origin. Every `ts` this realm writes is relative to it. */
  readonly originMono: Mono
  readonly clock: ClockSource
}

/** A connection as the page's API and the probe's snapshots report it. */
export interface ConnectionState {
  readonly id: string
  readonly realm: Realm
  readonly origin: string
  readonly draft: SupportedDraft | null
  readonly contentId?: string
  readonly state: 'connecting' | 'open' | 'closed'
  readonly closeCause?: ConnCloseCause
}

/** An open connection as a worker reports it to its page with every forward. */
export interface ConnectionSnapshot {
  readonly conn: ConnectionState
  /** The open interval so far: what the page reports if the worker is gone before the next one. */
  readonly rollup: RollupRecord | null
  readonly counters: ConnCloseRecord['counters']
}

interface Connection {
  readonly id: string
  readonly session: InterceptedSession
  readonly origin: string
  readonly options: ConnOptions | undefined
  readonly contentId: string
  readonly rollup: RollupEngine
  /** The sink the decoder writes into, bound to this connection's rollup. */
  readonly sink: ConnectionSink
  keys: TrackKeys
  dispatcher: StreamDispatcher | null
  adapter: DraftAdapter | undefined
  draft: SupportedDraft | null
  protocol: string | null
  degraded: ConnOpenRecord['degraded'] | undefined
  /** When `ready` resolved, relative to the anchor; unset until it does. */
  readyTs: number | undefined
  offered: number[] | undefined
  /**
   * The offered drafts are known or no longer looked for: they came from the
   * constructor's `protocols`, the session is draft-15 or later (whose
   * CLIENT_SETUP carries no version list), or the first chunk the page wrote
   * on its control stream has been read.
   */
  offerProbed: boolean
  roles: Set<Role>
  /** The raw buffer, held until the draft is known. Bounded in bytes. */
  pending: StreamChunk[]
  pendingBytes: number
  pendingDatagrams: DatagramChunk[]
  closed: boolean
  /**
   * The session negotiated `moq-00`, or no protocol at all over WebTransport,
   * so the draft is still unknown and is being looked for in the handshake.
   *
   * Set only for the eight drafts before -15. Cleared the moment SETUP names a
   * version, or when the pre-draft buffer fills — see `#probeSetup`.
   */
  awaitingSetup: boolean
  /**
   * Stream halves already offered to the setup probe, so each is tried once.
   *
   * SETUP is the first message each side writes on the control stream, so only
   * the first chunk in each direction can carry it: a CLIENT_SETUP offering
   * several versions says nothing, and the SERVER_SETUP that does arrives on
   * the same stream. Without this the probe would re-run on every buffered
   * chunk of a stream it has already declined.
   */
  probedStreams: Set<string>
  /**
   * Halves that began before this realm attached and cannot be decoded from
   * the middle: object streams, and control streams the dormant buffer cut
   * short. Their remainder is counted, not decoded.
   */
  skip: Set<string>
  /**
   * Per send stream: the last `bytesAcknowledged` seen, and the track to credit
   * it to once resolved.
   *
   * The QUIC stat is **cumulative for the life of the stream** while
   * `RollupTrackWire.ackedBytes` is a per-interval sum, so the difference is
   * taken here rather than in the bucket: the stat is per *stream* and a track
   * spans many streams.
   *
   * The track is **cached rather than looked up on arrival**, because the final
   * reading arrives after the stream is gone. `writer.close()` calls `onDone`
   * synchronously — `onStreamClose` here — and only then probes `getStats()`,
   * whose promise resolves a microtask later, by which point the dispatcher has
   * dropped the decoder that knew the track. For a stream carrying one subgroup
   * that closing probe is often the *only* one, so resolving late would lose the
   * metric, not merely a tail.
   */
  ackedByStream: Map<number, SendStreamAcks>
}

interface SendStreamAcks {
  /** Cumulative, as the stat itself is. */
  last: number
  /** Resolved while the stream still had a decoder; `null` until then. */
  key: BucketKey | null
  /** The stream has closed; the next reading is its last. */
  closed: boolean
}

type ConnectionSink = RecordSink & {
  onObject(s: ObjectSample): void
  onControlFrame(e: ControlFrameEvent): void
  onParseFailure(k: BucketKey | null, r: ParseFailureReason): void
  observeControlLatency(k: ExchangeKind, ms: number): void
  markShared(k: BucketKey): void
}

/**
 * Scheme, host and port of a transport URL. A path or a query can carry a
 * token, so neither ever leaves the device.
 */
export function originOf(url: string): string {
  const m = /^([a-z][a-z0-9+.-]*:\/\/[^/?#]*)/i.exec(url)
  if (m === null) return ''
  // Userinfo can carry credentials too.
  return (m[1] as string).replace(/\/\/[^@/]*@/, '//')
}

/** The options a connection reports: everything the hook kept but the offered protocols. */
function connOptionsOf(o: WebTransportOptionsInfo | undefined): ConnOptions | undefined {
  if (o === undefined) return undefined
  const { protocols: _offered, ...rest } = o
  return Object.keys(rest).length > 0 ? rest : undefined
}

/**
 * Distinct draft numbers, in the order offered, or `undefined` for none.
 */
function offeredOf<T>(
  items: readonly T[],
  draftOf: (x: T) => number | undefined,
): number[] | undefined {
  const out: number[] = []
  for (const x of items) {
    const d = draftOf(x)
    if (d !== undefined && !out.includes(d)) out.push(d)
  }
  return out.length > 0 ? out : undefined
}

/**
 * The draft an offered protocol names. Read by pattern, unlike the exact table
 * that picks a parser: this only reports, and a draft this build cannot parse
 * is worth reporting. `moq-00` names no single draft and adds nothing.
 */
function draftOfOffered(p: string): number | undefined {
  const m = /^moqt-(\d{1,3})$/.exec(p)
  return m === null ? undefined : Number(m[1])
}

export class RealmObserver {
  readonly #o: RealmOptions
  readonly #host: RealmHost
  readonly #origin: Mono
  readonly #ring: ByteRing
  readonly #recorder: FlightRecorder
  readonly #triggers: TriggerEngine
  readonly #connections = new Map<string, Connection>()
  /** Closed connections, for `connections()` and the counters on `end`. */
  readonly #closed: ConnectionState[] = []

  /** Drafts the dormant hook read off SETUP frames that crossed before this realm started. */
  #dormantSetupDrafts: ReadonlyMap<string, SupportedDraft> = new Map()
  #contentId: string
  #halted = false
  #skipRaw = false
  #ctrlWindowStart = 0
  #ctrlInWindow = 0
  #objectsInWindow = 0
  #droppedRecords = 0
  #sampledTypes = new Set<string>()
  #transportsRefused = 0
  /** Counters of connections that have closed, so the instance total survives them. */
  #closedParseFailures = 0
  #closedBucketsRefused = 0
  #overrunAt: Mono | undefined
  #overrunSignal: string | undefined
  /** A closing connection's last interval is being written; it passes the halt gate. */
  #closing = false

  constructor(o: RealmOptions) {
    this.#o = o
    this.#host = o.host
    this.#origin = o.originMono
    this.#contentId = o.config.context.contentId
    this.#ring = new ByteRing({ maxBytes: this.#depthBytes() })
    this.#recorder = new FlightRecorder({
      ring: this.#ring,
      sink: this.#sink,
      adapter: (e) => this.#connectionFor(e.key)?.adapter,
      keys: (e) => this.#connectionFor(e.key)?.keys,
      conn: (e) => this.#connectionFor(e.key)?.id ?? '',
      level: () => this.#host.level(),
      originMono: this.#origin,
    })
    this.#triggers = new TriggerEngine({
      config: o.config.flightRecorder.triggers,
      medians: {
        medianFor: (k) => this.#rollupOwning(k)?.medianFor(k),
        medianSamplesFor: (k) => this.#rollupOwning(k)?.medianSamplesFor(k) ?? 0,
      },
      onFire: (e) => this.#onTriggerFired(e),
    })
  }

  /** The ring's bounds, for the escalation controller's "ring filled" close condition. */
  get ring(): ByteRing {
    return this.#ring
  }

  get halted(): boolean {
    return this.#halted
  }

  /** Records refused by the droppable gate or the pre-draft buffer cap. */
  get droppedRecords(): number {
    return this.#droppedRecords
  }

  /** Objects seen in the current one-second window: the pacer's pressure signal. */
  get objectRate(): number {
    return this.#objectsInWindow
  }

  /** Every connection this realm has seen, open ones first. */
  connections(): ConnectionState[] {
    const open: ConnectionState[] = []
    for (const c of this.#connections.values()) open.push(this.#stateOf(c))
    return [...open, ...this.#closed]
  }

  /** Context for connections opened from now on. */
  setContentId(contentId: string): void {
    this.#contentId = contentId
  }

  /**
   * Take over from the dormant hook and start observing.
   *
   * Order matters. The dormant ring's pre-key bytes are moved into this
   * realm's own ring before the observer goes live, so no byte arrives at a
   * dispatcher before the ring it may be replayed from is populated.
   */
  start(): void {
    const dormant = drainDormant()
    this.#dormantSetupDrafts = dormant.setupDrafts
    if (this.#armed() && dormant.entries.length > 0) {
      // Dormant bytes mean this realm has already opened a WebTransport, so the
      // ring is wanted now. Otherwise it waits for `onSessionOpen`: a page
      // that only links workers never opens one and must not hold the memory.
      this.#ring.reserve()
      this.#adoptDormantRing(dormant.entries)
    }
    this.#recorder.arm(this.#o.config.flightRecorder.triggers)
    // `setObserver` replays every session that was already open, `onSessionOpen`
    // first and then the negotiated protocol — which is the ordinary case on a
    // page that connects at load and calls `init()` after its own bootstrap.
    this.#o.hook.setObserver(this.#guarded())
    // Synchronously after, so the held control plane reaches each decoder
    // before any live byte can.
    this.#adoptEarly(dormant.early)
  }

  /**
   * Close the open rollup interval of every connection, and run the triggers.
   * The host calls this on `metrics.intervalMs` and before every seal.
   */
  tick(now: Mono): void {
    for (const c of this.#connections.values()) c.rollup.tick(now)
    this.#triggers.tick(now)
  }

  /** Every open connection with its open rollup interval, which stays open. */
  snapshots(now: Mono): ConnectionSnapshot[] {
    const out: ConnectionSnapshot[] = []
    for (const c of this.#connections.values()) {
      out.push({
        conn: this.#stateOf(c),
        rollup: c.rollup.snapshot(now),
        counters: {
          parseFailures: c.rollup.parseFailures,
          bucketsRefused: c.rollup.bucketsRefused,
        },
      })
    }
    return out
  }

  /**
   * Counters over the realm's whole life, closed connections included, for the
   * `end` record.
   */
  counters(): Omit<EndCounters, 'chunksDropped'> {
    let parseFailures = this.#closedParseFailures
    let bucketsRefused = this.#closedBucketsRefused + this.#transportsRefused
    for (const c of this.#connections.values()) {
      parseFailures += c.rollup.parseFailures
      bucketsRefused += c.rollup.bucketsRefused
    }
    return {
      ringEvicted: this.#ring.evicted,
      ringEvictedBytes: this.#ring.evictedBytes,
      bucketsRefused,
      parseFailures,
      sampledTypes: [...this.#sampledTypes],
      ...(this.#overrunAt !== undefined ? { overrunAt: this.#overrunAt - this.#origin } : {}),
      ...(this.#overrunSignal !== undefined ? { overrunSignal: this.#overrunSignal } : {}),
    }
  }

  /**
   * Stop observing. Synchronous. Writes nothing; {@link closeAll} is what
   * reports the connections that were still open.
   */
  detach(): void {
    this.#halted = true
    try {
      this.#o.hook.setObserver(null)
    } catch (err) {
      this.#host.onError(err)
    }
    this.#recorder.disarm()
    this.#triggers.reset()
  }

  /**
   * Report every open connection closed with `cause`, its last rollup
   * interval first. Written past the halt gate: these are the records that say
   * why the connection's data stops.
   */
  closeAll(cause: ConnCloseCause, now: Mono): void {
    for (const c of [...this.#connections.values()]) this.#close(c, now, { cause })
  }

  /** Release memory. After this the realm is inert. */
  clear(): void {
    this.#ring.clear()
    this.#connections.clear()
  }

  /* ── TransportObserver — every method runs on the page's data path ────── */

  onSessionOpen(s: InterceptedSession): void {
    if (this.#halted) return
    // The ring claims its memory with the realm's first transport and nowhere
    // else. At the default depth that is 32 MiB, and every `#ring.push` site is
    // behind `#armed()`, so a realm with no trigger or no transport never
    // writes to it. A session opens before its first chunk, which keeps the
    // allocation off the data path. Ahead of the cap: a refused transport's
    // bytes are still ringed.
    if (this.#armed()) this.#ring.reserve()
    if (this.#connections.size >= this.#o.config.limits.maxConcurrentTransports) {
      // "Cap concurrent transports at 8: real clients are genuinely
      // bounded there, so the cap only ever fires on something wrong." Counted,
      // never silent (rule 2). Cumulative is deliberately uncapped.
      this.#transportsRefused += 1
      return
    }
    const config = this.#o.config
    const offered = offeredOf(s.options?.protocols ?? [], draftOfOffered)
    const rollup = new RollupEngine({
      intervalMs: config.metrics.intervalMs,
      maxBuckets: config.metrics.maxTracks,
      clock: this.#o.clock,
      sink: this.#sink,
      originMono: this.#origin,
      conn: s.id,
    })
    const c: Connection = {
      id: s.id,
      session: s,
      origin: originOf(s.url),
      options: connOptionsOf(s.options),
      contentId: this.#contentId,
      rollup,
      sink: this.#connectionSink(() => c, rollup),
      keys: new TrackKeys({ maxBuckets: config.metrics.maxTracks }),
      dispatcher: null,
      adapter: undefined,
      draft: null,
      protocol: null,
      degraded: undefined,
      readyTs: undefined,
      offered,
      offerProbed: offered !== undefined,
      roles: new Set(),
      pending: [],
      pendingBytes: 0,
      pendingDatagrams: [],
      closed: false,
      awaitingSetup: false,
      probedStreams: new Set(),
      skip: new Set(),
      ackedByStream: new Map(),
    }
    this.#connections.set(s.id, c)
    // Stamped with the transport's own construction time, which precedes this
    // realm's start for a session replayed from the dormant hook.
    this.#writeConnOpen(c, s.anchor.originMono - this.#origin)
  }

  /** `ready` resolved. Every path below sends the connection record again, with `readyTs`. */
  onSessionProtocol(sessionId: string, protocol: string, at?: Mono): void {
    const c = this.#connections.get(sessionId)
    if (c === undefined || c.dispatcher !== null) return
    c.readyTs = (at ?? this.#o.clock.now()) - this.#origin
    c.protocol = protocol === '' ? null : protocol
    if (protocol === LEGACY_PROTOCOL || protocol === '') {
      // Drafts before -15 negotiate `moq-00` over QUIC and nothing over
      // WebTransport, so the version comes from SETUP: read by the dormant hook
      // if the handshake preceded `init()`, else by `#probeSetup`.
      const known = this.#dormantSetupDrafts.get(sessionId)
      if (known !== undefined) {
        this.#attachDraft(c, LEGACY_PROTOCOL, known)
        return
      }
      c.awaitingSetup = true
      this.#writeConnOpen(c)
      return
    }
    c.offerProbed = true
    this.#attachDraft(c, protocol)
  }

  onSessionClose(sessionId: string, _reason: string, at: Mono, info?: SessionCloseInfo): void {
    const c = this.#connections.get(sessionId)
    if (c === undefined) return
    // A pre-15 connection that closes before SETUP named its version carries
    // no `degraded`: nothing showed the version to be one this build can't read.
    this.#close(c, at, info ?? { cause: 'closed' })
    this.#host.onConnClosed()
  }

  onStreamData(c: StreamChunk): void {
    if (this.#halted) return
    // Control bytes are deliberately NOT ringed: a token would sit in memory
    // for the life of the session.
    //
    // The replay skips every control entry it finds (`recorder/replay.ts`) and
    // baseline already ships every control frame's exact bytes through the
    // framer, so a ringed copy would have no consumer. And a chunk arriving here
    // is not frame-aligned, so masking it here would mean a second
    // frame-aligned parser at the seam.
    if (this.#armed() && !c.control) {
      this.#ring.push({
        sessionId: c.sessionId,
        streamId: c.streamId,
        dir: c.direction,
        control: c.control,
        atMono: c.at,
        data: c.data,
      })
    }
    const conn = this.#connections.get(c.sessionId)
    if (conn === undefined) return
    if (conn.skip.size > 0 && conn.skip.has(halfOf(c.streamId, c.direction))) {
      this.#skipEarly(conn, c.control, c.data.byteLength)
      return
    }
    // The probe may attach a dispatcher.
    if (c.control) this.#probeSetup(conn, c)
    const d = conn.dispatcher
    if (d !== null) {
      d.onStreamData(c)
      return
    }
    // The draft has not been identified. Buffer raw, bounded — an unbounded
    // buffer behind a draft that never resolves is a page-killing leak.
    this.#bufferPending(conn, c)
  }

  onStreamClose(sessionId: string, streamId: number): void {
    const conn = this.#connections.get(sessionId)
    if (conn === undefined) return
    // Resolve the track *before* the dispatcher drops the decoder that knows
    // it. The closing `getStats()` probe fires right after this returns and
    // lands a microtask later, by which point nothing else can answer.
    //
    // The entry is *created* here when there is none, not merely updated. A
    // stream carrying a single subgroup — the ordinary shape — is probed once,
    // at close, so its first reading is also its last and it would otherwise
    // find no entry, resolve no track, and report nothing.
    const existing = conn.ackedByStream.get(streamId)
    if (existing !== undefined) {
      existing.closed = true
      existing.key ??= conn.dispatcher?.trackForStream(streamId, 'tx') ?? null
    } else {
      const key = conn.dispatcher?.trackForStream(streamId, 'tx') ?? null
      // Only for a stream that carried a track. A control stream has no
      // send-side metric to attribute and would just occupy a slot.
      if (key !== null) {
        if (conn.ackedByStream.size >= MAX_ACK_STREAMS) sweepAcks(conn)
        conn.ackedByStream.set(streamId, { last: 0, key, closed: true })
      }
    }
    conn.skip.delete(halfOf(streamId, 'rx'))
    conn.skip.delete(halfOf(streamId, 'tx'))
    conn.dispatcher?.onStreamClose(streamId)
  }

  onStreamError(_sessionId: string, _streamId: number, error: unknown): void {
    this.#host.onError(error)
  }

  /**
   * Counted against the track the stream carried, which the dispatcher still
   * knows: the hook reports the reset before the stream's close. A stream reset
   * before its header named a track is counted on the connection.
   */
  onStreamReset(sessionId: string, streamId: number, d: Direction, code: number, at: Mono): void {
    if (this.#halted) return
    const conn = this.#connections.get(sessionId)
    if (conn === undefined) return
    const key = conn.dispatcher?.trackForStream(streamId, d) ?? null
    if (key !== null) conn.rollup.observeReset(key, code, at)
    else if (conn.dispatcher !== null) conn.rollup.count('resets.untracked', 1)
  }

  onDatagram(c: DatagramChunk): void {
    if (this.#halted) return
    if (this.#armed()) {
      this.#ring.push({
        sessionId: c.sessionId,
        streamId: DORMANT_DATAGRAM_STREAM_ID,
        dir: c.direction,
        control: false,
        atMono: c.at,
        data: c.data,
      })
    }
    const conn = this.#connections.get(c.sessionId)
    if (conn === undefined) return
    if (conn.dispatcher !== null) conn.dispatcher.onDatagram(c)
    else if (conn.pendingDatagrams.length < 512) {
      conn.pendingDatagrams.push({ ...c, data: c.data.slice() })
    }
  }

  onWriterPressure(p: WriterPressure): void {
    if (this.#halted) return
    const conn = this.#connections.get(p.sessionId)
    if (conn === undefined) return
    conn.rollup.observeWriterReady(p.readyLatencyMs)
    // And again against the track, when the stream has one. `writer.ready` can
    // resolve before the page has written the subgroup header that names the
    // alias, so an unattributed episode is ordinary rather than a fault: it is
    // in the connection histogram above either way, which is what keeps that
    // number a true total.
    const key = conn.dispatcher?.trackForStream(p.streamId, 'tx')
    if (key != null) conn.rollup.observeWriterBlocked(key, p.readyLatencyMs, p.at)
    // Object arrival rate is the pacer's pressure signal; a publish-only
    // session has no arriving objects, so `writer.ready` latency is this
    // package's fallback for it — a choice the spec does not make and nothing
    // has validated.
    this.#host.onPressure({
      objectsPerSec: this.#objectsInWindow,
      writerReadyMs: p.readyLatencyMs,
      at: p.at,
    })
  }

  /**
   * `WebTransportSendStream.getStats().bytesAcknowledged`, cumulative per
   * stream, differenced here and attributed to the track the stream carries.
   *
   * Chromium-only and feature-detected at the seam, so on every other engine
   * this is simply never called and `ackedBytes` never appears on a row. That
   * is the intended behaviour, not a degraded one — the field's absence is not
   * distinguishable from "nothing was acknowledged" and must not be alerted on.
   */
  onSendStats(sessionId: string, streamId: number, bytesAcknowledged: number, at: Mono): void {
    if (this.#halted) return
    if (!Number.isFinite(bytesAcknowledged) || bytesAcknowledged < 0) return
    const conn = this.#connections.get(sessionId)
    if (conn === undefined) return

    let acks = conn.ackedByStream.get(streamId)
    if (acks === undefined) {
      if (conn.ackedByStream.size >= MAX_ACK_STREAMS) sweepAcks(conn)
      acks = { last: 0, key: null, closed: false }
      conn.ackedByStream.set(streamId, acks)
    }

    const delta = bytesAcknowledged - acks.last
    if (delta > 0) {
      // Late resolution, for a stream first probed before its subgroup header
      // had been written. `onStreamClose` is the other half of this.
      acks.key ??= conn.dispatcher?.trackForStream(streamId, 'tx') ?? null
      if (acks.key !== null) {
        // Advanced only when the bytes are actually credited. Advancing it on
        // an unattributable reading would silently discard everything
        // acknowledged before the track became known — and those bytes belong
        // to the track as much as the later ones do. Held back, the first
        // reading that can be attributed carries the whole cumulative total,
        // which is what the stat means.
        acks.last = bytesAcknowledged
        conn.rollup.observeAckedBytes(acks.key, delta, at)
      }
    }
    // A closed stream's reading is its last, so the entry has done its job.
    if (acks.closed) conn.ackedByStream.delete(streamId)
  }

  /* ── the sinks ────────────────────────────────────────────────────────── */

  /**
   * The gate, and the only path from a record to the host.
   *
   * A `raw` frame is unreadable without the JSON record that names it and the
   * two must never straddle a body, so `raw` follows the fate of the record
   * before it: `#skipRaw` is set when a JSON record is dropped and the next
   * `raw` is dropped with it.
   */
  readonly #sink: RecordSink = {
    json: (r: EnvelopeRecord): void => this.#writeRecord(r),
    raw: (b: Uint8Array): void => {
      if (this.#halted || this.#skipRaw) {
        this.#skipRaw = false
        return
      }
      try {
        this.#host.sink.raw(b)
        this.#host.onBytes(b.byteLength)
      } catch (err) {
        this.#host.onError(err)
      }
    },
  }

  #connectionSink(conn: () => Connection, rollup: RollupEngine): ConnectionSink {
    return {
      json: this.#sink.json,
      raw: this.#sink.raw,
      onObject: (s: ObjectSample): void => {
        this.#objectsInWindow += 1
        const c = conn()
        const role: Role = s.key.dir === 'tx' ? 'publisher' : 'subscriber'
        if (!c.roles.has(role)) {
          c.roles.add(role)
          this.#writeConnOpen(c)
        }
        rollup.onObject(s)
        this.#triggers.onObject(s)
        const lvl = this.#host.level()
        if (lvl !== 'baseline') this.#writeHdr(c, s, lvl)
      },
      onControlFrame: (e: ControlFrameEvent): void => {
        this.#noteControlFrame(e.at)
        if (this.#halted) return
        rollup.onControlFrame(e)
      },
      onParseFailure: (k: BucketKey | null, r: ParseFailureReason): void => {
        rollup.onParseFailure(k, r)
      },
      observeControlLatency: (k: ExchangeKind, ms: number): void => {
        rollup.observeControlLatency(k, ms)
      },
      markShared: (k: BucketKey): void => {
        rollup.markShared(k)
      },
    }
  }

  #writeRecord(r: EnvelopeRecord): void {
    if (this.#halted && !this.#closing) {
      this.#skipRaw = true
      return
    }
    // "Never sample a non-droppable type. Under pressure, sample only
    // the droppable ones, and record exactly which."
    if (DROPPABLE.has(r.t) && this.#underPressure()) {
      this.#droppedRecords += 1
      this.#sampledTypes.add(r.t)
      this.#skipRaw = true
      return
    }
    try {
      const before = this.#host.sink.pendingBytes
      this.#host.sink.json(r)
      this.#host.onBytes(Math.max(0, this.#host.sink.pendingBytes - before))
      this.#skipRaw = false
    } catch (err) {
      this.#host.onError(err)
      this.#skipRaw = true
    }
  }

  /**
   * One object's header, while detail is raised. Through the droppable gate,
   * so a buffer near its cap sheds these before anything that explains them.
   *
   * Priority and subgroup are read off the counter that reported `s`, here and
   * not on the sample, so a baseline object never carries them.
   */
  #writeHdr(c: Connection, s: ObjectSample, lvl: DetailLevel): void {
    const f = c.dispatcher?.fieldsOf(s) ?? null
    const r: HdrRecord = {
      t: 'hdr',
      ts: s.at - this.#origin,
      lvl,
      conn: c.id,
      key: bucketKeyWire(s.key),
      ...(s.streamId !== undefined ? { streamId: s.streamId } : {}),
      group: s.groupId.toString(),
      object: s.objectId.toString(),
      ...(s.status !== undefined ? { status: Number(s.status) } : {}),
      ...(levelIndex(lvl) >= SIZES ? { size: s.payloadBytes } : {}),
      ...(f !== null && f.priority >= 0 ? { priority: f.priority } : {}),
      ...(f !== null && f.subgroupId !== null ? { subgroup: f.subgroupId.toString() } : {}),
    }
    this.#writeRecord(r)
  }

  /** A non-droppable record, written past the halt gate. */
  #writeCritical(r: EnvelopeRecord): void {
    try {
      this.#host.sink.json(r)
    } catch (err) {
      this.#host.onError(err)
    }
  }

  /** The buffer, as its host weighs it, is close to its cap. Droppable types give way. */
  #underPressure(): boolean {
    return this.#host.sink.pendingBytes > 6 * this.#o.config.upload.byteThreshold
  }

  /* ── connection records ───────────────────────────────────────────────── */

  /** Everything known about `c` so far. Sent again whenever that grows. */
  #writeConnOpen(c: Connection, ts?: Mono): void {
    const record: ConnOpenRecord = {
      t: 'conn-open',
      ts: ts ?? this.#relNow(),
      lvl: this.#host.level(),
      conn: c.id,
      realm: this.#o.realm,
      origin: c.origin,
      relay: c.origin,
      ...(c.options !== undefined ? { options: c.options } : {}),
      ...(c.contentId !== '' ? { contentId: c.contentId } : {}),
      draft: c.draft,
      protocol: c.protocol,
      roles: [...c.roles],
      ...(c.degraded !== undefined ? { degraded: c.degraded } : {}),
      ...(c.readyTs !== undefined ? { readyTs: c.readyTs } : {}),
      ...(c.offered !== undefined ? { offered: c.offered } : {}),
    }
    this.#writeCritical(record)
  }

  #close(c: Connection, at: Mono, info: SessionCloseInfo | { cause: ConnCloseCause }): void {
    if (c.closed) return
    c.closed = true
    c.awaitingSetup = false
    // The open interval goes out first, so the close is the connection's last
    // word. Past the halt gate, as the close itself is: the session's end
    // detaches the realm before it closes what is still open, and the interval
    // holds everything since the last tick.
    this.#closing = true
    try {
      c.rollup.tick(at)
    } catch (err) {
      this.#host.onError(err)
    } finally {
      this.#closing = false
    }
    const detail = info as SessionCloseInfo
    const record: ConnCloseRecord = {
      t: 'conn-close',
      ts: at - this.#origin,
      lvl: this.#host.level(),
      conn: c.id,
      cause: info.cause,
      ...(detail.by !== undefined ? { by: detail.by } : {}),
      ...(detail.code !== undefined ? { code: detail.code } : {}),
      ...(detail.reason !== undefined ? { reason: detail.reason } : {}),
      counters: {
        parseFailures: c.rollup.parseFailures,
        bucketsRefused: c.rollup.bucketsRefused,
      },
    }
    this.#writeCritical(record)
    this.#closedParseFailures += c.rollup.parseFailures
    this.#closedBucketsRefused += c.rollup.bucketsRefused
    this.#connections.delete(c.id)
    this.#closed.push({ ...this.#stateOf(c), closeCause: info.cause })
    // Bounded: a page that reconnects all day keeps the newest closed ones.
    if (this.#closed.length > 64) this.#closed.shift()
  }

  #stateOf(c: Connection): ConnectionState {
    return {
      id: c.id,
      realm: this.#o.realm,
      origin: c.origin,
      draft: c.draft,
      ...(c.contentId !== '' ? { contentId: c.contentId } : {}),
      state: c.closed
        ? 'closed'
        : c.dispatcher !== null || c.degraded !== undefined
          ? 'open'
          : 'connecting',
    }
  }

  /* ── overrun ──────────────────────────────────────────────────────────── */

  /**
   * Control-plane rate, in a one-second window.
   *
   * "If even the non-droppable types cannot be kept up with — a fuzzing
   * peer, a relay flapping thousands of streams — **stop collecting rather than
   * degrade.**" Control frames are the non-droppable type with an unbounded
   * arrival rate, so they are the signal.
   */
  #noteControlFrame(at: Mono): void {
    if (at - this.#ctrlWindowStart >= 1000) {
      this.#ctrlWindowStart = at
      this.#ctrlInWindow = 0
      this.#objectsInWindow = 0
    }
    this.#ctrlInWindow += 1
    const limit = this.#o.config.limits.controlRatePerSec
    if (this.#halted || this.#ctrlInWindow <= limit) return
    this.#overrunAt = at
    this.#overrunSignal = `control-plane rate exceeded ${limit}/s`
    this.detach()
    this.#host.onOverrun(at, this.#overrunSignal)
  }

  /* ── draft loading ────────────────────────────────────────────────────── */

  /**
   * Read the SETUP frame a pre-15 control stream opens with: the draft, from
   * SERVER_SETUP or from a CLIENT_SETUP offering one version, and the offered
   * drafts from CLIENT_SETUP.
   *
   * Only for `moq-00` sessions, where the ALPN names eight drafts at once. Only
   * the **first** chunk of each control-stream half is read: SETUP is the first
   * message on the stream, so a match anywhere else would be a coincidence and
   * not a handshake.
   */
  #probeSetup(c: Connection, chunk: StreamChunk): void {
    const offer = !c.offerProbed && chunk.direction === 'tx'
    if (!c.awaitingSetup && !offer) return
    const half = `${chunk.streamId}/${chunk.direction}`
    if (c.probedStreams.has(half)) return
    c.probedStreams.add(half)
    if (offer) c.offerProbed = true
    const f = readSetupFrame(chunk.data)
    if (f === undefined) return
    if (offer && !f.server) c.offered = offeredOf(f.versions, draftNumberOfVersion)
    if (c.awaitingSetup) {
      // SERVER_SETUP's version is the selected one, and so is a CLIENT_SETUP's
      // when it offers exactly one.
      const draft = f.versions.length === 1 ? draftOfVersion(f.versions[0] as bigint) : undefined
      if (draft !== undefined) {
        c.awaitingSetup = false
        this.#attachDraft(c, LEGACY_PROTOCOL, draft)
        return
      }
      if (f.server) {
        // The server selected a version this build has no decoder for.
        this.#giveUp(c, 'unsupported-protocol')
        return
      }
    }
    if (offer && c.offered !== undefined) this.#writeConnOpen(c)
  }

  /**
   * The loud failure. The adapter is withheld entirely — two incompatible
   * varint families disagree on the same bytes and return plausible wrong
   * numbers — so the connection degrades to transport-only metrics and the raw
   * control bytes it already shipped. The pending buffer is released rather
   * than held: nothing will ever parse it.
   */
  #giveUp(c: Connection, reason: NonNullable<ConnOpenRecord['degraded']>): void {
    c.awaitingSetup = false
    c.degraded = reason
    c.pending = []
    c.pendingBytes = 0
    c.pendingDatagrams = []
    this.#writeConnOpen(c)
    this.#host.onConnReady()
  }

  #attachDraft(c: Connection, protocol: string, known?: SupportedDraft): void {
    const result = resolveDraft(this.#o.drafts, protocol, known)
    if (c.closed || this.#halted) return
    if (!result.ok) {
      this.#giveUp(c, degradedReasonOf(result.reason))
      return
    }
    c.adapter = result.adapter
    c.draft = result.draft
    c.dispatcher = new StreamDispatcher(result.adapter, c.keys, c.sink, {
      slackBytes: this.#o.config.limits.maxHeaderSlackBytes,
      maskAuthParams: this.#o.config.privacy.maskAuthParams,
    })
    const pending = c.pending
    const datagrams = c.pendingDatagrams
    c.pending = []
    c.pendingBytes = 0
    c.pendingDatagrams = []
    this.#writeConnOpen(c)
    this.#host.onConnReady()
    // Replay in arrival order. The chunks were copied on the way in, so nothing
    // here is a view onto a page buffer the player has since rewritten.
    for (const chunk of pending) c.dispatcher.onStreamData(chunk)
    for (const d of datagrams) c.dispatcher.onDatagram(d)
  }

  #bufferPending(c: Connection, chunk: StreamChunk): void {
    const cap = this.#o.config.limits.dormantRingBytes
    if (c.pendingBytes + chunk.data.byteLength > cap) {
      if (c.awaitingSetup) {
        // The pre-draft buffer filled and SETUP never named a version. Waiting
        // longer costs memory for a connection that will not be parsed, so this
        // is where a `moq-00` connection gives up — reported as unsupported,
        // which is what it is: MoQT of some version this build could not
        // identify.
        this.#giveUp(c, 'unsupported-protocol')
        return
      }
      // Counted, not silently truncated: a connection that lost its opening
      // seconds says so rather than looking like a short one.
      this.#droppedRecords += 1
      this.#sampledTypes.add('pre-draft-bytes')
      return
    }
    c.pendingBytes += chunk.data.byteLength
    c.pending.push({ ...chunk, data: chunk.data.slice() })
  }

  /* ── the ring and the triggers ────────────────────────────────────────── */

  /**
   * The ring is filled only while the recorder is armed.
   *
   * Armed is "ring overwriting in memory ... nothing parsed, nothing
   * produced, nothing sent". Disarmed it is not a cheaper ring, it is no ring:
   * a session with no triggers configured — the default, since automated mode
   * ships off — pays neither the memory nor the per-chunk copy.
   */
  #armed(): boolean {
    const t = this.#o.config.flightRecorder.triggers
    return t.stall !== undefined || t.cadence !== undefined
  }

  #depthBytes(): number {
    try {
      return parseByteDepth(this.#o.config.flightRecorder.depth)
    } catch (err) {
      this.#host.onError(err)
      return parseByteDepth('32MB')
    }
  }

  /**
   * Replay the control plane the dormant hook held for each connection the
   * observer was just handed, in arrival order, so every decoder starts at
   * the beginning of its control streams.
   *
   * A connection missing here was refused by the transport cap; its bytes
   * have nowhere to go. The skipped halves are installed after the replay,
   * because a cut control stream's held prefix is itself on one of them.
   */
  #adoptEarly(early: ReadonlyMap<string, EarlyConnection>): void {
    for (const [id, e] of early) {
      const conn = this.#connections.get(id)
      if (conn === undefined) continue
      for (const chunk of e.control) {
        try {
          this.onStreamData(chunk)
        } catch (err) {
          this.#host.onError(err)
        }
      }
      for (const half of e.skip) conn.skip.add(half)
      if (e.dropped > 0) {
        this.#droppedRecords += e.dropped
        this.#sampledTypes.add(EARLY_CONTROL)
      }
      this.#countEarlyData(conn, e.dataChunks, e.dataBytes)
    }
  }

  /** A chunk on a half that began before this realm attached. */
  #skipEarly(conn: Connection, control: boolean, bytes: number): void {
    if (control) {
      this.#droppedRecords += 1
      this.#sampledTypes.add(EARLY_CONTROL)
      return
    }
    this.#countEarlyData(conn, 1, bytes)
  }

  /** Object data this realm saw but could not decode, on the connection's rollup. */
  #countEarlyData(conn: Connection, chunks: number, bytes: number): void {
    if (chunks === 0) return
    conn.rollup.count('early.dataChunks', chunks)
    conn.rollup.count('early.dataBytes', bytes)
  }

  #adoptDormantRing(entries: readonly RingEntry[]): void {
    for (const e of entries) {
      this.#ring.push({
        sessionId: e.sessionId,
        streamId: e.streamId,
        dir: e.dir,
        control: e.control,
        atMono: e.atMono,
        data: e.data,
      })
    }
  }

  #onTriggerFired(e: TriggerEvent): void {
    if (this.#halted) return
    // Order is load-bearing: the trigger opens a billable capture window
    // and "the pre-trigger dump is that window's first record". Raise first so
    // the dump is stamped at the window's level, then fire.
    this.#host.onTrigger(e)
    this.#recorder.fire(e)
  }

  /** The connection whose decoder minted `k`; the newest one with a draft when there is no key. */
  #connectionFor(k: BucketKey | undefined): Connection | undefined {
    let fallback: Connection | undefined
    for (const c of this.#connections.values()) {
      if (k !== undefined && c.rollup.owns(k)) return c
      if (c.adapter !== undefined) fallback = c
    }
    return fallback
  }

  #rollupOwning(k: BucketKey): RollupEngine | undefined {
    for (const c of this.#connections.values()) if (c.rollup.owns(k)) return c.rollup
    return undefined
  }

  #relNow(): Mono {
    return this.#o.clock.now() - this.#origin
  }

  /**
   * Every observer method, wrapped.
   *
   * `types.ts`: "Every method must also be total: a throw here lands in the
   * page's own stack." The hook wraps calls too and routes failures to
   * `onInternalError`, so this is the second of two locks on the same door — and
   * the cheap one, since it costs a closure per install rather than anything per
   * chunk.
   */
  #guarded(): TransportObserver {
    const wrap = <A extends unknown[]>(f: (...a: A) => void) => {
      return (...a: A): void => {
        try {
          f.apply(this, a)
        } catch (err) {
          this.#host.onError(err)
        }
      }
    }
    return {
      onSessionOpen: wrap(this.onSessionOpen),
      onSessionProtocol: wrap(this.onSessionProtocol),
      onSessionClose: wrap(this.onSessionClose),
      onStreamData: wrap(this.onStreamData),
      onStreamClose: wrap(this.onStreamClose),
      onStreamError: wrap(this.onStreamError),
      onStreamReset: wrap(this.onStreamReset),
      onDatagram: wrap(this.onDatagram),
      onWriterPressure: wrap(this.onWriterPressure),
      onSendStats: wrap(this.onSendStats),
    }
  }
}

/** Drop closed entries, oldest first; if none are closed, drop the oldest. */
function sweepAcks(conn: Connection): void {
  for (const [id, a] of conn.ackedByStream) {
    if (a.closed) conn.ackedByStream.delete(id)
  }
  if (conn.ackedByStream.size < MAX_ACK_STREAMS) return
  const oldest = conn.ackedByStream.keys().next()
  if (!oldest.done) conn.ackedByStream.delete(oldest.value)
}
