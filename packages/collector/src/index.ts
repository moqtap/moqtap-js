/**
 * `@moqtap/collector`, with the decoder for every supported draft and every
 * feature.
 *
 * **Importing this module patches `globalThis.WebTransport`**, at module
 * evaluation, so the hook is in place before the first `new WebTransport()`.
 * Until `init()` supplies a key it only buffers recent wire bytes in a bounded
 * ring and makes no network request. `end()` and `discard()` restore the global.
 *
 * `@moqtap/collector/draftNN` is the same with one draft's decoder,
 * `@moqtap/collector/draftNN/thin` that without the optional features, and
 * `@moqtap/collector/compose` builds any other combination.
 */

import { compose } from './api/compose.js'
import { ALL_DRAFTS } from './drafts/all.js'
import { ALL_FEATURES } from './features/all.js'

export const init = compose({ drafts: ALL_DRAFTS, features: ALL_FEATURES })
export * from './public.js'
