/**
 * @moqtap/codec/session — MoQT session state machine
 *
 * Requires a codec instance (which carries the draft version).
 * For direct access, use draft-scoped imports:
 *   import { createDraft17SessionState } from '@moqtap/codec/draft17/session';
 */

import type { SessionState, SessionStateOptions } from './core/session-types.js'
import type { Draft } from './core/types.js'
import { createDraft07SessionState } from './drafts/draft07/session.js'
import type { Draft07Message, Draft07MessageType } from './drafts/draft07/types.js'
import { createDraft08SessionState } from './drafts/draft08/session.js'
import type { Draft08Message, Draft08MessageType } from './drafts/draft08/types.js'
import { createDraft09SessionState } from './drafts/draft09/session.js'
import type { Draft09Message, Draft09MessageType } from './drafts/draft09/types.js'
import { createDraft10SessionState } from './drafts/draft10/session.js'
import type { Draft10Message, Draft10MessageType } from './drafts/draft10/types.js'
import { createDraft11SessionState } from './drafts/draft11/session.js'
import type { Draft11Message, Draft11MessageType } from './drafts/draft11/types.js'
import { createDraft12SessionState } from './drafts/draft12/session.js'
import type { Draft12Message, Draft12MessageType } from './drafts/draft12/types.js'
import { createDraft13SessionState } from './drafts/draft13/session.js'
import type { Draft13Message, Draft13MessageType } from './drafts/draft13/types.js'
import { createDraft14SessionState } from './drafts/draft14/session.js'
import type { Draft14Message, Draft14MessageType } from './drafts/draft14/types.js'
import { createDraft15SessionState } from './drafts/draft15/session.js'
import type { Draft15Message, Draft15MessageType } from './drafts/draft15/types.js'
import { createDraft16SessionState } from './drafts/draft16/session.js'
import type { Draft16Message, Draft16MessageType } from './drafts/draft16/types.js'
import { createDraft17SessionState } from './drafts/draft17/session.js'
import type { Draft17Message, Draft17MessageType } from './drafts/draft17/types.js'

type DraftSessionStateMap = {
  '07': SessionState<Draft07Message, Draft07MessageType>
  '08': SessionState<Draft08Message, Draft08MessageType>
  '09': SessionState<Draft09Message, Draft09MessageType>
  '10': SessionState<Draft10Message, Draft10MessageType>
  '11': SessionState<Draft11Message, Draft11MessageType>
  '12': SessionState<Draft12Message, Draft12MessageType>
  '13': SessionState<Draft13Message, Draft13MessageType>
  '14': SessionState<Draft14Message, Draft14MessageType>
  '15': SessionState<Draft15Message, Draft15MessageType>
  '16': SessionState<Draft16Message, Draft16MessageType>
  '17': SessionState<Draft17Message, Draft17MessageType>
}

/**
 * Create a session state machine for the given draft version.
 */
export function createSessionState<T extends Draft>(
  options: SessionStateOptions<T>,
): DraftSessionStateMap[T] {
  const draft = options.codec.draft

  const factories: Record<Draft, (role: 'client' | 'server') => DraftSessionStateMap[Draft]> = {
    '07': createDraft07SessionState,
    '08': createDraft08SessionState,
    '09': createDraft09SessionState,
    '10': createDraft10SessionState,
    '11': createDraft11SessionState,
    '12': createDraft12SessionState,
    '13': createDraft13SessionState,
    '14': createDraft14SessionState,
    '15': createDraft15SessionState,
    '16': createDraft16SessionState,
    '17': createDraft17SessionState,
  }

  const factory = factories[draft]
  if (!factory) {
    throw new Error(`Unsupported draft for session: "${draft}". Use a draft-scoped import instead.`)
  }

  return factory(options.role) as DraftSessionStateMap[T]
}

// Re-export all session types
export type {
  AnnouncePhase,
  AnnounceState,
  FetchPhase,
  FetchState,
  ProtocolViolation,
  ProtocolViolationCode,
  PublishPhase,
  PublishState,
  SessionPhase,
  SessionState,
  SessionStateOptions,
  SideEffect,
  SubscriptionPhase,
  SubscriptionState,
  TransitionResult,
  ValidationResult,
} from './core/session-types.js'
