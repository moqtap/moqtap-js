import vectorFile_ from "@moqtap/test-vectors/transport/draft15/codec/varint.json";
import { describe, expect, it } from "vitest";
import { BufferReader } from "../core/buffer-reader.js";
import { BufferWriter } from "../core/buffer-writer.js";
import type { TestVectorFile } from "./helpers.js";
import { bytesToHex, hexToBytes } from "./helpers.js";

const vectorFile = vectorFile_ as unknown as TestVectorFile;

describe("draft-15 varint encoding/decoding", () => {
  for (const vector of vectorFile.vectors) {
    describe(`[${vector.id}] ${vector.description}`, () => {
      const bytes = hexToBytes(vector.hex);

      if (vector.error) {
        it("should fail to decode", () => {
          try {
            const reader = new BufferReader(bytes);
            reader.readVarInt();
            expect.fail("Expected decode to throw");
          } catch {
            // Expected
          }
        });
      } else if (vector.decoded) {
        const expectedValue = BigInt(vector.decoded.value as string);

        it("should decode correctly", () => {
          const reader = new BufferReader(bytes);
          const value = reader.readVarInt();
          expect(value).toBe(expectedValue);
          expect(reader.offset).toBe(bytes.byteLength);
        });

        if (vector.canonical !== false) {
          it("should re-encode to same bytes", () => {
            const writer = new BufferWriter();
            writer.writeVarInt(expectedValue);
            const encoded = writer.finish();
            expect(bytesToHex(encoded)).toBe(vector.hex);
          });
        }
      }
    });
  }
});
