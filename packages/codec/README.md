# @moqtap/codec

MoQT (Media over QUIC Transport) wire-format codec and session state machine for JavaScript/TypeScript.

- Multi-draft support (drafts 07 through 17)
- Stateless encode/decode of all MoQT control messages and data streams
- Protocol session state machine with FSM-based validation per draft
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

const codec = createCodec({ draft: '17' }); // '07' through '17'
```

## Subpath Exports

Each draft is available as a subpath import with its own codec and session state machine:

| Import path | Description |
|---|---|
| `@moqtap/codec` | Factory + shared types (`createCodec({ draft })`) |
| `@moqtap/codec/draft7` | Draft-07 codec |
| `@moqtap/codec/draft8` | Draft-08 codec |
| `@moqtap/codec/draft9` | Draft-09 codec |
| `@moqtap/codec/draft10` | Draft-10 codec |
| `@moqtap/codec/draft11` | Draft-11 codec |
| `@moqtap/codec/draft12` | Draft-12 codec |
| `@moqtap/codec/draft13` | Draft-13 codec |
| `@moqtap/codec/draft14` | Draft-14 codec |
| `@moqtap/codec/draft15` | Draft-15 codec |
| `@moqtap/codec/draft16` | Draft-16 codec |
| `@moqtap/codec/draft17` | Draft-17 codec |
| `@moqtap/codec/draft{N}/session` | Session state machine for draft N |

> **Note:** A default (versionless) codec will be available once the MoQT specification reaches RFC status. Until then, always specify a draft version.

## Draft-Specific Imports

For applications targeting a single draft version:

```typescript
import { createDraft17Codec } from '@moqtap/codec/draft17';
import { createDraft17SessionState } from '@moqtap/codec/draft17/session';
```

## Session State Machine

Validate protocol message sequences without transport coupling:

```typescript
import { createDraft17SessionState } from '@moqtap/codec/draft17/session';
import { createDraft17Codec } from '@moqtap/codec/draft17';

const codec = createDraft17Codec();
const session = createDraft17SessionState({ codec, role: 'client' });

const result = session.receive(incomingMessage);
if (!result.ok) {
  console.error('Protocol violation:', result.violation);
}
```

## License

MIT
