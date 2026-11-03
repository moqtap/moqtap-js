/**
 * `@moqtap/monitor-browser/draft23/thin`: the collector with draft-23's decoder
 * and no optional feature: no worker links, flight recorder, escalation,
 * custom metrics or IndexedDB.
 *
 * Importing this patches `globalThis.WebTransport`, dormant.
 */

import { compose } from '../../api/compose.js'
import { draft23 } from './decoder.js'

export const init = compose({ drafts: [draft23] })
export * from '../../public.js'
