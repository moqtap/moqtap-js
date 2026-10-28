/**
 * `@moqtap/monitor-browser/draft14/decoder`: draft-14's decoder, for `compose()`.
 *
 * Importing this patches nothing; `compose()` installs the hook.
 */

import type { Draft } from '../../api/features.js'
import { OBSERVATION } from '../../api/observation.js'
import { DRAFT14_ADAPTER } from './index.js'

export const draft14: Draft = /*#__PURE__*/ Object.freeze({
  adapter: DRAFT14_ADAPTER,
  observation: OBSERVATION,
})
export { adapter, DRAFT14_ADAPTER, draft } from './index.js'
