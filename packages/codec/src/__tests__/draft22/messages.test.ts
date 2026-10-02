import { describe, expect, it } from 'vitest'
import { createDraft22Codec, UNKNOWN_STREAM_COUNT } from '../../drafts/draft22/codec.js'
import type { Draft22Message, Draft22Params, LocationFilter } from '../../drafts/draft22/types.js'
import {
  bytesToHex,
  hexToBytes,
  loadVectorDir,
  normalizeDecoded,
  vectorParamsToMap,
} from '../helpers.js'

const codec = createDraft22Codec()

const vectorEntries = loadVectorDir('transport/draft22/codec/messages')

/**
 * Guard against the silent failure mode: a vector file that stops being found,
 * or a vector inside one that no assertion reaches. Both counts are the
 * published contents of transport/draft22/codec/messages, and both have to be
 * updated deliberately.
 */
const EXPECTED_FILES = 21
const EXPECTED_VECTORS = 246

describe('draft-22 message vector corpus', () => {
  it('loads every published message vector file', () => {
    expect(vectorEntries.map((e) => e.file).sort()).toEqual([
      'fetch-ok.json',
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
    // Every vector must declare exactly one of `decoded` or `error`, otherwise
    // the runner below would generate no assertion for it at all.
    for (const { file, data } of vectorEntries) {
      for (const vector of data.vectors) {
        expect(
          Boolean(vector.decoded) !== Boolean(vector.error),
          `${file} [${vector.id}] must declare exactly one of decoded/error`,
        ).toBe(true)
      }
    }
  })
})

for (const { file, data: vectorFile } of vectorEntries) {
  const messageType = vectorFile.message_type

  describe(`draft-22 ${messageType} (${file})`, () => {
    for (const vector of vectorFile.vectors) {
      describe(`[${vector.id}] ${vector.description}`, () => {
        const bytes = hexToBytes(vector.hex)

        if (vector.error) {
          it('should fail to decode', () => {
            const result = codec.decodeMessage(bytes)
            expect(result.ok).toBe(false)
            const code = LOCATION_FILTER_ERROR_CODES[vector.id]
            if (code !== undefined && !result.ok) expect(result.error.code).toBe(code)
          })
        } else if (vector.decoded) {
          it('should decode correctly', () => {
            const result = codec.decodeMessage(bytes)
            expect(result.ok).toBe(true)
            if (!result.ok) return

            const normalized = normalizeDecoded(result.value as unknown as Record<string, unknown>)
            assertMatches(normalized, vector.decoded, messageType)
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
 * The DecodeError code each LOCATION_FILTER failure in the corpus must produce.
 *
 * The corpus names an unknown Location Filter Type `invalid_value`, which this
 * codec reports as CONSTRAINT_VIOLATION as it does the out-of-range filter
 * types of drafts 10 to 14. Fields that run past the end of the message make
 * the parameter malformed, which is INVALID_PARAMETER. StartGroup +
 * EndGroupDelta above 2^64 - 1, which the corpus files as `invalid_parameter`,
 * is CONSTRAINT_VIOLATION here, as it is in draft-21: the sum is a value out of
 * range, not a parameter whose bytes are malformed (see `decodeLocationFilter`
 * in `drafts/draft22/codec.ts`).
 */
const LOCATION_FILTER_ERROR_CODES: Readonly<Record<string, string>> = {
  'invalid-filter-type': 'CONSTRAINT_VIOLATION',
  'location-filter-fields-overrun-payload': 'INVALID_PARAMETER',
  'location-filter-end-group-overflow': 'CONSTRAINT_VIOLATION',
  'location-filter-end-group-overflow-full-range': 'CONSTRAINT_VIOLATION',
}

/**
 * Compare a decoded message against a vector's `decoded` tree, recursively.
 *
 * Every key the vector states is checked, at every depth — draft-22 nests
 * parameters two levels deep inside FILL_PARAMETERS, and a comparison that
 * stringified an object would pass on "[object Object]" without looking at
 * anything.
 */
/** Whether this path names a Key-Value-Pair block. */
function isKvpBlockPath(path: string): boolean {
  const last = path.split('.').pop() ?? ''
  return (
    last === 'parameters' ||
    last === 'options' ||
    last === 'track_properties' ||
    last === 'track_extensions' ||
    last === 'fill_parameters' ||
    last === 'value'
  )
}

function assertMatches(actual: unknown, expected: unknown, path: string): void {
  // A Key-Value-Pair block is a list of entries in the corpus and a map keyed
  // by name in this codec, so it is collapsed before the trees are compared.
  // Nested blocks are the same shape, which is what makes `value` one of the
  // paths worth checking: draft-22's FILL_PARAMETERS holds one.
  if (Array.isArray(expected) && isKvpBlockPath(path)) {
    const { named, repeated } = vectorParamsToMap(expected)
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
      // `{}` means "nothing here" — an absent object or one whose only content
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

// ─── Byte-level checks the corpus cannot make on its own ────────────────────

describe('draft-22 encoder specifics', () => {
  function encodeHex(message: Draft22Message): string {
    return bytesToHex(codec.encodeMessage(message))
  }

  it('encodes an empty FILL_PARAMETERS as Length 1 carrying the count byte (D1)', () => {
    // Not Length 0: the value is a parameter block, and a parameter block
    // begins with Number of Parameters.
    const hex = encodeHex({
      type: 'subscribe',
      request_id: 1n,
      track_namespace: ['live'],
      track_name: 'video',
      parameters: { fill_parameters: {} },
    })
    expect(hex.endsWith('01230100')).toBe(true)
  })

  it('restarts the Type Delta chain inside FILL_PARAMETERS and resumes the outer one from 0x23 (D2)', () => {
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
    //           count=02  0x23 len=05 [count=02 0x20 64 delta02(->0x22) 1]  delta0f(->0x32) 25
    expect(hex.endsWith('02' + '230502204002010f19')).toBe(true)
  })

  it('writes an inclusive four-field LOCATION_FILTER with no +1 on the end (D4)', () => {
    const hex = encodeHex({
      type: 'fetch',
      request_id: 2n,
      track_namespace: ['live'],
      track_name: 'video',
      parameters: {
        location_filter: {
          filter_type: 4n,
          start_group: 10n,
          start_object: 3n,
          end_group_delta: 5n,
          end_object: 7n,
        },
      },
    })
    // end_object 7 goes out as 7. A draft-19 encoder would have written 8.
    expect(hex.endsWith('0121040a030507')).toBe(true)
  })

  it('writes the FETCH_OK End Location verbatim (D4)', () => {
    const hex = encodeHex({
      type: 'fetch_ok',
      end_of_track: 0,
      end_group: 4n,
      end_object: 0n,
      parameters: {},
      track_properties: {},
    })
    // {4, 0} is object 0 of group 4, not "all of group 4" as it was in draft-19.
    expect(hex).toBe('18000400040000')
  })

  it('round-trips the 2^64-1 Stream Count sentinel through bigint (D6)', () => {
    expect(UNKNOWN_STREAM_COUNT).toBe(2n ** 64n - 1n)
    const hex = encodeHex({
      type: 'publish_done',
      status_code: 0n,
      stream_count: UNKNOWN_STREAM_COUNT,
      reason_phrase: '',
    })
    expect(hex).toBe('0b000b00ffffffffffffffffff00')
    const decoded = codec.decodeMessage(hexToBytes(hex))
    expect(decoded.ok).toBe(true)
    if (!decoded.ok || decoded.value.type !== 'publish_done') return
    expect(decoded.value.stream_count).toBe(UNKNOWN_STREAM_COUNT)
    // Why bigint is not optional here: as doubles the sentinel and its
    // neighbour are the same number, so a `number`-typed Stream Count cannot
    // tell "unknown" from an exact count near the top of the range.
    expect(UNKNOWN_STREAM_COUNT).not.toBe(UNKNOWN_STREAM_COUNT - 1n)
    expect(Number(UNKNOWN_STREAM_COUNT)).toBe(Number(UNKNOWN_STREAM_COUNT - 1n))
  })

  it('encodes PUBLISH_STATE_NOTIFY at 0x22 with no Request ID field', () => {
    const hex = encodeHex({
      type: 'publish_state_notify',
      parameters: { largest_object: { group: 10n, object: 3n } },
    })
    //   type 22, length 0004, count 01, delta 09 -> LARGEST_OBJECT, {10, 3}
    expect(hex).toBe('22000401090a03')
  })

  it('rejects a joining-style FETCH: draft-22 FETCH has no Fetch Type field', () => {
    // draft-19 relative joining FETCH: request 2, fetch type 2, joining
    // request 1, joining start 3, no parameters.
    const draft19JoiningFetch = hexToBytes('1600050202010300')
    const result = codec.decodeMessage(draft19JoiningFetch)
    expect(result.ok).toBe(false)
  })
})

// ─── LOCATION_FILTER (Section 9.20.9) ───────────────────────────────────────

/**
 * A SUBSCRIBE for live/video with request id 1, carrying `paramsHex` as its
 * whole parameter block (count included).
 */
function subscribeHex(paramsHex: string): string {
  const payload = `0101046c69766505766964656f${paramsHex}`
  return `0300${(payload.length / 2).toString(16).padStart(2, '0')}${payload}`
}

function decodeSubscribeParams(hex: string): Draft22Params {
  return decodeOk(hex).parameters
}

function decodeOk(hex: string): Draft22Message & { type: 'subscribe' } {
  const result = codec.decodeMessage(hexToBytes(hex))
  if (!result.ok) throw new Error(`${hex}: ${result.error.code} ${result.error.message}`)
  if (result.value.type !== 'subscribe') throw new Error(`${hex}: not a SUBSCRIBE`)
  return result.value
}

function decodeErrorCode(hex: string): string {
  const result = codec.decodeMessage(hexToBytes(hex))
  if (result.ok) throw new Error(`${hex}: decoded, but should have failed`)
  return result.error.code
}

describe('draft-22 LOCATION_FILTER is led by its Location Filter Type', () => {
  /**
   * Byte strings on which a decoder that still reads a draft-21 Length gives a
   * different answer. With every field a 1-byte value, draft-21's Length N and
   * draft-22's type N coincide for N = 0 to 4, so the corpus vectors built
   * from small values cannot tell the two readings apart; these can.
   */
  describe('discriminators against a draft-21 Length reading', () => {
    it('reads 21 05 as the Next Object, with no fields', () => {
      expect(decodeSubscribeParams(subscribeHex('012105')).location_filter).toEqual({
        filter_type: 5n,
      })
    })

    it('reads 21 02 00 00 as the absolute start {0, 0}, not the Next Object', () => {
      expect(decodeSubscribeParams(subscribeHex('0121020000')).location_filter).toEqual({
        filter_type: 2n,
        start_group: 0n,
        start_object: 0n,
      })
    })

    it('reads a two-byte StartGroup under type 2 as two fields', () => {
      const params = decodeSubscribeParams(subscribeHex('012102800a03'))
      expect(params.location_filter).toEqual({
        filter_type: 2n,
        start_group: 10n,
        start_object: 3n,
      })
    })

    it('refuses the draft-21 Length-3 encoding of {10, 3}, which reads as a type-3 filter cut short', () => {
      // Draft-21 wrote {10, 3} with a two-byte StartGroup as 21 03 80 0a 03.
      // Under draft-22 the 03 is a type that needs three fields and only two
      // arrive before the message ends.
      expect(decodeErrorCode(subscribeHex('012103800a03'))).toBe('INVALID_PARAMETER')
    })

    it('stops after a field-less type and reads the next parameter', () => {
      for (const type of ['00', '05']) {
        const params = decodeSubscribeParams(subscribeHex(`0221${type}0102`))
        expect(params.location_filter).toEqual({ filter_type: BigInt(`0x${type}`) })
        expect(params.group_order).toBe(2n)
      }
    })

    it('reads a non-minimal Location Filter Type and re-encodes it minimally', () => {
      const message = decodeOk(subscribeHex('01218005'))
      expect(message.parameters.location_filter).toEqual({ filter_type: 5n })
      expect(bytesToHex(codec.encodeMessage(message))).toBe(subscribeHex('012105'))
    })
  })

  describe('decoding', () => {
    it('reads each of the six types with exactly its own fields (Table 6)', () => {
      const cases: Array<[string, Record<string, bigint>]> = [
        ['00', { filter_type: 0n }],
        ['0103', { filter_type: 1n, start_group: 3n }],
        ['020a03', { filter_type: 2n, start_group: 10n, start_object: 3n }],
        ['030a0305', { filter_type: 3n, start_group: 10n, start_object: 3n, end_group_delta: 5n }],
        [
          '040a030507',
          {
            filter_type: 4n,
            start_group: 10n,
            start_object: 3n,
            end_group_delta: 5n,
            end_object: 7n,
          },
        ],
        ['05', { filter_type: 5n }],
      ]
      for (const [value, expected] of cases) {
        expect(decodeSubscribeParams(subscribeHex(`0121${value}`)).location_filter).toEqual(
          expected,
        )
      }
    })

    it('refuses any other type as a CONSTRAINT_VIOLATION', () => {
      for (const type of ['06', '40', '8006']) {
        expect(decodeErrorCode(subscribeHex(`0121${type}`))).toBe('CONSTRAINT_VIOLATION')
      }
    })

    it('refuses fields that run past the end of the message as INVALID_PARAMETER', () => {
      expect(decodeErrorCode(subscribeHex('0121040a03'))).toBe('INVALID_PARAMETER')
    })

    it('refuses a Location Filter Type cut off by the end of the message as INVALID_PARAMETER', () => {
      expect(decodeErrorCode(subscribeHex('0121'))).toBe('INVALID_PARAMETER')
      expect(decodeErrorCode(subscribeHex('012180'))).toBe('INVALID_PARAMETER')
    })

    it('refuses StartGroup + EndGroupDelta above 2^64 - 1 on types 3 and 4', () => {
      const max = 'ffffffffffffffffff'
      expect(decodeErrorCode(subscribeHex(`012103${max}0001`))).toBe('CONSTRAINT_VIOLATION')
      expect(decodeErrorCode(subscribeHex(`012104${max}000100`))).toBe('CONSTRAINT_VIOLATION')
      expect(decodeSubscribeParams(subscribeHex(`012103${max}0000`)).location_filter).toEqual({
        filter_type: 3n,
        start_group: 2n ** 64n - 1n,
        start_object: 0n,
        end_group_delta: 0n,
      })
    })

    it('reads the nested filter inside FILL_PARAMETERS with no inner length', () => {
      for (const [type, expected] of [
        ['05', { filter_type: 5n }],
        ['00', { filter_type: 0n }],
      ] as const) {
        const params = decodeSubscribeParams(subscribeHex(`0123030121${type}`))
        expect(params.fill_parameters?.location_filter).toEqual(expected)
      }
    })
  })

  describe('encoding', () => {
    function encodeFilter(location_filter: LocationFilter): string {
      return bytesToHex(
        codec.encodeMessage({
          type: 'subscribe',
          request_id: 1n,
          track_namespace: ['live'],
          track_name: 'video',
          parameters: { location_filter },
        }),
      )
    }

    it("writes the type and then exactly that type's fields", () => {
      expect(encodeFilter({ filter_type: 0n })).toBe(subscribeHex('012100'))
      expect(encodeFilter({ filter_type: 5n })).toBe(subscribeHex('012105'))
      expect(encodeFilter({ filter_type: 1n, start_group: 0n })).toBe(subscribeHex('01210100'))
      expect(encodeFilter({ filter_type: 2n, start_group: 0n, start_object: 0n })).toBe(
        subscribeHex('0121020000'),
      )
      expect(encodeFilter({ filter_type: 2n, start_group: 1000n, start_object: 0n })).toBe(
        subscribeHex('01210283e800'),
      )
    })

    it('refuses a filter whose fields do not match its type', () => {
      expect(() => encodeFilter({ filter_type: 5n, start_group: 0n })).toThrow()
      expect(() => encodeFilter({ filter_type: 0n, start_group: 0n, start_object: 0n })).toThrow()
      expect(() => encodeFilter({ filter_type: 2n, start_group: 10n })).toThrow()
      expect(() => encodeFilter({ filter_type: 4n, start_group: 1n, start_object: 2n })).toThrow()
      expect(() =>
        encodeFilter({ filter_type: 3n, start_group: 1n, start_object: 2n, end_object: 4n }),
      ).toThrow()
    })

    it('refuses a type Table 6 does not define', () => {
      expect(() => encodeFilter({ filter_type: 6n })).toThrow()
    })

    it('writes the nested filter inside FILL_PARAMETERS with no inner length', () => {
      const hex = bytesToHex(
        codec.encodeMessage({
          type: 'subscribe',
          request_id: 1n,
          track_namespace: ['live'],
          track_name: 'video',
          parameters: { fill_parameters: { location_filter: { filter_type: 5n } } },
        }),
      )
      //  count=01  0x23 len=03 [count=01 0x21 type=05]
      expect(hex).toBe(subscribeHex('012303012105'))
    })
  })
})

describe('draft-22 SUBSCRIBE_TRACKS takes every SUBSCRIBE parameter (Section 3.6.2)', () => {
  it('round-trips the parameters Section 9.18 omits and Section 3.6.2 admits', () => {
    const message: Draft22Message = {
      type: 'subscribe_tracks',
      request_id: 1n,
      namespace_prefix: ['conference'],
      parameters: {
        object_delivery_timeout: 100n,
        rendezvous_timeout: 200n,
        subgroup_delivery_timeout: 300n,
        subscriber_priority: 16n,
        location_filter: { filter_type: 5n },
        fill_parameters: { location_filter: { filter_type: 1n, start_group: 2n } },
        new_group_request: 0n,
        track_property_filter: [{ set_id: 0n, property_type: 2n, ranges: [{ start: 1n }] }],
      },
    }
    const bytes = codec.encodeMessage(message)
    const result = codec.decodeMessage(bytes)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toEqual(message)
  })

  it('still refuses LOCATION_FILTER on a PUBLISH_OK, which only EXPIRES and LARGEST_OBJECT may reach', () => {
    expect(decodeErrorCode('070006012103050014')).toBe('CONSTRAINT_VIOLATION')
  })
})
