import type { SessionState, SessionStateOptions } from "../../core/session-types.js";
import { Draft09SessionFSM } from "./session-fsm.js";
import type { Draft09Message, Draft09MessageType } from "./types.js";

export function createDraft09SessionState(
  options: SessionStateOptions,
): SessionState<Draft09Message, Draft09MessageType> {
  return new Draft09SessionFSM(options.role);
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
