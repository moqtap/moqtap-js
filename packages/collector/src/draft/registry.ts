/**
 * The decoders an entry point was built with.
 *
 * Each entry imports its drafts statically and passes them in, so a bundler
 * sees exactly the decoders that entry names and nothing loads at session time.
 */

import type { DraftAdapter, SetupRecord, SupportedDraft } from '../types.js'
import { draftOfProtocol } from './protocol.js'

export type DraftSet = ReadonlyMap<SupportedDraft, DraftAdapter>

export function draftSet(adapters: readonly DraftAdapter[]): DraftSet {
  return new Map(adapters.map((a) => [a.draft, a]))
}

/**
 * `unsupported-protocol`: no draft this package knows. `not-included`: a known
 * draft whose decoder this entry was not built with.
 */
export type ResolveFailure = 'unsupported-protocol' | 'not-included'

export type DraftResolution =
  | { readonly ok: true; readonly draft: SupportedDraft; readonly adapter: DraftAdapter }
  | { readonly ok: false; readonly reason: ResolveFailure }

/**
 * The adapter for a session. `known` is the version a pre-15 SETUP frame
 * named, for the drafts whose protocol string cannot say.
 */
export function resolveDraft(
  set: DraftSet,
  protocol: string,
  known?: SupportedDraft,
): DraftResolution {
  const draft = known ?? draftOfProtocol(protocol)
  if (draft === undefined) return { ok: false, reason: 'unsupported-protocol' }
  const adapter = set.get(draft)
  if (adapter === undefined) return { ok: false, reason: 'not-included' }
  return { ok: true, draft, adapter }
}

export function degradedReasonOf(reason: ResolveFailure): NonNullable<SetupRecord['degraded']> {
  return reason === 'not-included' ? 'draft-mismatch' : 'unsupported-protocol'
}
