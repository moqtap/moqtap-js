/**
 * `init()` — the one call site, and the whole of the public surface.
 * Configuration lives in the `init()` argument and nowhere else: not a global,
 * not a `data-` attribute, not build-time substitution.
 *
 * `init()` returns synchronously although its setup is not. IndexedDB has to
 * open before a byte can be *sent*, that is asynchronous, and it may not delay
 * the caller — `init()` is frequently the first line of a page's bootstrap, and
 * a promise there is a promise the customer has to thread through their own
 * startup. So `init()` returns a {@link Collector} immediately and the setup
 * runs behind it. **Nothing is lost in the gap**: the hook is already installed
 * and already buffering, the dormant ring holds the wire bytes from module-eval
 * time, and the runtime drains it into its own ring the moment it attaches.
 *
 * Calls made in the gap are queued and replayed in order. `ids()` answers
 * immediately, from the resolved config and an instance id minted here, so the
 * caller can put them in their own logs and join later.
 */

import { MQ1004, MQ1006, MQ1113 } from '../codes.js'
import type { ChunkStore } from '../flush/index.js'
import type { TransportHook } from '../transport/index.js'
import { type PresenceHandle, publishPresence } from '../transport/presence.js'
import type {
  CollectorConfig,
  ContextUpdate,
  DetailLevel,
  Identity,
  MetricDefinition,
  ResolvedConfig,
  UsageReport,
} from '../types.js'
import { COLLECTOR_VERSION } from '../version.js'
import {
  type ConfigProblem,
  isStorableSessionId,
  mintId,
  resolveConfig,
  sentActorId,
} from './config.js'
import type { ConnectionState } from './realm.js'
import { type Build, CollectorRuntime, type MessageTarget, type RuntimePorts } from './session.js'

/** The origin-scoped IndexedDB database. One per origin. */
export const DB_NAME = 'moqtap-collector'

/** A connection as {@link Collector.connections} reports it. */
export type ConnectionInfo = ConnectionState

export interface Collector {
  /**
   * Synchronous ids for your own logs: the session the next `WebTransport`
   * begins, or the one it began.
   */
  ids(): Identity
  /** Every connection seen in this page and its linked workers, open ones first. */
  connections(): readonly ConnectionInfo[]
  /** The connection id of a `WebTransport` this page created, to join your own logs. */
  connectionIdOf(transport: WebTransport): string | undefined
  /**
   * This worker's WebTransports report into this session. Call once per
   * worker, including replacements. You can terminate the worker at any time;
   * nothing sealed is lost.
   *
   * **Not automatic, and that is a security decision rather than an omission.**
   * The page cannot enumerate its workers, so the only automatic form would be
   * a `message` listener on the page's own global, which also receives
   * cross-origin `postMessage` from any frame or opener.
   */
  linkWorker(target: MessageTarget): void
  /**
   * Context from now on: `contentId` for connections opened from now on, e.g.
   * on a source switch, `actorId` once the user signs in, and `tags` added to
   * the session's.
   */
  setContext(ctx: ContextUpdate): void
  /**
   * Upload everything recorded so far, now. Ends nothing. Resolves when ingest
   * has accepted it or it is stored for retry.
   */
  flush(): Promise<void>
  /**
   * End this session now, upload everything, and restore WebTransport. Unload
   * already does this, so you only need `end()` when you stop collecting for
   * good.
   */
  end(): Promise<void>
  /**
   * End this session and start a new one in this page. Linked workers follow.
   * With a connection open the new session begins at once; with none, it
   * begins with the next `WebTransport`. Returns the new ids. After `end()` or
   * `discard()` it starts nothing and returns the ids unchanged.
   */
  newSession(ctx?: { contentId?: string; sessionId?: string }): Identity
  /** Consent withdrawn: delete everything unsent, including stored backlog, and send nothing more. */
  discard(): Promise<void>
  /** Add a marker to the session timeline, optionally scoped to one connection. */
  annotate(name: string, data?: unknown, connectionId?: string): void
  /** Declare a custom metric. Linked workers may observe it by name. */
  defineMetric(name: string, d: MetricDefinition): void
  /** Record a custom metric sample. */
  observe(name: string, value: number, labels?: Record<string, string>): void
  /** Raise the detail level for the page and every linked worker, opening one capture window that counts toward recording minutes. */
  escalate(level: DetailLevel, reason?: string): void
  /**
   * Close the capture window. Safe when none is open, and safe to call twice.
   *
   * **It is the primary way a window closes**; `flightRecorder.windowMs` — 15 s
   * — is the backstop for a developer who never calls it. There is deliberately
   * no automatic "the fault recovered" close: the collector sees objects
   * arriving, not a rebuffer ending, and guessing would be wrong in both
   * directions.
   */
  resolve(reason?: string): void
  /** The collector's own upload volume, for budgeting. Never the count of record. */
  usage(): UsageReport
}

