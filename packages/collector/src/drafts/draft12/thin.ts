/**
 * `@moqtap/collector/draft12/thin`: the collector with draft-12's decoder
 * and no optional feature: no worker links, flight recorder, escalation,
 * custom metrics or IndexedDB.
 *
 * Importing this patches `globalThis.WebTransport`, dormant.
 */

import { compose } from '../../api/compose.js'
import { draft12 } from './decoder.js'

export const init = compose({ drafts: [draft12] })
export * from '../../public.js'
