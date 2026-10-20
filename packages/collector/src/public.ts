/** The API every entry point exports besides `init` and `initWorker`. */

export { type ConfigProblem, type ResolveOptions, resolveConfig } from './api/config.js'
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
export {
  DORMANT_DATAGRAM_STREAM_ID,
  type DormantState,
  dormantState,
  drainDormant,
  ensureDormantHook,
  teardownDormant,
} from './api/dormant.js'
export {
  type EscalationCause,
  EscalationController,
  type EscalationControllerOptions,
  type RingPressure,
  TRIGGER_CAPTURE_LEVEL,
} from './api/escalation.js'
export {
  type Collector,
  DB_NAME,
  type InitOptions,
  type MessageTarget,
} from './api/init.js'
export { billableSeconds, SUSPEND_TOLERANCE_MS, UsageMeter } from './api/meter.js'
export {
  COLLECTOR_VERSION,
  CollectorRuntime,
  type RuntimePorts,
} from './api/session.js'
export {
  type InitWorkerOptions,
  WORKER_HANDSHAKE_TIMEOUT_MS,
  type WorkerCollector,
} from './api/worker.js'
/**
 * The page-global presence marker — a cross-repository contract with the moqtap
 * browser extension, which reads it to show whether a connection it is
 * inspecting is also being collected. See `transport/presence.ts`.
 */
export type { CollectorPresence } from './transport/presence.js'
export { PRESENCE_KEY, readPresence } from './transport/presence.js'
// The shared contract, re-exported so a TypeScript consumer never has to reach
// into a subpath for a type that appears in this package's own signatures.
export * from './types.js'
