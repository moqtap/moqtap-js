import type {
  AnnounceState,
  FetchState,
  ProtocolViolation,
  SessionPhase,
  SideEffect,
  SubscriptionState,
  TransitionResult,
  ValidationResult,
} from "../../core/session-types.js";
import {
  CLIENT_ONLY_MESSAGES,
  getLegalIncoming,
  getLegalOutgoing,
  SERVER_ONLY_MESSAGES,
} from "./rules.js";
import type { Draft09Message, Draft09MessageType } from "./types.js";

function violation(
  code: ProtocolViolation<Draft09MessageType>["code"],
  message: string,
  currentPhase: SessionPhase,
  offendingMessage: Draft09MessageType,
): ProtocolViolation<Draft09MessageType> {
  return { code, message, currentPhase, offendingMessage };
}

export class Draft09SessionFSM {
  private _phase: SessionPhase = "idle";
  private _role: "client" | "server";
  private _subscriptions = new Map<bigint, SubscriptionState>();
  private _announces = new Map<string, AnnounceState>();
  private _fetches = new Map<bigint, FetchState>();
  private _subscribeIds = new Set<bigint>();

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
  get fetches(): ReadonlyMap<bigint, FetchState> {
    return this._fetches;
  }

  get legalOutgoing(): ReadonlySet<Draft09MessageType> {
    return getLegalOutgoing(this._phase, this._role);
  }

  get legalIncoming(): ReadonlySet<Draft09MessageType> {
    return getLegalIncoming(this._phase, this._role);
  }

