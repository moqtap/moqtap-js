import { Decoder, decode as genericDecode } from 'cbor-x'
import { describe, expect, it } from 'vitest'
import { writeMoqtrace } from '../binary.js'
import type { Trace, TraceEvent } from '../types.js'

/**
 * These tests check the bytes this package emits against the shapes the other
 * implementation of the format can read. The trap they exist for is that a
 * round-trip through this same library proves nothing about interop: an
 * encoder and its own decoder agree on any convention, including one nobody
 * else implements.
 */

const MAJOR_UNSIGNED = 0
const MAJOR_BYTES = 2
const MAJOR_MAP = 5
const MAJOR_TAG = 6
const MAJOR_SIMPLE_OR_FLOAT = 7

function majorTypeOf(byte: number): number {
  return (byte >> 5) & 0x07
}

function headerBytesOf(file: Uint8Array): Uint8Array {
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength)
  return file.slice(16, 16 + view.getUint32(12, true))
}

function firstEventBytesOf(file: Uint8Array): Uint8Array {
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength)
  return file.slice(16 + view.getUint32(12, true))
}

/** Locate a map key's value by scanning for the encoded key text. */
function valueBytesAfterKey(bytes: Uint8Array, key: string): Uint8Array {
  const encodedKey = new TextEncoder().encode(key)
  outer: for (let i = 0; i + encodedKey.length <= bytes.length; i++) {
    for (let k = 0; k < encodedKey.length; k++) {
      if (bytes[i + k] !== encodedKey[k]) continue outer
    }
    return bytes.subarray(i + encodedKey.length)
  }
  throw new Error(`key '${key}' not found in the encoded bytes`)
}

const trace: Trace = {
  header: {
    protocol: 'moq-transport-14',
    perspective: 'observer',
    detail: 'full',
    startTime: 1745261856000,
    endTime: 1745261896000,
    source: 'moqtap-extension/0.1.0',
    endpoint: 'https://relay.example.com/moq',
  },
  events: [],
}

describe('CBOR interop (Rust/ciborium compatibility)', () => {
  it('encodes the header as a plain CBOR map, not a cbor-x record', () => {
    // A cbor-x "record" is a tag referencing a structure id, and no
    // spec-compliant decoder can read one.
    const headerBytes = headerBytesOf(writeMoqtrace(trace))
    expect(majorTypeOf(headerBytes[0]!)).toBe(MAJOR_MAP)

    const strict = new Decoder({ useRecords: false, mapsAsObjects: true })
    const decoded = strict.decode(headerBytes) as Record<string, unknown>
    expect(decoded.protocol).toBe('moq-transport-14')
    expect(Number(decoded.startTime)).toBe(1745261856000)

    // The permissive default decoder must keep working too — existing tooling
    // reads these files with it.
    const permissive = genericDecode(headerBytes) as Record<string, unknown>
    expect(Number(permissive.startTime)).toBe(1745261856000)
  })

  it('encodes a large timestamp as a CBOR integer, not a float', () => {
    // cbor-x writes any JS number past 32 bits as a float64 unless it is
    // handed a BigInt — and every epoch-millisecond timestamp is past 32 bits.
    // A decoder that reads `startTime` as an integer found it missing and
    // rejected the file, which is every trace this package used to write.
    const headerBytes = headerBytesOf(writeMoqtrace(trace))
    for (const key of ['startTime', 'endTime']) {
      const value = valueBytesAfterKey(headerBytes, key)
      expect(majorTypeOf(value[0]!), `${key} should be a CBOR integer`).toBe(MAJOR_UNSIGNED)
      expect(majorTypeOf(value[0]!), `${key} must not be a float`).not.toBe(MAJOR_SIMPLE_OR_FLOAT)
    }
  })

  it('encodes byte strings as major type 2, not a typed-array tag', () => {
    // cbor-x wraps every Uint8Array in tag 64 by default. A decoder reading
    // major type 2 sees no bytes at all, which silently emptied every
    // payload-bearing field: raw wire bytes, object payloads, track names.
    const withBytes: TraceEvent = {
      type: 'control',
      seq: 0,
      timestamp: 0,
      direction: 0,
      messageType: 0x03,
      message: {},
      raw: new Uint8Array([0x03, 0x00, 0x04]),
    }
    const eventBytes = firstEventBytesOf(writeMoqtrace({ ...trace, events: [withBytes] }))
    const value = valueBytesAfterKey(eventBytes, 'raw')

    expect(majorTypeOf(value[0]!), 'raw should be a CBOR byte string').toBe(MAJOR_BYTES)
    expect(majorTypeOf(value[0]!), 'raw must not be tagged').not.toBe(MAJOR_TAG)
  })

  it('encodes object payload bytes as major type 2', () => {
    const payloadEvent: TraceEvent = {
      type: 'object-payload',
      seq: 0,
      timestamp: 0,
      streamId: 4n,
      groupId: 1n,
      objectId: 0n,
      size: 3,
      payload: new Uint8Array([1, 2, 3]),
    }
    const eventBytes = firstEventBytesOf(writeMoqtrace({ ...trace, events: [payloadEvent] }))
    expect(majorTypeOf(valueBytesAfterKey(eventBytes, 'pl')[0]!)).toBe(MAJOR_BYTES)
  })

  it('encodes a stream id as a CBOR integer', () => {
    // Held as a BigInt on this side; had it been written as a bignum tag, the
    // other implementation would read no stream id at all.
    const event: TraceEvent = {
      type: 'stream-opened',
      seq: 0,
      timestamp: 0,
      streamId: 12n,
      direction: 0,
      streamType: 0,
    }
    const eventBytes = firstEventBytesOf(writeMoqtrace({ ...trace, events: [event] }))
    expect(majorTypeOf(valueBytesAfterKey(eventBytes, 'sid')[0]!)).toBe(MAJOR_UNSIGNED)
  })

  it('reads back a byte string in both the plain and the tagged form', () => {
    // The writer stopped emitting tag 64, so the reader has to handle the
    // plain form it now produces as well as the tagged form already on disk.
    const bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef])
    const decoder = new Decoder({ useRecords: false, mapsAsObjects: true })
    const plain = new Uint8Array([0x44, 0xde, 0xad, 0xbe, 0xef])
    const tagged = new Uint8Array([0xd8, 0x40, 0x44, 0xde, 0xad, 0xbe, 0xef])

    expect(new Uint8Array(decoder.decode(plain) as Uint8Array)).toEqual(bytes)
    expect(new Uint8Array(decoder.decode(tagged) as Uint8Array)).toEqual(bytes)
  })
})
