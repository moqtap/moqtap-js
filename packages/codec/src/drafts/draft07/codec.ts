import { BufferReader } from "../../core/buffer-reader.js";
import { BufferWriter } from "../../core/buffer-writer.js";
import type {
  Announce,
  AnnounceCancel,
  AnnounceError,
  AnnounceOk,
  ClientSetup,
  Codec,
  DecodeResult,
  Fetch,
  FetchCancel,
  FetchError,
  FetchOk,
  FilterType,
  GoAway,
  GroupOrderValue,
  MaxSubscribeId,
  MoqtMessage,
  MoqtMessageType,
  ObjectDatagram,
  ServerSetup,
  StreamHeaderSubgroup,
  Subscribe,
  SubscribeAnnounces,
  SubscribeAnnouncesError,
  SubscribeAnnouncesOk,
  SubscribeDone,
  SubscribeError,
  SubscribeOk,
  SubscribeUpdate,
  TrackStatus,
  TrackStatusRequest,
  Unannounce,
  Unsubscribe,
  UnsubscribeAnnounces,
} from "../../core/types.js";
import { DecodeError } from "../../core/types.js";
import type {
  DatagramObject as Draft07DatagramObject,
  FetchStream,
  SubgroupStream,
} from "./types.js";
import { MESSAGE_TYPE_IDS } from "./messages.js";
import { decodeVarInt, encodeVarInt } from "./varint.js";

// --- FilterType mapping ---

const FILTER_TYPE_TO_WIRE: Record<FilterType, bigint> = {
  latest_group: 1n,
  latest_object: 2n,
  absolute_start: 3n,
  absolute_range: 4n,
};

const WIRE_TO_FILTER_TYPE: Map<bigint, FilterType> = new Map([
  [1n, "latest_group"],
  [2n, "latest_object"],
  [3n, "absolute_start"],
  [4n, "absolute_range"],
]);

// --- GroupOrderValue mapping ---

const GROUP_ORDER_TO_WIRE: Record<GroupOrderValue, number> = {
  original: 0,
  ascending: 1,
  descending: 2,
};

const WIRE_TO_GROUP_ORDER: Map<number, GroupOrderValue> = new Map([
  [0, "original"],
  [1, "ascending"],
  [2, "descending"],
]);

// --- Encode helpers ---

function writeGroupOrder(writer: BufferWriter, value: GroupOrderValue): void {
  const wire = GROUP_ORDER_TO_WIRE[value];
  writer.writeUint8(wire);
}

function readGroupOrder(reader: BufferReader): GroupOrderValue {
  const wire = reader.readUint8();
  const value = WIRE_TO_GROUP_ORDER.get(wire);
  if (value === undefined) {
    throw new DecodeError(
      "CONSTRAINT_VIOLATION",
      `Invalid group order value: ${wire}`,
      reader.offset - 1,
    );
  }
  return value;
}

// Data stream type IDs that NEVER appear as control messages.
// Note: 0x04 (stream_header_subgroup) excluded — shares ID with subscribe_ok.
// Note: 0x05 (fetch_header) excluded — shares ID with subscribe_error.
// Callers must use decodeSubgroupStream/decodeFetchStream directly.
const DATA_STREAM_TYPE_IDS: ReadonlySet<bigint> = new Set([
  MESSAGE_TYPE_IDS.object_datagram,
]);

// --- Control message type (excludes data stream types) ---
type ControlMessageType = Exclude<
  MoqtMessageType,
  | "object_stream"
  | "object_datagram"
  | "stream_header_track"
  | "stream_header_group"
  | "stream_header_subgroup"
>;


// --- Encode functions for each message type (payload only, no type ID) ---

function encodeClientSetup(msg: ClientSetup, writer: BufferWriter): void {
  writer.writeVarInt(msg.supportedVersions.length);
  for (const version of msg.supportedVersions) {
    writer.writeVarInt(version);
  }
  writer.writeParameters(msg.parameters);
}

function encodeServerSetup(msg: ServerSetup, writer: BufferWriter): void {
  writer.writeVarInt(msg.selectedVersion);
  writer.writeParameters(msg.parameters);
}

