/**
 * `@moqtap/monitor-browser/draft13/thin/worker`: `initWorker()` with
 * draft-13's decoder and no flight recorder.
 *
 * Importing this patches the worker's `globalThis.WebTransport`, dormant.
 */

import { composeWorker } from '../../api/compose.js'
import { draft13 } from './decoder.js'

export const initWorker = composeWorker({ drafts: [draft13] })
export type { InitWorker, WorkerProbe } from '../../api/worker.js'
export type { DetailLevel } from '../../types.js'
