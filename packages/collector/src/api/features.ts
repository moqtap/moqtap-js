/**
 * The seams a build composes the collector through.
 *
 * The runtime names every optional part by interface only, so a bundle carries
 * a feature's code exactly when its entry imports that feature's module. What
 * an entry imports is what a page downloads; nothing here pulls an
 * implementation in.
 *
 * Observing a realm's own `WebTransport`s comes with a draft: the hook, the
 * decoders and the rollups are reachable only from a {@link Draft}. A page that
 * imports none observes no transport of its own, and records what its linked
 * workers forward.
 */

import type { ChunkStore, ChunkStoreOptions, LockManagerLike } from '../flush/index.js'
import type { TriggerEvent } from '../recorder/index.js'
import type { RingEntry } from '../ring/index.js'
import type { CustomMetrics } from '../rollup/index.js'
import type { TransportHook } from '../transport/index.js'
import type {
  BucketKey,
  ClockAnchor,
  ClockSource,
  DetailLevel,
  DraftAdapter,
  EnvelopeRecord,
  LinkRecord,
  Mono,
  ObjectSample,
  RecordSink,
  ResolvedConfig,
  TrackKeyResolver,
  TriggerConfig,
  TriggerKind,
} from '../types.js'
import type { DormantClaim, DormantState } from './dormant.js'
import type { DeflatePart, PageMessage } from './link.js'
import type { UsageMeter } from './meter.js'
import type { ConnectionState, RealmConfig, RealmObserver, RealmOptions } from './realm.js'
import type { LinkEvent, MessageTarget } from './session.js'

/* ── drafts ──────────────────────────────────────────────────────────────── */

/** What observing a realm's own transports takes: the hook, its buffer and the realm. */
export interface Observation {
  /** Install the hook, dormant. `ring` sizes the buffer of object data the flight recorder replays. */
  install(ring?: RingFactory): void
  claim(): DormantClaim
  arm(hook: TransportHook, onOpen: (s: DormantState) => void): DormantState
  pending(s?: DormantState | null): boolean
  setPresenceActive(active: boolean): void
  realm(o: RealmOptions): RealmObserver
  connectionIdOf(transport: unknown): string | undefined
}

/** One draft's decoder, and the observation that runs it. */
export interface Draft {
  readonly adapter: DraftAdapter
  readonly observation: Observation
}

/* ── the flight recorder ─────────────────────────────────────────────────── */

/** A bounded ring of object data, overwriting its oldest entries. */
export interface Ring {
  readonly maxBytes: number
  /** Bytes held now. */
  readonly bytes: number
  readonly evicted: number
  readonly evictedBytes: number
  reserve(): void
  push(e: Omit<RingEntry, 'seq'>): void
  snapshot(): RingEntry[]
  clear(): void
}

export type RingFactory = (maxBytes: number) => Ring

/** What a realm hands its recorder. */
export interface RecorderDeps {
  readonly config: RealmConfig['flightRecorder']
  readonly sink: RecordSink
  readonly adapter: (e: TriggerEvent) => DraftAdapter | undefined
  readonly keys: (e: TriggerEvent) => TrackKeyResolver | undefined
  readonly conn: (e: TriggerEvent) => string
  readonly level: () => DetailLevel
  readonly originMono: Mono
  readonly medianFor: (k: BucketKey) => number | undefined
  readonly medianSamplesFor: (k: BucketKey) => number
  readonly onFire: (e: TriggerEvent) => void
  readonly onError: (err: unknown) => void
}

/** The flight recorder as a realm runs it: its ring, its triggers and the dump a trigger fires. */
export interface RealmRecorder {
  readonly ring: Ring
  arm(triggers: TriggerConfig): void
  disarm(): void
  tick(now: Mono): void
  onObject(s: ObjectSample): void
  fire(e: TriggerEvent): void
}

/* ── escalation ──────────────────────────────────────────────────────────── */

export interface EscalationOptions {
  readonly configured: DetailLevel
  readonly ceilingMinutes: number
  readonly windowMs: number
  readonly meter: UsageMeter
  readonly clock: ClockSource
  readonly anchor: ClockAnchor
  readonly sink: RecordSink
  readonly ring?: { readonly capacityBytes: number; evictedBytes(): number }
  readonly onLevelChange?: (level: DetailLevel) => void
  readonly onWindowOpen?: (deadlineMono: Mono) => void
}

/** The page's detail level, and the capture windows that raise it. */
export interface Escalation {
  readonly level: DetailLevel
  escalate(to: DetailLevel, reason?: string): void
  resolve(reason?: string): void
  onTrigger(kind: TriggerKind, atMono: Mono, key?: BucketKey): void
  remote(to: DetailLevel, deadlineMono: Mono, reason?: string): void
  hold(untilMono: Mono): void
  tick(now: Mono): void
  close(): void
  unload(): void
}

/* ── worker links, the page's half ───────────────────────────────────────── */

/** What the page's links need from the page, whichever session it is in. */
export interface LinksHost {
  readonly clock: ClockSource
  readonly onError: (err: unknown) => void
  timer(fn: () => void, ms: number): unknown
  cancel(handle: unknown): void
}