function encodeSubscribe(msg: Subscribe, writer: BufferWriter): void {
  writer.writeVarInt(msg.subscribeId);
  writer.writeVarInt(msg.trackAlias);
  writer.writeTuple(msg.trackNamespace);
  writer.writeString(msg.trackName);
  writer.writeUint8(msg.subscriberPriority);
  writeGroupOrder(writer, msg.groupOrder);
  writer.writeVarInt(FILTER_TYPE_TO_WIRE[msg.filterType]);
  if (msg.filterType === "absolute_start" || msg.filterType === "absolute_range") {
    writer.writeVarInt(msg.startGroup!);
    writer.writeVarInt(msg.startObject!);
  }
  if (msg.filterType === "absolute_range") {
    writer.writeVarInt(msg.endGroup!);
    writer.writeVarInt(msg.endObject!);
  }
  writer.writeParameters(msg.parameters);
}

function encodeSubscribeOk(msg: SubscribeOk, writer: BufferWriter): void {
  writer.writeVarInt(msg.subscribeId);
  writer.writeVarInt(msg.expires);
  writeGroupOrder(writer, msg.groupOrder);
  writer.writeUint8(msg.contentExists ? 1 : 0);
  if (msg.contentExists) {
    writer.writeVarInt(msg.largestGroupId!);
    writer.writeVarInt(msg.largestObjectId!);
  }
  writer.writeParameters(msg.parameters);
}

function encodeSubscribeError(msg: SubscribeError, writer: BufferWriter): void {
  writer.writeVarInt(msg.subscribeId);
  writer.writeVarInt(msg.errorCode);
  writer.writeString(msg.reasonPhrase);
  writer.writeVarInt(msg.trackAlias);
}

function encodeSubscribeDone(msg: SubscribeDone, writer: BufferWriter): void {
  writer.writeVarInt(msg.subscribeId);
  writer.writeVarInt(msg.statusCode);
  writer.writeString(msg.reasonPhrase);
  writer.writeUint8(msg.contentExists ? 1 : 0);
  if (msg.contentExists) {
    writer.writeVarInt(msg.finalGroupId!);
    writer.writeVarInt(msg.finalObjectId!);
  }
}

function encodeSubscribeUpdate(msg: SubscribeUpdate, writer: BufferWriter): void {
  writer.writeVarInt(msg.subscribeId);
  writer.writeVarInt(msg.startGroup);
  writer.writeVarInt(msg.startObject);
  writer.writeVarInt(msg.endGroup);
  writer.writeVarInt(msg.endObject);
  writer.writeUint8(msg.subscriberPriority);
  writer.writeParameters(msg.parameters);
}

function encodeUnsubscribe(msg: Unsubscribe, writer: BufferWriter): void {
  writer.writeVarInt(msg.subscribeId);
}

function encodeAnnounce(msg: Announce, writer: BufferWriter): void {
  writer.writeTuple(msg.trackNamespace);
  writer.writeParameters(msg.parameters);
}

function encodeAnnounceOk(msg: AnnounceOk, writer: BufferWriter): void {
  writer.writeTuple(msg.trackNamespace);
}

function encodeAnnounceError(msg: AnnounceError, writer: BufferWriter): void {
  writer.writeTuple(msg.trackNamespace);
  writer.writeVarInt(msg.errorCode);
  writer.writeString(msg.reasonPhrase);
}

function encodeAnnounceCancel(msg: AnnounceCancel, writer: BufferWriter): void {
  writer.writeTuple(msg.trackNamespace);
  writer.writeVarInt(msg.errorCode);
  writer.writeString(msg.reasonPhrase);
}

function encodeUnannounce(msg: Unannounce, writer: BufferWriter): void {
  writer.writeTuple(msg.trackNamespace);
}

function encodeTrackStatusRequest(msg: TrackStatusRequest, writer: BufferWriter): void {
  writer.writeTuple(msg.trackNamespace);
  writer.writeString(msg.trackName);
}

function encodeTrackStatus(msg: TrackStatus, writer: BufferWriter): void {
  writer.writeTuple(msg.trackNamespace);
  writer.writeString(msg.trackName);
  writer.writeVarInt(msg.statusCode);
  writer.writeVarInt(msg.lastGroupId);
  writer.writeVarInt(msg.lastObjectId);
}

function encodeGoAway(msg: GoAway, writer: BufferWriter): void {
  writer.writeString(msg.newSessionUri);
}

function encodeSubscribeAnnounces(msg: SubscribeAnnounces, writer: BufferWriter): void {
  writer.writeTuple(msg.trackNamespace);
  writer.writeParameters(msg.parameters);
}

function encodeSubscribeAnnouncesOk(msg: SubscribeAnnouncesOk, writer: BufferWriter): void {
  writer.writeTuple(msg.trackNamespace);
}

