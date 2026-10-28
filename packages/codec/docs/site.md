---
title: "@moqtap/codec"
description: MoQT wire-format codec and session state machine for TypeScript.
version: 0.14.0
---

**Encode, decode, and validate MoQT messages in JavaScript/TypeScript.**

[npm](https://www.npmjs.com/package/@moqtap/codec) | [GitHub](https://github.com/moqtap/moqtap-js/tree/master/packages/codec)

## What it does

`@moqtap/codec` is a complete MoQT protocol library with two layers:

1. **Codec** — stateless encode/decode of all control messages and data streams
2. **Session FSM** — protocol state machine that validates message ordering, tracks subscriptions, publishes and fetches, and emits side effects

Supports **drafts 07 through 22** of MoQ Transport. Zero runtime dependencies. Works in Node.js, Bun, Deno, and browsers.

## Installation

```bash
npm install @moqtap/codec
```

## Quick start

MoQT is not yet an RFC, so the draft is always explicit:

```typescript
import { createCodec } from '@moqtap/codec';

const codec = createCodec({ draft: '22' }); // '07' through '22'

// Encode a message to wire bytes
const bytes = codec.encodeMessage({
  type: 'subscribe',
  request_id: 0n,
  track_namespace: ['live'],
  track_name: 'video',
  parameters: {},
});

// Decode wire bytes back to a typed message
const result = codec.decodeMessage(bytes);
if (result.ok) {
  console.log(result.value.type); // 'subscribe'
} else {
  console.error(result.error.code); // e.g. 'UNEXPECTED_END'
}
```

Message fields use snake_case, as in the draft text. Each draft has its own message types, so a message's shape depends on the draft you pick.

## Entry points

| Import path | Contents |
|---|---|
| `@moqtap/codec` | `createCodec({ draft })`, `DRAFT_VERSIONS`, cross-draft accessors, shared types |
| `@moqtap/codec/session` | `createSessionState({ codec: { draft }, role })` |
| `@moqtap/codec/draft07` … `/draft22` | One draft's codec, message types, constants and error-code registries |
| `@moqtap/codec/draft07/session` … `/draft22/session` | One draft's session state machine |

A draft entry point gives the tightest types and pulls in only that draft:

```typescript
// Draft-22
import {
  createDraft22Codec,
  encodeMessage,
  decodeMessage,
  createStreamDecoder,
  PROTOCOL_STRING, // 'moqt-22'
} from '@moqtap/codec/draft22';

// Draft-14
import {
  createDraft14Codec,
  encodeMessage,
  decodeMessage,
  createStreamDecoder,
  MESSAGE_ID_MAP,
} from '@moqtap/codec/draft14';
```

Every draft entry point exports `createDraft{NN}Codec()`, `encodeMessage`, `decodeMessage`, `createStreamDecoder`, `redactAuthTokens`, `DRAFT_VERSION`, `MESSAGE_ID_MAP` and `MESSAGE_TYPE_MAP`, its message types and its error-code registries.

## Draft versions

Through draft-14 the version is negotiated in CLIENT_SETUP and SERVER_SETUP, and `0xff0000NN` travels on the wire. Those are `DRAFT_VERSIONS['07']` through `DRAFT_VERSIONS['14']`. From draft-15 the version is negotiated by ALPN or `WT-Available-Protocols` as the string `moqt-NN`, and no version number is sent. The entries above `'14'` are identifiers only, not values a peer sends. Drafts 20 to 22 export the protocol string as `PROTOCOL_STRING`.

## Codec API

### Control messages

```typescript
const codec = createDraft14Codec();

// Single message
const bytes = codec.encodeMessage(message);
const result = codec.decodeMessage(bytes); // { ok: true, value, bytesRead } or { ok: false, error }

// Streaming decoder for incremental parsing
const decoder = codec.createStreamDecoder();
// TransformStream<Uint8Array, Draft14Message>
```

### Data streams

```typescript
// Subgroup streams
codec.encodeSubgroupStream(stream);
codec.decodeSubgroupStream(bytes);

// Datagrams
codec.encodeDatagram(obj);
codec.decodeDatagram(bytes);

// Fetch streams
codec.encodeFetchStream(stream);
codec.decodeFetchStream(bytes);

// Streaming data decoders (drafts 14 and later)
codec.createSubgroupStreamDecoder();
codec.createFetchStreamDecoder();
codec.createDataStreamDecoder();
```

Drafts 08 and later also have `decodeDataStream(streamType, bytes)`, with `streamType` one of `'subgroup'`, `'datagram'` or `'fetch'`. Drafts 08 to 10 add `'datagram_status'`, with `encodeDatagramStatus` and `decodeDatagramStatus`.

### Object properties

The data stream decoders return each Object's property block (Extension Headers before draft-17) as raw bytes in `extensionData`, with `extensionDataByteOffset` giving where it starts. Decode it with the draft's `decodeObjectProperties`:

```typescript
const result = codec.decodeObjectProperties(obj.extensionData);
if (result.ok) {
  for (const p of result.value) {
    // p.type: bigint; p.value for an even type, p.bytes for an odd one;
    // p.properties for the contents of Immutable Properties (0xB)
  }
}

// The reverse, for building an Object to encode
const extensionData = codec.encodeObjectProperties([{ type: 0x3cn, value: 2n }]);
```

The list keeps wire order, repeated types, odd-typed values and unknown types. A block malformed by the draft's rules, such as a property running past the block or a value longer than the draft allows, is a decode error.

### VarInt

`@moqtap/codec/draft07` exports the variable-length integer helpers:

```typescript
import { encodeVarInt, decodeVarInt } from '@moqtap/codec/draft07';

const bytes = encodeVarInt(16384n);   // 4-byte encoding
const result = decodeVarInt(bytes);   // { ok: true, value: 16384n, bytesRead: 4 }
```

### Reading across drafts

A field can move between messages from one draft to the next. A track alias travels in SUBSCRIBE through draft-11 and in SUBSCRIBE_OK from draft-12. The root entry point answers these questions for any draft:

```typescript
import { joiningRequestIdOf, requestIdOf, trackAliasOf, trackOf } from '@moqtap/codec';

const decoded = codec.decodeMessage(bytes);
if (decoded.ok) {
  requestIdOf(decoded.value);        // bigint, whichever name the draft uses
  trackAliasOf(decoded.value);       // bigint
  trackOf(decoded.value);            // { namespace, name }
  joiningRequestIdOf(decoded.value); // for a joining FETCH, the request it continues
}
```

Each returns `undefined` when the message does not carry the field. `requestIdOf` is `undefined` for draft-17 and later responses, which carry no request ID.

### Redacting authorization tokens

`redactAuthTokens(bytes)` returns a control frame with every authorization token value overwritten with `REDACTION_FILL` (`0x00`). The frame keeps its length.

```typescript
import { redactAuthTokens } from '@moqtap/codec/draft22';

const { bytes: clean, redacted, incomplete, decoded } = redactAuthTokens(frame);
```

`redacted` counts the overwritten values. Do not treat `clean` as safe when `incomplete` is `true`. When `decoded` is `false` the frame did not parse to the end, and `redacted === 0` does not mean the frame holds no token. Drafts 07 to 10 overwrite the whole AUTHORIZATION_INFO value. Drafts 11 and later overwrite the token value only.

## Session state machine

The session FSM validates protocol message ordering and tracks the lifecycle of subscriptions, publishes, and fetches. It does not perform I/O — you feed it messages and it tells you whether they're legal.

```typescript
import { createSessionState } from '@moqtap/codec/session';

const session = createSessionState({ codec: { draft: '22' }, role: 'client' });

// Or, from a draft entry point:
import { createDraft22SessionState } from '@moqtap/codec/draft22/session';
const session22 = createDraft22SessionState('client');
```

### Core methods

| Method | Description |
|--------|-------------|
| `send(message)` | Validate and apply an outgoing message. Returns `TransitionResult`. |
| `receive(message)` | Validate and apply an incoming message. Returns `TransitionResult`. |
| `validateOutgoing(message)` | Check if a message is legal to send without changing state. |
| `reset()` | Return to `idle` phase, clear all tracked state. |

### Properties

| Property | Type | Description |
|----------|------|-------------|
| `phase` | `SessionPhase` | Current session phase |
| `role` | `'client'` or `'server'` | The local endpoint's role |
| `subscriptions` | `ReadonlyMap<bigint, SubscriptionState>` | Subscription states keyed by ID |
| `announces` | `ReadonlyMap<string, AnnounceState>` | Namespace announcement states |
| `legalOutgoing` | `ReadonlySet` | Message types valid to send now |
| `legalIncoming` | `ReadonlySet` | Message types valid to receive now |

### TransitionResult

Every `send()` and `receive()` call returns a result:

```typescript
// Success
{ ok: true, phase: 'ready', sideEffects: [...] }

// Protocol violation
{ ok: false, violation: { code: 'ROLE_VIOLATION', message: '...', currentPhase: 'ready', offendingMessage: 'subscribe_ok' } }
```

Violation codes: `MESSAGE_BEFORE_SETUP`, `UNEXPECTED_MESSAGE`, `DUPLICATE_SUBSCRIBE_ID`, `DUPLICATE_REQUEST_ID`, `UNKNOWN_SUBSCRIBE_ID`, `UNKNOWN_REQUEST_ID`, `ROLE_VIOLATION`, `STATE_VIOLATION`, `SETUP_VIOLATION`.

### Session phases

```
idle → setup → ready → draining
```

| Phase | Entered when | Legal messages |
|-------|-------------|----------------|
| `idle` | Initial state | Setup messages |
| `setup` | First setup message sent or received | The peer's setup message |
| `ready` | Setup complete | All control messages |
| `draining` | `goaway` sent/received | Existing subscriptions only |

Through draft-16 setup is CLIENT_SETUP then SERVER_SETUP. From draft-17 each end sends one SETUP, and the session is ready once both have been seen.

### Side effects

The FSM emits side effects to notify your application of state changes:

```typescript
const result = session.receive(message);
if (result.ok) {
  for (const effect of result.sideEffects) {
    switch (effect.type) {
      case 'session-ready':
        // Setup complete, can send control messages
        break;
      case 'session-draining':
        // GOAWAY seen, effect.goAwayUri has the new URI
        break;
      case 'subscription-activated':
        // SUBSCRIBE_OK received, effect.subscribeId
        break;
      case 'subscription-ended':
        // Subscription closed, effect.subscribeId and effect.reason
        break;
      case 'announce-activated':
      case 'announce-ended':
        // effect.namespace
        break;
      case 'publish-activated':
      case 'publish-ended':
      case 'fetch-activated':
      case 'fetch-ended':
        // effect.requestId
        break;
      case 'fill-fetch-stream-opened':    // drafts 20–22
      case 'fill-fetch-stream-closed':    // drafts 20–22
      case 'subscription-state-notified': // drafts 20–22
        break;
    }
  }
}
```

### Example: full session lifecycle

```typescript
import { FilterType } from '@moqtap/codec/draft14';
import { createDraft14SessionState } from '@moqtap/codec/draft14/session';

const session = createDraft14SessionState('client');

// Setup
session.send({ type: 'client_setup', supported_versions: [0xff00000en], parameters: {} });
session.receive({ type: 'server_setup', selected_version: 0xff00000en, parameters: {} });
// session.phase === 'ready'

// Subscribe
const sub = session.send({
  type: 'subscribe',
  request_id: 0n,
  track_namespace: ['chat'],
  track_name: 'messages',
  subscriber_priority: 128,
  group_order: 0,
  forward: 1n,
  filter_type: FilterType.NextGroupStart,
  parameters: {},
});
// sub.ok === true, subscription is now 'pending'

session.receive({
  type: 'subscribe_ok',
  request_id: 0n,
  track_alias: 1n,
  expires: 0n,
  group_order: 1,
  content_exists: 0n,
  parameters: {},
});
// subscription is now 'active', sideEffects includes 'subscription-activated'

// Message types legal to send now
session.legalOutgoing; // Set { 'goaway', 'subscribe', 'subscribe_update', 'unsubscribe', ... }
```

## Decode errors

`decodeMessage` and the other one-shot decoders return `{ ok: false, error }` instead of throwing. `error` is a `DecodeError` with a `code` and the byte `offset` where decoding stopped. Streaming decoders error the stream with the same `DecodeError`.

| Code | Meaning |
|------|---------|
| `UNEXPECTED_END` | Truncated input |
| `INVALID_VARINT` | Malformed variable-length integer |
| `UNKNOWN_MESSAGE_TYPE` | Unrecognized message type ID |
| `INVALID_PARAMETER` | Malformed parameter encoding |
| `CONSTRAINT_VIOLATION` | Value outside legal range |
