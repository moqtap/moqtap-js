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
 * Calls made in the gap — `annotate`, `observe`, `escalate`, `resolve` — are
 * queued and replayed in order. `ids()` answers immediately, from the resolved
 * config, so the caller can put them in their own logs and join later.
 */

import { MQ1004 } from '../codes.js'
import { ChunkStore } from '../flush/index.js'
import type {
  CollectorConfig,
  DetailLevel,
  Identity,
  MetricDefinition,
  UsageReport,
} from '../types.js'
import { type ConfigProblem, resolveConfig } from './config.js'
import { claimDormantHook, type DormantClaim, setPresenceActive } from './dormant.js'
import { CollectorRuntime, type RuntimePorts } from './session.js'

/** The origin-scoped IndexedDB database. One per origin; records are session-scoped. */
export const DB_NAME = 'moqtap-collector'

/** What a worker link accepts: a `Worker`, a `MessagePort`, or anything postMessage-shaped. */
export interface MessageTarget {
  postMessage(message: unknown): void
  addEventListener(type: 'message', listener: (e: { data?: unknown }) => void): void
  removeEventListener?(type: 'message', listener: (e: { data?: unknown }) => void): void
  start?(): void
}

/** The handshake envelope. Namespaced so a customer's own traffic is never mistaken for it. */
export const HANDSHAKE = '__moqtap_collector__'
export const HELLO = 'hello'
export const CONFIG = 'config'

export interface Collector {
  /** Flushes what is buffered, then tears down. Never clears an unflushed backlog. */
  stop(): Promise<void>
  /** Drops everything, clears IndexedDB for this session, tears down. Transmits nothing. */
  abort(): Promise<void>
  annotate(name: string, data: unknown): void
  defineMetric(name: string, d: MetricDefinition): void
  observe(name: string, value: number, labels?: Record<string, string>): void
  /** Synchronous, available before the first object arrives. */
  ids(): Identity
  /** Manual escalation. Opens a billable capture window and records the source. */
  escalate(level: DetailLevel, reason?: string): void
  /**
   * The incident is over; close the billable capture window. The counterpart to
   * {@link Collector.escalate}.
   *
   * **It is the primary way a window closes**; `flightRecorder.windowMs` — 15 s
   * — is the backstop for a developer who never calls it. There is deliberately
   * no automatic "the fault recovered" close: the collector sees objects
   * arriving, not a rebuffer ending, and guessing would be wrong in both
   * directions.
   *
   * Safe to call with no window open, safe to call twice, and it never throws —
   * it belongs in a `catch` block beside the reporting call that opened the
   * window.
   */
  resolve(reason?: string): void
  /** The collector's own volume by level. A budgeting aid, never the invoice. */
  usage(): UsageReport
  /**
   * Link a dedicated `Worker` (or a `MessagePort` to one) so its own
   * realm's collector can be configured.
   *
   * **Not automatic, and that is a security decision rather than an omission.**
   * The page has no way to enumerate its workers, so the only automatic form
   * available would be a `message` listener on the page's own global — which
   * also receives cross-origin `postMessage` from any frame or opener, and
   * replying to one of those would post the customer's `apiKey` to whoever
   * asked. So the customer names the target, exactly once, and the handshake
   * goes only there.
   *
   * Calling it also arms the **fail-closed** rule: from this moment the
   * session is `partial` on its setup and terminal records until the worker
   * answers. If the worker never imports the collector, the message is ignored
   * and the session is reported partial rather than complete.
   */
  linkWorker(target: MessageTarget): void
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
  #stopRequest: 'stop' | 'abort' | null = null
  #settled: Promise<void> | null = null
  readonly #identity: Identity
  readonly #onError: (e: unknown) => void
  readonly #workers: MessageTarget[] = []
  readonly #claim: DormantClaim

  constructor(identity: Identity, onError: (e: unknown) => void, claim: DormantClaim) {
    this.#identity = identity
    this.#onError = onError
    this.#claim = claim
  }

