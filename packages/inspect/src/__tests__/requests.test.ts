import { createDraft07Codec } from '@moqtap/codec/draft07'
import { createDraft14Codec } from '@moqtap/codec/draft14'
import { createDraft17Codec } from '@moqtap/codec/draft17'
import { createDraft22Codec } from '@moqtap/codec/draft22'
import { describe, expect, it } from 'vitest'
import { displayFields } from '../display.js'
import { type ControlEvent, type InspectEvent, pairRequests, problems } from '../requests.js'

/** A message as the codec reads it off the wire, so fields are spelled as decoded. */
function decoded<M extends { type: string }>(
  codec: {
    encodeMessage(message: M): Uint8Array
    decodeMessage(bytes: Uint8Array): { ok: true; value: M } | { ok: false; error: unknown }
  },
  message: M,
): Record<string, unknown> {
  const result = codec.decodeMessage(codec.encodeMessage(message))
  if (!result.ok) throw new Error(`${message.type} did not round-trip`)
  return { ...result.value }
}

function control(
  name: string,
  fields: Record<string, unknown>,
  extra: Partial<ControlEvent> = {},
): ControlEvent {
  return { name, fields, ...extra }
}

describe('pairRequests', () => {
  it('pairs draft-07 by subscribe id, and ANNOUNCE by namespace', () => {
    const codec = createDraft07Codec()
    const sub = control(
      'subscribe',
      { subscribe_id: 3n, track_alias: 1n, track_namespace: ['live'], track_name: 'v' },
      { direction: 'tx', atMs: 100 },
    )
    const announce = control(
      'announce',
      { track_namespace: ['live'] },
      { direction: 'tx', atMs: 110 },
    )
    const err = control(
      'subscribe_error',
      decoded(codec, {
        type: 'subscribe_error',
        subscribe_id: 3n,
        error_code: 4n,
        reason_phrase: 'no',
        track_alias: 1n,
      }),
      { direction: 'rx', atMs: 140 },
    )
    const ok = control(
      'announce_ok',
      decoded(codec, { type: 'announce_ok', track_namespace: ['live'] }),
      { direction: 'rx', atMs: 150 },
    )
    const pairs = pairRequests([sub, announce, err, ok], { draft: 7 })
    expect(pairs).toEqual([
      { request: sub, response: err, rttMs: 40 },
      { request: announce, response: ok, rttMs: 40 },
    ])
  })

  it('pairs draft-07 TRACK_STATUS as the answer to TRACK_STATUS_REQUEST', () => {
    const req = control('track_status_request', { track_namespace: ['a'], track_name: 'b' })
    const res = control('track_status', {
      track_namespace: ['a'],
      track_name: 'b',
      status_code: 0n,
    })
    // Without a draft the TRACK_STATUS_REQUEST in the same events decides it.
    expect(pairRequests([req, res])).toEqual([{ request: req, response: res, rttMs: null }])
    expect(pairRequests([req, res], { draft: 7 })).toHaveLength(1)
  })

  it('pairs draft-14 by request id, only against requests that went the other way', () => {
    const codec = createDraft14Codec()
    const mine = control('SUBSCRIBE', { request_id: 2n }, { direction: 'tx', atMs: 0 })
    const theirs = control('PUBLISH', { request_id: 2n }, { direction: 'rx', atMs: 5 })
    const ok = control(
      'SUBSCRIBE_OK',
      decoded(codec, {
        type: 'subscribe_ok',
        request_id: 2n,
        track_alias: 9n,
        expires: 0n,
        group_order: 1,
        content_exists: 0n,
        parameters: {},
      }),
      { direction: 'rx', atMs: 30 },
    )
    const pairs = pairRequests([mine, theirs, ok], { draft: 14 })
    expect(pairs[0]).toEqual({ request: mine, response: ok, rttMs: 30 })
    expect(pairs[1]).toEqual({ request: theirs, response: null, rttMs: null })
  })

  it('reads displayed fields as well as decoded ones', () => {
    const big = 2n ** 60n
    const sub = control('subscribe', displayFields('subscribe', { request_id: big }), {
      direction: 'tx',
    })
    const ok = control('subscribe_ok', displayFields('subscribe_ok', { request_id: big }), {
      direction: 'rx',
    })
    expect(pairRequests([sub, ok])[0]?.response).toBe(ok)
  })

  it('pairs draft-17 and draft-22 responses by the stream they came back on', () => {
    for (const codec of [createDraft17Codec(), createDraft22Codec()]) {
      const draft = Number(codec.draft)
      const a = control('subscribe', { request_id: 0n }, { direction: 'tx', streamId: 4, atMs: 0 })
      const b = control('subscribe', { request_id: 2n }, { direction: 'tx', streamId: 8, atMs: 1 })
      const err = control(
        'request_error',
        decoded(codec as never, {
          type: 'request_error',
          error_code: 0x10n,
          retry_interval: 0n,
          reason_phrase: 'gone',
        }),
        { direction: 'rx', streamId: 8, atMs: 21 },
      )
      const ok = control(
        'request_ok',
        { parameters: {} },
        { direction: 'rx', streamId: 4, atMs: 50 },
      )
      expect(pairRequests([a, b, err, ok], { draft })).toEqual([
        { request: a, response: ok, rttMs: 50 },
        { request: b, response: err, rttMs: 20 },
      ])
    }
  })

  it('does not pair by stream before draft-17, where every request shares one', () => {
    const sub = control('subscribe', { request_id: 0n }, { direction: 'tx', streamId: 0 })
    const ok = control('request_ok', {}, { direction: 'rx', streamId: 0 })
    expect(pairRequests([sub, ok], { draft: 16 })[0]?.response).toBeNull()
  })

  it('keeps connections apart', () => {
    const sub = control('subscribe', {}, { connection: 'a', streamId: 4 })
    const ok = control('request_ok', {}, { connection: 'b', streamId: 4 })
    expect(pairRequests([sub, ok], { draft: 22 })[0]?.response).toBeNull()
  })

  it('takes the first response and ignores a second', () => {
    const sub = control('subscribe', { request_id: 1n })
    const one = control('subscribe_ok', { request_id: 1n })
    const two = control('subscribe_error', { request_id: 1n })
    expect(pairRequests([sub, one, two])[0]?.response).toBe(one)
  })
})

