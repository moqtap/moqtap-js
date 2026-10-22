/**
 * `@moqtap/collector/draft08/thin`: the collector with draft-8's decoder
 * and no optional feature: no worker links, flight recorder, escalation,
 * custom metrics or IndexedDB.
 *
 * Importing this patches `globalThis.WebTransport`, dormant.
 */

import { compose } from '../../api/compose.js'
import { draft08 } from './decoder.js'

export const init = compose({ drafts: [draft08] })
export * from '../../public.js'
