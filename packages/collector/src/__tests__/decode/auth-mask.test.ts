/**
 * The control plane reaches the sink with no Authorization Token in it.
 *
 * The codec's own suite proves the mask removes the bytes. What is tested here
 * is the thing that makes that promise true of *this package*: that the framer
 * masks **before it decodes**, so neither the raw frame the envelope ships nor
 * the decoded message the rollup reads has ever held a token; that the flag
 * defaults to on when a caller forgets to pass it; and that a mask which cannot
 * vouch for its own arithmetic loses the frame rather than shipping it.
 *
 * The fixture token is a byte pattern nothing else in the frame produces, and
 * every assertion searches the whole delivered frame for it. A test that
 * checked only the decoded `token_value` would pass on a mask that left the
 * bytes in place and cleared the field.
 */

import { describe, expect, it } from 'vitest'
import { ControlFramer } from '../../decode/control-framer.js'
import type { ControlRedaction, DraftAdapter } from '../../types.js'
import { chunks, DRAFT20_ADAPTER, encodeControl, Recorder } from './vectors.js'

const SECRET = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0xca, 0xfe, 0xba, 0xbe])

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

/** A SUBSCRIBE carrying a USE_VALUE Authorization Token. */
function subscribeWithToken(): Uint8Array {
  return encodeControl({
    type: 'subscribe',
    request_id: 4n,
    track_namespace: ['moqtap', 'test'],
    track_name: 'video',
    parameters: {
      authorization_token: [{ alias_type: 3n, token_type: 0n, token_value: SECRET }],
    },
  } as Parameters<typeof encodeControl>[0])
}

function run(
  bytes: Uint8Array,
  mask?: boolean,
  adapter: DraftAdapter = DRAFT20_ADAPTER,
): { sink: Recorder; framer: ControlFramer } {
  const sink = new Recorder()
  const framer =
    mask === undefined
      ? new ControlFramer('rx', 7, adapter, sink)
      : new ControlFramer('rx', 7, adapter, sink, mask)
  for (const part of chunks(bytes, bytes.length)) framer.push(part, 42)
  return { sink, framer }
}

describe('the framer masks auth parameters', () => {
  it('is proven by a fixture that really carries the token unmasked', () => {
    // Guards every other case in this file: if the encoder stopped putting the
    // value on the wire, the assertions below would pass for the wrong reason.
    expect(contains(subscribeWithToken(), SECRET)).toBe(true)
  })

  it('removes the token from the bytes the sink is handed', () => {
    const { sink, framer } = run(subscribeWithToken())
    expect(sink.control).toHaveLength(1)
    expect(contains(sink.control[0]?.bytes as Uint8Array, SECRET)).toBe(false)
    expect(framer.redactedCount).toBe(1)
  })

  it('removes it from the decoded message too, because it decodes the masked frame', () => {
    // The ordering is the point. Masking after the decode would leave the token
    // in the message object, which is what the rollup and the track-key map
    // read — a structure that outlives the frame.
    const { sink } = run(subscribeWithToken())
    const msg = sink.control[0]?.message as unknown as {
      parameters: { authorization_token?: { token_value?: Uint8Array }[] }
    }
    const token = msg.parameters.authorization_token?.[0]
    expect(token).toBeDefined()
    expect([...(token?.token_value ?? [])]).toEqual(new Array(SECRET.length).fill(0))
  })

  it('keeps the parameter, so a failed auth still looks different from no auth', () => {
    const { sink } = run(subscribeWithToken())
    const msg = sink.control[0]?.message as unknown as {
      parameters: { authorization_token?: { alias_type: bigint; token_type?: bigint }[] }
    }
    expect(msg.parameters.authorization_token).toHaveLength(1)
    expect(msg.parameters.authorization_token?.[0]?.alias_type).toBe(3n)
    expect(msg.parameters.authorization_token?.[0]?.token_type).toBe(0n)
  })

  it('leaves the frame the same length, so the Message Length field stays true', () => {
    const raw = subscribeWithToken()
    const { sink } = run(raw)
    expect((sink.control[0]?.bytes as Uint8Array).length).toBe(raw.length)
  })

  it('defaults to on when the caller passes no flag at all', () => {
    // A caller that forgets to thread the config through must get the safe
    // behaviour. This is the case a future refactor is most likely to create.
    const { framer } = run(subscribeWithToken())
    expect(framer.redactedCount).toBe(1)
  })

  it('ships the token when the customer has deliberately turned masking off', () => {
    const { sink, framer } = run(subscribeWithToken(), false)
    expect(contains(sink.control[0]?.bytes as Uint8Array, SECRET)).toBe(true)
    expect(framer.redactedCount).toBe(0)
  })

  it('counts nothing on a frame that carries no token', () => {
    const plain = encodeControl({ type: 'setup', options: { path: '/moqtap' } })
    const { sink, framer } = run(plain)
    expect(framer.redactedCount).toBe(0)
    expect(sink.control).toHaveLength(1)
    expect(Array.from(sink.control[0]?.bytes as Uint8Array)).toEqual(Array.from(plain))
  })
})

