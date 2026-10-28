/** The API every entry point exports besides `init` and `initWorker`. */

export {
  BASELINE,
  CONFIG_KEYS,
  DEFAULT_ENDPOINT,
  DEFAULT_FLIGHT_RECORDER,
  DEFAULT_LIMITS,
  DEFAULT_METRICS,
  DEFAULT_PROVENANCE,
  DEFAULT_UPLOAD,
  DEFAULTS,
  isElevated,
  LIMIT_PROVENANCE,
  levelIndex,
  METRICS_PROVENANCE,
  TRIGGER_DEFAULTS,
  UPLOAD_PROVENANCE,
} from './api/defaults.js'
export type { Collector, ConnectionInfo } from './api/init.js'
export { COLLECTOR_VERSION, type MessageTarget } from './api/session.js'
export type { WorkerProbe } from './api/worker.js'
// The shared contract, re-exported so a TypeScript consumer never has to reach
// into a subpath for a type that appears in this package's own signatures.
export * from './types.js'
