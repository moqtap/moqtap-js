import { describe, expect, it } from 'vitest'
import { byId, draftOf, type MessageDef } from '../drafts'
import {
  asShown,
  bytes,
  citation,
  count,
  duration,
  heading,
  hexLines,
  middle,
  offset,
  plainValue,
  specHref,
} from '../format'
import { looksLikeTrace } from '../ingest'
import { applyTheme, asTheme, themeFromQuery } from '../theme'

const def = (value: number, name: string, reserved = false): MessageDef => ({
  value,
  name,
  reserved,
  note: null,
  section: null,
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

describe('byId', () => {
  it('indexes by wire value', () => {
    expect(byId([def(3, 'SUBSCRIBE')]).get(3)?.name).toBe('SUBSCRIBE')
  })
})

// The thin space moqtap puts between a number and its unit.
const T = '\u2009'

describe('format', () => {
  it('writes durations the way every moqtap tool does', () => {
    expect(duration(420)).toBe(`0.42${T}ms`)
    expect(duration(1_500)).toBe(`1.50${T}ms`)
    expect(duration(18_000)).toBe(`18${T}ms`)
    expect(duration(1_250_000)).toBe(`1.25${T}s`)
    expect(duration(192_000_000)).toBe(`3${T}m 12${T}s`)
    expect(duration(3_780_000_000)).toBe(`1${T}h 3${T}m`)
  })

  it('keeps a span too short for hundredths of a millisecond in microseconds', () => {
    expect(duration(3)).toBe(`3${T}µs`)
    expect(duration(0)).toBe(`0${T}µs`)
  })

  it('picks the unit after rounding, so no span reads as the next unit at its threshold', () => {
    expect(duration(9_996)).toBe(`10${T}ms`)
    expect(duration(999_600)).toBe(`1.00${T}s`)
    expect(duration(59_999_999)).toBe(`1${T}m 0${T}s`)
    expect(duration(3_599_600_000)).toBe(`1${T}h 0${T}m`)
  })

  it('writes offsets from the session start as +mm:ss.mmm', () => {
    expect(offset(0)).toBe('+00:00.000')
    expect(offset(1_284_000)).toBe('+00:01.284')
    expect(offset(192_005_999)).toBe('+03:12.005')
    expect(offset(3_723_456_000)).toBe('+1:02:03.456')
  })

  it('scales bytes by 1024 with binary units and one decimal', () => {
    expect(bytes(812)).toBe(`812${T}B`)
    expect(bytes(1023)).toBe(`1023${T}B`)
    expect(bytes(1434)).toBe(`1.4${T}KiB`)
    expect(bytes(12 * 1024 * 1024)).toBe(`12.0${T}MiB`)
    expect(bytes(3 * 1024 ** 3)).toBe(`3.0${T}GiB`)
  })

  it('picks the binary unit after rounding to one decimal', () => {
    expect(bytes(1_048_575)).toBe(`1.0${T}MiB`)
    expect(bytes(1_048_524)).toBe(`1023.9${T}KiB`)
  })

  it('groups thousands in counts', () => {
    expect(count(12_480)).toBe('12,480')
    expect(count(7)).toBe('7')
  })

  it('shortens long identifiers in the middle and leaves short ones whole', () => {
    expect(middle('7f3a91c0d2e4b6a8e2b4c91e')).toBe('7f3a91c0…e2b4c91e')
    expect(middle('7f3a91c0d2e4b6a8e2b4')).toBe('7f3a91c0d2e4b6a8e2b4')
    expect(middle('7f3a91c0d2e4b6a8e2b4c')).toBe('7f3a91c0…6a8e2b4c')
    expect(middle('a'.repeat(45), 22)).toBe('a'.repeat(45))
    expect(middle('abcdefghijklmnopqrstuvwxyz0123456789abcdefghijk', 22)).toBe(
      'abcdefghijklmnopqrstuv…z0123456789abcdefghijk',
    )
  })

  it('lays bytes out sixteen to a line with offsets and ASCII', () => {
    const data = new TextEncoder().encode('live/conference/video/hd')
    const lines = hexLines(data)
    expect(lines).toHaveLength(2)
    expect(lines[0]?.offset).toBe('00000000')
    expect(lines[1]?.offset).toBe('00000010')
    expect(lines[0]?.ascii).toBe('live/conference/')
    expect(lines[1]?.hex.trimEnd()).toBe('76 69 64 65 6f 2f 68 64')
    expect(lines[1]?.hex).toHaveLength(47)
    expect(hexLines(Uint8Array.of(0, 0x7f, 0x41))[0]?.ascii).toBe('..A')
  })

  it('turns direction 0 (away from the recorder) into a side when the recorder says which end it was', () => {
    const up = { glyph: '↑', side: 'c2s', label: 'Client → relay' }
    const down = { glyph: '↓', side: 's2c', label: 'Relay → client' }
    expect(heading(0, 'client')).toEqual(up)
    expect(heading(1, 'client')).toEqual(down)
    expect(heading(0, 'server')).toEqual(down)
    expect(heading(1, 'server')).toEqual(up)
  })

  it('claims no side for a recorder that was neither end', () => {
    expect(heading(0, 'observer').label).toBe('Sent')
    expect(heading(1, 'relay-tap').label).toBe('Received')
  })
})

describe('specHref', () => {
  it('links a registry path on the site, with the trailing slash the site serves', () => {
    expect(specHref('/spec/draft-14/subscribe_ok')).toBe(
      'https://moqtap.com/spec/draft-14/subscribe_ok/',
    )
    expect(specHref('/spec/draft-14/subscribe_ok/')).toBe(
      'https://moqtap.com/spec/draft-14/subscribe_ok/',
    )
  })

  it('refuses anything that would leave the site', () => {
    expect(specHref('//evil.example/x')).toBeNull()
    expect(specHref('https://evil.example/x')).toBeNull()
    expect(specHref('spec/draft-14')).toBeNull()
  })
})

describe('plainValue', () => {
  it('copies integers and text as shown, bytes and versions as recorded', () => {
    expect(
      plainValue({
        id: { $shown: 'integer', text: '18446744073709551615', raw: '18446744073709551615' },
        name: { $shown: 'text', text: 'now', raw: '0x6e6f77' },
        blob: { $shown: 'bytes', text: '0x0001 (2 bytes)', raw: '0x0001' },
        versions: [{ $shown: 'version', text: 'draft-14', raw: '0xff00000e' }],
        n: 3,
      }),
    ).toEqual({
      id: '18446744073709551615',
      name: 'now',
      blob: '0x0001',
      versions: ['0xff00000e'],
      n: 3,
    })
  })

  it('reads a map with more keys as a map, not a shown value', () => {
    expect(asShown({ $shown: 'text', text: 'a', raw: 'b', other: 1 })).toBeNull()
  })
})

describe('theme', () => {
  class Root {
    attrs = new Map<string, string>()
    setAttribute(name: string, value: string) {
      this.attrs.set(name, value)
    }
    removeAttribute(name: string) {
      this.attrs.delete(name)
    }
  }

  it('accepts exactly light, dark and system', () => {
    expect(asTheme('light')).toBe('light')
    expect(asTheme('dark')).toBe('dark')
    expect(asTheme('system')).toBe('system')
    for (const bad of ['Dark', 'auto', '', null, undefined, 1, { theme: 'dark' }]) {
      expect(asTheme(bad)).toBeNull()
    }
  })

  it('reads the theme a parent put on the frame URL', () => {
    expect(themeFromQuery('?theme=dark')).toBe('dark')
    expect(themeFromQuery('?x=1&theme=system')).toBe('system')
    expect(themeFromQuery('')).toBeNull()
    expect(themeFromQuery('?theme=purple')).toBeNull()
  })

  it('sets data-theme for light and dark, and removes it to follow the system', () => {
    const root = new Root()
    applyTheme(root, 'dark')
    expect(root.attrs.get('data-theme')).toBe('dark')
    applyTheme(root, 'light')
    expect(root.attrs.get('data-theme')).toBe('light')
    applyTheme(root, 'system')
    expect(root.attrs.has('data-theme')).toBe(false)
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

describe('citation', () => {
  it('names the draft and the section, as text', () => {
    expect(citation(14, '9.8')).toBe('draft-14 §9.8')
    expect(citation(7, '6.2')).toBe('draft-07 §6.2')
  })

  it('is left out when the draft or the section is unknown', () => {
    expect(citation(null, '9.8')).toBeNull()
    expect(citation(14, null)).toBeNull()
  })
})
