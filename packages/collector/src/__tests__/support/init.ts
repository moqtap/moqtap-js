import { entryPoint } from '../../api/entry.js'
import { ALL_ADAPTERS } from '../../drafts/all.js'

/** The root entry's API without its module-eval hook install. */
export const { init, initWorker } = entryPoint(ALL_ADAPTERS)
