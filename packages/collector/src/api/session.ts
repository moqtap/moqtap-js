/**
 * The page's runtime: the only part of the collector that numbers, seals,
 * stores, uploads or ends anything.
 *
 * It observes the page's own transports through a {@link RealmObserver}, takes
 * the frames linked workers forward, and turns both into one stream of bodies
 * for this instance: numbered from zero in memory, keyed at the seal, kept in
 * an outbox until ingest answers, and copied to IndexedDB so a body the page
 * could not send is sent by the next page load on the origin.
 *
 * Rules every method below keeps:
 *
 *  - **Nothing throws into the page.** Every failure goes to
 *    `CollectorConfig.onInternalError`.
 *  - **A sealed body leaves the outbox only on an answer**: a 2xx, or a 4xx
 *    ingest will repeat forever. Anything else is retried — on the next seal,
 *    on `online`, and on a backoff capped at 60 s.
 *  - **The instance ends once**, with an `end` record in a body marked
 *    `final`, whose `seq` the record names.
 */

import { MQ1006 } from '../codes.js'
import type { DraftSet } from '../draft/index.js'
import { sha256Hex } from '../envelope/index.js'
import {
  BEACON_MAX_BYTES,
  type Chunk,
  type ChunkDestination,
  type ChunkStore,
  compress,
  DIRECTIVE_ELEVATE_MAX_LEVEL,
  DIRECTIVE_ELEVATE_MAX_SPAN_MS,
  DIRECTIVE_FLUSH_MAX_MS,
  DIRECTIVE_FLUSH_MAX_SPAN_MS,
  DIRECTIVE_FLUSH_MIN_MS,
  DIRECTIVE_HOLD_MAX_SPAN_MS,
  deadlineSignal,
  FlushQueue,
  FlushSchedule,
  type LockManagerLike,
  ReleasePacer,
  sendTail,
  Uploader,
} from '../flush/index.js'
import type { TriggerEvent } from '../recorder/index.js'
import type { CustomMetrics } from '../rollup/index.js'
import type { TransportHook } from '../transport/index.js'
import type {
  ClockAnchor,
  ClockSource,
  ContextRecord,
  ContextUpdate,
  DetailLevel,
  EndCounters,
  EndRecord,
  EnvelopeRecord,
  Identity,
  LifeRecord,
  LinkRecord,
  Mono,
  RecordSink,
  ResolvedConfig,
  SetupRecord,
  UploadOutcome,
  UsageReport,
} from '../types.js'
import { COLLECTOR_VERSION } from '../version.js'
import { addTags, type ConfigProblem, mintId, sentActorId } from './config.js'
import { levelIndex } from './defaults.js'
import type { DormantState } from './dormant.js'
import {
  baselineEscalation,
  type Escalation,
  type FeatureSet,
  type LinkOwner,
  type Observation,
  type Persistence,
  type WorkerLinks,
} from './features.js'
import type { DeflatePart, PageMessage } from './link.js'
import { UsageMeter } from './meter.js'
import type { ConnectionState, RealmObserver } from './realm.js'

/** Re-exported for the public API; defined in `../version.js` so the dormant
 * path can read it without pulling this module in. */
export { COLLECTOR_VERSION }

/** The part of a `MessageEvent` a link reads. */
export interface LinkEvent {
  readonly data?: unknown
  readonly ports?: readonly MessagePort[]
}

/** What a worker link accepts: a `Worker`, a `MessagePort`, or anything postMessage-shaped. */
export interface MessageTarget {
  postMessage(message: unknown, transfer?: Transferable[]): void
  addEventListener(type: 'message', listener: (e: LinkEvent) => void): void
  removeEventListener?(type: 'message', listener: (e: LinkEvent) => void): void
  start?(): void
}

/** Ports the runtime needs and does not create, so the suite can supply its own. */
export interface RuntimePorts {
  readonly clock?: ClockSource
  /** `performance.timeOrigin`: the page's clock origin, against which a worker's is rebased. */
  readonly timeOrigin?: number
  readonly fetchImpl?: typeof fetch
  readonly store?: ChunkStore | null
  readonly setTimer?: (fn: () => void, ms: number) => unknown
  readonly clearTimer?: (h: unknown) => void
  /** Injected so a test can drive the beacon without a DOM. */
  readonly beacon?: (url: string, data: Blob) => boolean
  /** Skip the page lifecycle listeners; the suite installs none. */
  readonly noLifecycleListeners?: boolean
  /** `navigator.locks`, or `null` for a platform without Web Locks. */
  readonly locks?: LockManagerLike | null
  /** The instance id. Injected so the suite is deterministic. */
  readonly instanceId?: string
  /**
   * Begin nothing until a `WebTransport` is constructed in the page or a
   * linked worker: until then nothing is recorded, stored or sent. The runtime
   * that records the session takes over at that moment, and {@link onSession}
   * names it.
   */
  readonly armed?: boolean | undefined
  /** Clock zero. Default: now. */
  readonly anchor?: ClockAnchor | undefined
  /**
   * When this session began on {@link anchor}, which an earlier session in the
   * page set: one started by `newSession()` while connections were open keeps
   * the page's timeline, so a linked probe's clock offset stays valid.
   */
  readonly startTs?: number | undefined
  /**
   * Another runtime took over: the session began, ended idle, or
   * `newSession()` started the next. Called before the new runtime starts,
   * so a runtime that hands over again at once is named after this one.
   */
  readonly onSession?: ((r: CollectorRuntime) => void) | undefined
  /** The customer's metric definitions, which carry from one session to the next. */
  readonly custom?: CustomMetrics | undefined
  /** Features already reported missing in this page, which are not reported again. */
  readonly reported?: Set<string> | undefined
  /** `CollectorConfig.onInternalError`, which `ResolvedConfig` deliberately omits. */
  readonly onInternalError?: (err: unknown) => void
}

/**
 * How long a session outlives its last connection. A connection attempted
 * within it joins the session; after it the session ends, and the next attempt
 * begins another.
 */
export const IDLE_END_MS = 30_000

/** The backoff a failed upload waits before the outbox tries again, in ms. */
const RETRY_FIRST_MS = 1_000
const RETRY_MAX_MS = 60_000

/**
 * The gap after which hiding the page seals what it holds. Under it the last
 * seal is recent enough that sealing again would only add an upload.
 */
const HIDDEN_SEAL_GAP_MS = 5_000

/**
 * The most of the page's own buffered frames a compressed forward's body takes
 * in front of it, uncompressed. Past it they are sealed and compressed first,
 * in a body of their own.
 */
const SEGMENT_PREFIX_MAX_BYTES = 8 * 1024

/** How old a stored body must be before a page without Web Locks takes it as left behind. */
const SWEEP_AGE_INTERVALS = 3

