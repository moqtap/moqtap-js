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
} from '../../core/session-types.js'
import { SessionTerminationCode as Close, RequestErrorCode } from './error-codes.js'
import { DEFAULT_MAX_CONTROL_MESSAGE_SIZE } from './messages.js'
import {
  checkRequestOk,
  checkRequestUpdate,
  getLegalIncoming,
  getLegalOutgoing,
  type RequestOkKind,
  type RuleViolation,
} from './rules.js'
import type {
  Draft23Fetch,
  Draft23FillParameters,
  Draft23GoAway,
  Draft23Message,
  Draft23MessageType,
  Draft23Params,
  Draft23Publish,
  Draft23RequestError,
  Draft23RequestOk,
  Draft23RequestUpdate,
  Draft23Setup,
  Draft23Subscribe,
} from './types.js'

/**
 * What kind of request a bidirectional request stream carries. A response is
 * tied to its request by the stream it arrives on, not by a field, and several
 * draft-23 rules are stated per kind, so the state machine has to be told the
 * stream: see {@link Draft23SessionFSM.receiveOn} and
 * {@link Draft23SessionFSM.sendOn}.
 */
export type RequestKind =
  | 'subscription'
  | 'fetch'
  | 'track_status'
  | 'publish_namespace'
  | 'subscribe_namespace'
  | 'subscribe_tracks'

/** Whether the local endpoint or the peer is the publisher on a request stream. */
export type PublisherSide = 'local' | 'remote'

export type FillFetchStreamPhase = 'open' | 'complete' | 'reset' | 'cancelled'

/**
 * One fill fetch stream, draft-23 Section 3.4: a unidirectional stream that
 * begins with FETCH_HEADER and is delivered as a FETCH response, opened because
 * a SUBSCRIBE, PUBLISH or REQUEST_UPDATE carried FILL_PARAMETERS. It is not a
 * FETCH: there is no FETCH request, no FETCH_OK and no REQUEST_ERROR for it, so
 * it never appears in {@link Draft23SessionFSM.fetches}.
 */
export interface FillFetchStreamState {
  /**
   * The Request ID the stream's FETCH_HEADER carries. Section 3.4: "the
   * subscription's Request ID for an initial fill, or the REQUEST_UPDATE
   * Request ID for a subsequent fill".
   */
  readonly requestId: bigint
  /** The Request ID of the subscription the fill belongs to. */
  readonly subscribeId: bigint
  readonly phase: FillFetchStreamPhase
}

type Side = 'local' | 'remote'

function other(side: Side): Side {
  return side === 'local' ? 'remote' : 'local'
}

/** Draft-23 subscription bookkeeping beyond the draft-agnostic SubscriptionState. */
interface SubscriptionMeta {
  publisherSide: PublisherSide
  /**
   * Whether the subscription is paused (Section 3.1.1): PAUSED
   * (Section 9.19.18) 1 pauses it and 0 resumes it. "If the parameter is omitted from
   * any other message, the default value is 0." It gates fill fetch streams.
   */
  pausedState: 0 | 1
  /**
   * Every fill fetch stream of this subscription, keyed by the Request ID that
   * opened it. Section 3.4: "a subscription can have multiple fill fetch
   * streams open at once, each identified by its Request ID".
   */
  fills: Map<bigint, FillFetchStreamState>
}

/** Per-request-stream state. */
interface RequestMeta {
  readonly kind: RequestKind
  /** The message that opened the stream. */
  readonly opener: Draft23MessageType
  /** Which endpoint sent the request. */
  readonly senderSide: Side
  readonly publisherSide: PublisherSide
  /** The first response (an OK or REQUEST_ERROR) has been seen. */
  answered: boolean
  /**
   * REQUEST_UPDATE Request IDs not yet answered, oldest first, by the side that
   * sent them. Section 9.5: "REQUEST_UPDATE_OKs MUST be returned in the order
   * the REQUEST_UPDATEs were received."
   */
  readonly updates: Record<Side, bigint[]>
  /** A GOAWAY has been seen on this stream. */
  goaway: boolean
  /** A FETCH's LOCATION_FILTER type, for the Section 3.2 relative-filter rule. */
  readonly locationFilterType?: bigint
}

function violation(
  code: ProtocolViolation<Draft23MessageType>['code'],
  message: string,
  currentPhase: SessionPhase,
  offendingMessage: Draft23MessageType,
  closeCode?: bigint,
): ProtocolViolation<Draft23MessageType> {
  return closeCode === undefined
    ? { code, message, currentPhase, offendingMessage }
    : { code, message, currentPhase, offendingMessage, closeCode }
}

function fail(v: ProtocolViolation<Draft23MessageType>): TransitionResult<Draft23MessageType> {
  return { ok: false, violation: v }
}

function hasFillParameters(params: Draft23Params | undefined): Draft23FillParameters | undefined {
  return params?.fill_parameters
}

/** The response name an initial REQUEST_OK carries for each opener (Section 1.5). */
const INITIAL_REQUEST_OK: Partial<Record<Draft23MessageType, RequestOkKind>> = {
  publish: 'publish_ok',
  fetch: 'fetch_ok',
  track_status: 'track_status_ok',
  subscribe_namespace: 'subscribe_namespace_ok',
  subscribe_tracks: 'subscribe_tracks_ok',
  publish_namespace: 'publish_namespace_ok',
}

/**
 * Section 9.4.2.1: "Track Name is not meaningful for namespace-scoped requests
 * (SUBSCRIBE_NAMESPACE, PUBLISH_NAMESPACE, SUBSCRIBE_TRACKS) and MUST be
 * empty".
 */
const NAMESPACE_SCOPED: ReadonlySet<RequestKind> = new Set([
  'subscribe_namespace',
  'publish_namespace',
  'subscribe_tracks',
])

