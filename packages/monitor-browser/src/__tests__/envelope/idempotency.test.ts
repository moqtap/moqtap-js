/**
 * The idempotency key and the SHA-256 it is built on.
 *
 * Ingest dedupes **exactly** on the key, so every property below decides
 * whether a body is counted once, twice, or not at all:
 *
 *  - determinism, because a body is keyed at seal time and replays that key on
 *    every retry, across a page reload;
 *  - distinctness across instances, because a supplied session id is shared by
 *    every reload and tab that uses it, and each of those numbers from zero.
 *
 * Every expected digest below was computed with `node:crypto`'s
 * `createHash('sha256')`, so the bundled implementation is not checking its own
 * homework.
 */

import { describe, expect, it, vi } from 'vitest'
import { idempotencyKey, sha256Hex } from '../../envelope/index.js'

/** `sha256(input)`, from `node:crypto`. */
const SHA256: Record<string, string> = {
  '': 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  abc: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  abcdbcdecdefdefgefghfghighijhijkijkljklmjklmnklmnolmnopmnopnopq:
    '282151602870a0064ce975dd3961716971ece56aff7ed98d0e239bcdc3910f48',
  's:i:0': '8ed64f7187a77601c3a81f098f01c9dd1ef3e052137dc128395a703818fedc4d',
  'sess-1:inst-a:0': 'dad063ea168c176315a374bc675386f6e1534ab3e673f7ee18284e487fc40a6f',
  'sess-1:inst-a:1': '0b645a1e76e4d81b0738c8f364035c9bf6e6bf49b209f7ee90d2d0e9bcc2bced',
  'sess-1:inst-b:0': 'd3f691d03b4af9fab5bbd27c90a8b34e22aaf3fbf198a35c3822f50e12ce1a82',
  '7f3a-uuid:9c1e:41': '7d9b06b202f54be67c3cff00a214cc311f99456f7ece77b2d77b42f79a01bb55',
}

/** `sha256('x'.repeat(n))` around the one- and two-block padding boundaries. */
const PADDING: Record<number, string> = {
  55: 'd5e285683cd4efc02d021a5c62014694958901005d6f71e89e0989fac77e4072',
  56: '04c26261370ee7541549d16dee320c723e3fd14671e66a099afe0a377c16888e',
  63: '75220b47218278e656f2013bb8f0c455a25eaf01e86c64924e9d48d89776d6f2',
  64: '7ce100971f64e7001e8fe5a51973ecdfe1ced42befe7ee8d5fd6219506b5393c',
  65: '9537c5fdf120482f7d58d25e9ed583f52c02b4e304ea814db1633ad565aed7e9',
  119: '000b48d4edf0fa7bee3c6236ecd2785baa5db4eeb8bb54341b029e0d9fa5fb0c',
  120: '13f05a0b594787f5ecd315edc96141bd3243203d1b7d4f0836f37308b276ba98',
}

describe('sha256Hex', () => {
  it('matches the FIPS 180-4 test vectors', () => {
    for (const input of [
      '',
      'abc',
      'abcdbcdecdefdefgefghfghighijhijkijkljklmjklmnklmnolmnopmnopnopq',
    ]) {
      expect(sha256Hex(input)).toBe(SHA256[input])
    }
  })

  it('pads correctly on both sides of every block boundary', () => {
    for (const [n, digest] of Object.entries(PADDING)) {
      expect(sha256Hex('x'.repeat(Number(n)))).toBe(digest)
    }
  })

  it('matches the FIPS long-message vector, a million bytes over many blocks', () => {
    expect(sha256Hex('a'.repeat(1_000_000))).toBe(
      'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0',
    )
  })

  it('needs no crypto global, so an insecure origin keys bodies the same way', () => {
    vi.stubGlobal('crypto', undefined)
    try {
      expect(sha256Hex('abc')).toBe(SHA256.abc)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('idempotencyKey', () => {
  it('is sha256 of sessionId:instanceId:seq, lowercase hex', () => {
    expect(idempotencyKey('s', 'i', 0)).toBe(SHA256['s:i:0'])
    expect(idempotencyKey('sess-1', 'inst-a', 0)).toBe(SHA256['sess-1:inst-a:0'])
    expect(idempotencyKey('sess-1', 'inst-a', 1)).toBe(SHA256['sess-1:inst-a:1'])
    expect(idempotencyKey('7f3a-uuid', '9c1e', 41)).toBe(SHA256['7f3a-uuid:9c1e:41'])
  })

  it('separates two instances of one supplied session id', () => {
    // A reload or a second tab with the same id numbers its bodies from zero
    // again. Without the instance in the input, its first body would be
    // discarded as a duplicate of the first instance's.
    expect(idempotencyKey('sess-1', 'inst-a', 0)).not.toBe(idempotencyKey('sess-1', 'inst-b', 0))
    expect(idempotencyKey('sess-1', 'inst-b', 0)).toBe(SHA256['sess-1:inst-b:0'])
  })

  it('regenerates the identical key for the same body, which is what makes a retry free', () => {
    expect(idempotencyKey('7f3a-uuid', '9c1e', 41)).toBe(idempotencyKey('7f3a-uuid', '9c1e', 41))
  })

  it('separates every body of an instance', () => {
    const keys = new Set([0, 1, 2, 3, 4].map((n) => idempotencyKey('sess-1', 'inst-a', n)))
    expect(keys.size).toBe(5)
  })

  it('cannot be confused by a sessionId that itself contains the separator', () => {
    const a = idempotencyKey('a:1', 'i', 2)
    const b = idempotencyKey('a', 'i', 1)
    const c = idempotencyKey('a:1:2', 'i', 0)
    expect(new Set([a, b, c]).size).toBe(3)
  })

  it('refuses a sequence that is not a number rather than hashing "NaN"', () => {
    // Every body that hit that bug would share one key, and an exact-dedupe
    // consumer would keep the first and drop the rest.
    expect(() => idempotencyKey('s', 'i', Number.NaN)).toThrow(RangeError)
    expect(() => idempotencyKey('s', 'i', 1.5)).toThrow(RangeError)
    expect(() => idempotencyKey('s', 'i', -1)).toThrow(RangeError)
    expect(() => idempotencyKey('s', 'i', Number.MAX_SAFE_INTEGER + 2)).toThrow(/MQ2101/)
  })
})
