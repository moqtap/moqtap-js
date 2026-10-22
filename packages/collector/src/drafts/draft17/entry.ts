/**
 * `@moqtap/collector/draft17`: the collector with draft-17's decoder and
 * every feature. A session on another draft is reported as `draft-mismatch`.
 *
 * Importing this patches `globalThis.WebTransport`, dormant.
 */

import { compose } from '../../api/compose.js'
import { ALL_FEATURES } from '../../features/all.js'
import { draft17 } from './decoder.js'

export const init = compose({ drafts: [draft17], features: ALL_FEATURES })
export * from '../../public.js'
