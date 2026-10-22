/**
 * Workers.
 *
 * A dedicated `Worker` is a separate JavaScript realm with its own
 * `globalThis`, so the page's patched `WebTransport` is not the worker's. The
 * worker installs its own hook at module-eval time by importing this package,
 * and `initWorker()` makes it a probe of the page that links it: it observes
 * the worker's transports and hands every record to the page, which numbers,
 * seals and uploads them in its own stream.
 *
 * The page names its worker explicitly through `Collector.linkWorker()` rather
 * than answering hellos automatically, because the page cannot enumerate its
 * own workers: the only automatic mechanism would be a `message` listener on
 * the page's own global, which also receives cross-origin `postMessage` from
 * any frame or opener.
 *
 * Until the page answers, the dormant hook holds the worker's control plane,
 * and the probe replays it into the page's session once linked: a worker
 * that connects right after `initWorker()` keeps its SETUP and first
 * SUBSCRIBEs. A worker that never hears back releases what it held and keeps
 * its hook dormant: its `WebTransport` traffic goes only to a bounded ring and
 * never leaves the worker. The page reports that link as `timeout`.
 */

import { type DraftSet, draftSet } from '../draft/index.js'
import { connectionIdOf } from '../transport/index.js'
import type { DetailLevel, DraftAdapter } from '../types.js'
import { DEFAULT_LIMITS } from './defaults.js'
import { claimDormantHook, ensureDormantHook, releaseDormantEarly } from './dormant.js'
import { envelope, type LinkedMessage, linkMessage } from './link.js'
import { type ProbePorts, ProbeRuntime } from './probe.js'
import type { LinkEvent, MessageTarget } from './session.js'

/** A linked worker's view of the collector. Every verb is forwarded to the page. */
export interface WorkerProbe {
  /**
   * Resolves `true` once a page links this worker, `false` after
   * `limits.linkTimeoutMs` (5 s by default). If `false`, the probe stays inert
   * and sends nothing.
   */
  readonly linked: Promise<boolean>
  /** The page's ids, or `null` until linked. They follow the page into a new session. */
  ids(): { sessionId: string; instanceId: string } | null
  /** The connection id of a `WebTransport` this worker created. */
  connectionIdOf(transport: WebTransport): string | undefined
  /** Forwarded to the page's session, optionally scoped to one connection. */
  annotate(name: string, data?: unknown, connectionId?: string): void
  /** Forwarded to the page. The metric must be defined on the page. */
  observe(name: string, value: number, labels?: Record<string, string>): void
  /** Forwarded. The page owns the capture window and the budget. */
  escalate(level: DetailLevel, reason?: string): void
  /** Forwarded. Closes the page's capture window. */
  resolve(reason?: string): void
}

export interface InitWorkerOptions extends ProbePorts {
  /** How long to wait for the page. Default `limits.linkTimeoutMs`'s default. */
  readonly timeoutMs?: number
  /** The object the handshake runs over. Defaults to the worker's own global. */
  readonly target?: MessageTarget
  /** `performance.timeOrigin` of this worker. Injected so the suite is deterministic. */
  readonly timeOrigin?: number
}

/**
 * In a Worker that opens its own WebTransport: report it through the page
 * that links this worker. Never uploads, never ends anything. Returns at once.
 */
export type InitWorker = (port?: MessagePort, options?: InitWorkerOptions) => WorkerProbe

/** `initWorker` bound to the decoders one entry point was built with. */
export function workerEntryPoint(adapters: readonly DraftAdapter[]): InitWorker {
  const drafts = draftSet(adapters)
  return (port, options) => initWorkerWith(drafts, port, options)
}

/** Calls made before the page answers, replayed once it does. Bounded. */
const MAX_QUEUED = 1024

function globalTarget(): MessageTarget | null {
  const g = globalThis as unknown as Partial<MessageTarget>
  if (typeof g.postMessage !== 'function' || typeof g.addEventListener !== 'function') return null
  return g as MessageTarget
}

/**
 * Call this inside a dedicated `Worker` that opens its own `WebTransport`.
 *
 * Returns at once. Sends one hello and waits for the page's answer; calls made
 * meanwhile are kept and forwarded once it arrives. **Never throws**, and
 * `linked` never rejects: an unhandled rejection inside someone's worker is the
 * failure this package exists not to cause.
 */
export function initWorkerWith(
  drafts: DraftSet,
  port?: MessagePort,
  options: InitWorkerOptions = {},
): WorkerProbe {
  // Dormant install in this realm too: the worker's global is patched the moment
  // it imports the package, so bytes crossing before the page answers are
  // buffered rather than lost.
  ensureDormantHook()

  let probe: ProbeRuntime | null = null
  let queued: ((p: ProbeRuntime) => void)[] = []
  const defer = (f: (p: ProbeRuntime) => void): void => {
    if (probe !== null) {
      try {
        f(probe)
      } catch (err) {
        options.onInternalError?.(err)
      }
      return
    }
    if (queued.length < MAX_QUEUED) queued.push(f)
  }

  const linked = new Promise<boolean>((resolve) => {
    const target =
      (port as unknown as MessageTarget | undefined) ?? options.target ?? globalTarget()
    if (target === null) {
      resolve(false)
      return
    }
    let settled = false
    const set = options.setTimer ?? ((fn: () => void, d: number) => setTimeout(fn, d))
    const finish = (ok: boolean): void => {
      if (settled) return
      settled = true
      try {
        target.removeEventListener?.('message', onMessage)
      } catch {
        // A target that cannot be unlistened is not a failure worth reporting.
      }
      if (!ok) {
        queued = []
        // Nothing will attach in this realm to replay it into.
        releaseDormantEarly()
      }
      resolve(ok)
    }
    const onMessage = (e: LinkEvent): void => {
      const m = linkMessage(e.data)
      const channel = e.ports?.[0]
      if (m === null || m.t !== 'linked' || channel === undefined || settled) return
      try {
        const claim = claimDormantHook()
        probe = new ProbeRuntime(
          m as unknown as LinkedMessage,
          channel,
          claim.hook,
          drafts,
          options,
        )
        probe.start()
        const replay = queued
        queued = []
        for (const f of replay) f(probe)
        finish(true)
      } catch (err) {
        options.onInternalError?.(err)
        finish(false)
      }
    }
    try {
      target.addEventListener('message', onMessage)
      target.start?.()
      target.postMessage(
        envelope({ t: 'hello', timeOrigin: options.timeOrigin ?? performance.timeOrigin }),
      )
    } catch (err) {
      options.onInternalError?.(err)
      finish(false)
      return
    }
    set(() => finish(false), options.timeoutMs ?? DEFAULT_LIMITS.linkTimeoutMs)
  })

  return {
    linked,
    ids: () => probe?.ids ?? null,
    connectionIdOf: (transport) => connectionIdOf(transport),
    annotate: (name, data, connectionId) => defer((p) => p.annotate(name, data, connectionId)),
    observe: (name, value, labels) => defer((p) => p.observe(name, value, labels)),
    escalate: (level, reason) => defer((p) => p.escalate(level, reason)),
    resolve: (reason) => defer((p) => p.resolve(reason)),
  }
}
