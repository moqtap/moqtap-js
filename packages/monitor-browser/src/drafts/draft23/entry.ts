/**
 * `@moqtap/monitor-browser/draft23`: the collector with draft-23's decoder and
 * every feature. A session on another draft is reported as `draft-mismatch`.
 *
 * Importing this patches `globalThis.WebTransport`, dormant.
 */

import { compose } from '../../api/compose.js'
import { ALL_FEATURES } from '../../features/all.js'
import { draft23 } from './decoder.js'

export const init = compose({ drafts: [draft23], features: ALL_FEATURES })
export * from '../../public.js'
