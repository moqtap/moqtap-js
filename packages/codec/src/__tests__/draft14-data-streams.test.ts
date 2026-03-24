import { describe, expect, it } from "vitest";
import { createDraft14Codec } from "../drafts/draft14/codec.js";
import type { DatagramObject, FetchStream, SubgroupStream } from "../drafts/draft14/types.js";
import { bytesToHex, hexToBytes, loadVectorDir } from "./helpers.js";

const codec = createDraft14Codec();

const vectorEntries = loadVectorDir("transport/draft14/codec/data-streams");

for (const { file, data: vectorFile } of vectorEntries) {
  const messageType = vectorFile.message_type;

  describe(`draft-14 data stream: ${messageType} (${file})`, () => {
    for (const vector of vectorFile.vectors) {
      describe(`[${vector.id}] ${vector.description}`, () => {
        const bytes = hexToBytes(vector.hex);

        if (vector.error) {
          it("should fail to decode", () => {
            const streamType = getStreamType(vector);
            const result = decodeByStreamType(streamType, bytes);
            expect(result.ok).toBe(false);
          });
        } else if (vector.decoded) {
          const decoded = vector.decoded;
          const streamType = decoded.stream_type as string;

          it("should decode correctly", () => {
            const result = decodeByStreamType(streamType, bytes);
            expect(result.ok).toBe(true);
            if (!result.ok) return;

            assertDataStreamMatch(result.value, decoded, streamType);
          });

          if (vector.canonical !== false) {
            it("should re-encode to same bytes", () => {
              const result = decodeByStreamType(streamType, bytes);
              if (!result.ok) {
                expect.fail("decode failed");
                return;
              }

              const reEncoded = encodeByStreamType(streamType, result.value);
              expect(bytesToHex(reEncoded)).toBe(vector.hex);
            });
          }
        }
      });
    }
  });
}

function getStreamType(
  vector: { decoded?: Record<string, unknown> },
): "subgroup" | "datagram" | "fetch" {
  if (vector.decoded?.stream_type) {
    return vector.decoded.stream_type as "subgroup" | "datagram" | "fetch";
  }
  return "subgroup";
}

function decodeByStreamType(streamType: string, bytes: Uint8Array) {
  switch (streamType) {
    case "subgroup":
      return codec.decodeSubgroupStream(bytes);
    case "datagram":
      return codec.decodeDatagram(bytes);
    case "fetch":
      return codec.decodeFetchStream(bytes);
    default:
      throw new Error(`Unknown stream type: ${streamType}`);
  }
}

function encodeByStreamType(streamType: string, value: unknown): Uint8Array {
  switch (streamType) {
    case "subgroup":
      return codec.encodeSubgroupStream(value as SubgroupStream);
    case "datagram":
      return codec.encodeDatagram(value as DatagramObject);
    case "fetch":
      return codec.encodeFetchStream(value as FetchStream);
    default:
      throw new Error(`Unknown stream type: ${streamType}`);
  }
}

function assertDataStreamMatch(
  actual: unknown,
  expected: Record<string, unknown>,
  streamType: string,
): void {
  const a = actual as Record<string, unknown>;

  if (streamType === "subgroup") {
    assertSubgroupMatch(a, expected);
  } else if (streamType === "datagram") {
    assertDatagramMatch(a, expected);
  } else if (streamType === "fetch") {
    assertFetchMatch(a, expected);
  }
}

