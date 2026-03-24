import { DecodeError } from "./types.js";

export class BufferReader {
  private readonly view: DataView;
  private pos: number;

  constructor(
    readonly buffer: Uint8Array,
    offset = 0,
  ) {
    this.view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    this.pos = offset;
  }

  get offset(): number {
    return this.pos;
  }

  get remaining(): number {
    return this.buffer.byteLength - this.pos;
  }

  readUint8(): number {
    if (this.remaining < 1) {
      throw new DecodeError("UNEXPECTED_END", "Not enough bytes to read uint8", this.pos);
    }
    const value = this.view.getUint8(this.pos);
    this.pos += 1;
    return value;
  }

  readBytes(length: number): Uint8Array<ArrayBuffer> {
    if (this.remaining < length) {
      throw new DecodeError(
        "UNEXPECTED_END",
        `Not enough bytes: need ${length}, have ${this.remaining}`,
        this.pos,
      );
    }
    const slice = this.buffer.slice(this.pos, this.pos + length);
    this.pos += length;
    return slice;
  }

  readVarInt(): bigint {
    if (this.remaining < 1) {
      throw new DecodeError("UNEXPECTED_END", "Not enough bytes for varint", this.pos);
    }
    const first = this.view.getUint8(this.pos);
    const prefix = first >> 6;
    let length: number;
    let value: bigint;

    switch (prefix) {
      case 0:
        length = 1;
        value = BigInt(first & 0x3f);
        break;
      case 1:
        length = 2;
        if (this.remaining < 2) {
          throw new DecodeError("UNEXPECTED_END", "Not enough bytes for 2-byte varint", this.pos);
        }
        value = BigInt(this.view.getUint16(this.pos) & 0x3fff);
        break;
      case 2:
        length = 4;
        if (this.remaining < 4) {
          throw new DecodeError("UNEXPECTED_END", "Not enough bytes for 4-byte varint", this.pos);
        }
        value = BigInt(this.view.getUint32(this.pos)) & 0x3fffffffn;
        break;
      case 3:
        length = 8;
        if (this.remaining < 8) {
          throw new DecodeError("UNEXPECTED_END", "Not enough bytes for 8-byte varint", this.pos);
        }
        value = this.view.getBigUint64(this.pos) & 0x3fffffffffffffffn;
        break;
      default:
        throw new DecodeError("INVALID_VARINT", "Invalid varint prefix", this.pos);
    }

    this.pos += length;
    return value;
  }

  readString(): string {
    const length = Number(this.readVarInt());
    const bytes = this.readBytes(length);
    return new TextDecoder().decode(bytes);
  }

  readTuple(): string[] {
    const count = Number(this.readVarInt());
    const result: string[] = [];
    for (let i = 0; i < count; i++) {
      result.push(this.readString());
    }
    return result;
  }

  readParameters(): Map<bigint, Uint8Array> {
    const count = Number(this.readVarInt());
    const params = new Map<bigint, Uint8Array>();
    for (let i = 0; i < count; i++) {
      const key = this.readVarInt();
      const length = Number(this.readVarInt());
      const value = this.readBytes(length);
      params.set(key, value);
    }
    return params;
  }
}
