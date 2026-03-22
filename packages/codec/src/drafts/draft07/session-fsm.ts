import type {
  AnnounceState,
  ProtocolViolation,
  SessionPhase,
  SideEffect,
  SubscriptionState,
  TransitionResult,
  ValidationResult,
} from "../../core/session-types.js";
import type { MoqtMessage, MoqtMessageType } from "../../core/types.js";
import {
  CLIENT_ONLY_MESSAGES,
  getLegalIncoming,
  getLegalOutgoing,
  SERVER_ONLY_MESSAGES,
} from "./rules.js";

function violation(
  code: ProtocolViolation["code"],
  message: string,
  currentPhase: SessionPhase,
  offendingMessage: MoqtMessageType,
): ProtocolViolation {
  return { code, message, currentPhase, offendingMessage };
}

export class SessionFSM {
  private _phase: SessionPhase = "idle";
  private _role: "client" | "server";
  private _subscriptions = new Map<bigint, SubscriptionState>();
  private _announces = new Map<string, AnnounceState>();

  constructor(role: "client" | "server") {
    this._role = role;
  }

  get phase(): SessionPhase {
    return this._phase;
  }
  get role(): "client" | "server" {
    return this._role;
  }
  get subscriptions(): ReadonlyMap<bigint, SubscriptionState> {
    return this._subscriptions;
  }
  get announces(): ReadonlyMap<string, AnnounceState> {
    return this._announces;
  }

  get legalOutgoing(): ReadonlySet<MoqtMessageType> {
    return getLegalOutgoing(this._phase, this._role);
  }

  get legalIncoming(): ReadonlySet<MoqtMessageType> {
    return getLegalIncoming(this._phase, this._role);
  }

  // Validate role constraints
  private checkRole(
    message: MoqtMessage,
    direction: "inbound" | "outbound",
  ): ProtocolViolation | null {
    const senderRole =
      direction === "outbound" ? this._role : this._role === "client" ? "server" : "client";

    if (CLIENT_ONLY_MESSAGES.has(message.type) && senderRole !== "client") {
      return violation(
        "ROLE_VIOLATION",
        `${message.type} can only be sent by client`,
        this._phase,
        message.type,
      );
    }
    if (SERVER_ONLY_MESSAGES.has(message.type) && senderRole !== "server") {
      return violation(
        "ROLE_VIOLATION",
        `${message.type} can only be sent by server`,
        this._phase,
        message.type,
      );
    }
    return null;
  }

  validateOutgoing(message: MoqtMessage): ValidationResult {
    const roleViolation = this.checkRole(message, "outbound");
    if (roleViolation) return { ok: false, violation: roleViolation };

    if (!this.legalOutgoing.has(message.type)) {
      return {
        ok: false,
        violation: violation(
          this._phase === "idle" || this._phase === "setup"
            ? "MESSAGE_BEFORE_SETUP"
            : "UNEXPECTED_MESSAGE",
          `Cannot send ${message.type} in phase ${this._phase}`,
          this._phase,
          message.type,
        ),
      };
    }
    return { ok: true };
  }

  receive(message: MoqtMessage): TransitionResult {
    const roleViolation = this.checkRole(message, "inbound");
    if (roleViolation) return { ok: false, violation: roleViolation };

    return this.applyTransition(message, "inbound");
  }

  send(message: MoqtMessage): TransitionResult {
    const roleViolation = this.checkRole(message, "outbound");
    if (roleViolation) return { ok: false, violation: roleViolation };

    return this.applyTransition(message, "outbound");
  }

