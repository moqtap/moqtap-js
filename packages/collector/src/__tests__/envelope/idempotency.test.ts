/**
 * The idempotency key, and the two things the envelope format does not say
 * about it.
 *
 * Ingest dedupes **exactly** on this string, so every property below decides
 * whether a chunk is counted once, twice, or not at all:
 *
 *  - determinism, because a chunk is keyed at creation and replays that
 *    key on every retry, across a page reload;
 *  - distinctness, because a collision is a batch silently discarded as a
 *    duplicate and never billed or shown;
 *  - the async/insecure-context split, because `crypto.subtle` is asynchronous
 *    and simply absent on `http://` origins, and a fallback smuggled inside the
 *    primary would make `BatchRecord.keyFallback` a guess rather than a fact.
 *
 * The sha256 expectations below were computed with `node:crypto`'s
 * `createHash('sha256')` and the FNV-1a-128 expectations with an independent
 * Python implementation, so neither is this module checking its own homework.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { idempotencyKey, idempotencyKeySync, subtleAvailable } from '../../envelope/index.js'

/** `sha256(input)`, from `node:crypto`. */
const SHA256: Record<string, string> = {
  's:0': '21d0725006cf0ba54c6f2c5e2f279fc731c4d72e4205515f93df41ae6ddf7f5b',
  'sess-1:0': '20cef7226a7dea7914cb8825aaf53530cb610f4e9e669abf669807101848ab24',
  'sess-1:1': 'b1b3bad40622b42bb0aad1e39cc45fcfe2e9b2fc313b8f1d9bbd4406fc889c06',
  '7f3a-uuid:41': '54d42244447767bb9bc338f851d05c4ee6dd22046999c171a45a8987ed968015',
}

