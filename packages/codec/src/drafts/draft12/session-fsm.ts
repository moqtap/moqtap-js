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
import type { Draft12Message, Draft12MessageType } from "./types.js";

function violation(
  code: ProtocolViolation<Draft12MessageType>["code"],
  message: string,
  currentPhase: SessionPhase,
  offendingMessage: Draft12MessageType,
): ProtocolViolation<Draft12MessageType> {
  return { code, message, currentPhase, offendingMessage };
}

export class Draft12SessionFSM {
  private _phase: SessionPhase = "idle";
  private _role: "client" | "server";
  private _subscriptions = new Map<bigint, SubscriptionState>();
  private _announces = new Map<string, AnnounceState>();
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
    return this._announces;
  }
  get fetches(): ReadonlyMap<bigint, FetchState> {
    return this._fetches;
  }

  get legalOutgoing(): ReadonlySet<Draft12MessageType> {
    return getLegalOutgoing(this._phase, this._role);
  }

  get legalIncoming(): ReadonlySet<Draft12MessageType> {
    return getLegalIncoming(this._phase, this._role);
  }

  private checkRole(
    message: Draft12Message,
    direction: "inbound" | "outbound",
  ): ProtocolViolation<Draft12MessageType> | null {
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
    msgType: Draft12MessageType,
  ): ProtocolViolation<Draft12MessageType> | null {
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
    msgType: Draft12MessageType,
  ): ProtocolViolation<Draft12MessageType> | null {
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

  validateOutgoing(message: Draft12Message): ValidationResult<Draft12MessageType> {
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

  receive(message: Draft12Message): TransitionResult<Draft12MessageType> {
    const roleViolation = this.checkRole(message, "inbound");
    if (roleViolation) return { ok: false, violation: roleViolation };
    return this.applyTransition(message, "inbound");
  }

  send(message: Draft12Message): TransitionResult<Draft12MessageType> {
    const roleViolation = this.checkRole(message, "outbound");
    if (roleViolation) return { ok: false, violation: roleViolation };
    return this.applyTransition(message, "outbound");
  }

  private applyTransition(
    message: Draft12Message,
    direction: "inbound" | "outbound",
  ): TransitionResult<Draft12MessageType> {
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

      // Publish lifecycle
      case "publish":
        return this.handlePublish(message, sideEffects);
      case "publish_ok":
        return this.handlePublishOk(message, sideEffects);
      case "publish_error":
        return this.handlePublishError(message, sideEffects);

      // Fetch lifecycle
      case "fetch":
        return this.handleFetch(message, sideEffects);
      case "fetch_ok":
        return this.handleFetchOk(message, sideEffects);
      case "fetch_error":
        return this.handleFetchError(message, sideEffects);
      case "fetch_cancel":
        return this.handleFetchCancel(message, sideEffects);

      // Subscribe announces lifecycle
      case "subscribe_announces":
        return this.handleSubscribeAnnounces(message, sideEffects);
      case "subscribe_announces_ok":
        return this.handleSubscribeAnnouncesOk(message, sideEffects);
      case "subscribe_announces_error":
        return this.handleSubscribeAnnouncesError(message, sideEffects);

      // Track status lifecycle
      case "track_status_request":
        return this.handleTrackStatusRequest(message, sideEffects);
      case "track_status":
        return this.handleTrackStatusResponse(message, sideEffects);

      // Other ready-phase messages
      default:
        return this.handleReadyPhaseMessage(message);
    }
  }

  private handleClientSetup(
    direction: "inbound" | "outbound",
  ): TransitionResult<Draft12MessageType> {
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
  ): TransitionResult<Draft12MessageType> {
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
    message: Draft12Message,
    sideEffects: SideEffect[],
  ): TransitionResult<Draft12MessageType> {
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
    const goaway = message as import("./types.js").Draft12GoAway;
    sideEffects.push({ type: "session-draining", goAwayUri: goaway.new_session_uri });
    return { ok: true, phase: this._phase, sideEffects };
  }

  private requireReady(msgType: Draft12MessageType): ProtocolViolation<Draft12MessageType> | null {
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
    message: Draft12Message,
    sideEffects: SideEffect[],
  ): TransitionResult<Draft12MessageType> {
    const err = this.requireReady(message.type);
    if (err) return { ok: false, violation: err };
    const sub = message as import("./types.js").Draft12Subscribe;
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
    message: Draft12Message,
    sideEffects: SideEffect[],
  ): TransitionResult<Draft12MessageType> {
    const err = this.requireReady(message.type);
    if (err) return { ok: false, violation: err };
    const ok = message as import("./types.js").Draft12SubscribeOk;
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

  private handleSubscribeError(
    message: Draft12Message,
    sideEffects: SideEffect[],
  ): TransitionResult<Draft12MessageType> {
    const err = this.requireReady(message.type);
    if (err) return { ok: false, violation: err };
    const subErr = message as import("./types.js").Draft12SubscribeError;
    const idErr = this.checkKnownRequestId(subErr.request_id, message.type);
    if (idErr) return { ok: false, violation: idErr };
    const existing = this._subscriptions.get(subErr.request_id);
    if (!existing)
      return {
        ok: false,
        violation: violation(
          "UNKNOWN_REQUEST_ID",
          `No subscription with request ID ${subErr.request_id}`,
          this._phase,
          message.type,
        ),
      };
    if (existing.phase !== "pending")
      return {
        ok: false,
        violation: violation(
          "STATE_VIOLATION",
          `Subscription ${subErr.request_id} is ${existing.phase}, not pending`,
          this._phase,
          message.type,
        ),
      };
    this._subscriptions.set(subErr.request_id, { ...existing, phase: "error" });
    sideEffects.push({
      type: "subscription-ended",
      subscribeId: subErr.request_id,
      reason: subErr.reason_phrase,
    });
    return { ok: true, phase: this._phase, sideEffects };
  }

  private handleSubscribeUpdate(
    message: Draft12Message,
    sideEffects: SideEffect[],
  ): TransitionResult<Draft12MessageType> {
    const err = this.requireReady(message.type);
    if (err) return { ok: false, violation: err };
    const update = message as import("./types.js").Draft12SubscribeUpdate;
    const idErr = this.checkKnownRequestId(update.request_id, message.type);
    if (idErr) return { ok: false, violation: idErr };
    const existing = this._subscriptions.get(update.request_id);
    if (!existing)
      return {
        ok: false,
        violation: violation(
          "UNKNOWN_REQUEST_ID",
          `No subscription with request ID ${update.request_id}`,
          this._phase,
          message.type,
        ),
      };
    if (existing.phase !== "active")
      return {
        ok: false,
        violation: violation(
          "STATE_VIOLATION",
          `Subscription ${update.request_id} is ${existing.phase}, not active`,
          this._phase,
          message.type,
        ),
      };
    return { ok: true, phase: this._phase, sideEffects };
  }

  private handleSubscribeDone(
    message: Draft12Message,
    sideEffects: SideEffect[],
  ): TransitionResult<Draft12MessageType> {
    const err = this.requireReady(message.type);
    if (err) return { ok: false, violation: err };
    const done = message as import("./types.js").Draft12SubscribeDone;
    const idErr = this.checkKnownRequestId(done.request_id, message.type);
    if (idErr) return { ok: false, violation: idErr };
    const existing = this._subscriptions.get(done.request_id);
    if (!existing)
      return {
        ok: false,
        violation: violation(
          "UNKNOWN_REQUEST_ID",
          `No subscription with request ID ${done.request_id}`,
          this._phase,
          message.type,
        ),
      };
    this._subscriptions.set(done.request_id, { ...existing, phase: "done" });
    sideEffects.push({
      type: "subscription-ended",
      subscribeId: done.request_id,
      reason: done.reason_phrase,
    });
    return { ok: true, phase: this._phase, sideEffects };
  }

  private handleUnsubscribe(
    message: Draft12Message,
    sideEffects: SideEffect[],
  ): TransitionResult<Draft12MessageType> {
    const err = this.requireReady(message.type);
    if (err) return { ok: false, violation: err };
    const unsub = message as import("./types.js").Draft12Unsubscribe;
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

  // ─── Announce lifecycle ───

  private handleAnnounce(
    message: Draft12Message,
    sideEffects: SideEffect[],
  ): TransitionResult<Draft12MessageType> {
    const err = this.requireReady(message.type);
    if (err) return { ok: false, violation: err };
    const ann = message as import("./types.js").Draft12Announce;
    const nsKey = ann.track_namespace.join("/");
    this._requestIds.add(ann.request_id);
    this._announces.set(nsKey, { namespace: ann.track_namespace, phase: "pending" });
    return { ok: true, phase: this._phase, sideEffects };
  }

  private handleAnnounceOk(
    message: Draft12Message,
    sideEffects: SideEffect[],
  ): TransitionResult<Draft12MessageType> {
    const err = this.requireReady(message.type);
    if (err) return { ok: false, violation: err };
    const ok = message as import("./types.js").Draft12AnnounceOk;
    const idErr = this.checkKnownRequestId(ok.request_id, message.type);
    if (idErr) return { ok: false, violation: idErr };
    return { ok: true, phase: this._phase, sideEffects };
  }

  private handleAnnounceError(
    message: Draft12Message,
    sideEffects: SideEffect[],
  ): TransitionResult<Draft12MessageType> {
    const err = this.requireReady(message.type);
    if (err) return { ok: false, violation: err };
    const annErr = message as import("./types.js").Draft12AnnounceError;
    const idErr = this.checkKnownRequestId(annErr.request_id, message.type);
    if (idErr) return { ok: false, violation: idErr };
    return { ok: true, phase: this._phase, sideEffects };
  }

  private handleUnannounce(
    message: Draft12Message,
    sideEffects: SideEffect[],
  ): TransitionResult<Draft12MessageType> {
    const err = this.requireReady(message.type);
    if (err) return { ok: false, violation: err };
    const unann = message as import("./types.js").Draft12Unannounce;
    const nsKey = unann.track_namespace.join("/");
    const existing = this._announces.get(nsKey);
    if (existing) {
      this._announces.delete(nsKey);
      sideEffects.push({ type: "announce-ended", namespace: unann.track_namespace });
    }
    return { ok: true, phase: this._phase, sideEffects };
  }

  private handleAnnounceCancel(
    message: Draft12Message,
    sideEffects: SideEffect[],
  ): TransitionResult<Draft12MessageType> {
    const err = this.requireReady(message.type);
    if (err) return { ok: false, violation: err };
    const cancel = message as import("./types.js").Draft12AnnounceCancel;
    const nsKey = cancel.track_namespace.join("/");
    const existing = this._announces.get(nsKey);
    if (existing) {
      this._announces.delete(nsKey);
      sideEffects.push({ type: "announce-ended", namespace: cancel.track_namespace });
    }
    return { ok: true, phase: this._phase, sideEffects };
  }

  // ─── Publish lifecycle ───

  private handlePublish(
    message: Draft12Message,
    sideEffects: SideEffect[],
  ): TransitionResult<Draft12MessageType> {
    const err = this.requireReady(message.type);
    if (err) return { ok: false, violation: err };
    const pub = message as import("./types.js").Draft12Publish;
    const dupErr = this.checkDuplicateRequestId(pub.request_id, message.type);
    if (dupErr) return { ok: false, violation: dupErr };
    this._requestIds.add(pub.request_id);
    return { ok: true, phase: this._phase, sideEffects };
  }

  private handlePublishOk(
    message: Draft12Message,
    sideEffects: SideEffect[],
  ): TransitionResult<Draft12MessageType> {
    const err = this.requireReady(message.type);
    if (err) return { ok: false, violation: err };
    const ok = message as import("./types.js").Draft12PublishOk;
    const idErr = this.checkKnownRequestId(ok.request_id, message.type);
    if (idErr) return { ok: false, violation: idErr };
    return { ok: true, phase: this._phase, sideEffects };
  }

  private handlePublishError(
    message: Draft12Message,
    sideEffects: SideEffect[],
  ): TransitionResult<Draft12MessageType> {
    const err = this.requireReady(message.type);
    if (err) return { ok: false, violation: err };
    const pubErr = message as import("./types.js").Draft12PublishError;
    const idErr = this.checkKnownRequestId(pubErr.request_id, message.type);
    if (idErr) return { ok: false, violation: idErr };
    return { ok: true, phase: this._phase, sideEffects };
  }

  // ─── Fetch lifecycle ───

  private handleFetch(
    message: Draft12Message,
    sideEffects: SideEffect[],
  ): TransitionResult<Draft12MessageType> {
    const err = this.requireReady(message.type);
    if (err) return { ok: false, violation: err };
    const fetch = message as import("./types.js").Draft12Fetch;
    const dupErr = this.checkDuplicateRequestId(fetch.request_id, message.type);
    if (dupErr) return { ok: false, violation: dupErr };
    this._requestIds.add(fetch.request_id);
    this._fetches.set(fetch.request_id, { requestId: fetch.request_id, phase: "pending" });
    return { ok: true, phase: this._phase, sideEffects };
  }

  private handleFetchOk(
    message: Draft12Message,
    sideEffects: SideEffect[],
  ): TransitionResult<Draft12MessageType> {
    const err = this.requireReady(message.type);
    if (err) return { ok: false, violation: err };
    const ok = message as import("./types.js").Draft12FetchOk;
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

  private handleFetchError(
    message: Draft12Message,
    sideEffects: SideEffect[],
  ): TransitionResult<Draft12MessageType> {
    const err = this.requireReady(message.type);
    if (err) return { ok: false, violation: err };
    const fetchErr = message as import("./types.js").Draft12FetchError;
    const idErr = this.checkKnownRequestId(fetchErr.request_id, message.type);
    if (idErr) return { ok: false, violation: idErr };
    const existing = this._fetches.get(fetchErr.request_id);
    if (!existing)
      return {
        ok: false,
        violation: violation(
          "UNKNOWN_REQUEST_ID",
          `No fetch with request ID ${fetchErr.request_id}`,
          this._phase,
          message.type,
        ),
      };
    this._fetches.set(fetchErr.request_id, { ...existing, phase: "error" });
    sideEffects.push({
      type: "fetch-ended",
      requestId: fetchErr.request_id,
      reason: fetchErr.reason_phrase,
    });
    return { ok: true, phase: this._phase, sideEffects };
  }

  private handleFetchCancel(
    message: Draft12Message,
    sideEffects: SideEffect[],
  ): TransitionResult<Draft12MessageType> {
    const err = this.requireReady(message.type);
    if (err) return { ok: false, violation: err };
    const cancel = message as import("./types.js").Draft12FetchCancel;
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

  // ─── Subscribe announces lifecycle ───

  private handleSubscribeAnnounces(
    message: Draft12Message,
    sideEffects: SideEffect[],
  ): TransitionResult<Draft12MessageType> {
    const err = this.requireReady(message.type);
    if (err) return { ok: false, violation: err };
    const sa = message as import("./types.js").Draft12SubscribeAnnounces;
    const dupErr = this.checkDuplicateRequestId(sa.request_id, message.type);
    if (dupErr) return { ok: false, violation: dupErr };
    this._requestIds.add(sa.request_id);
    return { ok: true, phase: this._phase, sideEffects };
  }

  private handleSubscribeAnnouncesOk(
    message: Draft12Message,
    sideEffects: SideEffect[],
  ): TransitionResult<Draft12MessageType> {
    const err = this.requireReady(message.type);
    if (err) return { ok: false, violation: err };
    const ok = message as import("./types.js").Draft12SubscribeAnnouncesOk;
    const idErr = this.checkKnownRequestId(ok.request_id, message.type);
    if (idErr) return { ok: false, violation: idErr };
    return { ok: true, phase: this._phase, sideEffects };
  }

  private handleSubscribeAnnouncesError(
    message: Draft12Message,
    sideEffects: SideEffect[],
  ): TransitionResult<Draft12MessageType> {
    const err = this.requireReady(message.type);
    if (err) return { ok: false, violation: err };
    const saErr = message as import("./types.js").Draft12SubscribeAnnouncesError;
    const idErr = this.checkKnownRequestId(saErr.request_id, message.type);
    if (idErr) return { ok: false, violation: idErr };
    return { ok: true, phase: this._phase, sideEffects };
  }

  // ─── Track status lifecycle ───

  private handleTrackStatusRequest(
    message: Draft12Message,
    sideEffects: SideEffect[],
  ): TransitionResult<Draft12MessageType> {
    const err = this.requireReady(message.type);
    if (err) return { ok: false, violation: err };
    const tsr = message as import("./types.js").Draft12TrackStatusRequest;
    const dupErr = this.checkDuplicateRequestId(tsr.request_id, message.type);
    if (dupErr) return { ok: false, violation: dupErr };
    this._requestIds.add(tsr.request_id);
    return { ok: true, phase: this._phase, sideEffects };
  }

  private handleTrackStatusResponse(
    message: Draft12Message,
    sideEffects: SideEffect[],
  ): TransitionResult<Draft12MessageType> {
    const err = this.requireReady(message.type);
    if (err) return { ok: false, violation: err };
    const ts = message as import("./types.js").Draft12TrackStatus;
    const idErr = this.checkKnownRequestId(ts.request_id, message.type);
    if (idErr) return { ok: false, violation: idErr };
    return { ok: true, phase: this._phase, sideEffects };
  }

  // ─── Generic ready-phase handler ───

  private handleReadyPhaseMessage(message: Draft12Message): TransitionResult<Draft12MessageType> {
    const err = this.requireReady(message.type);
    if (err) return { ok: false, violation: err };
    return { ok: true, phase: this._phase, sideEffects: [] };
  }

  reset(): void {
    this._phase = "idle";
    this._subscriptions.clear();
    this._announces.clear();
    this._fetches.clear();
    this._requestIds.clear();
  }
}
