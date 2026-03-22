import type { SessionState, SessionStateOptions } from "../../core/session-types.js";
import { Draft14SessionFSM } from "./session-fsm.js";
import type { Draft14Message, Draft14MessageType } from "./types.js";

export function createDraft14SessionState(
  options: SessionStateOptions,
): SessionState<Draft14Message, Draft14MessageType> {
  return new Draft14SessionFSM(options.role);
}

export type {
  FetchPhase,
  FetchState,
  ProtocolViolation,
  ProtocolViolationCode,
  PublishPhase,
  PublishState,
  SessionPhase,
  SessionState,
  SessionStateOptions,
  SideEffect,
  SubscriptionPhase,
  SubscriptionState,
  TransitionResult,
  ValidationResult,
} from "../../core/session-types.js";
