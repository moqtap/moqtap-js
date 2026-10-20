/**
 * `@moqtap/collector`, with the decoder for every supported draft.
 *
 * **Importing this module patches `globalThis.WebTransport`**, at module
 * evaluation, so the hook is in place before the first `new WebTransport()`.
 * Until `init()` supplies a key it only buffers recent wire bytes in a bounded
 * ring and makes no network request. `stop()` and `abort()` restore the global.
 *
 * `@moqtap/collector/draftNN` is the same API with one draft's decoder.
 */

import { ensureDormantHook } from './api/dormant.js'
import { entryPoint } from './api/entry.js'
import { ALL_ADAPTERS } from './drafts/all.js'

ensureDormantHook()

export const { init, initWorker } = entryPoint(ALL_ADAPTERS)
export * from './public.js'
