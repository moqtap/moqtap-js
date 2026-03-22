import type { SessionState, SessionStateOptions } from "../../core/session-types.js";
import { SessionFSM } from "./session-fsm.js";

export function createDraft07SessionState(options: SessionStateOptions): SessionState {
  return new SessionFSM(options.role);
}

export type {
  AnnouncePhase,
  AnnounceState,
  ProtocolViolation,
  ProtocolViolationCode,
  SessionPhase,
  SessionState,
  SessionStateOptions,
  SideEffect,
  SubscriptionPhase,
  SubscriptionState,
  TransitionResult,
  ValidationResult,
} from "../../core/session-types.js";
