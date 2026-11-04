/**
 * The draft-23 adapter.
 *
 * Draft-23 frames control messages with a vi64 Length, and its fetch streams
 * have an Object ID Delta `+ 2`, End-of-Range IDs with their own delta rule,
 * End of Gone Range, and the field-less End of Group and End of Track.
 * Control messages go through `@moqtap/codec/draft23`.
 *
 * The `@moqtap/codec/draft23` specifier below is a **static string literal** on
 * purpose: a template literal would defeat bundler analysis and pull every
 * draft into the bundle.
 *
 * Three codec functions are used and the streaming decoders are deliberately not:
 * none of them reports a header's byte length without materialising the
 * payload, which is the whole economics of this package. See `../data-walk.ts`.
 */

import { decodeDatagram, decodeMessage, redactAuthTokens } from '@moqtap/codec/draft23'
import { PROTOCOL_STRINGS } from '../../draft/protocol.js'
import { readVi64, VI64_READER } from '../../draft/varint.js'
import type { DraftAdapter, SupportedDraft } from '../../types.js'
import { makeAdapter } from '../adapter.js'
import { BLOCK_LENGTH, BLOCK_NONE, PRESENT_BIT0, type WalkDialect } from '../data-walk.js'

/**
 * draft-23's data-stream dialect, read off `drafts/draft23/data-streams.ts`
 * in `@moqtap/codec`.
 *
 * Field-by-field reasoning is on {@link WalkDialect}.
 */
const DIALECT: WalkDialect = /*#__PURE__*/ Object.freeze({
  readVarint: readVi64,

  controlOpener: 0xaf,
  // draft-23 Section 9, Figure 6: "Message Length (vi64)".
  controlLengthIsVarint: true,

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
  // 0x8c Non-Existent, 0x10c Unknown, 0x20c Timed-Out, 0x40c Gone.
  fetchMarkers: new Set<number>([0x8c, 0x10c, 0x20c, 0x40c]),
  fetchDatagramMode: true,
  fetchHasStatus: false,
  fetchGroupIsAbsolute: false,
  fetchObjectIdIsAbsolute: false,
  fetchObjectIdDeltaBias: 2n,
  markerIdsAreRangeDeltas: true,
  // 0x80 End of Group, 0x81 End of Track.
  fetchEndIndicators: new Set<number>([0x80, 0x81]),
  datagramDefaultPriorityBit: 0x08,
})

/**
 * The draft this chunk parses. Present so the module namespace object
 * structurally satisfies `DraftModule` with no wrapper allocation.
 */
export const draft: SupportedDraft = 23

/** The one adapter instance for draft-23. Stateless, so one is enough. */
export const DRAFT23_ADAPTER: DraftAdapter = /*#__PURE__*/ Object.freeze(
  makeAdapter(draft, PROTOCOL_STRINGS[23], VI64_READER, DIALECT, {
    decodeMessage,
    decodeDatagram,
    redactAuthTokens,
  }),
)

export { DRAFT23_ADAPTER as adapter }
