/**
 * `@moqtap/monitor-browser/draft20/thin/worker`: `initWorker()` with
 * draft-20's decoder and no flight recorder.
 *
 * Importing this patches the worker's `globalThis.WebTransport`, dormant.
 */

import { composeWorker } from '../../api/compose.js'
import { draft20 } from './decoder.js'

export const initWorker = composeWorker({ drafts: [draft20] })
export type { InitWorker, WorkerProbe } from '../../api/worker.js'
export type { DetailLevel } from '../../types.js'
