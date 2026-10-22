/**
 * `@moqtap/collector/draft14/thin`: the collector with draft-14's decoder
 * and no optional feature: no worker links, flight recorder, escalation,
 * custom metrics or IndexedDB.
 *
 * Importing this patches `globalThis.WebTransport`, dormant.
 */

import { compose } from '../../api/compose.js'
import { draft14 } from './decoder.js'

export const init = compose({ drafts: [draft14] })
export * from '../../public.js'
