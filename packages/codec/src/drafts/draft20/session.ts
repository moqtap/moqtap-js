import { Draft20SessionFSM } from './session-fsm.js'

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

export function createDraft20SessionState(role: 'client' | 'server'): Draft20SessionFSM {
  return new Draft20SessionFSM(role)
}

export { Draft20SessionFSM }
