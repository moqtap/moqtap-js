import type { SessionState, SessionStateOptions } from "../../core/session-types.js";
import { Draft11SessionFSM } from "./session-fsm.js";
import type { Draft11Message, Draft11MessageType } from "./types.js";

export function createDraft11SessionState(
  options: SessionStateOptions,
): SessionState<Draft11Message, Draft11MessageType> {
  return new Draft11SessionFSM(options.role);
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
