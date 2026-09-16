import { describe, expect, it } from 'vitest'
import { createDraft16Codec, redactAuthTokens } from '../../drafts/draft16/codec.js'
import {
  bytesToHex,
  flattenFetch,
  hexToBytes,
  loadVectorDir,
  normalizeDecoded,
  vectorParamsToMap,
} from '../helpers.js'

const codec = createDraft16Codec()

const vectorEntries = loadVectorDir('transport/draft16/codec/messages')

for (const { file, data: vectorFile } of vectorEntries) {
  const messageType = vectorFile.message_type

  describe(`draft-16 ${messageType} (${file})`, () => {
    for (const vector of vectorFile.vectors) {
      describe(`[${vector.id}] ${vector.description}`, () => {
        const bytes = hexToBytes(vector.hex)

        if (vector.error) {
          it('should fail to decode', () => {
            const result = codec.decodeMessage(bytes)
            expect(result.ok).toBe(false)
          })
        } else if (vector.decoded) {
          it('should decode correctly', () => {
            const result = codec.decodeMessage(bytes)
            expect(result.ok).toBe(true)
            if (!result.ok) return

            const normalized = normalizeDecoded(result.value as unknown as Record<string, unknown>)

            const expected = { ...vector.decoded }
            assertFieldsMatch(normalized, expected, messageType)
          })

          // Only test re-encode for canonical vectors (canonical defaults to true)
          if (vector.canonical !== false) {
            it('should re-encode to same bytes', () => {
              const result = codec.decodeMessage(bytes)
              if (!result.ok) {
                expect.fail('decode failed, cannot test re-encode')
                return
              }

              const reEncoded = codec.encodeMessage(result.value)
              expect(bytesToHex(reEncoded)).toBe(vector.hex)
            })
          }
        }
      })
    }
  })
}

/**
 * Assert that decoded message fields match expected test vector fields.
 * Handles the nuances of parameter comparison and type coercion.
 */
function assertFieldsMatch(
  actual: Record<string, unknown>,
  expected: Record<string, unknown>,
  messageType: string,
): void {
  // For fetch messages, flatten our nested structure for comparison
  const flatActual = messageType === 'fetch' ? flattenFetch(actual) : actual

  for (const [key, expectedValue] of Object.entries(expected)) {
    // Every Key-Value-Pair block is a list of entries in the corpus and a map
    // keyed by name in this codec, so they all go through the same collapse.
    if (
      key === 'parameters' ||
      key === 'options' ||
      key === 'track_properties' ||
      key === 'track_extensions'
    ) {
      assertParamsMatch(flatActual[key] as Record<string, unknown> | undefined, expectedValue)
      continue
    }

    const actualValue = flatActual[key]

    if (Array.isArray(expectedValue)) {
      expect(actualValue).toEqual(expectedValue)
    } else {
      expect(String(actualValue)).toBe(String(expectedValue))
    }
  }
}

function assertParamsMatch(
  actualParams: Record<string, unknown> | undefined,
  expectedEntries: unknown,
): void {
  const { named: expectedParams, repeated } = vectorParamsToMap(expectedEntries)
  expect(repeated, 'this codec has one slot per parameter name').toEqual([])
  // Normalize: empty params {} should match missing params
  if (Object.keys(expectedParams).length === 0) {
    if (actualParams) {
      const nonEmpty = Object.entries(actualParams).filter(([k, v]) => {
        if (k === 'unknown' && Array.isArray(v) && v.length === 0) return false
        return v !== undefined
      })
      expect(nonEmpty.length).toBe(0)
    }
    return
  }

  expect(actualParams).toBeDefined()
  if (!actualParams) return

  for (const [pk, pv] of Object.entries(expectedParams)) {
    if (pk === 'unknown') {
      const actualUnknown = (actualParams.unknown as Array<Record<string, unknown>>).map((u) => ({
        ...u,
        length: String(u.length),
      }))
      expect(actualUnknown).toEqual(pv)
    } else if (typeof pv === 'object' && pv !== null && !Array.isArray(pv)) {
      // Nested param object (e.g. subscription_filter, largest_object)
      const actualNested = actualParams[pk] as Record<string, unknown>
      expect(actualNested).toBeDefined()
      for (const [nk, nv] of Object.entries(pv as Record<string, unknown>)) {
        const av = actualNested[nk]
        const actual = av instanceof Uint8Array ? Buffer.from(av).toString('hex') : String(av)
        expect(actual).toBe(String(nv))
      }
    } else {
      expect(String(actualParams[pk])).toBe(String(pv))
    }
  }
}

