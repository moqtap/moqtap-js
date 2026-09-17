# @moqtap/trace

Record, serialize and analyze MoQT (Media over QUIC Transport) sessions as
`.moqtrace` files — a compact, streamable CBOR format that reads the same across
implementations. Includes a recorder that wraps `@moqtap/codec` session state
machines, streaming read and write, and a lossy JSON export for debugging.

## Install

```bash
npm install @moqtap/trace @moqtap/codec
```

`@moqtap/codec` is a peer dependency — install it alongside.

## Quick Start

Wrap a codec session state machine, then serialize what it recorded:

```typescript
import { createRecorder, writeMoqtrace } from '@moqtap/trace'
import { MESSAGE_ID_MAP } from '@moqtap/codec/draft21'
import { createDraft21SessionState } from '@moqtap/codec/draft21/session'

const recorder = createRecorder({
  protocol: 'moqt-21',
  perspective: 'client',
  detail: 'control',
  messageTypeId: (name) => Number(MESSAGE_ID_MAP.get(name) ?? 0),
})

// Every send/receive on the wrapper is recorded.
const traced = recorder.wrapSession(createDraft21SessionState('client'))
traced.send(setupMessage)
traced.receive(setupMessage)

// Events the session layer never sees.
recorder.recordStreamOpened(4n, 0, 0)
recorder.annotate('connected', { relay: 'cdn.example.com' })

const bytes = writeMoqtrace(recorder.finalize()) // Uint8Array
```

Read one back:

```typescript
import { readMoqtrace, readMoqtraceHeader } from '@moqtap/trace'

const header = readMoqtraceHeader(bytes) // metadata only, no event parsing
console.log(header.protocol, header.perspective, header.detail)

const trace = readMoqtrace(bytes)
for (const event of trace.events) {
  console.log(event.type, event.timestamp)
}
```

## API

| Function                                             | Purpose                                                      |
| ---------------------------------------------------- | ------------------------------------------------------------ |
| `createRecorder(options)`                            | Session recorder; wraps a codec session state machine         |
| `writeMoqtrace(trace)`                               | Serialize a complete trace to bytes                           |
| `readMoqtrace(bytes)`                                | Parse a complete file, flattening every segment in order      |
| `readMoqtraceHeader(bytes)`                          | Parse the header only                                         |
| `createMoqtraceWriter(header)`                       | Streaming writer: `preamble()`, then `writeEvent()` per event  |
| `createMoqtraceReader()`                             | Incremental reader for a stream arriving in chunks             |
| `writeMoqtraceSegments()` / `readMoqtraceSegments()` | Segmented traces, for rotation, live carriage and recovery    |
| `traceToJSON(trace)`                                 | Human-readable export; lossy, as bigints and bytes stringify   |

`createRecorder` requires `protocol`, `perspective` and `detail`. Pass
`messageTypeId` to map a message name to its wire id, which session-layer
recording needs; `maxEvents` bounds the event buffer.

Beyond `wrapSession`, the recorder takes events the session layer cannot see:
`recordStreamOpened`, `recordStreamClosed`, `recordObjectHeader`,
`recordObjectPayload`, `recordError` and `annotate`. `finalize()` returns the
trace and stops recording.

## Detail levels

| Level           | What is recorded                       |
| --------------- | -------------------------------------- |
| `control`       | Control messages only                  |
| `headers`       | + data stream and object headers       |
| `headers+sizes` | + payload byte lengths                 |
| `headers+data`  | + full payload bytes                   |
| `full`          | + raw wire bytes, pre-decode           |

Errors and annotations are recorded at every level. `headers+data` and `full`,
and the `raw` field on any event, carry user content, so capturing them should
be an explicit choice rather than a default.

When recording an error, hand `recordError` the full bytes: it applies
`MAX_ERROR_RAW_BYTES` itself and reports the untruncated length separately, so a
caller that pre-truncates destroys the signal saying the capture is partial.

## Reading a trace you did not write

Nothing is rejected for carrying something newer than this version knows. An
unrecognised event type arrives as an `UnknownEvent` with its fields intact, and
an unrecognised key is preserved verbatim in an `extra` map beside the fields, so
neither is dropped by a read-modify-write round trip.

A file that stops part-way through an event throws `TruncatedTraceError`, which
carries everything that decoded before the cut. On a segmented trace,
`readMoqtraceSegments(bytes, { recover: true })` skips a damaged region and
resumes at the next segment instead of throwing.

## File format

[SPEC.md](./SPEC.md) is the complete `.moqtrace` binary specification.

## Documentation

<https://moqtap.com/npm-packages/moqtap-trace/>

## License

MIT
