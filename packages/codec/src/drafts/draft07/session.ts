import type { SessionState, SessionStateOptionsRole } from '../../core/session-types.js'
import { Draft07SessionFSM } from './session-fsm.js'
import type { Draft07Message, Draft07MessageType } from './types.js'

export function createDraft07SessionState(
  role: SessionStateOptionsRole,
): SessionState<Draft07Message, Draft07MessageType> {
  return new Draft07SessionFSM(role)
}

export type {
  AnnouncePhase,
  AnnounceState,
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
