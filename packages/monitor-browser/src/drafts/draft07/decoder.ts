/**
 * `@moqtap/monitor-browser/draft07/decoder`: draft-7's decoder, for `compose()`.
 *
 * Importing this patches nothing; `compose()` installs the hook.
 */

import type { Draft } from '../../api/features.js'
import { OBSERVATION } from '../../api/observation.js'
import { DRAFT07_ADAPTER } from './index.js'

export const draft07: Draft = /*#__PURE__*/ Object.freeze({
  adapter: DRAFT07_ADAPTER,
  observation: OBSERVATION,
})
export { adapter, DRAFT07_ADAPTER, draft } from './index.js'
