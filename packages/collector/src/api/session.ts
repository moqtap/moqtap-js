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
  deadlineSignal,
  FlushQueue,
  FlushSchedule,
  heldInstances,
  holdInstanceLock,
  type LockManagerLike,
  platformLocks,
  ReleasePacer,
  sendTail,
  Uploader,
} from '../flush/index.js'
import type { TriggerEvent } from '../recorder/index.js'
import { CustomMetrics, RollupEngine } from '../rollup/index.js'
import { connectionIdOf, type TransportHook } from '../transport/index.js'
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
import { EscalationController } from './escalation.js'
import {
  type CallMessage,
  type DeflatePart,
  envelope,
  type ForwardMessage,
  HEARTBEAT_MS,
  type LinkedMessage,
  linkMessage,
  type PageMessage,
  SILENCE_MS,
} from './link.js'
import { UsageMeter } from './meter.js'
import { type ConnectionSnapshot, type ConnectionState, RealmObserver } from './realm.js'

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
   * The clock anchor of the session this one follows in the same page. A page
   * keeps one timeline across its sessions, so a linked probe's clock offset
   * stays valid when it follows the page into the next one.
   */
  readonly anchor?: ClockAnchor
  /** `CollectorConfig.onInternalError`, which `ResolvedConfig` deliberately omits. */
  readonly onInternalError?: (err: unknown) => void
}

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

/** One `linkWorker()` call. */
interface Link {
  readonly id: string
  readonly target: MessageTarget
  /**
   * The runtime this link reports into. Every handler the link installed reads
   * it at the time of the call, so the link follows the page into a new
   * session without touching the customer's worker.
   */
  owner: CollectorRuntime
  state: 'waiting' | 'linked' | 'timeout' | 'gone'
  port: MessagePort | null
  lastHeard: Mono
  ready: boolean
  /** Records the probe reported dropped, cumulative. */
  dropped: number
  /** Its open connections as of the last forward. */
  conns: readonly ConnectionSnapshot[]
  /** `terminate()` was called on it: gone for good, whatever arrives after. */
  terminated: boolean
  timeout: unknown
  onHello: ((e: LinkEvent) => void) | undefined
}

export class CollectorRuntime {
  readonly config: ResolvedConfig
  readonly anchor: ClockAnchor
  readonly instanceId: string

  readonly #clock: ClockSource
  readonly #ports: RuntimePorts
  readonly #onError: (err: unknown) => void
  readonly #hook: TransportHook
  readonly #drafts: DraftSet
  readonly #dest: ChunkDestination
  readonly #locks: LockManagerLike | undefined

  readonly #realm: RealmObserver
  readonly #custom: CustomMetrics
  /** Customer metrics belong to no connection, so they have an engine of their own. */
  readonly #customRollup: RollupEngine
  readonly #queue: FlushQueue
  readonly #schedule: FlushSchedule
  readonly #pacer: ReleasePacer
  readonly #uploader: Uploader
  readonly #meter: UsageMeter
  readonly #escalation: EscalationController
  readonly #store: ChunkStore | null
  /**
   * Every record the page writes goes through here, so the instance's setup
   * record is always the first frame of its first body. A page that never
   * records anything never sends anything.
   */
  readonly #sink: RecordSink & { readonly pendingBytes: number }
  /** Aborted at teardown: ends any upload still in flight. */
  readonly #life = new AbortController()

  /** Sealed bodies awaiting an answer, oldest first; bodies swept from storage go first of all. */
  #outbox: Chunk[] = []
  /** Compression and the stored copy of each body, which a send waits for. */
  readonly #prepared = new WeakMap<Chunk, Promise<void>>()
  /** Bodies already counted in `usage()`, so a body both beaconed and prepared counts once. */
  readonly #metered = new WeakSet<Chunk>()
  /** This instance's bodies that will never arrive. */
  readonly #lost: number[] = []
  #pumping: Promise<void> | null = null
  #urgent = false
  #wake: (() => void) | undefined
  #retryHandle: unknown
  #retryDelay = 0
  #lastSealMono: Mono
  #forwardRefused = 0

