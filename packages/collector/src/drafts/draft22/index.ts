/**
 * The draft-22 adapter.
 *
 * Draft-22 changes LOCATION_FILTER's encoding and nothing on the data streams,
 * so this dialect is draft-21's field for field, which is draft-20's. Control messages go through
 * `@moqtap/codec/draft22`, which owns that change.
 *
 * **This module is the boundary of the draft-22 chunk.** It is reached only
 * through `DRAFT_LOADERS[22]`'s `() => import('../drafts/draft22/index.js')`, and
 * the `@moqtap/codec/draft22` specifier below is a **static string literal** on
 * purpose: a template literal would defeat bundler analysis and pull every
 * draft -- 39.6 KB gz against 5.3 KB, a 7.5x regression that looks
 * like every other import line in review.
 *
 * Two codec functions are used and the streaming decoders are deliberately not:
 * none of them reports a header's byte length without materialising the
 * payload, which is the whole economics of this package. See `../data-walk.ts`.
 */

import { decodeDatagram, decodeMessage, redactAuthTokens } from '@moqtap/codec/draft22'
import { PROTOCOL_STRINGS } from '../../draft/protocol.js'
import { readVi64, VI64_READER } from '../../draft/varint.js'
import type { DraftAdapter, SupportedDraft } from '../../types.js'
import { makeAdapter } from '../adapter.js'
import { BLOCK_LENGTH, BLOCK_NONE, PRESENT_BIT0, type WalkDialect } from '../data-walk.js'

/**
 * draft-22's data-stream dialect, read off `drafts/draft22/data-streams.ts`
 * in `@moqtap/codec`, which is draft-20's unchanged.
 *
 * Field-by-field reasoning is on {@link WalkDialect}.
 */
const DIALECT: WalkDialect = /*#__PURE__*/ Object.freeze({
  readVarint: readVi64,

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
  // 0x8c Non-Existent, 0x10c Unknown, 0x20c Timed-Out.
  fetchMarkers: new Set<number>([0x8c, 0x10c, 0x20c]),
  fetchDatagramMode: true,
  fetchHasStatus: false,
  fetchGroupIsAbsolute: false,
  markerGroupIsAbsolute: false,
  fetchObjectIdIsAbsolute: false,
})

/**
 * The draft this chunk parses. Present so the module namespace object
 * structurally satisfies `DraftModule` with no wrapper allocation.
 */
export const draft: SupportedDraft = 22

/** The one adapter instance for draft-22. Stateless, so one is enough. */
export const DRAFT22_ADAPTER: DraftAdapter = /*#__PURE__*/ Object.freeze(
  makeAdapter(draft, PROTOCOL_STRINGS[22], VI64_READER, DIALECT, {
    decodeMessage,
    decodeDatagram,
    redactAuthTokens,
  }),
)

export { DRAFT22_ADAPTER as adapter }