export class Draft23SessionFSM {
  private _phase: SessionPhase = 'idle'
  private _role: 'client' | 'server'
  private _setupDirection: 'inbound' | 'outbound' | null = null
  private _subscriptions = new Map<bigint, SubscriptionState>()
  private _subscriptionMeta = new Map<bigint, SubscriptionMeta>()
  private _publishes = new Map<bigint, PublishState>()
  private _fetches = new Map<bigint, FetchState>()
  private _requests = new Map<bigint, RequestMeta>()
  private _requestIds = new Set<bigint>()
  private _pendingSubscribes: bigint[] = []
  private _pendingPublishes: bigint[] = []
  /** GOAWAYs seen on the control stream, by the side that sent them. */
  private _controlGoaways: Record<Side, number> = { local: 0, remote: 0 }
  /**
   * The peer's MAX_REQUEST_UPDATES (Setup Option 0x08), from its SETUP. 0 means
   * no limit, and 0 is also the default when the option is absent.
   */
  private _peerMaxRequestUpdates = 0n
  /** The local endpoint's own advertised MAX_REQUEST_UPDATES. */
  private _localMaxRequestUpdates = 0n
  private _peerMaxControlMessageSize = DEFAULT_MAX_CONTROL_MESSAGE_SIZE
  private _localMaxControlMessageSize = DEFAULT_MAX_CONTROL_MESSAGE_SIZE

  constructor(role: 'client' | 'server') {
    this._role = role
  }

  get phase(): SessionPhase {
    return this._phase
  }
  get role(): 'client' | 'server' {
    return this._role
  }
  get subscriptions(): ReadonlyMap<bigint, SubscriptionState> {
    return this._subscriptions
  }
  get announces(): ReadonlyMap<string, AnnounceState> {
    return new Map()
  }
  get publishes(): ReadonlyMap<bigint, PublishState> {
    return this._publishes
  }
  get fetches(): ReadonlyMap<bigint, FetchState> {
    return this._fetches
  }

  get legalOutgoing(): ReadonlySet<Draft23MessageType> {
    return getLegalOutgoing(this._phase, this._role)
  }

  get legalIncoming(): ReadonlySet<Draft23MessageType> {
    return getLegalIncoming(this._phase, this._role)
  }

  /**
   * The limit on the control messages this endpoint may send: the peer's
   * MAX_CONTROL_MESSAGE_SIZE. draft-23 Section 9.1.8: "Until an endpoint
   * receives the peer's SETUP, it uses the default value, including for SETUP
   * itself." Pass it to `encodeMessage` as `maxControlMessageSize`.
   */
  get peerMaxControlMessageSize(): bigint {
    return this._peerMaxControlMessageSize
  }

  /**
   * The limit on the control messages this endpoint receives: its own
   * advertised MAX_CONTROL_MESSAGE_SIZE, from the SETUP it sent, or 65535. Pass
   * it to `decodeMessage` as `maxControlMessageSize`.
   */
  get localMaxControlMessageSize(): bigint {
    return this._localMaxControlMessageSize
  }

  /**
   * Every fill fetch stream currently tracked, across all subscriptions, keyed
   * by the Request ID that opened it. Fill fetch streams carry no control
   * messages, so the transport events that end one are reported with
   * {@link closeFillFetchStream}.
   */
  get fillFetchStreams(): ReadonlyMap<bigint, FillFetchStreamState> {
    const all = new Map<bigint, FillFetchStreamState>()
    for (const meta of this._subscriptionMeta.values()) {
      for (const [requestId, fill] of meta.fills) all.set(requestId, fill)
    }
    return all
  }

  /** The fill fetch streams belonging to one subscription. */
  fillFetchStreamsFor(subscribeId: bigint): ReadonlyMap<bigint, FillFetchStreamState> {
    return this._subscriptionMeta.get(subscribeId)?.fills ?? new Map()
  }

  /** Whether a subscription is paused (1) or not (0), or undefined if it is unknown here. */
  pausedStateOf(subscribeId: bigint): 0 | 1 | undefined {
    return this._subscriptionMeta.get(subscribeId)?.pausedState
  }

  /** What kind of request a Request ID names, or undefined if it names none. */
  requestKindOf(requestId: bigint): RequestKind | undefined {
    return this._requests.get(requestId)?.kind
  }

  /**
   * draft-23 Section 6.4.2.1: "If an endpoint detects a duplicate Request ID,
   * it MUST close the session with INVALID_REQUEST_ID."
   */
  private checkDuplicateRequestId(
    requestId: bigint,
    msgType: Draft23MessageType,
  ): ProtocolViolation<Draft23MessageType> | null {
    if (this._requestIds.has(requestId)) {
      return violation(
        'DUPLICATE_REQUEST_ID',
        `Request ID ${requestId} already in use`,
        this._phase,
        msgType,
        Close.InvalidRequestId,
      )
    }
    return null
  }

  validateOutgoing(message: Draft23Message): ValidationResult<Draft23MessageType> {
    if (!this.legalOutgoing.has(message.type)) {
      return {
        ok: false,
        violation: violation(
          this._phase === 'idle' || this._phase === 'setup'
            ? 'MESSAGE_BEFORE_SETUP'
            : 'UNEXPECTED_MESSAGE',
          `Cannot send ${message.type} in phase ${this._phase}`,
          this._phase,
          message.type,
        ),
      }
    }
    return { ok: true }
  }

  receive(message: Draft23Message): TransitionResult<Draft23MessageType> {
    return this.applyTransition(message, 'inbound', undefined)
  }

  send(message: Draft23Message): TransitionResult<Draft23MessageType> {
    return this.applyTransition(message, 'outbound', undefined)
  }

  /**
   * Receive a message that arrived on a known request stream.
   *
   * Prefer this over {@link receive} for anything that carries no Request ID of
   * its own: SUBSCRIBE_OK, REQUEST_OK, REQUEST_ERROR, PUBLISH_DONE,
   * PUBLISH_STATE_NOTIFY, a REQUEST_UPDATE and a request-stream GOAWAY. A
   * REQUEST_OK names no request at all, so only the stream says whether it is a
   * FETCH_OK, a PUBLISH_OK or a REQUEST_UPDATE_OK; without one, the per-kind
   * rules below are not checked.
   */
  receiveOn(requestId: bigint, message: Draft23Message): TransitionResult<Draft23MessageType> {
    return this.applyTransition(message, 'inbound', requestId)
  }