const platformClock: ClockSource = { now: () => performance.now(), wall: () => Date.now() }

/** What this build of the collector carries. The same for every session in the page. */
export interface Build {
  readonly drafts: DraftSet
  /** `null` when the build imports no draft: the page observes no transport of its own. */
  readonly observation: Observation | null
  readonly features: FeatureSet
}

/** A realm's counters, for a page that observes no transport of its own. */
const NO_COUNTERS: Omit<EndCounters, 'chunksDropped'> = Object.freeze({
  ringEvicted: 0,
  ringEvictedBytes: 0,
  bucketsRefused: 0,
  parseFailures: 0,
  sampledTypes: [],
})

export class CollectorRuntime {
  readonly config: ResolvedConfig
  readonly anchor: ClockAnchor
  readonly instanceId: string
  /** Waiting for the session's first `WebTransport`; see {@link RuntimePorts.armed}. */
  private readonly _armed: boolean
  /** What holds the page's transports until this session's realm starts; `undefined` is the dormant hook's own. */
  private _dormant: DormantState | undefined
  private _idleHandle: unknown

  private readonly _clock: ClockSource
  private readonly _ports: RuntimePorts
  private readonly _onError: (err: unknown) => void
  /** `null` in a build without a draft: nothing in the page is observed. */
  private readonly _hook: TransportHook | null
  private readonly _build: Build
  private readonly _persistence: Persistence | undefined
  private readonly _dest: ChunkDestination
  private readonly _locks: LockManagerLike | undefined

  private readonly _realm: RealmObserver | null
  private readonly _custom: CustomMetrics | null
  /** Customer metrics belong to no connection, so they have an engine of their own. */
  private readonly _customRollup: { tick(now: Mono): void } | null
  private readonly _queue: FlushQueue
  private readonly _schedule: FlushSchedule
  private readonly _pacer: ReleasePacer
  private readonly _uploader: Uploader
  private readonly _meter: UsageMeter
  private readonly _escalation: Escalation
  private readonly _store: ChunkStore | null
  /** Features already reported missing in this page. */
  private readonly _reported: Set<string>
  /**
   * Every record the page writes goes through here, so the instance's setup
   * record is always the first frame of its first body. A page that never
   * records anything never sends anything.
   */
  private readonly _sink: RecordSink & { readonly pendingBytes: number }
  /** Aborted at teardown: ends any upload still in flight. */
  private readonly _life = new AbortController()

  /** Sealed bodies awaiting an answer, oldest first; bodies swept from storage go first of all. */
  private _outbox: Chunk[] = []
  /** Compression and the stored copy of each body, which a send waits for. */
  private readonly _prepared = new WeakMap<Chunk, Promise<void>>()
  /** Bodies already counted in `usage()`, so a body both beaconed and prepared counts once. */
  private readonly _metered = new WeakSet<Chunk>()
  /** This instance's bodies that will never arrive. */
  private readonly _lost: number[] = []
  private _pumping: Promise<void> | null = null
  private _urgent = false
  private _wake: (() => void) | undefined
  private _retryHandle: unknown
  private _retryDelay = 0
  private _lastSealMono: Mono
  private _forwardRefused = 0

  /** The page's workers, shared with every session in the page; `null` until one is linked. */
  private _links: WorkerLinks | null = null
  /**
   * Instance locks of earlier sessions in this page, held while their bodies
   * are still in this outbox, so no other page load sweeps them meanwhile.
   */
  private readonly _inheritedLocks = new Map<string, () => void>()
  /** What `ids()` and connections opened from now on carry. `setContext()` changes it. */
  private readonly _context: {
    actorId: string
    contentId: string
    tags: Readonly<Record<string, string>>
  }

  private _setupSent = false
  /** When this session began on an inherited anchor; `undefined` when the anchor is its own. */
  private _startTs: number | undefined
  private _ended = false
  private _discarded = false
  private _releaseLock: () => void = () => {}
  private _intervalHandle: unknown
  /** The one-shot timer landing the post-event timeout on time. See `_scheduleWindowClose`. */
  private _windowHandle: unknown
  private _listeners: [string, (e: unknown) => void, boolean][] = []
  private _frozenAt: Mono | undefined
  /** How far an unload got; see `_unload`. */
  private _unloadStep: 0 | 1 | 2 | 3 | 4 | 5 = 0
  private _endBody: Chunk | null = null
  /** Bodies handed to the platform at `pagehide`, so a resumed unload sends each once. */
  private readonly _beaconed = new Set<Chunk>()
  private _probeOverrun: Pick<EndCounters, 'overrunAt' | 'overrunSignal'> | undefined

