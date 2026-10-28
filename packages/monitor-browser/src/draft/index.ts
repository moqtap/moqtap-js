/**
 * Draft identification shared by every entry point.
 *
 * Never re-export `../drafts/draftNN/` here: each entry chooses its decoders,
 * and a re-export would put every draft in every entry. Nothing here may name
 * `@moqtap/codec` either; `tsup.config.ts` refuses the root and `/session`
 * entries, which carry every draft.
 */

// Type-only, and erased at build. Re-exported so a consumer of this module can
// name the draft numbers without also reaching for `types.ts`; the declaration
// itself stays there, frozen, as the single contract.
export type { DraftAdapter, SupportedDraft, VarintReader } from '../types.js'
export {
  draftOfProtocol,
  draftOfVersion,
  exchangeKindOf,
  LEGACY_PROTOCOL,
  PROTOCOL_STRINGS,
  requestIdOf,
  SUPPORTED_DRAFTS,
  trackAliasOf,
} from './protocol.js'
export {
  type DraftResolution,
  type DraftSet,
  degradedReasonOf,
  draftSet,
  type ResolveFailure,
  resolveDraft,
} from './registry.js'
export { draftNumberOfVersion, draftOfSetupFrame, readSetupFrame } from './setup-probe.js'
export type { Need, VarintValue } from './varint.js'
export {
  NEED,
  RFC9000_READER,
  readRfc9000,
  readVi64,
  readVi64Draft17,
  VI64_D17_READER,
  VI64_READER,
} from './varint.js'