  private applyTransition(
    message: MoqtMessage,
    direction: "inbound" | "outbound",
  ): TransitionResult {
    const sideEffects: SideEffect[] = [];

    switch (message.type) {
      case "client_setup":
        return this.handleClientSetup(message, direction);
      case "server_setup":
        return this.handleServerSetup(message, direction);
      case "goaway":
        return this.handleGoAway(message, direction, sideEffects);

      // Subscription lifecycle
      case "subscribe":
        return this.handleSubscribe(message, direction, sideEffects);
      case "subscribe_ok":
        return this.handleSubscribeOk(message, direction, sideEffects);
      case "subscribe_error":
        return this.handleSubscribeError(message, direction, sideEffects);
      case "subscribe_done":
        return this.handleSubscribeDone(message, direction, sideEffects);
      case "unsubscribe":
        return this.handleUnsubscribe(message, direction, sideEffects);

      // Announce lifecycle
      case "announce":
        return this.handleAnnounce(message, direction, sideEffects);
      case "announce_ok":
        return this.handleAnnounceOk(message, direction, sideEffects);
      case "announce_error":
        return this.handleAnnounceError(message, direction, sideEffects);
      case "announce_cancel":
        return this.handleAnnounceCancel(message, direction, sideEffects);
      case "unannounce":
        return this.handleUnannounce(message, direction, sideEffects);

      // Fetch lifecycle
      case "fetch":
      case "fetch_ok":
      case "fetch_error":
      case "fetch_cancel":
        return this.handleReadyPhaseMessage(message);

      // Other ready-phase messages
      default:
        return this.handleReadyPhaseMessage(message);
    }
  }

  private handleClientSetup(
    _message: MoqtMessage,
    direction: "inbound" | "outbound",
  ): TransitionResult {
    if (this._phase !== "idle") {
      return {
        ok: false,
        violation: violation(
          "SETUP_VIOLATION",
          "CLIENT_SETUP already sent/received",
          this._phase,
          "client_setup",
        ),
      };
    }

    if (direction === "outbound" && this._role !== "client") {
      return {
        ok: false,
        violation: violation(
          "ROLE_VIOLATION",
          "Only client can send CLIENT_SETUP",
          this._phase,
          "client_setup",
        ),
      };
    }

    this._phase = "setup";
    return { ok: true, phase: this._phase, sideEffects: [] };
  }

  private handleServerSetup(
    _message: MoqtMessage,
    direction: "inbound" | "outbound",
  ): TransitionResult {
    if (this._phase !== "setup") {
      return {
        ok: false,
        violation: violation(
          "SETUP_VIOLATION",
          "SERVER_SETUP before CLIENT_SETUP",
          this._phase,
          "server_setup",
        ),
      };
    }

    if (direction === "outbound" && this._role !== "server") {
      return {
        ok: false,
        violation: violation(
          "ROLE_VIOLATION",
          "Only server can send SERVER_SETUP",
          this._phase,
          "server_setup",
        ),
      };
    }

    this._phase = "ready";
    return { ok: true, phase: this._phase, sideEffects: [{ type: "session-ready" }] };
  }

  private handleGoAway(
    message: MoqtMessage,
    _direction: "inbound" | "outbound",
    sideEffects: SideEffect[],
  ): TransitionResult {
    if (this._phase !== "ready" && this._phase !== "draining") {
      return {
        ok: false,
        violation: violation(
          "UNEXPECTED_MESSAGE",
          `GOAWAY not valid in phase ${this._phase}`,
          this._phase,
          "goaway",
        ),
      };
    }
    this._phase = "draining";
    const goaway = message as import("../../core/types.js").GoAway;
    sideEffects.push({ type: "session-draining", goAwayUri: goaway.newSessionUri });
    return { ok: true, phase: this._phase, sideEffects };
  }

  private requireReady(msgType: MoqtMessageType): ProtocolViolation | null {
    if (this._phase !== "ready" && this._phase !== "draining") {
      return violation(
        this._phase === "idle" || this._phase === "setup"
          ? "MESSAGE_BEFORE_SETUP"
          : "UNEXPECTED_MESSAGE",
        `${msgType} requires ready phase, current: ${this._phase}`,
        this._phase,
        msgType,
      );
    }
    return null;
  }

  private handleSubscribe(
    message: MoqtMessage,
    _direction: "inbound" | "outbound",
    sideEffects: SideEffect[],
  ): TransitionResult {
    const err = this.requireReady(message.type);
    if (err) return { ok: false, violation: err };

    const sub = message as import("../../core/types.js").Subscribe;
    if (this._subscriptions.has(sub.subscribeId)) {
      return {
        ok: false,
        violation: violation(
          "DUPLICATE_SUBSCRIBE_ID",
          `Subscribe ID ${sub.subscribeId} already exists`,
          this._phase,
          message.type,
        ),
      };
    }

    this._subscriptions.set(sub.subscribeId, {
      subscribeId: sub.subscribeId,
      phase: "pending",
      trackNamespace: sub.trackNamespace,
      trackName: sub.trackName,
    });

    return { ok: true, phase: this._phase, sideEffects };
  }

