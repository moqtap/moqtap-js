/**
 * `@moqtap/monitor-browser/draft18/thin/worker`: `initWorker()` with
 * draft-18's decoder and no flight recorder.
 *
 * Importing this patches the worker's `globalThis.WebTransport`, dormant.
 */

import { composeWorker } from '../../api/compose.js'
import { draft18 } from './decoder.js'

export const initWorker = composeWorker({ drafts: [draft18] })
export type { InitWorker, WorkerProbe } from '../../api/worker.js'
export type { DetailLevel } from '../../types.js'
