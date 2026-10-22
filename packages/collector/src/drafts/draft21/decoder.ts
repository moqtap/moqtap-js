/**
 * `@moqtap/collector/draft21/decoder`: draft-21's decoder, for `compose()`.
 *
 * Importing this patches nothing; `compose()` installs the hook.
 */

import type { Draft } from '../../api/features.js'
import { OBSERVATION } from '../../api/observation.js'
import { DRAFT21_ADAPTER } from './index.js'

export const draft21: Draft = /*#__PURE__*/ Object.freeze({
  adapter: DRAFT21_ADAPTER,
  observation: OBSERVATION,
})
export { adapter, DRAFT21_ADAPTER, draft } from './index.js'
