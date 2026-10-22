/**
 * `@moqtap/collector/draft17/thin`: the collector with draft-17's decoder
 * and no optional feature: no worker links, flight recorder, escalation,
 * custom metrics or IndexedDB.
 *
 * Importing this patches `globalThis.WebTransport`, dormant.
 */

import { compose } from '../../api/compose.js'
import { draft17 } from './decoder.js'

export const init = compose({ drafts: [draft17] })
export * from '../../public.js'
