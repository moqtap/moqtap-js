import { describe, expect, it } from 'vitest'
import { MoqtBufferWriter } from '../../core/buffer-writer.js'
import { createDraft23Codec, UNKNOWN_STREAM_COUNT } from '../../drafts/draft23/codec.js'
import { SessionTerminationCode as Close } from '../../drafts/draft23/error-codes.js'
import { checkRequestOk } from '../../drafts/draft23/rules.js'
import type { Draft23Message, Draft23Params, LocationFilter } from '../../drafts/draft23/types.js'
import {
  bytesToHex,
  expectPropertyList,
  hexToBytes,
  loadVectorDir,
  normalizeDecoded,
  vectorParamsToMap,
} from '../helpers.js'

const codec = createDraft23Codec()

const vectorEntries = loadVectorDir('transport/draft23/codec/messages')

/**
 * Guard against a vector file that stops being found, or a vector no assertion
 * reaches. Both counts are the contents of transport/draft23/codec/messages.
 */
const EXPECTED_FILES = 20
const EXPECTED_VECTORS = 309

describe('draft-23 message vector corpus', () => {
  it('loads every message vector file', () => {
    expect(vectorEntries.map((e) => e.file).sort()).toEqual([
      'fetch.json',
      'goaway.json',
      'namespace-done.json',
      'namespace.json',
      'publish-done.json',
      'publish-namespace.json',
      'publish-ok.json',
      'publish-skipped.json',
      'publish-state-notify.json',
      'publish.json',
      'request-error.json',
      'request-ok.json',
      'request-update.json',
      'setup.json',
      'subscribe-namespace.json',
      'subscribe-ok.json',
      'subscribe-tracks.json',
      'subscribe.json',
      'track-status.json',
      'unknown-type.json',
    ])
    expect(vectorEntries.length).toBe(EXPECTED_FILES)
  })

  it('executes every vector in them', () => {
    const total = vectorEntries.reduce((n, e) => n + e.data.vectors.length, 0)
    expect(total).toBe(EXPECTED_VECTORS)
    for (const { file, data } of vectorEntries) {
      for (const vector of data.vectors) {
        expect(
          Boolean(vector.decoded) !== Boolean(vector.error),
          `${file} [${vector.id}] must declare exactly one of decoded/error`,
        ).toBe(true)
      }
    }
  })

  it('names a close code for every refusal it does not merely wait on', () => {
    const named = new Set(Object.keys(CLOSE_CODES))
    const errors = vectorEntries.flatMap(({ file, data }) =>
      data.vectors.filter((v) => v.error && v.error !== 'incomplete').map((v) => `${file}/${v.id}`),
    )
    expect(errors.filter((id) => !named.has(id))).toEqual([])
    expect([...named].filter((id) => !errors.includes(id))).toEqual([])
  })
})

/**
 * The draft-23 session termination code each refusing vector calls for, by
 * `file/id`. `incomplete` vectors are absent: their frame is not all there, so
 * the decoder waits for more bytes instead of naming a code.
 */
