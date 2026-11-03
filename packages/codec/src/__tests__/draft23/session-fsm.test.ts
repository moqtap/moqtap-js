/**
 * The session rules the vector corpus cannot reach: which response a
 * REQUEST_OK is, fill fetch streams, and rules about the stream a message
 * arrived on, which a single-message vector has no way to express.
 */

import { describe, expect, it } from 'vitest'
import { createDraft23Codec } from '../../drafts/draft23/codec.js'
import { SessionTerminationCode as Close } from '../../drafts/draft23/error-codes.js'
import { createDraft23SessionState } from '../../drafts/draft23/session.js'
import type { Draft23Message, Draft23Params } from '../../drafts/draft23/types.js'
import { hexToBytes } from '../helpers.js'

function ready(role: 'client' | 'server' = 'client') {
  const fsm = createDraft23SessionState(role)
  fsm.send({ type: 'setup', options: {} })
  fsm.receive({ type: 'setup', options: {} })
  expect(fsm.phase).toBe('ready')
  return fsm
}

function subscribe(requestId: bigint, parameters: Draft23Params): Draft23Message {
  return {
    type: 'subscribe',
    request_id: requestId,
    track_namespace: ['live'],
    track_name: 'video',
    parameters,
  }
}

function publish(requestId: bigint, parameters: Draft23Params): Draft23Message {
  return {
    type: 'publish',
    request_id: requestId,
    track_namespace: ['live'],
    track_name: 'video',
    track_alias: 0n,
    parameters,
    track_properties: {},
  }
}

function fetch(requestId: bigint, parameters: Draft23Params = {}): Draft23Message {
  return {
    type: 'fetch',
    request_id: requestId,
    track_namespace: ['live'],
    track_name: 'video',
    parameters,
  }
}

function requestOk(parameters: Draft23Params = {}, track_properties = {}): Draft23Message {
  return { type: 'request_ok', parameters, track_properties }
}

function update(requestId: bigint, parameters: Draft23Params = {}): Draft23Message {
  return { type: 'request_update', request_id: requestId, parameters }
}

function closeCodeOf(result: ReturnType<ReturnType<typeof ready>['send']>): bigint | undefined {
  expect(result.ok).toBe(false)
  return result.ok ? undefined : result.violation.closeCode
}

