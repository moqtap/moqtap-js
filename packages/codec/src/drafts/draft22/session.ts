import { Draft22SessionFSM } from './session-fsm.js'

export type {
  ProtocolViolation,
  SessionPhase,
  SideEffect,
  TransitionResult,
  ValidationResult,
} from '../../core/session-types.js'
export type {
  FillFetchStreamPhase,
  FillFetchStreamState,
  PublisherSide,
  RequestKind,
} from './session-fsm.js'

export function createDraft22SessionState(role: 'client' | 'server'): Draft22SessionFSM {
  return new Draft22SessionFSM(role)
}

export { Draft22SessionFSM }
