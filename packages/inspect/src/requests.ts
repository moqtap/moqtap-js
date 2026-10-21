/**
 * Requests paired with their responses, and the problems a session's control
 * messages show.
 *
 * How a response names its request changed across the drafts:
 *
 *   drafts 07–10  SUBSCRIBE and FETCH by subscribe id; ANNOUNCE,
 *                 SUBSCRIBE_ANNOUNCES and TRACK_STATUS_REQUEST by the
 *                 namespace (and track name) they repeat
 *   drafts 11–16  every request and response by request id
 *   drafts 17+    responses carry no id: each request has its own
 *                 bidirectional stream, and the response comes back on it
 *
 * Request ids are only unique per sender, so a response is matched against
 * requests that travelled the other way, and within one connection.
 *
 * Fields are read as the codec decodes them or as `displayFields` shows them,
 * so the same events serve a tool that keeps either.
 */

import { bytesAsText, isDisplayed } from './display.js'
import { errorName } from './errors.js'

/** Which way a message went: `tx` or `0` sent by the recorder, `rx` or `1` received. */
export type EventDirection = 'tx' | 'rx' | 0 | 1

/** A decoded control message, as the functions here read it. */
export interface ControlEvent {
  readonly kind?: 'control' | undefined
  /** The message's name in either case; `null` when its draft does not name it. */
  readonly name: string | null
  /** Decoded fields, raw from the codec or made readable by `displayFields`. */
  readonly fields?: Readonly<Record<string, unknown>> | undefined
  readonly direction?: EventDirection | undefined
  /** Required to pair a draft-17+ response, which only its stream ties to its request. */
  readonly streamId?: number | bigint | string | undefined
  /** When the message was seen, in milliseconds on any clock the session shares. */
  readonly atMs?: number | undefined
  /** The connection the message travelled on, when a session has several. */
  readonly connection?: string | undefined
}

/** Bytes on a control stream that did not decode as any message. */
export interface UndecodableEvent {
  readonly kind: 'undecodable'
  readonly reason?: string | undefined
  readonly direction?: EventDirection | undefined
  readonly streamId?: number | bigint | string | undefined
  readonly atMs?: number | undefined
  readonly connection?: string | undefined
}

export type InspectEvent = ControlEvent | UndecodableEvent

export interface RequestPair<T> {
  readonly request: T
  /** The first response to arrive, or `null` when none did. */
  readonly response: T | null
  /** From request to response, when both carry a time. */
  readonly rttMs: number | null
}

export interface PairOptions {
  /**
   * The session's draft. TRACK_STATUS is a response through draft-12 and a
   * request after; without the draft it is read as a response only when the
   * same events hold a TRACK_STATUS_REQUEST.
   */
  readonly draft?: number | null | undefined
}

export interface ProblemOptions extends PairOptions {
  /** A request with no response this long after it was sent is a problem. */
  readonly pendingMs: number
  /**
   * The time up to which a missing response counts as missing; the latest
   * event's time when not given.
   */
  readonly endMs?: number | undefined
}

interface ProblemBase<T> {
  /** When the problem began; `null` when the event carries no time. */
  readonly atMs: number | null
  readonly event: T
}

export type Problem<T> =
  | (ProblemBase<T> & {
      /** A *_ERROR or REQUEST_ERROR. */
      readonly kind: 'error'
      /** The message's name, upper case. */
      readonly message: string
      /** The error code in decimal, or `null` when the message carried none. */
      readonly code: string | null
      /** The code's name in the session's draft; `null` when that draft has none. */
      readonly codeName: string | null
      readonly reason: string
      /** The request the error answers, when it could be paired. */
      readonly request: T | null
    })
  | (ProblemBase<T> & {
      /**
       * A request that went `pendingMs` without a response. `atMs` is when the
       * threshold passed; `event` is the request.
       */
      readonly kind: 'pending'
      readonly requestId: string | null
      /** The response that came after the threshold, or `null` when none came. */
      readonly response: T | null
      /** How long the request waited: until its response, or until the end. */
      readonly waitedMs: number
    })
  | (ProblemBase<T> & {
      /**
       * REQUESTS_BLOCKED (SUBSCRIBES_BLOCKED before draft-11). Repeats from
       * the same sender at the same maximum are counted on the first.
       */
      readonly kind: 'requests-blocked'
      readonly maximumRequestId: string | null
      readonly count: number
    })
  | (ProblemBase<T> & {
      /**
       * A request that used the last id the peer's MAX_REQUEST_ID (or
       * MAX_SUBSCRIBE_ID, or the setup parameter) allowed, or one beyond it:
       * the sender cannot open another request until the peer raises it.
       */
      readonly kind: 'request-limit-reached'
      readonly requestId: string
      /** The peer's limit: the first id it does not allow. */
      readonly limit: string
    })
  | (ProblemBase<T> & {
      readonly kind: 'goaway'
      readonly newSessionUri: string | null
    })
  | (ProblemBase<T> & {
      readonly kind: 'undecodable'
      readonly reason: string | null
    })

