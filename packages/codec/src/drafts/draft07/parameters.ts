import type { BufferReader } from "../../core/buffer-reader.js";
import { BufferWriter } from "../../core/buffer-writer.js";

export function encodeParameters(params: Map<bigint, Uint8Array>): Uint8Array {
  const writer = new BufferWriter();
  writer.writeParameters(params);
  return writer.finish();
}

export function decodeParameters(reader: BufferReader): Map<bigint, Uint8Array> {
  return reader.readParameters();
}
