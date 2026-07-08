import { Draft19SessionFSM } from './session-fsm.js'

export type {
  ProtocolViolation,
  SessionPhase,
  SideEffect,
  TransitionResult,
  ValidationResult,
} from '../../core/session-types.js'

export function createDraft19SessionState(role: 'client' | 'server'): Draft19SessionFSM {
  return new Draft19SessionFSM(role)
}

export { Draft19SessionFSM }