  #links: Link[] = []
  #linkTimer: unknown
  /**
   * Instance locks of earlier sessions in this page, held while their bodies
   * are still in this outbox, so no other page load sweeps them meanwhile.
   */
  readonly #inheritedLocks = new Map<string, () => void>()
  /** What `ids()` and connections opened from now on carry. `setContext()` changes it. */
  readonly #context: {
    actorId: string
    contentId: string
    tags: Readonly<Record<string, string>>
  }

  #setupSent = false
  /** When this session began on an inherited anchor; `undefined` when the anchor is its own. */
  #startTs: number | undefined
  #ended = false
  #discarded = false
  #releaseLock: () => void = () => {}
  #intervalHandle: unknown
  /** The one-shot timer landing the post-event timeout on time. See `#scheduleWindowClose`. */
  #windowHandle: unknown
  #listeners: [string, (e: unknown) => void, boolean][] = []
  #frozenAt: Mono | undefined
  /** How far an unload got; see `#unload`. */
  #unloadStep: 0 | 1 | 2 | 3 | 4 | 5 = 0
  #endBody: Chunk | null = null
  /** Bodies handed to the platform at `pagehide`, so a resumed unload sends each once. */
  readonly #beaconed = new Set<Chunk>()
  #probeOverrun: Pick<EndCounters, 'overrunAt' | 'overrunSignal'> | undefined

  constructor(
    config: ResolvedConfig,
    hook: TransportHook,
    drafts: DraftSet,
    ports: RuntimePorts = {},
  ) {
    this.config = config
    this.#ports = ports
    this.#hook = hook
    this.#drafts = drafts
    this.#context = {
      actorId: config.context.actorId,
      contentId: config.context.contentId,
      tags: config.context.tags,
    }
    this.#clock = ports.clock ?? platformClock
    this.#onError = (err: unknown): void => {
      try {
        ports.onInternalError?.(err)
      } catch {
        // An error handler that throws is where reporting stops.
      }
    }
    this.anchor = ports.anchor ?? {
      originMono: this.#clock.now(),
      originWall: this.#clock.wall(),
    }
    if (ports.anchor !== undefined) this.#startTs = this.#clock.now() - ports.anchor.originMono
    this.instanceId = ports.instanceId ?? mintId()
    this.#lastSealMono = this.#clock.now()
    this.#dest = { endpoint: config.endpoint, keyHash: sha256Hex(config.apiKey) }
    this.#locks = ports.locks === null ? undefined : (ports.locks ?? platformLocks())

    // Every record is stamped session-relative: the queue's batch frame here,
    // and every other record by whoever writes it, against the same anchor.
    const relClock: ClockSource = {
      now: () => this.#clock.now() - this.anchor.originMono,
      wall: () => this.#clock.wall(),
    }

    this.#meter = new UsageMeter(this.#clock)
    this.#store = ports.store ?? null

    this.#queue = new FlushQueue({
      sessionId: config.sessionId,
      instanceId: this.instanceId,
      clock: relClock,
      level: () => this.#escalation.level,
      maxPendingBytes: 8 * config.upload.byteThreshold,
      onInternalError: this.#onError,
    })
    const queue = this.#queue
    this.#sink = {
      json: (r: EnvelopeRecord): void => {
        if (this.#discarded) return
        this.#ensureSetup()
        queue.json(r)
      },
      raw: (b: Uint8Array): void => {
        if (!this.#discarded) queue.raw(b)
      },
      get pendingBytes(): number {
        return queue.pendingBytes
      },
    }

    this.#realm = new RealmObserver({
      realm: 'page',
      config,
      hook,
      drafts,
      originMono: this.anchor.originMono,
      clock: this.#clock,
      host: {
        sink: this.#sink,
        level: () => this.#escalation.level,
        onTrigger: (e: TriggerEvent) => this.#escalation.onTrigger(e.kind, e.atMono, e.key),
        onConnReady: () => this.#schedule.ready(this.#clock.now()),
        onConnClosed: () => this.#sealNow(false),
        onOverrun: () => this.#overrun(),
        onPressure: (p) => this.#pacer.notePressure(p),
        onBytes: (n) => this.#schedule.noteBytes(n),
        onError: this.#onError,
      },
    })

    this.#custom = new CustomMetrics({ onError: (m) => this.#onError(new Error(m)) })
    this.#customRollup = new RollupEngine({
      intervalMs: config.metrics.intervalMs,
      maxBuckets: 1,
      clock: this.#clock,
      sink: this.#sink,
      originMono: this.anchor.originMono,
      custom: this.#custom,
    })

    this.#escalation = new EscalationController({
      configured: config.detail,
      ceilingMinutes: config.budget.elevatedMinutes,
      windowMs: config.flightRecorder.windowMs,
      meter: this.#meter,
      clock: this.#clock,
      anchor: this.anchor,
      sink: this.#sink,
      // The "ring filling" close condition. The ring is only written to while
      // the recorder is armed, so on a session with no triggers configured — the
      // default — this never advances and never closes anything.
      ring: {
        capacityBytes: this.#realm.ring.maxBytes,
        evictedBytes: () => this.#realm.ring.evictedBytes,
      },
      onWindowOpen: (deadline) => this.#scheduleWindowClose(deadline),
      onLevelChange: (level) => this.#broadcast({ t: 'level', level }),
    })

    this.#uploader = new Uploader({
      endpoint: config.endpoint,
      apiKey: config.apiKey,
      maxAttempts: config.upload.maxAttempts,
      // `fetch` has no timeout, so without this one blackholed request is
      // pending for the life of the page, and the outbox behind it with it.
      timeoutMs: config.upload.timeoutMs,
      ...(ports.fetchImpl !== undefined ? { fetchImpl: ports.fetchImpl } : {}),
      onInternalError: this.#onError,
    })
    this.#pacer = new ReleasePacer({
      // The pacer shapes only the DELAY between releases; it can never seal
      // less often. The ceiling is one flush interval, so a fully congested
      // session still releases roughly as often as it seals.
      minIntervalMs: 0,
      maxIntervalMs: config.upload.intervalMs,
    })
    this.#schedule = new FlushSchedule({
      onFlush: () => this.#sealNow(true),
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

  start(): void {
    this.#begin()
    void this.#sweep()
  }

  #begin(): void {
    this.#releaseLock = holdInstanceLock(this.#locks, this.instanceId, this.#onError)
    this.#realm.start()
    this.#schedule.start(this.#clock.now())
    this.#startInterval()
    this.#installLifecycle()
  }

  /* ── the public verbs ─────────────────────────────────────────────────── */

  ids(): Identity {
    const ctx = this.#context
    return {
      sessionId: this.config.sessionId,
      instanceId: this.instanceId,
      ...(ctx.actorId !== '' ? { actorId: ctx.actorId } : {}),
      ...(ctx.contentId !== '' ? { contentId: ctx.contentId } : {}),
    }
  }

  /** The connection id of a `WebTransport` this page created. */
  connectionIdOf(transport: unknown): string | undefined {
    return connectionIdOf(transport)
  }

  /** Every connection seen in this page and its linked workers, open ones first. */
  connections(): ConnectionState[] {
    const page = this.#realm.connections()
    const workers: ConnectionState[] = []
    for (const l of this.#links) for (const s of l.conns) workers.push(s.conn)
    const all = [...page, ...workers]
    return [...all.filter((c) => c.state !== 'closed'), ...all.filter((c) => c.state === 'closed')]
  }

  usage(): UsageReport {
    return this.#meter.report()
  }

  get ended(): boolean {
    return this.#ended
  }

  escalate(level: DetailLevel, reason?: string): void {
    if (this.#ended) return
    this.#escalation.escalate(level, reason)
  }

  /**
   * The incident is over. Closes the open capture window.
   *
   * Harmless when none is open, because this is called from the customer's own
   * error handling and will be called for incidents that never escalated.
   */
  resolve(reason?: string): void {
    if (this.#ended) return
    this.#escalation.resolve(reason)
  }

  annotate(name: string, data: unknown, connectionId?: string): void {
    if (this.#ended || this.#realm.halted) return
    this.#sink.json({
      t: 'note',
      ts: this.#relNow(),
      lvl: this.#escalation.level,
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
    if (this.#ended) return
    const c = this.#context
    const record: { -readonly [K in keyof ContextRecord]: ContextRecord[K] } = {
      t: 'context',
      ts: this.#relNow(),
      lvl: this.#escalation.level,
    }
    if (typeof ctx.contentId === 'string') {
      c.contentId = ctx.contentId
      this.#realm.setContentId(ctx.contentId)
      this.#broadcast({ t: 'context', contentId: ctx.contentId })
      if (ctx.contentId !== '') record.contentId = ctx.contentId
    }
    if (typeof ctx.actorId === 'string') {
      c.actorId = sentActorId(ctx.actorId, this.config)
      if (c.actorId !== '') record.actorId = c.actorId
    }
    if (ctx.tags !== undefined) {
      const { merged, accepted } = addTags(c.tags, ctx.tags, (p) => this.#report(p))
      c.tags = merged
      if (Object.keys(accepted).length > 0) record.tags = accepted
    }
    if (
      record.contentId !== undefined ||
      record.actorId !== undefined ||
      record.tags !== undefined
    ) {
      this.#sink.json(record)
    }
  }

  /** A rejected argument, in the form `init()` reports a rejected option. */
  #report(p: ConfigProblem): void {
    this.#onError(new Error(`${p.code}: ${p.key}${p.got === undefined ? '' : ` ${p.got}`}`))
  }

  defineMetric(name: string, d: Parameters<CustomMetrics['defineMetric']>[1]): void {
    this.#custom.defineMetric(name, d)
  }

  observe(name: string, value: number, labels?: Record<string, string>): void {
    if (labels === undefined) this.#custom.observe(name, value)
    else this.#custom.observe(name, value, labels)
  }

  /**
   * Seal everything recorded so far and send it. Resolves when ingest has
   * answered or `upload.drainDeadlineMs` has passed, with anything unsent
   * still queued and stored for retry. Ends nothing.
   */
  async flush(): Promise<void> {
    if (this.#ended) return
    this.#broadcast({ t: 'forward' })
    this.#tick()
    this.#seal()
    await this.#drainUrgent()
  }

  /**
   * End this instance: report its open connections closed, write `end{app}`,
   * send everything, and restore the patched global.
   */
  async end(): Promise<void> {
    if (this.#ended) return
    this.#finish('app')
    this.#seal(true)
    try {
      await this.#drainUrgent()
      // Whatever is still unsent keeps its stored copy for the next page load.
      await Promise.all(this.#outbox.map((c) => this.#prepared.get(c)))
    } finally {
      this.#teardown()
      this.#store?.close()
    }
  }

  /**
   * Drop everything unsent, stored copies included, and tear down.
   * **Transmits nothing**, from the first line on.
   */
  async discard(): Promise<void> {
    if (this.#discarded) return
    this.#discarded = true
    this.#ended = true
    this.#realm.detach()
    const unsent = this.#outbox
    this.#outbox = []
    this.#teardown()
    if (this.#store !== null) {
      try {
        // The outbox can hold bodies of earlier sessions in this page and of
        // earlier page loads; consent covers those too. Their stored copies may
        // still be being written, so each is deleted once it is.
        await Promise.all(unsent.map((c) => this.#prepared.get(c)))
        for (const c of unsent) await this.#store.delete(c.idempotencyKey)
        await this.#store.clearSession(this.config.sessionId)
      } catch (err) {
        this.#onError(err)
      }
      this.#store.close()
    }
  }

  /**
   * End this session and start the next one in this page, which takes over
   * the transport hook, the store, every worker link and every body not yet
   * sent. `null` once this instance has ended.
   *
   * Synchronous, like the seal: the old session's last body is numbered and
   * keyed before this returns. A probe forward already on its way lands in
   * the new session.
   */
  successor(next: ResolvedConfig, instanceId: string): CollectorRuntime | null {
    if (this.#ended) return null
    this.#finish('new-session')
    this.#seal(true)
    const runtime = new CollectorRuntime(next, this.#hook, this.#drafts, {
      ...this.#ports,
      instanceId,
      anchor: this.anchor,
    })
    // The session's tags so far, `setContext()`'s included, go on with it.
    runtime.#context.tags = this.#context.tags
    const outbox = this.#outbox
    // Every link, gone ones included: a worker silent past the limit is linked
    // again when it speaks, and the ids `w1, w2 …` stay unique in the page.
    const links = this.#links
    const locks = new Map(this.#inheritedLocks)
    locks.set(this.instanceId, this.#releaseLock)
    this.#outbox = []
    this.#links = []
    this.#inheritedLocks.clear()
    this.#releaseLock = () => {}
    this.#teardown({ keepHook: true })
    runtime.#adopt(this, outbox, links, locks)
    return runtime
  }

  /** Take over what {@link successor} hands on, and start. */
  #adopt(
    from: CollectorRuntime,
    outbox: readonly Chunk[],
    links: readonly Link[],
    locks: ReadonlyMap<string, () => void>,
  ): void {
    for (const c of outbox) {
      const prepared = from.#prepared.get(c)
      if (prepared !== undefined) this.#prepared.set(c, prepared)
      if (from.#metered.has(c)) this.#metered.add(c)
    }
    this.#outbox = [...outbox, ...this.#outbox]
    for (const [id, release] of locks) this.#inheritedLocks.set(id, release)
    this.#begin()
    for (const link of links) {
      link.owner = this
      link.conns = []
      link.ready = false
      this.#links.push(link)
      if (link.state === 'linked') this.#writeLink(link, 'linked')
      try {
        link.port?.postMessage(
          envelope<PageMessage>({
            t: 'session',
            sessionId: this.config.sessionId,
            instanceId: this.instanceId,
            level: this.#escalation.level,
          }),
        )
      } catch (err) {
        this.#onError(err)
      }
    }
    if (this.#links.length > 0) this.#startLinkTimer()
    this.#releaseInherited()
    if (this.#outbox.length > 0) void this.#drain()
  }

  /** Let go of an earlier session's lock once none of its bodies is left to send. */
  #releaseInherited(): void {
    for (const [id, release] of this.#inheritedLocks) {
      if (this.#outbox.some((c) => c.instanceId === id)) continue
      this.#inheritedLocks.delete(id)
      release()
    }
  }

  /* ── worker links ─────────────────────────────────────────────────────── */

  /**
   * Answer `target`'s hello, and report the link either way.
   *
   * Not automatic, and that is a security decision rather than an omission:
   * the page cannot enumerate its workers, and a `message` listener on the
   * page's own global would also hear cross-origin `postMessage` from any frame
   * or opener. So the customer names the target, and only it is answered.
   *
   * `hello` is one the target sent before this runtime was running, heard on
   * its behalf.
   */
  linkWorker(target: MessageTarget, hello?: LinkEvent): void {
    if (this.#ended || this.#links.some((l) => l.target === target)) return
    const link: Link = {
      id: `w${this.#links.length + 1}`,
      target,
      owner: this,
      state: 'waiting',
      port: null,
      lastHeard: this.#clock.now(),
      ready: false,
      dropped: 0,
      conns: [],
      terminated: false,
      timeout: undefined,
      onHello: undefined,
    }
    this.#links.push(link)
    const set = this.#ports.setTimer ?? ((fn: () => void, d: number) => setTimeout(fn, d))
    link.timeout = set(() => {
      const owner = link.owner
      if (link.state !== 'waiting' || owner.#ended) return
      link.state = 'timeout'
      owner.#writeLink(link, 'timeout')
    }, this.config.limits.linkTimeoutMs)
    this.#wrapTerminate(link)
    const onHello = (e: LinkEvent): void => {
      const m = linkMessage(e.data)
      if (m === null || m.t !== 'hello' || typeof m.timeOrigin !== 'number') return
      link.owner.#answer(link, m.timeOrigin)
    }
    link.onHello = onHello
    try {
      target.addEventListener('message', onHello)
      target.start?.()
    } catch (err) {
      this.#onError(err)
    }
    this.#startLinkTimer()
    if (hello !== undefined) onHello(hello)
  }

  #answer(link: Link, workerTimeOrigin: number): void {
    if (this.#ended || link.port !== null) return
    let channel: MessageChannel
    try {
      channel = new MessageChannel()
    } catch (err) {
      this.#onError(err)
      return
    }
    const port = channel.port1
    link.port = port
    port.onmessage = (e: MessageEvent) => link.owner.#fromProbe(link, e.data)
    const pageTimeOrigin = this.#ports.timeOrigin ?? performance.timeOrigin
    const linked: LinkedMessage = {
      t: 'linked',
      sessionId: this.config.sessionId,
      instanceId: this.instanceId,
      base: pageTimeOrigin + this.anchor.originMono - workerTimeOrigin,
      level: this.#escalation.level,
      config: {
        metrics: this.config.metrics,
        flightRecorder: this.config.flightRecorder,
        limits: this.config.limits,
        privacy: this.config.privacy,
        upload: this.config.upload,
        context: { ...this.config.context, ...this.#context },
      },
    }
    try {
      link.target.postMessage(envelope(linked), [channel.port2])
    } catch (err) {
      this.#onError(err)
      return
    }
    this.#heard(link)
  }

  #fromProbe(link: Link, data: unknown): void {
    if (this.#ended) return
    const m = linkMessage(data) as (ForwardMessage | CallMessage) | null
    if (m === null) return
    try {
      this.#heard(link)
      switch (m.t) {
        case 'fwd':
          this.#forwarded(link, m)
          return
        case 'annotate':
          this.annotate(m.name, m.data, m.conn)
          return
        case 'observe':
          this.observe(m.name, m.value, m.labels)
          return
        case 'escalate':
          this.escalate(m.level, m.reason)
          return
        case 'resolve':
          this.resolve(m.reason)
          return
        case 'trigger':
          this.#escalation.onTrigger(m.kind, m.at + this.anchor.originMono, m.key)
          return
        case 'overrun':
          this.#overrun({ overrunAt: m.at, overrunSignal: m.signal })
          return
      }
    } catch (err) {
      this.#onError(err)
    }
  }

  /**
   * A probe spoke: it is linked, and alive. A message a terminated worker
   * posted before it died is still taken, but does not bring the link back.
   */
  #heard(link: Link): void {
    link.lastHeard = this.#clock.now()
    if (link.state === 'linked' || link.terminated) return
    link.state = 'linked'
    this.#writeLink(link, 'linked')
  }

  #forwarded(link: Link, m: ForwardMessage): void {
    link.dropped = Math.max(link.dropped, m.dropped)
    // A terminated worker's connections were reported closed when it went.
    if (!link.terminated) link.conns = m.conns
    if (m.ready && !link.ready) {
      link.ready = true
      this.#schedule.ready(this.#clock.now())
    }
    if (m.parts === undefined || m.n === 0) return
    this.#ensureSetup()
    for (const part of m.parts) {
      if ('deflate' in part) {
        this.#sealSegment(part)
        continue
      }
      const frames = new Uint8Array(part.frames, 0, part.byteLength)
      if (this.#queue.append(frames, part.n)) this.#schedule.noteBytes(frames.byteLength)
      else this.#forwardRefused += part.n
    }
  }

  /**
   * Frames a probe compressed: the end of a body of their own, sealed now
   * behind what the page has buffered, and sent. Nothing is inflated or
   * compressed here.
   */
  #sealSegment(part: DeflatePart): void {
    if (this.#discarded) return
    if (this.#queue.pendingBytes > SEGMENT_PREFIX_MAX_BYTES) this.#seal()
    let chunk: Chunk
    try {
      chunk = this.#queue.sealSegment(
        {
          deflate: new Uint8Array(part.deflate, 0, part.byteLength),
          crc: part.crc,
          size: part.size,
        },
        { lost: this.#lost, dropped: this.#dropped() },
      )
    } catch (err) {
      this.#onError(err)
      this.#forwardRefused += part.n
      return
    }
    this.#admit(chunk)
    void this.#drain()
  }

  /**
   * The worker is gone: terminated, or silent past {@link SILENCE_MS}. Its open
   * connections are reported closed with what its last forward said about them.
   * If it speaks again, it is linked again and its connections continue.
   */
  #workerGone(link: Link): void {
    if (link.state !== 'linked' || this.#ended) return
    link.state = 'gone'
    this.#writeLink(link, 'gone')
    this.#closeForwarded(link, 'worker-gone')
    link.conns = []
    this.#sealNow(false)
  }

  /** Report a link's open connections closed, from its last forward. */
  #closeForwarded(link: Link, cause: 'worker-gone' | 'session-end'): void {
    const ts = this.#relNow()
    for (const s of link.conns) {
      if (s.conn.state === 'closed') continue
      if (s.rollup !== null) this.#sink.json(s.rollup)
      this.#sink.json({
        t: 'conn-close',
        ts,
        lvl: this.#escalation.level,
        conn: s.conn.id,
        cause,
        counters: s.counters,
      })
    }
  }

  /**
   * Notice `terminate()` on this one `Worker` object the moment it is called,
   * without touching `Worker.prototype`. A call that bypasses the instance —
   * `Worker.prototype.terminate.call(w)` — is caught by the silence check.
   */
  #wrapTerminate(link: Link): void {
    const w = link.target as { terminate?: unknown }
    const original = w.terminate
    if (typeof original !== 'function') return
    const gone = (): void => {
      link.terminated = true
      link.owner.#workerGone(link)
    }
    try {
      w.terminate = function terminate(this: unknown, ...args: unknown[]): unknown {
        try {
          gone()
        } catch {
          // Reporting never stands between the page and its own call.
        }
        return (original as (...a: unknown[]) => unknown).apply(this, args)
      }
    } catch (err) {
      this.#onError(err)
    }
  }

  #startLinkTimer(): void {
    if (this.#linkTimer !== undefined) return
    const set = this.#ports.setTimer ?? ((fn: () => void, d: number) => setTimeout(fn, d))
    const run = (): void => {
      if (this.#ended) return
      const now = this.#clock.now()
      for (const l of this.#links) {
        if (l.state === 'linked' && now - l.lastHeard > SILENCE_MS) this.#workerGone(l)
      }
      this.#linkTimer = set(run, HEARTBEAT_MS)
    }
    this.#linkTimer = set(run, HEARTBEAT_MS)
  }

  #broadcast(m: PageMessage): void {
    for (const l of this.#links) {
      if (l.port === null) continue
      try {
        l.port.postMessage(envelope(m))
      } catch (err) {
        this.#onError(err)
      }
    }
  }

  #writeLink(link: Link, ev: LinkRecord['ev']): void {
    this.#sink.json({
      t: 'link',
      ts: this.#relNow(),
      lvl: this.#escalation.level,
      link: link.id,
      ev,
    })
  }

  /* ── records ──────────────────────────────────────────────────────────── */

  #ensureSetup(): void {
    if (this.#setupSent) return
    this.#setupSent = true
    const ctx = this.config.context
    const tags = this.#context.tags
    const record: SetupRecord = {
      t: 'setup',
      ts: this.#relNow(),
      lvl: this.#escalation.level,
      anchor: this.anchor,
      identity: this.ids(),
      idSource: this.config.idSource,
      collectorVersion: COLLECTOR_VERSION,
      ...(ctx.environment !== '' ? { environment: ctx.environment } : {}),
      ...(ctx.release !== '' ? { release: ctx.release } : {}),
      ...(Object.keys(tags).length > 0 ? { tags } : {}),
      ...(this.#startTs !== undefined ? { startTs: this.#startTs } : {}),
    }
    this.#queue.json(record)
  }

  #writeLife(ev: LifeRecord['ev'], gapMs?: number): void {
    this.#sink.json({
      t: 'life',
      ts: this.#relNow(),
      lvl: this.#escalation.level,
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
  #finish(reason: EndRecord['reason']): void {
    this.#ended = true
    const now = this.#clock.now()
    this.#realm.detach()
    this.#schedule.stop()
    this.#escalation.close()
    this.#seal()
    this.#realm.closeAll('session-end', now)
    for (const l of this.#links) this.#closeForwarded(l, 'session-end')
    this.#customRollup.tick(now)
    // Probes follow the page into its next session rather than stop.
    if (reason !== 'new-session') this.#broadcast({ t: 'unlinked' })
    const record: EndRecord = {
      t: 'end',
      ts: this.#relNow(),
      lvl: this.#escalation.level,
      reason,
      // The `end` record rides in the next body, so that body's number is the last.
      finalSeq: this.#queue.nextSeq,
      counters: {
        ...this.#realm.counters(),
        ...this.#probeOverrun,
        chunksDropped: this.#dropped(),
      },
    }
    this.#sink.json(record)
  }

  /** Records dropped on the device so far, in this page and its probes. */
  #dropped(): number {
    let n = this.#queue.droppedRecords + this.#realm.droppedRecords + this.#forwardRefused
    for (const l of this.#links) n += l.dropped
    return n
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
  #overrun(probe?: Pick<EndCounters, 'overrunAt' | 'overrunSignal'>): void {
    if (this.#ended) return
    this.#probeOverrun = probe
    this.#finish('overrun')
    this.#seal(true)
    void this.#drain()
  }

  /* ── the interval ─────────────────────────────────────────────────────── */

  #startInterval(): void {
    const ms = this.config.metrics.intervalMs
    const set = this.#ports.setTimer ?? ((fn: () => void, d: number) => setTimeout(fn, d))
    const run = (): void => {
      if (this.#ended) return
      try {
        this.#tick()
      } catch (err) {
        this.#onError(err)
      }
      this.#intervalHandle = set(run, ms)
    }
    this.#intervalHandle = set(run, ms)
  }

  #tick(): void {
    const now = this.#clock.now()
    this.#realm.tick(now)
    this.#customRollup.tick(now)
    this.#escalation.tick(now)
    this.#pacer.notePressure({ objectsPerSec: this.#realm.objectRate, at: now })
  }

  /**
   * Land the post-event timeout on the second it is due.
   *
   * `#tick` already drives `EscalationController.tick`, but it runs on
   * `metrics.intervalMs` — 10 s by default and a customer setting — so on its
   * own it would close a 15 s window at 20 s and bill five seconds nobody
   * captured. One timer per opened window, cleared on the next one.
   */
  #scheduleWindowClose(deadlineMono: Mono): void {
    const set = this.#ports.setTimer ?? ((fn: () => void, d: number) => setTimeout(fn, d))
    const clear = this.#ports.clearTimer ?? ((h: unknown) => clearTimeout(h as never))
    if (this.#windowHandle !== undefined) clear(this.#windowHandle)
    const delay = Math.max(0, deadlineMono - this.#clock.now())
    this.#windowHandle = set(() => {
      this.#windowHandle = undefined
      if (this.#ended) return
      try {
        this.#escalation.tick(this.#clock.now())
      } catch (err) {
        this.#onError(err)
      }
    }, delay)
  }

  /* ── sealing ──────────────────────────────────────────────────────────── */

  /**
   * A seal the schedule or a connection close asked for, then send. `tick`
   * closes the open rollup intervals first; a close has already written its
   * connection's last one.
   */
  #sealNow(tick: boolean): void {
    if (this.#ended) return
    try {
      if (tick) this.#tick()
      if (this.#seal() !== null) void this.#drain()
    } catch (err) {
      this.#onError(err)
    }
  }

  /**
   * Seal what is buffered into a numbered, keyed body and put it in the
   * outbox, synchronously. Compression and the stored copy follow on their own.
   */
  #seal(final = false): Chunk | null {
    if (this.#discarded) return null
    let chunk: Chunk | null
    try {
      chunk = this.#queue.seal({ final, lost: this.#lost, dropped: this.#dropped() })
    } catch (err) {
      this.#onError(err)
      return null
    }
    if (chunk === null) return null
    this.#admit(chunk)
    return chunk
  }

  /**
   * Into the outbox before anything else can stop this: the frames have left
   * the queue, and a body in neither place is lost.
   */
  #admit(chunk: Chunk): void {
    this.#outbox.push(chunk)
    this.#lastSealMono = this.#clock.now()
    this.#prepared.set(chunk, this.#prepare(chunk))
    this.#capOutbox()
  }

  async #prepare(chunk: Chunk): Promise<void> {
    try {
      await compress(chunk)
      this.#noteBytes(chunk)
      if (this.#store !== null && !this.#discarded) await this.#store.put(chunk, this.#dest)
    } catch (err) {
      this.#onError(err)
    }
  }

  /**
   * Keep the outbox inside the storage quota. A body pushed out of memory is
   * still sent later if a stored copy exists; without one it is lost, and the
   * next body says so.
   */
  #capOutbox(): void {
    let bytes = 0
    for (const c of this.#outbox) bytes += c.bytes.byteLength
    const cap = Math.max(this.config.storage.quotaBytes, 8 * this.config.upload.byteThreshold)
    while (bytes > cap && this.#outbox.length > 1) {
      const dropped = this.#outbox.shift() as Chunk
      bytes -= dropped.bytes.byteLength
      if (this.#isOwn(dropped) && this.#store?.has(dropped.idempotencyKey) !== true) {
        this.#noteLost(dropped.seq)
      }
    }
  }

  #noteBytes(c: Chunk): void {
    if (this.#metered.has(c)) return
    this.#metered.add(c)
    this.#meter.noteBytes(c.level, c.bytes.byteLength)
  }

  #isOwn(c: Chunk): boolean {
    return c.instanceId === this.instanceId
  }

  #noteLost(seq: number): void {
    this.#lost.push(seq)
    // Bounded. The list is cumulative on every body, and any body that arrives
    // has already told the server about the older entries.
    if (this.#lost.length > 256) this.#lost.shift()
  }

  /* ── release ──────────────────────────────────────────────────────────── */

  /**
   * The release loop. One at a time; a call while it runs is absorbed by it,
   * since it keeps going until the outbox is empty or an upload fails.
   */
  #drain(): Promise<void> {
    if (this.#pumping !== null) return this.#pumping
    const run = this.#pump().finally(() => {
      this.#pumping = null
      this.#urgent = false
    })
    this.#pumping = run
    return run
  }

  async #pump(): Promise<void> {
    const signal = this.#life.signal
    while (this.#outbox.length > 0 && !signal.aborted) {
      const chunk = this.#outbox[0] as Chunk
      await this.#prepared.get(chunk)
      if (!this.#urgent) {
        const delay = this.#pacer.nextReleaseDelayMs()
        if (delay > 0) await this.#sleep(delay)
      }
      if (signal.aborted) return
      const outcome = await this.#uploader.send(chunk, signal, pageHidden())
      // Addressed to the instance the body came from, by the `i` it carried.
      if (outcome.directive !== undefined && this.#isOwn(chunk)) this.#obey(outcome)
      if (outcome.ok || outcome.terminal) {
        this.#retryDelay = 0
        const at = this.#outbox.indexOf(chunk)
        if (at !== -1) this.#outbox.splice(at, 1)
        if (outcome.terminal && this.#isOwn(chunk)) this.#noteLost(chunk.seq)
        if (this.#store !== null) await this.#store.delete(chunk.idempotencyKey)
        if (!this.#isOwn(chunk)) this.#releaseInherited()
        continue
      }
      // Kept, at the front. Spinning here would be the congestion the pacer
      // exists to avoid, so the next attempt waits for a seal, `online`, or the
      // backoff.
      this.#scheduleRetry()
      return
    }
  }

  /**
   * Do what ingest asked, within bounds: a shorter seal interval while someone
   * watches the session, and raised detail while a capture window covers it.
   * Its times are the server's clock, so they are read against the server's
   * time in the same answer.
   */
  #obey(outcome: UploadOutcome): void {
    const d = outcome.directive
    if (d === undefined || this.#ended) return
    try {
      const serverNow = outcome.serverWallMs ?? this.#clock.wall()
      if (d.flushMs !== undefined) {
        const ms = Math.min(DIRECTIVE_FLUSH_MAX_MS, Math.max(DIRECTIVE_FLUSH_MIN_MS, d.flushMs))
        const span = d.until === undefined ? DIRECTIVE_FLUSH_MAX_SPAN_MS : d.until - serverNow
        const forMs = Math.min(DIRECTIVE_FLUSH_MAX_SPAN_MS, span)
        if (forMs > 0) this.#schedule.shorten(ms, forMs)
      }
      const e = d.elevate
      if (e !== undefined) {
        const forMs = Math.min(DIRECTIVE_ELEVATE_MAX_SPAN_MS, e.until - serverNow)
        const level =
          levelIndex(e.level) > levelIndex(DIRECTIVE_ELEVATE_MAX_LEVEL)
            ? DIRECTIVE_ELEVATE_MAX_LEVEL
            : e.level
        if (forMs > 0) this.#escalation.remote(level, this.#clock.now() + forMs, e.reason)
      }
    } catch (err) {
      this.#onError(err)
    }
  }

  /**
   * Drain now, without pacing, and resolve when the outbox is empty, an upload
   * has failed, or `upload.drainDeadlineMs` has passed — whichever is first.
   */
  async #drainUrgent(): Promise<void> {
    this.#urgent = true
    this.#wake?.()
    const deadline = deadlineSignal(this.config.upload.drainDeadlineMs)
    try {
      await new Promise<void>((resolve) => {
        deadline.signal?.addEventListener('abort', () => resolve(), { once: true })
        void this.#drain().then(resolve, resolve)
      })
    } finally {
      deadline.clear()
    }
  }

  #scheduleRetry(): void {
    if (this.#retryHandle !== undefined || this.#life.signal.aborted) return
    this.#retryDelay = Math.min(RETRY_MAX_MS, Math.max(RETRY_FIRST_MS, this.#retryDelay * 2))
    const delay = Math.round(this.#retryDelay * (0.75 + Math.random() * 0.5))
    const set = this.#ports.setTimer ?? ((fn: () => void, d: number) => setTimeout(fn, d))
    this.#retryHandle = set(() => {
      this.#retryHandle = undefined
      void this.#drain()
    }, delay)
  }

  #sleep(ms: number): Promise<void> {
    const set = this.#ports.setTimer ?? ((fn: () => void, d: number) => setTimeout(fn, d))
    return new Promise((resolve) => {
      this.#wake = resolve
      set(() => resolve(), ms)
    })
  }

  /**
   * Send what earlier page loads stored and could not send: every body bound
   * for this endpoint and key whose instance is gone, from any session.
   */
  async #sweep(): Promise<void> {
    const store = this.#store
    if (store === null) return
    try {
      const held = await heldInstances(this.#locks, this.#onError)
      const cutoff = this.#clock.wall() - SWEEP_AGE_INTERVALS * this.config.upload.intervalMs
      const left = store.backlog(this.#dest).filter((e) => {
        if (e.instanceId === this.instanceId) return false
        return held === null ? e.createdWallMs < cutoff : !held.has(e.instanceId)
      })
      const adopted: Chunk[] = []
      for (const e of left) {
        const c = await store.get(e.key)
        if (c !== undefined) adopted.push(c)
      }
      if (adopted.length === 0 || this.#discarded) return
      this.#outbox = [...adopted, ...this.#outbox]
      await this.#drain()
    } catch (err) {
      this.#onError(err)
    }
  }

  /* ── page lifecycle ───────────────────────────────────────────────────── */

  #installLifecycle(): void {
    if (this.#ports.noLifecycleListeners === true) return
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
    this.#listeners.push(['pagehide', absorb, true])
    g.addEventListener('pagehide', absorb, true)
    const on = (type: string, f: (e: unknown) => void): void => {
      const guarded = (e: unknown): void => {
        try {
          f(e)
        } catch (err) {
          this.#onError(err)
        }
      }
      this.#listeners.push([type, guarded, false])
      g.addEventListener?.(type, guarded)
    }
    const pagehide = (e: unknown): void =>
      this.#pagehide((e as { persisted?: boolean }).persisted === true)
    on('pagehide', pagehide)
    // The same work again, resumed where a cancelled first run stopped; a no-op
    // after a run that finished.
    on('pagehide', pagehide)
    on('pageshow', (e) => {
      if ((e as { persisted?: boolean }).persisted === true) this.#pageshow()
    })
    on('visibilitychange', () => this.#visibility())
    on('online', () => {
      void this.#drain()
    })
  }

  #visibility(): void {
    if (this.#ended) return
    if (!pageHidden()) {
      this.#writeLife('visible')
      return
    }
    this.#writeLife('hidden')
    this.#broadcast({ t: 'forward' })
    // A mobile browser may kill a hidden page with no further event, so what
    // it holds leaves now — unless it sealed a moment ago.
    if (this.#clock.now() - this.#lastSealMono < HIDDEN_SEAL_GAP_MS) return
    this.#tick()
    this.#seal()
    void this.#drainUrgent()
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
  #pagehide(persisted: boolean): void {
    if (persisted) {
      if (this.#ended || this.#frozenAt !== undefined) return
      this.#frozenAt = this.#clock.now()
      this.#escalation.unload()
      this.#tick()
      this.#writeLife('frozen')
      this.#seal()
      this.#beaconOutbox([])
      this.#beaconed.clear()
      return
    }
    if (this.#ended && this.#unloadStep === 0) return
    this.#unload()
  }

  /**
   * End the instance and send everything, in steps a second call resumes.
   *
   * Firefox can stop a `pagehide` listener at any call, so each step is marked
   * done only once it is, and the second listener picks up from the first
   * unfinished one. A step cut short repeats: at worst a record or a body goes
   * twice, which ingest dedupes, rather than not at all.
   */
  #unload(): void {
    if (this.#unloadStep === 0) {
      this.#escalation.unload()
      this.#tick()
      this.#seal()
      this.#unloadStep = 1
    }
    if (this.#unloadStep === 1) {
      this.#finish('unload')
      this.#unloadStep = 2
    }
    if (this.#unloadStep === 2) {
      this.#endBody = this.#seal(true)
      this.#unloadStep = 3
    }
    if (this.#unloadStep === 3) {
      // A seal that failed left the `end` record buffered; one more try.
      this.#endBody ??= this.#seal(true)
      this.#beaconOutbox(this.#endBody === null ? [] : [this.#endBody])
      this.#unloadStep = 4
    }
    if (this.#unloadStep === 4) {
      this.#teardown()
      this.#unloadStep = 5
    }
  }

  #pageshow(): void {
    const at = this.#frozenAt
    if (at === undefined || this.#ended) return
    this.#frozenAt = undefined
    this.#writeLife('resumed', Math.round(this.#clock.now() - at))
  }

  /** Beacon `first`, then every other body in the outbox, newest last; store each one. */
  #beaconOutbox(first: readonly Chunk[]): void {
    const rest = this.#outbox.filter((c) => !first.includes(c))
    for (const chunk of [...first, ...rest]) {
      if (this.#beaconed.has(chunk)) continue
      const outcome = sendTail(this.config.endpoint, chunk.bytes, {
        maxBytes: Math.min(this.config.upload.beaconMaxBytes, BEACON_MAX_BYTES),
        apiKey: this.config.apiKey,
        idempotencyKey: chunk.idempotencyKey,
        instanceId: chunk.instanceId,
        ...(this.#ports.beacon !== undefined ? { beacon: this.#ports.beacon } : {}),
        ...(this.#ports.fetchImpl !== undefined ? { fetchImpl: this.#ports.fetchImpl } : {}),
        onInternalError: this.#onError,
      })
      this.#beaconed.add(chunk)
      // Metered only once something took it: ingest, the actual meter, never
      // sees a body nothing accepted.
      if (outcome !== false) this.#noteBytes(chunk)
      if (this.#store !== null) void this.#store.put(chunk, this.#dest)
    }
  }

  /* ── teardown ─────────────────────────────────────────────────────────── */

  /**
   * Stop every timer and listener, end uploads in flight, release the locks,
   * and restore the global, unless the next session in this page keeps the
   * hook.
   */
  #teardown(opts: { keepHook?: boolean } = {}): void {
    this.#ended = true
    this.#realm.detach()
    this.#schedule.stop()
    this.#life.abort()
    this.#wake?.()
    const clear = this.#ports.clearTimer ?? ((h: unknown) => clearTimeout(h as never))
    for (const h of [
      this.#intervalHandle,
      this.#windowHandle,
      this.#retryHandle,
      this.#linkTimer,
    ]) {
      if (h !== undefined) clear(h)
    }
    for (const l of this.#links) {
      if (l.timeout !== undefined) clear(l.timeout)
      if (l.onHello !== undefined) l.target.removeEventListener?.('message', l.onHello)
      l.port?.close()
    }
    this.#intervalHandle = undefined
    this.#windowHandle = undefined
    this.#retryHandle = undefined
    this.#linkTimer = undefined
    const g = globalThis as {
      removeEventListener?: (t: string, f: (e: unknown) => void, capture?: boolean) => void
    }
    for (const [type, f, capture] of this.#listeners) g.removeEventListener?.(type, f, capture)
    this.#listeners = []
    this.#releaseLock()
    for (const release of this.#inheritedLocks.values()) release()
    this.#inheritedLocks.clear()
    this.#realm.clear()
    if (opts.keepHook === true) return
    try {
      this.#hook.uninstall()
    } catch (err) {
      this.#onError(err)
    }
  }

  #relNow(): Mono {
    return this.#clock.now() - this.anchor.originMono
  }
}

/** Whether the page is hidden. `false` where there is no document. */
function pageHidden(): boolean {
  const d = (globalThis as { document?: { visibilityState?: string } }).document
  return d?.visibilityState === 'hidden'
}
