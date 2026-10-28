/**
 * `@moqtap/monitor-browser/draft16/thin`: the collector with draft-16's decoder
 * and no optional feature: no worker links, flight recorder, escalation,
 * custom metrics or IndexedDB.
 *
 * Importing this patches `globalThis.WebTransport`, dormant.
 */

import { compose } from '../../api/compose.js'
import { draft16 } from './decoder.js'

export const init = compose({ drafts: [draft16] })
export * from '../../public.js'