function encodeSubscribeAnnouncesError(msg: SubscribeAnnouncesError, writer: BufferWriter): void {
  writer.writeTuple(msg.trackNamespace);
  writer.writeVarInt(msg.errorCode);
  writer.writeString(msg.reasonPhrase);
}

function encodeUnsubscribeAnnounces(msg: UnsubscribeAnnounces, writer: BufferWriter): void {
  writer.writeTuple(msg.trackNamespace);
}

function encodeMaxSubscribeId(msg: MaxSubscribeId, writer: BufferWriter): void {
  writer.writeVarInt(msg.subscribeId);
}

function encodeFetch(msg: Fetch, writer: BufferWriter): void {
  writer.writeVarInt(msg.subscribeId);
  writer.writeTuple(msg.trackNamespace);
  writer.writeString(msg.trackName);
  writer.writeUint8(msg.subscriberPriority);
  writeGroupOrder(writer, msg.groupOrder);
  writer.writeVarInt(msg.startGroup);
  writer.writeVarInt(msg.startObject);
  writer.writeVarInt(msg.endGroup);
  writer.writeVarInt(msg.endObject);
  writer.writeParameters(msg.parameters);
}

function encodeFetchOk(msg: FetchOk, writer: BufferWriter): void {
  writer.writeVarInt(msg.subscribeId);
  writeGroupOrder(writer, msg.groupOrder);
  writer.writeUint8(msg.endOfTrack ? 1 : 0);
  writer.writeVarInt(msg.largestGroupId);
  writer.writeVarInt(msg.largestObjectId);
  writer.writeParameters(msg.parameters);
}

function encodeFetchError(msg: FetchError, writer: BufferWriter): void {
  writer.writeVarInt(msg.subscribeId);
  writer.writeVarInt(msg.errorCode);
  writer.writeString(msg.reasonPhrase);
}

function encodeFetchCancel(msg: FetchCancel, writer: BufferWriter): void {
  writer.writeVarInt(msg.subscribeId);
}

// Data stream encoders (no type+length framing)
function encodeObjectPayload(
  msg: { objectStatus?: number; payload: Uint8Array },
  writer: BufferWriter,
): void {
  if (msg.payload.byteLength === 0) {
    writer.writeVarInt(0); // payloadLength = 0 signals objectStatus follows
    writer.writeVarInt(msg.objectStatus ?? 0);
  } else {
    writer.writeVarInt(msg.payload.byteLength);
    writer.writeBytes(msg.payload);
  }
}

function encodeObjectDatagram(msg: ObjectDatagram, writer: BufferWriter): void {
  writer.writeVarInt(MESSAGE_TYPE_IDS.object_datagram);
  writer.writeVarInt(msg.trackAlias);
  writer.writeVarInt(msg.groupId);
  writer.writeVarInt(msg.objectId);
  writer.writeUint8(msg.publisherPriority);
  encodeObjectPayload(msg, writer);
}

// --- Encode dispatch ---

// Control message encoders (payload-only, framing added by encodeMessageImpl)
const controlEncoders: Record<ControlMessageType, (msg: never, writer: BufferWriter) => void> = {
  client_setup: encodeClientSetup as (msg: never, writer: BufferWriter) => void,
  server_setup: encodeServerSetup as (msg: never, writer: BufferWriter) => void,
  subscribe: encodeSubscribe as (msg: never, writer: BufferWriter) => void,
  subscribe_ok: encodeSubscribeOk as (msg: never, writer: BufferWriter) => void,
  subscribe_error: encodeSubscribeError as (msg: never, writer: BufferWriter) => void,
  subscribe_done: encodeSubscribeDone as (msg: never, writer: BufferWriter) => void,
  subscribe_update: encodeSubscribeUpdate as (msg: never, writer: BufferWriter) => void,
  unsubscribe: encodeUnsubscribe as (msg: never, writer: BufferWriter) => void,
  announce: encodeAnnounce as (msg: never, writer: BufferWriter) => void,
  announce_ok: encodeAnnounceOk as (msg: never, writer: BufferWriter) => void,
  announce_error: encodeAnnounceError as (msg: never, writer: BufferWriter) => void,
  announce_cancel: encodeAnnounceCancel as (msg: never, writer: BufferWriter) => void,
  unannounce: encodeUnannounce as (msg: never, writer: BufferWriter) => void,
  track_status_request: encodeTrackStatusRequest as (msg: never, writer: BufferWriter) => void,
  track_status: encodeTrackStatus as (msg: never, writer: BufferWriter) => void,
  goaway: encodeGoAway as (msg: never, writer: BufferWriter) => void,
  subscribe_announces: encodeSubscribeAnnounces as (msg: never, writer: BufferWriter) => void,
  subscribe_announces_ok: encodeSubscribeAnnouncesOk as (msg: never, writer: BufferWriter) => void,
  subscribe_announces_error: encodeSubscribeAnnouncesError as (
    msg: never,
    writer: BufferWriter,
  ) => void,
  unsubscribe_announces: encodeUnsubscribeAnnounces as (msg: never, writer: BufferWriter) => void,
  max_subscribe_id: encodeMaxSubscribeId as (msg: never, writer: BufferWriter) => void,
  fetch: encodeFetch as (msg: never, writer: BufferWriter) => void,
  fetch_ok: encodeFetchOk as (msg: never, writer: BufferWriter) => void,
  fetch_error: encodeFetchError as (msg: never, writer: BufferWriter) => void,
  fetch_cancel: encodeFetchCancel as (msg: never, writer: BufferWriter) => void,
};

