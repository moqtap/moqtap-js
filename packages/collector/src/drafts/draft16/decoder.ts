/**
 * `@moqtap/collector/draft16/decoder`: draft-16's decoder, for `compose()`.
 *
 * Importing this patches nothing; `compose()` installs the hook.
 */

import type { Draft } from '../../api/features.js'
import { OBSERVATION } from '../../api/observation.js'
import { DRAFT16_ADAPTER } from './index.js'

export const draft16: Draft = /*#__PURE__*/ Object.freeze({
  adapter: DRAFT16_ADAPTER,
  observation: OBSERVATION,
})
export { adapter, DRAFT16_ADAPTER, draft } from './index.js'
