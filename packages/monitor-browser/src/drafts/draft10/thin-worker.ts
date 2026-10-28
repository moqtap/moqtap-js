/**
 * `@moqtap/monitor-browser/draft10/thin/worker`: `initWorker()` with
 * draft-10's decoder and no flight recorder.
 *
 * Importing this patches the worker's `globalThis.WebTransport`, dormant.
 */

import { composeWorker } from '../../api/compose.js'
import { draft10 } from './decoder.js'

export const initWorker = composeWorker({ drafts: [draft10] })
export type { InitWorker, WorkerProbe } from '../../api/worker.js'
export type { DetailLevel } from '../../types.js'
