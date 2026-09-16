/**
 * The draft loader map.
 *
 * **A careless edit here costs 7.5×.** Measured: `@moqtap/codec`'s root entry is
 * 39.6 KB gzipped because it statically imports all fourteen drafts
 * (`packages/codec/src/index.ts`), against 5.3 KB for one draft's decoder.
 * `/session` does the same. The per-draft split exists to spend the 5.3 KB.
 *
 *  1. **Static string literals only.** `() => import('../drafts/draft20/index.js')`
 *     is analysable: a bundler sees one specifier, emits one chunk, and loads it
 *     only when the arrow is called. `import(`../drafts/draft${n}/index.js`)` is
 *     not — every bundler falls back to including everything the pattern could
 *     match, silently, with no warning and no diff in review. **Never introduce
 *     a variable into these specifiers, and never "simplify" this object into a
 *     loop.** That refactor looks like a tidy-up and costs 34 KB gz.
 *  2. **Only the per-draft codec entries may be named**, and only from inside
 *     `src/drafts/draftNN/index.ts`. `tsup.config.ts` scans every source file for
 *     a bare `@moqtap/codec` or `@moqtap/codec/session` specifier and throws at
 *     config load.
 *  3. **`draftNN`, never `dNN`.** Every package in this workspace uses the
 *     zero-padded form (`@moqtap/codec` ships `./draft07` through `./draft20`).
 *
 * The `pin` option in {@link LoadOptions} is not build-time substitution: it
 * **selects among literal specifiers the bundler can already see**. A single-file
 * or strict-CSP build that cannot `import()` at all imports
 * `@moqtap/collector/draft20` directly, and the pin makes the runtime path agree
 * with it.
 */

import type { DraftAdapter, SupportedDraft } from '../types.js'

/**
 * What one draft's chunk exports.
 *
 * Deliberately the *module namespace* shape rather than a wrapper, so
 * `import('../drafts/draft20/index.js')` satisfies it with no adapter object
 * allocated at load time and no default export to unwrap.
 */
export interface DraftModule {
  readonly draft: SupportedDraft
  readonly adapter: DraftAdapter
}

/**
 * The map. Frozen, fourteen entries, static literal specifiers.
 *
 * Keyed by draft number so `DRAFT_LOADERS[draftOfProtocol(p)]` is the whole
 * dispatch. Adding a draft is adding a literal line here plus its
 * `src/drafts/draftNN/index.ts`; no form of this file computes the specifier.
 * The fourteen lines a loop would shorten to three are the trade this file
 * exists to refuse: the loop costs 34 KB gz and looks like an improvement.
 */
export const DRAFT_LOADERS: Readonly<Record<SupportedDraft, () => Promise<DraftModule>>> =
  /*#__PURE__*/ Object.freeze({
    7: () => import('../drafts/draft07/index.js'),
    8: () => import('../drafts/draft08/index.js'),
    9: () => import('../drafts/draft09/index.js'),
    10: () => import('../drafts/draft10/index.js'),
    11: () => import('../drafts/draft11/index.js'),
    12: () => import('../drafts/draft12/index.js'),
    13: () => import('../drafts/draft13/index.js'),
    14: () => import('../drafts/draft14/index.js'),
    15: () => import('../drafts/draft15/index.js'),
    16: () => import('../drafts/draft16/index.js'),
    17: () => import('../drafts/draft17/index.js'),
    18: () => import('../drafts/draft18/index.js'),
    19: () => import('../drafts/draft19/index.js'),
    20: () => import('../drafts/draft20/index.js'),
  })
