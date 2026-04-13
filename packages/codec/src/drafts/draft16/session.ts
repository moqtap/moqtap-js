import type { SessionState, SessionStateOptionsRole } from '../../core/session-types.js'
import { Draft16SessionFSM } from './session-fsm.js'
import type { Draft16Message, Draft16MessageType } from './types.js'

export function createDraft16SessionState(
  role: SessionStateOptionsRole,
): SessionState<Draft16Message, Draft16MessageType> {
  return new Draft16SessionFSM(role)
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
