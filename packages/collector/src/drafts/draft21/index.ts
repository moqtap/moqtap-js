/**
 * The draft-21 adapter.
 *
 * Draft-21 restructures draft-20 and changes nothing on the wire, so this
 * dialect is draft-20's field for field. The two are told apart only by the
 * ALPN they negotiate.
 *
 * **This module is the boundary of the draft-21 chunk.** It is reached only
 * through `DRAFT_LOADERS[21]`'s `() => import('../drafts/draft21/index.js')`, and
 * the `@moqtap/codec/draft21` specifier below is a **static string literal** on
 * purpose: a template literal would defeat bundler analysis and pull every
 * draft -- 39.6 KB gz against 5.3 KB, a 7.5x regression that looks
 * like every other import line in review.
 *
 * Two codec functions are used and the streaming decoders are deliberately not:
 * none of them reports a header's byte length without materialising the
 * payload, which is the whole economics of this package. See `../data-walk.ts`.
 */

import { decodeDatagram, decodeMessage, redactAuthTokens } from '@moqtap/codec/draft21'
import { PROTOCOL_STRINGS } from '../../draft/protocol.js'
import { readVi64, VI64_READER } from '../../draft/varint.js'
import type { DraftAdapter, SupportedDraft } from '../../types.js'
import { makeAdapter } from '../adapter.js'
import { BLOCK_LENGTH, BLOCK_NONE, PRESENT_BIT0, type WalkDialect } from '../data-walk.js'

/**
 * draft-21's data-stream dialect, read off `drafts/draft21/data-streams.ts`
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
export const draft: SupportedDraft = 21

/** The one adapter instance for draft-21. Stateless, so one is enough. */
export const DRAFT21_ADAPTER: DraftAdapter = /*#__PURE__*/ Object.freeze(
  makeAdapter(draft, PROTOCOL_STRINGS[21], VI64_READER, DIALECT, {
    decodeMessage,
    decodeDatagram,
    redactAuthTokens,
  }),
)

export { DRAFT21_ADAPTER as adapter }
