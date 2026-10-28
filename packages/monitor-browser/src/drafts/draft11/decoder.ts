/**
 * `@moqtap/monitor-browser/draft11/decoder`: draft-11's decoder, for `compose()`.
 *
 * Importing this patches nothing; `compose()` installs the hook.
 */

import type { Draft } from '../../api/features.js'
import { OBSERVATION } from '../../api/observation.js'
import { DRAFT11_ADAPTER } from './index.js'

export const draft11: Draft = /*#__PURE__*/ Object.freeze({
  adapter: DRAFT11_ADAPTER,
  observation: OBSERVATION,
})
export { adapter, DRAFT11_ADAPTER, draft } from './index.js'
