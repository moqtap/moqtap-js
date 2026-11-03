import { Draft23SessionFSM } from './session-fsm.js'

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

export function createDraft23SessionState(role: 'client' | 'server'): Draft23SessionFSM {
  return new Draft23SessionFSM(role)
}

export { Draft23SessionFSM }
