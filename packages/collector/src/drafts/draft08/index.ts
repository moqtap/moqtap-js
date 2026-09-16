/**
 * The draft-08 adapter.
 *
 * The only draft whose per-object extension block is a *count* of headers
 * rather than a byte length, so it is the only one the walk has to iterate
 * instead of skipping in one step.
 *
 * **This module is the boundary of the draft-08 chunk.** It is reached only
 * through `DRAFT_LOADERS[8]`'s `() => import('../drafts/draft08/index.js')`, and
 * the `@moqtap/codec/draft08` specifier below is a **static string literal** on
 * purpose: a template literal would defeat bundler analysis and pull all
 * fourteen drafts -- 39.6 KB gz against 5.3 KB, a 7.5x regression that looks
 * like every other import line in review.
 *
 * Two codec functions are used and the streaming decoders are deliberately not:
 * none of them reports a header's byte length without materialising the
 * payload, which is the whole economics of this package. See `../data-walk.ts`.
 */

import { decodeDatagram, decodeMessage, redactAuthTokens } from '@moqtap/codec/draft08'
import { PROTOCOL_STRINGS } from '../../draft/protocol.js'
import { RFC9000_READER, readRfc9000 } from '../../draft/varint.js'
import type { DraftAdapter, SupportedDraft } from '../../types.js'
import { makeAdapter } from '../adapter.js'
import { BLOCK_COUNT, PRESENT_ALWAYS, type WalkDialect } from '../data-walk.js'

/**
 * draft-08's data-stream dialect, read off `drafts/draft08/data-streams.ts`.
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

  objectBlock: PRESENT_ALWAYS,
  blockShape: BLOCK_COUNT,
  objectIdIsDelta: false,

  fetchFlagged: false,
  fetchPlainBlock: BLOCK_COUNT,
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
export const draft: SupportedDraft = 8

/** The one adapter instance for draft-08. Stateless, so one is enough. */
export const DRAFT08_ADAPTER: DraftAdapter = /*#__PURE__*/ Object.freeze(
  makeAdapter(draft, PROTOCOL_STRINGS[8], RFC9000_READER, DIALECT, {
    decodeMessage,
    decodeDatagram,
    redactAuthTokens,
  }),
)

export { DRAFT08_ADAPTER as adapter }
