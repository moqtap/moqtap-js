import { describe, expect, it } from 'vitest'
import { messageAliases } from '../aliases.js'
import { errorName } from '../errors.js'

describe('errorName', () => {
  it("names a code from the session's draft, not a neighbour's", () => {
    // SUBSCRIBE_ERROR 0x4 moved from UNAUTHORIZED to TRACK_DOES_NOT_EXIST.
    expect(errorName(7, 'SUBSCRIBE_ERROR', 4)).toBe('UNAUTHORIZED')
    expect(errorName(14, 'SUBSCRIBE_ERROR', 4n)).toBe('TRACK_DOES_NOT_EXIST')
  })

  it('reads REQUEST_ERROR from draft-15 on', () => {
    expect(errorName(17, 'request_error', 0x10)).toBe('DOES_NOT_EXIST')
    expect(errorName(22, 'REQUEST_ERROR', 0x34n)).toBe('REDIRECT')
    expect(errorName(17, 'REQUEST_ERROR', 0x34n)).toBeNull()
  })

  it('has no name for a code the draft retired', () => {
    // INVALID_JOINING_REQUEST_ID went with joining fetches in draft-20.
    expect(errorName(17, 'REQUEST_ERROR', 0x32)).toBe('INVALID_JOINING_REQUEST_ID')
    expect(errorName(22, 'REQUEST_ERROR', 0x32)).toBeNull()
  })

  it('names status codes and session close codes', () => {
    expect(errorName(7, 'subscribe_done', 3)).toBe('TRACK_ENDED')
    expect(errorName(14, 'PUBLISH_DONE', 2)).toBe('TRACK_ENDED')
    expect(errorName(22, 'session', 0x10)).toBe('GOAWAY_TIMEOUT')
    expect(errorName(14, 'stream_reset', 2)).toBe('DELIVERY_TIMEOUT')
  })

  it('answers null rather than guess', () => {
    expect(errorName(null, 'SUBSCRIBE_ERROR', 0)).toBeNull()
    expect(errorName(99, 'SUBSCRIBE_ERROR', 0)).toBeNull()
    // Draft-07 has no ANNOUNCE_ERROR registry; draft-17 has no SUBSCRIBE_ERROR.
    expect(errorName(7, 'ANNOUNCE_ERROR', 0)).toBeNull()
    expect(errorName(17, 'SUBSCRIBE_ERROR', 0)).toBeNull()
    expect(errorName(14, 'SUBSCRIBE_ERROR', 0x99)).toBeNull()
    expect(errorName(14, 'SUBSCRIBE_ERROR', 1.5)).toBeNull()
  })
})

describe('messageAliases', () => {
  it("gives a renamed message's other names in the case it was asked in", () => {
    expect(messageAliases('ANNOUNCE')).toEqual(['PUBLISH_NAMESPACE'])
    expect(messageAliases('publish_namespace')).toEqual(['announce'])
    expect(messageAliases('PUBLISH_DONE')).toEqual(['SUBSCRIBE_DONE'])
    expect(messageAliases('MAX_REQUEST_ID')).toEqual(['MAX_SUBSCRIBE_ID'])
  })

  it('names both setup messages under SETUP', () => {
    expect(messageAliases('SETUP')).toEqual(['CLIENT_SETUP', 'SERVER_SETUP'])
    expect(messageAliases('server_setup')).toEqual(['setup'])
  })

  it('reads TRACK_STATUS by draft', () => {
    expect(messageAliases('TRACK_STATUS')).toEqual(['TRACK_STATUS_REQUEST'])
    expect(messageAliases('TRACK_STATUS', 22)).toEqual(['TRACK_STATUS_REQUEST'])
    expect(messageAliases('TRACK_STATUS', 7)).toEqual(['TRACK_STATUS_OK'])
    expect(messageAliases('TRACK_STATUS_OK')).toEqual(['TRACK_STATUS'])
  })

  it('is empty for a message that kept its name', () => {
    expect(messageAliases('SUBSCRIBE')).toEqual([])
    expect(messageAliases('REQUEST_ERROR')).toEqual([])
  })
})
