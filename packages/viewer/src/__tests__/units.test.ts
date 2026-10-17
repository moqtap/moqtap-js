import { describe, expect, it } from 'vitest'
import { byId, draftOf, idsNamed, type MessageDef } from '../drafts'
import { bytes, direction, duration, offset } from '../format'
import { looksLikeTrace } from '../ingest'

const def = (value: number, name: string, reserved = false): MessageDef => ({
  value,
  name,
  reserved,
  note: null,
  specPath: null,
})

describe('draftOf', () => {
  const tables = { 14: [], 16: [] }

  it('reads both spellings of a protocol string the recorders write', () => {
    expect(draftOf('moq-transport-16', tables)).toBe(16)
    expect(draftOf('moqt-14', tables)).toBe(14)
  })

  it('names no draft for a draft it does not carry', () => {
    expect(draftOf('moq-transport-15', tables)).toBeNull()
  })

  it('does not pull a number off the end of a string that names no draft', () => {
    expect(draftOf('moq-transport-rfc9999', tables)).toBeNull()
    expect(draftOf('moq-transport-160', tables)).toBeNull()
    expect(draftOf('xmoq-transport-16', tables)).toBeNull()
  })
})

describe('idsNamed', () => {
  it('finds whichever spelling of a response this draft defines', () => {
    const defs = [def(4, 'SUBSCRIBE_OK'), def(5, 'SUBSCRIBE_ERROR')]
    expect([...idsNamed(defs, ['SUBSCRIBE_OK', 'REQUEST_OK'])]).toEqual([4])
  })

  it('never returns a reserved code point, whatever its placeholder name', () => {
    const defs = [def(0x40, 'RESERVED', true), def(3, 'SUBSCRIBE')]
    expect([...idsNamed(defs, ['RESERVED', 'SUBSCRIBE'])]).toEqual([3])
  })

  it('byId indexes by wire value', () => {
    expect(byId([def(3, 'SUBSCRIBE')]).get(3)?.name).toBe('SUBSCRIBE')
  })
})

describe('format', () => {
  it('keeps sub-millisecond spans in microseconds rather than rounding to zero', () => {
    expect(duration(250)).toBe('250 µs')
    expect(duration(1_500)).toBe('1.5 ms')
    expect(duration(2_500_000)).toBe('2.50 s')
    expect(duration(90_000_000)).toBe('1m 30.0s')
    expect(offset(12)).toBe('+12 µs')
  })

  it('scales bytes by 1024', () => {
    expect(bytes(1023)).toBe('1023 B')
    expect(bytes(1536)).toBe('1.5 KB')
    expect(bytes(3 * 1024 * 1024)).toBe('3.0 MB')
  })

  it('direction 0 is away from the recorder', () => {
    expect(direction(0)).toBe('sent')
    expect(direction(1)).toBe('received')
  })
})

describe('the signature check', () => {
  it('accepts the eight bytes of MOQTRACE and nothing shorter or different', () => {
    const enc = new TextEncoder()
    expect(looksLikeTrace(enc.encode('MOQTRACE\0\0'))).toBe(true)
    expect(looksLikeTrace(enc.encode('MOQTRAC'))).toBe(false)
    expect(looksLikeTrace(enc.encode('moqtrace'))).toBe(false)
  })
})
