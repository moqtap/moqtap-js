/**
 * `@moqtap/collector/draft20` -- the draft-partitioned entry point.
 *
 * Importing this reaches draft-20's decoder and nothing else: no other draft's
 * chunk, and **no module-eval side effect**, because a consumer reaching for a
 * decoder has not asked to have `globalThis.WebTransport` patched. That is what
 * the root entry does, and it is why the root entry is declared impure in
 * `sideEffects` and this one is not.
 *
 * `draft20` rather than `d20`: every entry in this workspace is zero-padded,
 * and `@moqtap/codec` ships `./draft07` through `./draft20`.
 *
 * Draft-20 negotiates the ALPN `moqt-20`, which from draft-15 is the only
 * draft identifier a session carries: the version appears nowhere on the wire.
 */

export { PROTOCOL_STRINGS } from '../../draft/protocol.js'
export type {
  DatagramCounts,
  DecodedControl,
  DraftAdapter,
  FetchHeaderInfo,
  Need,
  ObjectCursor,
  ObjectHeaderInfo,
  StreamKind,
  SubgroupHeaderInfo,
  SupportedDraft,
  VarintReader,
} from '../../types.js'
export { NEED } from '../../types.js'
export { adapter, DRAFT20_ADAPTER, draft } from './index.js'
