/**
 * `@moqtap/collector/worker`: `initWorker()` alone, with the decoder for every
 * supported draft and the flight recorder, for a dedicated Worker that opens
 * its own WebTransport.
 *
 * The page side is not here: no uploader, no storage, no session. Use
 * `@moqtap/collector/draftNN/worker` for one draft's decoder.
 *
 * Importing this patches the worker's `globalThis.WebTransport`, dormant.
 */

import { composeWorker } from './api/compose.js'
import { ALL_DRAFTS } from './drafts/all.js'
import { flightRecorder } from './features/flight-recorder.js'

export const initWorker = composeWorker({ drafts: ALL_DRAFTS, features: [flightRecorder] })
export type { InitWorker, WorkerProbe } from './api/worker.js'
export type { DetailLevel } from './types.js'
