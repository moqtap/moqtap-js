import { BufferReader } from "../../core/buffer-reader.js";
import type { DecodeResult } from "../../core/types.js";
import { DecodeError } from "../../core/types.js";

export function encodeVarInt(value: number | bigint): Uint8Array {
  const v = BigInt(value);
  if (v < 0n) throw new Error("VarInt value must be non-negative");

  if (v < 0x40n) {
    const buf = new Uint8Array(1);
    buf[0] = Number(v);
    return buf;
  }
  if (v < 0x4000n) {
    const buf = new Uint8Array(2);
    const n = Number(v) | 0x4000;
    buf[0] = n >> 8;
    buf[1] = n & 0xff;
    return buf;
  }
  if (v < 0x40000000n) {
    const buf = new Uint8Array(4);
    const n = Number(v) | 0x80000000;
    buf[0] = (n >>> 24) & 0xff;
    buf[1] = (n >>> 16) & 0xff;
    buf[2] = (n >>> 8) & 0xff;
    buf[3] = n & 0xff;
    return buf;
  }
  if (v < 0x4000000000000000n) {
    const buf = new Uint8Array(8);
    const tagged = v | 0xc000000000000000n;
    const view = new DataView(buf.buffer);
    view.setBigUint64(0, tagged);
    return buf;
  }
  throw new Error("VarInt value exceeds 62-bit range");
}

export function decodeVarInt(bytes: Uint8Array, offset = 0): DecodeResult<bigint> {
  try {
    const reader = new BufferReader(bytes, offset);
    const value = reader.readVarInt();
    return { ok: true, value, bytesRead: reader.offset - offset };
  } catch (e) {
    if (e instanceof DecodeError) {
      return { ok: false, error: e };
    }
    throw e;
  }
}
