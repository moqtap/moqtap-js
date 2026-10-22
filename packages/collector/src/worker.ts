/**
 * `@moqtap/collector/worker`: `initWorker()` alone, with the decoder for every
 * supported draft, for a dedicated Worker that opens its own WebTransport.
 *
 * The page side is not here: no uploader, no storage, no session. Use
 * `@moqtap/collector/draftNN/worker` for one draft's decoder.
 *
 * Importing this patches the worker's `globalThis.WebTransport`, as every
 * entry but `internal` does.
 */

import { ensureDormantHook } from './api/dormant.js'
import { workerEntryPoint } from './api/worker.js'
import { ALL_ADAPTERS } from './drafts/all.js'

ensureDormantHook()

export const initWorker = workerEntryPoint(ALL_ADAPTERS)
export type { InitWorker, WorkerProbe } from './api/worker.js'
export type { DetailLevel } from './types.js'
