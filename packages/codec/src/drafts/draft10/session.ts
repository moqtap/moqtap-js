import type { SessionState, SessionStateOptions } from "../../core/session-types.js";
import { Draft10SessionFSM } from "./session-fsm.js";
import type { Draft10Message, Draft10MessageType } from "./types.js";

export function createDraft10SessionState(
  options: SessionStateOptions,
): SessionState<Draft10Message, Draft10MessageType> {
  return new Draft10SessionFSM(options.role);
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
