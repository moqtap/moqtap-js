/**
 * `@moqtap/monitor-browser/draft09/thin/worker`: `initWorker()` with
 * draft-9's decoder and no flight recorder.
 *
 * Importing this patches the worker's `globalThis.WebTransport`, dormant.
 */

import { composeWorker } from '../../api/compose.js'
import { draft09 } from './decoder.js'

export const initWorker = composeWorker({ drafts: [draft09] })
export type { InitWorker, WorkerProbe } from '../../api/worker.js'
export type { DetailLevel } from '../../types.js'
