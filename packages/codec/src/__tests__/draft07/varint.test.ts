import vectorFile_ from '@moqtap/test-vectors/transport/draft07/codec/varint.json'
import { describe, expect, it } from 'vitest'
import { createDraft07Codec } from '../../drafts/draft07/codec.js'
import type { TestVectorFile } from '../helpers.js'
import { bytesToHex, hexToBytes } from '../helpers.js'

const codec = createDraft07Codec()
const vectorFile = vectorFile_ as unknown as TestVectorFile

describe('draft-07 varint encoding/decoding', () => {
  for (const vector of vectorFile.vectors) {
    describe(`[${vector.id}] ${vector.description}`, () => {
      const bytes = hexToBytes(vector.hex)

      if (vector.error) {
        it('should fail to decode', () => {
          const result = codec.decodeVarInt(bytes)
          expect(result.ok).toBe(false)
        })
      } else if (vector.decoded) {
        const expectedValue = BigInt(vector.decoded.value as string)

        it('should decode correctly', () => {
          const result = codec.decodeVarInt(bytes)
          expect(result.ok).toBe(true)
          if (!result.ok) return
          expect(result.value).toBe(expectedValue)
          expect(result.bytesRead).toBe(bytes.byteLength)
        })

        if (vector.canonical !== false) {
          it('should re-encode to same bytes', () => {
            const encoded = codec.encodeVarInt(expectedValue)
            expect(bytesToHex(encoded)).toBe(vector.hex)
          })
        }
      }
    })
  }
})
