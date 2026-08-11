const textEncoder = /* @__PURE__ */ new TextEncoder()

export class BufferWriter {
  protected buffer: Uint8Array
  protected view: DataView
  protected pos: number

  constructor(initialSize = 256) {
    this.buffer = new Uint8Array(initialSize)
    this.view = new DataView(this.buffer.buffer)
    this.pos = 0
  }

  get offset(): number {
    return this.pos
  }

  protected ensureCapacity(needed: number): void {
    const required = this.pos + needed
    if (required <= this.buffer.byteLength) return

    let newSize = this.buffer.byteLength * 2
    while (newSize < required) newSize *= 2

    const newBuffer = new Uint8Array(newSize)
    newBuffer.set(this.buffer)
    this.buffer = newBuffer
    this.view = new DataView(this.buffer.buffer)
  }

  writeUint8(value: number): void {
    this.ensureCapacity(1)
    this.view.setUint8(this.pos, value)
    this.pos += 1
  }

  writeBytes(bytes: Uint8Array): void {
    this.ensureCapacity(bytes.byteLength)
    this.buffer.set(bytes, this.pos)
    this.pos += bytes.byteLength
  }

  writeVarInt(value: number | bigint): void {
    const v = BigInt(value)
    if (v < 0n) throw new Error('VarInt value must be non-negative')

    if (v < 0x40n) {
      this.ensureCapacity(1)
      this.view.setUint8(this.pos, Number(v))
      this.pos += 1
    } else if (v < 0x4000n) {
      this.ensureCapacity(2)
      this.view.setUint16(this.pos, Number(v) | 0x4000)
      this.pos += 2
    } else if (v < 0x40000000n) {
      this.ensureCapacity(4)
      this.view.setUint32(this.pos, Number(v) | 0x80000000)
      this.pos += 4
    } else if (v < 0x4000000000000000n) {
      this.ensureCapacity(8)
      this.view.setBigUint64(this.pos, v | 0xc000000000000000n)
      this.pos += 8
    } else {
      throw new Error('VarInt value exceeds 62-bit range')
    }
  }

  writeString(str: string): void {
    const encoded = textEncoder.encode(str)
    this.writeVarInt(encoded.byteLength)
    this.writeBytes(encoded)
  }

  writeTuple(values: string[]): void {
    this.writeVarInt(values.length)
    for (const v of values) {
      this.writeString(v)
    }
  }

  writeParameters(params: Map<bigint, Uint8Array>): void {
    this.writeVarInt(params.size)
    for (const [key, value] of params) {
      this.writeVarInt(key)
      this.writeVarInt(value.byteLength)
      this.writeBytes(value)
    }
  }

  /** Returns an owned copy of the written bytes. */
  finish(): Uint8Array {
    if (this.pos === this.buffer.byteLength) return this.buffer
    return this.buffer.slice(0, this.pos)
  }

  /** Returns a zero-copy view of the written bytes. Valid only until the next write. */
  finishView(): Uint8Array {
    return this.buffer.subarray(0, this.pos)
  }
}

/**
 * Writer for drafts 17 and later, which dropped the RFC 9000 varint for MoQT's
 * own (§1.4.1). See {@link MoqtBufferReader} for the encoding.
 *
 * Values are always written in the fewest bytes that hold them. Longer forms
 * are legal on the wire and decode fine, but there is no reason to emit them.
 */
export class MoqtBufferWriter extends BufferWriter {
  /** Draft-17 omits the 7-byte length; draft-18 restored it. */
  protected get allowSevenByte(): boolean {
    return true
  }

  override writeVarInt(value: number | bigint): void {
    const v = BigInt(value)
    if (v < 0n) throw new Error('VarInt value must be non-negative')
    if (v > 0xffffffffffffffffn) throw new Error('VarInt value exceeds 64-bit range')

    let length = 9
    for (let n = 1; n <= 8; n++) {
      if (n === 7 && !this.allowSevenByte) continue
      if (v < 1n << BigInt(7 * n)) {
        length = n
        break
      }
    }

    this.ensureCapacity(length)
    if (length === 9) {
      this.view.setUint8(this.pos, 0xff)
      this.view.setBigUint64(this.pos + 1, v)
      this.pos += 9
      return
    }

    // (length - 1) leading 1 bits, then a 0, in the top `length` bits.
    const prefix = BigInt(((1 << (length - 1)) - 1) << (9 - length)) & 0xffn
    const combined = (prefix << BigInt(8 * (length - 1))) | v
    for (let i = 0; i < length; i++) {
      this.view.setUint8(this.pos + i, Number((combined >> BigInt(8 * (length - 1 - i))) & 0xffn))
    }
    this.pos += length
  }
}

/** Draft-17's writer, which never emits the 7-byte form draft-18 restored. */
export class Draft17BufferWriter extends MoqtBufferWriter {
  protected override get allowSevenByte(): boolean {
    return false
  }
}
