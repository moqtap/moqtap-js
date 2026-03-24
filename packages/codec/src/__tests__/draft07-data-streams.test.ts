import { describe, expect, it } from "vitest";
import { createDraft07Codec } from "../drafts/draft07/codec.js";
import type { DatagramObject, FetchStream, SubgroupStream } from "../drafts/draft07/types.js";
import { bytesToHex, hexToBytes, loadVectorDir } from "./helpers.js";

const codec = createDraft07Codec();

const vectorEntries = loadVectorDir("transport/draft07/codec/data-streams");

for (const { file, data: vectorFile } of vectorEntries) {
  const messageType = vectorFile.message_type;

  describe(`draft-07 data stream: ${messageType} (${file})`, () => {
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
          const streamType = getStreamType(vector);

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
  const st = vector.decoded?.stream_type as string | undefined;
  if (st === "stream_header_subgroup") return "subgroup";
  if (st === "object_datagram") return "datagram";
  if (st === "fetch_header") return "fetch";
  // Fallback for error vectors without decoded.stream_type
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
  switch (streamType) {
    case "subgroup":
      assertSubgroupStream(actual as SubgroupStream, expected);
      break;
    case "datagram":
      assertDatagram(actual as DatagramObject, expected);
      break;
    case "fetch":
      assertFetchStream(actual as FetchStream, expected);
      break;
  }
}

function assertSubgroupStream(actual: SubgroupStream, expected: Record<string, unknown>): void {
  expect(actual.type).toBe("subgroup");
  expect(String(actual.trackAlias)).toBe(String(expected.track_alias));
  expect(String(actual.groupId)).toBe(String(expected.group_id));
  expect(String(actual.subgroupId)).toBe(String(expected.subgroup_id));
  expect(String(actual.publisherPriority)).toBe(String(expected.publisher_priority));

  if (expected.objects) {
    const expectedObjects = expected.objects as Array<Record<string, unknown>>;
    expect(actual.objects.length).toBe(expectedObjects.length);
    for (let i = 0; i < expectedObjects.length; i++) {
      const ao = actual.objects[i]!;
      const eo = expectedObjects[i]!;
      expect(String(ao.objectId)).toBe(String(eo.object_id));
      expect(String(ao.payloadLength)).toBe(String(eo.payload_length));
      if (eo.object_status !== undefined && String(eo.object_status) !== "0") {
        expect(String(ao.status)).toBe(String(eo.object_status));
      }
      if (eo.payload_hex !== undefined) {
        expect(bytesToHex(ao.payload)).toBe(eo.payload_hex);
      }
    }
  }
}

function assertDatagram(actual: DatagramObject, expected: Record<string, unknown>): void {
  expect(actual.type).toBe("datagram");
  expect(String(actual.trackAlias)).toBe(String(expected.track_alias));
  expect(String(actual.groupId)).toBe(String(expected.group_id));
  expect(String(actual.objectId)).toBe(String(expected.object_id));
  expect(String(actual.publisherPriority)).toBe(String(expected.publisher_priority));
  expect(String(actual.payloadLength)).toBe(String(expected.payload_length));
  if (expected.object_status !== undefined && String(expected.object_status) !== "0") {
    expect(String(actual.status)).toBe(String(expected.object_status));
  }
  if (expected.payload_hex !== undefined) {
    expect(bytesToHex(actual.payload)).toBe(expected.payload_hex);
  }
}

function assertFetchStream(actual: FetchStream, expected: Record<string, unknown>): void {
  expect(actual.type).toBe("fetch");
  expect(String(actual.subscribeId)).toBe(String(expected.subscribe_id));

  if (expected.objects) {
    const expectedObjects = expected.objects as Array<Record<string, unknown>>;
    expect(actual.objects.length).toBe(expectedObjects.length);
    for (let i = 0; i < expectedObjects.length; i++) {
      const ao = actual.objects[i]!;
      const eo = expectedObjects[i]!;
      expect(String(ao.groupId)).toBe(String(eo.group_id));
      expect(String(ao.subgroupId)).toBe(String(eo.subgroup_id));
      expect(String(ao.objectId)).toBe(String(eo.object_id));
      expect(String(ao.publisherPriority)).toBe(String(eo.publisher_priority));
      expect(String(ao.payloadLength)).toBe(String(eo.payload_length));
      if (eo.object_status !== undefined && String(eo.object_status) !== "0") {
        expect(String(ao.status)).toBe(String(eo.object_status));
      }
      if (eo.payload_hex !== undefined) {
        expect(bytesToHex(ao.payload)).toBe(eo.payload_hex);
      }
    }
  }
}
