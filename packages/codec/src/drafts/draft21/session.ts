import { Draft21SessionFSM } from './session-fsm.js'

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

export function createDraft21SessionState(role: 'client' | 'server'): Draft21SessionFSM {
  return new Draft21SessionFSM(role)
}

export { Draft21SessionFSM }
