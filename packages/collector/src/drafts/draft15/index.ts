/**
 * The draft-15 adapter.
 *
 * Two changes at once: the Publisher Priority byte became conditional on
 * bit 5, and fetch objects grew a Serialization Flags **byte** — with bits 6
 * and 7 reserved, so draft-15 has neither DATAGRAM mode nor End-of-Range
 * markers.
 *
 * **This module is the boundary of the draft-15 chunk.** It is reached only
 * through `DRAFT_LOADERS[15]`'s `() => import('../drafts/draft15/index.js')`, and
 * the `@moqtap/codec/draft15` specifier below is a **static string literal** on
 * purpose: a template literal would defeat bundler analysis and pull every
 * draft -- 39.6 KB gz against 5.3 KB, a 7.5x regression that looks
 * like every other import line in review.
 *
 * Two codec functions are used and the streaming decoders are deliberately not:
 * none of them reports a header's byte length without materialising the
 * payload, which is the whole economics of this package. See `../data-walk.ts`.
 */

import { decodeDatagram, decodeMessage, redactAuthTokens } from '@moqtap/codec/draft15'
import { PROTOCOL_STRINGS } from '../../draft/protocol.js'
import { RFC9000_READER, readRfc9000 } from '../../draft/varint.js'
import type { DraftAdapter, SupportedDraft } from '../../types.js'
import { makeAdapter } from '../adapter.js'
import { BLOCK_LENGTH, BLOCK_NONE, PRESENT_BIT0, type WalkDialect } from '../data-walk.js'

/**
 * draft-15's data-stream dialect, read off `drafts/draft15/data-streams.ts`.
 *
 * Field-by-field reasoning is on {@link WalkDialect}.
 */
const DIALECT: WalkDialect = /*#__PURE__*/ Object.freeze({
  readVarint: readRfc9000,

  controlOpener: -1,
  controlLengthIsVarint: false,

  subgroupTypeIsVarint: true,
  isSubgroupType: (v: number) =>
    ((v >= 0x10 && v <= 0x1f) || (v >= 0x30 && v <= 0x3f)) && (v & 0x06) !== 0x06,
  subgroupIdAlways: false,
  priorityAlways: false,

  objectBlock: PRESENT_BIT0,
  blockShape: BLOCK_LENGTH,
  objectIdIsDelta: true,

  fetchFlagged: true,
  fetchPlainBlock: BLOCK_NONE,
  fetchFlagsIsVarint: false,
  // draft-15 reserves the top two flag bits, so it has no markers at all.
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
export const draft: SupportedDraft = 15

/** The one adapter instance for draft-15. Stateless, so one is enough. */
export const DRAFT15_ADAPTER: DraftAdapter = /*#__PURE__*/ Object.freeze(
  makeAdapter(draft, PROTOCOL_STRINGS[15], RFC9000_READER, DIALECT, {
    decodeMessage,
    decodeDatagram,
    redactAuthTokens,
  }),
)

export { DRAFT15_ADAPTER as adapter }