  /** Send a message on a known request stream. See {@link receiveOn}. */
  sendOn(requestId: bigint, message: Draft23Message): TransitionResult<Draft23MessageType> {
    return this.applyTransition(message, 'outbound', requestId)
  }

  private applyTransition(
    message: Draft23Message,
    direction: 'inbound' | 'outbound',
    streamRequestId: bigint | undefined,
  ): TransitionResult<Draft23MessageType> {
    const sideEffects: SideEffect[] = []

    switch (message.type) {
      case 'setup':
        return this.handleSetup(message, direction)
      case 'goaway':
        return this.handleGoAway(message, direction, streamRequestId, sideEffects)

      case 'subscribe':
        return this.handleSubscribe(message, direction, sideEffects)
      case 'subscribe_ok':
        return this.handleSubscribeOk(streamRequestId, sideEffects)
      case 'request_update':
        return this.handleRequestUpdate(message, direction, streamRequestId, sideEffects)
      case 'publish_state_notify':
        return this.handlePublishStateNotify(message, direction, streamRequestId, sideEffects)

      case 'publish':
        return this.handlePublish(message, direction, sideEffects)
      case 'publish_done':
        return this.handlePublishDone(streamRequestId, sideEffects)

      case 'fetch':
        return this.handleFetch(message, direction, sideEffects)

      case 'request_ok':
        return this.handleRequestOk(message, direction, streamRequestId, sideEffects)
      case 'request_error':
        return this.handleRequestError(message, direction, streamRequestId, sideEffects)

      case 'track_status':
        return this.handleGenericRequest(message, 'track_status', direction, sideEffects)
      case 'publish_namespace':
        return this.handleGenericRequest(message, 'publish_namespace', direction, sideEffects)
      case 'subscribe_namespace':
        return this.handleGenericRequest(message, 'subscribe_namespace', direction, sideEffects)
      case 'subscribe_tracks':
        return this.handleGenericRequest(message, 'subscribe_tracks', direction, sideEffects)

      default:
        return this.handleReadyPhaseMessage(message)
    }
  }

  private handleSetup(
    setup: Draft23Setup,
    direction: 'inbound' | 'outbound',
  ): TransitionResult<Draft23MessageType> {
    // Section 9.1.4: "If a server receives Alias Type DELETE (0x0) or USE_ALIAS
    // (0x2) in a SETUP message, it MUST close the session with ROLE_VIOLATION."
    // At a client, SETUP is the first message, so only an alias an earlier
    // option of the same SETUP registered exists. Section 8.9: "The receiver of
    // a message referencing an Alias that is not currently registered MUST
    // reject the message with UNKNOWN_AUTH_TOKEN_ALIAS."
    const serverReceives =
      direction === 'inbound' ? this._role === 'server' : this._role === 'client'
    const registered = new Set<bigint>()
    for (const token of setup.options.authorization_token ?? []) {
      const alias = token.token_alias
      if (token.alias_type === 1n && alias !== undefined) {
        registered.add(alias)
        continue
      }
      if (token.alias_type !== 0n && token.alias_type !== 2n) continue
      if (serverReceives) {
        return fail(
          violation(
            'ROLE_VIOLATION',
            `a server may not receive Alias Type ${token.alias_type} in SETUP`,
            this._phase,
            'setup',
            Close.RoleViolation,
          ),
        )
      }
      if (alias === undefined || !registered.has(alias)) {
        return fail(
          violation(
            'STATE_VIOLATION',
            `SETUP refers to Token Alias ${alias}, which is not registered`,
            this._phase,
            'setup',
            Close.UnknownAuthTokenAlias,
          ),
        )
      }
      if (token.alias_type === 0n) registered.delete(alias)
    }

    // Section 9.1.7: absent, MAX_REQUEST_UPDATES defaults to 0, no limit.
    // Section 9.1.8: absent, MAX_CONTROL_MESSAGE_SIZE defaults to 65535.
    const updates = setup.options.max_request_updates ?? 0n
    const size = setup.options.max_control_message_size ?? DEFAULT_MAX_CONTROL_MESSAGE_SIZE
    if (direction === 'inbound') {
      this._peerMaxRequestUpdates = updates
      this._peerMaxControlMessageSize = size
    } else {
      this._localMaxRequestUpdates = updates
      this._localMaxControlMessageSize = size
    }

    if (this._phase === 'idle') {
      this._setupDirection = direction
      this._phase = 'setup'
      return { ok: true, phase: this._phase, sideEffects: [] }
    }
    if (this._phase === 'setup') {
      if (direction === this._setupDirection) {
        return fail(
          violation(
            'SETUP_VIOLATION',
            `Second SETUP must be ${this._setupDirection === 'inbound' ? 'outbound' : 'inbound'}, got ${direction}`,
            this._phase,
            'setup',
          ),
        )
      }
      this._phase = 'ready'
      return { ok: true, phase: this._phase, sideEffects: [{ type: 'session-ready' }] }
    }
    return fail(
      violation('SETUP_VIOLATION', 'SETUP not valid in current phase', this._phase, 'setup'),
    )
  }