/**
 * Draft-16 Setup Parameters are delta-encoded Key-Value-Pairs.
 *
 * Section 1.4.2: "Key-Value-Pairs encode a Type value as a delta from the
 * previous Type value, or from 0 if there is no previous Type value." Section
 * 9.2 puts Setup Parameters inside that structure -- "Parameters are serialized
 * as Key-Value-Pairs" -- so a Setup Parameter's Type is a delta too, and the
 * parity rule that decides whether a Length follows ("Only present when Type is
 * odd") reads the *resolved* Type, not the delta that encoded it. Drafts 15 and
 * earlier wrote the Type absolutely; draft-16 Appendix A.1 records the change as
 * "Delta encode Key-Value-Pairs for Parameters and Headers".
 *
 * Every draft-16 setup vector in the IETF corpus carries at most one parameter,
 * where a delta and an absolute Type are the same byte. So none of them can tell
 * the two encodings apart, and a codec whose encoder and decoder are wrong in
 * the same direction round-trips all of them. Each case below needs two or more
 * parameters for exactly that reason.
 */
describe('draft-16 setup parameters use delta-encoded Types', () => {
  /**
   * A real SERVER_SETUP from `cdn.moq.dev` (moq-lite-rs), 31 bytes on the wire.
   *
   * Read as deltas it consumes exactly its 28-byte payload: MAX_REQUEST_ID
   * (0x02), then a delta of 5 to MOQT_IMPLEMENTATION (0x07), then a delta of
   * 0x40b53 to an unregistered 0x40b5a. Read as absolute Types the third
   * parameter resolves to the odd 0x40b53, whose Length then runs one byte past
   * the end of the payload -- which is how this was found.
   */
  const CDN_MOQ_DEV_SERVER_SETUP = '21001c0302c0000000ffffffff050b6d6f712d6c6974652d727380040b5301'

  it('decodes a SERVER_SETUP captured from cdn.moq.dev', () => {
    const result = codec.decodeMessage(hexToBytes(CDN_MOQ_DEV_SERVER_SETUP))
    expect(result.ok, 'absolute Types overrun this frame by one byte').toBe(true)
    if (!result.ok) return
    expect(result.value.type).toBe('server_setup')
    if (result.value.type !== 'server_setup') return

    const params = result.value.parameters
    expect(params.max_request_id).toBe(0xffffffffn)
    // The discriminator: 0x07 under deltas, 0x05 (AUTHORITY) under absolute.
    expect(params.moqt_implementation).toBe('moq-lite-rs')
    expect(params.authority).toBeUndefined()
    expect(params.unknown).toEqual([{ id: '0x40b5a', length: 1, raw_hex: '01' }])
  })

  it('re-encodes that SERVER_SETUP to the captured bytes', () => {
    const result = codec.decodeMessage(hexToBytes(CDN_MOQ_DEV_SERVER_SETUP))
    if (!result.ok) {
      expect.fail('decode failed, cannot test re-encode')
      return
    }
    expect(bytesToHex(codec.encodeMessage(result.value))).toBe(CDN_MOQ_DEV_SERVER_SETUP)
  })

  /**
   * PATH (0x01), MAX_REQUEST_ID (0x02) and MOQT_IMPLEMENTATION (0x07) in one
   * CLIENT_SETUP. A Delta Type is an unsigned varint, so ascending order is the
   * only order the wire format can express, and the Types go out as 1, 1, 5.
   */
  const MULTI_PARAM_CLIENT_SETUP = '2000160301042f6d6f71014064050a6d6f717461702f312e30'
  /** The same three parameters with absolute Types: 1, 2, 7. */
  const MULTI_PARAM_ABSOLUTE = '2000160301042f6d6f71024064070a6d6f717461702f312e30'

  it('encodes a three-parameter CLIENT_SETUP as differences, not absolute Types', () => {
    const encoded = codec.encodeMessage({
      type: 'client_setup',
      parameters: {
        path: '/moq',
        max_request_id: 100n,
        moqt_implementation: 'moqtap/1.0',
      },
    })
    expect(bytesToHex(encoded)).toBe(MULTI_PARAM_CLIENT_SETUP)
    expect(bytesToHex(encoded)).not.toBe(MULTI_PARAM_ABSOLUTE)
  })

  it('round-trips a three-parameter CLIENT_SETUP', () => {
    const result = codec.decodeMessage(hexToBytes(MULTI_PARAM_CLIENT_SETUP))
    expect(result.ok).toBe(true)
    if (!result.ok || result.value.type !== 'client_setup') return
    expect(result.value.parameters).toEqual({
      path: '/moq',
      max_request_id: 100n,
      moqt_implementation: 'moqtap/1.0',
    })
    expect(bytesToHex(codec.encodeMessage(result.value))).toBe(MULTI_PARAM_CLIENT_SETUP)
  })

  it('rejects the absolute-Type spelling of those parameters', () => {
    // Not a claim about what a peer should send -- it is what makes the vector
    // above worth having. Reading its second Type as a delta gives 0x03, an odd
    // Type whose Length is then read from the MAX_REQUEST_ID value: 100 bytes
    // out of a 22-byte payload. The two encodings are distinguishable, which is
    // what lets a test over them fail.
    const result = codec.decodeMessage(hexToBytes(MULTI_PARAM_ABSOLUTE))
    expect(result.ok).toBe(false)
  })
})

