/**
 * `@moqtap/collector/draft10/thin`: the collector with draft-10's decoder
 * and no optional feature: no worker links, flight recorder, escalation,
 * custom metrics or IndexedDB.
 *
 * Importing this patches `globalThis.WebTransport`, dormant.
 */

import { compose } from '../../api/compose.js'
import { draft10 } from './decoder.js'

export const init = compose({ drafts: [draft10] })
export * from '../../public.js'
