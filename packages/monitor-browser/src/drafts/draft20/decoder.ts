/**
 * `@moqtap/monitor-browser/draft20/decoder`: draft-20's decoder, for `compose()`.
 *
 * Importing this patches nothing; `compose()` installs the hook.
 */

import type { Draft } from '../../api/features.js'
import { OBSERVATION } from '../../api/observation.js'
import { DRAFT20_ADAPTER } from './index.js'

export const draft20: Draft = /*#__PURE__*/ Object.freeze({
  adapter: DRAFT20_ADAPTER,
  observation: OBSERVATION,
})
export { adapter, DRAFT20_ADAPTER, draft } from './index.js'
