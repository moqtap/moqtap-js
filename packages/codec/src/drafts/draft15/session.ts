import type { SessionState, SessionStateOptions } from "../../core/session-types.js";
import { Draft15SessionFSM } from "./session-fsm.js";
import type { Draft15Message, Draft15MessageType } from "./types.js";

export function createDraft15SessionState(
  options: SessionStateOptions,
): SessionState<Draft15Message, Draft15MessageType> {
  return new Draft15SessionFSM(options.role);
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
