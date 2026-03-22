import type { SessionState, SessionStateOptions } from '../../core/session-types.js';
import { SessionFSM } from './session-fsm.js';

export function createDraft07SessionState(options: SessionStateOptions): SessionState {
  return new SessionFSM(options.role);
}

export type {
  SessionState,
  SessionStateOptions,
  SessionPhase,
  SubscriptionState,
  SubscriptionPhase,
  AnnounceState,
  AnnouncePhase,
  TransitionResult,
  ValidationResult,
  ProtocolViolation,
  ProtocolViolationCode,
  SideEffect,
} from '../../core/session-types.js';
