import vectorFile_ from '@moqtap/test-vectors/transport/draft20/codec/varint.json'
import { describe, expect, it } from 'vitest'
import { MoqtBufferReader as BufferReader } from '../../core/buffer-reader.js'
import { MoqtBufferWriter as BufferWriter } from '../../core/buffer-writer.js'
import type { TestVectorFile } from '../helpers.js'
import { bytesToHex, hexToBytes } from '../helpers.js'

const vectorFile = vectorFile_ as unknown as TestVectorFile

describe('draft-20 varint encoding/decoding', () => {
  it('runs every vector in the file', () => {
    expect(vectorFile.vectors.length).toBeGreaterThan(0)
  })

  for (const vector of vectorFile.vectors) {
    describe(`[${vector.id}] ${vector.description}`, () => {
      const bytes = hexToBytes(vector.hex)

      if (vector.error) {
        it('should fail to decode', () => {
          try {
            const reader = new BufferReader(bytes)
            reader.readVarInt()
            expect.fail('Expected decode to throw')
          } catch {
            // Expected
          }
        })
      } else if (vector.decoded) {
        const expectedValue = BigInt(vector.decoded.value as string)

        it('should decode correctly', () => {
          const reader = new BufferReader(bytes)
          const value = reader.readVarInt()
          expect(value).toBe(expectedValue)
          expect(reader.offset).toBe(bytes.byteLength)
        })

        if (vector.canonical !== false) {
          it('should re-encode to same bytes', () => {
            const writer = new BufferWriter()
            writer.writeVarInt(expectedValue)
            const encoded = writer.finish()
            expect(bytesToHex(encoded)).toBe(vector.hex)
          })
        }
      } else {
        it('has either a decoded value or an error', () => {
          expect.fail(`vector ${vector.id} declares neither`)
        })
      }
    })
  }
})
