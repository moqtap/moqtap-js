import { DecodeError } from './types.js'

const textDecoder = /* @__PURE__ */ new TextDecoder()

export class BufferReader {
  protected readonly view: DataView
  protected pos: number

  constructor(
    readonly buffer: Uint8Array,
    offset = 0,
  ) {
    this.view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
    this.pos = offset
  }

  get offset(): number {
    return this.pos
  }

  get remaining(): number {
    return this.buffer.byteLength - this.pos
  }

  readUint8(): number {
    if (this.remaining < 1) {
      throw new DecodeError('UNEXPECTED_END', 'Not enough bytes to read uint8', this.pos)
    }
    const value = this.view.getUint8(this.pos)
    this.pos += 1
    return value
  }

  readBytes(length: number): Uint8Array<ArrayBuffer> {
    if (this.remaining < length) {
      throw new DecodeError(
        'UNEXPECTED_END',
        `Not enough bytes: need ${length}, have ${this.remaining}`,
        this.pos,
      )
    }
    const slice = this.buffer.slice(this.pos, this.pos + length)
    this.pos += length
    return slice
  }

  /** Zero-copy read: returns a view into the underlying buffer. */
  readBytesView(length: number): Uint8Array<ArrayBuffer> {
    if (this.remaining < length) {
      throw new DecodeError(
        'UNEXPECTED_END',
        `Not enough bytes: need ${length}, have ${this.remaining}`,
        this.pos,
      )
    }
    const view = this.buffer.subarray(this.pos, this.pos + length)
    this.pos += length
    return view as Uint8Array<ArrayBuffer>
  }

  readVarInt(): bigint {
    if (this.remaining < 1) {
      throw new DecodeError('UNEXPECTED_END', 'Not enough bytes for varint', this.pos)
    }
    const first = this.view.getUint8(this.pos)
    const prefix = first >> 6
    let length: number
    let value: bigint

    switch (prefix) {
      case 0:
        length = 1
        value = BigInt(first & 0x3f)
        break
      case 1:
        length = 2
        if (this.remaining < 2) {
          throw new DecodeError('UNEXPECTED_END', 'Not enough bytes for 2-byte varint', this.pos)
        }
        value = BigInt(this.view.getUint16(this.pos) & 0x3fff)
        break
      case 2:
        length = 4
        if (this.remaining < 4) {
          throw new DecodeError('UNEXPECTED_END', 'Not enough bytes for 4-byte varint', this.pos)
        }
        value = BigInt(this.view.getUint32(this.pos)) & 0x3fffffffn
        break
      case 3:
        length = 8
        if (this.remaining < 8) {
          throw new DecodeError('UNEXPECTED_END', 'Not enough bytes for 8-byte varint', this.pos)
        }
        value = this.view.getBigUint64(this.pos) & 0x3fffffffffffffffn
        break
      default:
        throw new DecodeError('INVALID_VARINT', 'Invalid varint prefix', this.pos)
    }

    this.pos += length
    return value
  }

  readString(): string {
    const length = Number(this.readVarInt())
    const bytes = this.readBytesView(length)
    return textDecoder.decode(bytes)
  }

  readTuple(): string[] {
    const count = Number(this.readVarInt())
    const result: string[] = []
    for (let i = 0; i < count; i++) {
      result.push(this.readString())
    }
    return result
  }

  readParameters(): Map<bigint, Uint8Array> {
    const count = Number(this.readVarInt())
    const params = new Map<bigint, Uint8Array>()
    for (let i = 0; i < count; i++) {
      const key = this.readVarInt()
      const length = Number(this.readVarInt())
      const value = this.readBytes(length)
      params.set(key, value)
    }
    return params
  }
}

/**
 * Reader for drafts 17 and later, which dropped the RFC 9000 varint for MoQT's
 * own (§1.4.1).
 *
 * The number of leading 1 bits in the first byte gives the encoded length; the
 * bits after the terminating 0, followed by the remaining bytes, are the value
 * in network byte order. One byte therefore carries 0-127 rather than 0-63,
 * and nine bytes carry the full 64-bit range instead of RFC 9000's 62. A first
 * byte of 0xff is the nine-byte form and is prefix only.
 *
 * Encodings need not be minimal: draft-19 §1.4.1 says any length that can
 * represent the value is valid, so 0 may arrive as 0x00, 0x8000, 0xc00000 or
 * longer.
 */
export class MoqtBufferReader extends BufferReader {
  /** Draft-17 omits the 7-byte length; draft-18 restored it. */
  protected get allowSevenByte(): boolean {
    return true
  }

  override readVarInt(): bigint {
    if (this.remaining < 1) {
      throw new DecodeError('UNEXPECTED_END', 'Not enough bytes for varint', this.pos)
    }
    const first = this.view.getUint8(this.pos)

    if (first === 0xff) {
      if (this.remaining < 9) {
        throw new DecodeError('UNEXPECTED_END', 'Not enough bytes for 9-byte varint', this.pos)
      }
      const value = this.view.getBigUint64(this.pos + 1)
      this.pos += 9
      return value
    }

    let leadingOnes = 0
    while (leadingOnes < 8 && (first & (0x80 >> leadingOnes)) !== 0) leadingOnes++
    const length = leadingOnes + 1

    if (length === 7 && !this.allowSevenByte) {
      // draft-17 §1.4.1: "11111100 is an invalid code point. An endpoint that
      // receives this value MUST close the session with a PROTOCOL_VIOLATION."
      throw new DecodeError(
        'INVALID_VARINT',
        'The 7-byte varint is not defined in draft-17',
        this.pos,
      )
    }
    if (this.remaining < length) {
      throw new DecodeError(
        'UNEXPECTED_END',
        `Not enough bytes for ${length}-byte varint`,
        this.pos,
      )
    }

    let value = BigInt(first & ((1 << (8 - length)) - 1))
    for (let i = 1; i < length; i++) {
      value = (value << 8n) | BigInt(this.view.getUint8(this.pos + i))
    }
    this.pos += length
    return value
  }
}

/** Draft-17's reader, which rejects the 7-byte form draft-18 restored. */
export class Draft17BufferReader extends MoqtBufferReader {
  protected override get allowSevenByte(): boolean {
    return false
  }
}
