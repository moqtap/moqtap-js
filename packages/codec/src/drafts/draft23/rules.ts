import { SessionTerminationCode as Close } from './error-codes.js'
import type {
  Draft23MessageType,
  Draft23Params,
  Draft23RequestOk,
  Draft23RequestUpdate,
  Draft23TrackProperties,
} from './types.js'

// All draft-23 control messages (draft-23 Section 9, Table 5)
export const CONTROL_MESSAGES: ReadonlySet<Draft23MessageType> = new Set([
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
  'track_status',
  'request_ok',
  'request_error',
  'goaway',
])

// Draft-23 has a single SETUP message — both roles can send it
export const CLIENT_ONLY_MESSAGES: ReadonlySet<Draft23MessageType> = new Set<Draft23MessageType>()

export const SERVER_ONLY_MESSAGES: ReadonlySet<Draft23MessageType> = new Set<Draft23MessageType>()

// Messages that are bidirectional (both client and server can send)
export const BIDIRECTIONAL_MESSAGES: ReadonlySet<Draft23MessageType> = CONTROL_MESSAGES

/**
 * The message types that may open a request stream: the rows marked "First"
 * in draft-23 Section 9, Table 5. Section 6.3 closes the session with
 * UNEXPECTED_MESSAGE when a bidirectional stream begins with any other.
 */
