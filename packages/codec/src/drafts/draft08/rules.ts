import type { Draft08MessageType } from './types.js'

// All draft-08 control messages
export const CONTROL_MESSAGES: ReadonlySet<Draft08MessageType> = new Set([
  'client_setup',
  'server_setup',
  'subscribe',
  'subscribe_ok',
  'subscribe_error',
  'subscribe_update',
  'subscribe_done',
  'unsubscribe',
  'announce',
  'announce_ok',
  'announce_error',
  'unannounce',
  'announce_cancel',
  'subscribe_announces',
  'subscribe_announces_ok',
  'subscribe_announces_error',
  'unsubscribe_announces',
  'fetch',
  'fetch_ok',
  'fetch_error',
  'fetch_cancel',
  'track_status_request',
  'track_status',
  'goaway',
  'max_subscribe_id',
  'subscribes_blocked',
])

export const CLIENT_ONLY_MESSAGES: ReadonlySet<Draft08MessageType> = new Set(['client_setup'])
export const SERVER_ONLY_MESSAGES: ReadonlySet<Draft08MessageType> = new Set(['server_setup'])

export const BIDIRECTIONAL_MESSAGES: ReadonlySet<Draft08MessageType> = new Set([
  'subscribe',
  'subscribe_ok',
  'subscribe_error',
  'subscribe_update',
  'subscribe_done',
  'unsubscribe',
  'announce',
  'announce_ok',
  'announce_error',
  'unannounce',
  'announce_cancel',
  'subscribe_announces',
  'subscribe_announces_ok',
  'subscribe_announces_error',
  'unsubscribe_announces',
  'fetch',
  'fetch_ok',
  'fetch_error',
  'fetch_cancel',
  'track_status_request',
  'track_status',
  'goaway',
  'max_subscribe_id',
  'subscribes_blocked',
])

export function getLegalOutgoing(
  phase: string,
  role: 'client' | 'server',
): Set<Draft08MessageType> {
  const legal = new Set<Draft08MessageType>()
  switch (phase) {
    case 'idle':
      if (role === 'client') legal.add('client_setup')
      break
    case 'setup':
      if (role === 'server') legal.add('server_setup')
      break
    case 'ready':
      legal.add('goaway')
      for (const msg of BIDIRECTIONAL_MESSAGES) legal.add(msg)
      break
    case 'draining':
      break
  }
  return legal
}

export function getLegalIncoming(
  phase: string,
  role: 'client' | 'server',
): Set<Draft08MessageType> {
  const remoteRole = role === 'client' ? 'server' : 'client'
  return getLegalOutgoing(phase, remoteRole)
}
