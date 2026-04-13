import type { SessionState, SessionStateOptionsRole } from '../../core/session-types.js'
import { Draft14SessionFSM } from './session-fsm.js'
import type { Draft14Message, Draft14MessageType } from './types.js'

export function createDraft14SessionState(
  role: SessionStateOptionsRole,
): SessionState<Draft14Message, Draft14MessageType> {
  return new Draft14SessionFSM(role)
}

export type {
  FetchPhase,
  FetchState,
  ProtocolViolation,
  ProtocolViolationCode,
  PublishPhase,
  PublishState,
  SessionPhase,
  SessionState,
  SideEffect,
  SubscriptionPhase,
  SubscriptionState,
  TransitionResult,
  ValidationResult,
} from '../../core/session-types.js'
