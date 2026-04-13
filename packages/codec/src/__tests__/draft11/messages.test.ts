import { describe, expect, it } from 'vitest'
import { createDraft11Codec } from '../../drafts/draft11/codec.js'
import { bytesToHex, hexToBytes, loadVectorDir, normalizeDecoded } from '../helpers.js'

const codec = createDraft11Codec()

const vectorEntries = loadVectorDir('transport/draft11/codec/messages')

for (const { file, data: vectorFile } of vectorEntries) {
  const messageType = vectorFile.message_type

  describe(`draft-11 ${messageType} (${file})`, () => {
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
    if (key === 'parameters') {
      assertParamsMatch(
        flatActual.parameters as Record<string, unknown> | undefined,
        expectedValue as Record<string, unknown>,
      )
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

/**
 * Flatten the nested fetch structure to match test vector format.
 */
function flattenFetch(msg: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(msg)) {
    if (key === 'standalone' && value && typeof value === 'object') {
      Object.assign(result, value)
    } else if (key === 'joining' && value && typeof value === 'object') {
      Object.assign(result, value)
    } else {
      result[key] = value
    }
  }
  return result
}

function assertParamsMatch(
  actualParams: Record<string, unknown> | undefined,
  expectedParams: Record<string, unknown>,
): void {
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
        expect(String(actualToken[nk])).toBe(String(nv))
      }
    } else {
      expect(String(actualParams[pk])).toBe(String(pv))
    }
  }
}
