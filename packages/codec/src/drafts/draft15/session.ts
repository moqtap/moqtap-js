import type { SessionState, SessionStateOptionsRole } from '../../core/session-types.js'
import { Draft15SessionFSM } from './session-fsm.js'
import type { Draft15Message, Draft15MessageType } from './types.js'

export function createDraft15SessionState(
  role: SessionStateOptionsRole,
): SessionState<Draft15Message, Draft15MessageType> {
  return new Draft15SessionFSM(role)
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