  /**
   * GOAWAY, draft-23 Section 9.2, on the control stream or on a request stream.
   *
   *  - "If a server receives a GOAWAY with a non-zero New Session URI Length it
   *    MUST close the session with ROLE_VIOLATION."
   *  - "The endpoint MUST close the session with UNEXPECTED_MESSAGE
   *    (Section 12.2) if it receives more than one GOAWAY on the control stream or on a
   *    single request stream."
   *  - "Only the receiver of a request can send GOAWAY on its request stream.
   *    If the receiver of a request receives a GOAWAY on that request stream,
   *    it MUST close the session with a PROTOCOL_VIOLATION."
   *
   * A request-stream GOAWAY migrates that request alone; only the control
   * stream's drains the session.
   */
  private handleGoAway(
    goaway: Draft23GoAway,
    direction: 'inbound' | 'outbound',
    streamRequestId: bigint | undefined,
    sideEffects: SideEffect[],
  ): TransitionResult<Draft23MessageType> {
    if (this._phase !== 'ready' && this._phase !== 'draining') {
      return fail(
        violation(
          'UNEXPECTED_MESSAGE',
          `GOAWAY not valid in phase ${this._phase}`,
          this._phase,
          'goaway',
        ),
      )
    }
    const sender: Side = direction === 'inbound' ? 'remote' : 'local'
    const senderRole =
      sender === 'local' ? this._role : this._role === 'client' ? 'server' : 'client'
    if (senderRole === 'client' && goaway.new_session_uri.length > 0) {
      return fail(
        violation(
          'ROLE_VIOLATION',
          'a client must send a zero-length New Session URI',
          this._phase,
          'goaway',
          Close.RoleViolation,
        ),
      )
    }

    if (streamRequestId !== undefined) {
      const request = this._requests.get(streamRequestId)
      if (request === undefined) {
        return fail(
          violation(
            'UNKNOWN_REQUEST_ID',
            `GOAWAY on unknown request ${streamRequestId}`,
            this._phase,
            'goaway',
          ),
        )
      }
      if (sender === request.senderSide) {
        return fail(
          violation(
            'ROLE_VIOLATION',
            `only the receiver of request ${streamRequestId} may send GOAWAY on its stream`,
            this._phase,
            'goaway',
            Close.ProtocolViolation,
          ),
        )
      }
      if (request.goaway) {
        return fail(
          violation(
            'UNEXPECTED_MESSAGE',
            `second GOAWAY on request ${streamRequestId}`,
            this._phase,
            'goaway',
            Close.UnexpectedMessage,
          ),
        )
      }
      request.goaway = true
      return { ok: true, phase: this._phase, sideEffects }
    }

    if (this._controlGoaways[sender] > 0) {
      return fail(
        violation(
          'UNEXPECTED_MESSAGE',
          'second GOAWAY on the control stream',
          this._phase,
          'goaway',
          Close.UnexpectedMessage,
        ),
      )
    }
    this._controlGoaways[sender] += 1
    this._phase = 'draining'
    sideEffects.push({ type: 'session-draining', goAwayUri: goaway.new_session_uri })
    return { ok: true, phase: this._phase, sideEffects }
  }

  private requireReady(msgType: Draft23MessageType): ProtocolViolation<Draft23MessageType> | null {
    if (this._phase !== 'ready' && this._phase !== 'draining') {
      return violation(
        this._phase === 'idle' || this._phase === 'setup'
          ? 'MESSAGE_BEFORE_SETUP'
          : 'UNEXPECTED_MESSAGE',
        `${msgType} requires ready phase, current: ${this._phase}`,
        this._phase,
        msgType,
      )
    }
    return null
  }

  private openRequest(
    requestId: bigint,
    kind: RequestKind,
    opener: Draft23MessageType,
    direction: 'inbound' | 'outbound',
    publisherSide: PublisherSide,
    locationFilterType?: bigint,
  ): void {
    this._requestIds.add(requestId)
    const meta: RequestMeta = {
      kind,
      opener,
      senderSide: direction === 'outbound' ? 'local' : 'remote',
      publisherSide,
      answered: false,
      updates: { local: [], remote: [] },
      goaway: false,
      ...(locationFilterType !== undefined ? { locationFilterType } : {}),
    }
    this._requests.set(requestId, meta)
  }

  private handleSubscribe(
    sub: Draft23Subscribe,
    direction: 'inbound' | 'outbound',
    sideEffects: SideEffect[],
  ): TransitionResult<Draft23MessageType> {
    const err =
      this.requireReady(sub.type) ?? this.checkDuplicateRequestId(sub.request_id, sub.type)
    if (err) return fail(err)
    // The sender of SUBSCRIBE is the subscriber, so the peer is the publisher.
    const publisherSide: PublisherSide = direction === 'outbound' ? 'remote' : 'local'
    this.openRequest(sub.request_id, 'subscription', 'subscribe', direction, publisherSide)
    this._subscriptions.set(sub.request_id, {
      subscribeId: sub.request_id,
      phase: 'pending',
      trackNamespace: sub.track_namespace,
      trackName: sub.track_name,
    })
    this._subscriptionMeta.set(sub.request_id, {
      publisherSide,
      pausedState: sub.parameters.paused === 1n ? 1 : 0,
      fills: new Map(),
    })
    this._pendingSubscribes.push(sub.request_id)

    this.applyFillParameters(sub.request_id, sub.request_id, sub.parameters, sideEffects)
    return { ok: true, phase: this._phase, sideEffects }
  }

  /**
   * Open a fill fetch stream if this message asked for one.
   * draft-23 Section 3.4.1: "A publisher opens a fill fetch stream when it processes a SUBSCRIBE
   * or REQUEST_UPDATE, or sends a PUBLISH, that carries FILL_PARAMETERS while
   * the subscription is not paused (see Section 3.1.1). * FILL_PARAMETERS
   * carried while the subscription is paused opens no fill fetch stream.
   * Resuming the subscription without re-sending FILL_PARAMETERS does not open
   * one either."
   *
   * The new stream is keyed by the opening message's Request ID and leaves
   * every stream already open on the subscription alone. It has no FETCH_OK;
   * stream FIN is its only completion signal.
   */
  private applyFillParameters(
    subscribeId: bigint,
    openingRequestId: bigint,
    params: Draft23Params,
    sideEffects: SideEffect[],
  ): void {
    if (hasFillParameters(params) === undefined) return
    const meta = this._subscriptionMeta.get(subscribeId)
    if (meta === undefined) return
    if (meta.pausedState !== 0) return
    meta.fills.set(openingRequestId, { requestId: openingRequestId, subscribeId, phase: 'open' })
    sideEffects.push({ type: 'fill-fetch-stream-opened', subscribeId, requestId: openingRequestId })
  }