  private checkRole(
    message: Draft09Message,
    direction: "inbound" | "outbound",
  ): ProtocolViolation<Draft09MessageType> | null {
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

  private checkDuplicateSubscribeId(
    subscribeId: bigint,
    msgType: Draft09MessageType,
  ): ProtocolViolation<Draft09MessageType> | null {
    if (this._subscribeIds.has(subscribeId)) {
      return violation(
        "DUPLICATE_REQUEST_ID",
        `Subscribe ID ${subscribeId} already in use`,
        this._phase,
        msgType,
      );
    }
    return null;
  }

  private checkKnownSubscribeId(
    subscribeId: bigint,
    msgType: Draft09MessageType,
  ): ProtocolViolation<Draft09MessageType> | null {
    if (!this._subscribeIds.has(subscribeId)) {
      return violation(
        "UNKNOWN_REQUEST_ID",
        `No request with subscribe ID ${subscribeId}`,
        this._phase,
        msgType,
      );
    }
    return null;
  }

  validateOutgoing(message: Draft09Message): ValidationResult<Draft09MessageType> {
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

  receive(message: Draft09Message): TransitionResult<Draft09MessageType> {
    const roleViolation = this.checkRole(message, "inbound");
    if (roleViolation) return { ok: false, violation: roleViolation };
    return this.applyTransition(message, "inbound");
  }

  send(message: Draft09Message): TransitionResult<Draft09MessageType> {
    const roleViolation = this.checkRole(message, "outbound");
    if (roleViolation) return { ok: false, violation: roleViolation };
    return this.applyTransition(message, "outbound");
  }

  private applyTransition(
    message: Draft09Message,
    direction: "inbound" | "outbound",
  ): TransitionResult<Draft09MessageType> {
    const sideEffects: SideEffect[] = [];

    switch (message.type) {
      case "client_setup":
        return this.handleClientSetup(direction);
      case "server_setup":
        return this.handleServerSetup(direction);
      case "goaway":
        return this.handleGoAway(message, sideEffects);

      // Subscribe lifecycle
      case "subscribe":
        return this.handleSubscribe(message, sideEffects);
      case "subscribe_ok":
        return this.handleSubscribeOk(message, sideEffects);
      case "subscribe_error":
        return this.handleSubscribeError(message, sideEffects);
      case "subscribe_update":
        return this.handleSubscribeUpdate(message, sideEffects);
      case "subscribe_done":
        return this.handleSubscribeDone(message, sideEffects);
      case "unsubscribe":
        return this.handleUnsubscribe(message, sideEffects);

      // Announce lifecycle
      case "announce":
        return this.handleAnnounce(message, sideEffects);
      case "announce_ok":
        return this.handleAnnounceOk(message, sideEffects);
      case "announce_error":
        return this.handleAnnounceError(message, sideEffects);
      case "unannounce":
        return this.handleUnannounce(message, sideEffects);
      case "announce_cancel":
        return this.handleAnnounceCancel(message, sideEffects);

      // Fetch lifecycle
      case "fetch":
        return this.handleFetch(message, sideEffects);
      case "fetch_ok":
        return this.handleFetchOk(message, sideEffects);
      case "fetch_error":
        return this.handleFetchError(message, sideEffects);
      case "fetch_cancel":
        return this.handleFetchCancel(message, sideEffects);
      default:
        return this.handleReadyPhaseMessage(message);
    }
  }

  private handleClientSetup(
    direction: "inbound" | "outbound",
  ): TransitionResult<Draft09MessageType> {
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
    direction: "inbound" | "outbound",
  ): TransitionResult<Draft09MessageType> {
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
    message: Draft09Message,
    sideEffects: SideEffect[],
  ): TransitionResult<Draft09MessageType> {
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
    const goaway = message as import("./types.js").Draft09GoAway;
    sideEffects.push({ type: "session-draining", goAwayUri: goaway.new_session_uri });
    return { ok: true, phase: this._phase, sideEffects };
  }

  private requireReady(msgType: Draft09MessageType): ProtocolViolation<Draft09MessageType> | null {
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

  // ─── Subscribe lifecycle ───

  private handleSubscribe(
    message: Draft09Message,
    sideEffects: SideEffect[],
  ): TransitionResult<Draft09MessageType> {
    const err = this.requireReady(message.type);
    if (err) return { ok: false, violation: err };
    const sub = message as import("./types.js").Draft09Subscribe;
    const dupErr = this.checkDuplicateSubscribeId(sub.subscribe_id, message.type);
    if (dupErr) return { ok: false, violation: dupErr };
    this._subscribeIds.add(sub.subscribe_id);
    this._subscriptions.set(sub.subscribe_id, {
      subscribeId: sub.subscribe_id,
      phase: "pending",
      trackNamespace: sub.track_namespace,
      trackName: sub.track_name,
    });
    return { ok: true, phase: this._phase, sideEffects };
  }

  private handleSubscribeOk(
    message: Draft09Message,
    sideEffects: SideEffect[],
  ): TransitionResult<Draft09MessageType> {
    const err = this.requireReady(message.type);
    if (err) return { ok: false, violation: err };
    const ok = message as import("./types.js").Draft09SubscribeOk;
    const idErr = this.checkKnownSubscribeId(ok.subscribe_id, message.type);
    if (idErr) return { ok: false, violation: idErr };
    const existing = this._subscriptions.get(ok.subscribe_id);
    if (!existing)
      return {
        ok: false,
        violation: violation(
          "UNKNOWN_REQUEST_ID",
          `No subscription with subscribe ID ${ok.subscribe_id}`,
          this._phase,
          message.type,
        ),
      };
    if (existing.phase !== "pending")
      return {
        ok: false,
        violation: violation(
          "STATE_VIOLATION",
          `Subscription ${ok.subscribe_id} is ${existing.phase}, not pending`,
          this._phase,
          message.type,
        ),
      };
    this._subscriptions.set(ok.subscribe_id, { ...existing, phase: "active" });
    sideEffects.push({ type: "subscription-activated", subscribeId: ok.subscribe_id });
    return { ok: true, phase: this._phase, sideEffects };
  }

  private handleSubscribeError(
    message: Draft09Message,
    sideEffects: SideEffect[],
  ): TransitionResult<Draft09MessageType> {
    const err = this.requireReady(message.type);
    if (err) return { ok: false, violation: err };
    const subErr = message as import("./types.js").Draft09SubscribeError;
    const idErr = this.checkKnownSubscribeId(subErr.subscribe_id, message.type);
    if (idErr) return { ok: false, violation: idErr };
    const existing = this._subscriptions.get(subErr.subscribe_id);
    if (!existing)
      return {
        ok: false,
        violation: violation(
          "UNKNOWN_REQUEST_ID",
          `No subscription with subscribe ID ${subErr.subscribe_id}`,
          this._phase,
          message.type,
        ),
      };
    if (existing.phase !== "pending")
      return {
        ok: false,
        violation: violation(
          "STATE_VIOLATION",
          `Subscription ${subErr.subscribe_id} is ${existing.phase}, not pending`,
          this._phase,
          message.type,
        ),
      };
    this._subscriptions.set(subErr.subscribe_id, { ...existing, phase: "error" });
    sideEffects.push({
      type: "subscription-ended",
      subscribeId: subErr.subscribe_id,
      reason: subErr.reason_phrase,
    });
    return { ok: true, phase: this._phase, sideEffects };
  }

  private handleSubscribeUpdate(
    message: Draft09Message,
    sideEffects: SideEffect[],
  ): TransitionResult<Draft09MessageType> {
    const err = this.requireReady(message.type);
    if (err) return { ok: false, violation: err };
    const update = message as import("./types.js").Draft09SubscribeUpdate;
    const idErr = this.checkKnownSubscribeId(update.subscribe_id, message.type);
    if (idErr) return { ok: false, violation: idErr };
    const existing = this._subscriptions.get(update.subscribe_id);
    if (!existing)
      return {
        ok: false,
        violation: violation(
          "UNKNOWN_REQUEST_ID",
          `No subscription with subscribe ID ${update.subscribe_id}`,
          this._phase,
          message.type,
        ),
      };
    if (existing.phase !== "active")
      return {
        ok: false,
        violation: violation(
          "STATE_VIOLATION",
          `Subscription ${update.subscribe_id} is ${existing.phase}, not active`,
          this._phase,
          message.type,
        ),
      };
    return { ok: true, phase: this._phase, sideEffects };
  }

  private handleSubscribeDone(
    message: Draft09Message,
    sideEffects: SideEffect[],
  ): TransitionResult<Draft09MessageType> {
    const err = this.requireReady(message.type);
    if (err) return { ok: false, violation: err };
    const done = message as import("./types.js").Draft09SubscribeDone;
    const idErr = this.checkKnownSubscribeId(done.subscribe_id, message.type);
    if (idErr) return { ok: false, violation: idErr };
    const existing = this._subscriptions.get(done.subscribe_id);
    if (!existing)
      return {
        ok: false,
        violation: violation(
          "UNKNOWN_REQUEST_ID",
          `No subscription with subscribe ID ${done.subscribe_id}`,
          this._phase,
          message.type,
        ),
      };
    this._subscriptions.set(done.subscribe_id, { ...existing, phase: "done" });
    sideEffects.push({
      type: "subscription-ended",
      subscribeId: done.subscribe_id,
      reason: done.reason_phrase,
    });
    return { ok: true, phase: this._phase, sideEffects };
  }

  private handleUnsubscribe(
    message: Draft09Message,
    sideEffects: SideEffect[],
  ): TransitionResult<Draft09MessageType> {
    const err = this.requireReady(message.type);
    if (err) return { ok: false, violation: err };
    const unsub = message as import("./types.js").Draft09Unsubscribe;
    const idErr = this.checkKnownSubscribeId(unsub.subscribe_id, message.type);
    if (idErr) return { ok: false, violation: idErr };
    const existing = this._subscriptions.get(unsub.subscribe_id);
    if (!existing)
      return {
        ok: false,
        violation: violation(
          "UNKNOWN_REQUEST_ID",
          `No subscription with subscribe ID ${unsub.subscribe_id}`,
          this._phase,
          message.type,
        ),
      };
    this._subscriptions.set(unsub.subscribe_id, { ...existing, phase: "done" });
    sideEffects.push({
      type: "subscription-ended",
      subscribeId: unsub.subscribe_id,
      reason: "unsubscribed",
    });
    return { ok: true, phase: this._phase, sideEffects };
  }

  // ─── Announce lifecycle ───

  private handleAnnounce(
    message: Draft09Message,
    sideEffects: SideEffect[],
  ): TransitionResult<Draft09MessageType> {
    const err = this.requireReady(message.type);
    if (err) return { ok: false, violation: err };
    const ann = message as import("./types.js").Draft09Announce;
    const nsKey = ann.track_namespace.join("/");
    this._announces.set(nsKey, { namespace: ann.track_namespace, phase: "pending" });
    return { ok: true, phase: this._phase, sideEffects };
  }

  private handleAnnounceOk(
    message: Draft09Message,
    sideEffects: SideEffect[],
  ): TransitionResult<Draft09MessageType> {
    const err = this.requireReady(message.type);
    if (err) return { ok: false, violation: err };
    const ok = message as import("./types.js").Draft09AnnounceOk;
    const nsKey = ok.track_namespace.join("/");
    const existing = this._announces.get(nsKey);
    if (!existing)
      return {
        ok: false,
        violation: violation(
          "UNKNOWN_REQUEST_ID",
          `No announce for namespace ${nsKey}`,
          this._phase,
          message.type,
        ),
      };
    if (existing.phase !== "pending")
      return {
        ok: false,
        violation: violation(
          "STATE_VIOLATION",
          `Announce ${nsKey} is ${existing.phase}, not pending`,
          this._phase,
          message.type,
        ),
      };
    this._announces.set(nsKey, { ...existing, phase: "active" });
    return { ok: true, phase: this._phase, sideEffects };
  }

  private handleAnnounceError(
    message: Draft09Message,
    sideEffects: SideEffect[],
  ): TransitionResult<Draft09MessageType> {
    const err = this.requireReady(message.type);
    if (err) return { ok: false, violation: err };
    const annErr = message as import("./types.js").Draft09AnnounceError;
    const nsKey = annErr.track_namespace.join("/");
    const existing = this._announces.get(nsKey);
    if (!existing)
      return {
        ok: false,
        violation: violation(
          "UNKNOWN_REQUEST_ID",
          `No announce for namespace ${nsKey}`,
          this._phase,
          message.type,
        ),
      };
    if (existing.phase !== "pending")
      return {
        ok: false,
        violation: violation(
          "STATE_VIOLATION",
          `Announce ${nsKey} is ${existing.phase}, not pending`,
          this._phase,
          message.type,
        ),
      };
    this._announces.set(nsKey, { ...existing, phase: "error" });
    sideEffects.push({ type: "announce-ended", namespace: annErr.track_namespace });
    return { ok: true, phase: this._phase, sideEffects };
  }

  private handleUnannounce(
    message: Draft09Message,
    sideEffects: SideEffect[],
  ): TransitionResult<Draft09MessageType> {
    const err = this.requireReady(message.type);
    if (err) return { ok: false, violation: err };
    const unann = message as import("./types.js").Draft09Unannounce;
    const nsKey = unann.track_namespace.join("/");
    const existing = this._announces.get(nsKey);
    if (existing) {
      this._announces.delete(nsKey);
      sideEffects.push({ type: "announce-ended", namespace: unann.track_namespace });
    }
    return { ok: true, phase: this._phase, sideEffects };
  }

  private handleAnnounceCancel(
    message: Draft09Message,
    sideEffects: SideEffect[],
  ): TransitionResult<Draft09MessageType> {
    const err = this.requireReady(message.type);
    if (err) return { ok: false, violation: err };
    const cancel = message as import("./types.js").Draft09AnnounceCancel;
    const nsKey = cancel.track_namespace.join("/");
    const existing = this._announces.get(nsKey);
    if (existing) {
      this._announces.delete(nsKey);
      sideEffects.push({ type: "announce-ended", namespace: cancel.track_namespace });
    }
    return { ok: true, phase: this._phase, sideEffects };
  }

  // ─── Fetch lifecycle ───

  private handleFetch(
    message: Draft09Message,
    sideEffects: SideEffect[],
  ): TransitionResult<Draft09MessageType> {
    const err = this.requireReady(message.type);
    if (err) return { ok: false, violation: err };
    const fetch = message as import("./types.js").Draft09Fetch;
    const dupErr = this.checkDuplicateSubscribeId(fetch.subscribe_id, message.type);
    if (dupErr) return { ok: false, violation: dupErr };
    this._subscribeIds.add(fetch.subscribe_id);
    this._fetches.set(fetch.subscribe_id, { requestId: fetch.subscribe_id, phase: "pending" });
    return { ok: true, phase: this._phase, sideEffects };
  }

  private handleFetchOk(
    message: Draft09Message,
    sideEffects: SideEffect[],
  ): TransitionResult<Draft09MessageType> {
    const err = this.requireReady(message.type);
    if (err) return { ok: false, violation: err };
    const ok = message as import("./types.js").Draft09FetchOk;
    const idErr = this.checkKnownSubscribeId(ok.subscribe_id, message.type);
    if (idErr) return { ok: false, violation: idErr };
    const existing = this._fetches.get(ok.subscribe_id);
    if (!existing)
      return {
        ok: false,
        violation: violation(
          "UNKNOWN_REQUEST_ID",
          `No fetch with subscribe ID ${ok.subscribe_id}`,
          this._phase,
          message.type,
        ),
      };
    if (existing.phase !== "pending")
      return {
        ok: false,
        violation: violation(
          "STATE_VIOLATION",
          `Fetch ${ok.subscribe_id} is ${existing.phase}, not pending`,
          this._phase,
          message.type,
        ),
      };
    this._fetches.set(ok.subscribe_id, { ...existing, phase: "active" });
    sideEffects.push({ type: "fetch-activated", requestId: ok.subscribe_id });
    return { ok: true, phase: this._phase, sideEffects };
  }

  private handleFetchError(
    message: Draft09Message,
    sideEffects: SideEffect[],
  ): TransitionResult<Draft09MessageType> {
    const err = this.requireReady(message.type);
    if (err) return { ok: false, violation: err };
    const fetchErr = message as import("./types.js").Draft09FetchError;
    const idErr = this.checkKnownSubscribeId(fetchErr.subscribe_id, message.type);
    if (idErr) return { ok: false, violation: idErr };
    const existing = this._fetches.get(fetchErr.subscribe_id);
    if (!existing)
      return {
        ok: false,
        violation: violation(
          "UNKNOWN_REQUEST_ID",
          `No fetch with subscribe ID ${fetchErr.subscribe_id}`,
          this._phase,
          message.type,
        ),
      };
    this._fetches.set(fetchErr.subscribe_id, { ...existing, phase: "error" });
    sideEffects.push({
      type: "fetch-ended",
      requestId: fetchErr.subscribe_id,
      reason: fetchErr.reason_phrase,
    });
    return { ok: true, phase: this._phase, sideEffects };
  }

  private handleFetchCancel(
    message: Draft09Message,
    sideEffects: SideEffect[],
  ): TransitionResult<Draft09MessageType> {
    const err = this.requireReady(message.type);
    if (err) return { ok: false, violation: err };
    const cancel = message as import("./types.js").Draft09FetchCancel;
    const idErr = this.checkKnownSubscribeId(cancel.subscribe_id, message.type);
    if (idErr) return { ok: false, violation: idErr };
    const existing = this._fetches.get(cancel.subscribe_id);
    if (!existing)
      return {
        ok: false,
        violation: violation(
          "UNKNOWN_REQUEST_ID",
          `No fetch with subscribe ID ${cancel.subscribe_id}`,
          this._phase,
          message.type,
        ),
      };
    this._fetches.set(cancel.subscribe_id, { ...existing, phase: "cancelled" });
    sideEffects.push({ type: "fetch-ended", requestId: cancel.subscribe_id, reason: "cancelled" });
    return { ok: true, phase: this._phase, sideEffects };
  }

  // ─── Generic ready-phase handler ───

  private handleReadyPhaseMessage(message: Draft09Message): TransitionResult<Draft09MessageType> {
    const err = this.requireReady(message.type);
    if (err) return { ok: false, violation: err };
    return { ok: true, phase: this._phase, sideEffects: [] };
  }

  reset(): void {
    this._phase = "idle";
    this._subscriptions.clear();
    this._announces.clear();
    this._fetches.clear();
    this._subscribeIds.clear();
  }
}