  constructor(
    config: ResolvedConfig,
    hook: TransportHook | null,
    build: Build,
    ports: RuntimePorts = {},
  ) {
    this.config = config
    this._ports = ports
    this._hook = hook
    this._build = build
    this._persistence = build.features.persistence?.persistence
    this._reported = ports.reported ?? new Set()
    this._context = {
      actorId: config.context.actorId,
      contentId: config.context.contentId,
      tags: config.context.tags,
    }
    this._clock = ports.clock ?? platformClock
    this._onError = (err: unknown): void => {
      try {
        ports.onInternalError?.(err)
      } catch {
        // An error handler that throws is where reporting stops.
      }
    }
    this.anchor = ports.anchor ?? this._anchorNow()
    this._startTs = ports.startTs
    this._armed = ports.armed === true
    this.instanceId = ports.instanceId ?? mintId()
    this._lastSealMono = this._clock.now()
    this._dest = { endpoint: config.endpoint, keyHash: sha256Hex(config.apiKey) }
    this._locks =
      ports.locks === null ? undefined : (ports.locks ?? this._persistence?.platformLocks())

    // Every record is stamped session-relative: the queue's batch frame here,
    // and every other record by whoever writes it, against the same anchor.
    const relClock: ClockSource = {
      now: () => this._clock.now() - this.anchor.originMono,
      wall: () => this._clock.wall(),
    }

    this._meter = new UsageMeter(this._clock)
    this._store = ports.store ?? null

    this._queue = new FlushQueue({
      sessionId: config.sessionId,
      instanceId: this.instanceId,
      clock: relClock,
      level: () => this._escalation.level,
      maxPendingBytes: 8 * config.upload.byteThreshold,
      onInternalError: this._onError,
    })
    const queue = this._queue
    // Before its session begins a runtime records nothing at all.
    this._sink = {
      json: (r: EnvelopeRecord): void => {
        if (this._discarded || this._armed) return
        this._ensureSetup()
        queue.json(r)
      },
      raw: (b: Uint8Array): void => {
        if (!this._discarded && !this._armed) queue.raw(b)
      },
      get pendingBytes(): number {
        return queue.pendingBytes
      },
    }

    const observation = build.observation
    this._realm =
      observation === null || hook === null
        ? null
        : observation.realm({
            realm: 'page',
            config,
            hook,
            drafts: build.drafts,
            originMono: this.anchor.originMono,
            clock: this._clock,
            recorder: build.features.flightRecorder,
            host: {
              sink: this._sink,
              level: () => this._escalation.level,
              onTrigger: (e: TriggerEvent) => this._escalation.onTrigger(e.kind, e.atMono, e.key),
              onConnReady: () => this._schedule.ready(this._clock.now()),
              onConnClosed: () => {
                this._sealNow(false)
                this._noteClosed()
              },
              onOverrun: () => this._overrun(),
              onPressure: (p) => this._pacer.notePressure(p),
              onBytes: (n) => this._schedule.noteBytes(n),
              onError: this._onError,
            },
          })

    const metrics = build.features.customMetrics
    this._custom = ports.custom ?? metrics?.create((m) => this._onError(new Error(m))) ?? null
    this._customRollup =
      metrics === undefined || this._custom === null
        ? null
        : metrics.rollup({
            intervalMs: config.metrics.intervalMs,
            clock: this._clock,
            sink: this._sink,
            originMono: this.anchor.originMono,
            custom: this._custom,
          })

    const escalation = build.features.escalation
    const ring = this._realm?.ring ?? null
    this._escalation =
      escalation === undefined
        ? baselineEscalation(() => this._missing('escalation'))
        : escalation.create({
            configured: config.detail,
            ceilingMinutes: config.budget.elevatedMinutes,
            windowMs: config.flightRecorder.windowMs,
            meter: this._meter,
            clock: this._clock,
            anchor: this.anchor,
            sink: this._sink,
            // The "ring filling" close condition. The ring is only written to
            // while the recorder is armed, so on a session with no triggers
            // configured — the default — this never advances and never closes
            // anything.
            ...(ring !== null
              ? { ring: { capacityBytes: ring.maxBytes, evictedBytes: () => ring.evictedBytes } }
              : {}),
            onWindowOpen: (deadline) => this._scheduleWindowClose(deadline),
            onLevelChange: (level) => this._broadcast({ t: 'level', level }),
          })

    this._uploader = new Uploader({
      endpoint: config.endpoint,
      apiKey: config.apiKey,
      maxAttempts: config.upload.maxAttempts,
      // `fetch` has no timeout, so without this one blackholed request is
      // pending for the life of the page, and the outbox behind it with it.
      timeoutMs: config.upload.timeoutMs,
      ...(ports.fetchImpl !== undefined ? { fetchImpl: ports.fetchImpl } : {}),
      onInternalError: this._onError,
    })
    this._pacer = new ReleasePacer({
      // The pacer shapes only the DELAY between releases; it can never seal
      // less often. The ceiling is one flush interval, so a fully congested
      // session still releases roughly as often as it seals.
      minIntervalMs: 0,
      maxIntervalMs: config.upload.intervalMs,
    })
    this._schedule = new FlushSchedule({
      onFlush: () => this._sealNow(true),
      byteThreshold: config.upload.byteThreshold,
      earlyFlushesMs: config.upload.earlyFlushesMs,
      intervalMs: config.upload.intervalMs,
      ...(ports.setTimer !== undefined && ports.clearTimer !== undefined
        ? { timers: { setTimer: ports.setTimer, clearTimer: ports.clearTimer } }
        : {}),
      onInternalError: this._onError,
    })
  }

  /* ── startup ──────────────────────────────────────────────────────────── */

  start(): void {
    if (this._armed) {
      this._arm(true)
      return
    }
    this._begin()
    void this._sweep()
  }

  private _begin(): void {
    this._releaseLock =
      this._persistence?.hold(this._locks, this.instanceId, this._onError) ?? (() => {})
    this._realm?.start(this._dormant)
    this._dormant = undefined
    this._schedule.start(this._clock.now())
    this._startInterval()
    this._installLifecycle()
  }

  /**
   * Wait for a `WebTransport` in the page. Its construction begins the
   * session there and then, with clock zero at that moment, inside the
   * constructor's call: the runtime that records it is the hook's observer
   * before the constructor returns. One made before this runtime started,
   * still held by the dormant hook, begins it at once.
   */
  private _arm(first: boolean): void {
    this._installLifecycle()
    const observation = this._build.observation
    if (this._hook === null || observation === null || !this._hook.installed) return
    const hook = this._hook
    const begin = (from?: DormantState): void => {
      if (from !== undefined) this._dormant = from
      try {
        this._beginNow()
      } catch (err) {
        this._onError(err)
      }
    }
    const s = this._dormant
    if (s !== undefined) {
      s.onOpen = begin
      if (observation.pending(s)) begin()
    } else if (first && observation.pending()) begin()
    else this._dormant = observation.arm(hook, begin)
  }

  /** Begin the session this runtime was waiting for, in a runtime that records it. */
  private _beginNow(): void {
    if (this._ended) return
    this._handOver(this._withContext(), this.instanceId, { anchor: this._anchorNow() })
  }

  /** This session's config with the context as it stands, which the next one starts from. */
  private _withContext(over?: Pick<ResolvedConfig, 'sessionId' | 'idSource'>): ResolvedConfig {
    return Object.freeze({
      ...this.config,
      ...over,
      context: Object.freeze({ ...this.config.context, ...this._context }),
    })
  }

  private _anchorNow(): ClockAnchor {
    return { originMono: this._clock.now(), originWall: this._clock.wall() }
  }

  /** A connection is open or being attempted, in the page or a linked worker. */
  private _open(): boolean {
    return (
      this._links?.open() === true ||
      this._realm?.connections().some((c) => c.state !== 'closed') === true
    )
  }

  /**
   * A connection closed, or the session began with none open yet. With none
   * open, the session ends {@link IDLE_END_MS} from now unless one is
   * attempted meanwhile, and the next attempt begins a new one, with the
   * context so far.
   */
  private _noteClosed(): void {
    if (this._ended || this._armed || this._open()) return
    this._cancel(this._idleHandle)
    this._idleHandle = this._timer(() => {
      this._idleHandle = undefined
      if (this._ended || this._open()) return
      this._finish('idle')
      this._seal(true)
      this._handOver(this._withContext({ sessionId: mintId(), idSource: 'minted' }), mintId(), {
        armed: true,
      })
    }, IDLE_END_MS)
  }

  /* ── the public verbs ─────────────────────────────────────────────────── */

