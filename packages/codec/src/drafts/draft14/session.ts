import type { Draft14Message, Draft14MessageType } from './types.js';
import type { SessionState, SessionStateOptions } from '../../core/session-types.js';
import { Draft14SessionFSM } from './session-fsm.js';

export function createDraft14SessionState(
  options: SessionStateOptions,
): SessionState<Draft14Message, Draft14MessageType> {
  return new Draft14SessionFSM(options.role);
}

export type {
  SessionState,
  SessionStateOptions,
  SessionPhase,
  SubscriptionState,
  SubscriptionPhase,
  PublishState,
  PublishPhase,
  FetchState,
  FetchPhase,
  TransitionResult,
  ValidationResult,
  ProtocolViolation,
  ProtocolViolationCode,
  SideEffect,
} from '../../core/session-types.js';
