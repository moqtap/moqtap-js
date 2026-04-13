import type { SessionState, SessionStateOptionsRole } from '../../core/session-types.js'
import { Draft13SessionFSM } from './session-fsm.js'
import type { Draft13Message, Draft13MessageType } from './types.js'

export function createDraft13SessionState(
  role: SessionStateOptionsRole,
): SessionState<Draft13Message, Draft13MessageType> {
  return new Draft13SessionFSM(role)
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