// ---------------------------------------------------------------- readers ---

function lowerName(event: InspectEvent): string | null {
  if (event.kind === 'undecodable') return null
  return event.name === null ? null : event.name.toLowerCase()
}

function direction(value: EventDirection | undefined): 'tx' | 'rx' | '' {
  if (value === 'tx' || value === 0) return 'tx'
  if (value === 'rx' || value === 1) return 'rx'
  return ''
}

function opposite(value: 'tx' | 'rx' | ''): 'tx' | 'rx' | '' {
  return value === 'tx' ? 'rx' : value === 'rx' ? 'tx' : ''
}

/** A non-negative integer however it was recorded or displayed. */
function integer(value: unknown): bigint | null {
  if (typeof value === 'bigint') return value >= 0n ? value : null
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null
  }
  if (isDisplayed(value)) return value.$shown === 'integer' ? BigInt(value.text) : null
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value)
  return null
}

function text(value: unknown): string | null {
  if (value == null) return null
  if (typeof value === 'string') return value
  if (isDisplayed(value)) return value.text
  if (value instanceof Uint8Array) {
    return (
      bytesAsText(value) ??
      `0x${Array.from(value, (b) => b.toString(16).padStart(2, '0')).join('')}`
    )
  }
  return String(value)
}

function first(fields: Readonly<Record<string, unknown>>, names: readonly string[]): unknown {
  for (const name of names) {
    const value = fields[name]
    if (value != null) return value
  }
  return undefined
}

const ID_FIELDS = ['request_id', 'requestId', 'subscribe_id', 'subscribeId']

/** The request id a message carries, and whether it is a pre-draft-11 subscribe id. */
function idOf(
  fields: Readonly<Record<string, unknown>>,
): { id: bigint; subscribeId: boolean } | null {
  for (const name of ID_FIELDS) {
    const id = integer(fields[name])
    if (id !== null) return { id, subscribeId: name.startsWith('subscribe') }
  }
  return null
}

/** Messages whose id field is a limit, not a request of their own. */
const LIMIT_NAMES = new Set(['max_request_id', 'max_subscribe_id'])

/**
 * The request id a message carries, in decimal: `request_id`, or
 * `subscribe_id` before draft-11, raw from the codec or as `displayFields`
 * shows it. `null` when it carries none, and for MAX_REQUEST_ID and
 * MAX_SUBSCRIBE_ID, whose id field is a limit.
 */
export function requestIdOf(
  name: string | null,
  fields: Readonly<Record<string, unknown>> | undefined,
): string | null {
  if (fields === undefined || (name !== null && LIMIT_NAMES.has(name.toLowerCase()))) return null
  return idOf(fields)?.id.toString() ?? null
}

function tuple(value: unknown): string | null {
  return Array.isArray(value) ? JSON.stringify(value.map((part) => text(part) ?? '')) : null
}

// ----------------------------------------------------------- classification ---

/** Requests by name; TRACK_STATUS joins them from draft-13. */
const REQUESTS = new Set([
  'subscribe',
  'fetch',
  'publish',
  'announce',
  'publish_namespace',
  'subscribe_announces',
  'subscribe_namespace',
  'subscribe_tracks',
  'track_status_request',
])

/** Responses by name; TRACK_STATUS is one through draft-12. */
const RESPONSES = new Set([
  'subscribe_ok',
  'subscribe_error',
  'fetch_ok',
  'fetch_error',
  'publish_ok',
  'publish_error',
  'announce_ok',
  'announce_error',
  'publish_namespace_ok',
  'publish_namespace_error',
  'subscribe_announces_ok',
  'subscribe_announces_error',
  'subscribe_namespace_ok',
  'subscribe_namespace_error',
  'track_status_ok',
  'track_status_error',
  'request_ok',
  'request_error',
])

/**
 * The requests that drafts 07–10 identify by what they name rather than by an
 * id, and the responses that repeat it.
 */
const NAMED_BY = new Map<string, 'namespace' | 'prefix' | 'track'>([
  ['announce', 'namespace'],
  ['announce_ok', 'namespace'],
  ['announce_error', 'namespace'],
  ['subscribe_announces', 'prefix'],
  ['subscribe_announces_ok', 'prefix'],
  ['subscribe_announces_error', 'prefix'],
  ['track_status_request', 'track'],
  ['track_status', 'track'],
])

/** The last draft in which a response may name its request by id or by what it names. */
const IDS_UNTIL = 16
const TRACK_STATUS_ANSWER_UNTIL = 12