export interface InitOptions extends RuntimePorts {
  /** Every rejected or unknown config key lands here as well as on `onInternalError`. */
  readonly onConfigProblem?: (p: ConfigProblem) => void
  /** Session-id source. Injected so the suite is deterministic. */
  readonly mintSessionId?: () => string
  /** Skip `ChunkStore.open` entirely. `init()` then runs memory-only. */
  readonly persist?: boolean
}

/**
 * The object `init()` returns before the runtime exists.
 *
 * Not a proxy and not a promise: a small, total object that answers what it can
 * answer immediately and replays the rest: a dependency inside someone
 * else's player never hands them a rejected promise or a method that throws
 * because its own setup is still in flight.
 */
class PendingCollector implements Collector {
  #runtime: CollectorRuntime | null = null
  #queued: ((r: CollectorRuntime) => void)[] = []
  #endRequest: 'end' | 'discard' | null = null
  #settled: Promise<void> | null = null
  /** The current session's config and ids, which `newSession()` replaces. */
  #config: ResolvedConfig
  #identity: Identity
  readonly #onError: (e: unknown) => void
  readonly #claim: Claim
  readonly #build: Build

  constructor(
    config: ResolvedConfig,
    identity: Identity,
    onError: (e: unknown) => void,
    claim: Claim,
    build: Build,
  ) {
    this.#config = config
    this.#identity = identity
    this.#onError = onError
    this.#claim = claim
    this.#build = build
  }

  /** The runtime took over from its predecessor on its own: a session began or ended. */
  swap(r: CollectorRuntime): void {
    this.#runtime = r
    this.#config = r.config
  }

