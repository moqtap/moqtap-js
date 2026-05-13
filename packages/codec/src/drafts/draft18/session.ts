import { Draft18SessionFSM } from './session-fsm.js'

export type {
  ProtocolViolation,
  SessionPhase,
  SideEffect,
  TransitionResult,
  ValidationResult,
} from '../../core/session-types.js'

export function createDraft18SessionState(role: 'client' | 'server'): Draft18SessionFSM {
  return new Draft18SessionFSM(role)
}

export { Draft18SessionFSM }
