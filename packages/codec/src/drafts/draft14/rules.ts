import type { Draft14MessageType } from './types.js'

// All draft-14 control messages
export const CONTROL_MESSAGES: ReadonlySet<Draft14MessageType> = new Set([
  'client_setup',
  'server_setup',
  'subscribe',
  'subscribe_ok',
  'subscribe_update',
  'subscribe_error',
  'unsubscribe',
  'publish',
  'publish_ok',
  'publish_error',
  'publish_done',
  'publish_namespace',
  'publish_namespace_ok',
  'publish_namespace_error',
  'publish_namespace_done',
  'publish_namespace_cancel',
  'subscribe_namespace',
  'subscribe_namespace_ok',
  'subscribe_namespace_error',
  'unsubscribe_namespace',
  'fetch',
  'fetch_ok',
  'fetch_error',
  'fetch_cancel',
  'track_status',
  'track_status_ok',
  'track_status_error',
  'goaway',
  'max_request_id',
  'requests_blocked',
])

// Draft-14 is more symmetric: only setup messages are role-restricted.
// All other messages can be sent by both client and server.
export const CLIENT_ONLY_MESSAGES: ReadonlySet<Draft14MessageType> = new Set(['client_setup'])

export const SERVER_ONLY_MESSAGES: ReadonlySet<Draft14MessageType> = new Set(['server_setup'])

// Messages that are bidirectional (both client and server can send)
export const BIDIRECTIONAL_MESSAGES: ReadonlySet<Draft14MessageType> = new Set([
  'subscribe',
  'subscribe_ok',
  'subscribe_update',
  'subscribe_error',
  'unsubscribe',
  'publish',
  'publish_ok',
  'publish_error',
  'publish_done',
  'publish_namespace',
  'publish_namespace_ok',
  'publish_namespace_error',
  'publish_namespace_done',
  'publish_namespace_cancel',
  'subscribe_namespace',
  'subscribe_namespace_ok',
  'subscribe_namespace_error',
  'unsubscribe_namespace',
  'fetch',
  'fetch_ok',
  'fetch_error',
  'fetch_cancel',
  'track_status',
  'track_status_ok',
  'track_status_error',
  'goaway',
  'max_request_id',
  'requests_blocked',
])

// Messages legal in each session phase -- for outbound validation
export function getLegalOutgoing(
  phase: string,
  role: 'client' | 'server',
): Set<Draft14MessageType> {
  const legal = new Set<Draft14MessageType>()

  switch (phase) {
    case 'idle':
      if (role === 'client') legal.add('client_setup')
      break
    case 'setup':
      if (role === 'server') legal.add('server_setup')
      break
    case 'ready': {
      // Both roles can send goaway
      legal.add('goaway')
      // All bidirectional messages are legal for both roles
      for (const msg of BIDIRECTIONAL_MESSAGES) {
        legal.add(msg)
      }
      break
    }
    case 'draining':
      // Limited set during draining - can still finish active operations
      break
  }

  return legal
}

export function getLegalIncoming(
  phase: string,
  role: 'client' | 'server',
): Set<Draft14MessageType> {
  // Incoming from remote = the other role's outgoing
  const remoteRole = role === 'client' ? 'server' : 'client'
  return getLegalOutgoing(phase, remoteRole)
}
