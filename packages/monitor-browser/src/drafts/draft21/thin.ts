/**
 * `@moqtap/monitor-browser/draft21/thin`: the collector with draft-21's decoder
 * and no optional feature: no worker links, flight recorder, escalation,
 * custom metrics or IndexedDB.
 *
 * Importing this patches `globalThis.WebTransport`, dormant.
 */

import { compose } from '../../api/compose.js'
import { draft21 } from './decoder.js'

export const init = compose({ drafts: [draft21] })
export * from '../../public.js'
