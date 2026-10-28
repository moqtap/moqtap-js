/**
 * `@moqtap/monitor-browser/draft13/decoder`: draft-13's decoder, for `compose()`.
 *
 * Importing this patches nothing; `compose()` installs the hook.
 */

import type { Draft } from '../../api/features.js'
import { OBSERVATION } from '../../api/observation.js'
import { DRAFT13_ADAPTER } from './index.js'

export const draft13: Draft = /*#__PURE__*/ Object.freeze({
  adapter: DRAFT13_ADAPTER,
  observation: OBSERVATION,
})
export { adapter, DRAFT13_ADAPTER, draft } from './index.js'
