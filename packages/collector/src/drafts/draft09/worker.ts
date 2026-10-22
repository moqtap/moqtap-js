/**
 * `@moqtap/collector/draft09/worker`: `initWorker()` alone, with draft-09's
 * decoder and no other, for a dedicated Worker that opens its own WebTransport.
 * The page side is not here.
 *
 * Importing this patches the worker's `globalThis.WebTransport`, as every
 * entry but `internal` does.
 */

import { ensureDormantHook } from '../../api/dormant.js'
import { workerEntryPoint } from '../../api/worker.js'
import { adapter } from './index.js'

ensureDormantHook()

export const initWorker = workerEntryPoint([adapter])
export type { InitWorker, WorkerProbe } from '../../api/worker.js'
export type { DetailLevel } from '../../types.js'
