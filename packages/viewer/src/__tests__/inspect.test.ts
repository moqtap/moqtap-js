/**
 * What the viewer makes of a session's control messages and the collector's
 * delivery records: requests paired with their responses, problems in time
 * order, connections kept apart, and the rollups, flight dumps, detail
 * windows and player events placed on the trace's clock.
 *
 * Through `handle()`, the function the worker runs, on traces written here.
 */

import { type TraceEvent, writeMoqtrace } from '@moqtap/trace'
import { describe, expect, it } from 'vitest'
import type { TraceAnalysis } from '../analysis'
import { handle } from '../worker'

type Draft = Omit<TraceEvent, 'seq'>

const START = 1_767_225_600_000
const SECOND = 1_000_000
/** The thin space between a number and its unit. */
const THIN = String.fromCharCode(0x2009)

function analyse(events: Draft[], options: { protocol?: string; pendingMs?: number } = {}) {
  const bytes = writeMoqtrace({
    header: {
      protocol: options.protocol ?? 'moq-transport-14',
      perspective: 'client',
      detail: 'control',
      startTime: START,
    },
    events: events.map((e, seq) => ({ ...e, seq }) as TraceEvent),
  })
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  const response = handle({
    bytes: buffer as ArrayBuffer,
    ...(options.pendingMs === undefined ? {} : { pendingMs: options.pendingMs }),
  })
  if (!response.ok) throw new Error(response.message)
  return response.analysis
}

const control = (
  timestamp: number,
  messageType: number,
  direction: 0 | 1,
  message: object,
  extra: Partial<Draft> = {},
): Draft => ({ type: 'control', timestamp, messageType, direction, message, ...extra }) as Draft

const annotation = (timestamp: number, label: string, data: unknown, peer?: string): Draft =>
  ({ type: 'annotation', timestamp, label, data, ...(peer === undefined ? {} : { peer }) }) as Draft

const subscribe = (timestamp: number, id: number, name: string, peer?: string) =>
  control(
    timestamp,
    0x3,
    0,
    { request_id: BigInt(id), track_namespace: ['live', 'ch4'], track_name: name },
    peer === undefined ? {} : { peer },
  )

const named = (analysis: TraceAnalysis, name: string) =>
  analysis.messages.findIndex((m) => m.name === name)

describe('requests and their responses', () => {
  const session = () =>
    analyse([
      subscribe(1 * SECOND, 2, 'video'),
      control(1.212 * SECOND, 0x4, 1, { request_id: 2n, track_alias: 9n }),
      control(2 * SECOND, 0x2, 0, { request_id: 2n, subscriber_priority: 1 }),
      subscribe(3 * SECOND, 4, 'audio'),
      control(3.5 * SECOND, 0x5, 1, {
        request_id: 4n,
        error_code: 0x4n,
        reason_phrase: 'no such rendition',
      }),
      subscribe(4 * SECOND, 6, 'subtitles'),
      control(4.1 * SECOND, 0x5, 1, { request_id: 6n, error_code: 0x99n, reason_phrase: '' }),
    ])

  it('gives a request its response and the time between them, and the response its request', () => {
    const analysis = session()
    const request = analysis.messages[0]!
    expect(request.requestId).toBe('2')
    expect(request.response).toEqual({
      index: 1,
      name: 'SUBSCRIBE_OK',
      requestId: '2',
      rttUs: 212_000,
    })
    expect(analysis.messages[1]!.answers).toMatchObject({
      index: 0,
      name: 'SUBSCRIBE',
      rttUs: 212_000,
    })
  })

  it('threads what followed under the same request with it', () => {
    const analysis = session()
    expect(analysis.messages.slice(0, 3).map((m) => m.thread)).toEqual([0, 0, 0])
    expect(analysis.messages[3]!.thread).toBe(3)
  })

  it('names an error code from the draft, and says when the draft has no name for it', () => {
    const analysis = session()
    const known = analysis.messages[named(analysis, 'SUBSCRIBE_ERROR')]!
    expect(known.error).toEqual({
      code: '4',
      codeName: 'TRACK_DOES_NOT_EXIST',
      label: 'TRACK_DOES_NOT_EXIST (0x4)',
      reason: 'no such rendition',
    })
    const errors = analysis.problems.filter((p) => p.kind === 'error')
    expect(errors.map((p) => [p.title, p.detail])).toEqual([
      [
        'SUBSCRIBE_ERROR TRACK_DOES_NOT_EXIST (0x4) "no such rendition"',
        `Answers SUBSCRIBE #4 live/ch4 / audio after 500${THIN}ms`,
      ],
      [
        'SUBSCRIBE_ERROR 0x99, unknown for draft-14',
        `Answers SUBSCRIBE #6 live/ch4 / subtitles after 100${THIN}ms`,
      ],
    ])
    expect(analysis.findings.filter((f) => f.id === 'error-response')).toHaveLength(2)
  })

  it('gives a renamed message its names in other drafts', () => {
    const analysis = analyse([
      control(SECOND, 0x6, 0, { request_id: 2n, track_namespace: ['live'] }),
    ])
    expect(analysis.messages[0]!.name).toBe('PUBLISH_NAMESPACE')
    expect(analysis.messages[0]!.aliases).toEqual(['ANNOUNCE'])
  })
})

