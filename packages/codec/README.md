# @moqtap/codec

MoQT (Media over QUIC Transport) wire-format codec and session state machine for JavaScript/TypeScript.

- Multi-draft support (draft-07, draft-14)
- Stateless encode/decode of all MoQT control messages and data streams
- Protocol session state machine with FSM-based validation
- Zero runtime dependencies
- Works in Node.js, Bun, and browsers
- Full TypeScript types with discriminated unions

## Install

```bash
npm install @moqtap/codec
```

## Quick Start

MoQT is pre-RFC, so a draft version must always be specified. Use draft-scoped imports for the best experience:

```typescript
import { createDraft07Codec } from '@moqtap/codec/draft7';

const codec = createDraft07Codec();

// Decode a message from bytes
const result = codec.decodeMessage(bytes);
if (result.ok) {
  console.log(result.value.type); // e.g. 'subscribe'
}

// Encode a message to bytes
const encoded = codec.encodeMessage({
  type: 'client_setup',
  supportedVersions: [0xff000007n],
  parameters: new Map(),
});
```

Or use the factory if your application supports multiple drafts:

```typescript
import { createCodec } from '@moqtap/codec';

const codec = createCodec({ draft: '07' }); // or '14'
```

## Subpath Exports

| Import path | Description |
|---|---|
| `@moqtap/codec` | Factory + shared types (`createCodec({ draft })`) |
| `@moqtap/codec/draft7` | Draft-07 codec |
| `@moqtap/codec/draft14` | Draft-14 codec |
| `@moqtap/codec/session` | Session state machine factory |
| `@moqtap/codec/draft7/session` | Draft-07 session |
| `@moqtap/codec/draft14/session` | Draft-14 session |

> **Note:** A default (versionless) codec will be available once the MoQT specification reaches RFC status. Until then, always specify a draft version.

## Draft-Specific Imports

For applications targeting a single draft version:

```typescript
// Draft-07
import { createDraft07Codec } from '@moqtap/codec/draft7';
import { createDraft07SessionState } from '@moqtap/codec/draft7/session';

// Draft-14
import { createDraft14Codec } from '@moqtap/codec/draft14';
import { createDraft14SessionState } from '@moqtap/codec/draft14/session';
```

## Session State Machine

Validate protocol message sequences without transport coupling:

```typescript
import { createDraft07SessionState } from '@moqtap/codec/draft7/session';
import { createDraft07Codec } from '@moqtap/codec/draft7';

const codec = createDraft07Codec();
const session = createDraft07SessionState({ codec, role: 'client' });

const result = session.receive(incomingMessage);
if (!result.ok) {
  console.error('Protocol violation:', result.violation);
}
```

## License

MIT
