/**
 * `@moqtap/monitor-browser/compose`: a collector of exactly the drafts and features
 * a page names.
 *
 *     import { compose } from '@moqtap/monitor-browser/compose'
 *     import { draft14 } from '@moqtap/monitor-browser/draft14/decoder'
 *     import { workers, persistence } from '@moqtap/monitor-browser/features'
 *
 *     export const init = compose({ drafts: [draft14], features: [workers, persistence] })
 *
 * A page whose transports all live in linked workers needs no draft:
 * `compose({ features: [workers] })`. Call it at module level; with a draft it
 * patches `globalThis.WebTransport`, dormant, as every prebuilt entry does.
 */

export { type Composition, compose, composeWorker, type Init } from './api/compose.js'
export type { Draft, Feature } from './api/features.js'
export type { InitWorker, WorkerProbe } from './api/worker.js'
export * from './public.js'
