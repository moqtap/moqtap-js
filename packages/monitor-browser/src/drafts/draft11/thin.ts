/**
 * `@moqtap/monitor-browser/draft11/thin`: the collector with draft-11's decoder
 * and no optional feature: no worker links, flight recorder, escalation,
 * custom metrics or IndexedDB.
 *
 * Importing this patches `globalThis.WebTransport`, dormant.
 */

import { compose } from '../../api/compose.js'
import { draft11 } from './decoder.js'

export const init = compose({ drafts: [draft11] })
export * from '../../public.js'
