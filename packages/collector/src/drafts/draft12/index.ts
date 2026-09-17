/**
 * The draft-12 adapter.
 *
 * The subgroup type range moved to `0x10-0x15` and `0x18-0x1D`. Object IDs
 * are still absolute; draft-14 made them deltas.
 *
 * **This module is the boundary of the draft-12 chunk.** It is reached only
 * through `DRAFT_LOADERS[12]`'s `() => import('../drafts/draft12/index.js')`, and
 * the `@moqtap/codec/draft12` specifier below is a **static string literal** on
 * purpose: a template literal would defeat bundler analysis and pull every
 * draft -- 39.6 KB gz against 5.3 KB, a 7.5x regression that looks
 * like every other import line in review.
 *
 * Two codec functions are used and the streaming decoders are deliberately not:
 * none of them reports a header's byte length without materialising the
 * payload, which is the whole economics of this package. See `../data-walk.ts`.
 */

import { decodeDatagram, decodeMessage, redactAuthTokens } from '@moqtap/codec/draft12'
import { PROTOCOL_STRINGS } from '../../draft/protocol.js'
import { RFC9000_READER, readRfc9000 } from '../../draft/varint.js'
import type { DraftAdapter, SupportedDraft } from '../../types.js'
import { makeAdapter } from '../adapter.js'
import { BLOCK_LENGTH, PRESENT_BIT0, type WalkDialect } from '../data-walk.js'

/**
 * draft-12's data-stream dialect, read off `drafts/draft12/data-streams.ts`.
 *
 * Field-by-field reasoning is on {@link WalkDialect}.
 */
const DIALECT: WalkDialect = /*#__PURE__*/ Object.freeze({
  readVarint: readRfc9000,

  controlOpener: -1,
  controlLengthIsVarint: false,

  subgroupTypeIsVarint: true,
  isSubgroupType: (v: number) => (v >= 0x10 && v <= 0x15) || (v >= 0x18 && v <= 0x1d),
  subgroupIdAlways: false,
  priorityAlways: true,

  objectBlock: PRESENT_BIT0,
  blockShape: BLOCK_LENGTH,
  objectIdIsDelta: false,

  fetchFlagged: false,
  fetchPlainBlock: BLOCK_LENGTH,
  fetchFlagsIsVarint: false,
  // An unflagged fetch object has no Serialization Flags field, so the
  // three fields below are never consulted on this draft.
  fetchMarkers: new Set<number>(),
  fetchDatagramMode: false,
  fetchHasStatus: true,
  fetchGroupIsAbsolute: true,
  markerGroupIsAbsolute: true,
  fetchObjectIdIsAbsolute: true,
})

/**
 * The draft this chunk parses. Present so the module namespace object
 * structurally satisfies `DraftModule` with no wrapper allocation.
 */
export const draft: SupportedDraft = 12

/** The one adapter instance for draft-12. Stateless, so one is enough. */
export const DRAFT12_ADAPTER: DraftAdapter = /*#__PURE__*/ Object.freeze(
  makeAdapter(draft, PROTOCOL_STRINGS[12], RFC9000_READER, DIALECT, {
    decodeMessage,
    decodeDatagram,
    redactAuthTokens,
  }),
)

export { DRAFT12_ADAPTER as adapter }
