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
import { getLegalIncoming, getLegalOutgoing } from './rules.js'
import type {
  Draft20FillParameters,
  Draft20Message,
  Draft20MessageType,
  Draft20Params,
} from './types.js'

/**
 * What kind of request a bidirectional request stream carries.
 *
 * draft-20 keeps the draft-17 shape where a response is tied to its request by
 * the stream it arrives on rather than by a Request ID field. Several draft-20
 * rules are stated per request *kind* — most sharply
 * "PUBLISH_STATE_NOTIFY applies only to subscriptions ... An endpoint that
 * receives a PUBLISH_STATE_NOTIFY for any other request type ... MUST close
 * the session with a PROTOCOL_VIOLATION" (Section 10.10) — so the FSM has to
 * know which stream a message arrived on to enforce them. That is what
 * {@link Draft20SessionFSM.receiveOn} and {@link Draft20SessionFSM.sendOn} are
 * for.
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
 * One fill fetch stream — draft-20 Section 5.1.3, new in draft-20.
 *
 * A unidirectional stream that begins with FETCH_HEADER and is delivered
 * exactly as a FETCH response, opened because a SUBSCRIBE or REQUEST_UPDATE
 * carried FILL_PARAMETERS. It is NOT a FETCH: there is no FETCH request, no
 * FETCH_OK and no REQUEST_ERROR for it, so it never appears in
 * {@link Draft20SessionFSM.fetches}.
 */
export interface FillFetchStreamState {
  /**
   * The Request ID of the message that opened it — the SUBSCRIBE's for the
   * initial fill, the REQUEST_UPDATE's for a later one (Section 5.1.3). This
   * is what the stream's FETCH_HEADER carries, and it is how a subscription's
   * concurrent fills are told apart.
   */
  readonly requestId: bigint
  /** The Request ID of the subscription the fill belongs to. */
  readonly subscribeId: bigint
  readonly phase: FillFetchStreamPhase
}

/** Draft-20 subscription bookkeeping beyond the draft-agnostic SubscriptionState. */
interface SubscriptionMeta {
  publisherSide: PublisherSide
  /**
   * Forward State, Section 5.1 / Section 10.2.18. Defaults to 1; FORWARD=0
   * turns delivery off. It gates fill fetch streams — see
   * {@link Draft20SessionFSM.applyFillParameters}.
   */
  forwardState: 0 | 1
  /**
   * Every fill fetch stream this subscription has, keyed by the Request ID
   * that opened it. Plural on purpose: Section 5.1.3 says "a subscription can
   * have multiple fill fetch streams open at once, each identified by its
   * Request ID; opening a new fill fetch stream does not implicitly cancel any
   * previously opened fill fetch streams." Any model that keeps one fetch
   * stream per subscription is wrong for draft-20.
   */
  fills: Map<bigint, FillFetchStreamState>
}

/** Per-request-stream state that is not specific to subscriptions. */
interface RequestMeta {
  readonly kind: RequestKind
  readonly publisherSide: PublisherSide
  /**
   * REQUEST_UPDATEs sent on this stream and not yet answered by a REQUEST_OK
   * or REQUEST_ERROR (Section 10.3.1.7). PUBLISH_STATE_NOTIFY deliberately
   * does not touch this counter.
   */
  outstandingUpdates: number
}

function violation(
  code: ProtocolViolation<Draft20MessageType>['code'],
  message: string,
  currentPhase: SessionPhase,
  offendingMessage: Draft20MessageType,
): ProtocolViolation<Draft20MessageType> {
  return { code, message, currentPhase, offendingMessage }
}

function hasFillParameters(params: Draft20Params | undefined): Draft20FillParameters | undefined {
  return params?.fill_parameters
}

export class Draft20SessionFSM {
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
  private _pendingFetches: bigint[] = []
  /**
   * The peer's MAX_REQUEST_UPDATES (Setup Option 0x08), learned from its SETUP.
   * 0 means the peer does not limit REQUEST_UPDATE concurrency, and 0 is also
   * the default when the option is absent.
   */
  private _peerMaxRequestUpdates = 0n
  /** The local endpoint's own advertised MAX_REQUEST_UPDATES. */
  private _localMaxRequestUpdates = 0n

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