const CLOSE_CODES: Readonly<Record<string, bigint | undefined>> = {
  'fetch.json/invalid-filter-type': Close.InvalidParameter,
  'fetch.json/location-filter-fields-overrun-payload': Close.MalformedMessage,
  'fetch.json/location-filter-end-group-overflow': Close.DeltaEncodingOverflow,
  'fetch.json/location-filter-end-group-overflow-full-range': Close.DeltaEncodingOverflow,
  'fetch.json/fill-parameters-out-of-scope': Close.InvalidParameter,
  'fetch.json/paused-out-of-scope': Close.InvalidParameter,
  'fetch.json/include-properties-invalid-value': Close.InvalidParameter,
  'fetch.json/empty-track-name': Close.ProtocolViolation,
  'namespace.json/draft22-form': Close.MalformedMessage,
  'namespace.json/with-auth-token': Close.InvalidParameter,
  'publish-ok.json/with-subscriber-priority': Close.InvalidParameter,
  'publish-ok.json/with-object-delivery-timeout': Close.InvalidParameter,
  'publish-ok.json/with-subgroup-delivery-timeout': Close.InvalidParameter,
  'publish-ok.json/with-paused': Close.InvalidParameter,
  'publish-ok.json/with-location-filter': Close.InvalidParameter,
  'publish-ok.json/with-new-group-request': Close.InvalidParameter,
  'publish-ok.json/with-objectid-filter': Close.InvalidParameter,
  'publish-ok.json/with-largest-object': Close.InvalidParameter,
  'publish-ok.json/with-forward': Close.InvalidParameter,
  'publish-ok.json/with-track-properties': Close.InvalidField,
  'publish-state-notify.json/with-forward': Close.InvalidParameter,
  'publish-state-notify.json/paused-invalid-value': Close.InvalidParameter,
  'publish-state-notify.json/expires-out-of-scope': Close.InvalidParameter,
  'publish-state-notify.json/subscriber-priority-out-of-scope': Close.InvalidParameter,
  'publish.json/with-forward': Close.InvalidParameter,
  'publish.json/empty-track-name': Close.ProtocolViolation,
  'request-error.json/redirect-detail-trailing-bytes': Close.MalformedKeyValue,
  'request-error.json/redirect-without-detail': Close.MalformedMessage,
  'request-error.json/redirect-draft22-form': Close.MalformedMessage,
  'request-ok.json/length-zero': Close.MalformedMessage,
  'request-update.json/with-forward': Close.InvalidParameter,
  // ROLE_VIOLATION at a server, UNKNOWN_AUTH_TOKEN_ALIAS at a client. The
  // runner passes no role, so the decoder names neither.
  'setup.json/with-auth-token-delete': undefined,
  'setup.json/length-over-max-control-message-size': Close.FieldLengthExceeded,
  'subscribe-tracks.json/rendezvous-timeout-out-of-scope': Close.InvalidParameter,
  'subscribe-tracks.json/new-group-request-out-of-scope': Close.InvalidParameter,
  'subscribe-tracks.json/subscribe-tracks-id-out-of-scope': Close.InvalidParameter,
  'subscribe-tracks.json/expires-out-of-scope': Close.InvalidParameter,
  'subscribe-tracks.json/with-forward': Close.InvalidParameter,
  'subscribe.json/include-properties-invalid-value': Close.InvalidParameter,
  'subscribe.json/paused-invalid-value': Close.InvalidParameter,
  'subscribe.json/fill-parameters-invalid-nested-param': Close.InvalidParameter,
  'subscribe.json/fill-parameters-nested': Close.InvalidParameter,
  'subscribe.json/fill-parameters-draft22-length': Close.InvalidParameter,
  'subscribe.json/with-forward': Close.InvalidParameter,
  'subscribe.json/unknown-extension-param': Close.InvalidParameter,
  'subscribe.json/invalid-filter-type': Close.InvalidParameter,
  'subscribe.json/subscribe-tracks-id-out-of-scope': Close.InvalidParameter,
  'subscribe.json/auth-token-unknown-alias-type': Close.MalformedAuthToken,
  'subscribe.json/empty-track-name': Close.ProtocolViolation,
  'subscribe.json/namespace-33-fields': Close.InvalidTrackNamespace,
  'subscribe.json/empty-namespace-field': Close.InvalidTrackNamespace,
  'track-status.json/empty-track-name': Close.ProtocolViolation,
  'unknown-type.json/unknown-type-with-payload': Close.UnexpectedMessage,
  'unknown-type.json/fetch-ok-reserved': Close.UnexpectedMessage,
}

/**
 * PUBLISH_OK is a REQUEST_OK, and draft-23 Section 9.3 narrows what it may
 * carry: "PUBLISH_OK: EXPIRES" and Track Properties "are empty in PUBLISH_OK".
 * The frame does not say it answers a PUBLISH, so the codec decodes the union
 * every REQUEST_OK admits; the rest of the rule is `checkRequestOk`, which the
 * session state machine applies on a PUBLISH stream and this runner applies to
 * the file that says what it holds.
 */
function decodeAs(file: string, bytes: Uint8Array) {
  const result = codec.decodeMessage(bytes)
  if (!result.ok || file !== 'publish-ok.json' || result.value.type !== 'request_ok') return result
  const broken = checkRequestOk('publish_ok', result.value)
  if (broken === null) return result
  return { ok: false as const, closeCode: broken.closeCode }
}

