/**
 * `@moqtap/collector/draft12/decoder`: draft-12's decoder, for `compose()`.
 *
 * Importing this patches nothing; `compose()` installs the hook.
 */

import type { Draft } from '../../api/features.js'
import { OBSERVATION } from '../../api/observation.js'
import { DRAFT12_ADAPTER } from './index.js'

export const draft12: Draft = /*#__PURE__*/ Object.freeze({
  adapter: DRAFT12_ADAPTER,
  observation: OBSERVATION,
})
export { adapter, DRAFT12_ADAPTER, draft } from './index.js'
