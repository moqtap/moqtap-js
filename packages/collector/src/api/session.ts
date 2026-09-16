/**
 * The wiring. Every other module meets here and nowhere else.
 *
 * Three rules govern everything below.
 *
 * **1. The seam is a bounded enqueue and nothing else.** `types.ts` states the
 * contract: "every method runs synchronously on the page's own data path —
 * `onStreamData` fires *before* the page's write reaches the transport". So the
 * observer methods here copy, count and return: no `await`, no allocation of a
 * record, no compression, no storage call, and no timer started on that thread
 * of control.
 *
 * **2. Nothing throws into the page.** Every observer method is wrapped, and
 * every failure goes to `CollectorConfig.onInternalError`.
 *
 * **3. The overrun policy is a state, not a degradation.** Control frames and
 * the setup, terminal and escalation records are **non-droppable**; per-object
 * detail is droppable. When even the non-droppable set cannot be kept up with,
 * the runtime closes the segment, emits a terminal record with the counters and
 * stops — while still releasing the already-keyed backlog.
 */

import { StreamDispatcher, TrackKeys } from '../decode/index.js'
import {
  degradedReasonOf,
  draftOfSetupFrame,
  LEGACY_PROTOCOL,
  loadDraft,
  loadDraftNumber,
  preloadDrafts,
} from '../draft/index.js'
import {
  type Chunk,
  type ChunkStore,
  deadlineSignal,
  FlushQueue,
  FlushSchedule,
  ReleasePacer,
  sendTail,
  Uploader,
} from '../flush/index.js'
import { FlightRecorder, TriggerEngine, type TriggerEvent } from '../recorder/index.js'
import { ByteRing, parseByteDepth, type RingEntry } from '../ring/index.js'
import { CustomMetrics, RollupEngine } from '../rollup/index.js'
import type { TransportHook } from '../transport/index.js'
import type {
  BucketKey,
  ClockAnchor,
  ClockSource,
  ControlFrameEvent,
  DatagramChunk,
  DetailLevel,
  DraftAdapter,
  EnvelopeRecord,
  ExchangeKind,
  Identity,
  InterceptedSession,
  Mono,
  ObjectSample,
  ParseFailureReason,
  RecordSink,
  RecordType,
  ResolvedConfig,
  SealReason,
  SetupRecord,
  StreamChunk,
  SupportedDraft,
  TerminalRecord,
  TransportObserver,
  UsageReport,
  WriterPressure,
} from '../types.js'
import { COLLECTOR_VERSION } from '../version.js'
import { DORMANT_DATAGRAM_STREAM_ID, drainDormant } from './dormant.js'
import { EscalationController } from './escalation.js'
import { UsageMeter } from './meter.js'

/** Re-exported for the public API; defined in `../version.js` so the dormant
 * path can read it without pulling this module in. */
export { COLLECTOR_VERSION }

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
 *  - `setup`, `terminal` and `escalation` are **non-droppable**: one per
 *    session, or one per level change — dropping them saves nothing.
 *  - `rollup` is **non-droppable**: already O(1) per interval, and its counters
 *    are cumulative, so a dropped one is a hole in a total rather than a missing
 *    sample.
 *  - `hdr`, `flight` and `note` are **droppable**: per-object detail and
 *    customer annotations, each of which is one of many.
 */
const DROPPABLE: ReadonlySet<RecordType> = new Set<RecordType>(['hdr', 'flight', 'note'])

/** Ports the runtime needs and does not create, so the suite can supply its own. */
export interface RuntimePorts {
  readonly clock?: ClockSource
  readonly fetchImpl?: typeof fetch
  readonly store?: ChunkStore | null
  readonly setTimer?: (fn: () => void, ms: number) => unknown
  readonly clearTimer?: (h: unknown) => void
  /** Injected so a test can drive the beacon without a DOM. */
  readonly beacon?: (url: string, data: Blob) => boolean
  /** Skip the `pagehide` listener; the suite installs none. */
  readonly noLifecycleListeners?: boolean
  /** `CollectorConfig.onInternalError`, which `ResolvedConfig` deliberately omits. */
  readonly onInternalError?: (err: unknown) => void
}

interface Connection {
  readonly id: string
  readonly session: InterceptedSession
  keys: TrackKeys
  dispatcher: StreamDispatcher | null
  adapter: DraftAdapter | undefined
  /** The raw buffer, held across the dynamic-import await. Bounded in bytes. */
  pending: StreamChunk[]
  pendingBytes: number
  pendingDatagrams: DatagramChunk[]
  closed: boolean
  /**
   * The session negotiated `moq-00`, so the draft is still unknown and is being
   * looked for in the handshake.
   *
   * Set only for the eight drafts before -15, which share that one ALPN. Cleared
   * the moment SETUP names a version, or when the pre-draft buffer fills — see
   * `#probeLegacyDraft`.
   */
  awaitingSetup: boolean
  /**
   * Stream ids already offered to the setup probe, so each is tried once.
   *
   * SETUP is the first message on the control stream, so only a stream's first
   * chunk can carry it. Without this the probe would re-run on every buffered
   * chunk of a stream it has already declined.
   */
  probedStreams: Set<number>
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

/**
 * How many send streams may hold ack state at once.
 *
 * A closed stream's entry is dropped as soon as its final reading lands, so
 * this only bounds the pathological case: a stream aborted between its last
 * probe and a reading that never comes. Closed entries are swept first, and
 * insertion order makes the sweep the oldest ones.
 */
const MAX_ACK_STREAMS = 256

const platformClock: ClockSource = { now: () => performance.now(), wall: () => Date.now() }

/**
 * One collector. Owns every other module's instance and every timer.
 *
 * A single logical session (`config.sessionId`) that may span several
 * transports; each intercepted `WebTransport` is one *connection*, and a
 * reconnect makes a new one.
 */
export class CollectorRuntime implements TransportObserver {
  readonly config: ResolvedConfig
  readonly anchor: ClockAnchor

