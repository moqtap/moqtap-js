import { describe, expect, it } from 'vitest'
import { createDraft07Codec } from '../../drafts/draft07/codec.js'
import { bytesToHex, hexToBytes, loadVectorDir, normalizeDecoded } from '../helpers.js'

const codec = createDraft07Codec()

const vectorEntries = loadVectorDir('transport/draft07/codec/messages')

for (const { file, data: vectorFile } of vectorEntries) {
  const messageType = vectorFile.message_type

  describe(`draft-07 ${messageType} (${file})`, () => {
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
            assertFieldsMatch(normalized, expected)
          })

          // Only test re-encode for canonical vectors
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
 * Assert that all fields in expected match actual.
 * Handles parameters comparison specially.
 */
function assertFieldsMatch(
  actual: Record<string, unknown>,
  expected: Record<string, unknown>,
): void {
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (key === 'parameters') {
      assertParamsMatch(
        actual.parameters as Record<string, unknown> | undefined,
        expectedValue as Record<string, unknown>,
      )
      continue
    }

    const actualValue = actual[key]

    if (Array.isArray(expectedValue)) {
      expect(actualValue, `field "${key}"`).toEqual(expectedValue)
    } else {
      expect(String(actualValue), `field "${key}"`).toBe(String(expectedValue))
    }
  }
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
    } else {
      expect(String(actualParams[pk])).toBe(String(pv))
    }
  }
}
