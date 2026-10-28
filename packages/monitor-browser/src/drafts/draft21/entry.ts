/**
 * `@moqtap/monitor-browser/draft21`: the collector with draft-21's decoder and
 * every feature. A session on another draft is reported as `draft-mismatch`.
 *
 * Importing this patches `globalThis.WebTransport`, dormant.
 */

import { compose } from '../../api/compose.js'
import { ALL_FEATURES } from '../../features/all.js'
import { draft21 } from './decoder.js'

export const init = compose({ drafts: [draft21], features: ALL_FEATURES })
export * from '../../public.js'