export const REQUEST_STREAM_OPENERS: ReadonlySet<Draft23MessageType> = new Set([
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
): Set<Draft23MessageType> {
  const legal = new Set<Draft23MessageType>()

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
): Set<Draft23MessageType> {
  const remoteRole = role === 'client' ? 'server' : 'client'
  return getLegalOutgoing(phase, remoteRole)
}

/** A rule a message breaks, with the session termination code the draft names for it. */
export interface RuleViolation {
  readonly closeCode: bigint
  readonly reason: string
}

/** Which response a REQUEST_OK is, by the request it answers (draft-23 Section 1.5). */
export type RequestOkKind =
  | 'publish_ok'
  | 'fetch_ok'
  | 'request_update_ok'
  | 'track_status_ok'
  | 'subscribe_namespace_ok'
  | 'subscribe_tracks_ok'
  | 'publish_namespace_ok'

/**
 * draft-23 Section 9.3: "The parameters that can appear depend on the request
 * being answered: - PUBLISH_OK: EXPIRES - FETCH_OK: EXPIRES, LARGEST_OBJECT -
 * REQUEST_UPDATE_OK: EXPIRES, LARGEST_OBJECT - TRACK_STATUS_OK: EXPIRES,
 * LARGEST_OBJECT - SUBSCRIBE_NAMESPACE_OK: EXPIRES - SUBSCRIBE_TRACKS_OK:
 * EXPIRES - PUBLISH_NAMESPACE_OK: EXPIRES"
 */
const REQUEST_OK_PARAMETERS: Readonly<Record<RequestOkKind, readonly (keyof Draft23Params)[]>> = {
  publish_ok: ['expires'],
  fetch_ok: ['expires', 'largest_object'],
  request_update_ok: ['expires', 'largest_object'],
  track_status_ok: ['expires', 'largest_object'],
  subscribe_namespace_ok: ['expires'],
  subscribe_tracks_ok: ['expires'],
  publish_namespace_ok: ['expires'],
}

/**
 * draft-23 Section 9.3: "Track Properties are populated in TRACK_STATUS_OK and
 * FETCH_OK; they are empty in PUBLISH_OK, REQUEST_UPDATE_OK,
 * SUBSCRIBE_NAMESPACE_OK and PUBLISH_NAMESPACE_OK. If an endpoint receives
 * Track Properties in one of these messages it MUST close the session with
 * INVALID_FIELD." SUBSCRIBE_TRACKS_OK is in neither list.
 */
const REQUEST_OK_EMPTY_TRACK_PROPERTIES: ReadonlySet<RequestOkKind> = new Set([
  'publish_ok',
  'request_update_ok',
  'subscribe_namespace_ok',
  'publish_namespace_ok',
])

function presentParameters(params: Draft23Params): string[] {
  return Object.entries(params)
    .filter(([k, v]) => v !== undefined && !(k === 'unknown' && (v as unknown[]).length === 0))
    .map(([k]) => k)
}

function hasTrackProperties(props: Draft23TrackProperties): boolean {
  return Object.entries(props).some(
    ([k, v]) => v !== undefined && !(k === 'unknown' && (v as unknown[]).length === 0),
  )
}

/**
 * Hold a decoded REQUEST_OK to the lists of draft-23 Section 9.3 for the
 * response it is. The frame does not say which response that is, so the codec
 * cannot; the session state machine calls this once the request stream has
 * told it. A parameter outside the list closes with INVALID_PARAMETER
 * (Section 9.19.1).
 */
export function checkRequestOk(
  kind: RequestOkKind,
  message: Draft23RequestOk,
): RuleViolation | null {
  const allowed = REQUEST_OK_PARAMETERS[kind]
  const extra = presentParameters(message.parameters).filter(
    (name) => !allowed.includes(name as keyof Draft23Params),
  )
  if (extra.length > 0) {
    return {
      closeCode: Close.InvalidParameter,
      reason: `${kind} may carry only ${allowed.join(', ')}, not ${extra.join(', ')}`,
    }
  }
  if (REQUEST_OK_EMPTY_TRACK_PROPERTIES.has(kind) && hasTrackProperties(message.track_properties)) {
    return { closeCode: Close.InvalidField, reason: `${kind} must carry no Track Properties` }
  }
  return null
}

/** What a REQUEST_UPDATE updates, by the request on whose stream it travels. */
export type RequestUpdateTarget =
  | 'subscription'
  | 'fetch'
  | 'publish_namespace'
  | 'subscribe_namespace'
  | 'subscribe_tracks'

/**
 * draft-23 Section 9.5: "The parameters that can appear depend on the request
 * being updated: - Subscription: OBJECT_DELIVERY_TIMEOUT, AUTHORIZATION_TOKEN,
 * SUBGROUP_DELIVERY_TIMEOUT, PAUSED, SUBSCRIBER_PRIORITY, LOCATION_FILTER,
 * FILL_PARAMETERS, SUBGROUP_FILTER, OBJECTID_FILTER, PRIORITY_FILTER,
 * OBJECT_PROPERTY_FILTER, NEW_GROUP_REQUEST - FETCH: AUTHORIZATION_TOKEN,
 * SUBSCRIBER_PRIORITY - PUBLISH_NAMESPACE: AUTHORIZATION_TOKEN -
 * SUBSCRIBE_NAMESPACE: AUTHORIZATION_TOKEN, TRACK_NAMESPACE_PREFIX -
 * SUBSCRIBE_TRACKS: AUTHORIZATION_TOKEN, PAUSED, TRACK_PROPERTY_FILTER,
 * TRACK_NAMESPACE_PREFIX"
 */
const REQUEST_UPDATE_PARAMETERS: Readonly<
  Record<RequestUpdateTarget, readonly (keyof Draft23Params)[]>
> = {
  subscription: [
    'object_delivery_timeout',
    'authorization_token',
    'subgroup_delivery_timeout',
    'paused',
    'subscriber_priority',
    'location_filter',
    'fill_parameters',
    'subgroup_filter',
    'objectid_filter',
    'priority_filter',
    'object_property_filter',
    'new_group_request',
  ],
  fetch: ['authorization_token', 'subscriber_priority'],
  publish_namespace: ['authorization_token'],
  subscribe_namespace: ['authorization_token', 'track_namespace_prefix'],
  subscribe_tracks: [
    'authorization_token',
    'paused',
    'track_property_filter',
    'track_namespace_prefix',
  ],
}

/** The Range Filters of a subscription update, which only the subscriber may send. */
const SUBSCRIBER_ONLY_UPDATE_PARAMETERS: readonly (keyof Draft23Params)[] = [
  'subgroup_filter',
  'objectid_filter',
  'priority_filter',
  'object_property_filter',
]

/**
 * Hold a decoded REQUEST_UPDATE to the list of draft-23 Section 9.5 for the
 * request it updates, which the frame does not carry. `fromSubscriber` is
 * whether the sender is the subscriber of a subscription: Section 9.5, "Range
 * Filters are only allowed from the subscriber (see Section 3.3.2)". A
 * parameter outside the list closes with INVALID_PARAMETER (Section 9.19.1).
 */
export function checkRequestUpdate(
  target: RequestUpdateTarget,
  message: Draft23RequestUpdate,
  fromSubscriber: boolean,
): RuleViolation | null {
  const allowed = REQUEST_UPDATE_PARAMETERS[target]
  const present = presentParameters(message.parameters)
  const extra = present.filter((name) => !allowed.includes(name as keyof Draft23Params))
  if (extra.length > 0) {
    return {
      closeCode: Close.InvalidParameter,
      reason: `a REQUEST_UPDATE for a ${target} may carry only ${allowed.join(', ')}, not ${extra.join(', ')}`,
    }
  }
  if (target === 'subscription' && !fromSubscriber) {
    const filters = present.filter((name) =>
      SUBSCRIBER_ONLY_UPDATE_PARAMETERS.includes(name as keyof Draft23Params),
    )
    if (filters.length > 0) {
      return {
        closeCode: Close.InvalidParameter,
        reason: `Range Filters are only allowed from the subscriber, not ${filters.join(', ')}`,
      }
    }
  }
  return null
}