  get legalOutgoing(): ReadonlySet<Draft20MessageType> {
    return getLegalOutgoing(this._phase, this._role)
  }

  get legalIncoming(): ReadonlySet<Draft20MessageType> {
    return getLegalIncoming(this._phase, this._role)
  }

  /**
   * Every fill fetch stream currently tracked, across all subscriptions, keyed
   * by the Request ID that opened it.
   *
   * Fill fetch streams are unidirectional and carry no control messages, so
   * nothing here is inferred from a message alone; the transport events that
   * end one are reported with {@link closeFillFetchStream}.
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

  /** A subscription's current Forward State, or undefined if it is unknown here. */
  forwardStateOf(subscribeId: bigint): 0 | 1 | undefined {
    return this._subscriptionMeta.get(subscribeId)?.forwardState
  }

  /** What kind of request a Request ID names, or undefined if it names none. */
  requestKindOf(requestId: bigint): RequestKind | undefined {
    return this._requests.get(requestId)?.kind
  }

  private checkDuplicateRequestId(
    requestId: bigint,
    msgType: Draft20MessageType,
  ): ProtocolViolation<Draft20MessageType> | null {
    if (this._requestIds.has(requestId)) {
      return violation(
        'DUPLICATE_REQUEST_ID',
        `Request ID ${requestId} already in use`,
        this._phase,
        msgType,
      )
    }
    return null
  }

