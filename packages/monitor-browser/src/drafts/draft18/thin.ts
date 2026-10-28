/**
 * `@moqtap/monitor-browser/draft18/thin`: the collector with draft-18's decoder
 * and no optional feature: no worker links, flight recorder, escalation,
 * custom metrics or IndexedDB.
 *
 * Importing this patches `globalThis.WebTransport`, dormant.
 */

import { compose } from '../../api/compose.js'
import { draft18 } from './decoder.js'

export const init = compose({ drafts: [draft18] })
export * from '../../public.js'