  /** Called once the runtime is built and started. Replays the gap. */
  attach(r: CollectorRuntime): void {
    this.#runtime = r
    // the fail-closed rule, armed retroactively: a `linkWorker()` that
    // happened before the runtime existed still marks the session `partial`
    // until that worker answers.
    if (this.#workers.length > 0) r.expectWorker()
    const queued = this.#queued
    this.#queued = []
    for (const f of queued) {
      try {
        f(r)
      } catch (err) {
        this.#onError(err)
      }
    }
    // A `stop()`/`abort()` that arrived during setup wins: the customer asked to
    // stop before we finished starting, and starting anyway would transmit after
    // an opt-out.
    if (this.#stopRequest === 'abort') this.#settled = r.abort()
    else if (this.#stopRequest === 'stop') this.#settled = r.stop()
  }

  /** Setup failed outright. Nothing will ever attach; make the verbs terminal. */
  fail(): void {
    this.#queued = []
    // Released whether or not a stop was asked for: no runtime will ever attach,
    // so this collector is not running, and a later `init()` must not be
    // reported as one made over a live one.
    this.#claim.release()
    if (this.#stopRequest !== null) this.#claim.hook.uninstall()
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

  annotate(name: string, data: unknown): void {
    this.#defer((r) => r.annotate(name, data))
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
    if (this.#workers.includes(target)) return
    this.#workers.push(target)
    this.#runtime?.expectWorker()
    const onMessage = (e: { data?: unknown }): void => {
      const d = e.data as Record<string, unknown> | undefined
      if (typeof d !== 'object' || d === null || d[HANDSHAKE] !== 1 || d.t !== HELLO) return
      this.#runtime?.noteWorkerLinked()
      try {
        target.postMessage({ [HANDSHAKE]: 1, t: CONFIG, config: this.workerConfig })
      } catch (err) {
        this.#onError(err)
      }
    }
    try {
      target.addEventListener('message', onMessage)
      target.start?.()
    } catch (err) {
      this.#onError(err)
    }
  }

  /** The config a worker's own realm is configured with. Set by `init()`. */
  workerConfig: CollectorConfig | undefined

  stop(): Promise<void> {
    // Released at the *call*, not at the settlement: the teardown that actually
    // restores the global happens after the drain, and a page that re-inits
    // without awaiting this promise has made no mistake and must not be
    // reported as one. The claim keeps the authority to uninstall until then.
    this.#claim.release()
    const r = this.#runtime
    if (r !== null) {
      // One settlement per collector: a second `stop()` joins the first rather
      // than sealing and releasing a second time.
      this.#settled ??= r.stop()
      return this.#settled
    }
    this.#stopRequest ??= 'stop'
    return Promise.resolve()
  }

  abort(): Promise<void> {
    this.#claim.release()
    const r = this.#runtime
    if (r !== null) {
      // `abort()` overrides a `stop()` already in flight: the customer has
      // withdrawn consent, and the stronger verb wins.
      this.#settled = r.abort()
      return this.#settled
    }
    this.#stopRequest = 'abort'
    // Nothing has been sent and nothing can be: the hook is dormant, its ring is
    // memory-only, and tearing it down now restores the page's own global.
    this.#claim.hook.uninstall()
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
export function init(config: CollectorConfig, options: InitOptions = {}): Collector {
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
  // makes a second `init()` after a `stop()` work — `stop()` uninstalls, and the
  // claim re-installs rather than binding to a global that is no longer patched.
  const claim = claimDormantHook()
  if (claim.superseded) {
    // `init()` over a collector nobody stopped. There is one hook and one
    // observer on it, so the newer collector takes over — the caller's most
    // recent intent — and the older one goes quiet from here. Named rather than
    // silent: a session that reported almost nothing and never said why is the
    // outcome this area exists to prevent.
    report({ key: 'init', code: MQ1004 })
  }
  // A key has been supplied, so the page-global marker stops saying "installed
  // and dormant". The extension reads this to tell a developer whether the SDK
  // on the page is actually transmitting.
  setPresenceActive(true)

  const identity: Identity = {
    sessionId: resolved.sessionId,
    connectionId: `${resolved.sessionId}#0`,
    ...(resolved.context.actorId !== '' ? { actorId: resolved.context.actorId } : {}),
    ...(resolved.context.contentId !== '' ? { contentId: resolved.context.contentId } : {}),
  }
  const pending = new PendingCollector(identity, onError, claim)
  // The worker gets the *supplied* config with the session id pinned, not the
  // resolved one: a worker is part of the same logical session, and the
  // worker's own realm resolves its own defaults.
  pending.workerConfig = { ...config, sessionId: resolved.sessionId }

  void (async (): Promise<void> => {
    try {
      let store: ChunkStore | null
      if (options.store !== undefined) store = options.store
      else if (options.persist === false) store = null
      else {
        store = await ChunkStore.open(DB_NAME, resolved.storage.quotaBytes ?? 0, {
          onInternalError: onError,
        })
      }

      const runtime = new CollectorRuntime(resolved, claim.hook, {
        ...options,
        store,
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