  ids(): Identity {
    const ctx = this._context
    return {
      sessionId: this.config.sessionId,
      instanceId: this.instanceId,
      ...(ctx.actorId !== '' ? { actorId: ctx.actorId } : {}),
      ...(ctx.contentId !== '' ? { contentId: ctx.contentId } : {}),
    }
  }

  /** The connection id of a `WebTransport` this page created. */
  connectionIdOf(transport: unknown): string | undefined {
    return this._build.observation?.connectionIdOf(transport)
  }

  /** Every connection seen in this page and its linked workers, open ones first. */
  connections(): ConnectionState[] {
    const all = [...(this._realm?.connections() ?? []), ...(this._links?.connections() ?? [])]
    return [...all.filter((c) => c.state !== 'closed'), ...all.filter((c) => c.state === 'closed')]
  }

  usage(): UsageReport {
    return this._meter.report()
  }

  get ended(): boolean {
    return this._ended
  }

  /** Before the session begins there is nothing to capture, and the call is dropped. */
  escalate(level: DetailLevel, reason?: string): void {
    if (this._ended || this._armed) return
    this._escalation.escalate(level, reason)
  }

  /**
   * The incident is over. Closes the open capture window.
   *
   * Harmless when none is open, because this is called from the customer's own
   * error handling and will be called for incidents that never escalated.
   */
  resolve(reason?: string): void {
    if (this._ended || this._armed) return
    this._escalation.resolve(reason)
  }

  annotate(name: string, data: unknown, connectionId?: string): void {
    if (this._ended || this._realm?.halted === true) return
    this._sink.json({
      t: 'note',
      ts: this._relNow(),
      lvl: this._escalation.level,
      name: String(name),
      ...(connectionId !== undefined ? { conn: String(connectionId) } : {}),
      data,
    })
  }

  /**
   * Context for connections opened from now on, in this page and its linked
   * workers. `ids()` carries it at once, and a `context` record says from when.
   * Tags add to the session's.
   */
  setContext(ctx: ContextUpdate): void {
    if (this._ended) return
    const c = this._context
    const record: { -readonly [K in keyof ContextRecord]: ContextRecord[K] } = {
      t: 'context',
      ts: this._relNow(),
      lvl: this._escalation.level,
    }
    if (typeof ctx.contentId === 'string') {
      c.contentId = ctx.contentId
      this._realm?.setContentId(ctx.contentId)
      this._broadcast({ t: 'context', contentId: ctx.contentId })
      if (ctx.contentId !== '') record.contentId = ctx.contentId
    }
    if (typeof ctx.actorId === 'string') {
      c.actorId = sentActorId(ctx.actorId, this.config)
      if (c.actorId !== '') record.actorId = c.actorId
    }
    if (ctx.tags !== undefined) {
      const { merged, accepted } = addTags(c.tags, ctx.tags, (p) => this._report(p))
      c.tags = merged
      if (Object.keys(accepted).length > 0) record.tags = accepted
    }
    if (
      record.contentId !== undefined ||
      record.actorId !== undefined ||
      record.tags !== undefined
    ) {
      this._sink.json(record)
    }
  }

  /** A rejected argument, in the form `init()` reports a rejected option. */
  private _report(p: ConfigProblem): void {
    this._onError(new Error(`${p.code}: ${p.key}${p.got === undefined ? '' : ` ${p.got}`}`))
  }

  defineMetric(name: string, d: Parameters<CustomMetrics['defineMetric']>[1]): void {
    if (this._custom === null) this._missing('customMetrics')
    else this._custom.defineMetric(name, d)
  }

  observe(name: string, value: number, labels?: Record<string, string>): void {
    if (this._armed) return
    if (this._custom === null) this._missing('customMetrics')
    else if (labels === undefined) this._custom.observe(name, value)
    else this._custom.observe(name, value, labels)
  }

  /**
   * Seal everything recorded so far and send it. Resolves when ingest has
   * answered or `upload.drainDeadlineMs` has passed, with anything unsent
   * still queued and stored for retry. Ends nothing.
   */
  async flush(): Promise<void> {
    if (this._ended) return
    this._broadcast({ t: 'forward' })
    this._tick()
    this._seal()
    await this._drainUrgent()
  }

  /**
   * End this instance: report its open connections closed, write `end{app}`,
   * send everything, and restore the patched global. Before the session
   * begins there is nothing of it to end, only earlier sessions' bodies to send.
   */
  async end(): Promise<void> {
    if (this._ended) return
    if (this._armed) {
      this._ended = true
      this._broadcast({ t: 'unlinked' })
    } else {
      this._finish('app')
      this._seal(true)
    }
    try {
      await this._drainUrgent()
      // Whatever is still unsent keeps its stored copy for the next page load.
      await Promise.all(this._outbox.map((c) => this._prepared.get(c)))
    } finally {
      this._teardown()
      this._store?.close()
    }
  }

  /**
   * Drop everything unsent, stored copies included, and tear down.
   * **Transmits nothing**, from the first line on.
   */
  async discard(): Promise<void> {
    if (this._discarded) return
    this._discarded = true
    this._ended = true
    this._realm?.detach()
    const unsent = this._outbox
    this._outbox = []
    this._teardown()
    if (this._store !== null) {
      try {
        // The outbox can hold bodies of earlier sessions in this page and of
        // earlier page loads; consent covers those too. Their stored copies may
        // still be being written, so each is deleted once it is.
        await Promise.all(unsent.map((c) => this._prepared.get(c)))
        for (const c of unsent) await this._store.delete(c.idempotencyKey)
        await this._store.clearSession(this.config.sessionId)
      } catch (err) {
        this._onError(err)
      }
      this._store.close()
    }
  }

  /**
   * End this session and start the next one in this page, which takes over
   * the transport hook, the store, every worker link and every body not yet
   * sent. `null` once this instance has ended.
   *
   * With a connection open, the next session begins at once and inherits it.
   * With none, it begins with the next `WebTransport`, like the first.
   *
   * Synchronous, like the seal: the old session's last body is numbered and
   * keyed before this returns. A probe forward already on its way lands in
   * the new session.
   */
  successor(next: ResolvedConfig, instanceId: string): CollectorRuntime | null {
    if (this._ended) return null
    const open = !this._armed && this._open()
    if (!this._armed) {
      this._finish('new-session')
      this._seal(true)
    }
    return this._handOver(
      next,
      instanceId,
      open
        ? { anchor: this.anchor, startTs: this._clock.now() - this.anchor.originMono }
        : { armed: true },
    )
  }

