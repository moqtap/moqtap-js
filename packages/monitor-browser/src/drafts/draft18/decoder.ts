/**
 * `@moqtap/monitor-browser/draft18/decoder`: draft-18's decoder, for `compose()`.
 *
 * Importing this patches nothing; `compose()` installs the hook.
 */

import type { Draft } from '../../api/features.js'
import { OBSERVATION } from '../../api/observation.js'
import { DRAFT18_ADAPTER } from './index.js'

export const draft18: Draft = /*#__PURE__*/ Object.freeze({
  adapter: DRAFT18_ADAPTER,
  observation: OBSERVATION,
})
export { adapter, DRAFT18_ADAPTER, draft } from './index.js'
