import { type DraftSet, draftSet } from '../draft/index.js'
import type { CollectorConfig, DraftAdapter } from '../types.js'
import { type Collector, type InitOptions, initWith } from './init.js'
import { type InitWorkerOptions, initWorkerWith, type WorkerProbe } from './worker.js'

export interface EntryPoint {
  /**
   * Start collecting in this page. One session per page until `end()`.
   * Returns at once. Throws only for a missing `apiKey` or an unusable
   * `endpoint`; every other configuration problem is reported and defaulted.
   */
  init(config: CollectorConfig, options?: InitOptions): Collector
  /**
   * In a Worker that opens its own WebTransport: report it through the page
   * that links this worker. Never uploads, never ends anything. Returns at once.
   */
  initWorker(port?: MessagePort, options?: InitWorkerOptions): WorkerProbe
}

/** `init` and `initWorker` bound to the decoders one entry point was built with. */
export function entryPoint(adapters: readonly DraftAdapter[]): EntryPoint {
  const drafts: DraftSet = draftSet(adapters)
  return {
    init: (config, options) => initWith(drafts, config, options),
    initWorker: (port, options) => initWorkerWith(drafts, port, options),
  }
}