  /**
   * Report the transport event that ended a fill fetch stream: `'complete'`
   * for a FIN, `'reset'` for the publisher's reset ("the publisher signals a
   * fill failure by resetting the stream"), `'cancelled'` for the subscriber's
   * STOP_SENDING. Section 3.4.1: "Resetting or cancelling a fill fetch stream,
   * by either endpoint, does not affect the subscription", so the
   * subscription's own state is untouched.
   */
  closeFillFetchStream(
    requestId: bigint,
    phase: Exclude<FillFetchStreamPhase, 'open'>,
  ): SideEffect[] {
    for (const meta of this._subscriptionMeta.values()) {
      const fill = meta.fills.get(requestId)
      if (fill === undefined) continue
      meta.fills.set(requestId, { ...fill, phase })
      return [
        {
          type: 'fill-fetch-stream-closed',
          subscribeId: fill.subscribeId,
          requestId,
          reason: phase,
        },
      ]
    }
    return []
  }

  /**
   * SUBSCRIBE_OK. draft-23 Section 3.1: "A publisher MUST send exactly one
   * SUBSCRIBE_OK or SUBSCRIBE_ERROR in response to a SUBSCRIBE. [...] The peer
   * SHOULD close the session with UNEXPECTED_MESSAGE if it receives more than
   * one."
   */
  private handleSubscribeOk(
    streamRequestId: bigint | undefined,
    sideEffects: SideEffect[],
  ): TransitionResult<Draft23MessageType> {
    const err = this.requireReady('subscribe_ok')
    if (err) return fail(err)
    const requestId = streamRequestId ?? this._pendingSubscribes.shift()
    if (requestId === undefined) {
      return fail(
        violation(
          'UNEXPECTED_MESSAGE',
          'SUBSCRIBE_OK with no pending subscribe',
          this._phase,
          'subscribe_ok',
        ),
      )
    }
    const request = this._requests.get(requestId)
    if (streamRequestId !== undefined && request !== undefined) {
      if (request.opener !== 'subscribe' || request.answered) {
        return fail(
          violation(
            'UNEXPECTED_MESSAGE',
            request.answered
              ? `request ${requestId} has already been answered`
              : `SUBSCRIBE_OK on request ${requestId}, which is a ${request.opener}`,
            this._phase,
            'subscribe_ok',
            Close.UnexpectedMessage,
          ),
        )
      }
      this.dropPending(this._pendingSubscribes, streamRequestId)
    }
    if (request !== undefined) request.answered = true
    const existing = this._subscriptions.get(requestId)
    if (existing && existing.phase === 'pending') {
      this._subscriptions.set(requestId, { ...existing, phase: 'active' })
      sideEffects.push({ type: 'subscription-activated', subscribeId: requestId })
    }
    return { ok: true, phase: this._phase, sideEffects }
  }

  /**
   * REQUEST_UPDATE, draft-23 Section 9.5, on the stream of the request it
   * updates (its own Request ID names the update, not the request).
   *
   *  - "The sender of a request (SUBSCRIBE, PUBLISH, FETCH, PUBLISH_NAMESPACE,
   *    SUBSCRIBE_NAMESPACE, SUBSCRIBE_TRACKS) can later send a REQUEST_UPDATE
   *    on the same bidi stream as the request to modify it. A subscriber can
   *    also send REQUEST_UPDATE to modify parameters of a subscription
   *    established with PUBLISH. An endpoint that receives a REQUEST_UPDATE
   *    other than in the two cases above MUST close the session with
   *    UNEXPECTED_MESSAGE."
   *  - Section 9.1.7: "If an endpoint receives a REQUEST_UPDATE on a stream
   *    that already has MAX_REQUEST_UPDATES outstanding REQUEST_UPDATEs, it MUST
   *    close the session with TOO_MANY_REQUEST_UPDATES." The receiver's
   *    advertised limit applies.
   *  - The per-request parameter lists, {@link checkRequestUpdate}.
   */
  private handleRequestUpdate(
    update: Draft23RequestUpdate,
    direction: 'inbound' | 'outbound',
    streamRequestId: bigint | undefined,
    sideEffects: SideEffect[],
  ): TransitionResult<Draft23MessageType> {
    const err =
      this.requireReady(update.type) ?? this.checkDuplicateRequestId(update.request_id, update.type)
    if (err) return fail(err)

    const target = streamRequestId !== undefined ? this._requests.get(streamRequestId) : undefined
    if (streamRequestId === undefined || target === undefined) {
      this._requestIds.add(update.request_id)
      return { ok: true, phase: this._phase, sideEffects }
    }

    const sender: Side = direction === 'inbound' ? 'remote' : 'local'
    const subscriberSide = other(target.publisherSide)
    const allowedSender =
      target.kind !== 'track_status' &&
      (sender === target.senderSide || (target.opener === 'publish' && sender === subscriberSide))
    if (!allowedSender) {
      return fail(
        violation(
          'UNEXPECTED_MESSAGE',
          target.kind === 'track_status'
            ? `a TRACK_STATUS request (${streamRequestId}) cannot be updated`
            : `REQUEST_UPDATE on request ${streamRequestId} from an endpoint that may not update it`,
          this._phase,
          'request_update',
          Close.UnexpectedMessage,
        ),
      )
    }

    const limit =
      direction === 'inbound' ? this._localMaxRequestUpdates : this._peerMaxRequestUpdates
    if (limit > 0n && BigInt(target.updates[sender].length) >= limit) {
      return fail(
        violation(
          'STATE_VIOLATION',
          `REQUEST_UPDATE on request ${streamRequestId} exceeds MAX_REQUEST_UPDATES (${limit})`,
          this._phase,
          'request_update',
          Close.TooManyRequestUpdates,
        ),
      )
    }

    const ruleBroken = checkRequestUpdate(
      target.kind as Exclude<RequestKind, 'track_status'>,
      update,
      sender === subscriberSide,
    )
    if (ruleBroken !== null) return this.ruleViolation(ruleBroken, 'request_update')

    this._requestIds.add(update.request_id)
    target.updates[sender].push(update.request_id)

    if (target.kind === 'subscription') {
      const meta = this._subscriptionMeta.get(streamRequestId)
      if (meta !== undefined) {
        // Section 9.19.18: "If the parameter is omitted from REQUEST_UPDATE or
        // PUBLISH_STATE_NOTIFY, the value for the subscription remains
        // unchanged."
        if (update.parameters.paused !== undefined) {
          meta.pausedState = update.parameters.paused === 1n ? 1 : 0
        }
        // Section 3.4.1: "A REQUEST_UPDATE that does not carry FILL_PARAMETERS
        // does not open a new fill fetch stream."
        this.applyFillParameters(streamRequestId, update.request_id, update.parameters, sideEffects)
      }
    }

    return { ok: true, phase: this._phase, sideEffects }
  }

