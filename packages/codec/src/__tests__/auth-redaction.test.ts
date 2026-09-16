/**
 * Authorization Token values are overwritten at the point of parse.
 *
 * The property under test is narrow and absolute: after `redactAuthTokens` has
 * run over a control frame, **the token value's bytes are not in the frame any
 * more** — not moved, not shortened, not encoded differently. Gone.
 *
 * Everything else about the frame has to survive, and that half matters just as
 * much. A mask that also erased the Alias, the Token Type or the parameter's
 * presence would lose the distinction between a session that failed to
 * authenticate and one that never tried, which is the distinction the control
 * plane is being collected for in the first place.
 *
 * Both drafts the collector loads are covered, because the parameter numbering
 * and the option numbering are per-draft facts, and a shared implementation is
 * exactly the thing that drifts.
 *
 * Spec of record: `wt-logging-1-collector.md` Section 1.6.
 */

import { describe, expect, it } from 'vitest'
import {
  decodeMessage as decodeMessage19,
  encodeMessage as encodeMessage19,
  redactAuthTokens as redact19,
} from '../drafts/draft19/index.js'
import {
  decodeMessage as decodeMessage20,
  encodeMessage as encodeMessage20,
  redactAuthTokens as redact20,
} from '../drafts/draft20/index.js'

/** A byte pattern no other field in these fixtures produces. */
const SECRET = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0xca, 0xfe, 0xba, 0xbe])
const SECOND_SECRET = new Uint8Array([0x11, 0x22, 0x33, 0x44, 0x55, 0x66])

function contains(haystack: Uint8Array, needle: Uint8Array): boolean {
  for (let i = 0; i + needle.length <= haystack.length; i++) {
    let hit = true
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) {
        hit = false
        break
      }
    }
    if (hit) return true
  }
  return false
}

// The two drafts' message unions are structurally identical for these fixtures
// but nominally distinct, and the whole point of the table below is that one
// test body runs against both.
// biome-ignore lint/suspicious/noExplicitAny: see the note above
type AnyMessage = any

const DRAFTS = [
  { name: 'draft-19', encode: encodeMessage19, decode: decodeMessage19, redact: redact19 },
  { name: 'draft-20', encode: encodeMessage20, decode: decodeMessage20, redact: redact20 },
] as const

function setupWith(token: AnyMessage): AnyMessage {
  return { type: 'setup', options: { authorization_token: [token] } }
}

function subscribeWith(tokens: AnyMessage[]): AnyMessage {
  return {
    type: 'subscribe',
    request_id: 4n,
    track_namespace: ['example.com', 'live'],
    track_name: 'video',
    parameters: { authorization_token: tokens },
  }
}

const USE_VALUE = (value: Uint8Array): AnyMessage => ({
  alias_type: 3n,
  token_type: 0n,
  token_value: value,
})

const REGISTER = (alias: bigint, value: Uint8Array): AnyMessage => ({
  alias_type: 1n,
  token_alias: alias,
  token_type: 0n,
  token_value: value,
})

const USE_ALIAS = (alias: bigint): AnyMessage => ({ alias_type: 2n, token_alias: alias })