for (const { file, data: vectorFile } of vectorEntries) {
  const messageType = vectorFile.message_type

  describe(`draft-23 ${messageType} (${file})`, () => {
    for (const vector of vectorFile.vectors) {
      describe(`[${vector.id}] ${vector.description}`, () => {
        const bytes = hexToBytes(vector.hex)

        if (vector.error) {
          it('should fail to decode', () => {
            const result = decodeAs(file, bytes)
            expect(result.ok).toBe(false)
            if (result.ok) return
            const closeCode = 'error' in result ? result.error.closeCode : result.closeCode
            if (vector.error === 'incomplete') {
              expect('error' in result && result.error.code).toBe('UNEXPECTED_END')
              expect(closeCode).toBeUndefined()
            } else {
              expect('error' in result && result.error.code).not.toBe('UNEXPECTED_END')
              expect(closeCode).toBe(CLOSE_CODES[`${file}/${vector.id}`])
            }
          })
        } else if (vector.decoded) {
          it('should decode correctly', () => {
            const result = decodeAs(file, bytes)
            expect(result.ok).toBe(true)
            if (!result.ok) return

            const normalized = normalizeDecoded(result.value as unknown as Record<string, unknown>)
            assertMatches(normalized, vector.decoded, messageType)
          })

          if (vector.canonical !== false) {
            it('should re-encode to same bytes', () => {
              const result = codec.decodeMessage(bytes)
              if (!result.ok) {
                expect.fail('decode failed, cannot test re-encode')
                return
              }
              expect(bytesToHex(codec.encodeMessage(result.value))).toBe(vector.hex)
            })
          }
        }
      })
    }
  })
}

/** How draft-23 writes an even Key-Value-Pair's value: one MOQT vi64. */
function vi64Hex(value: bigint): string {
  const w = new MoqtBufferWriter(16)
  w.writeVarInt(value)
  return bytesToHex(w.finish())
}

/** Whether this path names a Key-Value-Pair block. */
function isKvpBlockPath(path: string): boolean {
  const last = path.split('.').pop() ?? ''
  return (
    last === 'parameters' ||
    last === 'options' ||
    last === 'track_properties' ||
    last === 'error_details' ||
    last === 'fill_parameters' ||
    last === 'value'
  )
}

/**
 * Compare a decoded message against a vector's `decoded` tree, recursively,
 * checking every key the vector states at every depth.
 */
function assertMatches(actual: unknown, expected: unknown, path: string): void {
  // A Key-Value-Pair block is a list of entries in the corpus and a map keyed
  // by name in this codec, so it is collapsed before the trees are compared.
  // Immutable Properties hold a Key-Value-Pair sequence of their own, which
  // the corpus renders as a nested list and this codec keeps as the bytes that
  // carry it, so the bytes are decoded for the comparison.
  if (Array.isArray(expected) && path.endsWith('.immutable_properties')) {
    expectPropertyList(codec.decodeObjectProperties, hexToBytes(actual as string), expected, path)
    return
  }
  if (Array.isArray(expected) && isKvpBlockPath(path)) {
    const { named, repeated } = vectorParamsToMap(expected, vi64Hex)
    expect(repeated, `${path}: this codec has one slot per parameter name`).toEqual([])
    assertMatches(actual, named, path)
    return
  }

  if (Array.isArray(expected)) {
    expect(Array.isArray(actual), path).toBe(true)
    const actualArray = actual as unknown[]
    expect(actualArray.length, `${path}.length`).toBe(expected.length)
    for (const [i, item] of expected.entries()) {
      assertMatches(actualArray[i], item, `${path}[${i}]`)
    }
    return
  }

  if (expected !== null && typeof expected === 'object') {
    const expectedObject = expected as Record<string, unknown>

    if (Object.keys(expectedObject).length === 0) {
      // `{}` means "nothing here": an absent object or one whose only content
      // is an empty `unknown` passthrough array.
      if (actual === undefined) return
      const meaningful = Object.entries(actual as Record<string, unknown>).filter(([k, v]) => {
        if (k === 'unknown' && Array.isArray(v) && v.length === 0) return false
        return v !== undefined
      })
      expect(meaningful, `${path} should be empty`).toEqual([])
      return
    }

    expect(actual, path).toBeDefined()
    const actualObject = (actual ?? {}) as Record<string, unknown>
    for (const [key, value] of Object.entries(expectedObject)) {
      assertMatches(actualObject[key], value, `${path}.${key}`)
    }
    return
  }

  expect(String(actual), path).toBe(String(expected))
}

// ─── Byte-level checks the corpus does not make ─────────────────────────────