  private handleSubscribeOk(
    message: MoqtMessage,
    _direction: "inbound" | "outbound",
    sideEffects: SideEffect[],
  ): TransitionResult {
    const err = this.requireReady(message.type);
    if (err) return { ok: false, violation: err };

    const ok = message as import("../../core/types.js").SubscribeOk;
    const existing = this._subscriptions.get(ok.subscribeId);
    if (!existing) {
      return {
        ok: false,
        violation: violation(
          "UNKNOWN_SUBSCRIBE_ID",
          `No subscription with ID ${ok.subscribeId}`,
          this._phase,
          message.type,
        ),
      };
    }
    if (existing.phase !== "pending") {
      return {
        ok: false,
        violation: violation(
          "STATE_VIOLATION",
          `Subscription ${ok.subscribeId} is ${existing.phase}, not pending`,
          this._phase,
          message.type,
        ),
      };
    }

    this._subscriptions.set(ok.subscribeId, { ...existing, phase: "active" });
    sideEffects.push({ type: "subscription-activated", subscribeId: ok.subscribeId });
    return { ok: true, phase: this._phase, sideEffects };
  }

  private handleSubscribeError(
    message: MoqtMessage,
    _direction: "inbound" | "outbound",
    sideEffects: SideEffect[],
  ): TransitionResult {
    const err = this.requireReady(message.type);
    if (err) return { ok: false, violation: err };

    const subErr = message as import("../../core/types.js").SubscribeError;
    const existing = this._subscriptions.get(subErr.subscribeId);
    if (!existing) {
      return {
        ok: false,
        violation: violation(
          "UNKNOWN_SUBSCRIBE_ID",
          `No subscription with ID ${subErr.subscribeId}`,
          this._phase,
          message.type,
        ),
      };
    }
    if (existing.phase !== "pending") {
      return {
        ok: false,
        violation: violation(
          "STATE_VIOLATION",
          `Subscription ${subErr.subscribeId} is ${existing.phase}, not pending`,
          this._phase,
          message.type,
        ),
      };
    }

    this._subscriptions.set(subErr.subscribeId, { ...existing, phase: "error" });
    sideEffects.push({
      type: "subscription-ended",
      subscribeId: subErr.subscribeId,
      reason: subErr.reasonPhrase,
    });
    return { ok: true, phase: this._phase, sideEffects };
  }

  private handleSubscribeDone(
    message: MoqtMessage,
    _direction: "inbound" | "outbound",
    sideEffects: SideEffect[],
  ): TransitionResult {
    const err = this.requireReady(message.type);
    if (err) return { ok: false, violation: err };

    const done = message as import("../../core/types.js").SubscribeDone;
    const existing = this._subscriptions.get(done.subscribeId);
    if (!existing) {
      return {
        ok: false,
        violation: violation(
          "UNKNOWN_SUBSCRIBE_ID",
          `No subscription with ID ${done.subscribeId}`,
          this._phase,
          message.type,
        ),
      };
    }

    this._subscriptions.set(done.subscribeId, { ...existing, phase: "done" });
    sideEffects.push({
      type: "subscription-ended",
      subscribeId: done.subscribeId,
      reason: done.reasonPhrase,
    });
    return { ok: true, phase: this._phase, sideEffects };
  }

  private handleUnsubscribe(
    message: MoqtMessage,
    _direction: "inbound" | "outbound",
    sideEffects: SideEffect[],
  ): TransitionResult {
    const err = this.requireReady(message.type);
    if (err) return { ok: false, violation: err };

    const unsub = message as import("../../core/types.js").Unsubscribe;
    const existing = this._subscriptions.get(unsub.subscribeId);
    if (!existing) {
      return {
        ok: false,
        violation: violation(
          "UNKNOWN_SUBSCRIBE_ID",
          `No subscription with ID ${unsub.subscribeId}`,
          this._phase,
          message.type,
        ),
      };
    }

    this._subscriptions.set(unsub.subscribeId, { ...existing, phase: "done" });
    sideEffects.push({
      type: "subscription-ended",
      subscribeId: unsub.subscribeId,
      reason: "unsubscribed",
    });
    return { ok: true, phase: this._phase, sideEffects };
  }