// Data stream encoders (write type + fields directly, no length framing)
const dataStreamEncoders: Partial<
  Record<MoqtMessageType, (msg: never, writer: BufferWriter) => void>
> = {
  object_datagram: encodeObjectDatagram as (msg: never, writer: BufferWriter) => void,
};

// --- Decode functions for each message type ---

function decodeClientSetup(reader: BufferReader): ClientSetup {
  const numVersions = reader.readVarInt();
  if (numVersions === 0n) {
    throw new DecodeError(
      "CONSTRAINT_VIOLATION",
      "supported_versions must not be empty",
      reader.offset,
    );
  }
  const supportedVersions: bigint[] = [];
  for (let i = 0n; i < numVersions; i++) {
    supportedVersions.push(reader.readVarInt());
  }
  const parameters = reader.readParameters();
  return { type: "client_setup", supportedVersions, parameters };
}

function decodeServerSetup(reader: BufferReader): ServerSetup {
  const selectedVersion = reader.readVarInt();
  const parameters = reader.readParameters();
  return { type: "server_setup", selectedVersion, parameters };
}

function decodeSubscribe(reader: BufferReader): Subscribe {
  const subscribeId = reader.readVarInt();
  const trackAlias = reader.readVarInt();
  const trackNamespace = reader.readTuple();
  const trackName = reader.readString();
  const subscriberPriority = reader.readUint8();
  const groupOrder = readGroupOrder(reader);
  const filterTypeWire = reader.readVarInt();
  const filterType = WIRE_TO_FILTER_TYPE.get(filterTypeWire);
  if (filterType === undefined) {
    throw new DecodeError(
      "CONSTRAINT_VIOLATION",
      `Invalid filter type: ${filterTypeWire}`,
      reader.offset,
    );
  }

  const base = {
    type: "subscribe" as const,
    subscribeId,
    trackAlias,
    trackNamespace,
    trackName,
    subscriberPriority,
    groupOrder,
    filterType,
    parameters: undefined as unknown as Map<bigint, Uint8Array>,
  };

  if (filterType === "absolute_start") {
    const startGroup = reader.readVarInt();
    const startObject = reader.readVarInt();
    base.parameters = reader.readParameters();
    return { ...base, startGroup, startObject };
  }
  if (filterType === "absolute_range") {
    const startGroup = reader.readVarInt();
    const startObject = reader.readVarInt();
    const endGroup = reader.readVarInt();
    const endObject = reader.readVarInt();
    base.parameters = reader.readParameters();
    return { ...base, startGroup, startObject, endGroup, endObject };
  }

  base.parameters = reader.readParameters();
  return base;
}

function decodeSubscribeOk(reader: BufferReader): SubscribeOk {
  const subscribeId = reader.readVarInt();
  const expires = reader.readVarInt();
  const groupOrder = readGroupOrder(reader);
  const contentExistsWire = reader.readUint8();
  const contentExists = contentExistsWire !== 0;

  if (contentExists) {
    const largestGroupId = reader.readVarInt();
    const largestObjectId = reader.readVarInt();
    const parameters = reader.readParameters();
    return {
      type: "subscribe_ok" as const,
      subscribeId,
      expires,
      groupOrder,
      contentExists,
      largestGroupId,
      largestObjectId,
      parameters,
    };
  }

  const parameters = reader.readParameters();
  return {
    type: "subscribe_ok" as const,
    subscribeId,
    expires,
    groupOrder,
    contentExists,
    parameters,
  };
}

