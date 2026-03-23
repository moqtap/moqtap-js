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
import type { Draft16Message, Draft16MessageType } from "./types.js";

function violation(
  code: ProtocolViolation<Draft16MessageType>["code"],
  message: string,
  currentPhase: SessionPhase,
  offendingMessage: Draft16MessageType,
): ProtocolViolation<Draft16MessageType> {
  return { code, message, currentPhase, offendingMessage };
}

export class Draft16SessionFSM {
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

  get legalOutgoing(): ReadonlySet<Draft16MessageType> {
    return getLegalOutgoing(this._phase, this._role);
  }

  get legalIncoming(): ReadonlySet<Draft16MessageType> {
    return getLegalIncoming(this._phase, this._role);
  }

  private checkRole(
    message: Draft16Message,
    direction: "inbound" | "outbound",
  ): ProtocolViolation<Draft16MessageType> | null {
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
    msgType: Draft16MessageType,
  ): ProtocolViolation<Draft16MessageType> | null {
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
    msgType: Draft16MessageType,
  ): ProtocolViolation<Draft16MessageType> | null {
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

  validateOutgoing(message: Draft16Message): ValidationResult<Draft16MessageType> {
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

  receive(message: Draft16Message): TransitionResult<Draft16MessageType> {
    const roleViolation = this.checkRole(message, "inbound");
    if (roleViolation) return { ok: false, violation: roleViolation };
    return this.applyTransition(message, "inbound");
  }

  send(message: Draft16Message): TransitionResult<Draft16MessageType> {
    const roleViolation = this.checkRole(message, "outbound");
    if (roleViolation) return { ok: false, violation: roleViolation };
    return this.applyTransition(message, "outbound");
  }

  private applyTransition(
    message: Draft16Message,
    direction: "inbound" | "outbound",
  ): TransitionResult<Draft16MessageType> {
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
      case "request_update":
        return this.handleRequestUpdate(message, sideEffects);
      case "unsubscribe":
        return this.handleUnsubscribe(message, sideEffects);

      // Publish lifecycle
      case "publish":
        return this.handlePublish(message, sideEffects);
      case "publish_ok":
        return this.handlePublishOk(message, sideEffects);
      case "publish_done":
        return this.handlePublishDone(message, sideEffects);

      // Fetch lifecycle
      case "fetch":
        return this.handleFetch(message, sideEffects);
      case "fetch_ok":
        return this.handleFetchOk(message, sideEffects);
      case "fetch_cancel":
        return this.handleFetchCancel(message, sideEffects);

      // Consolidated responses
      case "request_ok":
        return this.handleRequestOk(message, sideEffects);
      case "request_error":
        return this.handleRequestError(message, sideEffects);

      // Namespace and track status — register request IDs
      case "publish_namespace":
        return this.handlePublishNamespace(message, sideEffects);
      case "subscribe_namespace":
        return this.handleSubscribeNamespace(message, sideEffects);
      case "track_status":
        return this.handleTrackStatus(message, sideEffects);

      // Other ready-phase messages
      default:
        return this.handleReadyPhaseMessage(message);
    }
  }

  private handleClientSetup(
    direction: "inbound" | "outbound",
  ): TransitionResult<Draft16MessageType> {
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
  ): TransitionResult<Draft16MessageType> {
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
    message: Draft16Message,
    sideEffects: SideEffect[],
  ): TransitionResult<Draft16MessageType> {
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
    const goaway = message as import("./types.js").Draft16GoAway;
    sideEffects.push({ type: "session-draining", goAwayUri: goaway.new_session_uri });
    return { ok: true, phase: this._phase, sideEffects };
  }

  private requireReady(msgType: Draft16MessageType): ProtocolViolation<Draft16MessageType> | null {
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
    message: Draft16Message,
    sideEffects: SideEffect[],
  ): TransitionResult<Draft16MessageType> {
    const err = this.requireReady(message.type);
    if (err) return { ok: false, violation: err };
    const sub = message as import("./types.js").Draft16Subscribe;
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
    message: Draft16Message,
    sideEffects: SideEffect[],
  ): TransitionResult<Draft16MessageType> {
    const err = this.requireReady(message.type);
    if (err) return { ok: false, violation: err };
    const ok = message as import("./types.js").Draft16SubscribeOk;
    const idErr = this.checkKnownRequestId(ok.request_id, message.type);
    if (idErr) return { ok: false, violation: idErr };
    const existing = this._subscriptions.get(ok.request_id);
    if (!existing)
      return {
        ok: false,
        violation: violation(
          "UNKNOWN_REQUEST_ID",
          `No subscription with request ID ${ok.request_id}`,
          this._phase,
          message.type,
        ),
      };
    if (existing.phase !== "pending")
      return {
        ok: false,
        violation: violation(
          "STATE_VIOLATION",
          `Subscription ${ok.request_id} is ${existing.phase}, not pending`,
          this._phase,
          message.type,
        ),
      };
    this._subscriptions.set(ok.request_id, { ...existing, phase: "active" });
    sideEffects.push({ type: "subscription-activated", subscribeId: ok.request_id });
    return { ok: true, phase: this._phase, sideEffects };
  }

  // Renamed from handleSubscribeUpdate in draft-15
  private handleRequestUpdate(
    message: Draft16Message,
    sideEffects: SideEffect[],
  ): TransitionResult<Draft16MessageType> {
    const err = this.requireReady(message.type);
    if (err) return { ok: false, violation: err };
    const update = message as import("./types.js").Draft16RequestUpdate;
    const dupErr = this.checkDuplicateRequestId(update.request_id, message.type);
    if (dupErr) return { ok: false, violation: dupErr };
    this._requestIds.add(update.request_id);
    const existing = this._subscriptions.get(update.existing_request_id);
    if (!existing)
      return {
        ok: false,
        violation: violation(
          "UNKNOWN_REQUEST_ID",
          `No subscription with request ID ${update.existing_request_id}`,
          this._phase,
          message.type,
        ),
      };
    if (existing.phase !== "active")
      return {
        ok: false,
        violation: violation(
          "STATE_VIOLATION",
          `Subscription ${update.existing_request_id} is ${existing.phase}, not active`,
          this._phase,
          message.type,
        ),
      };
    return { ok: true, phase: this._phase, sideEffects };
  }

  private handleUnsubscribe(
    message: Draft16Message,
    sideEffects: SideEffect[],
  ): TransitionResult<Draft16MessageType> {
    const err = this.requireReady(message.type);
    if (err) return { ok: false, violation: err };
    const unsub = message as import("./types.js").Draft16Unsubscribe;
    const idErr = this.checkKnownRequestId(unsub.request_id, message.type);
    if (idErr) return { ok: false, violation: idErr };
    const existing = this._subscriptions.get(unsub.request_id);
    if (!existing)
      return {
        ok: false,
        violation: violation(
          "UNKNOWN_REQUEST_ID",
          `No subscription with request ID ${unsub.request_id}`,
          this._phase,
          message.type,
        ),
      };
    this._subscriptions.set(unsub.request_id, { ...existing, phase: "done" });
    sideEffects.push({
      type: "subscription-ended",
      subscribeId: unsub.request_id,
      reason: "unsubscribed",
    });
    return { ok: true, phase: this._phase, sideEffects };
  }

  private handlePublish(
    message: Draft16Message,
    sideEffects: SideEffect[],
  ): TransitionResult<Draft16MessageType> {
    const err = this.requireReady(message.type);
    if (err) return { ok: false, violation: err };
    const pub = message as import("./types.js").Draft16Publish;
    const dupErr = this.checkDuplicateRequestId(pub.request_id, message.type);
    if (dupErr) return { ok: false, violation: dupErr };
    this._requestIds.add(pub.request_id);
    this._publishes.set(pub.request_id, { requestId: pub.request_id, phase: "pending" });
    return { ok: true, phase: this._phase, sideEffects };
  }

  private handlePublishOk(
    message: Draft16Message,
    sideEffects: SideEffect[],
  ): TransitionResult<Draft16MessageType> {
    const err = this.requireReady(message.type);
    if (err) return { ok: false, violation: err };
    const ok = message as import("./types.js").Draft16PublishOk;
    const idErr = this.checkKnownRequestId(ok.request_id, message.type);
    if (idErr) return { ok: false, violation: idErr };
    const existing = this._publishes.get(ok.request_id);
    if (!existing)
      return {
        ok: false,
        violation: violation(
          "UNKNOWN_REQUEST_ID",
          `No publish with request ID ${ok.request_id}`,
          this._phase,
          message.type,
        ),
      };
    if (existing.phase !== "pending")
      return {
        ok: false,
        violation: violation(
          "STATE_VIOLATION",
          `Publish ${ok.request_id} is ${existing.phase}, not pending`,
          this._phase,
          message.type,
        ),
      };
    this._publishes.set(ok.request_id, { ...existing, phase: "active" });
    sideEffects.push({ type: "publish-activated", requestId: ok.request_id });
    return { ok: true, phase: this._phase, sideEffects };
  }

  private handlePublishDone(
    message: Draft16Message,
    sideEffects: SideEffect[],
  ): TransitionResult<Draft16MessageType> {
    const err = this.requireReady(message.type);
    if (err) return { ok: false, violation: err };
    const done = message as import("./types.js").Draft16PublishDone;
    const idErr = this.checkKnownRequestId(done.request_id, message.type);
    if (idErr) return { ok: false, violation: idErr };
    const existing = this._publishes.get(done.request_id);
    if (!existing)
      return {
        ok: false,
        violation: violation(
          "UNKNOWN_REQUEST_ID",
          `No publish with request ID ${done.request_id}`,
          this._phase,
          message.type,
        ),
      };
    this._publishes.set(done.request_id, { ...existing, phase: "done" });
    sideEffects.push({
      type: "publish-ended",
      requestId: done.request_id,
      reason: done.reason_phrase,
    });
    return { ok: true, phase: this._phase, sideEffects };
  }

  private handleFetch(
    message: Draft16Message,
    sideEffects: SideEffect[],
  ): TransitionResult<Draft16MessageType> {
    const err = this.requireReady(message.type);
    if (err) return { ok: false, violation: err };
    const fetch = message as import("./types.js").Draft16Fetch;
    const dupErr = this.checkDuplicateRequestId(fetch.request_id, message.type);
    if (dupErr) return { ok: false, violation: dupErr };
    this._requestIds.add(fetch.request_id);
    this._fetches.set(fetch.request_id, { requestId: fetch.request_id, phase: "pending" });
    return { ok: true, phase: this._phase, sideEffects };
  }

  private handleFetchOk(
    message: Draft16Message,
    sideEffects: SideEffect[],
  ): TransitionResult<Draft16MessageType> {
    const err = this.requireReady(message.type);
    if (err) return { ok: false, violation: err };
    const ok = message as import("./types.js").Draft16FetchOk;
    const idErr = this.checkKnownRequestId(ok.request_id, message.type);
    if (idErr) return { ok: false, violation: idErr };
    const existing = this._fetches.get(ok.request_id);
    if (!existing)
      return {
        ok: false,
        violation: violation(
          "UNKNOWN_REQUEST_ID",
          `No fetch with request ID ${ok.request_id}`,
          this._phase,
          message.type,
        ),
      };
    if (existing.phase !== "pending")
      return {
        ok: false,
        violation: violation(
          "STATE_VIOLATION",
          `Fetch ${ok.request_id} is ${existing.phase}, not pending`,
          this._phase,
          message.type,
        ),
      };
    this._fetches.set(ok.request_id, { ...existing, phase: "active" });
    sideEffects.push({ type: "fetch-activated", requestId: ok.request_id });
    return { ok: true, phase: this._phase, sideEffects };
  }

  private handleFetchCancel(
    message: Draft16Message,
    sideEffects: SideEffect[],
  ): TransitionResult<Draft16MessageType> {
    const err = this.requireReady(message.type);
    if (err) return { ok: false, violation: err };
    const cancel = message as import("./types.js").Draft16FetchCancel;
    const idErr = this.checkKnownRequestId(cancel.request_id, message.type);
    if (idErr) return { ok: false, violation: idErr };
    const existing = this._fetches.get(cancel.request_id);
    if (!existing)
      return {
        ok: false,
        violation: violation(
          "UNKNOWN_REQUEST_ID",
          `No fetch with request ID ${cancel.request_id}`,
          this._phase,
          message.type,
        ),
      };
    this._fetches.set(cancel.request_id, { ...existing, phase: "cancelled" });
    sideEffects.push({ type: "fetch-ended", requestId: cancel.request_id, reason: "cancelled" });
    return { ok: true, phase: this._phase, sideEffects };
  }

  private handleRequestError(
    message: Draft16Message,
    sideEffects: SideEffect[],
  ): TransitionResult<Draft16MessageType> {
    const err = this.requireReady(message.type);
    if (err) return { ok: false, violation: err };
    const reqErr = message as import("./types.js").Draft16RequestError;
    const sub = this._subscriptions.get(reqErr.request_id);
    if (sub && sub.phase === "pending") {
      this._subscriptions.set(reqErr.request_id, { ...sub, phase: "error" });
      sideEffects.push({
        type: "subscription-ended",
        subscribeId: reqErr.request_id,
        reason: reqErr.reason_phrase,
      });
      return { ok: true, phase: this._phase, sideEffects };
    }
    const pub = this._publishes.get(reqErr.request_id);
    if (pub && pub.phase === "pending") {
      this._publishes.set(reqErr.request_id, { ...pub, phase: "error" });
      sideEffects.push({
        type: "publish-ended",
        requestId: reqErr.request_id,
        reason: reqErr.reason_phrase,
      });
      return { ok: true, phase: this._phase, sideEffects };
    }
    const fetch = this._fetches.get(reqErr.request_id);
    if (fetch && fetch.phase === "pending") {
      this._fetches.set(reqErr.request_id, { ...fetch, phase: "error" });
      sideEffects.push({
        type: "fetch-ended",
        requestId: reqErr.request_id,
        reason: reqErr.reason_phrase,
      });
      return { ok: true, phase: this._phase, sideEffects };
    }
    return { ok: true, phase: this._phase, sideEffects };
  }

  private handleRequestOk(
    message: Draft16Message,
    sideEffects: SideEffect[],
  ): TransitionResult<Draft16MessageType> {
    const err = this.requireReady(message.type);
    if (err) return { ok: false, violation: err };
    return { ok: true, phase: this._phase, sideEffects };
  }

  // ─── Namespace and track status request ID tracking ───

  private handlePublishNamespace(
    message: Draft16Message,
    sideEffects: SideEffect[],
  ): TransitionResult<Draft16MessageType> {
    const err = this.requireReady(message.type);
    if (err) return { ok: false, violation: err };
    const pn = message as import("./types.js").Draft16PublishNamespace;
    const dupErr = this.checkDuplicateRequestId(pn.request_id, message.type);
    if (dupErr) return { ok: false, violation: dupErr };
    this._requestIds.add(pn.request_id);
    return { ok: true, phase: this._phase, sideEffects };
  }

  private handleSubscribeNamespace(
    message: Draft16Message,
    sideEffects: SideEffect[],
  ): TransitionResult<Draft16MessageType> {
    const err = this.requireReady(message.type);
    if (err) return { ok: false, violation: err };
    const sn = message as import("./types.js").Draft16SubscribeNamespace;
    const dupErr = this.checkDuplicateRequestId(sn.request_id, message.type);
    if (dupErr) return { ok: false, violation: dupErr };
    this._requestIds.add(sn.request_id);
    return { ok: true, phase: this._phase, sideEffects };
  }

  private handleTrackStatus(
    message: Draft16Message,
    sideEffects: SideEffect[],
  ): TransitionResult<Draft16MessageType> {
    const err = this.requireReady(message.type);
    if (err) return { ok: false, violation: err };
    const ts = message as import("./types.js").Draft16TrackStatus;
    const dupErr = this.checkDuplicateRequestId(ts.request_id, message.type);
    if (dupErr) return { ok: false, violation: dupErr };
    this._requestIds.add(ts.request_id);
    return { ok: true, phase: this._phase, sideEffects };
  }

  private handleReadyPhaseMessage(message: Draft16Message): TransitionResult<Draft16MessageType> {
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