describe('requests nothing can pair', () => {
  it('says so for a request recorded with no fields, rather than leave it looking answered', () => {
    const analysis = analyse([control(SECOND, 0x3, 0, {}), control(2 * SECOND, 0x4, 1, {})])
    const finding = analysis.findings.find((f) => f.id === 'requests-unpairable')
    expect(finding?.title).toBe('1 request with no fields to match a response by')
    expect(analysis.messages[0]!.response).toBeUndefined()
  })
})

describe('the pending threshold', () => {
  const events = () => [
    subscribe(1 * SECOND, 2, 'video'),
    subscribe(2 * SECOND, 4, 'audio'),
    control(9 * SECOND, 0x4, 1, { request_id: 4n, track_alias: 1n }),
    annotation(10 * SECOND, 'player.ready', null),
  ]

  it('marks a request with no response past 5 s, and one answered late, by default', () => {
    const analysis = analyse(events())
    expect(analysis.pendingMs).toBe(5000)
    const pending = analysis.problems.filter((p) => p.kind === 'pending')
    expect(pending.map((p) => [p.title, p.at])).toEqual([
      [`SUBSCRIBE #2: no response after 5${THIN}s`, 6 * SECOND],
      [`SUBSCRIBE #4: response after 7${THIN}s`, 7 * SECOND],
    ])
    expect(analysis.messages[0]!.pending).toEqual({ waitedUs: 9 * SECOND, answered: false })
    expect(analysis.messages[1]!.pending).toEqual({ waitedUs: 7 * SECOND, answered: true })
    expect(analysis.findings.map((f) => f.id)).toContain('request-pending')
  })

  it('takes the threshold the parent sent', () => {
    const analysis = analyse(events(), { pendingMs: 60_000 })
    expect(analysis.problems.filter((p) => p.kind === 'pending')).toEqual([])
    expect(analysis.messages[0]!.pending).toBeUndefined()
  })
})

describe('undecodable bytes', () => {
  it('keeps bytes that did not decode on a control stream in the log, never named', () => {
    const analysis = analyse([
      control(SECOND, 0x3, 0, { request_id: 2n, track_namespace: [], track_name: 'a' }),
      {
        type: 'error',
        timestamp: 2 * SECOND,
        errorCode: 0,
        reason: 'control frame did not decode',
        errorKind: 'decode',
        streamId: 0n,
      } as Draft,
      {
        type: 'stream-opened',
        timestamp: 3 * SECOND,
        streamId: 6n,
        direction: 1,
        streamType: 0,
      } as Draft,
      {
        type: 'error',
        timestamp: 4 * SECOND,
        errorCode: 0,
        reason: 'object decode failed',
        errorKind: 'decode',
        streamId: 6n,
      } as Draft,
    ])
    expect(analysis.messages).toHaveLength(2)
    const row = analysis.messages[1]!
    expect(row).toMatchObject({
      name: null,
      messageType: null,
      direction: null,
      undecodable: 'control frame did not decode',
    })
    expect(analysis.problems.map((p) => p.kind)).toEqual(['undecodable'])
  })
})