/**
 * An Authorization Token in a *later* setup-parameter position is still masked.
 *
 * `redactAuthTokens` learns where a credential sits by decoding the frame and
 * recording the span the decoder walked over. A decoder that resolves Types
 * wrongly never matches SETUP_PARAM_AUTHORIZATION_TOKEN (0x03), records no
 * span, and `redactWith` then returns the frame *unredacted*.
 *
 * Nothing downstream notices. `control-framer` drops a frame only when a span
 * was out of bounds, and counts `unmaskable` only when the decode did not
 * complete -- and reading the Types absolutely here does complete, on a
 * parameter it reports as a PATH. So the frame ships with the credential in it,
 * `redacted` at 0 and no counter moved. Reading Types absolutely matched 0x03
 * only when the token was the first setup parameter, which is why this shape
 * leaked and the one below it did not, with `privacy.maskAuthParams` on.
 */
describe('draft-16 auth token masking does not depend on parameter position', () => {
  /** A byte pattern no other field in these fixtures produces. */
  const SECRET = 'deadbeefcafebabe'

  function contains(haystack: Uint8Array, needleHex: string): boolean {
    return bytesToHex(haystack).includes(needleHex)
  }

  /**
   * CLIENT_SETUP carrying MAX_REQUEST_ID (0x02) and then AUTHORIZATION_TOKEN
   * (delta 0x01 -> 0x03), Alias Type USE_VALUE.
   *
   * Read absolutely the second Type is 0x01 (PATH), which is also odd and whose
   * Length happens to cover the rest of the payload exactly: the frame decodes
   * cleanly, reports a PATH, and hands the credential straight through.
   */
  const TOKEN_SECOND = `20001002024064010a0301${SECRET}`
  /** The same token as the only parameter, which was masked all along. */
  const TOKEN_FIRST = `20000d01030a0301${SECRET}`

  it('masks a token that is the only setup parameter', () => {
    const result = redactAuthTokens(hexToBytes(TOKEN_FIRST))
    expect(result.redacted).toBe(1)
    expect(contains(result.bytes, SECRET)).toBe(false)
  })

  it('masks a token in the second setup-parameter position', () => {
    const frame = hexToBytes(TOKEN_SECOND)
    expect(contains(frame, SECRET), 'fixture should carry the secret').toBe(true)

    const result = redactAuthTokens(frame)
    expect(result.redacted, 'no span recorded means the frame ships unredacted').toBe(1)
    expect(result.incomplete).toBe(false)
    expect(result.decoded).toBe(true)
    expect(contains(result.bytes, SECRET)).toBe(false)
    expect(result.bytes.byteLength).toBe(frame.byteLength)
    // Everything that is structure rather than secret survives.
    expect(bytesToHex(result.bytes)).toBe('20001002024064010a03010000000000000000')
  })

  it('leaves the rest of the message readable after masking', () => {
    const result = redactAuthTokens(hexToBytes(TOKEN_SECOND))
    const decoded = codec.decodeMessage(result.bytes)
    expect(decoded.ok).toBe(true)
    if (!decoded.ok || decoded.value.type !== 'client_setup') return
    const params = decoded.value.parameters
    expect(params.max_request_id).toBe(100n)
    expect(params.path, 'absolute Types read this token as a PATH').toBeUndefined()
    expect(params.authorization_token).toHaveLength(1)
    const token = params.authorization_token?.[0]
    expect(token?.alias_type).toBe(3n)
    expect(token?.token_type).toBe(1n)
    expect(bytesToHex(token?.token_value as Uint8Array)).toBe('0000000000000000')
  })
})
