/**
 * Detail above baseline: `escalate()`, the capture windows triggers open, and
 * the elevation ingest asks for. Without it every record is baseline.
 */

import { EscalationController } from '../api/escalation.js'
import type { EscalationFeature } from '../api/features.js'

export const escalation: EscalationFeature = {
  feature: 'escalation',
  create: (o) => new EscalationController(o),
}
