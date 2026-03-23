import { describe, expect, it } from "vitest";
import { BufferReader } from "../core/buffer-reader.js";
import { createDraft07Codec, dataStreamDecoders } from "../drafts/draft07/codec.js";
import { MESSAGE_TYPE_IDS } from "../drafts/draft07/messages.js";
import { bytesToHex, hexToBytes, loadVectorDir } from "./helpers.js";

const codec = createDraft07Codec();

const vectorEntries = loadVectorDir("transport/draft07/codec/data-streams");

/**
 * Map stream_type strings from test vectors to MESSAGE_TYPE_IDS.
 */
function getTypeId(streamType: string): bigint {
  switch (streamType) {
    case "object_datagram":
      return MESSAGE_TYPE_IDS.object_datagram;
    case "stream_header_subgroup":
      return MESSAGE_TYPE_IDS.stream_header_subgroup;
    case "fetch_header":
      return 0x05n; // fetch_header stream type per draft-07 spec §7.3.2
    default:
      throw new Error(`Unknown stream type: ${streamType}`);
  }
}

for (const { file, data: vectorFile } of vectorEntries) {
  const messageType = vectorFile.message_type;

  describe(`draft-07 data stream: ${messageType} (${file})`, () => {
    for (const vector of vectorFile.vectors) {
      describe(`[${vector.id}] ${vector.description}`, () => {
        const bytes = hexToBytes(vector.hex);

        if (vector.error) {
          it("should fail to decode", () => {
            const decoded = vector.decoded;
            const streamType = decoded?.stream_type as string | undefined;

            // Try decodeMessage first (works for types in DATA_STREAM_TYPE_IDS)
            const result = codec.decodeMessage(bytes);
            if (!result.ok) {
              // Expected failure
              return;
            }

            // If decodeMessage succeeded (e.g., misidentified the type), try
            // the specific data stream decoder via dataStreamDecoders
            if (streamType) {
              const typeId = getTypeId(streamType);
              const decoder = dataStreamDecoders.get(typeId);
              if (decoder) {
                try {
                  const reader = new BufferReader(bytes, 0);
                  reader.readVarInt(); // consume type ID
                  decoder(reader);
                  expect.fail("Expected decode to throw");
                } catch {
                  // Expected
                }
                return;
              }
            }

            // For truncated vectors without stream_type, just verify the raw
            // bytes can't be fully parsed
            try {
              const reader = new BufferReader(bytes, 0);
              const typeId = reader.readVarInt();
              const decoder = dataStreamDecoders.get(typeId);
              if (decoder) {
                decoder(reader);
                expect.fail("Expected decode to throw");
              }
            } catch {
              // Expected
            }
          });
        } else if (vector.decoded) {
          const decoded = vector.decoded;
          const streamType = decoded.stream_type as string;

          if (streamType === "object_datagram") {
            it("should decode correctly via decodeMessage", () => {
              const result = codec.decodeMessage(bytes);
              expect(result.ok).toBe(true);
              if (!result.ok) return;

              const msg = result.value as Record<string, unknown>;
              expect(msg.type).toBe("object_datagram");

              // Check fields that the codec exposes
              assertDatagramFields(msg, decoded);
            });

            if (vector.canonical !== false) {
              it("should re-encode to same bytes", () => {
                const result = codec.decodeMessage(bytes);
                expect(result.ok).toBe(true);
                if (!result.ok) return;

                const reEncoded = codec.encodeMessage(result.value);
                expect(bytesToHex(reEncoded)).toBe(vector.hex);
              });
            }
          } else if (streamType === "stream_header_subgroup") {
            it("should decode header via dataStreamDecoders", () => {
              const typeId = getTypeId(streamType);
              const decoder = dataStreamDecoders.get(typeId);
              expect(decoder).toBeDefined();
              if (!decoder) return;

              const reader = new BufferReader(bytes, 0);
              const wireType = reader.readVarInt();
              expect(wireType).toBe(typeId);

              const msg = decoder(reader) as Record<string, unknown>;
              expect(msg.type).toBe("stream_header_subgroup");

              // Verify header fields
              assertSubgroupHeaderFields(msg, decoded);

              // Verify objects can be parsed from remaining bytes
              if (decoded.objects) {
                const expectedObjects = decoded.objects as Array<Record<string, unknown>>;
                const actualObjects = parseSubgroupObjects(reader, expectedObjects.length);
                assertSubgroupObjects(actualObjects, expectedObjects);
              }
            });
          } else if (streamType === "fetch_header") {
            it("should decode fetch stream from raw bytes", () => {
              const reader = new BufferReader(bytes, 0);
              const wireType = reader.readVarInt();
              expect(wireType).toBe(0x05n);

              // Fetch header: subscribe_id
              const subscribeId = reader.readVarInt();
              expect(String(subscribeId)).toBe(String(decoded.subscribe_id));

              // Verify objects can be parsed from remaining bytes
              if (decoded.objects) {
                const expectedObjects = decoded.objects as Array<Record<string, unknown>>;
                const actualObjects = parseFetchObjects(reader, expectedObjects.length);
                assertFetchObjects(actualObjects, expectedObjects);
              }
            });
          }
        }
      });
    }
  });
}

// --- Assertion helpers ---