function decodeSubscribeError(reader: BufferReader): SubscribeError {
  const subscribeId = reader.readVarInt();
  const errorCode = reader.readVarInt();
  const reasonPhrase = reader.readString();
  const trackAlias = reader.readVarInt();
  return { type: "subscribe_error", subscribeId, errorCode, reasonPhrase, trackAlias };
}

function decodeSubscribeDone(reader: BufferReader): SubscribeDone {
  const subscribeId = reader.readVarInt();
  const statusCode = reader.readVarInt();
  const reasonPhrase = reader.readString();
  const contentExistsWire = reader.readUint8();
  const contentExists = contentExistsWire !== 0;

  if (contentExists) {
    const finalGroupId = reader.readVarInt();
    const finalObjectId = reader.readVarInt();
    return {
      type: "subscribe_done" as const,
      subscribeId,
      statusCode,
      reasonPhrase,
      contentExists,
      finalGroupId,
      finalObjectId,
    };
  }

  return { type: "subscribe_done" as const, subscribeId, statusCode, reasonPhrase, contentExists };
}

function decodeSubscribeUpdate(reader: BufferReader): SubscribeUpdate {
  const subscribeId = reader.readVarInt();
  const startGroup = reader.readVarInt();
  const startObject = reader.readVarInt();
  const endGroup = reader.readVarInt();
  const endObject = reader.readVarInt();
  const subscriberPriority = reader.readUint8();
  const parameters = reader.readParameters();
  return {
    type: "subscribe_update",
    subscribeId,
    startGroup,
    startObject,
    endGroup,
    endObject,
    subscriberPriority,
    parameters,
  };
}

function decodeUnsubscribe(reader: BufferReader): Unsubscribe {
  const subscribeId = reader.readVarInt();
  return { type: "unsubscribe", subscribeId };
}

function decodeAnnounce(reader: BufferReader): Announce {
  const trackNamespace = reader.readTuple();
  const parameters = reader.readParameters();
  return { type: "announce", trackNamespace, parameters };
}

function decodeAnnounceOk(reader: BufferReader): AnnounceOk {
  const trackNamespace = reader.readTuple();
  return { type: "announce_ok", trackNamespace };
}

function decodeAnnounceError(reader: BufferReader): AnnounceError {
  const trackNamespace = reader.readTuple();
  const errorCode = reader.readVarInt();
  const reasonPhrase = reader.readString();
  return { type: "announce_error", trackNamespace, errorCode, reasonPhrase };
}

function decodeAnnounceCancel(reader: BufferReader): AnnounceCancel {
  const trackNamespace = reader.readTuple();
  const errorCode = reader.readVarInt();
  const reasonPhrase = reader.readString();
  return { type: "announce_cancel", trackNamespace, errorCode, reasonPhrase };
}

function decodeUnannounce(reader: BufferReader): Unannounce {
  const trackNamespace = reader.readTuple();
  return { type: "unannounce", trackNamespace };
}

function decodeTrackStatusRequest(reader: BufferReader): TrackStatusRequest {
  const trackNamespace = reader.readTuple();
  const trackName = reader.readString();
  return { type: "track_status_request", trackNamespace, trackName };
}

function decodeTrackStatus(reader: BufferReader): TrackStatus {
  const trackNamespace = reader.readTuple();
  const trackName = reader.readString();
  const statusCode = reader.readVarInt();
  const lastGroupId = reader.readVarInt();
  const lastObjectId = reader.readVarInt();
  return { type: "track_status", trackNamespace, trackName, statusCode, lastGroupId, lastObjectId };
}

function decodeGoAway(reader: BufferReader): GoAway {
  const newSessionUri = reader.readString();
  return { type: "goaway", newSessionUri };
}

function decodeSubscribeAnnounces(reader: BufferReader): SubscribeAnnounces {
  const trackNamespace = reader.readTuple();
  const parameters = reader.readParameters();
  return { type: "subscribe_announces", trackNamespace, parameters };
}

function decodeSubscribeAnnouncesOk(reader: BufferReader): SubscribeAnnouncesOk {
  const trackNamespace = reader.readTuple();
  return { type: "subscribe_announces_ok", trackNamespace };
}

function decodeSubscribeAnnouncesError(reader: BufferReader): SubscribeAnnouncesError {
  const trackNamespace = reader.readTuple();
  const errorCode = reader.readVarInt();
  const reasonPhrase = reader.readString();
  return { type: "subscribe_announces_error", trackNamespace, errorCode, reasonPhrase };
}

function decodeUnsubscribeAnnounces(reader: BufferReader): UnsubscribeAnnounces {
  const trackNamespace = reader.readTuple();
  return { type: "unsubscribe_announces", trackNamespace };
}