describe('problems', () => {
  it('names errors by the draft and links them to their request', () => {
    const sub = control('subscribe', { request_id: 4n }, { direction: 'tx', atMs: 0 })
    const err = control(
      'SUBSCRIBE_ERROR',
      { request_id: 4n, error_code: 4n, reason_phrase: 'nope' },
      { direction: 'rx', atMs: 10 },
    )
    expect(problems([sub, err], { pendingMs: 5000, draft: 14 })).toEqual([
      {
        kind: 'error',
        atMs: 10,
        event: err,
        message: 'SUBSCRIBE_ERROR',
        code: '4',
        codeName: 'TRACK_DOES_NOT_EXIST',
        reason: 'nope',
        request: sub,
      },
    ])
  })

  it('leaves an unknown code unnamed', () => {
    const err = control('request_error', { error_code: 0x32n, reason_phrase: '' })
    const [problem] = problems([err], { pendingMs: 5000, draft: 22 })
    expect(problem).toMatchObject({ kind: 'error', code: '50', codeName: null })
  })

  it('marks a request with no response once it passes the threshold', () => {
    const sub = control('subscribe', { request_id: 0n }, { direction: 'tx', atMs: 1000 })
    const last = control('goaway', { new_session_uri: '' }, { direction: 'rx', atMs: 4000 })
    expect(problems([sub, last], { pendingMs: 5000, draft: 14 }).map((p) => p.kind)).toEqual([
      'goaway',
    ])
    expect(problems([sub, last], { pendingMs: 5000, draft: 14, endMs: 7000 })).toEqual([
      { kind: 'goaway', atMs: 4000, event: last, newSessionUri: null },
      { kind: 'pending', atMs: 6000, event: sub, requestId: '0', response: null, waitedMs: 6000 },
    ])
  })

  it('marks a request answered after the threshold, with its response', () => {
    const sub = control('subscribe', {}, { direction: 'tx', streamId: 4, atMs: 0 })
    const ok = control(
      'subscribe_ok',
      { track_alias: 1n },
      { direction: 'rx', streamId: 4, atMs: 900 },
    )
    expect(problems([sub, ok], { pendingMs: 500, draft: 17 })).toEqual([
      { kind: 'pending', atMs: 500, event: sub, requestId: null, response: ok, waitedMs: 900 },
    ])
    expect(problems([sub, ok], { pendingMs: 1000, draft: 17 })).toEqual([])
  })

  it('counts repeated REQUESTS_BLOCKED at one maximum on the first', () => {
    const codec = createDraft14Codec()
    const blocked = () =>
      control('requests_blocked', decoded(codec, { type: 'requests_blocked', request_id: 10n }), {
        direction: 'tx',
      })
    const events = [blocked(), blocked(), blocked()]
    expect(problems(events, { pendingMs: 5000, draft: 14 })).toEqual([
      { kind: 'requests-blocked', atMs: null, event: events[0], maximumRequestId: '10', count: 3 },
    ])
  })

  it('reads SUBSCRIBES_BLOCKED before draft-11', () => {
    const blocked = control('subscribes_blocked', { maximum_subscribe_id: 5n })
    expect(problems([blocked], { pendingMs: 5000, draft: 8 })).toMatchObject([
      { kind: 'requests-blocked', maximumRequestId: '5', count: 1 },
    ])
  })

  it('marks the request that uses the last id the peer allowed', () => {
    const setup = control(
      'server_setup',
      { selected_version: 0xff00000en, parameters: { max_request_id: 4n } },
      { direction: 'rx', atMs: 0 },
    )
    const subs = [0n, 2n].map((id, i) =>
      control('subscribe', { request_id: id }, { direction: 'tx', atMs: 10 + i }),
    )
    const raised = control('max_request_id', { request_id: 8n }, { direction: 'rx', atMs: 20 })
    const third = control('subscribe', { request_id: 4n }, { direction: 'tx', atMs: 30 })
    const found = problems([setup, ...subs, raised, third], { pendingMs: 5000, draft: 14 })
    expect(found).toEqual([
      { kind: 'request-limit-reached', atMs: 11, event: subs[1], requestId: '2', limit: '4' },
    ])
  })

  it('steps draft-07 subscribe ids by one', () => {
    const limit = control('max_subscribe_id', { subscribe_id: 2n }, { direction: 'rx' })
    const sub = (id: bigint) => control('subscribe', { subscribe_id: id }, { direction: 'tx' })
    const found = problems([limit, sub(0n), sub(1n)], { pendingMs: 5000, draft: 7 })
    expect(found).toMatchObject([{ kind: 'request-limit-reached', requestId: '1', limit: '2' }])
  })

  it('reports GOAWAY with its new URI and undecodable bytes, in time order', () => {
    const undecodable: InspectEvent = { kind: 'undecodable', reason: 'bad varint', atMs: 2 }
    const goaway = control('GOAWAY', { new_session_uri: 'https://relay.example/b' }, { atMs: 1 })
    expect(problems([goaway, undecodable], { pendingMs: 5000, draft: 22 })).toEqual([
      { kind: 'goaway', atMs: 1, event: goaway, newSessionUri: 'https://relay.example/b' },
      { kind: 'undecodable', atMs: 2, event: undecodable, reason: 'bad varint' },
    ])
  })

  it('finds nothing in a healthy session', () => {
    const sub = control('subscribe', { request_id: 0n }, { direction: 'tx', atMs: 0 })
    const ok = control('subscribe_ok', { request_id: 0n }, { direction: 'rx', atMs: 20 })
    expect(problems([sub, ok], { pendingMs: 5000, draft: 14, endMs: 60_000 })).toEqual([])
  })
})