  /**
   * PUBLISH_STATE_NOTIFY, draft-23 Section 9.10: unilateral ("the receiver does
   * not respond with REQUEST_OK or REQUEST_ERROR, and the message is not
   * subject to the MAX_REQUEST_UPDATES limit"), and "PUBLISH_STATE_NOTIFY
   * applies only to subscriptions, and is sent only by the publisher. An
   * endpoint that receives a PUBLISH_STATE_NOTIFY for any other request type
   * MUST close the session with UNEXPECTED_MESSAGE. A publisher that receives a
   * PUBLISH_STATE_NOTIFY MUST close the session with ROLE_VIOLATION."
   *
   * Without the stream neither rule can be checked, and the message passes.
   */
  private handlePublishStateNotify(
    message: Draft23Message & { type: 'publish_state_notify' },
    direction: 'inbound' | 'outbound',
    streamRequestId: bigint | undefined,
    sideEffects: SideEffect[],
  ): TransitionResult<Draft23MessageType> {
    const err = this.requireReady('publish_state_notify')
    if (err) return fail(err)
    if (streamRequestId === undefined) return { ok: true, phase: this._phase, sideEffects }

    const request = this._requests.get(streamRequestId)
    if (request === undefined) {
      return fail(
        violation(
          'UNKNOWN_REQUEST_ID',
          `PUBLISH_STATE_NOTIFY on unknown request ${streamRequestId}`,
          this._phase,
          'publish_state_notify',
        ),
      )
    }
    if (request.kind !== 'subscription') {
      return fail(
        violation(
          'UNEXPECTED_MESSAGE',
          `PUBLISH_STATE_NOTIFY applies only to subscriptions, but request ${streamRequestId} is a ${request.kind}`,
          this._phase,
          'publish_state_notify',
          Close.UnexpectedMessage,
        ),
      )
    }
    const sender: Side = direction === 'inbound' ? 'remote' : 'local'
    if (sender !== request.publisherSide) {
      return fail(
        violation(
          'ROLE_VIOLATION',
          `PUBLISH_STATE_NOTIFY is sent only by the publisher; request ${streamRequestId} has the publisher on the other side`,
          this._phase,
          'publish_state_notify',
          Close.RoleViolation,
        ),
      )
    }

    // Section 9.19.18: "When sent in PUBLISH_STATE_NOTIFY, it reports whether
    // the subscription is paused at the publisher."
    const meta = this._subscriptionMeta.get(streamRequestId)
    if (meta !== undefined && message.parameters.paused !== undefined) {
      meta.pausedState = message.parameters.paused === 1n ? 1 : 0
    }
    sideEffects.push({ type: 'subscription-state-notified', subscribeId: streamRequestId })
    return { ok: true, phase: this._phase, sideEffects }
  }

  private handlePublish(
    pub: Draft23Publish,
    direction: 'inbound' | 'outbound',
    sideEffects: SideEffect[],
  ): TransitionResult<Draft23MessageType> {
    const err =
      this.requireReady(pub.type) ?? this.checkDuplicateRequestId(pub.request_id, pub.type)
    if (err) return fail(err)
    // The sender of PUBLISH is the publisher, and a PUBLISH initiates a
    // subscription (Section 9.8).
    const publisherSide: PublisherSide = direction === 'outbound' ? 'local' : 'remote'
    this.openRequest(pub.request_id, 'subscription', 'publish', direction, publisherSide)
    this._publishes.set(pub.request_id, { requestId: pub.request_id, phase: 'pending' })
    this._subscriptions.set(pub.request_id, {
      subscribeId: pub.request_id,
      phase: 'pending',
      trackNamespace: pub.track_namespace,
      trackName: pub.track_name,
    })
    this._subscriptionMeta.set(pub.request_id, {
      publisherSide,
      pausedState: pub.parameters.paused === 1n ? 1 : 0,
      fills: new Map(),
    })
    this._pendingPublishes.push(pub.request_id)
    this.applyFillParameters(pub.request_id, pub.request_id, pub.parameters, sideEffects)
    return { ok: true, phase: this._phase, sideEffects }
  }

  private handlePublishDone(
    streamRequestId: bigint | undefined,
    sideEffects: SideEffect[],
  ): TransitionResult<Draft23MessageType> {
    const err = this.requireReady('publish_done')
    if (err) return fail(err)

    // PUBLISH_DONE has no Request ID; the stream it arrives on identifies the
    // subscription. Without one, fall back to the oldest active publish.
    let requestId = streamRequestId
    if (requestId === undefined) {
      for (const [reqId, pub] of this._publishes) {
        if (pub.phase === 'active') {
          requestId = reqId
          break
        }
      }
    }
    if (requestId === undefined) return { ok: true, phase: this._phase, sideEffects }

    const pub = this._publishes.get(requestId)
    if (pub !== undefined && pub.phase !== 'done') {
      this._publishes.set(requestId, { ...pub, phase: 'done' })
      sideEffects.push({ type: 'publish-ended', requestId, reason: 'done' })
    }
    const sub = this._subscriptions.get(requestId)
    if (sub !== undefined && sub.phase !== 'done') {
      this._subscriptions.set(requestId, { ...sub, phase: 'done' })
      sideEffects.push({
        type: 'subscription-ended',
        subscribeId: requestId,
        reason: 'publish_done',
      })
    }
    // Section 3.4.1: "When the subscription is cancelled, the publisher MUST
    // reset any open fill fetch streams."
    const meta = this._subscriptionMeta.get(requestId)
    if (meta !== undefined) {
      for (const [fillId, fill] of meta.fills) {
        if (fill.phase !== 'open') continue
        meta.fills.set(fillId, { ...fill, phase: 'reset' })
        sideEffects.push({
          type: 'fill-fetch-stream-closed',
          subscribeId: requestId,
          requestId: fillId,
          reason: 'subscription-ended',
        })
      }
    }
    return { ok: true, phase: this._phase, sideEffects }
  }