function decodeMaxSubscribeId(reader: BufferReader): MaxSubscribeId {
  const subscribeId = reader.readVarInt();
  return { type: "max_subscribe_id", subscribeId };
}

function decodeFetch(reader: BufferReader): Fetch {
  const subscribeId = reader.readVarInt();
  const trackNamespace = reader.readTuple();
  const trackName = reader.readString();
  const subscriberPriority = reader.readUint8();
  const groupOrder = readGroupOrder(reader);
  const startGroup = reader.readVarInt();
  const startObject = reader.readVarInt();
  const endGroup = reader.readVarInt();
  const endObject = reader.readVarInt();
  const parameters = reader.readParameters();
  return {
    type: "fetch" as const,
    subscribeId,
    trackNamespace,
    trackName,
    subscriberPriority,
    groupOrder,
    startGroup,
    startObject,
    endGroup,
    endObject,
    parameters,
  };
}

function decodeFetchOk(reader: BufferReader): FetchOk {
  const subscribeId = reader.readVarInt();
  const groupOrder = readGroupOrder(reader);
  const endOfTrackWire = reader.readUint8();
  const endOfTrack = endOfTrackWire !== 0;
  const largestGroupId = reader.readVarInt();
  const largestObjectId = reader.readVarInt();
  const parameters = reader.readParameters();
  return {
    type: "fetch_ok" as const,
    subscribeId,
    groupOrder,
    endOfTrack,
    largestGroupId,
    largestObjectId,
    parameters,
  };
}

function decodeFetchError(reader: BufferReader): FetchError {
  const subscribeId = reader.readVarInt();
  const errorCode = reader.readVarInt();
  const reasonPhrase = reader.readString();
  return { type: "fetch_error", subscribeId, errorCode, reasonPhrase };
}

function decodeFetchCancel(reader: BufferReader): FetchCancel {
  const subscribeId = reader.readVarInt();
  return { type: "fetch_cancel", subscribeId };
}

function decodeObjectDatagram(reader: BufferReader): ObjectDatagram {
  const trackAlias = reader.readVarInt();
  const groupId = reader.readVarInt();
  const objectId = reader.readVarInt();
  const publisherPriority = reader.readUint8();
  const payloadLength = Number(reader.readVarInt());
  if (payloadLength === 0) {
    // Object Status follows when payload length is 0
    const objectStatus = reader.remaining > 0 ? Number(reader.readVarInt()) : 0;
    return {
      type: "object_datagram" as const,
      trackAlias,
      groupId,
      objectId,
      publisherPriority,
      objectStatus,
      payload: new Uint8Array(0),
    };
  }
  const payload = reader.readBytesView(payloadLength);
  return {
    type: "object_datagram" as const,
    trackAlias,
    groupId,
    objectId,
    publisherPriority,
    payload,
  };
}


// --- Decode dispatch by wire type ID (control messages only) ---

type Decoder = (reader: BufferReader) => MoqtMessage;

const controlDecoders = new Map<bigint, Decoder>([
  [MESSAGE_TYPE_IDS.client_setup, decodeClientSetup],
  [MESSAGE_TYPE_IDS.server_setup, decodeServerSetup],
  [MESSAGE_TYPE_IDS.subscribe, decodeSubscribe],
  [MESSAGE_TYPE_IDS.subscribe_ok, decodeSubscribeOk],
  [MESSAGE_TYPE_IDS.subscribe_error, decodeSubscribeError],
  [MESSAGE_TYPE_IDS.subscribe_done, decodeSubscribeDone],
  [MESSAGE_TYPE_IDS.subscribe_update, decodeSubscribeUpdate],
  [MESSAGE_TYPE_IDS.unsubscribe, decodeUnsubscribe],
  [MESSAGE_TYPE_IDS.announce, decodeAnnounce],
  [MESSAGE_TYPE_IDS.announce_ok, decodeAnnounceOk],
  [MESSAGE_TYPE_IDS.announce_error, decodeAnnounceError],
  [MESSAGE_TYPE_IDS.announce_cancel, decodeAnnounceCancel],
  [MESSAGE_TYPE_IDS.unannounce, decodeUnannounce],
  [MESSAGE_TYPE_IDS.track_status_request, decodeTrackStatusRequest],
  [MESSAGE_TYPE_IDS.track_status, decodeTrackStatus],
  [MESSAGE_TYPE_IDS.goaway, decodeGoAway],
  [MESSAGE_TYPE_IDS.subscribe_announces, decodeSubscribeAnnounces],
  [MESSAGE_TYPE_IDS.subscribe_announces_ok, decodeSubscribeAnnouncesOk],
  [MESSAGE_TYPE_IDS.subscribe_announces_error, decodeSubscribeAnnouncesError],
  [MESSAGE_TYPE_IDS.unsubscribe_announces, decodeUnsubscribeAnnounces],
  [MESSAGE_TYPE_IDS.max_subscribe_id, decodeMaxSubscribeId],
  [MESSAGE_TYPE_IDS.fetch, decodeFetch],
  [MESSAGE_TYPE_IDS.fetch_ok, decodeFetchOk],
  [MESSAGE_TYPE_IDS.fetch_error, decodeFetchError],
  [MESSAGE_TYPE_IDS.fetch_cancel, decodeFetchCancel],
]);

