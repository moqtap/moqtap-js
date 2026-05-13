import type { Draft18MessageType } from './types.js'

// All draft-18 control messages
export const CONTROL_MESSAGES: ReadonlySet<Draft18MessageType> = new Set([
  'setup',
  'subscribe',
  'subscribe_ok',
  'request_update',
  'publish',
  'publish_done',
  'publish_namespace',
  'namespace',
  'namespace_done',
  'subscribe_namespace',
  'subscribe_tracks',
  'publish_blocked',
  'fetch',
  'fetch_ok',
  'track_status',
  'request_ok',
  'request_error',
  'goaway',
])

// Draft-18 has a single SETUP message — both roles can send it
export const CLIENT_ONLY_MESSAGES: ReadonlySet<Draft18MessageType> = new Set<Draft18MessageType>()

export const SERVER_ONLY_MESSAGES: ReadonlySet<Draft18MessageType> = new Set<Draft18MessageType>()

// Messages that are bidirectional (both client and server can send)
export const BIDIRECTIONAL_MESSAGES: ReadonlySet<Draft18MessageType> = new Set([
  'setup',
  'subscribe',
  'subscribe_ok',
  'request_update',
  'publish',
  'publish_done',
  'publish_namespace',
  'namespace',
  'namespace_done',
  'subscribe_namespace',
  'subscribe_tracks',
  'publish_blocked',
  'fetch',
  'fetch_ok',
  'track_status',
  'request_ok',
  'request_error',
  'goaway',
])

// Messages legal in each session phase
export function getLegalOutgoing(
  phase: string,
  _role: 'client' | 'server',
): Set<Draft18MessageType> {
  const legal = new Set<Draft18MessageType>()

  switch (phase) {
    case 'idle':
      legal.add('setup')
      break
    case 'setup':
      legal.add('setup')
      break
    case 'ready': {
      for (const msg of BIDIRECTIONAL_MESSAGES) {
        legal.add(msg)
      }
      break
    }
    case 'draining':
      break
  }

  return legal
}

export function getLegalIncoming(
  phase: string,
  role: 'client' | 'server',
): Set<Draft18MessageType> {
  const remoteRole = role === 'client' ? 'server' : 'client'
  return getLegalOutgoing(phase, remoteRole)
}