describe('connections', () => {
  const twoConnections = () =>
    analyse([
      { type: 'peer-connected', timestamp: 0, peer: 'c1', role: 'subscriber' } as Draft,
      annotation(
        0,
        'collector.conn-open',
        { conn: 'c1', realm: 'page', roles: ['subscriber'] },
        'c1',
      ),
      { type: 'peer-connected', timestamp: 0, peer: 'c2' } as Draft,
      annotation(0, 'collector.conn-open', { conn: 'c2', realm: 'worker' }, 'c2'),
      subscribe(SECOND, 2, 'video', 'c1'),
      control(1.1 * SECOND, 0x4, 1, { request_id: 2n, track_alias: 1n }, { peer: 'c1' }),
      subscribe(SECOND, 2, 'audio', 'c2'),
      control(1.2 * SECOND, 0x4, 1, { request_id: 2n, track_alias: 1n }, { peer: 'c2' }),
      { type: 'peer-disconnected', timestamp: 5 * SECOND, peer: 'c2', errorCode: 0 } as Draft,
      annotation(5 * SECOND, 'collector.conn-close', { cause: 'worker-gone' }, 'c2'),
    ])

  it('lists each connection once, in order, with what the collector said of it', () => {
    expect(twoConnections().connections).toEqual([
      { id: 'c1', label: 'Connection 1', openedAt: 0, realm: 'page', roles: ['subscriber'] },
      {
        id: 'c2',
        label: 'Connection 2',
        openedAt: 0,
        realm: 'worker',
        closedAt: 5 * SECOND,
        cause: 'worker-gone',
      },
    ])
  })

  it('keeps one track registry per connection, so a reused id names two tracks', () => {
    const analysis = twoConnections()
    expect(analysis.tracks.map((t) => [t.connection, t.name, t.alias])).toEqual([
      ['c1', 'live/ch4 / video', '1'],
      ['c2', 'live/ch4 / audio', '1'],
    ])
    // A response pairs only with a request on its own connection.
    expect(analysis.messages[1]!.answers?.index).toBe(0)
    expect(analysis.messages[3]!.answers?.index).toBe(2)
  })

  it('treats a trace with no p as one connection', () => {
    expect(analyse([subscribe(SECOND, 2, 'video')]).connections).toEqual([])
  })
})