describe.each(DRAFTS)('$name auth redaction', ({ encode, decode, redact }) => {
  it('removes a USE_VALUE token value from a SETUP option', () => {
    const frame = encode(setupWith(USE_VALUE(SECRET)))
    expect(contains(frame, SECRET)).toBe(true)

    const r = redact(frame)
    expect(r.redacted).toBe(1)
    expect(r.incomplete).toBe(false)
    expect(contains(r.bytes, SECRET)).toBe(false)
  })

  it('removes a token value from a SUBSCRIBE parameter', () => {
    const frame = encode(subscribeWith([USE_VALUE(SECRET)]))
    expect(contains(frame, SECRET)).toBe(true)

    const r = redact(frame)
    expect(r.redacted).toBe(1)
    expect(contains(r.bytes, SECRET)).toBe(false)
  })

  it('keeps the frame exactly as long, so the Message Length field stays true', () => {
    const frame = encode(subscribeWith([USE_VALUE(SECRET)]))
    const r = redact(frame)
    expect(r.bytes.length).toBe(frame.length)
    expect(decode(r.bytes).ok).toBe(true)
  })

  it('keeps the parameter, its alias and its token type — the fact, not the value', () => {
    const frame = encode(subscribeWith([REGISTER(7n, SECRET)]))
    const res = decode(redact(frame).bytes)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const msg = res.value as AnyMessage
    const tokens = msg.parameters.authorization_token
    expect(tokens).toHaveLength(1)
    expect(tokens[0].alias_type).toBe(1n)
    expect(tokens[0].token_alias).toBe(7n)
    expect(tokens[0].token_type).toBe(0n)
    // Present, same length, and no longer the secret.
    expect(tokens[0].token_value).toHaveLength(SECRET.length)
    expect([...tokens[0].token_value]).toEqual(new Array(SECRET.length).fill(0))
  })

  it('leaves a USE_ALIAS token untouched — it carries no value to remove', () => {
    const frame = encode(subscribeWith([USE_ALIAS(9n)]))
    const r = redact(frame)
    expect(r.redacted).toBe(0)
    expect(r.incomplete).toBe(false)
    // Same reference: nothing to redact costs no copy.
    expect(r.bytes).toBe(frame)
  })

  it('removes every token when a message carries more than one', () => {
    const frame = encode(subscribeWith([REGISTER(1n, SECRET), USE_VALUE(SECOND_SECRET)]))
    expect(contains(frame, SECRET)).toBe(true)
    expect(contains(frame, SECOND_SECRET)).toBe(true)

    const r = redact(frame)
    expect(r.redacted).toBe(2)
    expect(contains(r.bytes, SECRET)).toBe(false)
    expect(contains(r.bytes, SECOND_SECRET)).toBe(false)
  })

  it('does not mutate the caller buffer', () => {
    const frame = encode(subscribeWith([USE_VALUE(SECRET)]))
    const before = frame.slice()
    redact(frame)
    expect([...frame]).toEqual([...before])
  })

  it('leaves a message with no token alone, byte for byte', () => {
    const frame = encode({
      type: 'subscribe',
      request_id: 4n,
      track_namespace: ['example.com', 'live'],
      track_name: 'video',
      parameters: {},
    } as AnyMessage)
    const r = redact(frame)
    expect(r.redacted).toBe(0)
    expect(r.bytes).toBe(frame)
  })

  it('reports nothing to redact for a frame too short to hold a header', () => {
    for (const len of [0, 1, 2]) {
      const r = redact(new Uint8Array(len))
      expect(r.redacted).toBe(0)
      expect(r.incomplete).toBe(false)
    }
  })

  it('still redacts what it read when the payload fails to parse after the token', () => {
    // The token decodes, then the message runs off the end of its own payload.
    // The token was read, so it was exposed, so it must go — whatever happened
    // to the rest of the message. This is the malformed shape a peer can
    // actually produce: the frame is complete by its Message Length field, and
    // wrong inside it.
    const frame = encode(subscribeWith([USE_VALUE(SECRET)]))
    const broken = frame.slice()
    // Claim one more parameter than the message carries, so decodeParams walks
    // past the token and then off the end.
    const at = broken.indexOf(SECRET[0] as number)
    expect(at).toBeGreaterThan(0)
    const countAt = broken.lastIndexOf(0x01, at)
    expect(countAt).toBeGreaterThan(0)
    broken[countAt] = 0x02
    expect(contains(broken, SECRET)).toBe(true)

    const r = redact(broken)
    expect(r.decoded).toBe(false)
    expect(r.redacted).toBe(1)
    expect(contains(r.bytes, SECRET)).toBe(false)
  })

  it('reports a frame cut below its own header as unchecked, not as clean', () => {
    // Truncated before the payload is complete, the decoder rejects the frame
    // outright and never reaches a parameter. Nothing is redacted, and the
    // result must not claim otherwise — this is what `decoded` is for.
    //
    // Nothing in the collector can reach this: the framer emits a frame only
    // once every declared byte of it has arrived (control-framer.ts, the
    // `end > buf.length` guard), and a residue at stream end is dropped rather
    // than emitted. The case is pinned here so the contract is stated in a test
    // instead of assumed by a future caller.
    const frame = encode(setupWith(USE_VALUE(SECRET)))
    const truncated = frame.slice(0, frame.length - 1)
    const r = redact(truncated)
    expect(r.decoded).toBe(false)
    expect(r.redacted).toBe(0)
    expect(contains(r.bytes, SECRET.subarray(0, SECRET.length - 1))).toBe(true)
  })

  it('reports a well-formed frame as decoded', () => {
    expect(redact(encode(subscribeWith([USE_VALUE(SECRET)]))).decoded).toBe(true)
    expect(redact(encode(setupWith(USE_ALIAS(3n)))).decoded).toBe(true)
  })

  it('is idempotent — redacting twice changes nothing further', () => {
    const frame = encode(subscribeWith([USE_VALUE(SECRET)]))
    const once = redact(frame)
    const twice = redact(once.bytes)
    expect([...twice.bytes]).toEqual([...once.bytes])
  })

  it('does not leak spans between calls', () => {
    const withToken = encode(subscribeWith([USE_VALUE(SECRET)]))
    const withoutToken = encode(subscribeWith([USE_ALIAS(2n)]))
    expect(redact(withToken).redacted).toBe(1)
    // If the sink were not reset, this second call would replay the first
    // call's spans onto an unrelated frame and quietly corrupt it.
    const second = redact(withoutToken)
    expect(second.redacted).toBe(0)
    expect(second.bytes).toBe(withoutToken)
  })
})

describe('the mask is per draft, not shared', () => {
  it('redacts a draft-19 frame with the draft-19 redactor', () => {
    const frame = encodeMessage19(setupWith(USE_VALUE(SECRET)))
    expect(contains(redact19(frame).bytes, SECRET)).toBe(false)
  })

  it('redacts a draft-20 frame with the draft-20 redactor', () => {
    const frame = encodeMessage20(setupWith(USE_VALUE(SECRET)))
    expect(contains(redact20(frame).bytes, SECRET)).toBe(false)
  })
})
