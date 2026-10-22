/**
 * `@moqtap/collector/draft10/decoder`: draft-10's decoder, for `compose()`.
 *
 * Importing this patches nothing; `compose()` installs the hook.
 */

import type { Draft } from '../../api/features.js'
import { OBSERVATION } from '../../api/observation.js'
import { DRAFT10_ADAPTER } from './index.js'

export const draft10: Draft = /*#__PURE__*/ Object.freeze({
  adapter: DRAFT10_ADAPTER,
  observation: OBSERVATION,
})
export { adapter, DRAFT10_ADAPTER, draft } from './index.js'
