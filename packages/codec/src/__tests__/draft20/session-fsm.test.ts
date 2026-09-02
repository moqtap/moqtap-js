/**
 * Draft-20's behavioural changes live almost entirely in the session state
 * machine rather than in the byte layer, and the vector corpus cannot reach
 * them: fill fetch streams carry no control message of their own, and
 * PUBLISH_STATE_NOTIFY's rules are about which stream it arrived on, which a
 * single-message vector has no way to express. These are those rules.
 */

import { describe, expect, it } from 'vitest'
import { createDraft20SessionState } from '../../drafts/draft20/session.js'
import type { Draft20Message, Draft20Params } from '../../drafts/draft20/types.js'

function ready(role: 'client' | 'server' = 'client') {
  const fsm = createDraft20SessionState(role)
  fsm.send({ type: 'setup', options: {} })
  fsm.receive({ type: 'setup', options: {} })
  expect(fsm.phase).toBe('ready')
  return fsm
}

function subscribe(requestId: bigint, parameters: Draft20Params): Draft20Message {
  return {
    type: 'subscribe',
    request_id: requestId,
    track_namespace: ['live'],
    track_name: 'video',
    parameters,
  }
}

describe('draft-20 fill fetch streams (Section 5.1.3)', () => {
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

  it('opens none when the SUBSCRIBE carries no FILL_PARAMETERS', () => {
    const fsm = ready()
    fsm.send(subscribe(1n, {}))
    expect(fsm.fillFetchStreamsFor(1n).size).toBe(0)
  })

  it('opens none while Forward State is 0, and not later either (Section 5.1.3.1)', () => {
    const fsm = ready()
    // FILL_PARAMETERS carried while Forward State is 0 opens nothing.
    fsm.send(subscribe(1n, { forward: 0n, fill_parameters: {} }))
    expect(fsm.forwardStateOf(1n)).toBe(0)
    expect(fsm.fillFetchStreamsFor(1n).size).toBe(0)

    // "Transitioning to Forward State 1 without re-sending FILL_PARAMETERS
    // does not open one either."
    fsm.sendOn(1n, { type: 'request_update', request_id: 2n, parameters: { forward: 1n } })
    expect(fsm.forwardStateOf(1n)).toBe(1)
    expect(fsm.fillFetchStreamsFor(1n).size).toBe(0)

    // Re-sending them does.
    fsm.sendOn(1n, { type: 'request_update', request_id: 3n, parameters: { fill_parameters: {} } })
    expect([...fsm.fillFetchStreamsFor(1n).keys()]).toEqual([3n])
  })

  it('keeps several open at once, keyed by the Request ID that opened each', () => {
    // The draft-19 Joining FETCH model — one fetch stream per subscription —
    // is wrong here: "opening a new fill fetch stream does not implicitly
    // cancel any previously opened fill fetch streams."
    const fsm = ready()
    fsm.send(subscribe(1n, { fill_parameters: {} }))
    fsm.sendOn(1n, { type: 'request_update', request_id: 5n, parameters: { fill_parameters: {} } })
    fsm.sendOn(1n, { type: 'request_update', request_id: 9n, parameters: { fill_parameters: {} } })

    const fills = fsm.fillFetchStreamsFor(1n)
    expect([...fills.keys()]).toEqual([1n, 5n, 9n])
    for (const fill of fills.values()) {
      expect(fill.phase).toBe('open')
      expect(fill.subscribeId).toBe(1n)
    }
  })

  it('rejects FILL_PARAMETERS on a REQUEST_UPDATE for anything but a subscription', () => {
    const fsm = ready()
    fsm.send({
      type: 'subscribe_tracks',
      request_id: 3n,
      namespace_prefix: ['live'],
      parameters: {},
    })
    const result = fsm.sendOn(3n, {
      type: 'request_update',
      request_id: 4n,
      parameters: { fill_parameters: {} },
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.violation.message).toContain('subscribe_tracks')
  })

  it('never shows a fill fetch stream as a FETCH, and rejects a FETCH_OK for one (D7 / Q9)', () => {
    const fsm = ready()
    fsm.send(subscribe(1n, { fill_parameters: {} }))
    // A fill is a FETCH *response* with no FETCH request behind it.
    expect(fsm.fetches.size).toBe(0)
    expect(fsm.requestKindOf(1n)).toBe('subscription')

    // There is no FETCH_OK for a fill, so no End Location and no End Of Track;
    // stream FIN is the only end signal. One arriving is a violation, not
    // something to synthesize.
    const result = fsm.receiveOn(1n, {
      type: 'fetch_ok',
      end_of_track: 0,
      end_group: 3n,
      end_object: 4n,
      parameters: {},
      track_properties: {},
    })
    expect(result.ok).toBe(false)
  })

  it('ends a fill on a transport event, leaving the subscription alone', () => {
    const fsm = ready()
    fsm.send(subscribe(1n, { fill_parameters: {} }))
    fsm.sendOn(1n, { type: 'request_update', request_id: 5n, parameters: { fill_parameters: {} } })

    // A reset signals fill failure — there is no REQUEST_ERROR for a fill.
    expect(fsm.closeFillFetchStream(5n, 'reset')).toEqual([
      { type: 'fill-fetch-stream-closed', subscribeId: 1n, requestId: 5n, reason: 'reset' },
    ])
    expect(fsm.fillFetchStreamsFor(1n).get(5n)?.phase).toBe('reset')
    // The other fill and the subscription itself are untouched.
    expect(fsm.fillFetchStreamsFor(1n).get(1n)?.phase).toBe('open')
    expect(fsm.subscriptions.get(1n)?.phase).toBe('pending')

    // A FIN is the completion signal.
    fsm.closeFillFetchStream(1n, 'complete')
    expect(fsm.fillFetchStreamsFor(1n).get(1n)?.phase).toBe('complete')
  })

  it('resets every open fill when the subscription ends', () => {
    const fsm = ready()
    fsm.receive({
      type: 'publish',
      request_id: 4n,
      track_namespace: ['live'],
      track_name: 'video',
      track_alias: 0n,
      parameters: {},
      track_properties: {},
    })
    fsm.sendOn(4n, { type: 'request_ok', parameters: {}, track_properties: {} })
    fsm.sendOn(4n, { type: 'request_update', request_id: 7n, parameters: { fill_parameters: {} } })
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
    expect(fsm.fillFetchStreamsFor(4n).get(7n)?.phase).toBe('reset')
  })
})

describe('draft-20 PUBLISH_STATE_NOTIFY (Section 10.10)', () => {
  const notify: Draft20Message = {
    type: 'publish_state_notify',
    parameters: { largest_object: { group: 10n, object: 3n } },
  }

  it('is accepted from the publisher on a subscription stream, with no reply expected', () => {
    const fsm = ready()
    // We sent the SUBSCRIBE, so the peer is the publisher.
    fsm.send(subscribe(1n, {}))
    const result = fsm.receiveOn(1n, notify)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.sideEffects).toEqual([{ type: 'subscription-state-notified', subscribeId: 1n }])
    // Unilateral: nothing was queued waiting for a REQUEST_OK, and the
    // subscription is still just pending on its SUBSCRIBE_OK.
    expect(fsm.subscriptions.get(1n)?.phase).toBe('pending')
  })

  it('is a violation from the subscriber', () => {
    const fsm = ready()
    fsm.send(subscribe(1n, {}))
    // We are the subscriber on request 1, so we may not send one.
    const result = fsm.sendOn(1n, notify)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.violation.code).toBe('ROLE_VIOLATION')
  })

  it('is a violation on any request type other than a subscription', () => {
    const fsm = ready()
    fsm.send({
      type: 'fetch',
      request_id: 2n,
      track_namespace: ['live'],
      track_name: 'video',
      parameters: {},
    })
    const result = fsm.receiveOn(2n, notify)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.violation.code).toBe('STATE_VIOLATION')
    expect(result.violation.message).toContain('fetch')
  })

  it('is not counted against MAX_REQUEST_UPDATES', () => {
    const fsm = ready()
    // The peer will accept one outstanding REQUEST_UPDATE from us.
    fsm.reset()
    fsm.send({ type: 'setup', options: {} })
    fsm.receive({ type: 'setup', options: { max_request_updates: 1n } })
    fsm.send(subscribe(1n, {}))

    expect(fsm.sendOn(1n, { type: 'request_update', request_id: 2n, parameters: {} }).ok).toBe(true)
    // Any number of notifications in between changes nothing.
    for (let i = 0; i < 5; i++) expect(fsm.receiveOn(1n, notify).ok).toBe(true)
    // The second update still trips the limit, and only a REQUEST_OK clears it.
    expect(fsm.sendOn(1n, { type: 'request_update', request_id: 3n, parameters: {} }).ok).toBe(
      false,
    )
    fsm.receiveOn(1n, { type: 'request_ok', parameters: {}, track_properties: {} })
    expect(fsm.sendOn(1n, { type: 'request_update', request_id: 4n, parameters: {} }).ok).toBe(true)
  })
})
