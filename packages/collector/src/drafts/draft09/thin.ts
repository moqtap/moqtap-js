/**
 * `@moqtap/collector/draft09/thin`: the collector with draft-9's decoder
 * and no optional feature: no worker links, flight recorder, escalation,
 * custom metrics or IndexedDB.
 *
 * Importing this patches `globalThis.WebTransport`, dormant.
 */

import { compose } from '../../api/compose.js'
import { draft09 } from './decoder.js'

export const init = compose({ drafts: [draft09] })
export * from '../../public.js'
