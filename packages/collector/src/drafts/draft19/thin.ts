/**
 * `@moqtap/collector/draft19/thin`: the collector with draft-19's decoder
 * and no optional feature: no worker links, flight recorder, escalation,
 * custom metrics or IndexedDB.
 *
 * Importing this patches `globalThis.WebTransport`, dormant.
 */

import { compose } from '../../api/compose.js'
import { draft19 } from './decoder.js'

export const init = compose({ drafts: [draft19] })
export * from '../../public.js'