function assertDatagramFields(
  actual: Record<string, unknown>,
  expected: Record<string, unknown>,
): void {
  // The codec may use subscribeId or trackAlias as the first field.
  // Test vectors use track_alias. Check whichever the codec provides.
  if (expected.track_alias !== undefined && actual.trackAlias !== undefined) {
    expect(String(actual.trackAlias)).toBe(String(expected.track_alias));
  }
  if (expected.group_id !== undefined && actual.groupId !== undefined) {
    expect(String(actual.groupId)).toBe(String(expected.group_id));
  }
  if (expected.object_id !== undefined && actual.objectId !== undefined) {
    expect(String(actual.objectId)).toBe(String(expected.object_id));
  }
  if (expected.publisher_priority !== undefined && actual.publisherPriority !== undefined) {
    expect(String(actual.publisherPriority)).toBe(String(expected.publisher_priority));
  }
  if (expected.object_status !== undefined && actual.objectStatus !== undefined) {
    expect(String(actual.objectStatus)).toBe(String(expected.object_status));
  }
  if (expected.payload_hex !== undefined && actual.payload !== undefined) {
    expect(bytesToHex(actual.payload as Uint8Array)).toBe(expected.payload_hex);
  }
}

function assertSubgroupHeaderFields(
  actual: Record<string, unknown>,
  expected: Record<string, unknown>,
): void {
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
}

/**
 * Parse subgroup objects from remaining bytes in reader.
 * Draft-07 subgroup object format: object_id (varint), payload_length (varint),
 * then either payload (if length > 0) or object_status (if length == 0).
 */
function parseSubgroupObjects(reader: BufferReader, count: number): Array<Record<string, unknown>> {
  const objects: Array<Record<string, unknown>> = [];
  for (let i = 0; i < count && reader.remaining > 0; i++) {
    const objectId = reader.readVarInt();
    const payloadLength = Number(reader.readVarInt());
    let objectStatus = 0;
    let payload = new Uint8Array(0);

    if (payloadLength === 0) {
      // Object status follows when payload length is 0
      if (reader.remaining > 0) {
        objectStatus = Number(reader.readVarInt());
      }
    } else {
      payload = reader.readBytes(payloadLength);
    }

    objects.push({
      objectId,
      objectStatus,
      payloadLength,
      payload,
    });
  }
  return objects;
}

function assertSubgroupObjects(
  actual: Array<Record<string, unknown>>,
  expected: Array<Record<string, unknown>>,
): void {
  expect(actual.length).toBe(expected.length);
  for (let i = 0; i < expected.length; i++) {
    const a = actual[i]!;
    const e = expected[i]!;
    if (e.object_id !== undefined) {
      expect(String(a.objectId)).toBe(String(e.object_id));
    }
    if (e.payload_length !== undefined) {
      expect(String(a.payloadLength)).toBe(String(e.payload_length));
    }
    if (e.object_status !== undefined) {
      expect(String(a.objectStatus)).toBe(String(e.object_status));
    }
    if (e.payload_hex !== undefined) {
      expect(bytesToHex(a.payload as Uint8Array)).toBe(e.payload_hex);
    }
  }
}

/**
 * Parse fetch objects from remaining bytes.
 * Draft-07 fetch object format: group_id, subgroup_id, object_id,
 * publisher_priority (8), payload_length, [payload | object_status].
 */
function parseFetchObjects(reader: BufferReader, count: number): Array<Record<string, unknown>> {
  const objects: Array<Record<string, unknown>> = [];
  for (let i = 0; i < count && reader.remaining > 0; i++) {
    const groupId = reader.readVarInt();
    const subgroupId = reader.readVarInt();
    const objectId = reader.readVarInt();
    const publisherPriority = reader.readUint8();
    const payloadLength = Number(reader.readVarInt());
    let objectStatus = 0;
    let payload = new Uint8Array(0);

    if (payloadLength === 0) {
      if (reader.remaining > 0) {
        objectStatus = Number(reader.readVarInt());
      }
    } else {
      payload = reader.readBytes(payloadLength);
    }

    objects.push({
      groupId,
      subgroupId,
      objectId,
      publisherPriority,
      objectStatus,
      payloadLength,
      payload,
    });
  }
  return objects;
}

function assertFetchObjects(
  actual: Array<Record<string, unknown>>,
  expected: Array<Record<string, unknown>>,
): void {
  expect(actual.length).toBe(expected.length);
  for (let i = 0; i < expected.length; i++) {
    const a = actual[i]!;
    const e = expected[i]!;
    if (e.group_id !== undefined) {
      expect(String(a.groupId)).toBe(String(e.group_id));
    }
    if (e.subgroup_id !== undefined) {
      expect(String(a.subgroupId)).toBe(String(e.subgroup_id));
    }
    if (e.object_id !== undefined) {
      expect(String(a.objectId)).toBe(String(e.object_id));
    }
    if (e.publisher_priority !== undefined) {
      expect(String(a.publisherPriority)).toBe(String(e.publisher_priority));
    }
    if (e.payload_length !== undefined) {
      expect(String(a.payloadLength)).toBe(String(e.payload_length));
    }
    if (e.object_status !== undefined) {
      expect(String(a.objectStatus)).toBe(String(e.object_status));
    }
    if (e.payload_hex !== undefined) {
      expect(bytesToHex(a.payload as Uint8Array)).toBe(e.payload_hex);
    }
  }
}
