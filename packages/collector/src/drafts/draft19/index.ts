/**
 * The draft-19 adapter.
 *
 * Wire-identical to draft-18 for these walks. The type is still a byte;
 * draft-20 widened it back to a varint.
 *
 * **This module is the boundary of the draft-19 chunk.** It is reached only
 * through `DRAFT_LOADERS[19]`'s `() => import('../drafts/draft19/index.js')`, and
 * the `@moqtap/codec/draft19` specifier below is a **static string literal** on
 * purpose: a template literal would defeat bundler analysis and pull every
 * draft -- 39.6 KB gz against 5.3 KB, a 7.5x regression that looks
 * like every other import line in review.
 *
 * Two codec functions are used and the streaming decoders are deliberately not:
 * none of them reports a header's byte length without materialising the
 * payload, which is the whole economics of this package. See `../data-walk.ts`.
 */

import { decodeDatagram, decodeMessage, redactAuthTokens } from '@moqtap/codec/draft19'
import { PROTOCOL_STRINGS } from '../../draft/protocol.js'
import { readVi64, VI64_READER } from '../../draft/varint.js'
import type { DraftAdapter, SupportedDraft } from '../../types.js'
import { makeAdapter } from '../adapter.js'
import { BLOCK_LENGTH, BLOCK_NONE, PRESENT_BIT0, type WalkDialect } from '../data-walk.js'

/**
 * draft-19's data-stream dialect, read off `drafts/draft19/data-streams.ts`.
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
export const draft: SupportedDraft = 19

/** The one adapter instance for draft-19. Stateless, so one is enough. */
export const DRAFT19_ADAPTER: DraftAdapter = /*#__PURE__*/ Object.freeze(
  makeAdapter(draft, PROTOCOL_STRINGS[19], VI64_READER, DIALECT, {
    decodeMessage,
    decodeDatagram,
    redactAuthTokens,
  }),
)

export { DRAFT19_ADAPTER as adapter }
