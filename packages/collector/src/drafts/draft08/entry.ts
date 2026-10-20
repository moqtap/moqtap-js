/**
 * `@moqtap/collector/draft08`: the collector with draft-08's decoder and no
 * other. A session on another draft is reported as `draft-mismatch`.
 *
 * Importing this patches `globalThis.WebTransport`, as the root entry does.
 */

import { ensureDormantHook } from '../../api/dormant.js'
import { entryPoint } from '../../api/entry.js'
import { adapter } from './index.js'

ensureDormantHook()

export const { init, initWorker } = entryPoint([adapter])
export { PROTOCOL_STRINGS } from '../../draft/protocol.js'
export * from '../../public.js'
export { adapter, DRAFT08_ADAPTER, draft } from './index.js'