  /** Hand everything a page keeps across its sessions to the runtime of the next one. */
  private _handOver(
    next: ResolvedConfig,
    instanceId: string,
    ports: Pick<RuntimePorts, 'armed' | 'anchor' | 'startTs'>,
  ): CollectorRuntime {
    const runtime = new CollectorRuntime(next, this._hook, this._build, {
      ...this._ports,
      instanceId,
      armed: false,
      anchor: undefined,
      startTs: undefined,
      custom: this._custom ?? undefined,
      reported: this._reported,
      ...ports,
    })
    // The session's tags so far, `setContext()`'s included, go on with it.
    runtime._context.tags = this._context.tags
    runtime._dormant = this._dormant
    this._dormant = undefined
    const outbox = this._outbox
    const links = this._links
    const locks = new Map(this._inheritedLocks)
    if (!this._armed) locks.set(this.instanceId, this._releaseLock)
    this._outbox = []
    this._links = null
    this._inheritedLocks.clear()
    this._releaseLock = () => {}
    this._teardown({ keepHook: true })
    this._ports.onSession?.(runtime)
    runtime._adopt(this, outbox, links, locks)
    return runtime
  }

  /** Take over what {@link successor} hands on, and start. */
  private _adopt(
    from: CollectorRuntime,
    outbox: readonly Chunk[],
    links: WorkerLinks | null,
    locks: ReadonlyMap<string, () => void>,
  ): void {
    for (const c of outbox) {
      const prepared = from._prepared.get(c)
      if (prepared !== undefined) this._prepared.set(c, prepared)
      if (from._metered.has(c)) this._metered.add(c)
    }
    this._outbox = [...outbox, ...this._outbox]
    for (const [id, release] of locks) this._inheritedLocks.set(id, release)
    if (!this._armed) {
      this._begin()
      if (from._armed) void this._sweep()
    }
    if (links !== null) {
      this._links = links
      links.adopt(this._owner)
    }
    this._releaseInherited()
    if (this._outbox.length > 0) void this._drain()
    // A session a worker began may see that worker's connection close before
    // its first forward arrives; it ends all the same.
    this._noteClosed()
    // Last: a connection already waiting begins the next session at once, and
    // this one hands over what it now holds.
    if (this._armed) this._arm(false)
  }

  /** Let go of an earlier session's lock once none of its bodies is left to send. */
  private _releaseInherited(): void {
    for (const [id, release] of this._inheritedLocks) {
      if (this._outbox.some((c) => c.instanceId === id)) continue
      this._inheritedLocks.delete(id)
      release()
    }
  }

  /* ── worker links ─────────────────────────────────────────────────────── */

  /**
   * Answer `target`'s hello, and report the link either way. `hello` is one
   * the target sent before this runtime was running, heard on its behalf.
   */
  linkWorker(target: MessageTarget, hello?: LinkEvent): void {
    if (this._ended) return
    const workers = this._build.features.workers
    if (workers === undefined) {
      this._missing('workers')
      return
    }
    this._links ??= workers.create(
      {
        clock: this._clock,
        onError: this._onError,
        timer: (fn, ms) => this._timer(fn, ms),
        cancel: (h) => this._cancel(h),
      },
      this._owner,
    )
    this._links.link(target, hello)
  }

  /** What the links read from, and write into, this session. */
  private readonly _owner: LinkOwner = ((): LinkOwner => {
    const self = this
    return {
      get ended() {
        return self._ended
      },
      get armed() {
        return self._armed
      },
      get config() {
        return self.config
      },
      get instanceId() {
        return self.instanceId
      },
      get level() {
        return self._escalation.level
      },
      context: () => ({ ...self.config.context, ...self._context }),
      base: (origin) =>
        (self._ports.timeOrigin ?? performance.timeOrigin) + self.anchor.originMono - origin,
      begin: () => self._beginNow(),
      writeLink: (id, ev) => self._writeLink(id, ev),
      append: (frames, n) => {
        if (self._queue.append(frames, n)) self._schedule.noteBytes(frames.byteLength)
        else self._forwardRefused += n
      },
      sealSegment: (part) => self._sealSegment(part),
      ensureSetup: () => self._ensureSetup(),
      connReady: () => self._schedule.ready(self._clock.now()),
      noteClosed: () => self._noteClosed(),
      sealNow: () => self._sealNow(false),
      annotate: (name, data, conn) => self.annotate(name, data, conn),
      observe: (name, value, labels) => self.observe(name, value, labels),
      escalate: (level, reason) => self.escalate(level, reason),
      resolve: (reason) => self.resolve(reason),
      trigger: (kind, at, key) =>
        self._escalation.onTrigger(kind, at + self.anchor.originMono, key),
      overrun: (at, signal) => self._overrun({ overrunAt: at, overrunSignal: signal }),
      json: (r) => self._sink.json(r),
      relNow: () => self._relNow(),
    }
  })()

  /**
   * Frames a probe compressed: the end of a body of their own, sealed now
   * behind what the page has buffered, and sent. Nothing is inflated or
   * compressed here.
   */
  private _sealSegment(part: DeflatePart): void {
    if (this._discarded) return
    if (this._queue.pendingBytes > SEGMENT_PREFIX_MAX_BYTES) this._seal()
    let chunk: Chunk
    try {
      chunk = this._queue.sealSegment(
        {
          deflate: new Uint8Array(part.deflate, 0, part.byteLength),
          crc: part.crc,
          size: part.size,
        },
        { lost: this._lost, dropped: this._dropped() },
      )
    } catch (err) {
      this._onError(err)
      this._forwardRefused += part.n
      return
    }
    this._admit(chunk)
    void this._drain()
  }

  private _broadcast(m: PageMessage): void {
    this._links?.broadcast(m)
  }

  private _writeLink(link: string, ev: LinkRecord['ev']): void {
    this._sink.json({
      t: 'link',
      ts: this._relNow(),
      lvl: this._escalation.level,
      link,
      ev,
    })
  }

  /** A call that needs a feature this build does not carry. Reported once per feature. */
  private _missing(feature: string): void {
    if (this._reported.has(feature)) return
    this._reported.add(feature)
    this._onError(new Error(`${MQ1006}: ${feature}`))
  }

  /* ── records ──────────────────────────────────────────────────────────── */

  private _ensureSetup(): void {
    if (this._setupSent) return
    this._setupSent = true
    const ctx = this.config.context
    const tags = this._context.tags
    const record: SetupRecord = {
      t: 'setup',
      ts: this._relNow(),
      lvl: this._escalation.level,
      anchor: this.anchor,
      identity: this.ids(),
      idSource: this.config.idSource,
      collectorVersion: COLLECTOR_VERSION,
      ...(ctx.environment !== '' ? { environment: ctx.environment } : {}),
      ...(ctx.release !== '' ? { release: ctx.release } : {}),
      ...(Object.keys(tags).length > 0 ? { tags } : {}),
      ...(this._startTs !== undefined ? { startTs: this._startTs } : {}),
    }
    this._queue.json(record)
  }