  validateOutgoing(message: Draft20Message): ValidationResult<Draft20MessageType> {
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

  receive(message: Draft20Message): TransitionResult<Draft20MessageType> {
    return this.applyTransition(message, 'inbound', undefined)
  }

  send(message: Draft20Message): TransitionResult<Draft20MessageType> {
    return this.applyTransition(message, 'outbound', undefined)
  }

  /**
   * Receive a message that arrived on a known request stream.
   *
   * Prefer this over {@link receive} for anything that carries no Request ID of
   * its own — SUBSCRIBE_OK, REQUEST_OK, REQUEST_ERROR, PUBLISH_DONE, FETCH_OK
   * and PUBLISH_STATE_NOTIFY. Without the stream, the request-kind and
   * direction rules of Section 10.10 cannot be checked at all, and the
   * response-matching below falls back to FIFO guessing.
   */
  receiveOn(requestId: bigint, message: Draft20Message): TransitionResult<Draft20MessageType> {
    return this.applyTransition(message, 'inbound', requestId)
  }

  /** Send a message on a known request stream. See {@link receiveOn}. */
  sendOn(requestId: bigint, message: Draft20Message): TransitionResult<Draft20MessageType> {
    return this.applyTransition(message, 'outbound', requestId)
  }

  private applyTransition(
    message: Draft20Message,
    direction: 'inbound' | 'outbound',
    streamRequestId: bigint | undefined,
  ): TransitionResult<Draft20MessageType> {
    const sideEffects: SideEffect[] = []

    switch (message.type) {
      case 'setup':
        return this.handleSetup(message, direction)
      case 'goaway':
        return this.handleGoAway(message, sideEffects)

      case 'subscribe':
        return this.handleSubscribe(message, direction, sideEffects)
      case 'subscribe_ok':
        return this.handleSubscribeOk(streamRequestId, sideEffects)
      case 'request_update':
        return this.handleRequestUpdate(message, direction, streamRequestId, sideEffects)
      case 'publish_state_notify':
        return this.handlePublishStateNotify(direction, streamRequestId, sideEffects)

      case 'publish':
        return this.handlePublish(message, direction, sideEffects)
      case 'publish_done':
        return this.handlePublishDone(streamRequestId, sideEffects)

      case 'fetch':
        return this.handleFetch(message, direction, sideEffects)
      case 'fetch_ok':
        return this.handleFetchOk(streamRequestId, sideEffects)

      case 'request_ok':
        return this.handleRequestOk(streamRequestId, sideEffects)
      case 'request_error':
        return this.handleRequestError(streamRequestId, sideEffects)

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
    message: Draft20Message,
    direction: 'inbound' | 'outbound',
  ): TransitionResult<Draft20MessageType> {
    const setup = message as import('./types.js').Draft20Setup
    // Section 10.3.1.7: absent, MAX_REQUEST_UPDATES defaults to 0, which means
    // the endpoint does not limit REQUEST_UPDATE concurrency.
    const advertised = setup.options.max_request_updates ?? 0n
    if (direction === 'inbound') this._peerMaxRequestUpdates = advertised
    else this._localMaxRequestUpdates = advertised

    if (this._phase === 'idle') {
      this._setupDirection = direction
      this._phase = 'setup'
      return { ok: true, phase: this._phase, sideEffects: [] }
    }
    if (this._phase === 'setup') {
      if (direction === this._setupDirection) {
        return {
          ok: false,
          violation: violation(
            'SETUP_VIOLATION',
            `Second SETUP must be ${this._setupDirection === 'inbound' ? 'outbound' : 'inbound'}, got ${direction}`,
            this._phase,
            'setup',
          ),
        }
      }
      this._phase = 'ready'
      return {
        ok: true,
        phase: this._phase,
        sideEffects: [{ type: 'session-ready' }],
      }
    }
    return {
      ok: false,
      violation: violation(
        'SETUP_VIOLATION',
        'SETUP not valid in current phase',
        this._phase,
        'setup',
      ),
    }
  }

  private handleGoAway(
    message: Draft20Message,
    sideEffects: SideEffect[],
  ): TransitionResult<Draft20MessageType> {
    if (this._phase !== 'ready' && this._phase !== 'draining') {
      return {
        ok: false,
        violation: violation(
          'UNEXPECTED_MESSAGE',
          `GOAWAY not valid in phase ${this._phase}`,
          this._phase,
          'goaway',
        ),
      }
    }
    this._phase = 'draining'
    const goaway = message as import('./types.js').Draft20GoAway
    sideEffects.push({
      type: 'session-draining',
      goAwayUri: goaway.new_session_uri,
    })
    return { ok: true, phase: this._phase, sideEffects }
  }

  private requireReady(msgType: Draft20MessageType): ProtocolViolation<Draft20MessageType> | null {
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

  private handleSubscribe(
    message: Draft20Message,
    direction: 'inbound' | 'outbound',
    sideEffects: SideEffect[],
  ): TransitionResult<Draft20MessageType> {
    const err = this.requireReady(message.type)
    if (err) return { ok: false, violation: err }
    const sub = message as import('./types.js').Draft20Subscribe
    const dupErr = this.checkDuplicateRequestId(sub.request_id, message.type)
    if (dupErr) return { ok: false, violation: dupErr }
    this._requestIds.add(sub.request_id)
    // The sender of SUBSCRIBE is the subscriber, so the peer is the publisher.
    const publisherSide: PublisherSide = direction === 'outbound' ? 'remote' : 'local'
    this._subscriptions.set(sub.request_id, {
      subscribeId: sub.request_id,
      phase: 'pending',
      trackNamespace: sub.track_namespace,
      trackName: sub.track_name,
    })
    // FORWARD defaults to 1 (Section 10.2.18).
    const forwardState: 0 | 1 = sub.parameters.forward === 0n ? 0 : 1
    this._subscriptionMeta.set(sub.request_id, {
      publisherSide,
      forwardState,
      fills: new Map(),
    })
    this._requests.set(sub.request_id, {
      kind: 'subscription',
      publisherSide,
      outstandingUpdates: 0,
    })
    this._pendingSubscribes.push(sub.request_id)

    this.applyFillParameters(sub.request_id, sub.request_id, sub.parameters, sideEffects)
    return { ok: true, phase: this._phase, sideEffects }
  }

  /**
   * Open a fill fetch stream if this message asked for one — draft-20 Sections
   * 5.1.3 and 5.1.3.1, both new in draft-20.
   *
   * Three rules, all of which the draft states as bullets and all of which are
   * easy to get wrong by analogy with draft-19's Joining FETCH:
   *
   *  1. Presence of FILL_PARAMETERS is the request. There is no separate
   *     message and no Fetch Type; an empty FILL_PARAMETERS still opens a
   *     stream, with every setting inherited from the subscription.
   *  2. It only opens one "while Forward State is 1". FILL_PARAMETERS carried
   *     while Forward State is 0 opens nothing, and later transitioning to
   *     Forward State 1 without re-sending FILL_PARAMETERS opens nothing
   *     either — so this is checked at the moment the message is processed and
   *     never retried.
   *  3. Streams accumulate. The new one is keyed by the opening message's
   *     Request ID and does not disturb any stream already open on the same
   *     subscription.
   *
   * The opened stream has no FETCH_OK: per DECISIONS.md D7 (SPEC-DELTA Section
   * 11 Q9) there is no End Location and no End Of Track for a fill, and stream
   * FIN is the only completion signal. Nothing here synthesizes one, and the
   * stream is deliberately absent from {@link fetches}.
   */
  private applyFillParameters(
    subscribeId: bigint,
    openingRequestId: bigint,
    params: Draft20Params,
    sideEffects: SideEffect[],
  ): void {
    if (hasFillParameters(params) === undefined) return
    const meta = this._subscriptionMeta.get(subscribeId)
    if (meta === undefined) return
    if (meta.forwardState !== 1) return
    meta.fills.set(openingRequestId, {
      requestId: openingRequestId,
      subscribeId,
      phase: 'open',
    })
    sideEffects.push({
      type: 'fill-fetch-stream-opened',
      subscribeId,
      requestId: openingRequestId,
    })
  }

  /**
   * Report the transport event that ended a fill fetch stream.
   *
   * A fill fetch stream carries no control message of its own, so its end is
   * never inferable from the message sequence:
   *
   *  - `'complete'` — the publisher FINed the stream. Section 5.1.3.1 makes
   *    that the ONLY completion signal; there is no FETCH_OK to read an End
   *    Location or an End Of Track flag from (DECISIONS.md D7 / Q9).
   *  - `'reset'` — the publisher reset it, which is how a fill failure is
   *    signalled, "because there is no REQUEST_ERROR associated with a fill
   *    fetch stream".
   *  - `'cancelled'` — the subscriber sent STOP_SENDING.
   *
   * Either way "Resetting or cancelling a fill fetch stream, by either
   * endpoint, does not affect the subscription, which continues to deliver
   * objects using subscribe subgroups and datagrams", so the subscription's
   * own state is untouched here.
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

  private handleSubscribeOk(
    streamRequestId: bigint | undefined,
    sideEffects: SideEffect[],
  ): TransitionResult<Draft20MessageType> {
    const err = this.requireReady('subscribe_ok')
    if (err) return { ok: false, violation: err }
    const requestId = streamRequestId ?? this._pendingSubscribes.shift()
    if (requestId === undefined) {
      return {
        ok: false,
        violation: violation(
          'UNEXPECTED_MESSAGE',
          'SUBSCRIBE_OK with no pending subscribe',
          this._phase,
          'subscribe_ok',
        ),
      }
    }
    if (streamRequestId !== undefined) {
      this.dropPending(this._pendingSubscribes, streamRequestId)
    }
    const existing = this._subscriptions.get(requestId)
    if (existing && existing.phase === 'pending') {
      this._subscriptions.set(requestId, { ...existing, phase: 'active' })
      sideEffects.push({
        type: 'subscription-activated',
        subscribeId: requestId,
      })
    }
    return { ok: true, phase: this._phase, sideEffects }
  }

  private handleRequestUpdate(
    message: Draft20Message,
    direction: 'inbound' | 'outbound',
    streamRequestId: bigint | undefined,
    sideEffects: SideEffect[],
  ): TransitionResult<Draft20MessageType> {
    const err = this.requireReady(message.type)
    if (err) return { ok: false, violation: err }
    const update = message as import('./types.js').Draft20RequestUpdate
    const dupErr = this.checkDuplicateRequestId(update.request_id, message.type)
    if (dupErr) return { ok: false, violation: dupErr }
    this._requestIds.add(update.request_id)

    // The stream the REQUEST_UPDATE travels on is the request it updates. It
    // carries its own Request ID too, but that ID names the update, not the
    // request being updated (Section 10.1), so a caller that does not pass the
    // stream cannot be told which subscription this touches.
    const targetId = streamRequestId
    const target = targetId !== undefined ? this._requests.get(targetId) : undefined

    if (target !== undefined) {
      // Section 10.3.1.7: "If an endpoint receives a REQUEST_UPDATE on a stream
      // that already has MAX_REQUEST_UPDATES outstanding REQUEST_UPDATEs, it
      // MUST close the session with TOO_MANY_REQUEST_UPDATES." The limit that
      // applies is the receiver's advertised one.
      const limit =
        direction === 'inbound' ? this._localMaxRequestUpdates : this._peerMaxRequestUpdates
      if (limit > 0n && BigInt(target.outstandingUpdates) >= limit) {
        return {
          ok: false,
          violation: violation(
            'STATE_VIOLATION',
            `REQUEST_UPDATE on request ${targetId} exceeds MAX_REQUEST_UPDATES (${limit})`,
            this._phase,
            'request_update',
          ),
        }
      }
      target.outstandingUpdates += 1
    }

    if (targetId !== undefined && target !== undefined) {
      if (target.kind !== 'subscription') {
        // Section 10.2.15: FILL_PARAMETERS "MAY appear in a SUBSCRIBE or
        // REQUEST_UPDATE (for a subscription) message". The codec cannot check
        // the parenthetical — a REQUEST_UPDATE looks the same whichever request
        // it updates — so the scope rule of Section 10.2.1 lands here, where
        // the request stream says what kind of request this is.
        if (hasFillParameters(update.parameters) !== undefined) {
          return {
            ok: false,
            violation: violation(
              'STATE_VIOLATION',
              `FILL_PARAMETERS may only appear in a REQUEST_UPDATE for a subscription, but request ${targetId} is a ${target.kind}`,
              this._phase,
              'request_update',
            ),
          }
        }
      } else {
        const meta = this._subscriptionMeta.get(targetId)
        if (meta !== undefined) {
          // Sticky parameters (Section 10.9): an omitted parameter keeps its
          // value, so Forward State only moves when FORWARD is actually present.
          if (update.parameters.forward !== undefined) {
            meta.forwardState = update.parameters.forward === 0n ? 0 : 1
          }
          // Section 5.1.3.1: "A REQUEST_UPDATE that does not carry
          // FILL_PARAMETERS does not open a new fill fetch stream." When it does
          // carry them, the new stream is keyed by the REQUEST_UPDATE's own
          // Request ID and joins whatever is already open on this subscription.
          this.applyFillParameters(targetId, update.request_id, update.parameters, sideEffects)
        }
      }
    }

    return { ok: true, phase: this._phase, sideEffects }
  }

  /**
   * PUBLISH_STATE_NOTIFY — draft-20 Section 10.10, new in draft-20.
   *
   * Three properties set it apart from every other control message, and all
   * three are enforced here:
   *
   *  - **Unilateral.** "The receiver does not respond with REQUEST_OK or
   *    REQUEST_ERROR", so nothing is queued as pending and nothing is
   *    dequeued. A REQUEST_OK arriving later belongs to some other request.
   *  - **Not rate-limited.** "The message is not subject to the
   *    MAX_REQUEST_UPDATES limit", so `outstandingUpdates` is deliberately not
   *    touched — that counter exists only for REQUEST_UPDATE.
   *  - **Publisher to subscriber, subscriptions only.** "An endpoint that
   *    receives a PUBLISH_STATE_NOTIFY for any other request type, or from the
   *    subscriber, MUST close the session with a PROTOCOL_VIOLATION."
   *
   * The last one needs the request stream, because the message has no Request
   * ID field. Called through {@link receive}/{@link send} without one, the
   * kind and direction rules cannot be evaluated and the message is allowed
   * through unchecked rather than guessed at.
   */
  private handlePublishStateNotify(
    direction: 'inbound' | 'outbound',
    streamRequestId: bigint | undefined,
    sideEffects: SideEffect[],
  ): TransitionResult<Draft20MessageType> {
    const err = this.requireReady('publish_state_notify')
    if (err) return { ok: false, violation: err }

    if (streamRequestId === undefined) {
      // No stream, no verdict. See receiveOn().
      return { ok: true, phase: this._phase, sideEffects }
    }

    const request = this._requests.get(streamRequestId)
    if (request === undefined) {
      return {
        ok: false,
        violation: violation(
          'UNKNOWN_REQUEST_ID',
          `PUBLISH_STATE_NOTIFY on unknown request ${streamRequestId}`,
          this._phase,
          'publish_state_notify',
        ),
      }
    }
    if (request.kind !== 'subscription') {
      return {
        ok: false,
        violation: violation(
          'STATE_VIOLATION',
          `PUBLISH_STATE_NOTIFY applies only to subscriptions, but request ${streamRequestId} is a ${request.kind}`,
          this._phase,
          'publish_state_notify',
        ),
      }
    }
    const fromPublisher =
      direction === 'outbound'
        ? request.publisherSide === 'local'
        : request.publisherSide === 'remote'
    if (!fromPublisher) {
      return {
        ok: false,
        violation: violation(
          'ROLE_VIOLATION',
          `PUBLISH_STATE_NOTIFY is sent only by the publisher; request ${streamRequestId} has the publisher on the other side`,
          this._phase,
          'publish_state_notify',
        ),
      }
    }

    sideEffects.push({ type: 'subscription-state-notified', subscribeId: streamRequestId })
    return { ok: true, phase: this._phase, sideEffects }
  }

  private handlePublish(
    message: Draft20Message,
    direction: 'inbound' | 'outbound',
    sideEffects: SideEffect[],
  ): TransitionResult<Draft20MessageType> {
    const err = this.requireReady(message.type)
    if (err) return { ok: false, violation: err }
    const pub = message as import('./types.js').Draft20Publish
    const dupErr = this.checkDuplicateRequestId(pub.request_id, message.type)
    if (dupErr) return { ok: false, violation: dupErr }
    this._requestIds.add(pub.request_id)
    // The sender of PUBLISH is the publisher.
    const publisherSide: PublisherSide = direction === 'outbound' ? 'local' : 'remote'
    this._publishes.set(pub.request_id, {
      requestId: pub.request_id,
      phase: 'pending',
    })
    // A PUBLISH initiates a subscription (Section 10.11), so it is a
    // subscription request stream for the purposes of Section 10.10, and it
    // now carries the initial Subscription Parameters that draft-19 put on
    // PUBLISH_OK.
    this._subscriptions.set(pub.request_id, {
      subscribeId: pub.request_id,
      phase: 'pending',
      trackNamespace: pub.track_namespace,
      trackName: pub.track_name,
    })
    this._subscriptionMeta.set(pub.request_id, {
      publisherSide,
      forwardState: pub.parameters.forward === 0n ? 0 : 1,
      fills: new Map(),
    })
    this._requests.set(pub.request_id, {
      kind: 'subscription',
      publisherSide,
      outstandingUpdates: 0,
    })
    this._pendingPublishes.push(pub.request_id)
    return { ok: true, phase: this._phase, sideEffects }
  }

  private handlePublishDone(
    streamRequestId: bigint | undefined,
    sideEffects: SideEffect[],
  ): TransitionResult<Draft20MessageType> {
    const err = this.requireReady('publish_done')
    if (err) return { ok: false, violation: err }

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
    // Section 5.1.3.1: "When the subscription is cancelled, the publisher MUST
    // reset any open fill fetch streams." They also count toward
    // PUBLISH_DONE.Stream Count (Section 10.12), so a receiver reconciling that
    // count has to have them in view.
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
    message: Draft20Message,
    direction: 'inbound' | 'outbound',
    sideEffects: SideEffect[],
  ): TransitionResult<Draft20MessageType> {
    const err = this.requireReady(message.type)
    if (err) return { ok: false, violation: err }
    const fetch = message as import('./types.js').Draft20Fetch
    const dupErr = this.checkDuplicateRequestId(fetch.request_id, message.type)
    if (dupErr) return { ok: false, violation: dupErr }
    this._requestIds.add(fetch.request_id)
    // draft-20 has no Joining FETCH: a FETCH names its own track inline and
    // never references another request (Section 10.13). Nothing to resolve
    // against an existing subscription, and no INVALID_JOINING_REQUEST_ID to
    // raise — the error code went with the feature.
    this._fetches.set(fetch.request_id, {
      requestId: fetch.request_id,
      phase: 'pending',
    })
    this._requests.set(fetch.request_id, {
      kind: 'fetch',
      // The receiver of a FETCH serves it, so the peer publishes the objects.
      publisherSide: direction === 'outbound' ? 'remote' : 'local',
      outstandingUpdates: 0,
    })
    this._pendingFetches.push(fetch.request_id)
    return { ok: true, phase: this._phase, sideEffects }
  }

  private handleFetchOk(
    streamRequestId: bigint | undefined,
    sideEffects: SideEffect[],
  ): TransitionResult<Draft20MessageType> {
    const err = this.requireReady('fetch_ok')
    if (err) return { ok: false, violation: err }
    const requestId = streamRequestId ?? this._pendingFetches.shift()
    if (requestId === undefined) {
      return {
        ok: false,
        violation: violation(
          'UNEXPECTED_MESSAGE',
          'FETCH_OK with no pending fetch',
          this._phase,
          'fetch_ok',
        ),
      }
    }
    if (streamRequestId !== undefined) {
      // A FETCH_OK can only answer a FETCH. A fill fetch stream is a FETCH
      // response without a FETCH request, so it has no FETCH_OK at all
      // (DECISIONS.md D7 / SPEC-DELTA Section 11 Q9) — its Request ID names a
      // SUBSCRIBE or REQUEST_UPDATE, and one turning up here means the peer
      // synthesized a FETCH_OK for a fill.
      const kind = this._requests.get(requestId)?.kind
      if (kind !== undefined && kind !== 'fetch') {
        return {
          ok: false,
          violation: violation(
            'STATE_VIOLATION',
            `FETCH_OK on request ${requestId}, which is a ${kind}; a fill fetch stream has no FETCH_OK`,
            this._phase,
            'fetch_ok',
          ),
        }
      }
      this.dropPending(this._pendingFetches, requestId)
    }
    const existing = this._fetches.get(requestId)
    if (existing && existing.phase === 'pending') {
      this._fetches.set(requestId, { ...existing, phase: 'active' })
      sideEffects.push({ type: 'fetch-activated', requestId })
    }
    return { ok: true, phase: this._phase, sideEffects }
  }

  private handleRequestError(
    streamRequestId: bigint | undefined,
    sideEffects: SideEffect[],
  ): TransitionResult<Draft20MessageType> {
    const err = this.requireReady('request_error')
    if (err) return { ok: false, violation: err }

    if (streamRequestId !== undefined) {
      this.restoreUpdateCredit(streamRequestId)
      const sub = this._subscriptions.get(streamRequestId)
      if (sub !== undefined && sub.phase === 'pending') {
        this._subscriptions.set(streamRequestId, { ...sub, phase: 'error' })
        this.dropPending(this._pendingSubscribes, streamRequestId)
        sideEffects.push({
          type: 'subscription-ended',
          subscribeId: streamRequestId,
          reason: 'request_error',
        })
      }
      const pub = this._publishes.get(streamRequestId)
      if (pub !== undefined && pub.phase === 'pending') {
        this._publishes.set(streamRequestId, { ...pub, phase: 'error' })
        this.dropPending(this._pendingPublishes, streamRequestId)
        sideEffects.push({
          type: 'publish-ended',
          requestId: streamRequestId,
          reason: 'request_error',
        })
      }
      const f = this._fetches.get(streamRequestId)
      if (f !== undefined && f.phase === 'pending') {
        this._fetches.set(streamRequestId, { ...f, phase: 'error' })
        this.dropPending(this._pendingFetches, streamRequestId)
        sideEffects.push({
          type: 'fetch-ended',
          requestId: streamRequestId,
          reason: 'request_error',
        })
      }
      return { ok: true, phase: this._phase, sideEffects }
    }

    // No stream: REQUEST_ERROR can target any pending request — FIFO dequeue.
    const subId = this.dequeuePending(this._pendingSubscribes, this._subscriptions)
    if (subId !== undefined) {
      const sub = this._subscriptions.get(subId)!
      this._subscriptions.set(subId, { ...sub, phase: 'error' })
      sideEffects.push({
        type: 'subscription-ended',
        subscribeId: subId,
        reason: 'request_error',
      })
      return { ok: true, phase: this._phase, sideEffects }
    }
    const pubId = this.dequeuePending(this._pendingPublishes, this._publishes)
    if (pubId !== undefined) {
      const pub = this._publishes.get(pubId)!
      this._publishes.set(pubId, { ...pub, phase: 'error' })
      sideEffects.push({
        type: 'publish-ended',
        requestId: pubId,
        reason: 'request_error',
      })
      return { ok: true, phase: this._phase, sideEffects }
    }
    const fetchId = this.dequeuePending(this._pendingFetches, this._fetches)
    if (fetchId !== undefined) {
      const f = this._fetches.get(fetchId)!
      this._fetches.set(fetchId, { ...f, phase: 'error' })
      sideEffects.push({
        type: 'fetch-ended',
        requestId: fetchId,
        reason: 'request_error',
      })
      return { ok: true, phase: this._phase, sideEffects }
    }
    // Could be for subscribe_namespace, subscribe_tracks, publish_namespace or
    // track_status — allow through.
    return { ok: true, phase: this._phase, sideEffects }
  }

  private handleRequestOk(
    streamRequestId: bigint | undefined,
    sideEffects: SideEffect[],
  ): TransitionResult<Draft20MessageType> {
    const err = this.requireReady('request_ok')
    if (err) return { ok: false, violation: err }

    if (streamRequestId !== undefined) {
      // Each REQUEST_OK restores one MAX_REQUEST_UPDATES credit on the stream
      // (Section 10.3.1.7).
      this.restoreUpdateCredit(streamRequestId)
      const pub = this._publishes.get(streamRequestId)
      if (pub !== undefined && pub.phase === 'pending') {
        // PUBLISH_OK. In draft-20 it can no longer carry subscription
        // parameters; a subscriber that wants to change one sends a
        // REQUEST_UPDATE after this. Only EXPIRES still names PUBLISH_OK.
        this._publishes.set(streamRequestId, { ...pub, phase: 'active' })
        this.dropPending(this._pendingPublishes, streamRequestId)
        sideEffects.push({ type: 'publish-activated', requestId: streamRequestId })
        const sub = this._subscriptions.get(streamRequestId)
        if (sub !== undefined && sub.phase === 'pending') {
          this._subscriptions.set(streamRequestId, { ...sub, phase: 'active' })
          sideEffects.push({ type: 'subscription-activated', subscribeId: streamRequestId })
        }
      }
      return { ok: true, phase: this._phase, sideEffects }
    }

    // REQUEST_OK is the unified response (also the PUBLISH_OK alias) — try FIFO
    // dequeue. Falls through for namespace-scoped requests.
    const pubId = this.dequeuePending(this._pendingPublishes, this._publishes)
    if (pubId !== undefined) {
      const pub = this._publishes.get(pubId)!
      this._publishes.set(pubId, { ...pub, phase: 'active' })
      sideEffects.push({ type: 'publish-activated', requestId: pubId })
    }
    return { ok: true, phase: this._phase, sideEffects }
  }

  private handleGenericRequest(
    message: Draft20Message,
    kind: RequestKind,
    direction: 'inbound' | 'outbound',
    sideEffects: SideEffect[],
  ): TransitionResult<Draft20MessageType> {
    const err = this.requireReady(message.type)
    if (err) return { ok: false, violation: err }
    const requestId = (message as { request_id?: bigint }).request_id
    if (requestId === undefined) return { ok: true, phase: this._phase, sideEffects }
    const dupErr = this.checkDuplicateRequestId(requestId, message.type)
    if (dupErr) return { ok: false, violation: dupErr }
    this._requestIds.add(requestId)
    this._requests.set(requestId, {
      kind,
      // Only subscriptions have a publisher in the Section 10.10 sense; the
      // value is recorded for symmetry and never consulted for these kinds.
      publisherSide: direction === 'outbound' ? 'remote' : 'local',
      outstandingUpdates: 0,
    })
    return { ok: true, phase: this._phase, sideEffects }
  }

  private restoreUpdateCredit(requestId: bigint): void {
    const request = this._requests.get(requestId)
    if (request !== undefined && request.outstandingUpdates > 0) {
      request.outstandingUpdates -= 1
    }
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
      const id = queue[0]!
      const state = stateMap.get(id)
      if (state && state.phase === 'pending') {
        queue.shift()
        return id
      }
      // Skip non-pending entries (already resolved by type-specific handler)
      queue.shift()
    }
    return undefined
  }

  private handleReadyPhaseMessage(message: Draft20Message): TransitionResult<Draft20MessageType> {
    const err = this.requireReady(message.type)
    if (err) return { ok: false, violation: err }
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
    this._pendingFetches.length = 0
    this._peerMaxRequestUpdates = 0n
    this._localMaxRequestUpdates = 0n
  }
}
