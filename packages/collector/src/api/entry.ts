import { type DraftSet, draftSet } from '../draft/index.js'
import type { CollectorConfig, DraftAdapter } from '../types.js'
import { type Collector, type InitOptions, initWith } from './init.js'
import { type InitWorkerOptions, initWorkerWith, type WorkerCollector } from './worker.js'

export interface EntryPoint {
  /**
   * Start collecting. Throws only for a missing `apiKey` or an unusable
   * `endpoint`; every other configuration problem is reported and defaulted.
   */
  init(config: CollectorConfig, options?: InitOptions): Collector
  /**
   * Call inside a dedicated `Worker` that opens its own `WebTransport`. Waits
   * for the page's config through `linkWorker()`. Never rejects: unanswered,
   * it resolves to an inert collector whose `linked` is `false`.
   */
  initWorker(port?: MessagePort, options?: InitWorkerOptions): Promise<WorkerCollector>
}

/** `init` and `initWorker` bound to the decoders one entry point was built with. */
export function entryPoint(adapters: readonly DraftAdapter[]): EntryPoint {
  const drafts: DraftSet = draftSet(adapters)
  return {
    init: (config, options) => initWith(drafts, config, options),
    initWorker: (port, options) => initWorkerWith(drafts, port, options),
  }
}
