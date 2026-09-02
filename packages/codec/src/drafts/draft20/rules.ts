import type { Draft20MessageType } from './types.js'

// All draft-20 control messages (draft-20 Section 10, Table 5)
export const CONTROL_MESSAGES: ReadonlySet<Draft20MessageType> = new Set([
  'setup',
  'subscribe',
  'subscribe_ok',
  'request_update',
  'publish_state_notify',
  'publish',
  'publish_done',
  'publish_namespace',
  'namespace',
  'namespace_done',
  'subscribe_namespace',
  'subscribe_tracks',
  'publish_skipped',
  'fetch',
  'fetch_ok',
  'track_status',
  'request_ok',
  'request_error',
  'goaway',
])

// Draft-20 has a single SETUP message — both roles can send it
export const CLIENT_ONLY_MESSAGES: ReadonlySet<Draft20MessageType> = new Set<Draft20MessageType>()

export const SERVER_ONLY_MESSAGES: ReadonlySet<Draft20MessageType> = new Set<Draft20MessageType>()

// Messages that are bidirectional (both client and server can send)
export const BIDIRECTIONAL_MESSAGES: ReadonlySet<Draft20MessageType> = new Set([
  'setup',
  'subscribe',
  'subscribe_ok',
  'request_update',
  'publish_state_notify',
  'publish',
  'publish_done',
  'publish_namespace',
  'namespace',
  'namespace_done',
  'subscribe_namespace',
  'subscribe_tracks',
  'publish_skipped',
  'fetch',
  'fetch_ok',
  'track_status',
  'request_ok',
  'request_error',
  'goaway',
])

/**
 * The seven message types that may be the FIRST message on a new bidirectional
 * (request) stream — draft-20 Section 3.3, and the rows marked "First" in the
 * Section 10 registry. Unchanged from draft-19.
 *
 * "Bidirectional streams MUST NOT begin with any other message type unless
 * negotiated. If they do, the peer MUST close the Session with a
 * PROTOCOL_VIOLATION." Note GOAWAY (0x10) is marked "Control, Request" but not
 * "First": it may travel on either kind of stream but may never open one.
 */
export const REQUEST_STREAM_OPENERS: ReadonlySet<Draft20MessageType> = new Set([
  'subscribe',
  'publish',
  'fetch',
  'track_status',
  'publish_namespace',
  'subscribe_namespace',
  'subscribe_tracks',
])

// Messages legal in each session phase
export function getLegalOutgoing(
  phase: string,
  _role: 'client' | 'server',
): Set<Draft20MessageType> {
  const legal = new Set<Draft20MessageType>()

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
): Set<Draft20MessageType> {
  const remoteRole = role === 'client' ? 'server' : 'client'
  return getLegalOutgoing(phase, remoteRole)
}
