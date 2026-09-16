/**
 * `@moqtap/collector/draft07` -- the draft-partitioned entry point.
 *
 * Importing this reaches draft-07's decoder and nothing else: no other draft's
 * chunk, and **no module-eval side effect**, because a consumer reaching for a
 * decoder has not asked to have `globalThis.WebTransport` patched. That is what
 * the root entry does, and it is why the root entry is declared impure in
 * `sideEffects` and this one is not.
 *
 * `draft07` rather than `d7`: every entry in this workspace is zero-padded,
 * and `@moqtap/codec` ships `./draft07` through `./draft20`.
 *
 * Draft-07 negotiates the ALPN `moq-00`, which it shares with every draft
 * before -15. The ALPN alone therefore does not say which draft a session
 * speaks -- the selected version does, and it arrives in SERVER_SETUP. See
 * `../../draft/setup-probe.ts`.
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
export { adapter, DRAFT07_ADAPTER, draft } from './index.js'