function encodeHex(message: Draft23Message): string {
  return bytesToHex(codec.encodeMessage(message))
}

function decodeError(hex: string) {
  const result = codec.decodeMessage(hexToBytes(hex))
  if (result.ok) throw new Error(`${hex}: decoded, but should have failed`)
  return result.error
}

describe('draft-23 control message framing (Section 9)', () => {
  it('writes the Length as a vi64', () => {
    // REQUEST_OK with no parameters: body 00, Length 1 in one byte.
    expect(encodeHex({ type: 'request_ok', parameters: {}, track_properties: {} })).toBe('070100')
  })

  it('reads a Length above 127 in two bytes and above 16383 in three', () => {
    const reason = 'x'.repeat(200)
    const hex = encodeHex({
      type: 'publish_done',
      status_code: 0n,
      stream_count: 0n,
      reason_phrase: reason,
    })
    // body: 00 00 80c8 + 200 bytes = 204 = 0xcc, written 80cc.
    expect(hex.startsWith('0b80cc000080c8')).toBe(true)
    expect(codec.decodeMessage(hexToBytes(hex)).ok).toBe(true)

    const big = encodeHex({
      type: 'request_ok',
      parameters: {},
      track_properties: { immutable_properties: new Uint8Array(20000) },
    })
    // body: 00 0b c04e20 + 20000 bytes = 20005 = 0x4e25, written c04e25.
    expect(big.startsWith('07c04e25000bc04e20')).toBe(true)
    expect(codec.decodeMessage(hexToBytes(big)).ok).toBe(true)
  })

  it('reads a draft-22 16-bit Length as a short body', () => {
    // 07 00 01 00 is a draft-22 REQUEST_OK. Read as draft-23 it is Length 0,
    // a REQUEST_OK with no Number of Parameters.
    const error = decodeError('07000100')
    expect(error.closeCode).toBe(Close.MalformedMessage)
  })

  it('refuses bytes left after the body', () => {
    // GOAWAY with an empty URI and Timeout 0, then one byte the body has no field for.
    expect(codec.decodeMessage(hexToBytes('10020000')).ok).toBe(true)
    expect(decodeError('1003000000').closeCode).toBe(Close.MalformedMessage)
  })

  it('waits for a frame whose body has not all arrived, rather than naming a code', () => {
    const error = decodeError('0b80cc0000')
    expect(error.code).toBe('UNEXPECTED_END')
    expect(error.closeCode).toBeUndefined()
  })

  describe('MAX_CONTROL_MESSAGE_SIZE on the Length', () => {
    const big: Draft23Message = {
      type: 'request_ok',
      parameters: {},
      track_properties: { immutable_properties: new Uint8Array(0xffff) },
    }
    const bigBytes = codec.encodeMessage(big, { maxControlMessageSize: 70000n })

    it('refuses to encode past the given limit', () => {
      expect(() => codec.encodeMessage(big, { maxControlMessageSize: 65535n })).toThrow()
      expect(bigBytes.length).toBeGreaterThan(65535)
    })

    it('refuses a longer message with FIELD_LENGTH_EXCEEDED, and accepts it under a larger limit or none', () => {
      const refused = codec.decodeMessage(bigBytes, { maxControlMessageSize: 65535n })
      expect(refused.ok || refused.error.closeCode).toBe(Close.FieldLengthExceeded)
      expect(codec.decodeMessage(bigBytes, { maxControlMessageSize: 70000n }).ok).toBe(true)
      expect(codec.decodeMessage(bigBytes).ok).toBe(true)
    })

    it('holds SETUP to 65535 whatever limit is given', () => {
      // A Path of 65540 bytes: the Length is above 65535.
      const body = `01${vi64Hex(65540n)}${'61'.repeat(65540)}`
      const hex = `af00${vi64Hex(BigInt(body.length / 2))}${body}`
      const result = codec.decodeMessage(hexToBytes(hex), { maxControlMessageSize: 1048576n })
      expect(result.ok || result.error.closeCode).toBe(Close.FieldLengthExceeded)
    })

    it('fails a stream as soon as an oversized Length has arrived', async () => {
      // Type 0x07, then the Length: the first bytes with which the one-shot
      // decoder already names the code.
      let head = 1
      for (; head < bigBytes.length; head++) {
        const r = codec.decodeMessage(bigBytes.subarray(0, head), { maxControlMessageSize: 65535n })
        if (!r.ok && r.error.closeCode !== undefined) break
      }
      expect(head).toBeLessThan(10)
      const decoder = codec.createStreamDecoder({ maxControlMessageSize: 65535n })
      const writer = decoder.writable.getWriter()
      const reader = decoder.readable.getReader()
      writer.write(bigBytes.subarray(0, head)).catch(() => {})
      await expect(reader.read()).rejects.toMatchObject({ closeCode: Close.FieldLengthExceeded })
    })
  })

  it('treats the reserved FETCH_OK type 0x18 as unknown', () => {
    const error = decodeError('180100')
    expect(error.code).toBe('UNKNOWN_MESSAGE_TYPE')
    expect(error.closeCode).toBe(Close.UnexpectedMessage)
  })
})

