/**
 * Workers.
 *
 * A dedicated `Worker` is a separate JavaScript realm with its own
 * `globalThis`, so the page's patched `WebTransport` is not the worker's. The
 * worker installs its own hook at module-eval time by importing this package,
 * and this handshake is how it is told the key. Never blob-URL rewriting: it
 * needs `document_start` MAIN-world execution the SDK lacks, `blob:` workers
 * are blocked by most hardened `worker-src` policies, and substituting a
 * customer's worker is not a behaviour a dependency may have.
 *
 * The page names its worker explicitly through `Collector.linkWorker()` rather
 * than answering hellos automatically, because the page cannot enumerate its
 * own workers: the only automatic mechanism would be a `message` listener on
 * the page's own global, which also receives cross-origin `postMessage` from
 * any frame or opener, and answering one of those would post the customer's
 * `apiKey` to whoever asked for it.
 *
 * Fail closed in both directions. A worker that never hears back keeps its own
 * hook dormant, so its `WebTransport` traffic is buffered and discarded rather
 * than sent unkeyed; a page that called `linkWorker()` and never got a hello
 * marks its own session `partial` on the setup and terminal records.
 */

import type { CollectorConfig } from '../types.js'
import { ensureDormantHook, teardownDormant } from './dormant.js'
import {
  CONFIG,
  type Collector,
  HANDSHAKE,
  HELLO,
  type InitOptions,
  init,
  type MessageTarget,
} from './init.js'

/**
 * How long the worker waits for the page's answer.
 *
 * **Provenance: guess, pending field data**. Nothing else bounds it. Long
 * enough for a page that calls `linkWorker()` after its own bootstrap, short
 * enough that a worker in a page which never links it stops holding a listener
 * and a ring for a message that is not coming.
 */
export const WORKER_HANDSHAKE_TIMEOUT_MS = 5_000

export interface WorkerCollector extends Collector {
  /** `false` when the handshake timed out. The worker then collects nothing. */
  readonly linked: boolean
}

export interface InitWorkerOptions extends InitOptions {
  readonly timeoutMs?: number
  /** The object the handshake runs over. Defaults to the worker's own global. */
  readonly target?: MessageTarget
}

/** A collector that never got a key: every verb is total, and none transmits. */
function dormantCollector(): WorkerCollector {
  return {
    linked: false,
    stop: async () => {
      teardownDormant()
    },
    abort: async () => {
      teardownDormant()
    },
    annotate: () => {},
    defineMetric: () => {},
    observe: () => {},
    escalate: () => {},
    resolve: () => {},
    linkWorker: () => {},
    ids: () => ({ sessionId: '', connectionId: '' }),
    usage: () => ({
      bytesByLevel: { baseline: 0, headers: 0, 'headers+sizes': 0, 'headers+data': 0 },
      elevatedSeconds: 0,
      elevatedMinutes: 0,
      bytesPerElevatedMinute: 0,
      isEstimate: true,
    }),
  }
}

function globalTarget(): MessageTarget | null {
  const g = globalThis as unknown as Partial<MessageTarget>
  if (typeof g.postMessage !== 'function' || typeof g.addEventListener !== 'function') return null
  return g as MessageTarget
}

/**
 * Call this inside a dedicated `Worker` that opens its own `WebTransport`.
 *
 * Sends one hello and waits for the page's config. **Never rejects**: an
 * unanswered worker resolves to a collector whose `linked` is `false` and whose
 * every verb is inert, because an unhandled rejection inside someone's worker
 * is the failure this package exists not to cause.
 */
export async function initWorker(
  port?: MessagePort,
  options: InitWorkerOptions = {},
): Promise<WorkerCollector> {
  // Dormant install in this realm too: the worker's global is patched the moment
  // it imports the package, so bytes crossing before the page answers are
  // buffered rather than lost.
  ensureDormantHook()

  const target = (port as unknown as MessageTarget | undefined) ?? options.target ?? globalTarget()
  if (target === null || target === undefined) return dormantCollector()

  const timeoutMs = options.timeoutMs ?? WORKER_HANDSHAKE_TIMEOUT_MS
  const config = await new Promise<CollectorConfig | null>((resolve) => {
    let settled = false
    const finish = (c: CollectorConfig | null): void => {
      if (settled) return
      settled = true
      try {
        target.removeEventListener?.('message', onMessage)
      } catch {
        // A target that cannot be unlistened is not a failure worth reporting.
      }
      resolve(c)
    }
    const onMessage = (e: { data?: unknown }): void => {
      const d = e.data as Record<string, unknown> | undefined
      if (typeof d !== 'object' || d === null || d[HANDSHAKE] !== 1 || d.t !== CONFIG) return
      const c = d.config
      // Fail closed: an answer that is not a usable config is the same as no
      // answer, and the key is never invented here. The endpoint may legitimately
      // be absent — `resolveConfig` has a default for it.
      if (
        typeof c !== 'object' ||
        c === null ||
        typeof (c as CollectorConfig).apiKey !== 'string'
      ) {
        finish(null)
        return
      }
      finish(c as CollectorConfig)
    }
    try {
      target.addEventListener('message', onMessage)
      target.start?.()
      target.postMessage({ [HANDSHAKE]: 1, t: HELLO, v: 1 })
    } catch {
      finish(null)
      return
    }
    setTimeout(() => finish(null), timeoutMs)
  })

  if (config === null) return dormantCollector()

  const collector = init(config, options)
  // A delegating wrapper rather than a copy: `PendingCollector`'s methods read
  // private fields, and spreading would detach them from the instance that owns
  // them.
  return {
    linked: true,
    stop: () => collector.stop(),
    abort: () => collector.abort(),
    annotate: (n, d) => collector.annotate(n, d),
    defineMetric: (n, d) => collector.defineMetric(n, d),
    observe: (n, v, l) => (l === undefined ? collector.observe(n, v) : collector.observe(n, v, l)),
    escalate: (l, r) => collector.escalate(l, r),
    resolve: (r) => collector.resolve(r),
    ids: () => collector.ids(),
    usage: () => collector.usage(),
    linkWorker: (t) => collector.linkWorker(t),
  }
}
