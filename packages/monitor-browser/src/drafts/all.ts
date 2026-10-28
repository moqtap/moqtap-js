import type { Draft } from '../api/features.js'
import type { DraftAdapter } from '../types.js'
import { draft07 as d07 } from './draft07/decoder.js'
import { adapter as draft07 } from './draft07/index.js'
import { draft08 as d08 } from './draft08/decoder.js'
import { adapter as draft08 } from './draft08/index.js'
import { draft09 as d09 } from './draft09/decoder.js'
import { adapter as draft09 } from './draft09/index.js'
import { draft10 as d10 } from './draft10/decoder.js'
import { adapter as draft10 } from './draft10/index.js'
import { draft11 as d11 } from './draft11/decoder.js'
import { adapter as draft11 } from './draft11/index.js'
import { draft12 as d12 } from './draft12/decoder.js'
import { adapter as draft12 } from './draft12/index.js'
import { draft13 as d13 } from './draft13/decoder.js'
import { adapter as draft13 } from './draft13/index.js'
import { draft14 as d14 } from './draft14/decoder.js'
import { adapter as draft14 } from './draft14/index.js'
import { draft15 as d15 } from './draft15/decoder.js'
import { adapter as draft15 } from './draft15/index.js'
import { draft16 as d16 } from './draft16/decoder.js'
import { adapter as draft16 } from './draft16/index.js'
import { draft17 as d17 } from './draft17/decoder.js'
import { adapter as draft17 } from './draft17/index.js'
import { draft18 as d18 } from './draft18/decoder.js'
import { adapter as draft18 } from './draft18/index.js'
import { draft19 as d19 } from './draft19/decoder.js'
import { adapter as draft19 } from './draft19/index.js'
import { draft20 as d20 } from './draft20/decoder.js'
import { adapter as draft20 } from './draft20/index.js'
import { draft21 as d21 } from './draft21/decoder.js'
import { adapter as draft21 } from './draft21/index.js'
import { draft22 as d22 } from './draft22/decoder.js'
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

/** Every draft, with the observation that runs it, for `compose()`. */
export const ALL_DRAFTS: readonly Draft[] = /*#__PURE__*/ Object.freeze([
  d07,
  d08,
  d09,
  d10,
  d11,
  d12,
  d13,
  d14,
  d15,
  d16,
  d17,
  d18,
  d19,
  d20,
  d21,
  d22,
])