describe('draft-23 MAX_CONTROL_MESSAGE_SIZE (Section 9.1.8)', () => {
  it('writes the odd-typed option as a Length and one varint', () => {
    expect(encodeHex({ type: 'setup', options: { max_control_message_size: 1048576n } })).toBe(
      'af00050903d00000',
    )
  })

  it('refuses a value whose Length bytes are not exactly one varint', () => {
    // Length 4 around the three-byte varint c0ffff.
    expect(decodeError('af00060904c0ffff00').closeCode).toBe(Close.MalformedKeyValue)
    // Length 1 holding the first byte of a three-byte varint.
    expect(decodeError('af00030901c0').closeCode).toBe(Close.MalformedKeyValue)
  })

  it('refuses to send less than 65535', () => {
    expect(() =>
      encodeHex({ type: 'setup', options: { max_control_message_size: 65534n } }),
    ).toThrow()
  })
})

describe('draft-23 SETUP Authorization Token aliases (Section 8.9, Section 9.1.4)', () => {
  // The corpus vector with-auth-token-delete: DELETE of alias 0.
  const deleteUnregistered = 'af000403020000'
  // REGISTER alias 5 (token type 0, value "a"), then DELETE alias 5.
  const registerThenDelete = 'af000a03040105006100020005'

  it('names no code without a role, and the code for the role with one', () => {
    expect(decodeError(deleteUnregistered).closeCode).toBeUndefined()
    const asServer = codec.decodeMessage(hexToBytes(deleteUnregistered), { role: 'server' })
    expect(asServer.ok || asServer.error.closeCode).toBe(Close.RoleViolation)
    const asClient = codec.decodeMessage(hexToBytes(deleteUnregistered), { role: 'client' })
    expect(asClient.ok || asClient.error.closeCode).toBe(Close.UnknownAuthTokenAlias)
  })

  it('refuses any DELETE at a server, even of an alias the SETUP registered', () => {
    expect(codec.decodeMessage(hexToBytes(registerThenDelete)).ok).toBe(true)
    expect(codec.decodeMessage(hexToBytes(registerThenDelete), { role: 'client' }).ok).toBe(true)
    const asServer = codec.decodeMessage(hexToBytes(registerThenDelete), { role: 'server' })
    expect(asServer.ok || asServer.error.closeCode).toBe(Close.RoleViolation)
  })
})

describe('draft-23 Key-Value-Pairs (Section 8.3)', () => {
  it('refuses a Setup Option Length above 2^16-1', () => {
    expect(decodeError('af00040bc10000').closeCode).toBe(Close.FieldLengthExceeded)
  })

  it('refuses a Type above 2^64-1', () => {
    // MAX_AUTH_TOKEN_CACHE_SIZE 0, then a Delta Type of 2^64-1 on top of 0x04.
    expect(decodeError(`af000b0400${'ff'.repeat(9)}`).closeCode).toBe(Close.DeltaEncodingOverflow)
  })

  it('refuses out-of-range Track Property values with MALFORMED_KEY_VALUE (Section 10.4, Section 10.5, Section 10.6)', () => {
    // SUBSCRIBE_OK, alias 0, no parameters, then one Track Property.
    expect(decodeError('040500000e8100').closeCode).toBe(Close.MalformedKeyValue)
    expect(decodeError('040400002203').closeCode).toBe(Close.MalformedKeyValue)
    expect(decodeError('040400003002').closeCode).toBe(Close.MalformedKeyValue)
  })
})

