import type {
  AnnounceState,
  ProtocolViolation,
  SessionPhase,
  SideEffect,
  SubscriptionState,
  TransitionResult,
  ValidationResult,
} from '../../core/session-types.js'
import {
  CLIENT_ONLY_MESSAGES,
  getLegalIncoming,
  getLegalOutgoing,
  SERVER_ONLY_MESSAGES,
} from './rules.js'
import type { Draft07Message, Draft07MessageType } from './types.js'

function violation(
  code: ProtocolViolation<Draft07MessageType>['code'],
  message: string,
  currentPhase: SessionPhase,
  offendingMessage: Draft07MessageType,
): ProtocolViolation<Draft07MessageType> {
  return { code, message, currentPhase, offendingMessage }
}

export class Draft07SessionFSM {
  private _phase: SessionPhase = 'idle'
  private _role: 'client' | 'server'
  private _subscriptions = new Map<bigint, SubscriptionState>()
  private _announces = new Map<string, AnnounceState>()

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
    return this._announces
  }

  get legalOutgoing(): ReadonlySet<Draft07MessageType> {
    return getLegalOutgoing(this._phase, this._role)
  }

  get legalIncoming(): ReadonlySet<Draft07MessageType> {
    return getLegalIncoming(this._phase, this._role)
  }

  // Validate role constraints
  private checkRole(
    message: Draft07Message,
    direction: 'inbound' | 'outbound',
  ): ProtocolViolation<Draft07MessageType> | null {
    const senderRole =
      direction === 'outbound' ? this._role : this._role === 'client' ? 'server' : 'client'

    if (CLIENT_ONLY_MESSAGES.has(message.type) && senderRole !== 'client') {
      return violation(
        'ROLE_VIOLATION',
        `${message.type} can only be sent by client`,
        this._phase,
        message.type,
      )
    }
    if (SERVER_ONLY_MESSAGES.has(message.type) && senderRole !== 'server') {
      return violation(
        'ROLE_VIOLATION',
        `${message.type} can only be sent by server`,
        this._phase,
        message.type,
      )
    }
    return null
  }

  validateOutgoing(message: Draft07Message): ValidationResult<Draft07MessageType> {
    const roleViolation = this.checkRole(message, 'outbound')
    if (roleViolation) return { ok: false, violation: roleViolation }

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

  receive(message: Draft07Message): TransitionResult<Draft07MessageType> {
    const roleViolation = this.checkRole(message, 'inbound')
    if (roleViolation) return { ok: false, violation: roleViolation }

    return this.applyTransition(message, 'inbound')
  }

  send(message: Draft07Message): TransitionResult<Draft07MessageType> {
    const roleViolation = this.checkRole(message, 'outbound')
    if (roleViolation) return { ok: false, violation: roleViolation }

    return this.applyTransition(message, 'outbound')
  }

  private applyTransition(
    message: Draft07Message,
    direction: 'inbound' | 'outbound',
  ): TransitionResult<Draft07MessageType> {
    const sideEffects: SideEffect[] = []

    switch (message.type) {
      case 'client_setup':
        return this.handleClientSetup(message, direction)
      case 'server_setup':
        return this.handleServerSetup(message, direction)
      case 'goaway':
        return this.handleGoAway(message, direction, sideEffects)

      // Subscription lifecycle
      case 'subscribe':
        return this.handleSubscribe(message, direction, sideEffects)
      case 'subscribe_ok':
        return this.handleSubscribeOk(message, direction, sideEffects)
      case 'subscribe_error':
        return this.handleSubscribeError(message, direction, sideEffects)
      case 'subscribe_done':
        return this.handleSubscribeDone(message, direction, sideEffects)
      case 'unsubscribe':
        return this.handleUnsubscribe(message, direction, sideEffects)

      // Announce lifecycle
      case 'announce':
        return this.handleAnnounce(message, direction, sideEffects)
      case 'announce_ok':
        return this.handleAnnounceOk(message, direction, sideEffects)
      case 'announce_error':
        return this.handleAnnounceError(message, direction, sideEffects)
      case 'announce_cancel':
        return this.handleAnnounceCancel(message, direction, sideEffects)
      case 'unannounce':
        return this.handleUnannounce(message, direction, sideEffects)

      // Fetch lifecycle
      case 'fetch':
      case 'fetch_ok':
      case 'fetch_error':
      case 'fetch_cancel':
        return this.handleReadyPhaseMessage(message)

      // Other ready-phase messages
      default:
        return this.handleReadyPhaseMessage(message)
    }
  }

  private handleClientSetup(
    _message: Draft07Message,
    direction: 'inbound' | 'outbound',
  ): TransitionResult<Draft07MessageType> {
    if (this._phase !== 'idle') {
      return {
        ok: false,
        violation: violation(
          'SETUP_VIOLATION',
          'CLIENT_SETUP already sent/received',
          this._phase,
          'client_setup',
        ),
      }
    }

    if (direction === 'outbound' && this._role !== 'client') {
      return {
        ok: false,
        violation: violation(
          'ROLE_VIOLATION',
          'Only client can send CLIENT_SETUP',
          this._phase,
          'client_setup',
        ),
      }
    }

    this._phase = 'setup'
    return { ok: true, phase: this._phase, sideEffects: [] }
  }

  private handleServerSetup(
    _message: Draft07Message,
    direction: 'inbound' | 'outbound',
  ): TransitionResult<Draft07MessageType> {
    if (this._phase !== 'setup') {
      return {
        ok: false,
        violation: violation(
          'SETUP_VIOLATION',
          'SERVER_SETUP before CLIENT_SETUP',
          this._phase,
          'server_setup',
        ),
      }
    }

    if (direction === 'outbound' && this._role !== 'server') {
      return {
        ok: false,
        violation: violation(
          'ROLE_VIOLATION',
          'Only server can send SERVER_SETUP',
          this._phase,
          'server_setup',
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

  private handleGoAway(
    message: Draft07Message,
    _direction: 'inbound' | 'outbound',
    sideEffects: SideEffect[],
  ): TransitionResult<Draft07MessageType> {
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
    const goaway = message as import('./types.js').GoAway
    sideEffects.push({
      type: 'session-draining',
      goAwayUri: goaway.new_session_uri,
    })
    return { ok: true, phase: this._phase, sideEffects }
  }

  private requireReady(msgType: Draft07MessageType): ProtocolViolation<Draft07MessageType> | null {
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
    message: Draft07Message,
    _direction: 'inbound' | 'outbound',
    sideEffects: SideEffect[],
  ): TransitionResult<Draft07MessageType> {
    const err = this.requireReady(message.type)
    if (err) return { ok: false, violation: err }

    const sub = message as import('./types.js').Subscribe
    if (this._subscriptions.has(sub.subscribe_id)) {
      return {
        ok: false,
        violation: violation(
          'DUPLICATE_SUBSCRIBE_ID',
          `Subscribe ID ${sub.subscribe_id} already exists`,
          this._phase,
          message.type,
        ),
      }
    }

    this._subscriptions.set(sub.subscribe_id, {
      subscribeId: sub.subscribe_id,
      phase: 'pending',
      trackNamespace: sub.track_namespace,
      trackName: sub.track_name,
    })

    return { ok: true, phase: this._phase, sideEffects }
  }

  private handleSubscribeOk(
    message: Draft07Message,
    _direction: 'inbound' | 'outbound',
    sideEffects: SideEffect[],
  ): TransitionResult<Draft07MessageType> {
    const err = this.requireReady(message.type)
    if (err) return { ok: false, violation: err }

    const ok = message as import('./types.js').SubscribeOk
    const existing = this._subscriptions.get(ok.subscribe_id)
    if (!existing) {
      return {
        ok: false,
        violation: violation(
          'UNKNOWN_SUBSCRIBE_ID',
          `No subscription with ID ${ok.subscribe_id}`,
          this._phase,
          message.type,
        ),
      }
    }
    if (existing.phase !== 'pending') {
      return {
        ok: false,
        violation: violation(
          'STATE_VIOLATION',
          `Subscription ${ok.subscribe_id} is ${existing.phase}, not pending`,
          this._phase,
          message.type,
        ),
      }
    }

    this._subscriptions.set(ok.subscribe_id, { ...existing, phase: 'active' })
    sideEffects.push({
      type: 'subscription-activated',
      subscribeId: ok.subscribe_id,
    })
    return { ok: true, phase: this._phase, sideEffects }
  }

  private handleSubscribeError(
    message: Draft07Message,
    _direction: 'inbound' | 'outbound',
    sideEffects: SideEffect[],
  ): TransitionResult<Draft07MessageType> {
    const err = this.requireReady(message.type)
    if (err) return { ok: false, violation: err }

    const subErr = message as import('./types.js').SubscribeError
    const existing = this._subscriptions.get(subErr.subscribe_id)
    if (!existing) {
      return {
        ok: false,
        violation: violation(
          'UNKNOWN_SUBSCRIBE_ID',
          `No subscription with ID ${subErr.subscribe_id}`,
          this._phase,
          message.type,
        ),
      }
    }
    if (existing.phase !== 'pending') {
      return {
        ok: false,
        violation: violation(
          'STATE_VIOLATION',
          `Subscription ${subErr.subscribe_id} is ${existing.phase}, not pending`,
          this._phase,
          message.type,
        ),
      }
    }

    this._subscriptions.set(subErr.subscribe_id, {
      ...existing,
      phase: 'error',
    })
    sideEffects.push({
      type: 'subscription-ended',
      subscribeId: subErr.subscribe_id,
      reason: subErr.reason_phrase,
    })
    return { ok: true, phase: this._phase, sideEffects }
  }

  private handleSubscribeDone(
    message: Draft07Message,
    _direction: 'inbound' | 'outbound',
    sideEffects: SideEffect[],
  ): TransitionResult<Draft07MessageType> {
    const err = this.requireReady(message.type)
    if (err) return { ok: false, violation: err }

    const done = message as import('./types.js').SubscribeDone
    const existing = this._subscriptions.get(done.subscribe_id)
    if (!existing) {
      return {
        ok: false,
        violation: violation(
          'UNKNOWN_SUBSCRIBE_ID',
          `No subscription with ID ${done.subscribe_id}`,
          this._phase,
          message.type,
        ),
      }
    }

    this._subscriptions.set(done.subscribe_id, { ...existing, phase: 'done' })
    sideEffects.push({
      type: 'subscription-ended',
      subscribeId: done.subscribe_id,
      reason: done.reason_phrase,
    })
    return { ok: true, phase: this._phase, sideEffects }
  }

  private handleUnsubscribe(
    message: Draft07Message,
    _direction: 'inbound' | 'outbound',
    sideEffects: SideEffect[],
  ): TransitionResult<Draft07MessageType> {
    const err = this.requireReady(message.type)
    if (err) return { ok: false, violation: err }

    const unsub = message as import('./types.js').Unsubscribe
    const existing = this._subscriptions.get(unsub.subscribe_id)
    if (!existing) {
      return {
        ok: false,
        violation: violation(
          'UNKNOWN_SUBSCRIBE_ID',
          `No subscription with ID ${unsub.subscribe_id}`,
          this._phase,
          message.type,
        ),
      }
    }

    this._subscriptions.set(unsub.subscribe_id, { ...existing, phase: 'done' })
    sideEffects.push({
      type: 'subscription-ended',
      subscribeId: unsub.subscribe_id,
      reason: 'unsubscribed',
    })
    return { ok: true, phase: this._phase, sideEffects }
  }

  // Announce handlers
  private namespaceKey(ns: string[]): string {
    return ns.join('/')
  }

  private handleAnnounce(
    message: Draft07Message,
    _direction: 'inbound' | 'outbound',
    sideEffects: SideEffect[],
  ): TransitionResult<Draft07MessageType> {
    const err = this.requireReady(message.type)
    if (err) return { ok: false, violation: err }

    const ann = message as import('./types.js').Announce
    const key = this.namespaceKey(ann.track_namespace)

    this._announces.set(key, {
      namespace: ann.track_namespace,
      phase: 'pending',
    })
    return { ok: true, phase: this._phase, sideEffects }
  }

  private handleAnnounceOk(
    message: Draft07Message,
    _direction: 'inbound' | 'outbound',
    sideEffects: SideEffect[],
  ): TransitionResult<Draft07MessageType> {
    const err = this.requireReady(message.type)
    if (err) return { ok: false, violation: err }

    const ok = message as import('./types.js').AnnounceOk
    const key = this.namespaceKey(ok.track_namespace)
    const existing = this._announces.get(key)
    if (!existing) {
      return {
        ok: false,
        violation: violation(
          'UNEXPECTED_MESSAGE',
          `No announce for namespace ${key}`,
          this._phase,
          message.type,
        ),
      }
    }

    this._announces.set(key, { ...existing, phase: 'active' })
    sideEffects.push({
      type: 'announce-activated',
      namespace: ok.track_namespace,
    })
    return { ok: true, phase: this._phase, sideEffects }
  }

  private handleAnnounceError(
    message: Draft07Message,
    _direction: 'inbound' | 'outbound',
    sideEffects: SideEffect[],
  ): TransitionResult<Draft07MessageType> {
    const err = this.requireReady(message.type)
    if (err) return { ok: false, violation: err }

    const annErr = message as import('./types.js').AnnounceError
    const key = this.namespaceKey(annErr.track_namespace)
    const existing = this._announces.get(key)
    if (!existing) {
      return {
        ok: false,
        violation: violation(
          'UNEXPECTED_MESSAGE',
          `No announce for namespace ${key}`,
          this._phase,
          message.type,
        ),
      }
    }

    this._announces.set(key, { ...existing, phase: 'error' })
    sideEffects.push({
      type: 'announce-ended',
      namespace: annErr.track_namespace,
    })
    return { ok: true, phase: this._phase, sideEffects }
  }

  private handleAnnounceCancel(
    message: Draft07Message,
    _direction: 'inbound' | 'outbound',
    sideEffects: SideEffect[],
  ): TransitionResult<Draft07MessageType> {
    const err = this.requireReady(message.type)
    if (err) return { ok: false, violation: err }

    const cancel = message as import('./types.js').AnnounceCancel
    const key = this.namespaceKey(cancel.track_namespace)
    const existing = this._announces.get(key)
    if (existing) {
      this._announces.delete(key)
      sideEffects.push({
        type: 'announce-ended',
        namespace: cancel.track_namespace,
      })
    }
    return { ok: true, phase: this._phase, sideEffects }
  }

  private handleUnannounce(
    message: Draft07Message,
    _direction: 'inbound' | 'outbound',
    sideEffects: SideEffect[],
  ): TransitionResult<Draft07MessageType> {
    const err = this.requireReady(message.type)
    if (err) return { ok: false, violation: err }

    const unann = message as import('./types.js').Unannounce
    const key = this.namespaceKey(unann.track_namespace)
    const existing = this._announces.get(key)
    if (existing) {
      this._announces.delete(key)
      sideEffects.push({
        type: 'announce-ended',
        namespace: unann.track_namespace,
      })
    }
    return { ok: true, phase: this._phase, sideEffects }
  }

  private handleReadyPhaseMessage(message: Draft07Message): TransitionResult<Draft07MessageType> {
    const err = this.requireReady(message.type)
    if (err) return { ok: false, violation: err }
    return { ok: true, phase: this._phase, sideEffects: [] }
  }

  reset(): void {
    this._phase = 'idle'
    this._subscriptions.clear()
    this._announces.clear()
  }
}
