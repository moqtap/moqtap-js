/**
 * `@moqtap/collector/draft13`: the collector with draft-13's decoder and
 * every feature. A session on another draft is reported as `draft-mismatch`.
 *
 * Importing this patches `globalThis.WebTransport`, dormant.
 */

import { compose } from '../../api/compose.js'
import { ALL_FEATURES } from '../../features/all.js'
import { draft13 } from './decoder.js'

export const init = compose({ drafts: [draft13], features: ALL_FEATURES })
export * from '../../public.js'
