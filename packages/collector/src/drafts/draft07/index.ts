/**
 * The draft-07 adapter.
 *
 * The oldest draft the codec speaks. One subgroup stream type, no type
 * flags at all, no per-object extension block, and absolute Object IDs.
 *
 * **This module is the boundary of the draft-07 chunk.** It is reached only
 * through `DRAFT_LOADERS[7]`'s `() => import('../drafts/draft07/index.js')`, and
 * the `@moqtap/codec/draft07` specifier below is a **static string literal** on
 * purpose: a template literal would defeat bundler analysis and pull all
 * fourteen drafts -- 39.6 KB gz against 5.3 KB, a 7.5x regression that looks
 * like every other import line in review.
 *
 * Two codec functions are used and the streaming decoders are deliberately not:
 * none of them reports a header's byte length without materialising the
 * payload, which is the whole economics of this package. See `../data-walk.ts`.
 */

import { decodeDatagram, decodeMessage, redactAuthTokens } from '@moqtap/codec/draft07'
import { PROTOCOL_STRINGS } from '../../draft/protocol.js'
import { RFC9000_READER, readRfc9000 } from '../../draft/varint.js'
import type { DraftAdapter, SupportedDraft } from '../../types.js'
import { makeAdapter } from '../adapter.js'
import { BLOCK_NONE, PRESENT_NEVER, type WalkDialect } from '../data-walk.js'

/**
 * draft-07's data-stream dialect, read off `drafts/draft07/data-streams.ts`.
 *
 * Field-by-field reasoning is on {@link WalkDialect}.
 */
const DIALECT: WalkDialect = /*#__PURE__*/ Object.freeze({
  readVarint: readRfc9000,

  controlOpener: -1,
  controlLengthIsVarint: true,

  subgroupTypeIsVarint: true,
  isSubgroupType: (v: number) => v === 0x04,
  subgroupIdAlways: true,
  priorityAlways: true,

  objectBlock: PRESENT_NEVER,
  blockShape: BLOCK_NONE,
  objectIdIsDelta: false,

  fetchFlagged: false,
  fetchPlainBlock: BLOCK_NONE,
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
export const draft: SupportedDraft = 7

/** The one adapter instance for draft-07. Stateless, so one is enough. */
export const DRAFT07_ADAPTER: DraftAdapter = /*#__PURE__*/ Object.freeze(
  makeAdapter(draft, PROTOCOL_STRINGS[7], RFC9000_READER, DIALECT, {
    decodeMessage,
    decodeDatagram,
    redactAuthTokens,
  }),
)

export { DRAFT07_ADAPTER as adapter }
