// Draft-07 data stream types
// Matches the API pattern of draft-08+ data stream types

export interface ObjectPayload {
  readonly type: "object";
  readonly objectId: bigint;
  readonly payloadLength: number;
  readonly status?: bigint;
  readonly payload: Uint8Array;
  readonly byteOffset: number;
  readonly payloadByteOffset: number;
}

export interface SubgroupStream {
  readonly type: "subgroup";
  readonly streamTypeId: 0x04;
  readonly trackAlias: bigint;
  readonly groupId: bigint;
  readonly subgroupId: bigint;
  readonly publisherPriority: number;
  readonly objects: ObjectPayload[];
}

export interface DatagramObject {
  readonly type: "datagram";
  readonly streamTypeId: 0x01;
  readonly trackAlias: bigint;
  readonly groupId: bigint;
  readonly objectId: bigint;
  readonly publisherPriority: number;
  readonly payloadLength: number;
  readonly status?: bigint;
  readonly payload: Uint8Array;
}

export interface FetchObjectPayload {
  readonly type: "object";
  readonly groupId: bigint;
  readonly subgroupId: bigint;
  readonly objectId: bigint;
  readonly publisherPriority: number;
  readonly payloadLength: number;
  readonly status?: bigint;
  readonly payload: Uint8Array;
  readonly byteOffset: number;
  readonly payloadByteOffset: number;
}

export interface FetchStream {
  readonly type: "fetch";
  readonly subscribeId: bigint;
  readonly objects: FetchObjectPayload[];
}

export type Draft07DataStream = SubgroupStream | DatagramObject | FetchStream;

// Streaming data stream decoder types
export interface SubgroupStreamHeader {
  readonly type: "subgroup_header";
  readonly trackAlias: bigint;
  readonly groupId: bigint;
  readonly subgroupId: bigint;
  readonly publisherPriority: number;
}

export interface FetchStreamHeader {
  readonly type: "fetch_header";
  readonly subscribeId: bigint;
}

export type DataStreamHeader = SubgroupStreamHeader | FetchStreamHeader;
export type DataStreamEvent = DataStreamHeader | ObjectPayload;