  readonly #clock: ClockSource
  readonly #ports: RuntimePorts
  readonly #onError: (err: unknown) => void
  readonly #hook: TransportHook

  readonly #ring: ByteRing
  readonly #rollup: RollupEngine
  readonly #custom: CustomMetrics
  readonly #queue: FlushQueue
  readonly #schedule: FlushSchedule
  readonly #pacer: ReleasePacer
  readonly #uploader: Uploader
  readonly #recorder: FlightRecorder
  readonly #triggers: TriggerEngine
  readonly #meter: UsageMeter
  readonly #escalation: EscalationController
  readonly #store: ChunkStore | null

  readonly #connections = new Map<string, Connection>()
  #connectionId: string
  #lastAdapter: DraftAdapter | undefined
  #lastKeys: TrackKeys | undefined
  #draft: SupportedDraft | null = null
  #protocol: string | null = null
  #degraded: SetupRecord['degraded'] | undefined
  #roles = new Set<'publisher' | 'subscriber'>()

  #setupSent = false
  #terminalSent = false
  #stopped = false
  #aborted = false
  #overrun = false
  #overrunAt: Mono | undefined
  #overrunSignal: string | undefined
  #partialExpected = false
  #partialLinked = false

  #outbox: Chunk[] = []
  #pumping = false
  #intervalHandle: unknown
  /** The one-shot timer landing the post-event timeout on time. See `#scheduleWindowClose`. */
  #windowHandle: unknown
  #ctrlWindowStart = 0
  #ctrlInWindow = 0
  #objectsInWindow = 0
  #droppedRecords = 0
  #sampledTypes = new Set<string>()
  #transportsRefused = 0
  #onPagehide: (() => void) | undefined

  constructor(config: ResolvedConfig, hook: TransportHook, ports: RuntimePorts = {}) {
    this.config = config
    this.#ports = ports
    this.#hook = hook
    this.#clock = ports.clock ?? platformClock
    this.#onError = (err: unknown): void => {
      try {
        ports.onInternalError?.(err)
      } catch {
        // An error handler that throws is where reporting stops.
      }
    }
    this.anchor = { originMono: this.#clock.now(), originWall: this.#clock.wall() }
    this.#connectionId = `${config.sessionId}#0`

    // The clock every record is stamped with is already session-relative: the
    // flush queue's docs require `now()` to be anchor-relative and nothing
    // downstream re-bases it.
    const relClock: ClockSource = {
      now: () => this.#clock.now() - this.anchor.originMono,
      wall: () => this.#clock.wall(),
    }

    this.#meter = new UsageMeter(this.#clock)
    this.#store = ports.store ?? null

    this.#queue = new FlushQueue({
      sessionId: config.sessionId,
      store: this.#store,
      clock: relClock,
      level: () => this.#escalation.level,
      maxPendingBytes: 8 * config.upload.byteThreshold,
      onInternalError: this.#onError,
    })

