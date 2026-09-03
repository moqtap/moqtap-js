import { describe, expect, it } from 'vitest'
import { createDraft13Codec } from '../../drafts/draft13/codec.js'
import {
  bytesToHex,
  flattenFetch,
  hexToBytes,
  loadVectorDir,
  normalizeDecoded,
  vectorParamsToMap,
} from '../helpers.js'

const codec = createDraft13Codec()

const vectorEntries = loadVectorDir('transport/draft13/codec/messages')

for (const { file, data: vectorFile } of vectorEntries) {
  const messageType = vectorFile.message_type

  describe(`draft-13 ${messageType} (${file})`, () => {
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
    } else if (pk === 'authorization_token' && typeof pv === 'object' && pv !== null) {
      // Nested authorization_token object
      const actualToken = actualParams.authorization_token as Record<string, unknown>
      expect(actualToken).toBeDefined()
      for (const [nk, nv] of Object.entries(pv as Record<string, unknown>)) {
        const av = actualToken[nk]
        const actual = av instanceof Uint8Array ? Buffer.from(av).toString('hex') : String(av)
        expect(actual).toBe(String(nv))
      }
    } else {
      expect(String(actualParams[pk])).toBe(String(pv))
    }
  }
}
