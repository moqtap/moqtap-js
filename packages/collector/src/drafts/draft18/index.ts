/**
 * The draft-18 adapter.
 *
 * The subgroup stream type narrowed to a single byte, and fetch Group IDs
 * became deltas. Two independent changes in one draft, and neither is visible
 * in the other's neighbourhood.
 *
 * **This module is the boundary of the draft-18 chunk.** It is reached only
 * through `DRAFT_LOADERS[18]`'s `() => import('../drafts/draft18/index.js')`, and
 * the `@moqtap/codec/draft18` specifier below is a **static string literal** on
 * purpose: a template literal would defeat bundler analysis and pull every
 * draft -- 39.6 KB gz against 5.3 KB, a 7.5x regression that looks
 * like every other import line in review.
 *
 * Two codec functions are used and the streaming decoders are deliberately not:
 * none of them reports a header's byte length without materialising the
 * payload, which is the whole economics of this package. See `../data-walk.ts`.
 */

import { decodeDatagram, decodeMessage, redactAuthTokens } from '@moqtap/codec/draft18'
import { PROTOCOL_STRINGS } from '../../draft/protocol.js'
import { readVi64, VI64_READER } from '../../draft/varint.js'
import type { DraftAdapter, SupportedDraft } from '../../types.js'
import { makeAdapter } from '../adapter.js'
import { BLOCK_LENGTH, BLOCK_NONE, PRESENT_BIT0, type WalkDialect } from '../data-walk.js'

/**
 * draft-18's data-stream dialect, read off `drafts/draft18/data-streams.ts`.
 *
 * Field-by-field reasoning is on {@link WalkDialect}.
 */
const DIALECT: WalkDialect = /*#__PURE__*/ Object.freeze({
  readVarint: readVi64,

  controlOpener: 0xaf,
  controlLengthIsVarint: false,

  subgroupTypeIsVarint: false,
  isSubgroupType: (v: number) => v < 0x80 && (v & 0x10) !== 0 && (v & 0x06) !== 0x06,
  subgroupIdAlways: false,
  priorityAlways: false,

  objectBlock: PRESENT_BIT0,
  blockShape: BLOCK_LENGTH,
  objectIdIsDelta: true,

  fetchFlagged: true,
  fetchPlainBlock: BLOCK_NONE,
  fetchFlagsIsVarint: true,
  // 0x8c Non-Existent, 0x10c Unknown.
  fetchMarkers: new Set<number>([0x8c, 0x10c]),
  fetchDatagramMode: true,
  fetchHasStatus: false,
  fetchGroupIsAbsolute: false,
  markerGroupIsAbsolute: true,
  fetchObjectIdIsAbsolute: true,
})

/**
 * The draft this chunk parses. Present so the module namespace object
 * structurally satisfies `DraftModule` with no wrapper allocation.
 */
export const draft: SupportedDraft = 18

/** The one adapter instance for draft-18. Stateless, so one is enough. */
export const DRAFT18_ADAPTER: DraftAdapter = /*#__PURE__*/ Object.freeze(
  makeAdapter(draft, PROTOCOL_STRINGS[18], VI64_READER, DIALECT, {
    decodeMessage,
    decodeDatagram,
    redactAuthTokens,
  }),
)

export { DRAFT18_ADAPTER as adapter }