  private handleFetch(
    fetch: Draft23Fetch,
    direction: 'inbound' | 'outbound',
    sideEffects: SideEffect[],
  ): TransitionResult<Draft23MessageType> {
    const err =
      this.requireReady(fetch.type) ?? this.checkDuplicateRequestId(fetch.request_id, fetch.type)
    if (err) return fail(err)
    this._fetches.set(fetch.request_id, { requestId: fetch.request_id, phase: 'pending' })
    // The receiver of a FETCH serves it, so the peer publishes the objects.
    this.openRequest(
      fetch.request_id,
      'fetch',
      'fetch',
      direction,
      direction === 'outbound' ? 'remote' : 'local',
      fetch.parameters.location_filter?.filter_type,
    )
    return { ok: true, phase: this._phase, sideEffects }
  }

  /**
   * Which response a REQUEST_OK or REQUEST_ERROR on a known stream is: the
   * request's own, sent first by its receiver, or the answer to the oldest
   * REQUEST_UPDATE the other side has outstanding. `initialPossible` is false
   * for a REQUEST_OK on a SUBSCRIBE, which SUBSCRIBE_OK answers.
   */
  private classifyResponse(
    request: RequestMeta,
    responder: Side,
    initialPossible: boolean,
  ): 'initial' | 'update' | undefined {
    if (initialPossible && !request.answered && responder !== request.senderSide) {
      return 'initial'
    }
    return request.updates[other(responder)].length > 0 ? 'update' : undefined
  }

  /**
   * REQUEST_OK on a known stream is one of the responses of Section 1.5: the
   * request's own OK when it comes first from the request's receiver (for a
   * FETCH, "The publisher MUST send exactly one FETCH_OK or FETCH_ERROR in
   * response to a FETCH", Section 3.2), otherwise a REQUEST_UPDATE_OK, answering
   * the oldest outstanding REQUEST_UPDATE from the other side (Section 9.5).
   * Each is held to its own lists by {@link checkRequestOk}.
   */
  private handleRequestOk(
    message: Draft23RequestOk,
    direction: 'inbound' | 'outbound',
    streamRequestId: bigint | undefined,
    sideEffects: SideEffect[],
  ): TransitionResult<Draft23MessageType> {
    const err = this.requireReady('request_ok')
    if (err) return fail(err)

    if (streamRequestId === undefined) {
      // No stream: the oldest pending PUBLISH is the only REQUEST_OK this can
      // be matched to without guessing between request kinds.
      const pubId = this.dequeuePending(this._pendingPublishes, this._publishes)
      if (pubId !== undefined) {
        const pub = this._publishes.get(pubId)!
        this._publishes.set(pubId, { ...pub, phase: 'active' })
        sideEffects.push({ type: 'publish-activated', requestId: pubId })
      }
      return { ok: true, phase: this._phase, sideEffects }
    }

    const request = this._requests.get(streamRequestId)
    if (request === undefined) return { ok: true, phase: this._phase, sideEffects }
    const responder: Side = direction === 'inbound' ? 'remote' : 'local'
    const initialKind = INITIAL_REQUEST_OK[request.opener]
    const role = this.classifyResponse(request, responder, initialKind !== undefined)
    if (role === undefined) {
      return fail(
        violation(
          'UNEXPECTED_MESSAGE',
          `REQUEST_OK on request ${streamRequestId} answers nothing outstanding`,
          this._phase,
          'request_ok',
          Close.UnexpectedMessage,
        ),
      )
    }
    const kind: RequestOkKind =
      role === 'initial' ? (initialKind as RequestOkKind) : 'request_update_ok'

    const ruleBroken = checkRequestOk(kind, message)
    if (ruleBroken !== null) return this.ruleViolation(ruleBroken, 'request_ok')
    // Section 3.2: "If the Location filter is relative (see Section 9.19.9), the
    // publisher MUST return REQUEST_ERROR with error code INVALID_RANGE."
    // Section 9.19.9 calls Location Filter Type 0x01 the relative one.
    if (kind === 'fetch_ok' && request.locationFilterType === 1n) {
      return fail(
        violation(
          'STATE_VIOLATION',
          `FETCH ${streamRequestId} has a relative Location filter and must be answered with REQUEST_ERROR INVALID_RANGE`,
          this._phase,
          'request_ok',
        ),
      )
    }

    if (kind !== 'request_update_ok') {
      request.answered = true
      this.activateRequest(streamRequestId, sideEffects)
    } else {
      request.updates[other(responder)].shift()
    }
    return { ok: true, phase: this._phase, sideEffects }
  }

  private activateRequest(requestId: bigint, sideEffects: SideEffect[]): void {
    const pub = this._publishes.get(requestId)
    if (pub !== undefined && pub.phase === 'pending') {
      this._publishes.set(requestId, { ...pub, phase: 'active' })
      this.dropPending(this._pendingPublishes, requestId)
      sideEffects.push({ type: 'publish-activated', requestId })
      const sub = this._subscriptions.get(requestId)
      if (sub !== undefined && sub.phase === 'pending') {
        this._subscriptions.set(requestId, { ...sub, phase: 'active' })
        sideEffects.push({ type: 'subscription-activated', subscribeId: requestId })
      }
    }
    const f = this._fetches.get(requestId)
    if (f !== undefined && f.phase === 'pending') {
      this._fetches.set(requestId, { ...f, phase: 'active' })
      sideEffects.push({ type: 'fetch-activated', requestId })
    }
  }

