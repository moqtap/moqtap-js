/**
 * `@moqtap/monitor-browser/draft17/decoder`: draft-17's decoder, for `compose()`.
 *
 * Importing this patches nothing; `compose()` installs the hook.
 */

import type { Draft } from '../../api/features.js'
import { OBSERVATION } from '../../api/observation.js'
import { DRAFT17_ADAPTER } from './index.js'

export const draft17: Draft = /*#__PURE__*/ Object.freeze({
  adapter: DRAFT17_ADAPTER,
  observation: OBSERVATION,
})
export { adapter, DRAFT17_ADAPTER, draft } from './index.js'
