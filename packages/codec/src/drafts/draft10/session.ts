import type { SessionState, SessionStateOptionsRole } from '../../core/session-types.js'
import { Draft10SessionFSM } from './session-fsm.js'
import type { Draft10Message, Draft10MessageType } from './types.js'

export function createDraft10SessionState(
  role: SessionStateOptionsRole,
): SessionState<Draft10Message, Draft10MessageType> {
  return new Draft10SessionFSM(role)
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
