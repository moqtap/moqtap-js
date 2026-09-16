/**
 * `@moqtap/collector` — the rollup module.
 *
 * What the device computes and keeps: fixed-boundary histograms that merge by
 * addition, one interval row per track, customer metrics folded to fixed cost,
 * and the per-track running median the cadence trigger reads.
 *
 * Zero imports outside `../types.js`. The decoder writes into
 * {@link RollupEngine} through {@link import('../types.js').CountingSink} and
 * the two modules share no file; everything the engine produces leaves through
 * {@link import('../types.js').RecordSink}.
 */

export {
  DUPLICATE_WINDOW,
  MAX_GAP_RUN,
  MEDIAN_MIN_SAMPLES,
  MEDIAN_WINDOW,
  SlidingMedian,
  STALL_FLOOR_MS,
  STALL_MULTIPLE,
  TrackBucket,
  type TrackBucketOptions,
} from './bucket.js'
export {
  CustomMetrics,
  type CustomMetricsOptions,
  MAX_ERROR_REPORTS,
  MAX_LABEL_VALUE_LENGTH,
  MAX_LABELS,
  MAX_METRICS,
  MAX_SERIES_PER_METRIC,
} from './custom-metrics.js'
export {
  BOUNDARIES,
  bucketIndex,
  DEFAULT_CUSTOM_BOUNDARIES,
  DURATION_BOUNDARIES,
  flattenHistogram,
  HISTOGRAM_COUNT_MAX,
  Histogram,
  SIZE_BOUNDARIES,
} from './histogram.js'
export {
  IDLE_EVICT_INTERVALS,
  type MedianSource,
  RollupEngine,
  type RollupEngineOptions,
  SUSPEND_TOLERANCE_MS,
} from './interval.js'
