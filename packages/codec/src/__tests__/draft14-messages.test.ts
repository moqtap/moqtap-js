import { describe, expect, it } from "vitest";
import { createDraft14Codec } from "../drafts/draft14/codec.js";
import { bytesToHex, hexToBytes, loadVectorDir, normalizeDecoded } from "./helpers.js";

const codec = createDraft14Codec();

const vectorEntries = loadVectorDir("transport/draft14/codec/messages");

for (const { file, data: vectorFile } of vectorEntries) {
  const messageType = vectorFile.message_type;

  describe(`draft-14 ${messageType} (${file})`, () => {
    for (const vector of vectorFile.vectors) {
      describe(`[${vector.id}] ${vector.description}`, () => {
        const bytes = hexToBytes(vector.hex);

        if (vector.error) {
          it("should fail to decode", () => {
            const result = codec.decodeMessage(bytes);
            expect(result.ok).toBe(false);
          });
        } else if (vector.decoded) {
          it("should decode correctly", () => {
            const result = codec.decodeMessage(bytes);
            expect(result.ok).toBe(true);
            if (!result.ok) return;

            const normalized = normalizeDecoded(result.value as unknown as Record<string, unknown>);

            // Normalize params: remove empty params for comparison
            const expected = { ...vector.decoded };
            assertFieldsMatch(normalized, expected, messageType);
          });

          // Only test re-encode for canonical vectors (canonical defaults to true)
          if (vector.canonical !== false) {
            it("should re-encode to same bytes", () => {
              const result = codec.decodeMessage(bytes);
              if (!result.ok) {
                expect.fail("decode failed, cannot test re-encode");
                return;
              }

              const reEncoded = codec.encodeMessage(result.value);
              expect(bytesToHex(reEncoded)).toBe(vector.hex);
            });
          }
        }
      });
    }
  });
}

/**
 * Assert that decoded message fields match expected test vector fields.
 * Handles the nuances of parameter comparison and type coercion.
 */
function assertFieldsMatch(
  actual: Record<string, unknown>,
  expected: Record<string, unknown>,
  _messageType: string,
): void {
  // Compare non-parameter fields
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (key === "parameters") {
      const actualParams = actual.parameters as Record<string, unknown> | undefined;
      const expectedParams = expectedValue as Record<string, unknown>;

      // Normalize: empty params {} should match missing params
      if (Object.keys(expectedParams).length === 0) {
        if (actualParams) {
          // Actual params should also be empty or only have empty unknown array
          const nonEmpty = Object.entries(actualParams).filter(([k, v]) => {
            if (k === "unknown" && Array.isArray(v) && v.length === 0) return false;
            return v !== undefined;
          });
          expect(nonEmpty.length).toBe(0);
        }
      } else {
        expect(actualParams).toBeDefined();
        if (actualParams) {
          for (const [pk, pv] of Object.entries(expectedParams)) {
            if (pk === "unknown") {
              const actualUnknown = (actualParams.unknown as Array<Record<string, unknown>>).map(
                (u) => ({
                  ...u,
                  length: String(u.length),
                }),
              );
              expect(actualUnknown).toEqual(pv);
            } else {
              expect(String(actualParams[pk])).toBe(String(pv));
            }
          }
        }
      }
      continue;
    }

    const actualValue = actual[key];

    if (Array.isArray(expectedValue)) {
      expect(actualValue).toEqual(expectedValue);
    } else {
      expect(String(actualValue)).toBe(String(expectedValue));
    }
  }
}
