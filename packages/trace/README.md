# @moqtap/trace

Record, serialize, and analyze MoQT (Media over QUIC Transport) sessions using the `.moqtrace` binary format.

- Binary `.moqtrace` format with CBOR encoding (compact, streamable, cross-language)
- Segmented traces for capture rotation, live carriage, and recovery from a damaged region
- Configurable detail levels from control-only to full wire captures
- Session recorder that wraps `@moqtap/codec` session state machines
- Human-readable JSON export for debugging
- Zero-copy streaming writer, and an incremental reader for a stream that
  arrives in chunks
- Unrecognised keys, event types and enum values preserved through a
  read-modify-write

Writes format version 2 and reads versions 1 and 2.

## Install

```bash
npm install @moqtap/trace @moqtap/codec
```

`@moqtap/codec` is a peer dependency — install it alongside `@moqtap/trace`.

## Quick Start

### Recording a session

```typescript
import { createRecorder, writeMoqtrace } from '@moqtap/trace'
import { createDraft17SessionState } from '@moqtap/codec/draft17/session'

const recorder = createRecorder({
  protocol: 'moq-transport-17',
  perspective: 'client',
  detail: 'control',
})

// Wrap a session to auto-capture control messages and state transitions
const session = createDraft17SessionState('client')
const traced = recorder.wrapSession(session)

// Use `traced` instead of `session` — all send/receive calls are recorded
traced.send(setupMessage)
traced.receive(setupMessage)

// Manually record events the session layer doesn't see
recorder.recordStreamOpened(4n, 0, 0) // outgoing subgroup stream
recorder.annotate('connected', { relay: 'cdn.example.com' })

// Finalize and serialize
const trace = recorder.finalize()
const bytes = writeMoqtrace(trace) // → Uint8Array (.moqtrace binary)
```

### Recording an error with the bytes behind it

A report saying "your SUBSCRIBE_OK did not parse" is an assertion. The same
report carrying the bytes is evidence the other party can run against their own
encoder.

```typescript
recorder.recordError(0, 'SUBSCRIBE_OK did not parse', {
  streamId: 4n,
  errorKind: 'decode', // 'protocol' | 'transport' | 'decode' | any other string
  raw: offendingBytes, // hand over everything held, untruncated
})
```

Hand `raw` the full bytes. The recorder applies `MAX_ERROR_RAW_BYTES` (4096)
itself and reports the untruncated length separately, so a caller that
pre-truncates destroys the one signal saying the capture is partial. `rawLength`
is recorded from `'headers+sizes'` and `raw` only at `'full'`, and the bytes are
written once per flow.

### Reading a trace file

```typescript
import { readMoqtrace, readMoqtraceHeader } from '@moqtap/trace'

// Quick metadata peek (no event parsing)
const header = readMoqtraceHeader(bytes)
console.log(header.protocol) // "moq-transport-17"
console.log(header.perspective) // "client"
console.log(header.detail) // "control"

// Full parse
const trace = readMoqtrace(bytes)
for (const event of trace.events) {
  console.log(event.type, event.timestamp)
}
```

### Streaming writer (for large traces)

```typescript
import { createMoqtraceWriter } from '@moqtap/trace'

const writer = createMoqtraceWriter(header)
outputStream.write(writer.preamble())

for (const event of events) {
  outputStream.write(writer.writeEvent(event))
}
```

### Streaming reader (for a stream that arrives in chunks)

`readMoqtrace` and the functions beside it take a finished file. A live capture
does not have one: chunk boundaries fall wherever the transport put them,
almost never on an item boundary.

```typescript
import { createMoqtraceReader, TruncatedStreamError } from '@moqtap/trace'

const reader = createMoqtraceReader()

for await (const chunk of incoming) {
  // Returns whatever the chunk completed — often nothing, which is ordinary.
  for (const item of reader.push(chunk)) {
    if (item.kind === 'segment') console.log('segment', item.header.sessionId)
    else console.log(item.event.type, item.event.timestamp)
  }
}

// `end()` can still yield items, and throws if bytes are left over that do not
// form a whole one.
try {
  for (const item of reader.end()) console.log(item.kind)
} catch (error) {
  if (error instanceof TruncatedStreamError) console.warn('stream cut mid-item')
}
```

### Segmented traces

A segment is a complete `.moqtrace` blob — magic, version, header, events —
appended after the one before it, so a reader can start at any segment without
the ones preceding it. That buys capture rotation without finalizing a file, a
natural cut point for live carriage, and recovery from a damaged region.

```typescript
import { readMoqtraceSegments, writeMoqtraceSegments } from '@moqtap/trace'

// Each segment header must carry `segment` metadata: it is what tells a reader
// that `seq` and `timestamp` restart at zero in every segment.
const bytes = writeMoqtraceSegments([
  { header: { ...header, segment: { sequence: 0 } }, events: firstBatch },
  { header: { ...header, segment: { sequence: 1, continues: true } }, events: secondBatch },
])

// Read the boundaries — you need them to order events across segments.
for (const segment of readMoqtraceSegments(bytes)) {
  console.log(segment.header.segment?.sequence, segment.events.length)
}

// Or ignore them: readMoqtrace flattens every segment's events in order.
```