/** The session the links report into. It changes when the page's session does. */
export interface LinkOwner {
  readonly ended: boolean
  /** Waiting for its first `WebTransport`. */
  readonly armed: boolean
  readonly config: ResolvedConfig
  readonly instanceId: string
  readonly level: DetailLevel
  /** The context connections opened from now on carry. */
  context(): ResolvedConfig['context']
  /** What a probe subtracts from its own clock to land on this session's. */
  base(workerOrigin: number): Mono
  /** A linked worker constructed a `WebTransport` while the session waited for one. */
  begin(): void
  writeLink(id: string, ev: LinkRecord['ev']): void
  /** Frames a probe forwarded as they are. */
  append(frames: Uint8Array, n: number): void
  /** Frames a probe compressed: the end of a body of their own. */
  sealSegment(part: DeflatePart): void
  ensureSetup(): void
  connReady(): void
  /** A linked worker has fewer connections open than it had. */
  noteClosed(): void
  sealNow(): void
  annotate(name: string, data: unknown, conn?: string): void
  observe(name: string, value: number, labels?: Record<string, string>): void
  escalate(level: DetailLevel, reason?: string): void
  resolve(reason?: string): void
  /** A probe's trigger fired, `at` on this session's clock. */
  trigger(kind: TriggerKind, at: Mono, key?: BucketKey): void
  /** A probe's control plane outran it, `at` on this session's clock. */
  overrun(at: Mono, signal: string): void
  json(r: EnvelopeRecord): void
  relNow(): Mono
}

/** The page's workers. One set serves the page across its sessions. */
export interface WorkerLinks {
  link(target: MessageTarget, hello?: LinkEvent): void
  /** A connection is open or being attempted in a linked worker. */
  open(): boolean
  connections(): ConnectionState[]
  /** Records the probes reported dropped, cumulative. */
  dropped(): number
  closeForwarded(cause: 'session-end'): void
  broadcast(m: PageMessage): void
  /** The next session took over: every link reports into `owner` from now. */
  adopt(owner: LinkOwner): void
  teardown(): void
}

/* ── storage ─────────────────────────────────────────────────────────────── */

/** IndexedDB, and the Web Locks that keep one page load from sweeping another's bodies. */
export interface Persistence {
  open(name: string, quotaBytes: number, opts: ChunkStoreOptions): Promise<ChunkStore | null>
  platformLocks(): LockManagerLike | undefined
  hold(
    locks: LockManagerLike | undefined,
    instanceId: string,
    onError: (e: unknown) => void,
  ): () => void
  held(
    locks: LockManagerLike | undefined,
    onError: (e: unknown) => void,
  ): Promise<ReadonlySet<string> | null>
}

/* ── the features ────────────────────────────────────────────────────────── */

export interface EscalationFeature {
  readonly feature: 'escalation'
  create(o: EscalationOptions): Escalation
}

export interface FlightRecorderFeature {
  readonly feature: 'flightRecorder'
  readonly ring: RingFactory
  parseDepth(depth: string | number): number
  create(d: RecorderDeps, ring: Ring): RealmRecorder
}

export interface CustomMetricsFeature {
  readonly feature: 'customMetrics'
  create(onError: (message: string) => void): CustomMetrics
  /** The engine that rolls the customer's metrics up each interval; they belong to no connection. */
  rollup(o: {
    readonly intervalMs: number
    readonly clock: ClockSource
    readonly sink: RecordSink
    readonly originMono: Mono
    readonly custom: CustomMetrics
  }): { tick(now: Mono): void }
}

export interface PersistenceFeature {
  readonly feature: 'persistence'
  readonly persistence: Persistence
}

export interface WorkersFeature {
  readonly feature: 'workers'
  create(host: LinksHost, owner: LinkOwner): WorkerLinks
  /**
   * Listen to `target` for its hello before a session can answer it. The
   * returned call stops listening and hands over what was heard.
   */
  hold(target: MessageTarget, onError: (err: unknown) => void): () => LinkEvent | undefined
}

export type Feature =
  | EscalationFeature
  | FlightRecorderFeature
  | CustomMetricsFeature
  | PersistenceFeature
  | WorkersFeature

/** A build's features, by name. */
export interface FeatureSet {
  readonly escalation?: EscalationFeature
  readonly flightRecorder?: FlightRecorderFeature
  readonly customMetrics?: CustomMetricsFeature
  readonly persistence?: PersistenceFeature
  readonly workers?: WorkersFeature
}

/**
 * Detail fixed at baseline, for a build without escalation. Nothing raises it;
 * a call that would is reported once, and ingest's request for elevation is
 * not one the build can honour.
 */
export function baselineEscalation(missing: () => void): Escalation {
  return {
    level: 'baseline',
    escalate: missing,
    resolve() {},
    onTrigger() {},
    remote() {},
    hold() {},
    tick() {},
    close() {},
    unload() {},
  }
}

export function featureSet(features: readonly Feature[]): FeatureSet {
  const out: { -readonly [K in keyof FeatureSet]: FeatureSet[K] } = {}
  for (const f of features) (out as Record<string, Feature>)[f.feature] = f
  return out
}