describe('the mask reports what it could not do', () => {
  function adapterReturning(r: ControlRedaction): DraftAdapter {
    return { ...DRAFT20_ADAPTER, redactAuthTokens: () => r }
  }

  it('drops the frame when a span could not be applied', () => {
    // `incomplete` means our offsets and the frame disagree — a defect here,
    // not something the peer did. What is certain is that a token was seen, so
    // the bytes are lost rather than shipped unvouched.
    const raw = subscribeWithToken()
    const { sink, framer } = run(
      raw,
      true,
      adapterReturning({ bytes: raw, redacted: 0, incomplete: true, decoded: true }),
    )
    expect(sink.control).toEqual([])
    expect(framer.redactionFailureCount).toBe(1)
    expect(sink.reasons).toEqual(['redaction-failed'])
    // Still counted as a frame: the stream stays framed and the count honest.
    expect(framer.frameCount).toBe(1)
  })

  it('survives a throwing adapter without letting the throw reach the page', () => {
    // A throw here would land in the player's own stack. Both draft
    // adapters catch, so this is the belt to that brace — but it also has to
    // fail CLOSED, because a mask that threw did not mask and carrying on would
    // ship the frame in the clear.
    const raw = subscribeWithToken()
    const throwing: DraftAdapter = {
      ...DRAFT20_ADAPTER,
      redactAuthTokens: () => {
        throw new Error('adapter blew up')
      },
    }
    const { sink, framer } = run(raw, true, throwing)
    expect(sink.control).toEqual([])
    expect(framer.redactionFailureCount).toBe(1)
    expect(sink.reasons).toEqual(['redaction-failed'])
  })

  it('the real adapters do not throw, whatever they are handed', () => {
    // The contract the belt above exists for. Fed the shapes a peer can
    // actually produce plus some it cannot, the adapter returns a result.
    for (const input of [
      new Uint8Array(0),
      new Uint8Array([0xff]),
      new Uint8Array([0x03, 0xff, 0xff, 1, 2, 3]),
      subscribeWithToken().slice(0, 4),
      subscribeWithToken(),
    ]) {
      expect(() => DRAFT20_ADAPTER.redactAuthTokens(input)).not.toThrow()
    }
  })

  it('counts a frame it could not parse as unmaskable rather than as clean', () => {
    // An unknown codepoint is something a peer may send, and it ships raw
    // on purpose. Its parameters were never walked, so "nothing found" is not
    // "nothing there" — and the difference is a number, not a footnote.
    const raw = subscribeWithToken()
    const { framer } = run(
      raw,
      true,
      adapterReturning({ bytes: raw, redacted: 0, incomplete: false, decoded: false }),
    )
    expect(framer.unmaskableCount).toBe(1)
    expect(framer.redactionFailureCount).toBe(0)
  })
})
