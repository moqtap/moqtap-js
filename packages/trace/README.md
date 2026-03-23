# @moqtap/trace

Record, serialize, and analyze MoQT (Media over QUIC Transport) sessions using the `.moqtrace` binary format.

- Binary `.moqtrace` format with CBOR encoding (compact, streamable, cross-language)
- Configurable detail levels from control-only to full wire captures
- Session recorder that wraps `@moqtap/codec` session state machines
- Human-readable JSON export for debugging
- Zero-copy streaming writer for large traces

## Install

```bash
npm install @moqtap/trace @moqtap/codec
```

`@moqtap/codec` is a peer dependency — install it alongside `@moqtap/trace`.

## Quick Start

### Recording a session

```typescript
import { createRecorder, writeMoqtrace } from '@moqtap/trace';
import { createDraft17SessionState } from '@moqtap/codec/draft17/session';

const recorder = createRecorder({
  protocol: 'moq-transport-17',
  perspective: 'client',
  detail: 'control',
});

// Wrap a session to auto-capture control messages and state transitions
const session = createDraft17SessionState({ codec: { draft: 'draft-ietf-moq-transport-17' }, role: 'client' });
const traced = recorder.wrapSession(session);

// Use `traced` instead of `session` — all send/receive calls are recorded
traced.send(setupMessage);
traced.receive(setupMessage);

// Manually record events the session layer doesn't see
recorder.recordStreamOpened(4n, 0, 0); // outgoing subgroup stream
recorder.annotate('connected', { relay: 'cdn.example.com' });

// Finalize and serialize
const trace = recorder.finalize();
const bytes = writeMoqtrace(trace); // → Uint8Array (.moqtrace binary)
```

### Reading a trace file

```typescript
import { readMoqtrace, readMoqtraceHeader } from '@moqtap/trace';

// Quick metadata peek (no event parsing)
const header = readMoqtraceHeader(bytes);
console.log(header.protocol);   // "moq-transport-17"
console.log(header.perspective); // "client"
console.log(header.detail);     // "control"

// Full parse
const trace = readMoqtrace(bytes);
for (const event of trace.events) {
  console.log(event.type, event.timestamp);
}
```

### Streaming writer (for large traces)

```typescript
import { createMoqtraceWriter } from '@moqtap/trace';

const writer = createMoqtraceWriter(header);
outputStream.write(writer.preamble());

for (const event of events) {
  outputStream.write(writer.writeEvent(event));
}
```

## Detail Levels

| Level | What's recorded |
|---|---|
| `control` | Control messages only (setup, subscribe, publish, goaway) |
| `headers` | + data stream headers (subgroup/fetch, object metadata) |
| `headers+sizes` | + payload byte lengths |
| `headers+data` | + full payload bytes |
| `full` | + raw wire bytes (pre-decode) |

## JSON Export

For human-readable debugging (not lossless — bigint/Uint8Array become strings):

```typescript
import { traceToJSON } from '@moqtap/trace';

const json = traceToJSON(trace);
console.log(json);
```

## File Format

See [SPEC.md](./SPEC.md) for the complete `.moqtrace` binary format specification.

## License

MIT
