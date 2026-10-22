/**
 * `@moqtap/collector/draft08/decoder`: draft-8's decoder, for `compose()`.
 *
 * Importing this patches nothing; `compose()` installs the hook.
 */

import type { Draft } from '../../api/features.js'
import { OBSERVATION } from '../../api/observation.js'
import { DRAFT08_ADAPTER } from './index.js'

export const draft08: Draft = /*#__PURE__*/ Object.freeze({
  adapter: DRAFT08_ADAPTER,
  observation: OBSERVATION,
})
export { adapter, DRAFT08_ADAPTER, draft } from './index.js'
