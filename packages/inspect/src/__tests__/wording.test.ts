import { createDraft14Codec } from '@moqtap/codec/draft14'
import { describe, expect, it } from 'vitest'
import { displayFields } from '../display.js'
import { type ControlEvent, problems, requestIdOf } from '../requests.js'
import {
  codeLabel,
  durationText,
  problemDetail,
  problemSeverity,
  problemTitle,
} from '../wording.js'

const T = '\u2009'

function control(
  name: string,
  fields: Record<string, unknown>,
  extra: Partial<ControlEvent> = {},
): ControlEvent {
  return { name, fields, ...extra }
}

describe('codeLabel', () => {
  it('names the code, or says the draft has no name for it', () => {
    expect(codeLabel('4', 'TRACK_DOES_NOT_EXIST', 14)).toBe('TRACK_DOES_NOT_EXIST (0x4)')
    expect(codeLabel(4n, null, 14)).toBe('0x4, unknown for draft-14')
    expect(codeLabel(50, null, 7)).toBe('0x32, unknown for draft-07')
    expect(codeLabel('4', null, null)).toBe('0x4')
    expect(codeLabel(null, null, 14)).toBe('')
  })
})

describe('problemSeverity', () => {
  it('calls a failure an error and the rest warnings', () => {
    expect(problemSeverity('error')).toBe('error')
    expect(problemSeverity('undecodable')).toBe('error')
    for (const kind of [
      'pending',
      'requests-blocked',
      'request-limit-reached',
      'goaway',
    ] as const) {
      expect(problemSeverity(kind)).toBe('warning')
    }
  })
})

describe('requestIdOf', () => {
  it('reads the id raw or displayed, and not from a limit message', () => {
    expect(requestIdOf('SUBSCRIBE', { request_id: 14n })).toBe('14')
    expect(requestIdOf('subscribe', { subscribe_id: 3 })).toBe('3')
    expect(requestIdOf('FETCH', { requestId: '9007199254740993' })).toBe('9007199254740993')
    const codec = createDraft14Codec()
    const bytes = codec.encodeMessage({
      type: 'subscribe_ok',
      request_id: 2n ** 60n,
      track_alias: 1n,
      expires: 0n,
      group_order: 1,
      content_exists: 0,
      parameters: new Map(),
    } as never)
    const decoded = codec.decodeMessage(bytes)
    if (!decoded.ok) throw new Error('did not decode')
    const shown = displayFields('subscribe_ok', { ...decoded.value })
    expect(requestIdOf('SUBSCRIBE_OK', shown)).toBe((2n ** 60n).toString())
    expect(requestIdOf('MAX_REQUEST_ID', { request_id: 20n })).toBeNull()
    expect(requestIdOf('SUBSCRIBE', {})).toBeNull()
    expect(requestIdOf('SUBSCRIBE', undefined)).toBeNull()
  })
})

describe('durationText', () => {
  it('reads as a person would say it', () => {
    expect(durationText(340.4)).toBe(`340${T}ms`)
    expect(durationText(5000)).toBe(`5${T}s`)
    expect(durationText(7240)).toBe(`7.2${T}s`)
    expect(durationText(125_000)).toBe(`2${T}min 5${T}s`)
  })
})

describe('problemTitle and problemDetail', () => {
  const track = (event: ControlEvent) =>
    event.name === 'subscribe' ? 'live/ch4 / video/1080p' : undefined

  it('words an error with the request it answers', () => {
    const request = control('subscribe', { request_id: 14n }, { direction: 'tx', atMs: 100 })
    const error = control(
      'subscribe_error',
      { request_id: 14n, error_code: 4n, reason_phrase: 'no such track' },
      { direction: 'rx', atMs: 220 },
    )
    const [problem] = problems([request, error], { draft: 14, pendingMs: 5000 })
    const options = { draft: 14, pendingMs: 5000, trackOf: track }
    expect(problemTitle(problem!, options)).toBe(
      'SUBSCRIBE_ERROR TRACK_DOES_NOT_EXIST (0x4) "no such track"',
    )
    expect(problemDetail(problem!, options)).toBe(
      `Answers SUBSCRIBE #14 live/ch4 / video/1080p after 120${T}ms`,
    )
  })

  it('says a code the draft does not define is unknown for it', () => {
    const error = control('subscribe_error', {
      request_id: 1n,
      error_code: 0x99n,
      reason_phrase: '',
    })
    const [problem] = problems([error], { draft: 14, pendingMs: 5000 })
    expect(problemTitle(problem!, { draft: 14, pendingMs: 5000 })).toBe(
      'SUBSCRIBE_ERROR 0x99, unknown for draft-14',
    )
    expect(problemDetail(problem!, { draft: 14, pendingMs: 5000 })).toBeNull()
  })

  it('words a pending request by the threshold, or by how long the response took', () => {
    const sub = control('subscribe', { request_id: 2n }, { direction: 'tx', atMs: 0 })
    const late = control('subscribe_ok', { request_id: 2n }, { direction: 'rx', atMs: 7240 })
    const options = { draft: 14, pendingMs: 5000, trackOf: track }
    const [unanswered] = problems([sub], { ...options, endMs: 9000 })
    expect(problemTitle(unanswered!, options)).toBe(`SUBSCRIBE #2: no response after 5${T}s`)
    expect(problemDetail(unanswered!, options)).toBe('live/ch4 / video/1080p')
    const [answered] = problems([sub, late], options)
    expect(problemTitle(answered!, options)).toBe(`SUBSCRIBE #2: response after 7.2${T}s`)
  })

  it('words blocked requests, an exhausted limit and undecodable bytes', () => {
    const blocked = control('requests_blocked', { maximum_request_id: 20n }, { direction: 'tx' })
    const [b] = problems([blocked, blocked, blocked], { draft: 14, pendingMs: 5000 })
    expect(problemTitle(b!, { pendingMs: 5000 })).toBe(
      'REQUESTS_BLOCKED at request ID 20 (3 times)',
    )
    const limit = control('max_request_id', { request_id: 20n }, { direction: 'rx' })
    const sub = control('subscribe', { request_id: 18n }, { direction: 'tx' })
    const [l] = problems([limit, sub], { draft: 14, pendingMs: 5000 })
    expect(problemTitle(l!, { pendingMs: 5000 })).toBe(
      'Request ID limit 20 reached by SUBSCRIBE #18',
    )
    const [u] = problems([{ kind: 'undecodable', reason: 'truncated varint' }], { pendingMs: 5000 })
    expect(problemTitle(u!, { pendingMs: 5000 })).toBe('Undecodable bytes: truncated varint')
  })

  it('says who sent a GOAWAY from the recording end', () => {
    const goaway = (direction: 'tx' | 'rx', uri: string) =>
      problems([control('goaway', { new_session_uri: uri }, { direction })], {
        pendingMs: 5000,
      })[0]!
    const fromRelay = goaway('rx', 'moqt://b.example')
    expect(problemTitle(fromRelay, { pendingMs: 5000, perspective: 'client' })).toBe(
      'GOAWAY from relay → moqt://b.example',
    )
    expect(problemTitle(fromRelay, { pendingMs: 5000, perspective: 'server' })).toBe(
      'GOAWAY from client → moqt://b.example',
    )
    expect(problemTitle(goaway('tx', ''), { pendingMs: 5000 })).toBe('GOAWAY sent')
    const [bare] = problems([control('goaway', {})], { pendingMs: 5000 })
    expect(problemTitle(bare!, { pendingMs: 5000 })).toBe('GOAWAY')
  })
})
