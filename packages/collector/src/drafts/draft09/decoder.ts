/**
 * `@moqtap/collector/draft09/decoder`: draft-9's decoder, for `compose()`.
 *
 * Importing this patches nothing; `compose()` installs the hook.
 */

import type { Draft } from '../../api/features.js'
import { OBSERVATION } from '../../api/observation.js'
import { DRAFT09_ADAPTER } from './index.js'

export const draft09: Draft = /*#__PURE__*/ Object.freeze({
  adapter: DRAFT09_ADAPTER,
  observation: OBSERVATION,
})
export { adapter, DRAFT09_ADAPTER, draft } from './index.js'