  private _writeLife(ev: LifeRecord['ev'], gapMs?: number): void {
    this._sink.json({
      t: 'life',
      ts: this._relNow(),
      lvl: this._escalation.level,
      ev,
      ...(gapMs !== undefined ? { gapMs } : {}),
    })
  }

  /**
   * Stop recording and write the instance's last records: open connections
   * closed, the open rollup intervals, the `end` record. The caller seals
   * them as the final body.
   *
   * What was already buffered is sealed first, so the final body holds only
   * these few records and can never be refused by the buffer's cap: the `end`
   * record is the one that must not be lost.
   */
  private _finish(reason: EndRecord['reason']): void {
    this._ended = true
    const now = this._clock.now()
    this._realm?.detach()
    this._schedule.stop()
    this._escalation.close()
    this._seal()
    this._realm?.closeAll('session-end', now)
    this._links?.closeForwarded('session-end')
    this._customRollup?.tick(now)
    // Probes follow the page into its next session rather than stop.
    if (reason !== 'new-session' && reason !== 'idle') this._broadcast({ t: 'unlinked' })
    const record: EndRecord = {
      t: 'end',
      ts: this._relNow(),
      lvl: this._escalation.level,
      reason,
      // The `end` record rides in the next body, so that body's number is the last.
      finalSeq: this._queue.nextSeq,
      counters: {
        ...(this._realm?.counters() ?? NO_COUNTERS),
        ...this._probeOverrun,
        chunksDropped: this._dropped(),
      },
    }
    this._sink.json(record)
  }

  /** Records dropped on the device so far, in this page and its probes. */
  private _dropped(): number {
    return (
      this._queue.droppedRecords +
      (this._realm?.droppedRecords ?? 0) +
      this._forwardRefused +
      (this._links?.dropped() ?? 0)
    )
  }

  /**
   * The control plane outran the collector, in this page or in a probe. Stop
   * collecting rather than degrade: "a short honest record plus an explicit
   * 'I stopped here' is defensible; a long one silently missing control
   * messages is worse than nothing, because it will be trusted." The bodies
   * already sealed still go out.
   *
   * A probe's overrun arrives with where and why, which only its own realm
   * knows; the page's own is already on its realm's counters.
   */
  private _overrun(probe?: Pick<EndCounters, 'overrunAt' | 'overrunSignal'>): void {
    if (this._ended) return
    this._probeOverrun = probe
    this._finish('overrun')
    this._seal(true)
    void this._drain()
  }

  /* ── the interval ─────────────────────────────────────────────────────── */

  private _startInterval(): void {
    const ms = this.config.metrics.intervalMs
    const run = (): void => {
      if (this._ended) return
      try {
        this._tick()
      } catch (err) {
        this._onError(err)
      }
      this._intervalHandle = this._timer(run, ms)
    }
    this._intervalHandle = this._timer(run, ms)
  }

  private _tick(): void {
    const now = this._clock.now()
    this._realm?.tick(now)
    this._customRollup?.tick(now)
    this._escalation.tick(now)
    this._pacer.notePressure({ objectsPerSec: this._realm?.objectRate ?? 0, at: now })
  }

  /**
   * Land the post-event timeout on the second it is due.
   *
   * `_tick` already drives `EscalationController.tick`, but it runs on
   * `metrics.intervalMs` — 10 s by default and a customer setting — so on its
   * own it would close a 15 s window at 20 s and count five seconds nobody
   * captured toward recording minutes. One timer per opened window, cleared on the next one.
   */
  private _scheduleWindowClose(deadlineMono: Mono): void {
    this._cancel(this._windowHandle)
    const delay = Math.max(0, deadlineMono - this._clock.now())
    this._windowHandle = this._timer(() => {
      this._windowHandle = undefined
      if (this._ended) return
      try {
        this._escalation.tick(this._clock.now())
      } catch (err) {
        this._onError(err)
      }
    }, delay)
  }

  /* ── sealing ──────────────────────────────────────────────────────────── */

  /**
   * A seal the schedule or a connection close asked for, then send. `tick`
   * closes the open rollup intervals first; a close has already written its
   * connection's last one.
   */
  private _sealNow(tick: boolean): void {
    if (this._ended) return
    try {
      if (tick) this._tick()
      if (this._seal() !== null) void this._drain()
    } catch (err) {
      this._onError(err)
    }
  }

  /**
   * Seal what is buffered into a numbered, keyed body and put it in the
   * outbox, synchronously. Compression and the stored copy follow on their own.
   */
  private _seal(final = false): Chunk | null {
    if (this._discarded) return null
    let chunk: Chunk | null
    try {
      chunk = this._queue.seal({ final, lost: this._lost, dropped: this._dropped() })
    } catch (err) {
      this._onError(err)
      return null
    }
    if (chunk === null) return null
    this._admit(chunk)
    return chunk
  }

  /**
   * Into the outbox before anything else can stop this: the frames have left
   * the queue, and a body in neither place is lost.
   */
  private _admit(chunk: Chunk): void {
    this._outbox.push(chunk)
    this._lastSealMono = this._clock.now()
    this._prepared.set(chunk, this._prepare(chunk))
    this._capOutbox()
  }

  private async _prepare(chunk: Chunk): Promise<void> {
    try {
      await compress(chunk)
      this._noteBytes(chunk)
      if (this._store !== null && !this._discarded) await this._store.put(chunk, this._dest)
    } catch (err) {
      this._onError(err)
    }
  }

  /**
   * Keep the outbox inside the storage quota. A body pushed out of memory is
   * still sent later if a stored copy exists; without one it is lost, and the
   * next body says so.
   */
  private _capOutbox(): void {
    let bytes = 0
    for (const c of this._outbox) bytes += c.bytes.byteLength
    const cap = Math.max(this.config.storage.quotaBytes, 8 * this.config.upload.byteThreshold)
    while (bytes > cap && this._outbox.length > 1) {
      const dropped = this._outbox.shift() as Chunk
      bytes -= dropped.bytes.byteLength
      if (this._isOwn(dropped) && this._store?.has(dropped.idempotencyKey) !== true) {
        this._noteLost(dropped.seq)
      }
    }
  }

  private _noteBytes(c: Chunk): void {
    if (this._metered.has(c)) return
    this._metered.add(c)
    this._meter.noteBytes(c.level, c.bytes.byteLength)
  }

  private _isOwn(c: Chunk): boolean {
    return c.instanceId === this.instanceId
  }

  private _noteLost(seq: number): void {
    this._lost.push(seq)
    // Bounded. The list is cumulative on every body, and any body that arrives
    // has already told the server about the older entries.
    if (this._lost.length > 256) this._lost.shift()
  }

  /* ── release ──────────────────────────────────────────────────────────── */

