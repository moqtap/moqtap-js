/**
 * `@moqtap/collector/draft09/worker`: `initWorker()` with draft-9's
 * decoder and the flight recorder, for a dedicated Worker that opens its own
 * WebTransport. The page side is not here.
 *
 * Importing this patches the worker's `globalThis.WebTransport`, dormant.
 */

import { composeWorker } from '../../api/compose.js'
import { flightRecorder } from '../../features/flight-recorder.js'
import { draft09 } from './decoder.js'

export const initWorker = composeWorker({ drafts: [draft09], features: [flightRecorder] })
export type { InitWorker, WorkerProbe } from '../../api/worker.js'
export type { DetailLevel } from '../../types.js'
