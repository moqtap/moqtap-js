import type { Codec, MoqtMessage, MoqtMessageType } from './types.js';

export type SessionPhase =
  | 'idle'
  | 'setup'
  | 'ready'
  | 'draining'
  | 'closed'
  | 'error';

export type SubscriptionPhase =
  | 'pending'
  | 'active'
  | 'error'
  | 'done';

export type AnnouncePhase =
  | 'pending'
  | 'active'
  | 'error';

export type PublishPhase = 'pending' | 'active' | 'error' | 'done';

export type FetchPhase = 'pending' | 'active' | 'error' | 'cancelled';

export interface SubscriptionState {
  readonly subscribeId: bigint;
  readonly phase: SubscriptionPhase;
  readonly trackNamespace: string[];
  readonly trackName: string;
}

export interface AnnounceState {
  readonly namespace: string[];
  readonly phase: AnnouncePhase;
}

export interface PublishState {
  readonly requestId: bigint;
  readonly phase: PublishPhase;
}

export interface FetchState {
  readonly requestId: bigint;
  readonly phase: FetchPhase;
}

export interface SessionStateOptions {
  codec: { draft: string };
  role: 'client' | 'server';
}

export interface SessionState<M = MoqtMessage, T extends string = MoqtMessageType> {
  readonly phase: SessionPhase;
  readonly role: 'client' | 'server';
  receive(message: M): TransitionResult<T>;
  validateOutgoing(message: M): ValidationResult<T>;
  send(message: M): TransitionResult<T>;
  readonly subscriptions: ReadonlyMap<bigint, SubscriptionState>;
  readonly announces: ReadonlyMap<string, AnnounceState>;
  readonly legalOutgoing: ReadonlySet<T>;
  readonly legalIncoming: ReadonlySet<T>;
  reset(): void;
}

export type TransitionResult<T extends string = MoqtMessageType> =
  | { ok: true; phase: SessionPhase; sideEffects: SideEffect[] }
  | { ok: false; violation: ProtocolViolation<T> };

export type ValidationResult<T extends string = MoqtMessageType> =
  | { ok: true }
  | { ok: false; violation: ProtocolViolation<T> };

export interface ProtocolViolation<T extends string = MoqtMessageType> {
  readonly code: ProtocolViolationCode;
  readonly message: string;
  readonly currentPhase: SessionPhase;
  readonly offendingMessage: T;
}

export type ProtocolViolationCode =
  | 'MESSAGE_BEFORE_SETUP'
  | 'UNEXPECTED_MESSAGE'
  | 'DUPLICATE_SUBSCRIBE_ID'
  | 'UNKNOWN_SUBSCRIBE_ID'
  | 'DUPLICATE_REQUEST_ID'
  | 'UNKNOWN_REQUEST_ID'
  | 'ROLE_VIOLATION'
  | 'STATE_VIOLATION'
  | 'SETUP_VIOLATION';

export type SideEffect =
  | { type: 'subscription-activated'; subscribeId: bigint }
  | { type: 'subscription-ended'; subscribeId: bigint; reason: string }
  | { type: 'announce-activated'; namespace: string[] }
  | { type: 'announce-ended'; namespace: string[] }
  | { type: 'publish-activated'; requestId: bigint }
  | { type: 'publish-ended'; requestId: bigint; reason: string }
  | { type: 'fetch-activated'; requestId: bigint }
  | { type: 'fetch-ended'; requestId: bigint; reason: string }
  | { type: 'session-ready' }
  | { type: 'session-draining'; goAwayUri: string }
  | { type: 'session-closed' };
