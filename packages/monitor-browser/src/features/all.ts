import type { Feature } from '../api/features.js'
import { customMetrics } from './custom-metrics.js'
import { escalation } from './escalation.js'
import { flightRecorder } from './flight-recorder.js'
import { persistence } from './persistence.js'
import { workers } from './workers.js'

/** Every feature: what the root entry and each `draftNN` entry carry. */
export const ALL_FEATURES: readonly Feature[] = /*#__PURE__*/ Object.freeze([
  workers,
  escalation,
  flightRecorder,
  customMetrics,
  persistence,
])
