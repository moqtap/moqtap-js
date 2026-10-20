import type { DraftAdapter } from '../types.js'
import { adapter as draft07 } from './draft07/index.js'
import { adapter as draft08 } from './draft08/index.js'
import { adapter as draft09 } from './draft09/index.js'
import { adapter as draft10 } from './draft10/index.js'
import { adapter as draft11 } from './draft11/index.js'
import { adapter as draft12 } from './draft12/index.js'
import { adapter as draft13 } from './draft13/index.js'
import { adapter as draft14 } from './draft14/index.js'
import { adapter as draft15 } from './draft15/index.js'
import { adapter as draft16 } from './draft16/index.js'
import { adapter as draft17 } from './draft17/index.js'
import { adapter as draft18 } from './draft18/index.js'
import { adapter as draft19 } from './draft19/index.js'
import { adapter as draft20 } from './draft20/index.js'
import { adapter as draft21 } from './draft21/index.js'
import { adapter as draft22 } from './draft22/index.js'

/** Every supported draft's adapter: what the root entry is built with. */
export const ALL_ADAPTERS: readonly DraftAdapter[] = /*#__PURE__*/ Object.freeze([
  draft07,
  draft08,
  draft09,
  draft10,
  draft11,
  draft12,
  draft13,
  draft14,
  draft15,
  draft16,
  draft17,
  draft18,
  draft19,
  draft20,
  draft21,
  draft22,
])
