import { buildOf, type Init, workerBuildOf } from '../../api/compose.js'
import { useDormantRing } from '../../api/dormant.js'
import { initWith } from '../../api/init.js'
import { type InitWorker, initWorkerWith } from '../../api/worker.js'
import { ALL_DRAFTS } from '../../drafts/all.js'
import { ALL_FEATURES } from '../../features/all.js'
import { flightRecorder } from '../../features/flight-recorder.js'
import type { MockWebTransport } from '../transport/mocks.js'

useDormantRing(flightRecorder.ring)

const build = buildOf({ drafts: ALL_DRAFTS, features: ALL_FEATURES })
/** The worker entry's build: every draft and the flight recorder. */
export const workerBuild = workerBuildOf({ drafts: ALL_DRAFTS, features: [flightRecorder] })

/** The root entry's API without its module-eval hook install. */
export const init: Init = (config, options) => initWith(build, config, options)
export const initWorker: InitWorker = (port, options) => initWorkerWith(workerBuild, port, options)

/**
 * Construct a `WebTransport` through the page's global, as a player would: a
 * connection attempt, which begins the collector's session. Never opened, so
 * it stays a pending attempt until the test opens or closes it.
 */
export function attempt(url = 'https://relay.test/moq'): MockWebTransport {
  const g = globalThis as unknown as { WebTransport: new (u: string) => MockWebTransport }
  return new g.WebTransport(url)
}