// Data stream decoders keyed by wire ID (for disambiguation)
const dataStreamDecoders = new Map<bigint, Decoder>([
  [MESSAGE_TYPE_IDS.object_datagram, decodeObjectDatagram],
]);

// --- Message type to wire ID mapping ---
const MESSAGE_TYPE_TO_WIRE: Record<ControlMessageType, bigint> = {
  client_setup: MESSAGE_TYPE_IDS.client_setup,
  server_setup: MESSAGE_TYPE_IDS.server_setup,
  subscribe: MESSAGE_TYPE_IDS.subscribe,
  subscribe_ok: MESSAGE_TYPE_IDS.subscribe_ok,
  subscribe_error: MESSAGE_TYPE_IDS.subscribe_error,
  subscribe_done: MESSAGE_TYPE_IDS.subscribe_done,
  subscribe_update: MESSAGE_TYPE_IDS.subscribe_update,
  unsubscribe: MESSAGE_TYPE_IDS.unsubscribe,
  announce: MESSAGE_TYPE_IDS.announce,
  announce_ok: MESSAGE_TYPE_IDS.announce_ok,
  announce_error: MESSAGE_TYPE_IDS.announce_error,
  announce_cancel: MESSAGE_TYPE_IDS.announce_cancel,
  unannounce: MESSAGE_TYPE_IDS.unannounce,
  track_status_request: MESSAGE_TYPE_IDS.track_status_request,
  track_status: MESSAGE_TYPE_IDS.track_status,
  goaway: MESSAGE_TYPE_IDS.goaway,
  subscribe_announces: MESSAGE_TYPE_IDS.subscribe_announces,
  subscribe_announces_ok: MESSAGE_TYPE_IDS.subscribe_announces_ok,
  subscribe_announces_error: MESSAGE_TYPE_IDS.subscribe_announces_error,
  unsubscribe_announces: MESSAGE_TYPE_IDS.unsubscribe_announces,
  max_subscribe_id: MESSAGE_TYPE_IDS.max_subscribe_id,
  fetch: MESSAGE_TYPE_IDS.fetch,
  fetch_ok: MESSAGE_TYPE_IDS.fetch_ok,
  fetch_error: MESSAGE_TYPE_IDS.fetch_error,
  fetch_cancel: MESSAGE_TYPE_IDS.fetch_cancel,
};

// --- Public codec API ---

function encodeMessageImpl(message: MoqtMessage): Uint8Array {
  // Check if it's a data stream message (no type+length framing)
  const dataEncoder = dataStreamEncoders[message.type];
  if (dataEncoder) {
    const writer = new BufferWriter();
    dataEncoder(message as never, writer);
    return writer.finish();
  }

  // Control message: type + length + payload framing
  const controlEncoder = controlEncoders[message.type as ControlMessageType];
  if (!controlEncoder) {
    throw new Error(`Unknown message type: ${message.type}`);
  }

  // Encode payload first
  const payloadWriter = new BufferWriter();
  controlEncoder(message as never, payloadWriter);
  const payload = payloadWriter.finishView();

  // Write type + length + payload
  const frameWriter = new BufferWriter(payload.byteLength + 16);
  frameWriter.writeVarInt(MESSAGE_TYPE_TO_WIRE[message.type as ControlMessageType]);
  frameWriter.writeVarInt(payload.byteLength);
  frameWriter.writeBytes(payload);
  return frameWriter.finish();
}

