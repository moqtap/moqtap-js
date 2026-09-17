/**
 * The draft-16 adapter.
 *
 * Fetch Serialization Flags widened to a varint and gained the two
 * End-of-Range markers and DATAGRAM mode. Fetch objects **lost** their Object
 * Status in the same step, and reading one that is not there consumes the next
 * object's first field.
 *
 * **This module is the boundary of the draft-16 chunk.** It is reached only
 * through `DRAFT_LOADERS[16]`'s `() => import('../drafts/draft16/index.js')`, and
 * the `@moqtap/codec/draft16` specifier below is a **static string literal** on
 * purpose: a template literal would defeat bundler analysis and pull every
 * draft -- 39.6 KB gz against 5.3 KB, a 7.5x regression that looks
 * like every other import line in review.
 *
 * Two codec functions are used and the streaming decoders are deliberately not:
 * none of them reports a header's byte length without materialising the
 * payload, which is the whole economics of this package. See `../data-walk.ts`.
 */

import { decodeDatagram, decodeMessage, redactAuthTokens } from '@moqtap/codec/draft16'
import { PROTOCOL_STRINGS } from '../../draft/protocol.js'
import { RFC9000_READER, readRfc9000 } from '../../draft/varint.js'
import type { DraftAdapter, SupportedDraft } from '../../types.js'
import { makeAdapter } from '../adapter.js'
import { BLOCK_LENGTH, BLOCK_NONE, PRESENT_BIT0, type WalkDialect } from '../data-walk.js'

/**
 * draft-16's data-stream dialect, read off `drafts/draft16/data-streams.ts`.
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
export const draft: SupportedDraft = 16

/** The one adapter instance for draft-16. Stateless, so one is enough. */
export const DRAFT16_ADAPTER: DraftAdapter = /*#__PURE__*/ Object.freeze(
  makeAdapter(draft, PROTOCOL_STRINGS[16], RFC9000_READER, DIALECT, {
    decodeMessage,
    decodeDatagram,
    redactAuthTokens,
  }),
)

export { DRAFT16_ADAPTER as adapter }
