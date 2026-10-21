/**
 * `@moqtap/collector/internal`: the parts of the collector a test, a harness
 * or the moqtap browser extension builds on, and an integrator does not.
 *
 * No compatibility promise across minor versions. Importing this module
 * patches nothing.
 */

export { type ConfigProblem, type ResolveOptions, resolveConfig } from './api/config.js'
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
export { DB_NAME, type InitOptions } from './api/init.js'
export { billableSeconds, SUSPEND_TOLERANCE_MS, UsageMeter } from './api/meter.js'
export { CollectorRuntime, type RuntimePorts } from './api/session.js'
export type { InitWorkerOptions } from './api/worker.js'
/**
 * The page-global presence marker, a contract with the moqtap browser
 * extension, which reads it to show whether a connection it is inspecting is
 * also being collected. See `transport/presence.ts`.
 */
export type { CollectorPresence } from './transport/presence.js'
export { PRESENCE_KEY, readPresence } from './transport/presence.js'
