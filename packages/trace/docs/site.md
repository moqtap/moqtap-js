---
title: "@moqtap/trace"
description: Read, write, and record .moqtrace session files in TypeScript.
version: 0.5.0
---

**Read, write, and record MoQT session traces.**

[npm](https://www.npmjs.com/package/@moqtap/trace) | [GitHub](https://github.com/moqtap/moqtap-js/tree/master/packages/trace)

## What it does

`@moqtap/trace` implements the [.moqtrace binary format](/concepts/trace-format/) for JavaScript/TypeScript. It provides:

- One-shot, segmented and incremental read/write of `.moqtrace` files
- A recorder that wraps `@moqtap/codec` sessions and auto-captures events
- Detail-level filtering (control only through full wire bytes)
- JSON serialization for inspection and debugging

Peer dependency on `@moqtap/codec` (0.11.0 or later). Uses `cbor-x` for CBOR encoding.

## Installation

```bash
npm install @moqtap/trace @moqtap/codec
```

## Reading traces

```typescript
import { controlMessageFields, readMoqtrace, readMoqtraceHeader } from '@moqtap/trace';

// Full read — header + all events
const trace = readMoqtrace(bytes);
console.log(trace.header.protocol);    // 'moq-transport-14'
console.log(trace.events.length);      // number of events

// Header-only read — fast metadata extraction
const header = readMoqtraceHeader(bytes);
console.log(header.perspective);       // 'client'
console.log(header.detail);            // 'control'

// Control message fields
for (const event of trace.events) {
  if (event.type === 'control') {
    const fields = controlMessageFields(event.message);
    console.log(fields?.request_id);
  }
}
```

A control event's `message` is typed `unknown`. It is normally a map of the message's fields in snake_case, but traces from other tools can carry other values. `controlMessageFields(message)` returns the field map, or `undefined` when the message is not a map.

### Segmented traces

A segmented trace is several header-plus-events segments back to back, as written by a recorder that rotates or streams live. `readMoqtrace` flattens one: the header is the first segment's, and every segment's events follow in order. `readMoqtraceSegments` returns one `Trace` per segment, each with `header.segment` set. A file that is not segmented reads as one entry with no `segment`. `seq` and `timestamp` restart in each segment, so order events across segments by `(segment.sequence, seq)`.

```typescript
import { readMoqtraceSegments } from '@moqtap/trace';

const segments = readMoqtraceSegments(bytes, {
  recover: true,
  onRecovered: (region) => console.warn(region.kind, region.offset, region.resumedAt),
});
```

With `recover`, a damaged segment is skipped and the read resumes at the next one instead of throwing. `onRecovered` is called once per skipped region. `region.kind` is `header` (the whole segment was dropped), `event` (the segment was cut short) or `truncated` (the file ended mid-item). `region.resumedAt` is `undefined` when no further segment followed.

### Reading a stream in chunks

`createMoqtraceReader()` reads a trace that arrives in pieces, such as a download or a live capture:

```typescript
import { createMoqtraceReader } from '@moqtap/trace';

const reader = createMoqtraceReader();
for await (const chunk of stream) {
  for (const item of reader.push(chunk)) {
    if (item.kind === 'segment') console.log(item.header.protocol);
    if (item.kind === 'event') render(item.event);
  }
}
for (const item of reader.end()) {
  if (item.kind === 'event') render(item.event);
}
```

`push` returns the items each chunk completed and keeps the rest. A `segment` item arrives before the events that belong to it. `end()` returns any last item, and throws `TruncatedStreamError` when the bytes left over do not form a whole item. The reader has no `recover` option: it stops at damage.

### Errors

| Error | Thrown by | When |
|---|---|---|
| `TruncatedTraceError` | `readMoqtrace`, `readMoqtraceSegments` | The file stops part-way through an item. `offset` is where the incomplete item begins; `segments` and `trace` hold everything decoded before the cut. |
| `MalformedHeaderError` | The readers and writers | A header has no usable value for `protocol`, `perspective`, `detail`, `startTime` or `segment.sequence`. `key` names the key. With `recover`, `readMoqtrace` and `readMoqtraceSegments` skip that segment instead. |
| `TruncatedStreamError` | `createMoqtraceReader().end()` | The stream stops part-way through an item. `offset` is where the item begins; `events` counts the events already returned. |

Nothing else in a header fails the read. An optional value of the wrong type is kept in `extra` (below) and its field reads as absent. The writers throw `MalformedHeaderError` when `startTime` or `segment.sequence` is negative, fractional or above `Number.MAX_SAFE_INTEGER`.

### Keys this version does not know

A trace can carry keys and event types newer than this package. They are kept and written back unchanged:

- An event type this version does not know reads as an `UnknownEvent` (`type: 'unknown'`), with its numeric `eventType` and its other keys in `fields`.
- An unknown key on a known event is kept in that event's `extra`.
- An unknown key in the header, in `header.segment` or in `header.sampling` is kept in that object's `extra`.
- A known key whose value has the wrong type is kept in `extra` the same way.

## Writing traces

```typescript
import { writeMoqtrace, writeMoqtraceSegments, createMoqtraceWriter } from '@moqtap/trace';

// One-shot — serialize a complete trace to bytes
const bytes = writeMoqtrace({ header, events });

// Segmented — every segment header must carry `segment`
const segmented = writeMoqtraceSegments([segment0, segment1]);

// Streaming — write incrementally as events arrive
const writer = createMoqtraceWriter(header);
const preamble = writer.preamble();   // magic + version + header
const chunk1 = writer.writeEvent(event1);
const chunk2 = writer.writeEvent(event2);
// Concatenate preamble + chunks to get the complete file

// Start the next segment; the header must carry `segment`
const nextPreamble = writer.startSegment(nextHeader);
```

`writeMoqtraceSegments` and `startSegment` throw when a header has no `segment`. Keep `protocol`, `perspective`, `detail` and `sessionId` the same in every segment, and increment `segment.sequence`.

## Recording sessions

The recorder wraps a `SessionState` from `@moqtap/codec` and auto-captures control messages, state transitions, and data events filtered by detail level.

```typescript
import { createRecorder, writeMoqtrace } from '@moqtap/trace';
import { createSessionState } from '@moqtap/codec/session';
import { MESSAGE_ID_MAP } from '@moqtap/codec/draft14';

const recorder = createRecorder({
  detail: 'headers',
  protocol: 'moq-transport-14',
  perspective: 'client',
  source: 'my-app/1.0.0',
  endpoint: 'https://relay.example.com/moq',
  messageTypeId: (name) => Number(MESSAGE_ID_MAP.get(name) ?? 0),
});

// messageTypeId resolves message names to wire type IDs for control events.
// The recorder is draft-agnostic — you bring your own mapping.
// Defaults to () => 0 if omitted.

// Wrap a session — receive/send calls are auto-recorded
const session = createSessionState({ codec: { draft: '14' }, role: 'client' });
const traced = recorder.wrapSession(session);

// Use the wrapped session normally
traced.send(clientSetup);
traced.receive(serverSetup);
// State changes and control messages are captured automatically

// Record data events manually
recorder.recordStreamOpened(3n, 1, 0);       // incoming subgroup stream
// …or with what its header said, and the header's bytes
recorder.recordStreamOpened(7n, 1, 0, { trackAlias: 2n, subgroupId: 0n, headerRaw: headerBytes });
recorder.recordObjectHeader(3n, 1n, 0n, 128, 0);
// …or with the object's property block, as the wire carried it
recorder.recordObjectHeader(3n, 1n, 1n, 128, 0, propertyBlock);
recorder.recordObjectPayload(3n, 1n, 0n, 256);
recorder.recordStreamClosed(3n, 0);

// Record an error, with the bytes behind it
recorder.recordError(0x3, 'malformed SUBGROUP_HEADER', {
  streamId: 3n,
  errorKind: 'decode',
  raw: offendingBytes,
});

// Add custom annotations
recorder.annotate('user-action', { clicked: 'subscribe' });

// Finalize and export
const trace = recorder.finalize();
const bytes = writeMoqtrace(trace);
```

`createRecorder` requires `protocol`, `perspective` and `detail`, and throws on a detail level it does not know. Optional settings: `transport`, `source`, `endpoint`, `sessionId`, `maxEvents`, `messageTypeId`, `clock` (microseconds for event timestamps) and `extra` (header keys of your own, written to the header; use an `x-` prefix).

`recordError(errorCode, reason, details?)` takes `streamId`, `errorKind` (`'protocol'`, `'transport'`, `'decode'` or any other string), `raw` and `rawLength`. Pass all the bytes you hold in `raw`: the recorder keeps the first `MAX_ERROR_RAW_BYTES` (4096) and writes the full length as `rawLength`. Bytes are kept for the first error on each stream, and for the first error with no stream; later errors are recorded without them. Pass `rawLength: null` when the true length is unknown.

`recordStreamOpened(streamId, direction, streamType, header?)` takes `trackAlias`, `subgroupId` (subgroup streams), `fetchRequestId` (fetch streams), `groupId` (datagrams) and `headerRaw`, the header's bytes from the stream type through its last field. A field on the wrong stream type is not recorded.

`record(event)` adds an event you built yourself, with no detail-level filtering. `finalize()` stops recording and returns the trace; `recording` says whether the recorder still accepts events.

### Detail-level filtering

The recorder automatically filters events based on the configured detail level:

| Detail level | Control messages | Stream/object headers | Payload sizes | Payload bytes | Error bytes (`raw`) |
|---|---|---|---|---|---|
| `control` | Yes | — | — | — | — |
| `headers` | Yes | Yes | — | — | — |
| `headers+sizes` | Yes | Yes | Yes | — | — |
| `headers+data` | Yes | Yes | Yes | Yes | — |
| `full` | Yes | Yes | Yes | Yes | Yes |

Errors and annotations are always recorded regardless of detail level. An error's `rawLength` is recorded from `headers+sizes`.

### Event buffer

The recorder keeps at most 100,000 events by default. When the limit is reached, the oldest events are dropped. Sequence numbers keep increasing; they are not reset when events are dropped.

```typescript
const recorder = createRecorder({
  // ...
  maxEvents: 50_000,    // custom buffer size
});
```

When events were dropped, the finalized header carries `sampling: { dropPolicy: 'head', droppedTotal }`, with `droppedTotal` the number of events dropped. A trace with no `sampling` lost no events.

## JSON export

For inspection and debugging, traces can be converted to JSON. Note that this is lossy — `bigint` values become hex strings and `Uint8Array` values become hex strings. The `extra` stores are included.

```typescript
import { traceToJSON } from '@moqtap/trace';

const json = traceToJSON(trace);   // pretty-printed JSON string
```

## API reference

### Functions

| Function | Description |
|----------|-------------|
| `readMoqtrace(bytes, options?)` | Parse a complete `.moqtrace` file into a `Trace`, flattening segments |
| `readMoqtraceSegments(bytes, options?)` | Parse a file into one `Trace` per segment |
| `readMoqtraceHeader(bytes)` | Parse only the header (skip events); the first segment's in a segmented file |
| `createMoqtraceReader()` | Create an incremental reader: `push(chunk)`, then `end()` |
| `writeMoqtrace(trace)` | Serialize a `Trace` to `.moqtrace` bytes |
| `writeMoqtraceSegments(traces)` | Serialize several segments as one segmented file |
| `createMoqtraceWriter(header)` | Create a streaming writer: `preamble()`, `writeEvent(event)`, `startSegment(header)` |
| `createRecorder(options)` | Create a session recorder |
| `controlMessageFields(message)` | A control event's field map, or `undefined` |
| `traceToJSON(trace)` | Serialize to JSON (lossy) |

`options` for the readers: `recover` and `onRecovered`.

### Constants and errors

| Export | Description |
|---|---|
| `FORMAT_VERSION` | The format version this package writes (`2`) |
| `SUPPORTED_VERSIONS` | The format versions it reads (`[1, 2]`) |
| `MAX_ERROR_RAW_BYTES` | The most error bytes the recorder keeps (`4096`) |
| `TRACE_ID_LENGTH` | Length of a subscription-derivation trace ID, in bytes (`16`) |
| `TruncatedTraceError`, `MalformedHeaderError`, `TruncatedStreamError` | See [Errors](#errors) |

### Event types

Events use a discriminated union on the `type` field:

| Type | Description |
|------|-------------|
| `control` | Control message sent or received |
| `stream-opened` | QUIC stream opened; optional `trackAlias`, `subgroupId`, `fetchRequestId`, `groupId`, `headerRaw` |
| `stream-closed` | QUIC stream closed |
| `object-header` | Object metadata parsed from data stream |
| `object-payload` | Object payload size, and bytes at `headers+data` and above |
| `state-change` | Session FSM phase transition |
| `error` | Protocol or transport error; optional `streamId`, `errorKind`, `rawLength`, `raw` |
| `annotation` | User-defined event |
| `peer-connected` | A peer session started (relay taps) |
| `peer-disconnected` | A peer session ended (relay taps) |
| `subscription-derivation` | An upstream subscription serving downstream ones (relay taps) |
| `unknown` | An event type this version does not know |

Every event has `seq` and `timestamp` (microseconds since the segment's `startTime`). Relay-tap traces also set `peer`.

See [.moqtrace File Format](/concepts/trace-format/) for the complete binary specification.