  /**
   * The release loop. One at a time; a call while it runs is absorbed by it,
   * since it keeps going until the outbox is empty or an upload fails.
   */
  private _drain(): Promise<void> {
    if (this._pumping !== null) return this._pumping
    const run = this._pump().finally(() => {
      this._pumping = null
      this._urgent = false
    })
    this._pumping = run
    return run
  }

  private async _pump(): Promise<void> {
    const signal = this._life.signal
    while (this._outbox.length > 0 && !signal.aborted) {
      const chunk = this._outbox[0] as Chunk
      await this._prepared.get(chunk)
      if (!this._urgent) {
        const delay = this._pacer.nextReleaseDelayMs()
        if (delay > 0) await this._sleep(delay)
      }
      if (signal.aborted) return
      const outcome = await this._uploader.send(chunk, signal, pageHidden())
      // Addressed to the instance the body came from, by the `i` it carried.
      if (outcome.directive !== undefined && this._isOwn(chunk)) this._obey(outcome)
      if (outcome.ok || outcome.terminal) {
        this._retryDelay = 0
        const at = this._outbox.indexOf(chunk)
        if (at !== -1) this._outbox.splice(at, 1)
        if (outcome.terminal && this._isOwn(chunk)) this._noteLost(chunk.seq)
        if (this._store !== null) await this._store.delete(chunk.idempotencyKey)
        if (!this._isOwn(chunk)) this._releaseInherited()
        continue
      }
      // Kept, at the front. Spinning here would be the congestion the pacer
      // exists to avoid, so the next attempt waits for a seal, `online`, or the
      // backoff.
      this._scheduleRetry()
      return
    }
  }

  /**
   * Do what ingest asked, within bounds: a shorter seal interval while someone
   * watches the session, raised detail while a capture window covers it, and
   * detail held at baseline once the workspace's recording minutes are used up.
   * The hold is read first, so a raise in the same answer is refused. Its times
   * are the server's clock, so they are read against the server's time in the
   * same answer.
   */
  private _obey(outcome: UploadOutcome): void {
    const d = outcome.directive
    if (d === undefined || this._ended) return
    try {
      const serverNow = outcome.serverWallMs ?? this._clock.wall()
      if (d.flushMs !== undefined) {
        const ms = Math.min(DIRECTIVE_FLUSH_MAX_MS, Math.max(DIRECTIVE_FLUSH_MIN_MS, d.flushMs))
        const span = d.until === undefined ? DIRECTIVE_FLUSH_MAX_SPAN_MS : d.until - serverNow
        const forMs = Math.min(DIRECTIVE_FLUSH_MAX_SPAN_MS, span)
        if (forMs > 0) this._schedule.shorten(ms, forMs)
      }
      const h = d.hold
      if (h !== undefined) {
        const forMs = Math.min(DIRECTIVE_HOLD_MAX_SPAN_MS, h.until - serverNow)
        if (forMs > 0) this._escalation.hold(this._clock.now() + forMs)
      }
      const e = d.elevate
      if (e !== undefined) {
        const forMs = Math.min(DIRECTIVE_ELEVATE_MAX_SPAN_MS, e.until - serverNow)
        const level =
          levelIndex(e.level) > levelIndex(DIRECTIVE_ELEVATE_MAX_LEVEL)
            ? DIRECTIVE_ELEVATE_MAX_LEVEL
            : e.level
        if (forMs > 0) this._escalation.remote(level, this._clock.now() + forMs, e.reason)
      }
    } catch (err) {
      this._onError(err)
    }
  }

  /**
   * Drain now, without pacing, and resolve when the outbox is empty, an upload
   * has failed, or `upload.drainDeadlineMs` has passed — whichever is first.
   */
  private async _drainUrgent(): Promise<void> {
    this._urgent = true
    this._wake?.()
    const deadline = deadlineSignal(this.config.upload.drainDeadlineMs)
    try {
      await new Promise<void>((resolve) => {
        deadline.signal?.addEventListener('abort', () => resolve(), { once: true })
        void this._drain().then(resolve, resolve)
      })
    } finally {
      deadline.clear()
    }
  }

  private _scheduleRetry(): void {
    if (this._retryHandle !== undefined || this._life.signal.aborted) return
    this._retryDelay = Math.min(RETRY_MAX_MS, Math.max(RETRY_FIRST_MS, this._retryDelay * 2))
    const delay = Math.round(this._retryDelay * (0.75 + Math.random() * 0.5))
    this._retryHandle = this._timer(() => {
      this._retryHandle = undefined
      void this._drain()
    }, delay)
  }