    this.#custom = new CustomMetrics({ onError: (m) => this.#onError(new Error(m)) })
    this.#rollup = new RollupEngine({
      intervalMs: config.metrics.intervalMs,
      maxBuckets: config.metrics.maxTracks,
      clock: this.#clock,
      sink: this.#sink,
      originMono: this.anchor.originMono,
      custom: this.#custom,
    })

    this.#ring = new ByteRing({ maxBytes: this.#depthBytes() })
    this.#recorder = new FlightRecorder({
      ring: this.#ring,
      sink: this.#sink,
      adapter: () => this.#lastAdapter,
      keys: () => this.#lastKeys,
      level: () => this.#escalation.level,
      originMono: this.anchor.originMono,
    })
    this.#triggers = new TriggerEngine({
      config: config.flightRecorder.triggers,
      medians: this.#rollup,
      onFire: (e) => this.#onTriggerFired(e),
    })

    this.#escalation = new EscalationController({
      configured: config.detail,
      ceilingMinutes: config.budget.elevatedMinutes,
      windowMs: config.flightRecorder.windowMs,
      meter: this.#meter,
      clock: this.#clock,
      anchor: this.anchor,
      sink: this.#sink,
      // the "the ring filling" close condition. The ring is only written to
      // while the recorder is armed (see `#armed`), so on a session with no
      // triggers configured — the default — this never advances and never
      // closes anything.
      ring: {
        capacityBytes: this.#ring.maxBytes,
        evictedBytes: () => this.#ring.evictedBytes,
      },
      onWindowOpen: (deadline) => this.#scheduleWindowClose(deadline),
    })

    this.#uploader = new Uploader({
      endpoint: config.endpoint,
      apiKey: config.apiKey,
      maxAttempts: config.upload.maxAttempts,
      // `fetch` has no timeout, so without this one blackholed request
      // is pending for the life of the page — and `#pumping` with it, which
      // wedges every later drain too.
      timeoutMs: config.upload.timeoutMs,
      ...(ports.fetchImpl !== undefined ? { fetchImpl: ports.fetchImpl } : {}),
      onInternalError: this.#onError,
    })
    this.#pacer = new ReleasePacer({
      // The pacer shapes only the DELAY between releases; it can never seal
      // less often. The bounds are this module's own: the floor is "as
      // fast as the loop can go" and the ceiling is one flush interval, so a
      // fully congested session still releases roughly as often as it seals and
      // the backlog cannot grow without bound.
      minIntervalMs: 0,
      maxIntervalMs: config.upload.intervalMs,
    })
    this.#schedule = new FlushSchedule({
      onFlush: (r) => {
        void this.#flush(r)
      },
      byteThreshold: config.upload.byteThreshold,
      earlyFlushesMs: config.upload.earlyFlushesMs,
      intervalMs: config.upload.intervalMs,
      ...(ports.setTimer !== undefined && ports.clearTimer !== undefined
        ? { timers: { setTimer: ports.setTimer, clearTimer: ports.clearTimer } }
        : {}),
      onInternalError: this.#onError,
    })
  }

  /* ── startup ──────────────────────────────────────────────────────────── */

  /**
   * Take over from the dormant hook and start the schedule.
   *
   * Order matters. The pin is preloaded first ("Present => eager, no dynamic
   * import at session time"), then the dormant ring's pre-key bytes are moved
   * into this collector's own ring, and only then does the observer go live —
   * so no byte arrives at a dispatcher before the ring it may be replayed from
   * is populated.
   */
  start(): void {
    void preloadDrafts(this.config.drafts.length > 0 ? this.config.drafts : undefined)

    const dormant = drainDormant()
    if (this.#armed()) {
      // The ring claims its memory here and nowhere else. At the default depth
      // that is 32 MiB, and every `#ring.push` site is behind `#armed()` — so a
      // ring built for a session with no trigger configured would be held and
      // never written to. Reserving here also keeps the allocation off the data
      // path: the alternative, letting the first chunk claim it, would put a
      // 32 MiB allocation on the page's own write path.
      this.#ring.reserve()
      this.#adoptDormantRing(dormant.entries)
    }
    this.#recorder.arm(this.config.flightRecorder.triggers)

    // `setObserver` replays every session that was already open, `onSessionOpen`
    // first and then the negotiated protocol — which is the ordinary case on a
    // page that connects at load and calls `init()` after its own bootstrap.
    this.#hook.setObserver(this.#guarded())

    this.#schedule.start(this.#clock.now())
    this.#startInterval()
    this.#installLifecycle()
    void this.#adoptBacklog()
  }

  /* ── the public verbs ─────────────────────────────────────────────────── */

  ids(): Identity {
    const id: {
      actorId?: string
      sessionId: string
      connectionId: string
      contentId?: string
    } = { sessionId: this.config.sessionId, connectionId: this.#connectionId }
    if (this.config.context.actorId !== '') id.actorId = this.config.context.actorId
    if (this.config.context.contentId !== '') id.contentId = this.config.context.contentId
    return id
  }

  usage(): UsageReport {
    return this.#meter.report()
  }

  escalate(level: DetailLevel, reason?: string): void {
    if (this.#stopped || this.#aborted) return
    this.#escalation.escalate(level, reason)
  }

  /**
   * The incident is over. Closes the open capture window.
   *
   * Harmless when none is open, because this is called from the customer's own
   * error handling and will be called for incidents that never escalated.
   */
  resolve(reason?: string): void {
    if (this.#stopped || this.#aborted) return
    this.#escalation.resolve(reason)
  }

  annotate(name: string, data: unknown): void {
    if (this.#stopped || this.#aborted || this.#overrun) return
    this.#sink.json({
      t: 'note',
      ts: this.#relNow(),
      lvl: this.#escalation.level,
      name: String(name),
      data,
    })
  }

  defineMetric(name: string, d: Parameters<CustomMetrics['defineMetric']>[1]): void {
    this.#custom.defineMetric(name, d)
  }

  observe(name: string, value: number, labels?: Record<string, string>): void {
    if (labels === undefined) this.#custom.observe(name, value)
    else this.#custom.observe(name, value, labels)
  }

  /** A worker was expected. Until it handshakes the session is `partial`. */
  expectWorker(): void {
    this.#partialExpected = true
  }

  /** The worker handshook. The session is complete again. */
  noteWorkerLinked(): void {
    this.#partialLinked = true
  }

  /**
   * Flush what is buffered, then tear down.
   *
   * Clears **only what it successfully sent**. An ordinary `stop()` while
   * offline would flush (fail), then clear — destroying precisely the durability
   * IndexedDB exists for, and the backlog is largest exactly when the session is
   * most worth having. So a failed upload here leaves its chunk persisted for
   * the next page load, and only `abort()` clears unconditionally.
   */
  async stop(): Promise<void> {
    if (this.#stopped || this.#aborted) return
    this.#stopped = true
    this.#detach()
    this.#escalation.close()
    this.#tickRollup()
    this.#emitTerminal('stop')
    // The page awaits this promise inside its own teardown, so the drain
    // gets a deadline and `stop()` resolves whether or not ingest ever answers.
    // One signal, threaded into every `Uploader.send` below it, rather than a
    // timer racing the drain: a race would resolve `stop()` while an upload
    // carried on in the background, which is the same hang with the evidence
    // removed. On expiry the chunk is still queued and still persisted — which
    // is exactly what the store exists for — so the next page load sends it.
    const deadline = deadlineSignal(this.config.upload.stopDrainDeadlineMs)
    try {
      await this.#flush('stop')
      await this.#drainOutbox({ paced: false, signal: deadline.signal })
    } finally {
      deadline.clear()
    }
    await this.#teardown()
  }

  /**
   * Drop what is buffered, then tear down. **Transmits nothing.**
   *
   * The verb to call when the reason for stopping is that you no longer want the
   * data to leave the device: a consent withdrawal, an opt-out, a test fixture.
   * The detach happens on the first line, before any await, so nothing can be
   * sealed or sent while the teardown is in flight.
   *
   * No terminal record is emitted: `TerminalRecord.reason` has an `'abort'`
   * member, but sending one would be a transmission, and after either verb the
   * collector transmits nothing further for that session.
   */
  async abort(): Promise<void> {
    if (this.#aborted) return
    this.#aborted = true
    this.#stopped = true
    this.#detach()
    this.#outbox = []
    this.#ring.clear()
    if (this.#store !== null) {
      try {
        await this.#store.clearSession(this.config.sessionId)
      } catch (err) {
        this.#onError(err)
      }
    }
    await this.#teardown()
  }

  /* ── TransportObserver — every method runs on the page's data path ────── */

  onSessionOpen(s: InterceptedSession): void {
    if (this.#halted()) return
    if (this.#connections.size >= this.config.limits.maxConcurrentTransports) {
      // "Cap concurrent transports at 8: real clients are genuinely
      // bounded there, so the cap only ever fires on something wrong." Counted,
      // never silent (rule 2). Cumulative is deliberately uncapped.
      this.#transportsRefused += 1
      return
    }
    this.#connections.set(s.id, {
      id: s.id,
      session: s,
      keys: new TrackKeys({ maxBuckets: this.config.metrics.maxTracks }),
      dispatcher: null,
      adapter: undefined,
      pending: [],
      pendingBytes: 0,
      pendingDatagrams: [],
      closed: false,
      awaitingSetup: false,
      probedStreams: new Set(),
      ackedByStream: new Map(),
    })
    // One transport within the session. A reconnect makes a new one.
    this.#connectionId = s.id
  }

  onSessionProtocol(sessionId: string, protocol: string): void {
    const c = this.#connections.get(sessionId)
    if (c === undefined || c.dispatcher !== null) return
    this.#protocol = protocol
    if (protocol === LEGACY_PROTOCOL) {
      // Every draft before -15 negotiates `moq-00`, so the ALPN has told us the
      // family and not the draft. Keep buffering and read the selected version
      // out of the handshake instead — `#probeLegacyDraft`, from the control
      // chunks that were going to be buffered anyway.
      c.awaitingSetup = true
      return
    }
    void this.#attachDraft(c, protocol)
  }

  onSessionClose(sessionId: string): void {
    const c = this.#connections.get(sessionId)
    if (c === undefined) return
    c.closed = true
    this.#connections.delete(sessionId)
  }

  onStreamData(c: StreamChunk): void {
    if (this.#halted()) return
    // Control bytes are deliberately NOT ringed: a token would sit in memory.
    //
    // The replay skips every control entry it finds (`recorder/replay.ts`) and
    // baseline already ships every control frame's exact bytes through the
    // framer, so a ringed copy would have no consumer. And a chunk arriving here
    // is not frame-aligned, so masking it here would mean a second
    // frame-aligned parser at the seam, while leaving it unmasked would mean the
    // one place in the collector where a bearer token sits in memory in the
    // clear.
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
    const d = conn.dispatcher
    if (d !== null) {
      d.onStreamData(c)
      return
    }
    // The draft chunk has not landed. Buffer raw, bounded — the spec
    // mandates the buffering and gives it no bound at all, and an unbounded one
    // behind a chunk that never resolves (offline, a 404, a CSP refusal) is a
    // page-killing leak.
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
        if (conn.ackedByStream.size >= MAX_ACK_STREAMS) this.#sweepAcks(conn)
        conn.ackedByStream.set(streamId, { last: 0, key, closed: true })
      }
    }
    conn.dispatcher?.onStreamClose(streamId)
  }

  onStreamError(_sessionId: string, _streamId: number, error: unknown): void {
    this.#onError(error)
  }

  onDatagram(c: DatagramChunk): void {
    if (this.#halted()) return
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
    if (this.#halted()) return
    this.#rollup.observeWriterReady(p.readyLatencyMs)
    // And again against the track, when the stream has one. `writer.ready` can
    // resolve before the page has written the subgroup header that names the
    // alias, so an unattributed episode is ordinary rather than a fault: it is
    // in the session histogram above either way, which is what keeps that
    // number a true total.
    const key = this.#connections.get(p.sessionId)?.dispatcher?.trackForStream(p.streamId, 'tx')
    if (key != null) this.#rollup.observeWriterBlocked(key, p.readyLatencyMs, p.at)
    // Object arrival rate is the pacer's pressure signal; a publish-only
    // session has no arriving objects, so `writer.ready` latency is this
    // package's fallback for it — a choice the spec does not make and nothing
    // has validated.
    this.#pacer.notePressure({
      objectsPerSec: this.#objectRate(),
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
    if (this.#halted()) return
    if (!Number.isFinite(bytesAcknowledged) || bytesAcknowledged < 0) return
    const conn = this.#connections.get(sessionId)
    if (conn === undefined) return

    let acks = conn.ackedByStream.get(streamId)
    if (acks === undefined) {
      if (conn.ackedByStream.size >= MAX_ACK_STREAMS) this.#sweepAcks(conn)
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
        this.#rollup.observeAckedBytes(acks.key, delta, at)
      }
    }
    // A closed stream's reading is its last, so the entry has done its job.
    if (acks.closed) conn.ackedByStream.delete(streamId)
  }

  /** Drop closed entries, oldest first; if none are closed, drop the oldest. */
  #sweepAcks(conn: Connection): void {
    for (const [id, a] of conn.ackedByStream) {
      if (a.closed) conn.ackedByStream.delete(id)
    }
    if (conn.ackedByStream.size < MAX_ACK_STREAMS) return
    const oldest = conn.ackedByStream.keys().next()
    if (!oldest.done) conn.ackedByStream.delete(oldest.value)
  }

  /* ── the sink the rollup and the recorder write into ──────────────────── */

  /**
   * The gate, and the only path from a record to the wire.
   *
   * A `raw` frame is unreadable without the JSON record that names it and the
   * two must never straddle a body, so `raw` follows the fate of the record
   * before it: `#skipRaw` is set when a JSON record is dropped and the next
   * `raw` is dropped with it.
   */
  readonly #sink: RecordSink & {
    onObject(s: ObjectSample): void
    onControlFrame(e: ControlFrameEvent): void
    onParseFailure(k: BucketKey | null, r: ParseFailureReason): void
    observeControlLatency(k: ExchangeKind, ms: number): void
    markShared(k: BucketKey): void
  } = {
    json: (r: EnvelopeRecord): void => this.#writeRecord(r),
    raw: (b: Uint8Array): void => {
      if (this.#halted() || this.#skipRaw) {
        this.#skipRaw = false
        return
      }
      try {
        this.#queue.raw(b)
        this.#schedule.noteBytes(b.byteLength)
      } catch (err) {
        this.#onError(err)
      }
    },
    onObject: (s: ObjectSample): void => {
      this.#objectsInWindow += 1
      this.#roles.add(s.key.dir === 'tx' ? 'publisher' : 'subscriber')
      this.#rollup.onObject(s)
      this.#triggers.onObject(s)
    },
    onControlFrame: (e: ControlFrameEvent): void => {
      this.#noteControlFrame(e.at)
      if (this.#overrun) return
      this.#rollup.onControlFrame(e)
    },
    onParseFailure: (k: BucketKey | null, r: ParseFailureReason): void => {
      this.#rollup.onParseFailure(k, r)
    },
    observeControlLatency: (k: ExchangeKind, ms: number): void => {
      this.#rollup.observeControlLatency(k, ms)
    },
    markShared: (k: BucketKey): void => {
      this.#rollup.markShared(k)
    },
  }

  #skipRaw = false

  #writeRecord(r: EnvelopeRecord): void {
    if (this.#halted()) {
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
      const before = this.#queue.pendingBytes
      this.#queue.json(r)
      this.#schedule.noteBytes(Math.max(0, this.#queue.pendingBytes - before))
      this.#skipRaw = false
    } catch (err) {
      this.#onError(err)
      this.#skipRaw = true
    }
  }

  /** The flush buffer is close to its own hard cap. Droppable types give way. */
  #underPressure(): boolean {
    return this.#queue.pendingBytes > 6 * this.config.upload.byteThreshold
  }

  /* ── overrun ──────────────────────────────────────────────────────────── */

  /**
   * Control-plane rate, in a one-second window.
   *
   * "If even the non-droppable types cannot be kept up with — a fuzzing
   * peer, a relay flapping thousands of streams — **stop collecting rather than
   * degrade.** Close the segment, emit a terminal record carrying the counters,
   * and send nothing further for that session." Control frames are the
   * non-droppable type with an unbounded arrival rate, so they are the signal.
   */
  #noteControlFrame(at: Mono): void {
    if (at - this.#ctrlWindowStart >= 1000) {
      this.#ctrlWindowStart = at
      this.#ctrlInWindow = 0
      this.#objectsInWindow = 0
    }
    this.#ctrlInWindow += 1
    if (this.#overrun || this.#ctrlInWindow <= this.config.limits.controlRatePerSec) return
    this.#overrun = true
    this.#overrunAt = at
    this.#overrunSignal = `control-plane rate exceeded ${this.config.limits.controlRatePerSec}/s`
    // The terminal record and the final seal are the last things this session
    // produces. The already-keyed backlog still goes out: those chunks are paid
    // for and honest, and the objection is to *continuing*, not to what was
    // already recorded.
    this.#detach()
    this.#emitTerminal('overrun')
    void this.#flush('terminal').then(() => this.#drainOutbox({ paced: true }))
  }

  #objectRate(): number {
    return this.#objectsInWindow
  }

  /* ── draft loading ───────────────────────────────────── */

  /**
   * Try to read the negotiated draft out of a buffered control chunk.
   *
   * Only for `moq-00` sessions, where the ALPN names eight drafts at once. Only
   * the **first** chunk of each control stream is offered: SETUP is the first
   * message on the stream, so a match anywhere else would be a coincidence and
   * not a handshake.
   *
   * Costs one call per control stream per session and nothing at all on
   * draft-15+, where `awaitingSetup` is never set.
   */
  #probeLegacyDraft(c: Connection, chunk: StreamChunk): void {
    if (!c.awaitingSetup || !chunk.control) return
    if (c.probedStreams.has(chunk.streamId)) return
    c.probedStreams.add(chunk.streamId)
    const draft = draftOfSetupFrame(chunk.data)
    if (draft === undefined) return
    c.awaitingSetup = false
    void this.#attachDraft(c, LEGACY_PROTOCOL, draft)
  }

  async #attachDraft(c: Connection, protocol: string, known?: SupportedDraft): Promise<void> {
    const opts = {
      ...(this.config.drafts.length > 0 ? { pin: this.config.drafts } : {}),
    }
    // `known` is the version the peer's own SETUP frame named, for the eight
    // drafts whose ALPN cannot say. It is evidence off the wire, not a
    // preference — see `loadDraftNumber`.
    const result =
      known === undefined
        ? await loadDraft(protocol, opts)
        : await loadDraftNumber(known, protocol, opts)
    if (c.closed || this.#halted()) return
    if (!result.ok || result.adapter === undefined || result.draft === undefined) {
      // the loud failure. The adapter is withheld entirely — two incompatible
      // varint families disagree on the same bytes and return plausible wrong
      // numbers — so the session degrades to transport-only metrics and the raw
      // control bytes it already shipped. The pending buffer is released rather
      // than held: nothing will ever parse it.
      this.#degraded = degradedReasonOf(result.reason ?? 'import-failed')
      c.pending = []
      c.pendingBytes = 0
      c.pendingDatagrams = []
      // the loud failure has to reach ingest, and `SetupRecord.degraded` is
      // where it lands — so the record goes out now rather than at teardown.
      this.#ensureSetup()
      return
    }
    c.adapter = result.adapter
    this.#lastAdapter = result.adapter
    this.#lastKeys = c.keys
    this.#draft = result.draft
    c.dispatcher = new StreamDispatcher(result.adapter, c.keys, this.#sink, {
      slackBytes: this.config.limits.maxHeaderSlackBytes,
      maskAuthParams: this.config.privacy.maskAuthParams,
    })
    // Replay in arrival order. The chunks were copied on the way in, so nothing
    // here is a view onto a page buffer the player has since rewritten.
    const pending = c.pending
    const datagrams = c.pendingDatagrams
    c.pending = []
    c.pendingBytes = 0
    c.pendingDatagrams = []
    // The two fields worth having — the negotiated protocol and the draft it
    // selected — exist from here, so this is the earliest honest moment for the
    // setup record.
    this.#ensureSetup()
    for (const chunk of pending) c.dispatcher.onStreamData(chunk)
    for (const d of datagrams) c.dispatcher.onDatagram(d)
  }

  #bufferPending(c: Connection, chunk: StreamChunk): void {
    this.#probeLegacyDraft(c, chunk)
    // The probe may have attached a dispatcher synchronously in a warm-cache
    // build. Nothing downstream of here would be wrong if it had not, but
    // buffering a chunk that could be dispatched delays it for no reason.
    if (c.dispatcher !== null) {
      c.dispatcher.onStreamData(chunk)
      return
    }
    const cap = this.config.limits.dormantRingBytes
    if (c.pendingBytes + chunk.data.byteLength > cap) {
      if (c.awaitingSetup) {
        // The pre-draft buffer filled and SETUP never named a version. Waiting
        // longer costs memory for a session that will not be parsed, so this is
        // where a `moq-00` session gives up — reported as unsupported, which is
        // what it is: MoQT of some version this build could not identify.
        c.awaitingSetup = false
        this.#degraded = 'unsupported-protocol'
        c.pending = []
        c.pendingBytes = 0
        c.pendingDatagrams = []
        this.#ensureSetup()
        return
      }
      // Counted, not silently truncated. The counter surfaces on
      // the terminal record, so a session that lost its opening seconds to a
      // slow chunk fetch says so rather than looking like a short one.
      this.#droppedRecords += 1
      this.#sampledTypes.add('pre-draft-bytes')
      return
    }
    c.pendingBytes += chunk.data.byteLength
    c.pending.push({ ...chunk, data: chunk.data.slice() })
  }

  /* ── the ring ─────────────────────────────────────────────────────────── */

  /**
   * The ring is filled only while the recorder is armed.
   *
   * Armed is "ring overwriting in memory ... nothing parsed, nothing
   * produced, nothing sent". Disarmed it is not a cheaper ring, it is no ring:
   * a session with no triggers configured — the default, since automated mode
   * ships off — pays neither the memory nor the per-chunk copy.
   */
  #armed(): boolean {
    const t = this.config.flightRecorder.triggers
    return t.stall !== undefined || t.cadence !== undefined || t.trackSwitch !== undefined
  }

  #depthBytes(): number {
    try {
      return parseByteDepth(this.config.flightRecorder.depth)
    } catch (err) {
      this.#onError(err)
      return parseByteDepth('32MB')
    }
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
    if (this.#halted()) return
    // Order is load-bearing: the trigger opens a billable capture window
    // and "the pre-trigger dump is that window's first record". Raise first so
    // the dump is stamped at the window's level, then fire.
    this.#escalation.onTrigger(e.kind, e.atMono, e.key)
    this.#recorder.fire(e)
  }

  /* ── records ──────────────────────────────────────────────────────────── */

  #relNow(): Mono {
    return this.#clock.now() - this.anchor.originMono
  }

  /**
   * The setup record, emitted once, lazily, immediately before the first seal.
   *
   * Lazily because the two fields worth having — the negotiated protocol and the
   * draft it selected — do not exist until `ready` has resolved and the chunk has
   * landed, and a setup record that said `draft: null` on every session would be
   * a worse first frame than one that waits for the first flush.
   */
  #ensureSetup(): void {
    if (this.#setupSent) return
    this.#setupSent = true
    const base = {
      t: 'setup',
      ts: this.#relNow(),
      lvl: this.#escalation.level,
      draft: this.#draft,
      protocol: this.#protocol,
      roles: [...this.#roles],
      anchor: this.anchor,
      identity: this.ids(),
      collectorVersion: COLLECTOR_VERSION,
      // the fail-closed rule: a session whose worker never handshook is
      // reported partial rather than complete.
      partial: this.#partialExpected && !this.#partialLinked,
    } as const
    const record: SetupRecord = {
      ...base,
      ...(this.config.context.environment !== ''
        ? { environment: this.config.context.environment }
        : {}),
      ...(this.config.context.release !== '' ? { release: this.config.context.release } : {}),
      ...(this.#degraded !== undefined ? { degraded: this.#degraded } : {}),
    }
    this.#writeCritical(record)
  }

  #emitTerminal(reason: TerminalRecord['reason']): void {
    if (this.#terminalSent) return
    this.#terminalSent = true
    this.#ensureSetup()
    const counters: TerminalRecord['counters'] = {
      ringEvicted: this.#ring.evicted,
      ringEvictedBytes: this.#ring.evictedBytes,
      chunksDropped: this.#queue.droppedChunks + this.#droppedRecords,
      bucketsRefused: this.#rollup.bucketsRefused + this.#transportsRefused,
      parseFailures: this.#rollup.parseFailures,
      sampledTypes: [...this.#sampledTypes],
      ...(this.#overrunAt !== undefined
        ? { overrunAt: this.#overrunAt - this.anchor.originMono }
        : {}),
      ...(this.#overrunSignal !== undefined ? { overrunSignal: this.#overrunSignal } : {}),
    }
    // Written past the gate: `terminal` is non-droppable, and this is the record
    // the overrun policy exists for — "a short honest record plus an explicit 'I stopped here'
    // is defensible; a long one silently missing control messages is worse than
    // nothing, because it will be trusted."
    const record: TerminalRecord = {
      t: 'terminal',
      ts: this.#relNow(),
      lvl: this.#escalation.level,
      reason,
      counters,
      partial: this.#overrun || (this.#partialExpected && !this.#partialLinked),
    }
    this.#writeCritical(record)
  }

  /**
   * A non-droppable record, written past the halt gate.
   *
   * `setup` and `terminal` are produced during teardown and during the
   * overrun, i.e. exactly when `#halted()` is already true — so routing them
   * through `#writeRecord` would drop the two records that explain why
   * everything else stopped. Only `abort()` suppresses them, because `abort()`
   * transmits nothing at all.
   */
  #writeCritical(r: EnvelopeRecord): void {
    if (this.#aborted) return
    try {
      this.#queue.json(r)
    } catch (err) {
      this.#onError(err)
    }
  }

  /* ── the interval ─────────────────────────────────────────────────────── */

  #startInterval(): void {
    const ms = this.config.metrics.intervalMs
    const set = this.#ports.setTimer ?? ((fn: () => void, d: number) => setTimeout(fn, d))
    const run = (): void => {
      if (this.#stopped || this.#aborted) return
      try {
        this.#tickRollup()
      } catch (err) {
        this.#onError(err)
      }
      this.#intervalHandle = set(run, ms)
    }
    this.#intervalHandle = set(run, ms)
  }

  /**
   * Land the post-event timeout on the second it is due.
   *
   * `#tickRollup` already drives `EscalationController.tick`, but it runs on
   * `metrics.intervalMs` — 10 s by default and a customer setting — so on its
   * own it would close a 15 s window at 20 s and bill five seconds nobody
   * captured. Whole seconds are billed per window, so that rounding is money.
   * One timer per opened window, cleared on the next one and on `#detach`.
   */
  #scheduleWindowClose(deadlineMono: Mono): void {
    const set = this.#ports.setTimer ?? ((fn: () => void, d: number) => setTimeout(fn, d))
    const clear = this.#ports.clearTimer ?? ((h: unknown) => clearTimeout(h as never))
    if (this.#windowHandle !== undefined) clear(this.#windowHandle)
    const delay = Math.max(0, deadlineMono - this.#clock.now())
    this.#windowHandle = set(() => {
      this.#windowHandle = undefined
      if (this.#halted()) return
      try {
        this.#escalation.tick(this.#clock.now())
      } catch (err) {
        this.#onError(err)
      }
    }, delay)
  }

  #tickRollup(): void {
    const now = this.#clock.now()
    this.#rollup.tick(now)
    this.#triggers.tick(now)
    this.#escalation.tick(now)
    this.#pacer.notePressure({ objectsPerSec: this.#objectRate(), at: now })
  }

  /* ── sealing and release ──────────────────────────────────────────────── */

  async #flush(reason: SealReason): Promise<void> {
    if (this.#aborted) return
    try {
      // Not on every seal. The first seal fires within milliseconds of
      // `init()`, frequently before the page has even constructed its
      // `WebTransport`, and a setup record emitted there would carry
      // `protocol: null` and `draft: null` on every session — the two fields
      // that make it worth having. It goes out when the draft resolves
      // (`#attachDraft`), and at the latest when the session ends.
      if (reason === 'stop' || reason === 'terminal' || reason === 'pagehide') this.#ensureSetup()
      if (reason !== 'terminal' && reason !== 'stop') this.#rollup.tick(this.#clock.now())
      const chunk = await this.#queue.seal(reason)
      if (chunk === null) return
      this.#meter.noteBytes(chunk.level, chunk.bytes.byteLength)
      this.#outbox.push(chunk)
      if (reason !== 'stop') void this.#drainOutbox({ paced: true })
    } catch (err) {
      this.#onError(err)
    }
  }

  /**
   * The release loop. The pacer shapes the delay; it never seals.
   *
   * Rules the flush module documents and this loop obeys: release in segment
   * order; delete only what ingest confirmed, plus a terminal 4xx that ingest
   * will refuse forever; keep everything else, because that is what the
   * persistence is for.
   */
  async #drainOutbox(o: { paced: boolean; signal?: AbortSignal | undefined }): Promise<void> {
    if (this.#pumping || this.#aborted) return
    this.#pumping = true
    try {
      while (this.#outbox.length > 0 && !this.#aborted) {
        // The caller's deadline ends the loop between chunks as well as
        // inside a request, so a `stop()` that has run out of time does not
        // start a sixth upload it cannot finish.
        if (o.signal?.aborted === true) return
        const chunk = this.#outbox[0] as Chunk
        if (o.paced) {
          const delay = this.#pacer.nextReleaseDelayMs()
          if (delay > 0) await this.#sleep(delay)
        }
        if (this.#aborted) return
        const outcome = await this.#uploader.send(chunk, o.signal)
        this.#outbox.shift()
        if (outcome.ok || outcome.terminal) {
          if (this.#store !== null) await this.#store.delete(chunk.idempotencyKey)
        } else if (this.#store === null) {
          // Nothing durable behind it: keep it in memory for a later attempt
          // rather than dropping data the customer's page can still send.
          this.#outbox.push(chunk)
          return
        } else {
          // Persisted. `#adoptBacklog` on the next page load picks it up, and
          // spinning here would be the congestion the pacer exists to avoid.
          return
        }
      }
    } catch (err) {
      this.#onError(err)
    } finally {
      this.#pumping = false
    }
  }

  /**
   * Re-queue what a previous page load persisted and did not manage to send.
   *
   * Session-scoped, which is what stops one tab's `stop()` destroying another's
   * backlog — and which also means the backlog is only reachable when the
   * customer supplied a stable `sessionId`. A minted one is new every load, so
   * its predecessor's chunks are orphaned in the store until their TTL;
   * `ChunkStore` exposes no safe cross-session listing to do better from here.
   */
  async #adoptBacklog(): Promise<void> {
    const store = this.#store
    if (store === null) return
    try {
      for (const entry of store.pending(this.config.sessionId)) {
        const c = await store.get(entry.key)
        if (c !== undefined) this.#outbox.push(c)
      }
      if (this.#outbox.length > 0) await this.#drainOutbox({ paced: true })
    } catch (err) {
      this.#onError(err)
    }
  }

  #sleep(ms: number): Promise<void> {
    const set = this.#ports.setTimer ?? ((fn: () => void, d: number) => setTimeout(fn, d))
    return new Promise((resolve) => {
      set(() => resolve(), ms)
    })
  }

  /* ── page lifecycle ────────────────────────────────────────────── */

  /**
   * The tail beacon.
   *
   * "`sendBeacon` carries the tail only, at `pagehide` — it caps around
   * 64 KB and is best-effort." Synchronous throughout: the page may not survive
   * a single `await`, so `sealSync` takes the non-secure-context key (flagged
   * `keyFallback`) and writes the body uncompressed, because `CompressionStream`
   * is asynchronous by construction.
   *
   * **bfcache.** `pagehide` also fires on bfcache entry and the page may then be
   * restored and carry on. The spec does not say what should happen; the
   * decision here is to send the tail and **not** tear down, so a restored page
   * resumes the same session with a fresh connection id (the hook mints one per
   * `new WebTransport()`) and a `segmentSeq` read back from storage, which is
   * where the flush queue already gets it. Tearing down instead would silently
   * end a session the user is still watching.
   */
  #installLifecycle(): void {
    if (this.#ports.noLifecycleListeners === true) return
    const g = globalThis as { addEventListener?: (t: string, f: () => void) => void }
    if (typeof g.addEventListener !== 'function') return
    const handler = (): void => {
      try {
        this.#sendTail()
      } catch (err) {
        this.#onError(err)
      }
    }
    this.#onPagehide = handler
    g.addEventListener('pagehide', handler)
  }

  #sendTail(): void {
    if (this.#halted()) return
    // the third close condition — "the page reloading or unloading". Before
    // the seal, so the record that closes the window rides this beacon rather
    // than waiting for a page load that may never come. On a bfcache entry the
    // page may be restored and carry on; the window still closed, and the next
    // trigger opens a new one, which is the honest reading — nobody was
    // capturing while the page was frozen.
    this.#escalation.unload()
    this.#ensureSetup()
    this.#rollup.tick(this.#clock.now())
    const chunk = this.#queue.sealSync('pagehide')
    if (chunk === null) return
    // The credential has to be handed over explicitly: `sendBeacon` can set no
    // headers, so unless the key rides in the URL the tail is an unauthenticated
    // POST that ingest refuses — and refuses invisibly, because a beacon cannot
    // read a response. The fallback path uses a header instead; `sendTail` picks
    // per path.
    const outcome = sendTail(this.config.endpoint, chunk.bytes, {
      maxBytes: this.config.upload.beaconMaxBytes,
      apiKey: this.config.apiKey,
      idempotencyKey: chunk.idempotencyKey,
      ...(this.#ports.beacon !== undefined ? { beacon: this.#ports.beacon } : {}),
      ...(this.#ports.fetchImpl !== undefined ? { fetchImpl: this.#ports.fetchImpl } : {}),
      onInternalError: this.#onError,
    })
    // Metered only once something took it. `sealSync` does not persist, so a
    // refused tail is gone; counting its bytes would put them in the usage
    // estimate while ingest — the actual meter — never sees them. `sendTail` has
    // already reported the loss.
    if (outcome === false) return
    this.#meter.noteBytes(chunk.level, chunk.bytes.byteLength)
  }

  /* ── teardown ─────────────────────────────────────────────────────────── */

  /** Stop observing. Synchronous, and the first thing both verbs do. */
  #detach(): void {
    try {
      this.#hook.setObserver(null)
    } catch (err) {
      this.#onError(err)
    }
    this.#schedule.stop()
    this.#recorder.disarm()
    this.#triggers.reset()
    const clear = this.#ports.clearTimer ?? ((h: unknown) => clearTimeout(h as never))
    if (this.#intervalHandle !== undefined) {
      clear(this.#intervalHandle)
      this.#intervalHandle = undefined
    }
    if (this.#windowHandle !== undefined) {
      clear(this.#windowHandle)
      this.#windowHandle = undefined
    }
  }

  /**
   * Both verbs restore the wrapped globals, and the transport module's
   * `uninstall` also detaches every per-instance patch on sessions that are
   * still open — the case `abort()` exists for.
   */
  async #teardown(): Promise<void> {
    const g = globalThis as { removeEventListener?: (t: string, f: () => void) => void }
    if (this.#onPagehide !== undefined && typeof g.removeEventListener === 'function') {
      g.removeEventListener('pagehide', this.#onPagehide)
      this.#onPagehide = undefined
    }
    this.#ring.clear()
    this.#connections.clear()
    try {
      this.#hook.uninstall()
    } catch (err) {
      this.#onError(err)
    }
    this.#store?.close()
    await Promise.resolve()
  }

  /** Stopped, aborted, or halted by the overrun. Nothing is collected after. */
  #halted(): boolean {
    return this.#stopped || this.#aborted || this.#overrun
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
          this.#onError(err)
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
      onDatagram: wrap(this.onDatagram),
      onWriterPressure: wrap(this.onWriterPressure),
      onSendStats: wrap(this.onSendStats),
    }
  }
}
