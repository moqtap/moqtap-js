import { describe, expect, it } from 'vitest'
import { createDraft14Codec } from '../../drafts/draft14/codec.js'
import { bytesToHex, hexToBytes, loadVectorDir, normalizeDecoded } from '../helpers.js'

const codec = createDraft14Codec()

const vectorEntries = loadVectorDir('transport/draft14/codec/messages')

for (const { file, data: vectorFile } of vectorEntries) {
  const messageType = vectorFile.message_type

  describe(`draft-14 ${messageType} (${file})`, () => {
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
  _messageType: string,
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
      expect(actualValue).toEqual(expectedValue)
    } else if (typeof expectedValue === 'object' && expectedValue !== null) {
      // Nested object (e.g. largest_location, end_location)
      expect(actualValue).toBeDefined()
      const actualObj = actualValue as Record<string, unknown>
      for (const [nk, nv] of Object.entries(expectedValue as Record<string, unknown>)) {
        expect(String(actualObj[nk])).toBe(String(nv))
      }
    } else {
      expect(String(actualValue)).toBe(String(expectedValue))
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
    } else if (typeof pv === 'object' && pv !== null && !Array.isArray(pv)) {
      // Nested param object (e.g. authorization_token)
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