function decodeMessageImpl(bytes: Uint8Array): DecodeResult<MoqtMessage> {
  try {
    const reader = new BufferReader(bytes, 0);
    const typeId = reader.readVarInt();

    // Check if this is a data stream type (no length framing)
    if (DATA_STREAM_TYPE_IDS.has(typeId)) {
      const decoder = dataStreamDecoders.get(typeId);
      if (!decoder) {
        return {
          ok: false,
          error: new DecodeError(
            "UNKNOWN_MESSAGE_TYPE",
            `Unknown data stream type ID: 0x${typeId.toString(16)}`,
            0,
          ),
        };
      }
      const message = decoder(reader);
      return { ok: true, value: message, bytesRead: reader.offset };
    }

    // Control message: read length, then decode payload from bounded sub-reader
    const payloadLength = Number(reader.readVarInt());
    const _headerBytes = reader.offset; // bytes consumed by type + length

    if (reader.remaining < payloadLength) {
      return {
        ok: false,
        error: new DecodeError(
          "UNEXPECTED_END",
          `Not enough bytes for payload: need ${payloadLength}, have ${reader.remaining}`,
          reader.offset,
        ),
      };
    }

    const payloadBytes = reader.readBytes(payloadLength);
    const totalBytesRead = reader.offset;

    const decoder = controlDecoders.get(typeId);
    if (!decoder) {
      return {
        ok: false,
        error: new DecodeError(
          "UNKNOWN_MESSAGE_TYPE",
          `Unknown message type ID: 0x${typeId.toString(16)}`,
          0,
        ),
      };
    }

    const payloadReader = new BufferReader(payloadBytes, 0);
    const message = decoder(payloadReader);
    return { ok: true, value: message, bytesRead: totalBytesRead };
  } catch (e) {
    if (e instanceof DecodeError) {
      return { ok: false, error: e };
    }
    throw e;
  }
}

function createStreamDecoderImpl(): TransformStream<Uint8Array, MoqtMessage> {
  let buffer = new Uint8Array(0);
  let offset = 0;

  return new TransformStream<Uint8Array, MoqtMessage>({
    transform(chunk, controller) {
      // Compact before accumulating new data
      if (offset > 0) {
        buffer = buffer.subarray(offset);
        offset = 0;
      }
      const newBuffer = new Uint8Array(buffer.length + chunk.length);
      newBuffer.set(buffer, 0);
      newBuffer.set(chunk, buffer.length);
      buffer = newBuffer;

      // Try to decode messages from the buffer
      while (offset < buffer.length) {
        const result = decodeMessageImpl(buffer.subarray(offset));
        if (!result.ok) {
          if (result.error.code === "UNEXPECTED_END") {
            // Need more data -- wait for next chunk
            break;
          }
          // Fatal decode error
          controller.error(result.error);
          return;
        }
        controller.enqueue(result.value);
        // Advance offset past the consumed bytes
        offset += result.bytesRead;
      }
    },

    flush(controller) {
      // If there is remaining data in the buffer, it is a truncated message
      if (offset < buffer.length) {
        controller.error(
          new DecodeError("UNEXPECTED_END", "Stream ended with incomplete message data", 0),
        );
      }
    },
  });
}

// ─── Data stream encode/decode (re-exported from data-streams.ts) ─────────────

export {
  encodeSubgroupStream,
  encodeDatagram,
  encodeFetchStream,
  decodeSubgroupStream,
  decodeDatagram,
  decodeFetchStream,
} from "./data-streams.js";

import {
  encodeSubgroupStream,
  encodeDatagram,
  encodeFetchStream,
  decodeSubgroupStream,
  decodeDatagram,
  decodeFetchStream,
} from "./data-streams.js";

// --- Factory ---

export interface Draft07Codec extends Codec {
  encodeSubgroupStream(stream: SubgroupStream): Uint8Array;
  decodeSubgroupStream(bytes: Uint8Array): DecodeResult<SubgroupStream>;
  encodeDatagram(dg: Draft07DatagramObject): Uint8Array;
  decodeDatagram(bytes: Uint8Array): DecodeResult<Draft07DatagramObject>;
  encodeFetchStream(stream: FetchStream): Uint8Array;
  decodeFetchStream(bytes: Uint8Array): DecodeResult<FetchStream>;
}

export function createDraft07Codec(): Draft07Codec {
  return {
    draft: "draft-ietf-moq-transport-07",
    encodeMessage: encodeMessageImpl,
    decodeMessage: decodeMessageImpl,
    encodeVarInt,
    decodeVarInt,
    createStreamDecoder: createStreamDecoderImpl,
    encodeSubgroupStream,
    decodeSubgroupStream,
    encodeDatagram,
    decodeDatagram,
    encodeFetchStream,
    decodeFetchStream,
  };
}

// Export data-stream decoder map for callers that need to disambiguate
export { dataStreamDecoders };
