/**
 * `@moqtap/collector/draft22/decoder`: draft-22's decoder, for `compose()`.
 *
 * Importing this patches nothing; `compose()` installs the hook.
 */

import type { Draft } from '../../api/features.js'
import { OBSERVATION } from '../../api/observation.js'
import { DRAFT22_ADAPTER } from './index.js'

export const draft22: Draft = /*#__PURE__*/ Object.freeze({
  adapter: DRAFT22_ADAPTER,
  observation: OBSERVATION,
})
export { adapter, DRAFT22_ADAPTER, draft } from './index.js'
