import { describe, expect, it } from 'vitest'
import {
  bytesAsText,
  displayBytes,
  displayFields,
  displayValue,
  draftOfProtocol,
  isDisplayed,
  setupImplementation,
  setupVersionLabel,
} from '../display.js'

const ascii = (s: string) => new TextEncoder().encode(s)

describe('bytes', () => {
  it('reads printable ASCII as text, skipping leading NULs', () => {
    expect(bytesAsText(ascii('video/1080p'))).toBe('video/1080p')
    expect(bytesAsText(new Uint8Array([0, 0, ...ascii('tok')]))).toBe('tok')
  })

  it('is not text when any byte is unprintable, or when it is only NULs', () => {
    expect(bytesAsText(new Uint8Array([0x41, 0x0a]))).toBeNull()
    expect(bytesAsText(new Uint8Array([0, 0]))).toBeNull()
    expect(bytesAsText(new Uint8Array())).toBeNull()
  })

  it('shows text with its hex for a tooltip', () => {
    expect(displayBytes(ascii('now'))).toEqual({ $shown: 'text', text: 'now', raw: '0x6e6f77' })
  })

  it('shows other bytes as a hex preview with their length', () => {
    const shown = displayBytes(new Uint8Array(40).fill(0xab))
    expect(shown.$shown).toBe('bytes')
    expect(shown.text).toBe(`0x${'ab'.repeat(32)}… (40 bytes)`)
    expect(shown.raw).toBe(`0x${'ab'.repeat(40)}`)
  })
})

describe('integers', () => {
  it('turns a safe bigint into a number', () => {
    expect(displayValue(42n)).toBe(42)
  })

  it('keeps an integer past 2^53 in full decimal', () => {
    const big = 2n ** 62n + 1n
    expect(displayValue(big)).toEqual({
      $shown: 'integer',
      text: big.toString(),
      raw: big.toString(),
    })
  })
})

describe('setup versions', () => {
  it('names a draft version, and nothing else', () => {
    expect(setupVersionLabel(0xff00000e)).toBe('draft-14')
    expect(setupVersionLabel(0xff000007n)).toBe('draft-07')
    expect(setupVersionLabel(1)).toBeNull()
    expect(setupVersionLabel('0xff00000e')).toBeNull()
  })

  it('shows CLIENT_SETUP versions as drafts with the hex beside them', () => {
    const shown = displayFields('CLIENT_SETUP', {
      supported_versions: [0xff00000en, 0xff000010n, 7n],
      parameters: {},
    })
    expect(shown.supported_versions).toEqual([
      { $shown: 'version', text: 'draft-14', raw: '0xff00000e' },
      { $shown: 'version', text: 'draft-16', raw: '0xff000010' },
      { $shown: 'version', text: '0x00000007', raw: '0x00000007' },
    ])
  })

  it('shows the SERVER_SETUP version, named from the codec type when no name is given', () => {
    const shown = displayFields(null, { type: 'server_setup', selected_version: 0xff00000e })
    expect(shown.selected_version).toEqual({
      $shown: 'version',
      text: 'draft-14',
      raw: '0xff00000e',
    })
  })

  it('leaves version-like numbers alone outside a setup message', () => {
    expect(displayFields('SUBSCRIBE', { selected_version: 0xff00000e }).selected_version).toBe(
      0xff00000e,
    )
  })
})

describe('displayed values', () => {
  it('survive JSON and are told apart from a field map', () => {
    const shown = JSON.parse(JSON.stringify(displayBytes(ascii('x'))))
    expect(isDisplayed(shown)).toBe(true)
    expect(isDisplayed({ $shown: 'text', text: 'x', raw: '0x78', extra: 1 })).toBe(false)
    expect(isDisplayed({ text: 'x', raw: 'y' })).toBe(false)
  })

  it('cuts nesting deeper than a reader would follow', () => {
    let deep: unknown = 1
    for (let i = 0; i < 20; i++) deep = [deep]
    expect(JSON.stringify(displayValue(deep))).toContain('"…"')
  })
})

describe('setupImplementation', () => {
  it('names the client from CLIENT_SETUP and the relay from SERVER_SETUP', () => {
    const params = { parameters: { moqt_implementation: 'moxygen/1.0' } }
    expect(setupImplementation('CLIENT_SETUP', params)).toEqual({
      side: 'client',
      implementation: 'moxygen/1.0',
    })
    expect(setupImplementation('server_setup', params)?.side).toBe('server')
  })

  it('reads the unified SETUP options, with the side from who sent it', () => {
    const msg = { options: { moqt_implementation: ascii('imquic 0.0.2/alpha') } }
    expect(setupImplementation('SETUP', msg, false)).toEqual({
      side: 'server',
      implementation: 'imquic 0.0.2/alpha',
    })
    expect(setupImplementation('SETUP', msg)).toBeNull()
  })

  it('is null for any other message, or an empty name', () => {
    expect(
      setupImplementation('SUBSCRIBE', { parameters: { moqt_implementation: 'x' } }),
    ).toBeNull()
    expect(
      setupImplementation('CLIENT_SETUP', { parameters: { moqt_implementation: '' } }),
    ).toBeNull()
  })
})

describe('draftOfProtocol', () => {
  it('reads both identifier spellings', () => {
    expect(draftOfProtocol('moqt-16')).toBe(16)
    expect(draftOfProtocol('moq-transport-14')).toBe(14)
  })

  it('reads nothing out of an identifier that names no draft', () => {
    expect(draftOfProtocol('moq-transport-rfc9999')).toBeNull()
    expect(draftOfProtocol('h3')).toBeNull()
  })
})
