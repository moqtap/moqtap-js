import { describe, it, expect } from 'vitest';
import { createDraft07Codec } from '../drafts/draft07/codec.js';
import { hexToBytes, bytesToHex, loadVectorDir } from './helpers.js';
import { normalizeDraft07Message } from './draft07-helpers.js';

const codec = createDraft07Codec();

const vectorEntries = loadVectorDir('transport/draft07/codec/messages');

for (const { file, data: vectorFile } of vectorEntries) {
  const messageType = vectorFile.message_type;

  describe(`draft-07 ${messageType} (${file})`, () => {
    for (const vector of vectorFile.vectors) {
      describe(`[${vector.id}] ${vector.description}`, () => {
        const bytes = hexToBytes(vector.hex);

        if (vector.error) {
          it('should fail to decode', () => {
            const result = codec.decodeMessage(bytes);
            expect(result.ok).toBe(false);
          });
        } else if (vector.decoded) {
          it('should decode correctly', () => {
            const result = codec.decodeMessage(bytes);
            expect(result.ok).toBe(true);
            if (!result.ok) return;

            const normalized = normalizeDraft07Message(
              result.value as unknown as Record<string, unknown>,
            );
            assertFieldsMatch(normalized, vector.decoded);
          });

          // Only test re-encode for canonical vectors
          if (vector.canonical !== false) {
            it('should re-encode to same bytes', () => {
              const result = codec.decodeMessage(bytes);
              if (!result.ok) {
                expect.fail('decode failed, cannot test re-encode');
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
 * Assert that all fields in expected match actual.
 * Handles parameters comparison specially.
 */
function assertFieldsMatch(
  actual: Record<string, unknown>,
  expected: Record<string, unknown>,
): void {
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (key === 'parameters') {
      const actualParams = (actual['parameters'] ?? {}) as Record<string, unknown>;
      const expectedParams = expectedValue as Record<string, unknown>;

      if (Object.keys(expectedParams).length === 0) {
        // Empty params: actual should also be empty
        const nonEmpty = Object.entries(actualParams).filter(
          ([, v]) => v !== undefined,
        );
        expect(nonEmpty.length, `expected empty parameters, got: ${JSON.stringify(actualParams)}`).toBe(0);
      } else {
        for (const [pk, pv] of Object.entries(expectedParams)) {
          expect(actualParams[pk], `parameter "${pk}"`).toEqual(pv);
        }
      }
      continue;
    }

    const actualValue = actual[key];

    if (Array.isArray(expectedValue)) {
      expect(actualValue, `field "${key}"`).toEqual(expectedValue);
    } else {
      expect(String(actualValue), `field "${key}"`).toBe(String(expectedValue));
    }
  }
}
