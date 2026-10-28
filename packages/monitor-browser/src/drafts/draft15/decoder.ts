/**
 * `@moqtap/monitor-browser/draft15/decoder`: draft-15's decoder, for `compose()`.
 *
 * Importing this patches nothing; `compose()` installs the hook.
 */

import type { Draft } from '../../api/features.js'
import { OBSERVATION } from '../../api/observation.js'
import { DRAFT15_ADAPTER } from './index.js'

export const draft15: Draft = /*#__PURE__*/ Object.freeze({
  adapter: DRAFT15_ADAPTER,
  observation: OBSERVATION,
})
export { adapter, DRAFT15_ADAPTER, draft } from './index.js'