### Damaged and truncated files

A file that stops part-way through an event throws `TruncatedTraceError`, which
carries everything that decoded before the cut — a truncated trace is still
evidence. On a segmented trace, `{ recover: true }` skips a damaged region and
resumes at the next segment instead of throwing; pass `onRecovered` alongside
it to be told what that cost, since the return value cannot say.

```typescript
import { readMoqtrace, readMoqtraceSegments, TruncatedTraceError } from '@moqtap/trace'

try {
  const trace = readMoqtrace(bytes)
} catch (error) {
  if (error instanceof TruncatedTraceError) {
    console.warn(`truncated at byte ${error.offset}`)
    const survived = error.segments.reduce((n, segment) => n + segment.events.length, 0)
    console.log(survived, 'events survived')
  }
}

const whatSurvived = readMoqtraceSegments(bytes, {
  recover: true,
  onRecovered: ({ offset, kind, resumedAt }) => {
    console.warn(
      resumedAt == null
        ? `${kind} damage at ${offset}: nothing readable followed, rest discarded`
        : `${kind} damage at ${offset}, resumed at ${resumedAt}`,
    )
  },
})
```

## Reading a trace you did not write

Nothing here rejects a file for carrying something newer than this version
knows. An unrecognised event type arrives as an `UnknownEvent` with its fields
intact, so it survives a read-modify-write round trip rather than being dropped
or relabelled; an unrecognised perspective, detail level, role, side, drop
policy or derivation kind is kept verbatim.

Keys are kept on the same terms. One this version does not recognise — on the
header, on `segment`, on `sampling`, or on any event — is preserved verbatim in
an `extra` map beside the fields and written back unchanged. Ignoring a key is
permitted; dropping one is not, or a redaction pass, a filter or an annotated
download emits a file that looks as though it never carried the key.

The one place that refuses is `createRecorder`, which cannot honour a detail
level it does not implement: it would either capture less than you asked for
while writing a header claiming otherwise, or — for the payload-bearing levels
— capture more.

## Detail Levels

| Level           | What's recorded                                           |
| --------------- | --------------------------------------------------------- |
| `control`       | Control messages only (setup, subscribe, publish, goaway) |
| `headers`       | + data stream headers (subgroup/fetch, object metadata)   |
| `headers+sizes` | + payload byte lengths                                    |
| `headers+data`  | + full payload bytes                                      |
| `full`          | + raw wire bytes (pre-decode)                             |

`headers+data` and `full`, and the `raw` field on any event, carry user
content. Capturing them is optional for a conformant recorder and should be an
explicit choice, not a default.

## JSON Export

For human-readable debugging (not lossless — bigint/Uint8Array become strings):

```typescript
import { traceToJSON } from '@moqtap/trace'

const json = traceToJSON(trace)
console.log(json)
```

## Upgrading

### To 0.4.0 (from 0.3.0)

Two changes to what a reader accepts:

- `ControlMessageEvent.message` is `unknown` rather than
  `Record<string, unknown>`, so anything reading a key straight off it stops
  compiling. Narrow with `controlMessageFields()` first. The old type was a
  claim the runtime did not keep — every real capture carries a text rendering
  there, so `event.message.request_id` typechecked and read `undefined`.
- A header with no usable value for a required key throws
  `MalformedHeaderError` instead of returning a header with `undefined`, `NaN`
  or `0` standing in for it. Pass `recover` to skip that segment instead. No
  file either implementation writes is affected.

Everything else is additive: `extra` on the header and its two sub-maps, the
stream-header identifiers on Event 1, the error fields on Event 6, and
`createMoqtraceReader`.

### To 0.3.0 (from 0.2.0)

The package now writes format version 2. A 0.2.0 reader rejects those files at
byte 8, which is the point of the bump: it turns what would have been silent
desynchronization on a segmented trace into a clear refusal. Reading is
unaffected in the other direction — 0.3.0 reads everything 0.2.0 wrote.

What changes for code already using it:

- `TraceEvent` gained four members (`peer-connected`, `peer-disconnected`,
  `subscription-derivation`, `unknown`). A `switch` that handles only the
  cases it cares about is unaffected; one that asserts exhaustiveness is not.
- `Perspective`, `DetailLevel` and the new string unions accept values they do
  not name, so indexing a `Record<DetailLevel, T>` with one now yields
  `T | undefined`.
- An unknown event type used to arrive as an annotation labelled
  `unknown-event-<n>`. It now arrives as an `UnknownEvent` carrying its real
  type and fields, so code matching that label should match `type === 'unknown'`
  instead. The old shape was lossy in a way that mattered: writing the trace
  back rewrote the event's type to 7.
- `createRecorder` throws on a detail level it does not implement, which the
  types previously made unexpressible.
- The bytes changed in two ways that make files readable by the Rust
  implementation for the first time: an integral value past 32 bits is now
  written as a CBOR integer rather than a float64, and a byte string as major
  type 2 rather than wrapped in the typed-array tag 64. Both readers accept
  either form, so nothing already written becomes unreadable.

## File Format

See [SPEC.md](./SPEC.md) for the complete `.moqtrace` binary format specification.

## License

MIT