describe('delivery from the collector', () => {
  const key = (d: string, v: string) => ({ d, k: 'alias', v, e: 0 })
  const rollup = (at: number, startMono: number, endMono: number, tracks: object[]) =>
    annotation(
      at,
      'collector.rollup',
      { conn: 'c1', seq: 0, startMono, endMono, tracks, session: {} },
      'c1',
    )
  const row = (k: object, fields: object) => ({
    key: k,
    firstSeen: 0,
    lastSeen: 0,
    objects: 0,
    payloadBytes: 0,
    headerBytes: 0,
    groups: 0,
    groupGaps: 0,
    outOfOrder: 0,
    duplicates: 0,
    statusObjects: 0,
    parseFailures: 0,
    hist: {},
    ...fields,
  })

  // The rollup's record time is its interval's end; here the collector's
  // clock runs half a second behind the trace's.
  const session = () =>
    analyse([
      subscribe(0.5 * SECOND, 2, 'video', 'c1'),
      control(0.6 * SECOND, 0x4, 1, { request_id: 2n, track_alias: 9n }, { peer: 'c1' }),
      rollup(10.5 * SECOND, 0, 10_000, [
        row(key('rx', '9'), {
          firstSeen: 300,
          objects: 120,
          groups: 5,
          hist: {
            groupCadenceMs: { i: [10, 11], c: [3, 1], n: 4, sum: 7000 },
            interArrivalMs: { i: [4, 5, 6], c: [100, 15, 4], n: 119, sum: 3000 },
          },
        }),
      ]),
      rollup(20.5 * SECOND, 10_000, 20_000, [
        row(key('rx', '9'), {
          firstSeen: 10_100,
          objects: 80,
          groups: 4,
          groupGaps: 1,
          statusObjects: 2,
          hist: { stallMs: { i: [8, 11], c: [1, 1], n: 2, sum: 2700 } },
        }),
        row(key('tx', '3'), { objects: 40, payloadBytes: 4096, blockedMs: 12, ackedBytes: 4000 }),
      ]),
    ])

  it('places each rollup interval as a cell on the trace clock, with what it counted', () => {
    const { cells } = session().delivery
    expect(
      cells.map((c) => [c.lane, c.from, c.to, c.objects, c.stalls, c.longestStall, c.groupGaps]),
    ).toEqual([
      ['c1|rx:alias:9', 0.5 * SECOND, 10.5 * SECOND, 120, 0, null, 0],
      ['c1|rx:alias:9', 10.5 * SECOND, 20.5 * SECOND, 80, 2, 11, 1],
      ['c1|tx:alias:3', 10.5 * SECOND, 20.5 * SECOND, 40, 0, null, 0],
    ])
  })

  it('joins the received stats to the track its alias names', () => {
    const video = session().tracks.find((t) => t.name === 'live/ch4 / video')!
    expect(video.lanes).toEqual(['c1|rx:alias:9'])
    expect(video.received).toMatchObject({
      firstObjectAt: 0.8 * SECOND,
      objects: 200,
      groups: 9,
      groupGaps: 1,
      skipped: 2,
      stalls: 2,
      longestStall: 11,
      cadenceP50: 10,
      cadenceP95: 11,
      arrivalP95: 5,
    })
  })

  it('reports a track it sent on, which no recorded request named, with its send side', () => {
    const sent = session().tracks.find((t) => t.sent !== undefined)!
    expect(sent).toMatchObject({ key: 'c1|tx:alias:3', name: '', alias: '3', connection: 'c1' })
    expect(sent.sent).toMatchObject({
      objects: 40,
      payloadBytes: 4096,
      blockedMs: 12,
      ackedBytes: 4000,
    })
  })

  it('places a flight dump and the stalls inside it exactly', () => {
    const analysis = analyse([
      rollup(10.5 * SECOND, 0, 10_000, [row(key('rx', '9'), { objects: 1 })]),
      annotation(
        8.5 * SECOND,
        'collector.flight',
        {
          conn: 'c1',
          trigger: 'stall',
          windowStart: 5000,
          windowEnd: 8000,
          truncated: false,
          cols: {
            key: ['rx:alias:9:0', 'rx:alias:9:0', 'rx:alias:9:0', 'rx:alias:9:0'],
            at: [5000, 5033, 5066, 7066],
            group: [1, 1, 1, 2],
            object: [0, 1, 2, 0],
            bytes: [100, 100, 100, 100],
            deliveryMs: [1, 1, 1, 1],
          },
        },
        'c1',
      ),
    ])
    const [flight] = analysis.delivery.flights
    expect(flight).toMatchObject({
      connection: 'c1',
      trigger: 'stall',
      from: 5.5 * SECOND,
      to: 8.5 * SECOND,
    })
    expect(flight!.objects).toHaveLength(4)
    expect(flight!.stalls).toEqual([
      { lane: 'c1|rx:alias:9', from: 5.566 * SECOND, to: 7.566 * SECOND },
    ])
  })

  it('draws a band where detail was raised, from the escalation that opened it to the one that closed it', () => {
    const analysis = analyse([
      annotation(3 * SECOND, 'collector.escalation', {
        from: 'baseline',
        to: 'headers',
        by: { kind: 'trigger', trigger: 'stall' },
      }),
      annotation(18 * SECOND, 'collector.escalation', {
        from: 'headers',
        to: 'baseline',
        by: { kind: 'window', closed: 'timeout' },
      }),
      annotation(20 * SECOND, 'collector.escalation', {
        from: 'baseline',
        to: 'headers+sizes',
        by: { kind: 'manual' },
      }),
    ])
    expect(analysis.delivery.bands).toEqual([
      { from: 3 * SECOND, to: 18 * SECOND, level: 'headers', cause: 'stall' },
      { from: 20 * SECOND, to: null, level: 'headers+sizes', cause: 'escalate()' },
    ])
  })

  it("takes the player's annotations as player events, and nothing the collector or Insight wrote", () => {
    const analysis = analyse([
      annotation(SECOND, 'bitrate-down', { to: 720 }),
      annotation(2 * SECOND, 'rebuffer', null, 'c1'),
      annotation(3 * SECOND, 'collector.batch', { segmentSeq: 0 }),
      annotation(0, 'insight.missing-segment', { segmentSeq: 3 }),
    ])
    expect(analysis.delivery.playerEvents).toEqual([
      { at: SECOND, label: 'bitrate-down', data: '{"to":720}' },
      { at: 2 * SECOND, label: 'rebuffer', connection: 'c1' },
    ])
  })
})
