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
import type { Draft17Message, Draft17MessageType } from './types.js'

function violation(
  code: ProtocolViolation<Draft17MessageType>['code'],
  message: string,
  currentPhase: SessionPhase,
  offendingMessage: Draft17MessageType,
): ProtocolViolation<Draft17MessageType> {
  return { code, message, currentPhase, offendingMessage }
}

export class Draft17SessionFSM {
  private _phase: SessionPhase = 'idle'
  private _role: 'client' | 'server'
  private _setupDirection: 'inbound' | 'outbound' | null = null
  private _subscriptions = new Map<bigint, SubscriptionState>()
  private _publishes = new Map<bigint, PublishState>()
  private _fetches = new Map<bigint, FetchState>()
  private _requestIds = new Set<bigint>()
  private _pendingSubscribes: bigint[] = []
  private _pendingPublishes: bigint[] = []
  private _pendingFetches: bigint[] = []

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

  get legalOutgoing(): ReadonlySet<Draft17MessageType> {
    return getLegalOutgoing(this._phase, this._role)
  }

  get legalIncoming(): ReadonlySet<Draft17MessageType> {
    return getLegalIncoming(this._phase, this._role)
  }

  private checkDuplicateRequestId(
    requestId: bigint,
    msgType: Draft17MessageType,
  ): ProtocolViolation<Draft17MessageType> | null {
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

  validateOutgoing(message: Draft17Message): ValidationResult<Draft17MessageType> {
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

  receive(message: Draft17Message): TransitionResult<Draft17MessageType> {
    return this.applyTransition(message, 'inbound')
  }

  send(message: Draft17Message): TransitionResult<Draft17MessageType> {
    return this.applyTransition(message, 'outbound')
  }

  private applyTransition(
    message: Draft17Message,
    direction: 'inbound' | 'outbound',
  ): TransitionResult<Draft17MessageType> {
    const sideEffects: SideEffect[] = []

    switch (message.type) {
      case 'setup':
        return this.handleSetup(direction)
      case 'goaway':
        return this.handleGoAway(message, sideEffects)

      case 'subscribe':
        return this.handleSubscribe(message, sideEffects)
      case 'subscribe_ok':
        return this.handleSubscribeOk(message, sideEffects)
      case 'request_update':
        return this.handleRequestUpdate(message, sideEffects)

      case 'publish':
        return this.handlePublish(message, sideEffects)
      case 'publish_ok':
        return this.handlePublishOk(sideEffects)
      case 'publish_done':
        return this.handlePublishDone(message, sideEffects)

      case 'fetch':
        return this.handleFetch(message, sideEffects)
      case 'fetch_ok':
        return this.handleFetchOk(sideEffects)

      case 'request_ok':
        return this.handleRequestOk(sideEffects)
      case 'request_error':
        return this.handleRequestError(sideEffects)

      default:
        return this.handleReadyPhaseMessage(message)
    }
  }

  private handleSetup(direction: 'inbound' | 'outbound'): TransitionResult<Draft17MessageType> {
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
    message: Draft17Message,
    sideEffects: SideEffect[],
  ): TransitionResult<Draft17MessageType> {
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
    const goaway = message as import('./types.js').Draft17GoAway
    sideEffects.push({
      type: 'session-draining',
      goAwayUri: goaway.new_session_uri,
    })
    return { ok: true, phase: this._phase, sideEffects }
  }

  private requireReady(msgType: Draft17MessageType): ProtocolViolation<Draft17MessageType> | null {
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
    message: Draft17Message,
    sideEffects: SideEffect[],
  ): TransitionResult<Draft17MessageType> {
    const err = this.requireReady(message.type)
    if (err) return { ok: false, violation: err }
    const sub = message as import('./types.js').Draft17Subscribe
    const dupErr = this.checkDuplicateRequestId(sub.request_id, message.type)
    if (dupErr) return { ok: false, violation: dupErr }
    this._requestIds.add(sub.request_id)
    this._subscriptions.set(sub.request_id, {
      subscribeId: sub.request_id,
      phase: 'pending',
      trackNamespace: sub.track_namespace,
      trackName: sub.track_name,
    })
    this._pendingSubscribes.push(sub.request_id)
    return { ok: true, phase: this._phase, sideEffects }
  }

  private handleSubscribeOk(
    _message: Draft17Message,
    sideEffects: SideEffect[],
  ): TransitionResult<Draft17MessageType> {
    const err = this.requireReady('subscribe_ok')
    if (err) return { ok: false, violation: err }
    const requestId = this._pendingSubscribes.shift()
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
    message: Draft17Message,
    sideEffects: SideEffect[],
  ): TransitionResult<Draft17MessageType> {
    const err = this.requireReady(message.type)
    if (err) return { ok: false, violation: err }
    const update = message as import('./types.js').Draft17RequestUpdate
    const dupErr = this.checkDuplicateRequestId(update.request_id, message.type)
    if (dupErr) return { ok: false, violation: dupErr }
    this._requestIds.add(update.request_id)
    return { ok: true, phase: this._phase, sideEffects }
  }

  private handlePublish(
    message: Draft17Message,
    sideEffects: SideEffect[],
  ): TransitionResult<Draft17MessageType> {
    const err = this.requireReady(message.type)
    if (err) return { ok: false, violation: err }
    const pub = message as import('./types.js').Draft17Publish
    const dupErr = this.checkDuplicateRequestId(pub.request_id, message.type)
    if (dupErr) return { ok: false, violation: dupErr }
    this._requestIds.add(pub.request_id)
    this._publishes.set(pub.request_id, {
      requestId: pub.request_id,
      phase: 'pending',
    })
    this._pendingPublishes.push(pub.request_id)
    return { ok: true, phase: this._phase, sideEffects }
  }

  private handlePublishOk(sideEffects: SideEffect[]): TransitionResult<Draft17MessageType> {
    const err = this.requireReady('publish_ok')
    if (err) return { ok: false, violation: err }
    const requestId = this._pendingPublishes.shift()
    if (requestId === undefined) {
      return {
        ok: false,
        violation: violation(
          'UNEXPECTED_MESSAGE',
          'PUBLISH_OK with no pending publish',
          this._phase,
          'publish_ok',
        ),
      }
    }
    const existing = this._publishes.get(requestId)
    if (existing && existing.phase === 'pending') {
      this._publishes.set(requestId, { ...existing, phase: 'active' })
      sideEffects.push({ type: 'publish-activated', requestId })
    }
    return { ok: true, phase: this._phase, sideEffects }
  }

  private handlePublishDone(
    _message: Draft17Message,
    sideEffects: SideEffect[],
  ): TransitionResult<Draft17MessageType> {
    const err = this.requireReady('publish_done')
    if (err) return { ok: false, violation: err }
    // PUBLISH_DONE has no request_id in draft-17; dequeue oldest active publish
    for (const [reqId, pub] of this._publishes) {
      if (pub.phase === 'active') {
        this._publishes.set(reqId, { ...pub, phase: 'done' })
        sideEffects.push({
          type: 'publish-ended',
          requestId: reqId,
          reason: 'done',
        })
        break
      }
    }
    return { ok: true, phase: this._phase, sideEffects }
  }

  private handleFetch(
    message: Draft17Message,
    sideEffects: SideEffect[],
  ): TransitionResult<Draft17MessageType> {
    const err = this.requireReady(message.type)
    if (err) return { ok: false, violation: err }
    const fetch = message as import('./types.js').Draft17Fetch
    const dupErr = this.checkDuplicateRequestId(fetch.request_id, message.type)
    if (dupErr) return { ok: false, violation: dupErr }
    this._requestIds.add(fetch.request_id)
    this._fetches.set(fetch.request_id, {
      requestId: fetch.request_id,
      phase: 'pending',
    })
    this._pendingFetches.push(fetch.request_id)
    return { ok: true, phase: this._phase, sideEffects }
  }

  private handleFetchOk(sideEffects: SideEffect[]): TransitionResult<Draft17MessageType> {
    const err = this.requireReady('fetch_ok')
    if (err) return { ok: false, violation: err }
    const requestId = this._pendingFetches.shift()
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
    const existing = this._fetches.get(requestId)
    if (existing && existing.phase === 'pending') {
      this._fetches.set(requestId, { ...existing, phase: 'active' })
      sideEffects.push({ type: 'fetch-activated', requestId })
    }
    return { ok: true, phase: this._phase, sideEffects }
  }

  private handleRequestError(sideEffects: SideEffect[]): TransitionResult<Draft17MessageType> {
    const err = this.requireReady('request_error')
    if (err) return { ok: false, violation: err }
    // REQUEST_ERROR can target any pending request — try FIFO dequeue from each queue
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
    // Could be for subscribe_namespace, publish_namespace, track_status — allow through
    return { ok: true, phase: this._phase, sideEffects }
  }

  private handleRequestOk(sideEffects: SideEffect[]): TransitionResult<Draft17MessageType> {
    const err = this.requireReady('request_ok')
    if (err) return { ok: false, violation: err }
    // REQUEST_OK is for subscribe_namespace, publish_namespace, track_status — allow through
    return { ok: true, phase: this._phase, sideEffects }
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

  private handleReadyPhaseMessage(message: Draft17Message): TransitionResult<Draft17MessageType> {
    const err = this.requireReady(message.type)
    if (err) return { ok: false, violation: err }
    return { ok: true, phase: this._phase, sideEffects: [] }
  }

  reset(): void {
    this._phase = 'idle'
    this._setupDirection = null
    this._subscriptions.clear()
    this._publishes.clear()
    this._fetches.clear()
    this._requestIds.clear()
    this._pendingSubscribes.length = 0
    this._pendingPublishes.length = 0
    this._pendingFetches.length = 0
  }
}