  /** Called once the runtime is built and started. Replays the gap. */
  attach(r: CollectorRuntime): void {
    // The session may already have begun as it started, in the runtime it handed over to.
    this.#runtime ??= r
    const queued = this.#queued
    this.#queued = []
    // Each call runs against the runtime current at its turn: a queued
    // `newSession()` replaces it for the calls made after it.
    for (const f of queued) {
      try {
        f(this.#runtime ?? r)
      } catch (err) {
        this.#onError(err)
      }
    }
    // An `end()`/`discard()` that arrived during setup wins: the customer asked
    // to stop before we finished starting, and starting anyway would transmit
    // after an opt-out.
    const current = this.#runtime ?? r
    if (this.#endRequest === 'discard') this.#settled = current.discard()
    else if (this.#endRequest === 'end') this.#settled = current.end()
  }

  /** Setup failed outright. Nothing will ever attach; make the verbs terminal. */
  fail(): void {
    this.#queued = []
    // Released whether or not an end was asked for: no runtime will ever
    // attach, so this collector is not running, and a later `init()` must not
    // be reported as one made over a live one.
    this.#claim.release()
    if (this.#endRequest !== null) this.#claim.hook?.uninstall()
  }

  #defer(f: (r: CollectorRuntime) => void): void {
    const r = this.#runtime
    if (r !== null) {
      try {
        f(r)
      } catch (err) {
        this.#onError(err)
      }
      return
    }
    // Bounded: a page that calls `observe()` in a render loop and never finishes
    // starting must not accumulate an unbounded replay queue.
    if (this.#queued.length >= 1024) return
    this.#queued.push(f)
  }

  ids(): Identity {
    return this.#runtime?.ids() ?? this.#identity
  }

  connections(): readonly ConnectionInfo[] {
    return this.#runtime?.connections() ?? []
  }

  usage(): UsageReport {
    const r = this.#runtime
    if (r !== null) return r.usage()
    return {
      bytesByLevel: { baseline: 0, headers: 0, 'headers+sizes': 0, 'headers+data': 0 },
      elevatedSeconds: 0,
      elevatedMinutes: 0,
      bytesPerElevatedMinute: 0,
      isEstimate: true,
    }
  }

  connectionIdOf(transport: WebTransport): string | undefined {
    return this.#build.observation?.connectionIdOf(transport)
  }

  annotate(name: string, data?: unknown, connectionId?: string): void {
    this.#defer((r) => r.annotate(name, data, connectionId))
  }

  setContext(ctx: ContextUpdate): void {
    const { actorId, contentId } = this.#identity
    this.#identity = {
      ...this.#identity,
      ...withId(
        'actorId',
        typeof ctx.actorId === 'string' ? sentActorId(ctx.actorId, this.#config) : actorId,
      ),
      ...withId('contentId', typeof ctx.contentId === 'string' ? ctx.contentId : contentId),
    }
    this.#defer((r) => r.setContext(ctx))
  }

  newSession(ctx: { contentId?: string; sessionId?: string } = {}): Identity {
    const current = this.ids()
    if (this.#endRequest !== null || this.#settled !== null || this.#runtime?.ended === true) {
      return current
    }
    let sessionId = mintId()
    let idSource: ResolvedConfig['idSource'] = 'minted'
    if (typeof ctx.sessionId === 'string' && ctx.sessionId !== '') {
      if (isStorableSessionId(ctx.sessionId)) {
        sessionId = ctx.sessionId
        idSource = 'supplied'
      } else {
        // The byte length, not the id, as `init()` reports it.
        const bytes = new TextEncoder().encode(ctx.sessionId).byteLength
        this.#onError(new Error(`${MQ1113}: sessionId ${bytes}`))
      }
    }
    const contentId = typeof ctx.contentId === 'string' ? ctx.contentId : current.contentId
    const config: ResolvedConfig = Object.freeze({
      ...this.#config,
      sessionId,
      idSource,
      context: Object.freeze({
        ...this.#config.context,
        actorId: current.actorId ?? '',
        contentId: contentId ?? '',
      }),
    })
    const instanceId = mintId()
    this.#config = config
    this.#identity = {
      sessionId,
      instanceId,
      ...withId('actorId', current.actorId),
      ...withId('contentId', contentId),
    }
    // The runtime that takes over is named through `swap()`.
    const next = (r: CollectorRuntime): void => void r.successor(config, instanceId)
    if (this.#runtime !== null) {
      next(this.#runtime)
      return this.ids()
    }
    this.#defer(next)
    return this.#identity
  }

  defineMetric(name: string, d: MetricDefinition): void {
    this.#defer((r) => r.defineMetric(name, d))
  }

  observe(name: string, value: number, labels?: Record<string, string>): void {
    this.#defer((r) => {
      if (labels === undefined) r.observe(name, value)
      else r.observe(name, value, labels)
    })
  }

  escalate(level: DetailLevel, reason?: string): void {
    this.#defer((r) => r.escalate(level, reason))
  }

  resolve(reason?: string): void {
    // Queued like every other verb, so an escalate/resolve pair made in the gap
    // replays in the order the customer made it and cannot leave a window open.
    this.#defer((r) => r.resolve(reason))
  }

  linkWorker(target: MessageTarget): void {
    const workers = this.#build.features.workers
    if (this.#runtime !== null || workers === undefined) {
      this.#defer((r) => r.linkWorker(target))
      return
    }
    // A `Worker` dispatches its hello to whoever listens at that moment, and
    // the page may still be opening its store when the worker answers. Listen
    // from the call, and hand what was heard to the runtime once it runs.
    const heard = workers.hold(target, this.#onError)
    this.#defer((r) => r.linkWorker(target, heard()))
  }

  flush(): Promise<void> {
    const r = this.#runtime
    if (r === null) return Promise.resolve()
    return r.flush().catch((err: unknown) => this.#onError(err))
  }

  end(): Promise<void> {
    // Released at the *call*, not at the settlement: the teardown that actually
    // restores the global happens after the drain, and a page that re-inits
    // without awaiting this promise has made no mistake and must not be
    // reported as one. The claim keeps the authority to uninstall until then.
    this.#claim.release()
    const r = this.#runtime
    if (r !== null) {
      // One settlement per collector: a second `end()` joins the first.
      this.#settled ??= r.end().catch((err: unknown) => this.#onError(err))
      return this.#settled
    }
    this.#endRequest ??= 'end'
    return Promise.resolve()
  }

  discard(): Promise<void> {
    this.#claim.release()
    const r = this.#runtime
    if (r !== null) {
      // `discard()` overrides an `end()` already in flight: the customer has
      // withdrawn consent, and the stronger verb wins.
      this.#settled = r.discard().catch((err: unknown) => this.#onError(err))
      return this.#settled
    }
    this.#endRequest = 'discard'
    // Nothing has been sent and nothing can be: the hook is dormant, its ring is
    // memory-only, and tearing it down now restores the page's own global.
    this.#claim.hook?.uninstall()
    return Promise.resolve()
  }
}

/**
 * Start collecting.
 *
 * Throws only for a missing `apiKey` or an `endpoint` that was supplied and is
 * unusable — see `resolveConfig`; an absent one resolves to the hosted ingest.
 * Every other configuration problem is reported and defaulted, because a dependency
 * inside someone else's player does not get to throw over a mistyped bucket cap.
 */
export function initWith(
  build: Build,
  config: CollectorConfig,
  options: InitOptions = {},
): Collector {
  const onError = (err: unknown): void => {
    try {
      config.onInternalError?.(err)
    } catch {
      // An error handler that throws is where reporting stops.
    }
  }

  const report = (p: ConfigProblem): void => {
    options.onConfigProblem?.(p)
    // Code, key, and the offending value if there was one. The key is what
    // tells the caller *where* to look and costs nothing extra — it is a
    // string they wrote themselves.
    onError(new Error(`${p.code}: ${p.key}${p.got === undefined ? '' : ` ${p.got}`}`))
  }

  const resolved = resolveConfig(config, {
    onProblem: report,
    ...(options.mintSessionId !== undefined ? { mintSessionId: options.mintSessionId } : {}),
  })

  // The hook is already installed from module-eval time. Claiming it is what
  // makes a second `init()` after an `end()` work — `end()` uninstalls, and the
  // claim re-installs rather than binding to a global that is no longer patched.
  const observation = build.observation
  const claim: Claim = observation === null ? claimWithoutHook() : observation.claim()
  if (claim.superseded) {
    // `init()` over a collector nobody ended. There is one hook and one
    // observer on it, so the newer collector takes over — the caller's most
    // recent intent — and the older one goes quiet from here. Named rather than
    // silent: a session that reported almost nothing and never said why is the
    // outcome this area exists to prevent.
    report({ key: 'init', code: MQ1004 })
  }
  // A key has been supplied, so the page-global marker stops saying "installed
  // and dormant". The extension reads this to tell a developer whether the SDK
  // on the page is actually transmitting.
  if (observation === null) presenceWithoutHook()
  else observation.setPresenceActive(true)

  const features = build.features
  if (features.escalation === undefined && resolved.detail !== 'baseline') {
    report({ key: 'detail', code: MQ1006, got: 'escalation' })
  }
  const triggers = resolved.flightRecorder.triggers
  if (triggers.stall !== undefined || triggers.cadence !== undefined) {
    // A trigger dumps the recorder and opens a capture window: both halves.
    if (features.flightRecorder === undefined) {
      report({ key: 'flightRecorder.triggers', code: MQ1006, got: 'flightRecorder' })
    } else if (features.escalation === undefined) {
      report({ key: 'flightRecorder.triggers', code: MQ1006, got: 'escalation' })
    }
  }

  const instanceId = options.instanceId ?? mintId()
  const identity: Identity = {
    sessionId: resolved.sessionId,
    instanceId,
    ...withId('actorId', resolved.context.actorId),
    ...withId('contentId', resolved.context.contentId),
  }
  const pending = new PendingCollector(resolved, identity, onError, claim, build)

  void (async (): Promise<void> => {
    try {
      const persistence = features.persistence?.persistence
      let store: ChunkStore | null
      if (options.store !== undefined) store = options.store
      else if (options.persist === false || persistence === undefined) store = null
      else {
        store = await persistence.open(DB_NAME, resolved.storage.quotaBytes, {
          onInternalError: onError,
        })
      }

      // Armed: the session begins with the first WebTransport, and nothing
      // before it is recorded or sent.
      const runtime = new CollectorRuntime(resolved, claim.hook, build, {
        ...options,
        instanceId,
        store,
        armed: true,
        onSession: (r) => pending.swap(r),
        onInternalError: onError,
      })
      runtime.start()
      pending.attach(runtime)
    } catch (err) {
      onError(err)
      pending.fail()
    }
  })()

  return pending
}

/** `{ [key]: value }`, or nothing for an empty or absent value, as `ids()` reports them. */
function withId<K extends 'actorId' | 'contentId'>(
  key: K,
  value: string | undefined,
): Partial<Record<K, string>> {
  return value === undefined || value === '' ? {} : ({ [key]: value } as Record<K, string>)
}

/** One collector's hold on the page: the hook, when the build observes the page's transports. */
interface Claim {
  readonly hook: TransportHook | null
  /** An earlier collector still held it: `init()` over a running collector. */
  readonly superseded: boolean
  release(): void
}

let hooklessClaims = 0
let hooklessClaimant = 0
let hooklessHeld = false
let hooklessPresence: PresenceHandle | null = null

/**
 * The claim of a build that observes no transport in the page. There is no
 * hook to guard, only the question of whether a collector is still running.
 */
function claimWithoutHook(): Claim {
  hooklessClaims += 1
  const mine = hooklessClaims
  const superseded = hooklessHeld
  hooklessClaimant = mine
  hooklessHeld = true
  return {
    hook: null,
    superseded,
    release(): void {
      if (hooklessClaimant !== mine) return
      hooklessHeld = false
      hooklessPresence?.setActive(false)
    },
  }
}

/** Announce the collector on the page global, transmitting, for a build with no hook to do it. */
function presenceWithoutHook(): void {
  try {
    hooklessPresence ??= publishPresence(globalThis, COLLECTOR_VERSION, Date.now())
    hooklessPresence.setActive(true)
  } catch {
    // The marker is a courtesy to the extension; a global that refuses it is not a failure.
  }
}
