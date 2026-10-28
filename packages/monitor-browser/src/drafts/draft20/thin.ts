/**
 * `@moqtap/monitor-browser/draft20/thin`: the collector with draft-20's decoder
 * and no optional feature: no worker links, flight recorder, escalation,
 * custom metrics or IndexedDB.
 *
 * Importing this patches `globalThis.WebTransport`, dormant.
 */

import { compose } from '../../api/compose.js'
import { draft20 } from './decoder.js'

export const init = compose({ drafts: [draft20] })
export * from '../../public.js'
