import type {
  AnnounceState,
  FetchState,
  ProtocolViolation,
  PublishState,
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
import type { Draft14Message, Draft14MessageType } from "./types.js";

function violation(
  code: ProtocolViolation<Draft14MessageType>["code"],
  message: string,
  currentPhase: SessionPhase,
  offendingMessage: Draft14MessageType,
): ProtocolViolation<Draft14MessageType> {
  return { code, message, currentPhase, offendingMessage };
}

export class Draft14SessionFSM {
  private _phase: SessionPhase = "idle";
  private _role: "client" | "server";
  private _subscriptions = new Map<bigint, SubscriptionState>();
  private _publishes = new Map<bigint, PublishState>();
  private _fetches = new Map<bigint, FetchState>();
  private _requestIds = new Set<bigint>();

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
    return new Map();
  }
  get publishes(): ReadonlyMap<bigint, PublishState> {
    return this._publishes;
  }
  get fetches(): ReadonlyMap<bigint, FetchState> {
    return this._fetches;
  }

  get legalOutgoing(): ReadonlySet<Draft14MessageType> {
    return getLegalOutgoing(this._phase, this._role);
  }

  get legalIncoming(): ReadonlySet<Draft14MessageType> {
    return getLegalIncoming(this._phase, this._role);
  }

  // Validate role constraints
  private checkRole(
    message: Draft14Message,
    direction: "inbound" | "outbound",
  ): ProtocolViolation<Draft14MessageType> | null {
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

  private checkDuplicateRequestId(
    requestId: bigint,
    msgType: Draft14MessageType,
  ): ProtocolViolation<Draft14MessageType> | null {
    if (this._requestIds.has(requestId)) {
      return violation(
        "DUPLICATE_REQUEST_ID",
        `Request ID ${requestId} already in use`,
        this._phase,
        msgType,
      );
    }
    return null;
  }

  private checkKnownRequestId(
    requestId: bigint,
    msgType: Draft14MessageType,
  ): ProtocolViolation<Draft14MessageType> | null {
    if (!this._requestIds.has(requestId)) {
      return violation(
        "UNKNOWN_REQUEST_ID",
        `No request with ID ${requestId}`,
        this._phase,
        msgType,
      );
    }
    return null;
  }

  validateOutgoing(message: Draft14Message): ValidationResult<Draft14MessageType> {
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

  receive(message: Draft14Message): TransitionResult<Draft14MessageType> {
    const roleViolation = this.checkRole(message, "inbound");
    if (roleViolation) return { ok: false, violation: roleViolation };

    return this.applyTransition(message, "inbound");
  }

  send(message: Draft14Message): TransitionResult<Draft14MessageType> {
    const roleViolation = this.checkRole(message, "outbound");
    if (roleViolation) return { ok: false, violation: roleViolation };

    return this.applyTransition(message, "outbound");
  }

  private applyTransition(
    message: Draft14Message,
    direction: "inbound" | "outbound",
  ): TransitionResult<Draft14MessageType> {
    const sideEffects: SideEffect[] = [];

    switch (message.type) {
      case "client_setup":
        return this.handleClientSetup(message, direction);
      case "server_setup":
        return this.handleServerSetup(message, direction);
      case "goaway":
        return this.handleGoAway(message, direction, sideEffects);

      // Subscribe lifecycle
      case "subscribe":
        return this.handleSubscribe(message, direction, sideEffects);
      case "subscribe_ok":
        return this.handleSubscribeOk(message, direction, sideEffects);
      case "subscribe_error":
        return this.handleSubscribeError(message, direction, sideEffects);
      case "subscribe_update":
        return this.handleSubscribeUpdate(message, direction, sideEffects);
      case "unsubscribe":
        return this.handleUnsubscribe(message, direction, sideEffects);

      // Publish lifecycle
      case "publish":
        return this.handlePublish(message, direction, sideEffects);
      case "publish_ok":
        return this.handlePublishOk(message, direction, sideEffects);
      case "publish_error":
        return this.handlePublishError(message, direction, sideEffects);
      case "publish_done":
        return this.handlePublishDone(message, direction, sideEffects);

      // Fetch lifecycle
      case "fetch":
        return this.handleFetch(message, direction, sideEffects);
      case "fetch_ok":
        return this.handleFetchOk(message, direction, sideEffects);
      case "fetch_error":
        return this.handleFetchError(message, direction, sideEffects);
      case "fetch_cancel":
        return this.handleFetchCancel(message, direction, sideEffects);

      // Publish namespace lifecycle
      case "publish_namespace":
        return this.handlePublishNamespace(message, sideEffects);
      case "publish_namespace_ok":
        return this.handlePublishNamespaceOk(message, sideEffects);
      case "publish_namespace_error":
        return this.handlePublishNamespaceError(message, sideEffects);
      case "publish_namespace_done":
        return this.handlePublishNamespaceDone(message, sideEffects);
      case "publish_namespace_cancel":
        return this.handlePublishNamespaceCancel(message, sideEffects);

      // Subscribe namespace lifecycle
      case "subscribe_namespace":
        return this.handleSubscribeNamespace(message, sideEffects);
      case "subscribe_namespace_ok":
        return this.handleSubscribeNamespaceOk(message, sideEffects);
      case "subscribe_namespace_error":
        return this.handleSubscribeNamespaceError(message, sideEffects);
      case "unsubscribe_namespace":
        return this.handleUnsubscribeNamespace(message, sideEffects);

      // Track status lifecycle
      case "track_status":
        return this.handleTrackStatus(message, sideEffects);
      case "track_status_ok":
        return this.handleTrackStatusOk(message, sideEffects);
      case "track_status_error":
        return this.handleTrackStatusError(message, sideEffects);

      // Other ready-phase messages
      default:
        return this.handleReadyPhaseMessage(message);
    }
  }

  private handleClientSetup(
    _message: Draft14Message,
    direction: "inbound" | "outbound",
  ): TransitionResult<Draft14MessageType> {
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
    _message: Draft14Message,
    direction: "inbound" | "outbound",
  ): TransitionResult<Draft14MessageType> {
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
    message: Draft14Message,
    _direction: "inbound" | "outbound",
    sideEffects: SideEffect[],
  ): TransitionResult<Draft14MessageType> {
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
    const goaway = message as import("./types.js").Draft14GoAway;
    sideEffects.push({ type: "session-draining", goAwayUri: goaway.new_session_uri });
    return { ok: true, phase: this._phase, sideEffects };
  }

  private requireReady(msgType: Draft14MessageType): ProtocolViolation<Draft14MessageType> | null {
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

  // ─── Subscribe lifecycle ──────────────────────────────────────────────────────

  private handleSubscribe(
    message: Draft14Message,
    _direction: "inbound" | "outbound",
    sideEffects: SideEffect[],
  ): TransitionResult<Draft14MessageType> {
    const err = this.requireReady(message.type);
    if (err) return { ok: false, violation: err };

    const sub = message as import("./types.js").Draft14Subscribe;
    const dupErr = this.checkDuplicateRequestId(sub.request_id, message.type);
    if (dupErr) return { ok: false, violation: dupErr };

    this._requestIds.add(sub.request_id);
    this._subscriptions.set(sub.request_id, {
      subscribeId: sub.request_id,
      phase: "pending",
      trackNamespace: sub.track_namespace,
      trackName: sub.track_name,
    });

    return { ok: true, phase: this._phase, sideEffects };
  }

  private handleSubscribeOk(
    message: Draft14Message,
    _direction: "inbound" | "outbound",
    sideEffects: SideEffect[],
  ): TransitionResult<Draft14MessageType> {
    const err = this.requireReady(message.type);
    if (err) return { ok: false, violation: err };

    const ok = message as import("./types.js").Draft14SubscribeOk;
    const idErr = this.checkKnownRequestId(ok.request_id, message.type);
    if (idErr) return { ok: false, violation: idErr };

    const existing = this._subscriptions.get(ok.request_id);
    if (!existing) {
      return {
        ok: false,
        violation: violation(
          "UNKNOWN_REQUEST_ID",
          `No subscription with request ID ${ok.request_id}`,
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
          `Subscription ${ok.request_id} is ${existing.phase}, not pending`,
          this._phase,
          message.type,
        ),
      };
    }

    this._subscriptions.set(ok.request_id, { ...existing, phase: "active" });
    sideEffects.push({ type: "subscription-activated", subscribeId: ok.request_id });
    return { ok: true, phase: this._phase, sideEffects };
  }

  private handleSubscribeError(
    message: Draft14Message,
    _direction: "inbound" | "outbound",
    sideEffects: SideEffect[],
  ): TransitionResult<Draft14MessageType> {
    const err = this.requireReady(message.type);
    if (err) return { ok: false, violation: err };

    const subErr = message as import("./types.js").Draft14SubscribeError;
    const idErr = this.checkKnownRequestId(subErr.request_id, message.type);
    if (idErr) return { ok: false, violation: idErr };

    const existing = this._subscriptions.get(subErr.request_id);
    if (!existing) {
      return {
        ok: false,
        violation: violation(
          "UNKNOWN_REQUEST_ID",
          `No subscription with request ID ${subErr.request_id}`,
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
          `Subscription ${subErr.request_id} is ${existing.phase}, not pending`,
          this._phase,
          message.type,
        ),
      };
    }

    this._subscriptions.set(subErr.request_id, { ...existing, phase: "error" });
    sideEffects.push({
      type: "subscription-ended",
      subscribeId: subErr.request_id,
      reason: subErr.reason_phrase,
    });
    return { ok: true, phase: this._phase, sideEffects };
  }

  private handleSubscribeUpdate(
    message: Draft14Message,
    _direction: "inbound" | "outbound",
    sideEffects: SideEffect[],
  ): TransitionResult<Draft14MessageType> {
    const err = this.requireReady(message.type);
    if (err) return { ok: false, violation: err };

    const update = message as import("./types.js").Draft14SubscribeUpdate;
    const idErr = this.checkKnownRequestId(update.request_id, message.type);
    if (idErr) return { ok: false, violation: idErr };

    const existing = this._subscriptions.get(update.request_id);
    if (!existing) {
      return {
        ok: false,
        violation: violation(
          "UNKNOWN_REQUEST_ID",
          `No subscription with request ID ${update.request_id}`,
          this._phase,
          message.type,
        ),
      };
    }
    if (existing.phase !== "active") {
      return {
        ok: false,
        violation: violation(
          "STATE_VIOLATION",
          `Subscription ${update.request_id} is ${existing.phase}, not active`,
          this._phase,
          message.type,
        ),
      };
    }

    return { ok: true, phase: this._phase, sideEffects };
  }

  private handleUnsubscribe(
    message: Draft14Message,
    _direction: "inbound" | "outbound",
    sideEffects: SideEffect[],
  ): TransitionResult<Draft14MessageType> {
    const err = this.requireReady(message.type);
    if (err) return { ok: false, violation: err };

    const unsub = message as import("./types.js").Draft14Unsubscribe;
    const idErr = this.checkKnownRequestId(unsub.request_id, message.type);
    if (idErr) return { ok: false, violation: idErr };

    const existing = this._subscriptions.get(unsub.request_id);
    if (!existing) {
      return {
        ok: false,
        violation: violation(
          "UNKNOWN_REQUEST_ID",
          `No subscription with request ID ${unsub.request_id}`,
          this._phase,
          message.type,
        ),
      };
    }

    this._subscriptions.set(unsub.request_id, { ...existing, phase: "done" });
    sideEffects.push({
      type: "subscription-ended",
      subscribeId: unsub.request_id,
      reason: "unsubscribed",
    });
    return { ok: true, phase: this._phase, sideEffects };
  }

  // ─── Publish lifecycle ────────────────────────────────────────────────────────

  private handlePublish(
    message: Draft14Message,
    _direction: "inbound" | "outbound",
    sideEffects: SideEffect[],
  ): TransitionResult<Draft14MessageType> {
    const err = this.requireReady(message.type);
    if (err) return { ok: false, violation: err };

    const pub = message as import("./types.js").Draft14Publish;
    const dupErr = this.checkDuplicateRequestId(pub.request_id, message.type);
    if (dupErr) return { ok: false, violation: dupErr };

    this._requestIds.add(pub.request_id);
    this._publishes.set(pub.request_id, {
      requestId: pub.request_id,
      phase: "pending",
    });

    return { ok: true, phase: this._phase, sideEffects };
  }

  private handlePublishOk(
    message: Draft14Message,
    _direction: "inbound" | "outbound",
    sideEffects: SideEffect[],
  ): TransitionResult<Draft14MessageType> {
    const err = this.requireReady(message.type);
    if (err) return { ok: false, violation: err };

    const ok = message as import("./types.js").Draft14PublishOk;
    const idErr = this.checkKnownRequestId(ok.request_id, message.type);
    if (idErr) return { ok: false, violation: idErr };

    const existing = this._publishes.get(ok.request_id);
    if (!existing) {
      return {
        ok: false,
        violation: violation(
          "UNKNOWN_REQUEST_ID",
          `No publish with request ID ${ok.request_id}`,
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
          `Publish ${ok.request_id} is ${existing.phase}, not pending`,
          this._phase,
          message.type,
        ),
      };
    }

    this._publishes.set(ok.request_id, { ...existing, phase: "active" });
    sideEffects.push({ type: "publish-activated", requestId: ok.request_id });
    return { ok: true, phase: this._phase, sideEffects };
  }

  private handlePublishError(
    message: Draft14Message,
    _direction: "inbound" | "outbound",
    sideEffects: SideEffect[],
  ): TransitionResult<Draft14MessageType> {
    const err = this.requireReady(message.type);
    if (err) return { ok: false, violation: err };

    const pubErr = message as import("./types.js").Draft14PublishError;
    const idErr = this.checkKnownRequestId(pubErr.request_id, message.type);
    if (idErr) return { ok: false, violation: idErr };

    const existing = this._publishes.get(pubErr.request_id);
    if (!existing) {
      return {
        ok: false,
        violation: violation(
          "UNKNOWN_REQUEST_ID",
          `No publish with request ID ${pubErr.request_id}`,
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
          `Publish ${pubErr.request_id} is ${existing.phase}, not pending`,
          this._phase,
          message.type,
        ),
      };
    }

    this._publishes.set(pubErr.request_id, { ...existing, phase: "error" });
    sideEffects.push({
      type: "publish-ended",
      requestId: pubErr.request_id,
      reason: pubErr.reason_phrase,
    });
    return { ok: true, phase: this._phase, sideEffects };
  }

  private handlePublishDone(
    message: Draft14Message,
    _direction: "inbound" | "outbound",
    sideEffects: SideEffect[],
  ): TransitionResult<Draft14MessageType> {
    const err = this.requireReady(message.type);
    if (err) return { ok: false, violation: err };

    const done = message as import("./types.js").Draft14PublishDone;
    const idErr = this.checkKnownRequestId(done.request_id, message.type);
    if (idErr) return { ok: false, violation: idErr };

    const existing = this._publishes.get(done.request_id);
    if (!existing) {
      return {
        ok: false,
        violation: violation(
          "UNKNOWN_REQUEST_ID",
          `No publish with request ID ${done.request_id}`,
          this._phase,
          message.type,
        ),
      };
    }

    this._publishes.set(done.request_id, { ...existing, phase: "done" });
    sideEffects.push({
      type: "publish-ended",
      requestId: done.request_id,
      reason: done.reason_phrase,
    });
    return { ok: true, phase: this._phase, sideEffects };
  }

  // ─── Fetch lifecycle ──────────────────────────────────────────────────────────

  private handleFetch(
    message: Draft14Message,
    _direction: "inbound" | "outbound",
    sideEffects: SideEffect[],
  ): TransitionResult<Draft14MessageType> {
    const err = this.requireReady(message.type);
    if (err) return { ok: false, violation: err };

    const fetch = message as import("./types.js").Draft14Fetch;
    const dupErr = this.checkDuplicateRequestId(fetch.request_id, message.type);
    if (dupErr) return { ok: false, violation: dupErr };

    this._requestIds.add(fetch.request_id);
    this._fetches.set(fetch.request_id, {
      requestId: fetch.request_id,
      phase: "pending",
    });

    return { ok: true, phase: this._phase, sideEffects };
  }

  private handleFetchOk(
    message: Draft14Message,
    _direction: "inbound" | "outbound",
    sideEffects: SideEffect[],
  ): TransitionResult<Draft14MessageType> {
    const err = this.requireReady(message.type);
    if (err) return { ok: false, violation: err };

    const ok = message as import("./types.js").Draft14FetchOk;
    const idErr = this.checkKnownRequestId(ok.request_id, message.type);
    if (idErr) return { ok: false, violation: idErr };

    const existing = this._fetches.get(ok.request_id);
    if (!existing) {
      return {
        ok: false,
        violation: violation(
          "UNKNOWN_REQUEST_ID",
          `No fetch with request ID ${ok.request_id}`,
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
          `Fetch ${ok.request_id} is ${existing.phase}, not pending`,
          this._phase,
          message.type,
        ),
      };
    }

    this._fetches.set(ok.request_id, { ...existing, phase: "active" });
    sideEffects.push({ type: "fetch-activated", requestId: ok.request_id });
    return { ok: true, phase: this._phase, sideEffects };
  }

  private handleFetchError(
    message: Draft14Message,
    _direction: "inbound" | "outbound",
    sideEffects: SideEffect[],
  ): TransitionResult<Draft14MessageType> {
    const err = this.requireReady(message.type);
    if (err) return { ok: false, violation: err };

    const fetchErr = message as import("./types.js").Draft14FetchError;
    const idErr = this.checkKnownRequestId(fetchErr.request_id, message.type);
    if (idErr) return { ok: false, violation: idErr };

    const existing = this._fetches.get(fetchErr.request_id);
    if (!existing) {
      return {
        ok: false,
        violation: violation(
          "UNKNOWN_REQUEST_ID",
          `No fetch with request ID ${fetchErr.request_id}`,
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
          `Fetch ${fetchErr.request_id} is ${existing.phase}, not pending`,
          this._phase,
          message.type,
        ),
      };
    }

    this._fetches.set(fetchErr.request_id, { ...existing, phase: "error" });
    sideEffects.push({
      type: "fetch-ended",
      requestId: fetchErr.request_id,
      reason: fetchErr.reason_phrase,
    });
    return { ok: true, phase: this._phase, sideEffects };
  }

  private handleFetchCancel(
    message: Draft14Message,
    _direction: "inbound" | "outbound",
    sideEffects: SideEffect[],
  ): TransitionResult<Draft14MessageType> {
    const err = this.requireReady(message.type);
    if (err) return { ok: false, violation: err };

    const cancel = message as import("./types.js").Draft14FetchCancel;
    const idErr = this.checkKnownRequestId(cancel.request_id, message.type);
    if (idErr) return { ok: false, violation: idErr };

    const existing = this._fetches.get(cancel.request_id);
    if (!existing) {
      return {
        ok: false,
        violation: violation(
          "UNKNOWN_REQUEST_ID",
          `No fetch with request ID ${cancel.request_id}`,
          this._phase,
          message.type,
        ),
      };
    }

    this._fetches.set(cancel.request_id, { ...existing, phase: "cancelled" });
    sideEffects.push({ type: "fetch-ended", requestId: cancel.request_id, reason: "cancelled" });
    return { ok: true, phase: this._phase, sideEffects };
  }

  // ─── Publish namespace lifecycle ──────────────────────────────────────────────

  private handlePublishNamespace(
    message: Draft14Message,
    sideEffects: SideEffect[],
  ): TransitionResult<Draft14MessageType> {
    const err = this.requireReady(message.type);
    if (err) return { ok: false, violation: err };
    const pn = message as import("./types.js").Draft14PublishNamespace;
    const dupErr = this.checkDuplicateRequestId(pn.request_id, message.type);
    if (dupErr) return { ok: false, violation: dupErr };
    this._requestIds.add(pn.request_id);
    return { ok: true, phase: this._phase, sideEffects };
  }

  private handlePublishNamespaceOk(
    message: Draft14Message,
    sideEffects: SideEffect[],
  ): TransitionResult<Draft14MessageType> {
    const err = this.requireReady(message.type);
    if (err) return { ok: false, violation: err };
    const ok = message as import("./types.js").Draft14PublishNamespaceOk;
    const idErr = this.checkKnownRequestId(ok.request_id, message.type);
    if (idErr) return { ok: false, violation: idErr };
    return { ok: true, phase: this._phase, sideEffects };
  }

  private handlePublishNamespaceError(
    message: Draft14Message,
    sideEffects: SideEffect[],
  ): TransitionResult<Draft14MessageType> {
    const err = this.requireReady(message.type);
    if (err) return { ok: false, violation: err };
    const pnErr = message as import("./types.js").Draft14PublishNamespaceError;
    const idErr = this.checkKnownRequestId(pnErr.request_id, message.type);
    if (idErr) return { ok: false, violation: idErr };
    return { ok: true, phase: this._phase, sideEffects };
  }

  private handlePublishNamespaceDone(
    message: Draft14Message,
    sideEffects: SideEffect[],
  ): TransitionResult<Draft14MessageType> {
    const err = this.requireReady(message.type);
    if (err) return { ok: false, violation: err };
    const done = message as import("./types.js").Draft14PublishNamespaceDone;
    const idErr = this.checkKnownRequestId(done.request_id, message.type);
    if (idErr) return { ok: false, violation: idErr };
    return { ok: true, phase: this._phase, sideEffects };
  }

  private handlePublishNamespaceCancel(
    message: Draft14Message,
    sideEffects: SideEffect[],
  ): TransitionResult<Draft14MessageType> {
    const err = this.requireReady(message.type);
    if (err) return { ok: false, violation: err };
    const cancel = message as import("./types.js").Draft14PublishNamespaceCancel;
    const idErr = this.checkKnownRequestId(cancel.request_id, message.type);
    if (idErr) return { ok: false, violation: idErr };
    return { ok: true, phase: this._phase, sideEffects };
  }

  // ─── Subscribe namespace lifecycle ──────────────────────────────────────────────

  private handleSubscribeNamespace(
    message: Draft14Message,
    sideEffects: SideEffect[],
  ): TransitionResult<Draft14MessageType> {
    const err = this.requireReady(message.type);
    if (err) return { ok: false, violation: err };
    const sn = message as import("./types.js").Draft14SubscribeNamespace;
    const dupErr = this.checkDuplicateRequestId(sn.request_id, message.type);
    if (dupErr) return { ok: false, violation: dupErr };
    this._requestIds.add(sn.request_id);
    return { ok: true, phase: this._phase, sideEffects };
  }

  private handleSubscribeNamespaceOk(
    message: Draft14Message,
    sideEffects: SideEffect[],
  ): TransitionResult<Draft14MessageType> {
    const err = this.requireReady(message.type);
    if (err) return { ok: false, violation: err };
    const ok = message as import("./types.js").Draft14SubscribeNamespaceOk;
    const idErr = this.checkKnownRequestId(ok.request_id, message.type);
    if (idErr) return { ok: false, violation: idErr };
    return { ok: true, phase: this._phase, sideEffects };
  }

  private handleSubscribeNamespaceError(
    message: Draft14Message,
    sideEffects: SideEffect[],
  ): TransitionResult<Draft14MessageType> {
    const err = this.requireReady(message.type);
    if (err) return { ok: false, violation: err };
    const snErr = message as import("./types.js").Draft14SubscribeNamespaceError;
    const idErr = this.checkKnownRequestId(snErr.request_id, message.type);
    if (idErr) return { ok: false, violation: idErr };
    return { ok: true, phase: this._phase, sideEffects };
  }

  private handleUnsubscribeNamespace(
    message: Draft14Message,
    sideEffects: SideEffect[],
  ): TransitionResult<Draft14MessageType> {
    const err = this.requireReady(message.type);
    if (err) return { ok: false, violation: err };
    // unsubscribe_namespace has no request_id — namespace-based
    return { ok: true, phase: this._phase, sideEffects };
  }

  // ─── Track status lifecycle ──────────────────────────────────────────────────

  private handleTrackStatus(
    message: Draft14Message,
    sideEffects: SideEffect[],
  ): TransitionResult<Draft14MessageType> {
    const err = this.requireReady(message.type);
    if (err) return { ok: false, violation: err };
    const ts = message as import("./types.js").Draft14TrackStatus;
    const dupErr = this.checkDuplicateRequestId(ts.request_id, message.type);
    if (dupErr) return { ok: false, violation: dupErr };
    this._requestIds.add(ts.request_id);
    return { ok: true, phase: this._phase, sideEffects };
  }

  private handleTrackStatusOk(
    message: Draft14Message,
    sideEffects: SideEffect[],
  ): TransitionResult<Draft14MessageType> {
    const err = this.requireReady(message.type);
    if (err) return { ok: false, violation: err };
    const ok = message as import("./types.js").Draft14TrackStatusOk;
    const idErr = this.checkKnownRequestId(ok.request_id, message.type);
    if (idErr) return { ok: false, violation: idErr };
    return { ok: true, phase: this._phase, sideEffects };
  }

  private handleTrackStatusError(
    message: Draft14Message,
    sideEffects: SideEffect[],
  ): TransitionResult<Draft14MessageType> {
    const err = this.requireReady(message.type);
    if (err) return { ok: false, violation: err };
    const tsErr = message as import("./types.js").Draft14TrackStatusError;
    const idErr = this.checkKnownRequestId(tsErr.request_id, message.type);
    if (idErr) return { ok: false, violation: idErr };
    return { ok: true, phase: this._phase, sideEffects };
  }

  // ─── Generic ready-phase handler ──────────────────────────────────────────────

  private handleReadyPhaseMessage(message: Draft14Message): TransitionResult<Draft14MessageType> {
    const err = this.requireReady(message.type);
    if (err) return { ok: false, violation: err };
    return { ok: true, phase: this._phase, sideEffects: [] };
  }

  reset(): void {
    this._phase = "idle";
    this._subscriptions.clear();
    this._publishes.clear();
    this._fetches.clear();
    this._requestIds.clear();
  }
}
