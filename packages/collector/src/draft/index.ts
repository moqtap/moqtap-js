/**
 * The draft module's public surface.
 *
 * **Everything re-exported here is in the STATIC bundle** (the ~10 KB budget),
 * so the list is exactly: the loader map's two arrow functions, the load
 * decision, the protocol table, the copied accessors and the two varint
 * readers. Together they are a few hundred bytes.
 *
 * Two things are deliberately **not** here and must never be added:
 *
 *  - `../drafts/draft19/index.js` and `../drafts/draft20/index.js`, and
 *    anything they import — `../drafts/data-walk.js` above all. They are
 *    reachable only through {@link DRAFT_LOADERS}'s `import()`, which is what
 *    keeps them in their own chunks. A single `export * from '../drafts/…'`
 *    here would move 5.3 KB gz per draft into the static graph and, with both
 *    drafts named, defeat the entire per-draft split.
 *  - Anything from `@moqtap/codec` itself. The root and `/session` entries
 *    statically import all fourteen drafts (39.6 KB gz against 5.3 KB); only
 *    `src/drafts/draftNN/index.ts` may name a codec entry, and only a per-draft
 *    one, and only as a static string literal. `tsup.config.ts` scans for the
 *    violation at config load.
 */

// Type-only, and erased at build. Re-exported so a consumer of this module can
// name the draft numbers without also reaching for `types.ts`; the declaration
// itself stays there, frozen, as the single contract.
export type { DraftAdapter, SupportedDraft, VarintReader } from '../types.js'
export type { LoadFailure, LoadOptions, LoadResult } from './loader.js'
export {
  DEFAULT_IMPORT_TIMEOUT_MS,
  degradedReasonOf,
  loadDraft,
  loadDraftNumber,
  preloadDrafts,
} from './loader.js'
export type { DraftModule } from './loaders.js'
export { DRAFT_LOADERS } from './loaders.js'
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
export { draftOfSetupFrame } from './setup-probe.js'
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
