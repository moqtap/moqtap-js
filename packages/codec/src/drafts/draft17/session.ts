import { Draft17SessionFSM } from './session-fsm.js'

export type {
  ProtocolViolation,
  SessionPhase,
  SideEffect,
  TransitionResult,
  ValidationResult,
} from '../../core/session-types.js'

export function createDraft17SessionState(role: 'client' | 'server'): Draft17SessionFSM {
  return new Draft17SessionFSM(role)
}

export { Draft17SessionFSM }