  /**
   * REQUEST_ERROR. With a REDIRECT Error Detail, draft-23 Section 9.4.2.1: "If
   * a server receives a Redirect with a non-zero Connect URI Length it MUST
   * close the session with ROLE_VIOLATION." and "an endpoint that receives a
   * non-empty Track Name in a Redirect for a namespace-scoped request MUST
   * close the session with INVALID_FIELD."
   */
  private handleRequestError(
    message: Draft23RequestError,
    direction: 'inbound' | 'outbound',
    streamRequestId: bigint | undefined,
    sideEffects: SideEffect[],
  ): TransitionResult<Draft23MessageType> {
    const err = this.requireReady('request_error')
    if (err) return fail(err)

    // draft-23 Section 9.4.2: receivers "MUST ignore a known Error Detail type
    // that accompanies an Error Code it is not defined for", and
    // Section 9.4.2.1: the REDIRECT Error Detail "accompanies Error Code REDIRECT".
    const redirect =
      message.error_code === RequestErrorCode.Redirect ? message.error_details.redirect : undefined
    const serverReceives =
      direction === 'inbound' ? this._role === 'server' : this._role === 'client'
    if (redirect !== undefined && serverReceives && redirect.connect_uri.length > 0) {
      return fail(
        violation(
          'ROLE_VIOLATION',
          'a server may not receive a Redirect with a Connect URI',
          this._phase,
          'request_error',
          Close.RoleViolation,
        ),
      )
    }

    if (streamRequestId !== undefined) {
      const request = this._requests.get(streamRequestId)
      if (
        redirect !== undefined &&
        request !== undefined &&
        NAMESPACE_SCOPED.has(request.kind) &&
        redirect.track_name.length > 0
      ) {
        return fail(
          violation(
            'STATE_VIOLATION',
            `a Redirect for a ${request.kind} must have an empty Track Name`,
            this._phase,
            'request_error',
            Close.InvalidField,
          ),
        )
      }
      const responder: Side = direction === 'inbound' ? 'remote' : 'local'
      if (request !== undefined && this.classifyResponse(request, responder, true) === 'update') {
        // A REQUEST_UPDATE_ERROR: the request itself stands (Section 9.5.1 has
        // the publisher end it separately).
        request.updates[other(responder)].shift()
        return { ok: true, phase: this._phase, sideEffects }
      }
      if (request !== undefined) request.answered = true
      this.endRequestWithError(streamRequestId, sideEffects)
      return { ok: true, phase: this._phase, sideEffects }
    }

    // No stream: the oldest pending subscription, then publish, takes it.
    const subId = this.dequeuePending(this._pendingSubscribes, this._subscriptions)
    if (subId !== undefined) {
      this.endRequestWithError(subId, sideEffects)
      return { ok: true, phase: this._phase, sideEffects }
    }
    const pubId = this.dequeuePending(this._pendingPublishes, this._publishes)
    if (pubId !== undefined) this.endRequestWithError(pubId, sideEffects)
    return { ok: true, phase: this._phase, sideEffects }
  }

  private endRequestWithError(requestId: bigint, sideEffects: SideEffect[]): void {
    const sub = this._subscriptions.get(requestId)
    if (sub !== undefined && sub.phase === 'pending') {
      this._subscriptions.set(requestId, { ...sub, phase: 'error' })
      this.dropPending(this._pendingSubscribes, requestId)
      sideEffects.push({
        type: 'subscription-ended',
        subscribeId: requestId,
        reason: 'request_error',
      })
    }
    const pub = this._publishes.get(requestId)
    if (pub !== undefined && pub.phase === 'pending') {
      this._publishes.set(requestId, { ...pub, phase: 'error' })
      this.dropPending(this._pendingPublishes, requestId)
      sideEffects.push({ type: 'publish-ended', requestId, reason: 'request_error' })
    }
    const f = this._fetches.get(requestId)
    if (f !== undefined && f.phase === 'pending') {
      this._fetches.set(requestId, { ...f, phase: 'error' })
      sideEffects.push({ type: 'fetch-ended', requestId, reason: 'request_error' })
    }
  }

  private handleGenericRequest(
    message: Draft23Message,
    kind: RequestKind,
    direction: 'inbound' | 'outbound',
    sideEffects: SideEffect[],
  ): TransitionResult<Draft23MessageType> {
    const err = this.requireReady(message.type)
    if (err) return fail(err)
    const requestId = (message as { request_id?: bigint }).request_id
    if (requestId === undefined) return { ok: true, phase: this._phase, sideEffects }
    const dupErr = this.checkDuplicateRequestId(requestId, message.type)
    if (dupErr) return fail(dupErr)
    // Only subscriptions have a publisher in the Section 9.10 sense; the value
    // is recorded for symmetry and never consulted for these kinds.
    this.openRequest(
      requestId,
      kind,
      message.type,
      direction,
      direction === 'outbound' ? 'remote' : 'local',
    )
    return { ok: true, phase: this._phase, sideEffects }
  }

  private ruleViolation(
    rule: RuleViolation,
    msgType: Draft23MessageType,
  ): TransitionResult<Draft23MessageType> {
    return fail(violation('STATE_VIOLATION', rule.reason, this._phase, msgType, rule.closeCode))
  }

  private dropPending(queue: bigint[], requestId: bigint): void {
    const index = queue.indexOf(requestId)
    if (index >= 0) queue.splice(index, 1)
  }

  private dequeuePending(
    queue: bigint[],
    stateMap: ReadonlyMap<bigint, { phase: string }>,
  ): bigint | undefined {
    while (queue.length > 0) {
      const id = queue.shift()!
      if (stateMap.get(id)?.phase === 'pending') return id
    }
    return undefined
  }

  private handleReadyPhaseMessage(message: Draft23Message): TransitionResult<Draft23MessageType> {
    const err = this.requireReady(message.type)
    if (err) return fail(err)
    return { ok: true, phase: this._phase, sideEffects: [] }
  }

  reset(): void {
    this._phase = 'idle'
    this._setupDirection = null
    this._subscriptions.clear()
    this._subscriptionMeta.clear()
    this._publishes.clear()
    this._fetches.clear()
    this._requests.clear()
    this._requestIds.clear()
    this._pendingSubscribes.length = 0
    this._pendingPublishes.length = 0
    this._controlGoaways = { local: 0, remote: 0 }
    this._peerMaxRequestUpdates = 0n
    this._localMaxRequestUpdates = 0n
    this._peerMaxControlMessageSize = DEFAULT_MAX_CONTROL_MESSAGE_SIZE
    this._localMaxControlMessageSize = DEFAULT_MAX_CONTROL_MESSAGE_SIZE
  }
}