function nameKey(name: string, fields: Readonly<Record<string, unknown>>): string | null {
  const by = NAMED_BY.get(name)
  if (by === 'namespace') {
    const ns = tuple(first(fields, ['track_namespace', 'trackNamespace']))
    return ns === null ? null : `namespace:${ns}`
  }
  if (by === 'prefix') {
    const prefix = tuple(
      first(fields, ['track_namespace_prefix', 'trackNamespacePrefix', 'namespace_prefix']),
    )
    return prefix === null ? null : `prefix:${prefix}`
  }
  if (by === 'track') {
    const ns = tuple(first(fields, ['track_namespace', 'trackNamespace']))
    const track = text(first(fields, ['track_name', 'trackName']))
    return ns === null || track === null ? null : `track:${ns}:${JSON.stringify(track)}`
  }
  return null
}

interface Classifier {
  isRequest(name: string): boolean
  isResponse(name: string): boolean
  /** Whether a response with no id and no name may be paired by its stream. */
  byStream(fields: Readonly<Record<string, unknown>> | undefined): boolean
}

function classifier(events: readonly InspectEvent[], draft: number | null | undefined): Classifier {
  const answer =
    draft != null
      ? draft <= TRACK_STATUS_ANSWER_UNTIL
      : events.some((e) => lowerName(e) === 'track_status_request')
  return {
    isRequest: (name) => REQUESTS.has(name) || (name === 'track_status' && !answer),
    isResponse: (name) => RESPONSES.has(name) || (name === 'track_status' && answer),
    // Before draft-17 every request shares the control stream, so a stream
    // says nothing about which request a response answers. A message with no
    // readable fields says nothing either way and is not paired at all.
    byStream: (fields) => (draft != null ? draft > IDS_UNTIL : fields !== undefined),
  }
}

// ---------------------------------------------------------------- pairing ---

interface MutablePair<T> {
  request: T
  response: T | null
  rttMs: number | null
}

function pair<T extends InspectEvent>(
  events: readonly T[],
  draft: number | null | undefined,
): { pairs: MutablePair<T>[]; answering: Map<T, MutablePair<T>> } {
  const kinds = classifier(events, draft)
  const pairs: MutablePair<T>[] = []
  const answering = new Map<T, MutablePair<T>>()
  const open = new Map<string, MutablePair<T>>()
  const onStream = new Map<string, MutablePair<T>>()

  for (const event of events) {
    const name = lowerName(event)
    if (name === null || event.kind === 'undecodable') continue
    const fields = event.fields ?? {}
    const conn = event.connection ?? ''
    const dir = direction(event.direction)
    const stream = event.streamId == null ? null : `${conn}|${String(event.streamId)}`

    if (kinds.isRequest(name)) {
      const entry: MutablePair<T> = { request: event, response: null, rttMs: null }
      pairs.push(entry)
      const id = idOf(fields)
      const key = id !== null ? `id:${id.id}` : nameKey(name, fields)
      if (key !== null) open.set(`${conn}|${dir}|${key}`, entry)
      if (stream !== null) onStream.set(stream, entry)
      continue
    }

    if (!kinds.isResponse(name)) continue
    const id = idOf(fields)
    const key = id !== null ? `id:${id.id}` : nameKey(name, fields)
    let entry = key === null ? undefined : open.get(`${conn}|${opposite(dir)}|${key}`)
    if (entry === undefined && key === null && stream !== null && kinds.byStream(event.fields)) {
      entry = onStream.get(stream)
    }
    if (entry === undefined || entry.response !== null) continue
    entry.response = event
    const sent = entry.request.atMs
    entry.rttMs = sent !== undefined && event.atMs !== undefined ? event.atMs - sent : null
    answering.set(event, entry)
  }

  return { pairs, answering }
}

/**
 * Each request in `events` with the response that answered it, in the order
 * the requests were sent. `events` are in the order they were seen.
 */
export function pairRequests<T extends InspectEvent>(
  events: readonly T[],
  options: PairOptions = {},
): RequestPair<T>[] {
  return pair(events, options.draft).pairs.map(({ request, response, rttMs }) => ({
    request,
    response,
    rttMs,
  }))
}

// --------------------------------------------------------------- problems ---

const BLOCKED = new Set(['requests_blocked', 'subscribes_blocked'])
const SETUPS = new Set(['client_setup', 'server_setup', 'setup'])

/** The limit a setup message grants, from its parameters. */
function setupLimit(fields: Readonly<Record<string, unknown>>): bigint | null {
  const params = fields.parameters
  if (params === null || typeof params !== 'object' || Array.isArray(params)) return null
  return integer(
    first(params as Record<string, unknown>, [
      'max_request_id',
      'maxRequestId',
      'max_subscribe_id',
      'maxSubscribeId',
    ]),
  )
}

