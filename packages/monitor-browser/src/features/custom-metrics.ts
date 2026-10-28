/** Customer metrics: `defineMetric()` and `observe()`, in the page and its linked workers. */

import type { CustomMetricsFeature } from '../api/features.js'
import { CustomMetrics, RollupEngine } from '../rollup/index.js'

export const customMetrics: CustomMetricsFeature = {
  feature: 'customMetrics',
  create: (onError: (message: string) => void) => new CustomMetrics({ onError }),
  rollup: (o) => new RollupEngine({ ...o, maxBuckets: 1 }),
}