/** FNV-1a, 128-bit, computed independently in Python. */
const FNV1A128: Record<string, string> = {
  's:0': 'a68db5347b8b5822836dbc799a0093e0',
  'sess-1:0': '7d29677ebf659baf62c407403ef98773',
  'sess-1:1': '7d29677ebe659baf62c407403ef98638',
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('idempotencyKey', () => {
  it('is sha256 of sessionId + ":" + segmentSeq, lowercase hex', async () => {
    expect(await idempotencyKey('s', 0)).toBe(SHA256['s:0'])
    expect(await idempotencyKey('sess-1', 0)).toBe(SHA256['sess-1:0'])
    expect(await idempotencyKey('sess-1', 1)).toBe(SHA256['sess-1:1'])
    expect(await idempotencyKey('7f3a-uuid', 41)).toBe(SHA256['7f3a-uuid:41'])
  })

  it('is 64 lowercase hex characters', async () => {
    const key = await idempotencyKey('sess-1', 12)
    expect(key).toMatch(/^[0-9a-f]{64}$/)
  })

  it('regenerates the identical key for the same chunk, which is what makes a retry free', async () => {
    const a = await idempotencyKey('7f3a-uuid', 41)
    const b = await idempotencyKey('7f3a-uuid', 41)
    expect(a).toBe(b)
  })

  it('separates every segment of a session', async () => {
    const keys = await Promise.all([0, 1, 2, 3, 4].map((n) => idempotencyKey('sess-1', n)))
    expect(new Set(keys).size).toBe(5)
  })

  it('cannot be confused by a sessionId that itself contains the separator', async () => {
    // 'a:1' + seq 2 and 'a' + seq 1 must not meet, because every input ends in
    // ':' followed by digits and no numeric sequence can absorb the difference.
    const a = await idempotencyKey('a:1', 2)
    const b = await idempotencyKey('a', 1)
    const c = await idempotencyKey('a:1:2', 0)
    expect(new Set([a, b, c]).size).toBe(3)
  })

  it('refuses a sequence that is not a number rather than hashing "NaN"', async () => {
    // Every chunk that hit that bug would share one key, and an exact-dedupe
    // consumer would keep the first and drop the rest.
    await expect(idempotencyKey('s', Number.NaN)).rejects.toThrow(RangeError)
    await expect(idempotencyKey('s', 1.5)).rejects.toThrow(RangeError)
    await expect(idempotencyKey('s', -1)).rejects.toThrow(RangeError)
    await expect(idempotencyKey('s', Number.MAX_SAFE_INTEGER + 2)).rejects.toThrow(RangeError)
  })

  it('rejects instead of silently falling back when crypto.subtle is missing', async () => {
    // An insecure origin: `crypto` is present, `crypto.subtle` is not. A hidden
    // fallback here would leave BatchRecord.keyFallback saying `false` about a
    // key that is not a sha256.
    vi.stubGlobal('crypto', { randomUUID: () => 'stub' })
    expect(subtleAvailable()).toBe(false)
    await expect(idempotencyKey('sess-1', 0)).rejects.toThrow(/MQ2102/)
  })
})

describe('subtleAvailable', () => {
  it('is true in a secure context', () => {
    expect(subtleAvailable()).toBe(true)
  })

  it('is false when crypto.subtle is absent, which is the whole insecure-origin case', () => {
    vi.stubGlobal('crypto', { randomUUID: () => 'stub' })
    expect(subtleAvailable()).toBe(false)
  })

  it('is false when there is no crypto global at all', () => {
    vi.stubGlobal('crypto', undefined)
    expect(subtleAvailable()).toBe(false)
  })
})

describe('idempotencyKeySync', () => {
  it('is FNV-1a 128-bit over the same input', () => {
    expect(idempotencyKeySync('s', 0)).toBe(FNV1A128['s:0'])
    expect(idempotencyKeySync('sess-1', 0)).toBe(FNV1A128['sess-1:0'])
    expect(idempotencyKeySync('sess-1', 1)).toBe(FNV1A128['sess-1:1'])
  })

  it('is 32 lowercase hex characters, so ingest can tell it from a sha256 by length alone', () => {
    // The fetch() path sends the key as an Idempotency-Key header so ingest can
    // dedupe without decompressing the body — and a header cannot carry
    // BatchRecord.keyFallback. The length is the only signal on that path.
    const fallback = idempotencyKeySync('sess-1', 12)
    expect(fallback).toMatch(/^[0-9a-f]{32}$/)
    expect(fallback).toHaveLength(32)
  })

  it('needs no crypto at all', () => {
    vi.stubGlobal('crypto', undefined)
    expect(idempotencyKeySync('sess-1', 7)).toBe(idempotencyKeySync('sess-1', 7))
    expect(idempotencyKeySync('sess-1', 7)).toMatch(/^[0-9a-f]{32}$/)
  })

  it('separates every segment of a session, and every session', () => {
    const keys = new Set<string>()
    for (let seq = 0; seq < 200; seq++) keys.add(idempotencyKeySync('sess-1', seq))
    for (let seq = 0; seq < 200; seq++) keys.add(idempotencyKeySync('sess-2', seq))
    expect(keys.size).toBe(400)
  })

  it('pads a short digest to the full 32 characters', () => {
    // A leading zero nibble is not a shorter key. Only a strict-width hex form
    // dedupes correctly against a stored one.
    for (let seq = 0; seq < 500; seq++) {
      expect(idempotencyKeySync('pad-probe', seq)).toHaveLength(32)
    }
  })

  it('refuses a sequence that is not a number, exactly as the async form does', () => {
    expect(() => idempotencyKeySync('s', Number.NaN)).toThrow(RangeError)
    expect(() => idempotencyKeySync('s', 1.5)).toThrow(RangeError)
    expect(() => idempotencyKeySync('s', -1)).toThrow(RangeError)
  })

  it('never produces a string a sha256 key could be mistaken for', async () => {
    const real = await idempotencyKey('sess-1', 0)
    const fallback = idempotencyKeySync('sess-1', 0)
    expect(real).not.toBe(fallback)
    expect(real.length).not.toBe(fallback.length)
  })
})