/**
 * What went wrong in `events`, in time order: errors, requests left pending
 * past `pendingMs`, blocked or exhausted request ids, GOAWAY and undecodable
 * bytes. `events` are in the order they were seen.
 */
export function problems<T extends InspectEvent>(
  events: readonly T[],
  options: ProblemOptions,
): Problem<T>[] {
  const { pendingMs, draft } = options
  const { pairs, answering } = pair(events, draft)
  const kinds = classifier(events, draft)

  const found: { order: number; problem: Problem<T> }[] = []
  let clock = Number.NEGATIVE_INFINITY
  let latest = Number.NEGATIVE_INFINITY
  const add = (problem: Problem<T>) => found.push({ order: problem.atMs ?? clock, problem })

  const blocked = new Map<string, { count: number }>()
  /** The limit each sender's requests are held to, granted by its peer. */
  const limits = new Map<string, bigint>()
  const reached = new Set<string>()

  for (const event of events) {
    if (event.atMs !== undefined) {
      clock = event.atMs
      latest = Math.max(latest, event.atMs)
    }
    const atMs = event.atMs ?? null

    if (event.kind === 'undecodable') {
      add({ kind: 'undecodable', atMs, event, reason: event.reason ?? null })
      continue
    }
    const name = lowerName(event)
    if (name === null) continue
    const fields = event.fields ?? {}
    const conn = event.connection ?? ''
    const dir = direction(event.direction)

    if (name.endsWith('_error')) {
      const code = integer(first(fields, ['error_code', 'errorCode']))
      add({
        kind: 'error',
        atMs,
        event,
        message: name.toUpperCase(),
        code: code === null ? null : code.toString(),
        codeName: code === null ? null : errorName(draft ?? null, name, code),
        reason: text(first(fields, ['reason_phrase', 'reasonPhrase'])) ?? '',
        request: answering.get(event)?.request ?? null,
      })
    } else if (BLOCKED.has(name)) {
      const maximum = integer(
        first(fields, [
          'maximum_request_id',
          'maximumRequestId',
          'maximum_subscribe_id',
          'maximumSubscribeId',
          'request_id',
        ]),
      )
      const key = `${conn}|${dir}|${maximum ?? ''}`
      const seen = blocked.get(key)
      if (seen !== undefined) {
        seen.count += 1
      } else {
        const problem = {
          kind: 'requests-blocked' as const,
          atMs,
          event,
          maximumRequestId: maximum === null ? null : maximum.toString(),
          count: 1,
        }
        blocked.set(key, problem)
        add(problem)
      }
    } else if (name === 'goaway') {
      const uri = text(first(fields, ['new_session_uri', 'newSessionUri']))
      add({ kind: 'goaway', atMs, event, newSessionUri: uri === null || uri === '' ? null : uri })
    } else if (LIMIT_NAMES.has(name) || SETUPS.has(name)) {
      const limit = SETUPS.has(name)
        ? setupLimit(fields)
        : (idOf(fields)?.id ?? integer(first(fields, ['maximum_request_id'])))
      // A limit granted by one end binds the requests the other end sends.
      if (limit !== null) limits.set(`${conn}|${opposite(dir)}`, limit)
    } else if (kinds.isRequest(name)) {
      const id = idOf(fields)
      const limit = limits.get(`${conn}|${dir}`)
      if (id !== null && limit !== undefined) {
        // Subscribe ids count up by one; request ids by two, because the two
        // ends draw from the even and the odd numbers.
        const next = id.id + (id.subscribeId ? 1n : 2n)
        const key = `${conn}|${dir}|${limit}`
        if (next >= limit && !reached.has(key)) {
          reached.add(key)
          add({
            kind: 'request-limit-reached',
            atMs,
            event,
            requestId: id.id.toString(),
            limit: limit.toString(),
          })
        }
      }
    }
  }

  const end = options.endMs ?? latest
  for (const entry of pairs) {
    const sent = entry.request.atMs
    if (sent === undefined) continue
    let waitedMs: number
    if (entry.response === null) waitedMs = end - sent
    else if (entry.rttMs !== null) waitedMs = entry.rttMs
    else continue
    if (!(waitedMs > pendingMs)) continue
    const fields = entry.request.kind === 'undecodable' ? {} : (entry.request.fields ?? {})
    const id = idOf(fields)
    found.push({
      order: sent + pendingMs,
      problem: {
        kind: 'pending',
        atMs: sent + pendingMs,
        event: entry.request,
        requestId: id === null ? null : id.id.toString(),
        response: entry.response,
        waitedMs,
      },
    })
  }

  return found.sort((a, b) => a.order - b.order).map(({ problem }) => problem)
}
