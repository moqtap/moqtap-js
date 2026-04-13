import type { SessionState, SessionStateOptionsRole } from '../../core/session-types.js'
import { Draft08SessionFSM } from './session-fsm.js'
import type { Draft08Message, Draft08MessageType } from './types.js'

export function createDraft08SessionState(
  role: SessionStateOptionsRole,
): SessionState<Draft08Message, Draft08MessageType> {
  return new Draft08SessionFSM(role)
}

export type {
  AnnouncePhase,
  AnnounceState,
  FetchPhase,
  FetchState,
  ProtocolViolation,
  ProtocolViolationCode,
  SessionPhase,
  SessionState,
  SideEffect,
  SubscriptionPhase,
  SubscriptionState,
  TransitionResult,
  ValidationResult,
} from '../../core/session-types.js'
