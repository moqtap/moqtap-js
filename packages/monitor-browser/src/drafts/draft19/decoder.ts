/**
 * `@moqtap/monitor-browser/draft19/decoder`: draft-19's decoder, for `compose()`.
 *
 * Importing this patches nothing; `compose()` installs the hook.
 */

import type { Draft } from '../../api/features.js'
import { OBSERVATION } from '../../api/observation.js'
import { DRAFT19_ADAPTER } from './index.js'

export const draft19: Draft = /*#__PURE__*/ Object.freeze({
  adapter: DRAFT19_ADAPTER,
  observation: OBSERVATION,
})
export { adapter, DRAFT19_ADAPTER, draft } from './index.js'
