/**
 * `@moqtap/collector/features`: the optional parts of the collector, for
 * `compose()`. A bundle carries the ones it imports and no other.
 *
 *  - `workers` — `linkWorker()`: a dedicated worker's transports report into the page.
 *  - `escalation` — `escalate()` and detail above baseline.
 *  - `flightRecorder` — the stall and cadence triggers and the dump they fire.
 *    A page needs `escalation` with it: a trigger opens a capture window.
 *  - `customMetrics` — `defineMetric()` and `observe()`.
 *  - `persistence` — IndexedDB: a body the page could not send is sent by the
 *    next page load.
 *
 * Importing this patches nothing.
 */

export { customMetrics } from './custom-metrics.js'
export { escalation } from './escalation.js'
export { flightRecorder } from './flight-recorder.js'
export { persistence } from './persistence.js'
export { workers } from './workers.js'
