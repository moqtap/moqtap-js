import { describe, expect, it } from 'vitest'
import { type TrackFields, TrackRegistry, trackDisplayName, trackEventFrom } from '../tracks.js'

function registry() {
  const tracks = new Map<string, TrackFields>()
  return { tracks, reg: new TrackRegistry(tracks, (fields) => ({ ...fields })) }
}

describe('trackEventFrom', () => {
  it('reads a message by name in either case', () => {
    const msg = { request_id: 1n, track_namespace: ['live'], track_name: 'video' }
    expect(trackEventFrom('SUBSCRIBE', msg)).toEqual(trackEventFrom('subscribe', msg))
    expect(trackEventFrom('SUBSCRIBE', msg)).toMatchObject({
      kind: 'open',
      requestId: '1',
      trackNamespace: ['live'],
      trackName: 'video',
    })
  })

  it('reads byte-string names as text', () => {
    const msg = {
      request_id: 0,
      track_namespace: [new TextEncoder().encode('clock')],
      track_name: new TextEncoder().encode('now'),
    }
    expect(trackEventFrom('subscribe', msg)).toMatchObject({
      trackNamespace: ['clock'],
      trackName: 'now',
    })
  })

  it('says nothing about a message that is not about a track', () => {
    expect(trackEventFrom('GOAWAY', { new_session_uri: 'x' })).toBeNull()
  })
})

describe('TrackRegistry', () => {
  it('joins a draft-12+ alias from SUBSCRIBE_OK to the SUBSCRIBE that named the track', () => {
    const { reg } = registry()
    reg.apply(
      'SUBSCRIBE',
      { request_id: 4n, track_namespace: ['live', 'ch4'], track_name: 'video/1080p' },
      { direction: 'tx', timestamp: 10 },
    )
    const track = reg.apply(
      'SUBSCRIBE_OK',
      { request_id: 4n, track_alias: 9n },
      { direction: 'rx', timestamp: 30 },
    )
    expect(track).toMatchObject({ status: 'active', trackAlias: '9', subscribeOkAt: 30 })
    expect(reg.byAlias('9')?.trackName).toBe('video/1080p')
    expect(trackDisplayName(reg.byAlias('9')!)).toBe('live/ch4 / video/1080p')
  })

  it('follows a draft-17+ response by the stream its request opened', () => {
    const { reg } = registry()
    reg.apply(
      'subscribe',
      { request_id: 2n, track_namespace: ['a'], track_name: 'b' },
      { direction: 'tx', streamId: 4n },
    )
    expect(
      reg.apply('request_ok', { track_alias: 1n }, { direction: 'rx', streamId: 4 }),
    ).toMatchObject({ subscribeId: '2', trackAlias: '1', status: 'active' })
    expect(reg.apply('request_ok', { track_alias: 1n }, { direction: 'rx' })).toBeNull()
  })

  it('records a rejection with its reason', () => {
    const { reg } = registry()
    reg.apply('subscribe', { request_id: 1, track_name: 'x' }, { direction: 'tx' })
    expect(
      reg.apply(
        'SUBSCRIBE_ERROR',
        { request_id: 1, reason_phrase: 'not found' },
        { direction: 'rx', timestamp: 5 },
      ),
    ).toMatchObject({ status: 'error', errorReason: 'not found', subscribeErrorAt: 5 })
  })

  it('names a joining FETCH after the subscription it continues', () => {
    const { reg } = registry()
    reg.apply(
      'subscribe',
      { request_id: 1, track_namespace: ['ns'], track_name: 'n' },
      { direction: 'tx' },
    )
    const fetch = reg.apply(
      'fetch',
      { request_id: 3, joining: { joining_request_id: 1 } },
      { direction: 'tx' },
    )
    expect(fetch).toMatchObject({ via: 'fetch', trackNamespace: ['ns'], trackName: 'n' })
  })
})

describe('trackDisplayName', () => {
  it('writes a name alone when there is no namespace', () => {
    expect(trackDisplayName({ trackNamespace: [], trackName: 'video' })).toBe('video')
    expect(trackDisplayName({ trackNamespace: ['ns'], trackName: '' })).toBe('ns')
  })
})
