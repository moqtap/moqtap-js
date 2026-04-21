import { Decoder, decode as genericDecode } from 'cbor-x'
import { describe, expect, it } from 'vitest'
import { writeMoqtrace } from '../binary.js'
import type { Trace } from '../types.js'

describe('CBOR interop (Rust/ciborium compatibility)', () => {
  it('header decodes as a plain CBOR map with a spec-compliant decoder', () => {
    const trace: Trace = {
      header: {
        protocol: 'moq-transport-14',
        perspective: 'observer',
        detail: 'headers+data',
        startTime: 1745261856000,
        endTime: 1745261896000,
        source: 'moqtap-extension/0.1.0',
        endpoint: 'https://relay.example.com/moq',
      },
      events: [],
    }

    const bytes = writeMoqtrace(trace)

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const headerLen = view.getUint32(12, true)
    const headerBytes = bytes.slice(16, 16 + headerLen)

    // The first byte of a standard CBOR map has major type 5 (0xA0..0xBF) or
    // length-prefixed map (0xB8..0xBB). A cbor-x "record" would start with
    // a tag (major type 6, 0xC0..0xDB) referencing structure id r0/r1/etc.
    const firstByte = headerBytes[0]!
    const majorType = (firstByte >> 5) & 0x07
    expect(majorType, `expected CBOR map (major type 5), got major type ${majorType}`).toBe(5)

    // Decode with a strict spec-compliant decoder (no records extension) and
    // verify it gets the startTime we wrote.
    const strictDecoder = new Decoder({ useRecords: false, mapsAsObjects: true })
    const decoded = strictDecoder.decode(headerBytes) as Record<string, unknown>
    expect(decoded.startTime).toBe(1745261856000)
    expect(decoded.protocol).toBe('moq-transport-14')

    // Also verify the default cbor-x decoder (which supports both formats)
    // still reads it back correctly — existing tooling must keep working.
    const defaultDecoded = genericDecode(headerBytes) as Record<string, unknown>
    expect(defaultDecoded.startTime).toBe(1745261856000)
  })
})
