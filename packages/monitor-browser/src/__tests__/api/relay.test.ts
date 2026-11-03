import { describe, expect, it } from 'vitest'
import { relayOf } from '../../api/relay.js'

/** Relay URLs and the endpoint each is named by. */
const ENDPOINTS: readonly (readonly [string, string | null])[] = [
  ['https://relay.example', 'https://relay.example'],
  ['https://relay.example/', 'https://relay.example'],
  ['HTTPS://Relay.Example:443/', 'https://relay.example'],
  ['moqt://relay.example:4443', 'moqt://relay.example:4443'],
  ['moqt://relay.example/', 'moqt://relay.example'],
  ['https://Bücher.Example/moq', 'https://xn--bcher-kva.example/moq'],
  ['moqt://Bücher.Example:4443/moq', 'moqt://xn--bcher-kva.example:4443/moq'],
  ['https://relay.example/moq', 'https://relay.example/moq'],
  ['https://relay.example/moq/', 'https://relay.example/moq/'],
  ['https://relay.example/Moq/A', 'https://relay.example/Moq/A'],
  ['https://user:pw@relay.example/moq?jwt=secret#f', 'https://relay.example/moq'],
  ['https://relay.example?jwt=secret', 'https://relay.example'],
  ['https://relay.example/a//b', 'https://relay.example/a//b'],
  ['https://relay.example/%7euser/%41', 'https://relay.example/~user/A'],
  ['https://relay.example/a%2fb%3f', 'https://relay.example/a%2Fb%3F'],
  ['https://relay.example/100%', 'https://relay.example/100%25'],
  ['https://relay.example/%zz', 'https://relay.example/%25zz'],
  ['https://relay.example/bücher', 'https://relay.example/b%C3%BCcher'],
  ['https://relay.example/a|b[c]^{d}"e', 'https://relay.example/a%7Cb%5Bc%5D%5E%7Bd%7D%22e'],
  ["https://relay.example/a;v=1/!$&'()*+,=:@", "https://relay.example/a;v=1/!$&'()*+,=:@"],
  ['https://relay.example/a/./b/../c', 'https://relay.example/a/c'],
  ['https://relay.example/a/%2E%2e/b', 'https://relay.example/b'],
  ['https://relay.example/..', 'https://relay.example'],
  ['https://relay.example/a/..', 'https://relay.example'],
  ['https://relay.example/a/b/..', 'https://relay.example/a/'],
  ['https://relay.example/a b', null],
  ['https://relay.example/a\tb', null],
  ['https://relay.example/a\\b', null],
  ['wss://relay.example/moq', null],
  [`https://relay.example/${'ü'.repeat(400)}`, null],
]

/** The URL parser reads these first: a tab dropped, a space escaped, `\` a slash. */
const PARSED: Readonly<Record<string, string>> = {
  'https://relay.example/a b': 'https://relay.example/a%20b',
  'https://relay.example/a\tb': 'https://relay.example/ab',
  'https://relay.example/a\\b': 'https://relay.example/a/b',
}

describe('relayOf', () => {
  it('keeps the normalised path and drops query, fragment and userinfo', () => {
    for (const [url, want] of ENDPOINTS) expect(relayOf(url), url).toBe(PARSED[url] ?? want ?? '')
  })

  it('is its own fixed point', () => {
    for (const [, want] of ENDPOINTS) if (want !== null) expect(relayOf(want)).toBe(want)
  })

  it('is empty for what is not a relay URL', () => {
    for (const bad of ['', 'not a url', 'wss://relay.example', 'https://'])
      expect(relayOf(bad), bad).toBe('')
  })
})