  private _sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this._wake = resolve
      this._timer(() => resolve(), ms)
    })
  }

  private _timer(fn: () => void, ms: number): unknown {
    return (this._ports.setTimer ?? ((f: () => void, d: number) => setTimeout(f, d)))(fn, ms)
  }

  private _cancel(h: unknown): void {
    if (h !== undefined) (this._ports.clearTimer ?? ((t: unknown) => clearTimeout(t as never)))(h)
  }

  /**
   * Send what earlier page loads stored and could not send: every body bound
   * for this endpoint and key whose instance is gone, from any session. Only
   * once a session has begun: a page that never has one sends nothing.
   */
  private async _sweep(): Promise<void> {
    const store = this._store
    if (store === null) return
    try {
      const held =
        this._persistence === undefined
          ? null
          : await this._persistence.held(this._locks, this._onError)
      const cutoff = this._clock.wall() - SWEEP_AGE_INTERVALS * this.config.upload.intervalMs
      const left = store.backlog(this._dest).filter((e) => {
        if (e.instanceId === this.instanceId) return false
        return held === null ? e.createdWallMs < cutoff : !held.has(e.instanceId)
      })
      const adopted: Chunk[] = []
      for (const e of left) {
        const c = await store.get(e.key)
        if (c !== undefined) adopted.push(c)
      }
      if (adopted.length === 0 || this._discarded) return
      this._outbox = [...adopted, ...this._outbox]
      await this._drain()
    } catch (err) {
      this._onError(err)
    }
  }

  /* ── page lifecycle ───────────────────────────────────────────────────── */

  private _installLifecycle(): void {
    if (this._ports.noLifecycleListeners === true) return
    const g = globalThis as {
      addEventListener?: (t: string, f: (e: unknown) => void, capture?: boolean) => void
    }
    if (typeof g.addEventListener !== 'function') return
    // Closing a tab in Firefox cancels the page's running script, once. A
    // cancel that finds no script running stops the next one, which is the
    // first `pagehide` listener, at its first call. This one takes it: capture
    // listeners run first on the window, ahead of every non-capture one, the
    // page's own included. A cancel that lands later is caught by the second
    // `pagehide` listener below.
    const absorb = (): void => {}
    this._listeners.push(['pagehide', absorb, true])
    g.addEventListener('pagehide', absorb, true)
    const on = (type: string, f: (e: unknown) => void): void => {
      const guarded = (e: unknown): void => {
        try {
          f(e)
        } catch (err) {
          this._onError(err)
        }
      }
      this._listeners.push([type, guarded, false])
      g.addEventListener?.(type, guarded)
    }
    const pagehide = (e: unknown): void =>
      this._pagehide((e as { persisted?: boolean }).persisted === true)
    on('pagehide', pagehide)
    // The same work again, resumed where a cancelled first run stopped; a no-op
    // after a run that finished.
    on('pagehide', pagehide)
    on('pageshow', (e) => {
      if ((e as { persisted?: boolean }).persisted === true) this._pageshow()
    })
    on('visibilitychange', () => this._visibility())
    on('online', () => {
      void this._drain()
    })
  }

  private _visibility(): void {
    if (this._ended || this._armed) return
    if (!pageHidden()) {
      this._writeLife('visible')
      return
    }
    this._writeLife('hidden')
    this._broadcast({ t: 'forward' })
    // A mobile browser may kill a hidden page with no further event, so what
    // it holds leaves now — unless it sealed a moment ago.
    if (this._clock.now() - this._lastSealMono < HIDDEN_SEAL_GAP_MS) return
    this._tick()
    this._seal()
    void this._drainUrgent()
  }

  /**
   * The page is going away, or into the back/forward cache.
   *
   * Synchronous throughout: the page may not survive a single `await`. On a
   * real unload the `end` record is sealed as its own small body and beaconed
   * first, so the one record that says how the instance ended is the likeliest
   * to fit the browser's shared beacon quota; then the tail, then every body
   * still unconfirmed. Each also goes to IndexedDB under the same key, so one
   * the browser refuses is sent by the next page load, and one it takes twice
   * dedupes.
   *
   * A persisted `pagehide` is a page entering the back/forward cache, which may
   * be restored: the tail goes, marked `frozen`, and the instance carries on.
   */
  private _pagehide(persisted: boolean): void {
    // Waiting for a session, a page holds only earlier sessions' bodies.
    if (this._armed) {
      if (this._ended) return
      this._beaconOutbox([])
      if (persisted) this._beaconed.clear()
      return
    }
    if (persisted) {
      if (this._ended || this._frozenAt !== undefined) return
      this._frozenAt = this._clock.now()
      this._escalation.unload()
      this._tick()
      this._writeLife('frozen')
      this._seal()
      this._beaconOutbox([])
      this._beaconed.clear()
      return
    }
    if (this._ended && this._unloadStep === 0) return
    this._unload()
  }

  /**
   * End the instance and send everything, in steps a second call resumes.
   *
   * Firefox can stop a `pagehide` listener at any call, so each step is marked
   * done only once it is, and the second listener picks up from the first
   * unfinished one. A step cut short repeats: at worst a record or a body goes
   * twice, which ingest dedupes, rather than not at all.
   */
  private _unload(): void {
    if (this._unloadStep === 0) {
      this._escalation.unload()
      this._tick()
      this._seal()
      this._unloadStep = 1
    }
    if (this._unloadStep === 1) {
      this._finish('unload')
      this._unloadStep = 2
    }
    if (this._unloadStep === 2) {
      this._endBody = this._seal(true)
      this._unloadStep = 3
    }
    if (this._unloadStep === 3) {
      // A seal that failed left the `end` record buffered; one more try.
      this._endBody ??= this._seal(true)
      this._beaconOutbox(this._endBody === null ? [] : [this._endBody])
      this._unloadStep = 4
    }
    if (this._unloadStep === 4) {
      this._teardown()
      this._unloadStep = 5
    }
  }

  private _pageshow(): void {
    const at = this._frozenAt
    if (at === undefined || this._ended) return
    this._frozenAt = undefined
    this._writeLife('resumed', Math.round(this._clock.now() - at))
  }

  /** Beacon `first`, then every other body in the outbox, newest last; store each one. */
  private _beaconOutbox(first: readonly Chunk[]): void {
    const rest = this._outbox.filter((c) => !first.includes(c))
    for (const chunk of [...first, ...rest]) {
      if (this._beaconed.has(chunk)) continue
      const outcome = sendTail(this.config.endpoint, chunk.bytes, {
        maxBytes: Math.min(this.config.upload.beaconMaxBytes, BEACON_MAX_BYTES),
        apiKey: this.config.apiKey,
        idempotencyKey: chunk.idempotencyKey,
        instanceId: chunk.instanceId,
        ...(this._ports.beacon !== undefined ? { beacon: this._ports.beacon } : {}),
        ...(this._ports.fetchImpl !== undefined ? { fetchImpl: this._ports.fetchImpl } : {}),
        onInternalError: this._onError,
      })
      this._beaconed.add(chunk)
      // Metered only once something took it: ingest, the actual meter, never
      // sees a body nothing accepted.
      if (outcome !== false) this._noteBytes(chunk)
      if (this._store !== null) void this._store.put(chunk, this._dest)
    }
  }

  /* ── teardown ─────────────────────────────────────────────────────────── */

  /**
   * Stop every timer and listener, end uploads in flight, release the locks,
   * and restore the global, unless the next session in this page keeps the
   * hook.
   */
  private _teardown(opts: { keepHook?: boolean } = {}): void {
    this._ended = true
    this._realm?.detach()
    this._schedule.stop()
    this._life.abort()
    this._wake?.()
    for (const h of [
      this._intervalHandle,
      this._windowHandle,
      this._retryHandle,
      this._idleHandle,
    ]) {
      this._cancel(h)
    }
    this._links?.teardown()
    this._intervalHandle = undefined
    this._windowHandle = undefined
    this._retryHandle = undefined
    this._idleHandle = undefined
    const g = globalThis as {
      removeEventListener?: (t: string, f: (e: unknown) => void, capture?: boolean) => void
    }
    for (const [type, f, capture] of this._listeners) g.removeEventListener?.(type, f, capture)
    this._listeners = []
    this._releaseLock()
    for (const release of this._inheritedLocks.values()) release()
    this._inheritedLocks.clear()
    this._realm?.clear()
    if (opts.keepHook === true) return
    try {
      this._hook?.uninstall()
    } catch (err) {
      this._onError(err)
    }
  }

  private _relNow(): Mono {
    return this._clock.now() - this.anchor.originMono
  }
}

/** Whether the page is hidden. `false` where there is no document. */
function pageHidden(): boolean {
  const d = (globalThis as { document?: { visibilityState?: string } }).document
  return d?.visibilityState === 'hidden'
}
