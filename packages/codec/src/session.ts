/**
 * @moqtap/codec/session — MoQT session state machine
 *
 * Requires a codec instance (which carries the draft version).
 * For direct access, use draft-scoped imports:
 *   import { createDraft07SessionState } from '@moqtap/codec/draft7/session';
 *   import { createDraft14SessionState } from '@moqtap/codec/draft14/session';
 */

import type { SessionState, SessionStateOptions } from './core/session-types.js';
import { createDraft07SessionState } from './drafts/draft07/session.js';
import { createDraft14SessionState } from './drafts/draft14/session.js';

/**
 * Create a session state machine for the given draft version.
 *
 * For type-safe access with draft-specific message types, use the
 * draft-scoped factory functions directly:
 *   import { createDraft07SessionState } from '@moqtap/codec/draft7/session';
 *   import { createDraft14SessionState } from '@moqtap/codec/draft14/session';
 */
export function createSessionState(options: SessionStateOptions): SessionState<unknown, string> {
  const draft = options.codec.draft;

  switch (draft) {
    case 'draft-ietf-moq-transport-07':
      return createDraft07SessionState(options);
    case 'draft-ietf-moq-transport-14':
      return createDraft14SessionState(options) as SessionState<unknown, string>;
    default:
      throw new Error(
        `Unsupported draft for session: "${draft}". ` +
        `Use a draft-scoped import instead:\n` +
        `  import { createDraft07SessionState } from '@moqtap/codec/draft7/session'\n` +
        `  import { createDraft14SessionState } from '@moqtap/codec/draft14/session'`,
      );
  }
}

// Re-export all session types
export type {
  SessionState,
  SessionStateOptions,
  SessionPhase,
  SubscriptionState,
  SubscriptionPhase,
  AnnounceState,
  AnnouncePhase,
  PublishState,
  PublishPhase,
  FetchState,
  FetchPhase,
  TransitionResult,
  ValidationResult,
  ProtocolViolation,
  ProtocolViolationCode,
  SideEffect,
} from './core/session-types.js';
