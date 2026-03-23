import type { SessionState, SessionStateOptions } from "../../core/session-types.js";
import { Draft16SessionFSM } from "./session-fsm.js";
import type { Draft16Message, Draft16MessageType } from "./types.js";

export function createDraft16SessionState(
  options: SessionStateOptions,
): SessionState<Draft16Message, Draft16MessageType> {
  return new Draft16SessionFSM(options.role);
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