describe('draft-23 Track Namespace and Track Name (Section 2.4.1, Section 8.7)', () => {
  it('refuses an empty namespace field with INVALID_TRACK_NAMESPACE', () => {
    // SUBSCRIBE_NAMESPACE, Request ID 1, namespace of one empty field.
    expect(decodeError('500401010000').closeCode).toBe(Close.InvalidTrackNamespace)
  })

  it('refuses more than 32 fields with INVALID_TRACK_NAMESPACE', () => {
    const body = `0121${'0161'.repeat(33)}00`
    const hex = `50${(body.length / 2).toString(16)}${body}`
    expect(decodeError(hex).closeCode).toBe(Close.InvalidTrackNamespace)
  })

  it('refuses to encode an empty Track Name', () => {
    expect(() =>
      encodeHex({
        type: 'subscribe',
        request_id: 2n,
        track_namespace: ['a'],
        track_name: '',
        parameters: {},
      }),
    ).toThrow()
  })

  it('accepts the empty Track Name a namespace-scoped REDIRECT carries', () => {
    const message: Draft23Message = {
      type: 'request_error',
      error_code: 0x34n,
      retry_interval: 0n,
      reason_phrase: '',
      error_details: { redirect: { connect_uri: '', track_namespace: ['a'], track_name: '' } },
    }
    const hex = encodeHex(message)
    expect(hex).toBe('050a34000001050001016100')
    const decoded = codec.decodeMessage(hexToBytes(hex))
    expect(decoded.ok && decoded.value).toEqual(message)
  })
})

describe('draft-23 REQUEST_ERROR Error Details (Section 9.4.2)', () => {
  it('refuses to send Error Code REDIRECT without the REDIRECT detail', () => {
    expect(() =>
      encodeHex({
        type: 'request_error',
        error_code: 0x34n,
        retry_interval: 0n,
        reason_phrase: '',
        error_details: {},
      }),
    ).toThrow()
  })

  // draft-23 Section 9.4.2 forbids the repeat to senders and names no receiver
  // action, so the second detail stays visible.
  it('keeps a second REDIRECT detail as raw bytes', () => {
    const body = '34000001060001016101620006000101610162'
    const hex = `05${(body.length / 2).toString(16).padStart(2, '0')}${body}`
    const decoded = codec.decodeMessage(hexToBytes(hex))
    expect(decoded.ok && decoded.value).toEqual({
      type: 'request_error',
      error_code: 0x34n,
      retry_interval: 0n,
      reason_phrase: '',
      error_details: {
        redirect: { connect_uri: '', track_namespace: ['a'], track_name: 'b' },
        unknown: [{ id: '0x1', length: 6, raw_hex: '000101610162' }],
      },
    })
    if (decoded.ok) expect(encodeHex(decoded.value)).toBe(hex)
  })

  it('round-trips UNSUPPORTED_PROPERTY instances with a grease detail between them', () => {
    const message: Draft23Message = {
      type: 'request_error',
      error_code: 0x33n,
      retry_interval: 0n,
      reason_phrase: '',
      error_details: {
        unsupported_property: [0x4000n, 0x4002n],
        unknown: [{ id: '0x9d', length: 0, raw_hex: '' }],
      },
    }
    const hex = encodeHex(message)
    //          code 33, retry 0, reason "", 02 c04000, 00 c04002, delta 9b (odd 0x9d) length 0
    expect(hex).toBe('050e33000002c0400000c04002809b00')
    const decoded = codec.decodeMessage(hexToBytes(hex))
    expect(decoded.ok && decoded.value).toEqual(message)
  })
})

