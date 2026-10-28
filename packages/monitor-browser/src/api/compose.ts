/**
 * Build a collector from the drafts and features a page needs, and nothing
 * else.
 *
 * Every published entry is one of these calls. A bundle holds exactly the
 * modules its entry imports: the drafts listed here and the features listed
 * here. Calling it installs the `WebTransport` hook in this realm, dormant,
 * when a draft is given, so call it at module level, before the page or the
 * worker constructs its first transport.
 */

import { draftSet } from '../draft/index.js'
import type { CollectorConfig } from '../types.js'
import { type Draft, type Feature, featureSet } from './features.js'
import { type Collector, type InitOptions, initWith } from './init.js'
import type { WorkerBuild } from './probe.js'
import type { Build } from './session.js'
import { type InitWorker, initWorkerWith } from './worker.js'

export interface Composition {
  /**
   * The drafts this build decodes, from `@moqtap/monitor-browser/drafts/draftNN`.
   * A page whose transports all live in linked workers needs none.
   */
  readonly drafts?: readonly Draft[]
  /** From `@moqtap/monitor-browser/features`. */
  readonly features?: readonly Feature[]
}

/**
 * Start collecting in this page. A session begins with the first
 * `WebTransport` the page or a linked worker constructs; before that nothing
 * is recorded or sent. Returns at once. Throws only for a missing `apiKey`
 * or an unusable `endpoint`; every other configuration problem is reported
 * and defaulted.
 */
export type Init = (config: CollectorConfig, options?: InitOptions) => Collector

/** The page's `init`, carrying `drafts` and `features`. */
export function compose(c: Composition): Init {
  const build = buildOf(c)
  build.observation?.install(build.features.flightRecorder?.ring)
  return (config, options) => initWith(build, config, options)
}

/** What `compose()` builds, without installing anything. */
export function buildOf(c: Composition): Build {
  const drafts = c.drafts ?? []
  return {
    drafts: draftSet(drafts.map((d) => d.adapter)),
    observation: drafts[0]?.observation ?? null,
    features: featureSet(c.features ?? []),
  }
}

/**
 * A worker's `initWorker`, carrying `drafts` and, of `features`, the flight
 * recorder: everything else a worker reports goes to its page.
 */
export function composeWorker(c: Composition & { readonly drafts: readonly Draft[] }): InitWorker {
  const build = workerBuildOf(c)
  c.drafts[0]?.observation.install(build.recorder?.ring)
  return (port, options) => initWorkerWith(build, port, options)
}

/** What `composeWorker()` builds, without installing anything. */
export function workerBuildOf(c: Composition): WorkerBuild {
  return {
    drafts: draftSet((c.drafts ?? []).map((d) => d.adapter)),
    recorder: featureSet(c.features ?? []).flightRecorder,
  }
}
