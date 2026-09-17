/**
 * The draft-17 adapter.
 *
 * The varint family changes here: MoQT's leading-1-bits vi64 replaces RFC
 * 9000's, and control moves to a unidirectional stream opening `af 00`. Fetch
 * Group IDs are still absolute; draft-18 made them deltas.
 *
 * **This module is the boundary of the draft-17 chunk.** It is reached only
 * through `DRAFT_LOADERS[17]`'s `() => import('../drafts/draft17/index.js')`, and
 * the `@moqtap/codec/draft17` specifier below is a **static string literal** on
 * purpose: a template literal would defeat bundler analysis and pull every
 * draft -- 39.6 KB gz against 5.3 KB, a 7.5x regression that looks
 * like every other import line in review.
 *
 * Two codec functions are used and the streaming decoders are deliberately not:
 * none of them reports a header's byte length without materialising the
 * payload, which is the whole economics of this package. See `../data-walk.ts`.
 */

import { decodeDatagram, decodeMessage, redactAuthTokens } from '@moqtap/codec/draft17'
import { PROTOCOL_STRINGS } from '../../draft/protocol.js'
import { readVi64Draft17, VI64_D17_READER } from '../../draft/varint.js'
import type { DraftAdapter, SupportedDraft } from '../../types.js'
import { makeAdapter } from '../adapter.js'
import { BLOCK_LENGTH, BLOCK_NONE, PRESENT_BIT0, type WalkDialect } from '../data-walk.js'

/**
 * draft-17's data-stream dialect, read off `drafts/draft17/data-streams.ts`.
 *
 * Field-by-field reasoning is on {@link WalkDialect}.
 */
const DIALECT: WalkDialect = /*#__PURE__*/ Object.freeze({
  readVarint: readVi64Draft17,

  controlOpener: 0xaf,
  controlLengthIsVarint: false,

  subgroupTypeIsVarint: true,
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
  fetchGroupIsAbsolute: true,
  markerGroupIsAbsolute: true,
  fetchObjectIdIsAbsolute: true,
})

/**
 * The draft this chunk parses. Present so the module namespace object
 * structurally satisfies `DraftModule` with no wrapper allocation.
 */
export const draft: SupportedDraft = 17

/** The one adapter instance for draft-17. Stateless, so one is enough. */
export const DRAFT17_ADAPTER: DraftAdapter = /*#__PURE__*/ Object.freeze(
  makeAdapter(draft, PROTOCOL_STRINGS[17], VI64_D17_READER, DIALECT, {
    decodeMessage,
    decodeDatagram,
    redactAuthTokens,
  }),
)

export { DRAFT17_ADAPTER as adapter }
