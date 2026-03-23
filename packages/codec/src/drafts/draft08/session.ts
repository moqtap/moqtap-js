import type { SessionState, SessionStateOptions } from "../../core/session-types.js";
import { Draft08SessionFSM } from "./session-fsm.js";
import type { Draft08Message, Draft08MessageType } from "./types.js";

export function createDraft08SessionState(
  options: SessionStateOptions,
): SessionState<Draft08Message, Draft08MessageType> {
  return new Draft08SessionFSM(options.role);
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
  SessionStateOptions,
  SideEffect,
  SubscriptionPhase,
  SubscriptionState,
  TransitionResult,
  ValidationResult,
} from "../../core/session-types.js";
