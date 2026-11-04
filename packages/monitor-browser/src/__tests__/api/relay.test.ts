import { describe, expect, it } from 'vitest'
import { relayOf } from '../../api/relay.js'

/** The same table as ingest's and moqtap-monitor's relay tests. */
const ENDPOINTS: readonly (readonly [string, string | null])[] = [
  ['https://relay.example', 'https://relay.example/'],
  ['https://relay.example/', 'https://relay.example/'],
  ['HTTPS://Relay.Example:443/', 'https://relay.example/'],
  ['https://relay.example?jwt=secret', 'https://relay.example/'],
  ['moqt://relay.example', 'moqt://relay.example'],
  ['moqt://relay.example/', 'moqt://relay.example/'],
  ['moqt://relay.example:443/moq', 'moqt://relay.example/moq'],
  ['moqt://relay.example:4443', 'moqt://relay.example:4443'],
  ['https://Bücher.Example/moq', 'https://xn--bcher-kva.example/moq'],
  ['moqt://Bücher.Example:4443/moq', 'moqt://xn--bcher-kva.example:4443/moq'],
  ['https://relay.example/moq', 'https://relay.example/moq'],
  ['https://relay.example/moq/', 'https://relay.example/moq/'],
  ['https://relay.example/Moq/A', 'https://relay.example/Moq/A'],
  ['https://user:pw@relay.example/moq?jwt=secret#f', 'https://relay.example/moq'],
  ['https://relay.example/a//b', 'https://relay.example/a//b'],
  ['https://relay.example/%7euser/%41', 'https://relay.example/%7euser/%41'],
  ['https://relay.example/a%2fb', 'https://relay.example/a%2fb'],
  ['https://relay.example/100%', 'https://relay.example/100%'],
  ['https://relay.example/b\u00fccher', 'https://relay.example/b%C3%BCcher'],
  ['https://relay.example/a|b', 'https://relay.example/a|b'],
  ['https://relay.example/a b', 'https://relay.example/a%20b'],
  ['https://relay.example/a\tb', 'https://relay.example/ab'],
  ['https://relay.example/a/./b/../c', 'https://relay.example/a/c'],
  ['moqt://relay.example/a/./b/../c', 'moqt://relay.example/a/./b/../c'],
  ['moqt://relay.example/%7e?jwt=secret', 'moqt://relay.example/%7e'],
  ["moqt://relay.example/a;v=1/!$&'()*+,=:@", "moqt://relay.example/a;v=1/!$&'()*+,=:@"],
  ['moqt://relay.example/a b', null],
  ['moqt://relay.example/a|b', null],
  ['moqt://relay.example/b\u00fccher', null],
  ['moqt://relay.example/100%', null],
  ['wss://relay.example/moq', null],
  [`https://relay.example/${'\u00fc'.repeat(400)}`, null],
]

describe('relayOf', () => {
  it('keeps the path exactly and drops query, fragment and userinfo', () => {
    for (const [url, want] of ENDPOINTS) expect(relayOf(url), url).toBe(want ?? '')
  })

  it('is its own fixed point', () => {
    for (const [, want] of ENDPOINTS) if (want !== null) expect(relayOf(want)).toBe(want)
  })

  it('reads an https backslash as the URL parser does: a slash', () => {
    expect(relayOf('https://relay.example/a\\b')).toBe('https://relay.example/a/b')
  })

  it('tells moqt://h from moqt://h/', () => {
    expect(relayOf('moqt://h')).toBe('moqt://h')
    expect(relayOf('moqt://h/')).toBe('moqt://h/')
  })

  it('is empty for what is not a relay URL', () => {
    for (const bad of ['', 'not a url', 'wss://relay.example', 'https://'])
      expect(relayOf(bad), bad).toBe('')
  })
})