  // Announce handlers
  private namespaceKey(ns: string[]): string {
    return ns.join("/");
  }

  private handleAnnounce(
    message: MoqtMessage,
    _direction: "inbound" | "outbound",
    sideEffects: SideEffect[],
  ): TransitionResult {
    const err = this.requireReady(message.type);
    if (err) return { ok: false, violation: err };

    const ann = message as import("../../core/types.js").Announce;
    const key = this.namespaceKey(ann.trackNamespace);

    this._announces.set(key, { namespace: ann.trackNamespace, phase: "pending" });
    return { ok: true, phase: this._phase, sideEffects };
  }

  private handleAnnounceOk(
    message: MoqtMessage,
    _direction: "inbound" | "outbound",
    sideEffects: SideEffect[],
  ): TransitionResult {
    const err = this.requireReady(message.type);
    if (err) return { ok: false, violation: err };

    const ok = message as import("../../core/types.js").AnnounceOk;
    const key = this.namespaceKey(ok.trackNamespace);
    const existing = this._announces.get(key);
    if (!existing) {
      return {
        ok: false,
        violation: violation(
          "UNEXPECTED_MESSAGE",
          `No announce for namespace ${key}`,
          this._phase,
          message.type,
        ),
      };
    }

    this._announces.set(key, { ...existing, phase: "active" });
    sideEffects.push({ type: "announce-activated", namespace: ok.trackNamespace });
    return { ok: true, phase: this._phase, sideEffects };
  }

  private handleAnnounceError(
    message: MoqtMessage,
    _direction: "inbound" | "outbound",
    sideEffects: SideEffect[],
  ): TransitionResult {
    const err = this.requireReady(message.type);
    if (err) return { ok: false, violation: err };

    const annErr = message as import("../../core/types.js").AnnounceError;
    const key = this.namespaceKey(annErr.trackNamespace);
    const existing = this._announces.get(key);
    if (!existing) {
      return {
        ok: false,
        violation: violation(
          "UNEXPECTED_MESSAGE",
          `No announce for namespace ${key}`,
          this._phase,
          message.type,
        ),
      };
    }

    this._announces.set(key, { ...existing, phase: "error" });
    sideEffects.push({ type: "announce-ended", namespace: annErr.trackNamespace });
    return { ok: true, phase: this._phase, sideEffects };
  }

  private handleAnnounceCancel(
    message: MoqtMessage,
    _direction: "inbound" | "outbound",
    sideEffects: SideEffect[],
  ): TransitionResult {
    const err = this.requireReady(message.type);
    if (err) return { ok: false, violation: err };

    const cancel = message as import("../../core/types.js").AnnounceCancel;
    const key = this.namespaceKey(cancel.trackNamespace);
    const existing = this._announces.get(key);
    if (existing) {
      this._announces.delete(key);
      sideEffects.push({ type: "announce-ended", namespace: cancel.trackNamespace });
    }
    return { ok: true, phase: this._phase, sideEffects };
  }

  private handleUnannounce(
    message: MoqtMessage,
    _direction: "inbound" | "outbound",
    sideEffects: SideEffect[],
  ): TransitionResult {
    const err = this.requireReady(message.type);
    if (err) return { ok: false, violation: err };

    const unann = message as import("../../core/types.js").Unannounce;
    const key = this.namespaceKey(unann.trackNamespace);
    const existing = this._announces.get(key);
    if (existing) {
      this._announces.delete(key);
      sideEffects.push({ type: "announce-ended", namespace: unann.trackNamespace });
    }
    return { ok: true, phase: this._phase, sideEffects };
  }

  private handleReadyPhaseMessage(message: MoqtMessage): TransitionResult {
    const err = this.requireReady(message.type);
    if (err) return { ok: false, violation: err };
    return { ok: true, phase: this._phase, sideEffects: [] };
  }

  reset(): void {
    this._phase = "idle";
    this._subscriptions.clear();
    this._announces.clear();
  }
}
