import type { SessionState, SessionStateOptions } from "../../core/session-types.js";
import { Draft12SessionFSM } from "./session-fsm.js";
import type { Draft12Message, Draft12MessageType } from "./types.js";

export function createDraft12SessionState(
  options: SessionStateOptions,
): SessionState<Draft12Message, Draft12MessageType> {
  return new Draft12SessionFSM(options.role);
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
