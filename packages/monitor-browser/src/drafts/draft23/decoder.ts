/**
 * `@moqtap/monitor-browser/draft23/decoder`: draft-23's decoder, for `compose()`.
 *
 * Importing this patches nothing; `compose()` installs the hook.
 */

import type { Draft } from '../../api/features.js'
import { OBSERVATION } from '../../api/observation.js'
import { DRAFT23_ADAPTER } from './index.js'

export const draft23: Draft = /*#__PURE__*/ Object.freeze({
  adapter: DRAFT23_ADAPTER,
  observation: OBSERVATION,
})
export { adapter, DRAFT23_ADAPTER, draft } from './index.js'