function assertSubgroupMatch(
  actual: Record<string, unknown>,
  expected: Record<string, unknown>,
): void {
  if (expected.header_type !== undefined) {
    expect(String(actual.headerType)).toBe(String(expected.header_type));
  }
  if (expected.track_alias !== undefined) {
    expect(String(actual.trackAlias)).toBe(String(expected.track_alias));
  }
  if (expected.group_id !== undefined) {
    expect(String(actual.groupId)).toBe(String(expected.group_id));
  }
  if (expected.subgroup_id !== undefined) {
    expect(String(actual.subgroupId)).toBe(String(expected.subgroup_id));
  }
  if (expected.publisher_priority !== undefined) {
    expect(String(actual.publisherPriority)).toBe(String(expected.publisher_priority));
  }

  if (expected.objects !== undefined) {
    const actualObjects = actual.objects as Array<Record<string, unknown>>;
    const expectedObjects = expected.objects as Array<Record<string, unknown>>;
    expect(actualObjects.length).toBe(expectedObjects.length);

    for (let i = 0; i < expectedObjects.length; i++) {
      const ao = actualObjects[i]!;
      const eo = expectedObjects[i]!;
      if (eo.object_id !== undefined) {
        expect(String(ao.objectId)).toBe(String(eo.object_id));
      }
      if (eo.payload_length !== undefined) {
        expect(String(ao.payloadLength)).toBe(String(eo.payload_length));
      }
      if (eo.payload_hex !== undefined) {
        expect(bytesToHex(ao.payload as Uint8Array)).toBe(eo.payload_hex);
      }
      if (eo.object_status !== undefined) {
        expect(String(ao.status)).toBe(String(eo.object_status));
      }
    }
  }
}

function assertDatagramMatch(
  actual: Record<string, unknown>,
  expected: Record<string, unknown>,
): void {
  if (expected.datagram_type !== undefined) {
    expect(String(actual.datagramType)).toBe(String(expected.datagram_type));
  }
  if (expected.track_alias !== undefined) {
    expect(String(actual.trackAlias)).toBe(String(expected.track_alias));
  }
  if (expected.group_id !== undefined) {
    expect(String(actual.groupId)).toBe(String(expected.group_id));
  }
  if (expected.object_id !== undefined) {
    expect(String(actual.objectId)).toBe(String(expected.object_id));
  }
  if (expected.publisher_priority !== undefined) {
    expect(String(actual.publisherPriority)).toBe(String(expected.publisher_priority));
  }
  if (expected.payload_hex !== undefined) {
    expect(bytesToHex(actual.payload as Uint8Array)).toBe(expected.payload_hex);
  }
  if (expected.object_status !== undefined) {
    expect(String(actual.objectStatus)).toBe(String(expected.object_status));
  }
  if (expected.end_of_group !== undefined) {
    expect(actual.endOfGroup).toBe(expected.end_of_group);
  }
}

function assertFetchMatch(
  actual: Record<string, unknown>,
  expected: Record<string, unknown>,
): void {
  if (expected.request_id !== undefined) {
    expect(String(actual.requestId)).toBe(String(expected.request_id));
  }

  if (expected.objects !== undefined) {
    const actualObjects = actual.objects as Array<Record<string, unknown>>;
    const expectedObjects = expected.objects as Array<Record<string, unknown>>;
    expect(actualObjects.length).toBe(expectedObjects.length);

    for (let i = 0; i < expectedObjects.length; i++) {
      const ao = actualObjects[i]!;
      const eo = expectedObjects[i]!;
      if (eo.group_id !== undefined) {
        expect(String(ao.groupId)).toBe(String(eo.group_id));
      }
      if (eo.subgroup_id !== undefined) {
        expect(String(ao.subgroupId)).toBe(String(eo.subgroup_id));
      }
      if (eo.object_id !== undefined) {
        expect(String(ao.objectId)).toBe(String(eo.object_id));
      }
      if (eo.publisher_priority !== undefined) {
        expect(String(ao.publisherPriority)).toBe(String(eo.publisher_priority));
      }
      if (eo.payload_length !== undefined) {
        expect(String(ao.payloadLength)).toBe(String(eo.payload_length));
      }
      if (eo.payload_hex !== undefined) {
        expect(bytesToHex(ao.payload as Uint8Array)).toBe(eo.payload_hex);
      }
      if (eo.object_status !== undefined) {
        expect(String(ao.status)).toBe(String(eo.object_status));
      }
    }
  }
}
