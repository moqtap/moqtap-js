/**
 * `@moqtap/collector` — the public entry.
 *
 * **Importing this module patches `globalThis.WebTransport`**, on the line
 * below, at module-evaluation time — before the importing entry file's body
 * runs, because ESM imports are hoisted. There is no call site to see it at,
 * which is why the README leads with it: a dependency that patches a global
 * invisibly is the shape security reviewers are trained to flag.
 *
 * Until {@link init} is called with a key, the hook copies recent wire bytes
 * into a small bounded in-memory ring, continuously overwrites that ring, and
 * makes no network request of any kind — no `fetch`, no `sendBeacon`, no
 * IndexedDB, no timer. `stop()` and `abort()` both restore the original global
 * and detach the per-instance patches on sessions already open.
 *
 * The hook has to be in place before the first `new WebTransport()`, and the
 * API key is frequently not known until later. Installing dormant and
 * configuring afterwards is what lets both be true: **the ordering is the
 * reason; the dormancy is the safeguard.**
 *
 * `@moqtap/codec` and `@moqtap/codec/session` are deliberately not imported
 * here. Both statically import every draft — 39.6 KB gz against 5.3 KB
 * for one draft's decoder — and the import line looks like every other import
 * line in review. One draft's chunk is fetched at session time behind a static
 * literal specifier in `src/draft/loaders.ts`, and `tsup.config.ts` refuses to
 * build if any file under `src/` names the root entry.
 */

import { ensureDormantHook } from './api/dormant.js'

// The side effect the README leads with, on the first executable line of the
// package, so a reader looking for it finds it here rather than three modules
// down.
ensureDormantHook()

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
  init,
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
  initWorker,
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
