import { describe, expect, it } from 'vitest'
import { createDraft20Codec, UNKNOWN_STREAM_COUNT } from '../../drafts/draft20/codec.js'
import type { Draft20Message } from '../../drafts/draft20/types.js'
import { bytesToHex, hexToBytes, loadVectorDir, normalizeDecoded } from '../helpers.js'

const codec = createDraft20Codec()

const vectorEntries = loadVectorDir('transport/draft20/codec/messages')

/**
 * Guard against the silent failure mode: a vector file that stops being found,
 * or a vector inside one that no assertion reaches. Both counts are the
 * published contents of @moqtap/test-vectors 0.13.0
 * (transport/draft20/codec/messages), and both have to be updated deliberately.
 */
const EXPECTED_FILES = 21
const EXPECTED_VECTORS = 229

describe('draft-20 message vector corpus', () => {
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

  describe(`draft-20 ${messageType} (${file})`, () => {
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
 * Compare a decoded message against a vector's `decoded` tree, recursively.
 *
 * Every key the vector states is checked, at every depth — draft-20 nests
 * parameters two levels deep inside FILL_PARAMETERS, and a comparison that
 * stringified an object would pass on "[object Object]" without looking at
 * anything.
 */
function assertMatches(actual: unknown, expected: unknown, path: string): void {
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

describe('draft-20 encoder specifics', () => {
  function encodeHex(message: Draft20Message): string {
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

  it('rejects a joining-style FETCH: draft-20 FETCH has no Fetch Type field', () => {
    // draft-19 relative joining FETCH: request 2, fetch type 2, joining
    // request 1, joining start 3, no parameters.
    const draft19JoiningFetch = hexToBytes('1600050202010300')
    const result = codec.decodeMessage(draft19JoiningFetch)
    expect(result.ok).toBe(false)
  })
})