describe('draft-23 parameters (Section 9.19)', () => {
  function subscribeHex(paramsHex: string): string {
    const payload = `0101046c69766505766964656f${paramsHex}`
    return `03${(payload.length / 2).toString(16).padStart(2, '0')}${payload}`
  }

  function decodeSubscribeParams(hex: string): Draft23Params {
    const result = codec.decodeMessage(hexToBytes(hex))
    if (!result.ok) throw new Error(`${hex}: ${result.error.code} ${result.error.message}`)
    if (result.value.type !== 'subscribe') throw new Error(`${hex}: not a SUBSCRIBE`)
    return result.value.parameters
  }

  it('encodes PAUSED at 0x11 with 1 meaning paused (Section 9.19.18)', () => {
    expect(encodeHex({ type: 'request_update', request_id: 4n, parameters: { paused: 1n } })).toBe(
      '020404011101',
    )
  })

  it('refuses FORWARD (0x10) as an unknown parameter', () => {
    expect(decodeError(subscribeHex('011001')).closeCode).toBe(Close.InvalidParameter)
  })

  it('encodes FILL_PARAMETERS as a count with no byte length (Section 9.19.15)', () => {
    const hex = encodeHex({
      type: 'subscribe',
      request_id: 1n,
      track_namespace: ['live'],
      track_name: 'video',
      parameters: {
        location_filter: { filter_type: 5n },
        fill_parameters: {
          fill_timeout: 500n,
          location_filter: { filter_type: 1n, start_group: 1n },
        },
      },
    })
    expect(hex).toBe(subscribeHex('02210502020a81f4170101'))
  })

  it('restarts the Type Delta chain inside FILL_PARAMETERS and resumes the outer one from 0x23', () => {
    const hex = encodeHex({
      type: 'subscribe',
      request_id: 1n,
      track_namespace: ['live'],
      track_name: 'video',
      parameters: {
        fill_parameters: { subscriber_priority: 64n, group_order: 1n },
        new_group_request: 25n,
      },
    })
    //            count=02  0x23 [count=02 0x20 64 delta02(->0x22) 1]  delta0f(->0x32) 25
    expect(hex.endsWith('02' + '2302204002010f19')).toBe(true)
  })

  it('refuses a duplicated parameter that does not allow repeats', () => {
    expect(decodeError(subscribeHex('0220400040')).closeCode).toBe(Close.InvalidParameter)
  })

  it('refuses GROUP_ORDER outside 1 and 2 (Section 9.19.8)', () => {
    expect(decodeError(subscribeHex('012203')).closeCode).toBe(Close.InvalidParameter)
    expect(decodeSubscribeParams(subscribeHex('012202')).group_order).toBe(2n)
  })

  it('refuses to encode a parameter outside its scope', () => {
    expect(() =>
      encodeHex({
        type: 'request_ok',
        parameters: { subscriber_priority: 1n },
        track_properties: {},
      }),
    ).toThrow()
  })

  it('carries SUBSCRIBE_TRACKS_ID on a PUBLISH only (Section 9.19.21)', () => {
    const publish: Draft23Message = {
      type: 'publish',
      request_id: 1n,
      track_namespace: ['a'],
      track_name: 'b',
      track_alias: 0n,
      parameters: { subscribe_tracks_id: 2n },
      track_properties: {},
    }
    expect(encodeHex(publish)).toBe('1d0a01010161016200013602')
  })
})

describe('draft-23 LOCATION_FILTER (Section 9.19.9)', () => {
  function encodeFilter(location_filter: LocationFilter): string {
    return encodeHex({
      type: 'subscribe',
      request_id: 1n,
      track_namespace: ['live'],
      track_name: 'video',
      parameters: { location_filter },
    })
  }

  it('writes an inclusive four-field filter with no +1 on the end', () => {
    expect(
      encodeFilter({
        filter_type: 4n,
        start_group: 10n,
        start_object: 3n,
        end_group_delta: 5n,
        end_object: 7n,
      }).endsWith('0121040a030507'),
    ).toBe(true)
  })

  it('refuses a filter whose fields do not match its type', () => {
    expect(() => encodeFilter({ filter_type: 5n, start_group: 0n })).toThrow()
    expect(() => encodeFilter({ filter_type: 2n, start_group: 10n })).toThrow()
    expect(() => encodeFilter({ filter_type: 6n })).toThrow()
  })
})

describe('draft-23 PUBLISH_DONE', () => {
  it('round-trips the 2^64-1 Stream Count sentinel through bigint', () => {
    expect(UNKNOWN_STREAM_COUNT).toBe(2n ** 64n - 1n)
    const hex = encodeHex({
      type: 'publish_done',
      status_code: 0n,
      stream_count: UNKNOWN_STREAM_COUNT,
      reason_phrase: '',
    })
    expect(hex).toBe('0b0b00ffffffffffffffffff00')
    const decoded = codec.decodeMessage(hexToBytes(hex))
    expect(decoded.ok && decoded.value.type === 'publish_done' && decoded.value.stream_count).toBe(
      UNKNOWN_STREAM_COUNT,
    )
  })

  it('refuses a Reason Phrase over 1024 bytes (Section 8.5)', () => {
    expect(decodeError('0b0400008401').closeCode).toBe(Close.FieldLengthExceeded)
  })
})
