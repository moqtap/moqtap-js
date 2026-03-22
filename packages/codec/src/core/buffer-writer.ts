export class BufferWriter {
  private buffer: Uint8Array;
  private view: DataView;
  private pos: number;

  constructor(initialSize = 256) {
    this.buffer = new Uint8Array(initialSize);
    this.view = new DataView(this.buffer.buffer);
    this.pos = 0;
  }

  get offset(): number {
    return this.pos;
  }

  private ensureCapacity(needed: number): void {
    const required = this.pos + needed;
    if (required <= this.buffer.byteLength) return;

    let newSize = this.buffer.byteLength * 2;
    while (newSize < required) newSize *= 2;

    const newBuffer = new Uint8Array(newSize);
    newBuffer.set(this.buffer);
    this.buffer = newBuffer;
    this.view = new DataView(this.buffer.buffer);
  }

  writeUint8(value: number): void {
    this.ensureCapacity(1);
    this.view.setUint8(this.pos, value);
    this.pos += 1;
  }

  writeBytes(bytes: Uint8Array): void {
    this.ensureCapacity(bytes.byteLength);
    this.buffer.set(bytes, this.pos);
    this.pos += bytes.byteLength;
  }

  writeVarInt(value: number | bigint): void {
    const v = BigInt(value);
    if (v < 0n) throw new Error("VarInt value must be non-negative");

    if (v < 0x40n) {
      this.ensureCapacity(1);
      this.view.setUint8(this.pos, Number(v));
      this.pos += 1;
    } else if (v < 0x4000n) {
      this.ensureCapacity(2);
      this.view.setUint16(this.pos, Number(v) | 0x4000);
      this.pos += 2;
    } else if (v < 0x40000000n) {
      this.ensureCapacity(4);
      this.view.setUint32(this.pos, Number(v) | 0x80000000);
      this.pos += 4;
    } else if (v < 0x4000000000000000n) {
      this.ensureCapacity(8);
      this.view.setBigUint64(this.pos, v | 0xc000000000000000n);
      this.pos += 8;
    } else {
      throw new Error("VarInt value exceeds 62-bit range");
    }
  }

  writeString(str: string): void {
    const encoded = new TextEncoder().encode(str);
    this.writeVarInt(encoded.byteLength);
    this.writeBytes(encoded);
  }

  writeTuple(values: string[]): void {
    this.writeVarInt(values.length);
    for (const v of values) {
      this.writeString(v);
    }
  }

  writeParameters(params: Map<bigint, Uint8Array>): void {
    this.writeVarInt(params.size);
    for (const [key, value] of params) {
      this.writeVarInt(key);
      this.writeVarInt(value.byteLength);
      this.writeBytes(value);
    }
  }

  finish(): Uint8Array {
    return this.buffer.slice(0, this.pos);
  }
}
