# moqtap-js

JavaScript/TypeScript implementation of [MoQT (Media over QUIC Transport)](https://datatracker.ietf.org/doc/draft-ietf-moq-transport/), an IETF protocol for real-time media delivery over QUIC.

## Packages

| Package | Description |
|---|---|
| [`@moqtap/codec`](./packages/codec) | Wire-format codec and session state machine |
| [`@moqtap/trace`](./packages/trace) | Session recorder and `.moqtrace` binary format |

## Features

- **Multi-draft support** — draft-07 and draft-14
- **Stateless codec** — encode/decode all MoQT control messages and data stream headers
- **Session state machine** — FSM-based protocol validation
- **Trace recording** — capture sessions with configurable detail levels
- **Cross-runtime** — works in Node.js, Bun, Deno, and browsers
- **Zero dependencies** — codec has no runtime dependencies

## Quick Start

```bash
npm install @moqtap/codec
```

```typescript
import { createDraft14Codec } from '@moqtap/codec/draft14';

const codec = createDraft14Codec();

// Decode
const result = codec.decodeMessage(bytes);
if (result.ok) {
  console.log(result.value.type);
}

// Encode
const encoded = codec.encodeMessage({
  type: 'client_setup',
  supportedVersions: [0xff00000en],
  parameters: new Map(),
});
```

See each package's README for full API documentation.

## Development

This is a [Bun](https://bun.sh) workspaces monorepo.

```bash
bun install          # install dependencies
bun run build        # build all packages
bun run test         # run tests
bun run lint         # check formatting and lint rules
bun run typecheck    # type-check all packages
```

## License

MIT
