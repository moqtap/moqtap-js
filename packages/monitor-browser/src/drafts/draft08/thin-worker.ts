/**
 * `@moqtap/monitor-browser/draft08/thin/worker`: `initWorker()` with
 * draft-8's decoder and no flight recorder.
 *
 * Importing this patches the worker's `globalThis.WebTransport`, dormant.
 */

import { composeWorker } from '../../api/compose.js'
import { draft08 } from './decoder.js'

export const initWorker = composeWorker({ drafts: [draft08] })
export type { InitWorker, WorkerProbe } from '../../api/worker.js'
export type { DetailLevel } from '../../types.js'
