/**
 * `@moqtap/collector/draft15/thin`: the collector with draft-15's decoder
 * and no optional feature: no worker links, flight recorder, escalation,
 * custom metrics or IndexedDB.
 *
 * Importing this patches `globalThis.WebTransport`, dormant.
 */

import { compose } from '../../api/compose.js'
import { draft15 } from './decoder.js'

export const init = compose({ drafts: [draft15] })
export * from '../../public.js'