describe('draft-23 REQUEST_OK as FETCH_OK and REQUEST_UPDATE_OK (Sections 1.5, 3.2 and 9.5)', () => {
  it('reads the first REQUEST_OK on a FETCH stream as FETCH_OK', () => {
    const fsm = ready()
    fsm.send(fetch(2n))
    const result = fsm.receiveOn(2n, requestOk({ largest_object: { group: 5n, object: 3n } }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.sideEffects).toContainEqual({ type: 'fetch-activated', requestId: 2n })
    expect(fsm.fetches.get(2n)?.phase).toBe('active')
  })

  it('lets FETCH_OK carry Track Properties and a REQUEST_UPDATE_OK not', () => {
    const fsm = ready()
    fsm.send(fetch(2n))
    expect(fsm.receiveOn(2n, requestOk({}, { dynamic_groups: 1n })).ok).toBe(true)
    fsm.sendOn(2n, update(4n, { subscriber_priority: 10n }))
    expect(closeCodeOf(fsm.receiveOn(2n, requestOk({}, { dynamic_groups: 1n })))).toBe(
      Close.InvalidField,
    )
  })

  it('pairs REQUEST_UPDATE_OKs with REQUEST_UPDATEs in order', () => {
    const fsm = ready()
    fsm.send(fetch(2n))
    fsm.sendOn(2n, update(4n))
    fsm.sendOn(2n, update(6n))
    // FETCH_OK, then one answer for each update, then nothing is outstanding.
    expect(fsm.receiveOn(2n, requestOk()).ok).toBe(true)
    expect(fsm.receiveOn(2n, requestOk()).ok).toBe(true)
    expect(fsm.receiveOn(2n, requestOk()).ok).toBe(true)
    expect(closeCodeOf(fsm.receiveOn(2n, requestOk()))).toBe(Close.UnexpectedMessage)
  })

  it('holds PUBLISH_OK to EXPIRES and empty Track Properties', () => {
    const fsm = ready()
    fsm.receive(publish(1n, {}))
    expect(
      closeCodeOf(fsm.sendOn(1n, requestOk({ largest_object: { group: 1n, object: 0n } }))),
    ).toBe(Close.InvalidParameter)
    expect(closeCodeOf(fsm.sendOn(1n, requestOk({}, { dynamic_groups: 1n })))).toBe(
      Close.InvalidField,
    )
    const ok = fsm.sendOn(1n, requestOk({ expires: 100n }))
    expect(ok.ok).toBe(true)
    expect(fsm.publishes.get(1n)?.phase).toBe('active')
  })

  it('refuses a FETCH_OK for a FETCH with a relative Location filter (Section 3.2)', () => {
    const fsm = ready('server')
    fsm.receive(fetch(2n, { location_filter: { filter_type: 1n, start_group: 2n } }))
    const result = fsm.sendOn(2n, requestOk())
    expect(result.ok).toBe(false)
  })

  it('reads a REQUEST_OK on a SUBSCRIBE stream as a REQUEST_UPDATE_OK, never the SUBSCRIBE_OK', () => {
    const fsm = ready()
    fsm.send(subscribe(1n, {}))
    expect(closeCodeOf(fsm.receiveOn(1n, requestOk()))).toBe(Close.UnexpectedMessage)
    fsm.receiveOn(1n, {
      type: 'subscribe_ok',
      track_alias: 0n,
      parameters: {},
      track_properties: {},
    })
    fsm.sendOn(1n, update(3n))
    expect(fsm.receiveOn(1n, requestOk({ largest_object: { group: 1n, object: 0n } })).ok).toBe(
      true,
    )
  })

  it('refuses a second SUBSCRIBE_OK (Section 3.1)', () => {
    const fsm = ready()
    fsm.send(subscribe(1n, {}))
    const ok: Draft23Message = {
      type: 'subscribe_ok',
      track_alias: 0n,
      parameters: {},
      track_properties: {},
    }
    expect(fsm.receiveOn(1n, ok).ok).toBe(true)
    expect(closeCodeOf(fsm.receiveOn(1n, ok))).toBe(Close.UnexpectedMessage)
  })
})

describe('draft-23 REQUEST_UPDATE (Section 9.5)', () => {
  it('holds each update to the list for the request it updates', () => {
    const fsm = ready()
    fsm.send(fetch(2n))
    expect(fsm.sendOn(2n, update(4n, { subscriber_priority: 1n })).ok).toBe(true)
    expect(closeCodeOf(fsm.sendOn(2n, update(6n, { paused: 1n })))).toBe(Close.InvalidParameter)

    fsm.send({
      type: 'subscribe_namespace',
      request_id: 8n,
      namespace_prefix: ['a'],
      parameters: {},
    })
    expect(fsm.sendOn(8n, update(10n, { track_namespace_prefix: ['b'] })).ok).toBe(true)
    expect(closeCodeOf(fsm.sendOn(8n, update(12n, { fill_parameters: {} })))).toBe(
      Close.InvalidParameter,
    )
  })

  it('refuses an update of a TRACK_STATUS, and one from the receiver of a SUBSCRIBE', () => {
    const fsm = ready()
    fsm.send({
      type: 'track_status',
      request_id: 2n,
      track_namespace: ['live'],
      track_name: 'video',
      parameters: {},
    })
    expect(closeCodeOf(fsm.sendOn(2n, update(4n)))).toBe(Close.UnexpectedMessage)

    fsm.receive(subscribe(1n, {}))
    expect(closeCodeOf(fsm.sendOn(1n, update(6n)))).toBe(Close.UnexpectedMessage)
  })

  it('lets either side update a PUBLISH, and only the subscriber send Range Filters', () => {
    const fsm = ready()
    fsm.send(publish(2n, {}))
    expect(fsm.sendOn(2n, update(4n, { subscriber_priority: 1n })).ok).toBe(true)
    const filter = { objectid_filter: [{ set_id: 0n, ranges: [{ start: 0n, end: 4n }] }] }
    expect(closeCodeOf(fsm.sendOn(2n, update(6n, filter)))).toBe(Close.InvalidParameter)
    expect(fsm.receiveOn(2n, update(1n, filter)).ok).toBe(true)
  })

  it('counts each side against the limit its peer advertised (Section 9.1.7)', () => {
    const fsm = createDraft23SessionState('client')
    fsm.send({ type: 'setup', options: {} })
    fsm.receive({ type: 'setup', options: { max_request_updates: 1n } })
    fsm.send(subscribe(1n, {}))
    expect(fsm.sendOn(1n, update(3n)).ok).toBe(true)
    expect(closeCodeOf(fsm.sendOn(1n, update(5n)))).toBe(Close.TooManyRequestUpdates)
    fsm.receiveOn(1n, requestOk())
    expect(fsm.sendOn(1n, update(7n)).ok).toBe(true)
  })

  it('names INVALID_REQUEST_ID for a duplicate Request ID (Section 6.4.2.1)', () => {
    const fsm = ready()
    fsm.send(subscribe(1n, {}))
    expect(closeCodeOf(fsm.send(subscribe(1n, {})))).toBe(Close.InvalidRequestId)
  })
})

describe('draft-23 fill fetch streams (Sections 3.4 and 3.4.1)', () => {
  it('opens one when SUBSCRIBE carries FILL_PARAMETERS', () => {
    const fsm = ready()
    const result = fsm.send(subscribe(1n, { fill_parameters: {} }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.sideEffects).toContainEqual({
      type: 'fill-fetch-stream-opened',
      subscribeId: 1n,
      requestId: 1n,
    })
    expect([...fsm.fillFetchStreamsFor(1n).keys()]).toEqual([1n])
  })

  it('opens one when PUBLISH carries FILL_PARAMETERS, keyed by the PUBLISH Request ID', () => {
    const fsm = ready()
    fsm.receive(publish(3n, { fill_parameters: {} }))
    expect([...fsm.fillFetchStreamsFor(3n).keys()]).toEqual([3n])
  })

  it('opens none while the subscription is paused, and not after it resumes either', () => {
    const fsm = ready()
    fsm.send(subscribe(1n, { paused: 1n, fill_parameters: {} }))
    expect(fsm.pausedStateOf(1n)).toBe(1)
    expect(fsm.fillFetchStreamsFor(1n).size).toBe(0)

    // "Resuming the subscription without re-sending FILL_PARAMETERS does not
    // open one either."
    fsm.sendOn(1n, update(2n, { paused: 0n }))
    expect(fsm.pausedStateOf(1n)).toBe(0)
    expect(fsm.fillFetchStreamsFor(1n).size).toBe(0)

    fsm.sendOn(1n, update(3n, { fill_parameters: {} }))
    expect([...fsm.fillFetchStreamsFor(1n).keys()]).toEqual([3n])
  })

  it('defaults PAUSED to 0 and keeps it when an update omits it', () => {
    const fsm = ready()
    fsm.send(subscribe(1n, {}))
    expect(fsm.pausedStateOf(1n)).toBe(0)
    fsm.sendOn(1n, update(3n, { paused: 1n }))
    fsm.sendOn(1n, update(5n, {}))
    expect(fsm.pausedStateOf(1n)).toBe(1)
  })

  it('keeps several open at once, keyed by the Request ID that opened each', () => {
    const fsm = ready()
    fsm.send(subscribe(1n, { fill_parameters: {} }))
    fsm.sendOn(1n, update(5n, { fill_parameters: {} }))
    fsm.sendOn(1n, update(9n, { fill_parameters: {} }))
    const fills = fsm.fillFetchStreamsFor(1n)
    expect([...fills.keys()]).toEqual([1n, 5n, 9n])
    for (const fill of fills.values()) {
      expect(fill.phase).toBe('open')
      expect(fill.subscribeId).toBe(1n)
    }
  })

  it('never shows a fill fetch stream as a FETCH', () => {
    const fsm = ready()
    fsm.send(subscribe(1n, { fill_parameters: {} }))
    expect(fsm.fetches.size).toBe(0)
    expect(fsm.requestKindOf(1n)).toBe('subscription')
  })

  it('ends a fill on a transport event, leaving the subscription alone', () => {
    const fsm = ready()
    fsm.send(subscribe(1n, { fill_parameters: {} }))
    fsm.sendOn(1n, update(5n, { fill_parameters: {} }))
    expect(fsm.closeFillFetchStream(5n, 'reset')).toEqual([
      { type: 'fill-fetch-stream-closed', subscribeId: 1n, requestId: 5n, reason: 'reset' },
    ])
    expect(fsm.fillFetchStreamsFor(1n).get(1n)?.phase).toBe('open')
    expect(fsm.subscriptions.get(1n)?.phase).toBe('pending')
  })

  it('resets every open fill when the subscription ends', () => {
    const fsm = ready()
    fsm.receive(publish(4n, {}))
    fsm.sendOn(4n, requestOk())
    fsm.sendOn(4n, update(7n, { fill_parameters: {} }))
    expect(fsm.fillFetchStreamsFor(4n).get(7n)?.phase).toBe('open')

    const done = fsm.receiveOn(4n, {
      type: 'publish_done',
      status_code: 2n,
      stream_count: 3n,
      reason_phrase: '',
    })
    expect(done.ok).toBe(true)
    if (!done.ok) return
    expect(done.sideEffects).toContainEqual({
      type: 'fill-fetch-stream-closed',
      subscribeId: 4n,
      requestId: 7n,
      reason: 'subscription-ended',
    })
  })
})

describe('draft-23 PUBLISH_STATE_NOTIFY (Section 9.10)', () => {
  const notify: Draft23Message = {
    type: 'publish_state_notify',
    parameters: { largest_object: { group: 10n, object: 3n }, paused: 1n },
  }

  it('is accepted from the publisher, with no reply expected, and reports PAUSED', () => {
    const fsm = ready()
    fsm.send(subscribe(1n, {}))
    const result = fsm.receiveOn(1n, notify)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.sideEffects).toEqual([{ type: 'subscription-state-notified', subscribeId: 1n }])
    expect(fsm.pausedStateOf(1n)).toBe(1)
  })

  it('closes with ROLE_VIOLATION when a publisher receives one', () => {
    const fsm = ready()
    fsm.receive(subscribe(1n, {}))
    const result = fsm.receiveOn(1n, notify)
    expect(closeCodeOf(result)).toBe(Close.RoleViolation)
  })

  it('closes with UNEXPECTED_MESSAGE on any other request type', () => {
    const fsm = ready()
    fsm.send(fetch(2n))
    const result = fsm.receiveOn(2n, notify)
    expect(closeCodeOf(result)).toBe(Close.UnexpectedMessage)
    if (result.ok) return
    expect(result.violation.message).toContain('fetch')
  })
})

describe('draft-23 GOAWAY (Section 9.2)', () => {
  const goaway = (uri = ''): Draft23Message => ({
    type: 'goaway',
    new_session_uri: uri,
    timeout: 0n,
  })

  it('allows the receiver of a request to send one on its stream, once, without draining', () => {
    const fsm = ready()
    fsm.send(subscribe(1n, {}))
    expect(fsm.receiveOn(1n, goaway()).ok).toBe(true)
    expect(fsm.phase).toBe('ready')
    expect(closeCodeOf(fsm.receiveOn(1n, goaway()))).toBe(Close.UnexpectedMessage)
  })

  it('closes with PROTOCOL_VIOLATION when the receiver of a request gets one on its stream', () => {
    const fsm = ready()
    fsm.receive(subscribe(1n, {}))
    expect(closeCodeOf(fsm.receiveOn(1n, goaway()))).toBe(Close.ProtocolViolation)
  })

  it('closes with UNEXPECTED_MESSAGE on a second control-stream GOAWAY', () => {
    const fsm = ready()
    expect(fsm.receive(goaway()).ok).toBe(true)
    expect(fsm.phase).toBe('draining')
    expect(closeCodeOf(fsm.receive(goaway()))).toBe(Close.UnexpectedMessage)
  })

  it('closes with ROLE_VIOLATION when a server receives a New Session URI', () => {
    const fsm = ready('server')
    expect(closeCodeOf(fsm.receive(goaway('moqt://relay')))).toBe(Close.RoleViolation)
  })
})

describe('draft-23 SETUP (Sections 9.1.4 and 9.1.8)', () => {
  it('closes with ROLE_VIOLATION when a server receives DELETE or USE_ALIAS', () => {
    for (const alias_type of [0n, 2n]) {
      const fsm = createDraft23SessionState('server')
      const result = fsm.receive({
        type: 'setup',
        options: { authorization_token: [{ alias_type, token_alias: 0n }] },
      })
      expect(closeCodeOf(result)).toBe(Close.RoleViolation)
    }
  })

  it('closes with UNKNOWN_AUTH_TOKEN_ALIAS when a client receives one for no registered alias', () => {
    const fsm = createDraft23SessionState('client')
    const result = fsm.receive({
      type: 'setup',
      options: { authorization_token: [{ alias_type: 2n, token_alias: 4n }] },
    })
    expect(closeCodeOf(result)).toBe(Close.UnknownAuthTokenAlias)
  })

  it('closes with ROLE_VIOLATION on a decoded SETUP that registers an alias and deletes it', () => {
    // REGISTER alias 5 (token type 0, value "a"), then DELETE alias 5.
    const decoded = createDraft23Codec().decodeMessage(hexToBytes('af000a03040105006100020005'))
    if (!decoded.ok) throw decoded.error
    expect(closeCodeOf(createDraft23SessionState('server').receive(decoded.value))).toBe(
      Close.RoleViolation,
    )
    expect(createDraft23SessionState('client').receive(decoded.value).ok).toBe(true)
  })

  it('learns both MAX_CONTROL_MESSAGE_SIZE values, 65535 by default', () => {
    const fsm = createDraft23SessionState('client')
    expect(fsm.peerMaxControlMessageSize).toBe(65535n)
    fsm.send({ type: 'setup', options: { max_control_message_size: 1048576n } })
    fsm.receive({ type: 'setup', options: {} })
    expect(fsm.localMaxControlMessageSize).toBe(1048576n)
    expect(fsm.peerMaxControlMessageSize).toBe(65535n)
  })
})

describe('draft-23 REDIRECT Error Detail (Section 9.4.2.1)', () => {
  const redirect = (
    connect_uri: string,
    track_name: string,
    error_code = 0x34n,
  ): Draft23Message => ({
    type: 'request_error',
    error_code,
    retry_interval: 0n,
    reason_phrase: '',
    error_details: { redirect: { connect_uri, track_namespace: ['b'], track_name } },
  })

  it('closes with ROLE_VIOLATION when a server receives a Connect URI', () => {
    const fsm = ready('server')
    fsm.send(subscribe(1n, {}))
    expect(closeCodeOf(fsm.receiveOn(1n, redirect('moqt://other', 'x')))).toBe(Close.RoleViolation)
  })

  it('closes with INVALID_FIELD on a Track Name for a namespace-scoped request', () => {
    const fsm = ready()
    fsm.send({ type: 'subscribe_tracks', request_id: 2n, namespace_prefix: ['a'], parameters: {} })
    expect(closeCodeOf(fsm.receiveOn(2n, redirect('', 'x')))).toBe(Close.InvalidField)
    expect(fsm.receiveOn(2n, redirect('', '')).ok).toBe(true)
  })

  // draft-23 Section 9.4.2: receivers "MUST ignore a known Error Detail type
  // that accompanies an Error Code it is not defined for".
  it('ignores a REDIRECT detail under another Error Code', () => {
    const server = ready('server')
    server.send(subscribe(1n, {}))
    expect(server.receiveOn(1n, redirect('moqt://other', 'x', 0x10n)).ok).toBe(true)
    const client = ready()
    client.send({
      type: 'subscribe_tracks',
      request_id: 2n,
      namespace_prefix: ['a'],
      parameters: {},
    })
    expect(client.receiveOn(2n, redirect('', 'x', 0x10n)).ok).toBe(true)
  })
})
