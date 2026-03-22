import { BufferReader } from '../../core/buffer-reader.js';
import { BufferWriter } from '../../core/buffer-writer.js';
import { DecodeError } from '../../core/types.js';
import type { DecodeResult } from '../../core/types.js';

export function encodeVarInt(value: number | bigint): Uint8Array {
  const writer = new BufferWriter(8);
  writer.writeVarInt(value);
  return writer.finish();
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
