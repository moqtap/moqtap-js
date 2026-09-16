/**
 * The draft-11 adapter.
 *
 * Type flags arrive: the subgroup stream type carries EXTENSIONS_PRESENT in
 * bit 0 and an explicit Subgroup ID in bit 2. The range is `0x08-0x0D`, which
 * draft-12 moved.
 *
 * **This module is the boundary of the draft-11 chunk.** It is reached only
 * through `DRAFT_LOADERS[11]`'s `() => import('../drafts/draft11/index.js')`, and
 * the `@moqtap/codec/draft11` specifier below is a **static string literal** on
 * purpose: a template literal would defeat bundler analysis and pull all
 * fourteen drafts -- 39.6 KB gz against 5.3 KB, a 7.5x regression that looks
 * like every other import line in review.
 *
 * Two codec functions are used and the streaming decoders are deliberately not:
 * none of them reports a header's byte length without materialising the
 * payload, which is the whole economics of this package. See `../data-walk.ts`.
 */

import { decodeDatagram, decodeMessage, redactAuthTokens } from '@moqtap/codec/draft11'
import { PROTOCOL_STRINGS } from '../../draft/protocol.js'
import { RFC9000_READER, readRfc9000 } from '../../draft/varint.js'
import type { DraftAdapter, SupportedDraft } from '../../types.js'
import { makeAdapter } from '../adapter.js'
import { BLOCK_LENGTH, PRESENT_BIT0, type WalkDialect } from '../data-walk.js'

/**
 * draft-11's data-stream dialect, read off `drafts/draft11/data-streams.ts`.
 *
 * Field-by-field reasoning is on {@link WalkDialect}.
 */
const DIALECT: WalkDialect = /*#__PURE__*/ Object.freeze({
  readVarint: readRfc9000,

  controlOpener: -1,
  controlLengthIsVarint: false,

  subgroupTypeIsVarint: true,
  isSubgroupType: (v: number) => v >= 0x08 && v <= 0x0d,
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
export const draft: SupportedDraft = 11

/** The one adapter instance for draft-11. Stateless, so one is enough. */
export const DRAFT11_ADAPTER: DraftAdapter = /*#__PURE__*/ Object.freeze(
  makeAdapter(draft, PROTOCOL_STRINGS[11], RFC9000_READER, DIALECT, {
    decodeMessage,
    decodeDatagram,
    redactAuthTokens,
  }),
)

export { DRAFT11_ADAPTER as adapter }
