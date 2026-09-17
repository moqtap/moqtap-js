# @moqtap/codec

MoQT (Media over QUIC Transport) wire-format codec and session state machine for
JavaScript and TypeScript. Stateless encode and decode of every control message
and data stream, plus an FSM that validates message ordering per draft.

Drafts 07 through 21, zero runtime dependencies, full TypeScript types with
discriminated unions. Runs in Node.js, Bun, and browsers.

## Install

```bash
npm install @moqtap/codec
```

## Quick Start

MoQT is pre-RFC, so a draft version is always explicit. Draft-scoped imports
give the tightest types and pull in only that draft:

```typescript
import { createDraft21Codec } from '@moqtap/codec/draft21'

const codec = createDraft21Codec()

const bytes = codec.encodeMessage({
  type: 'setup',
  options: { moqt_implementation: 'my-app/1.0' },
})

const result = codec.decodeMessage(bytes)
if (result.ok) {
  console.log(result.value.type) // 'setup'
} else {
  console.error(result.error)
}
```

If your application supports several drafts, the root factory picks one at
runtime:

```typescript
import { createCodec } from '@moqtap/codec'

const codec = createCodec({ draft: '21' }) // '07' through '21'
```

## Exports

| Import path                           | Contents                                                      |
| ------------------------------------- | ------------------------------------------------------------- |
| `@moqtap/codec`                       | `createCodec({ draft })`, cross-draft accessors, shared types  |
| `@moqtap/codec/session`               | `createSessionState({ codec: { draft }, role })`               |
| `@moqtap/codec/draft{07..21}`         | One draft's codec, message types and constants                 |
| `@moqtap/codec/draft{07..21}/session` | One draft's session state machine                              |

Each draft module exports `createDraft{NN}Codec()`, `DRAFT_VERSION`, and that
draft's message types.

## Draft versions

Through draft-14 the version is negotiated in band and `0xff0000NN` travels on
the wire; those are the `DRAFT_VERSIONS['07']` through `DRAFT_VERSIONS['14']`
entries. From draft-15 the version is negotiated by ALPN (raw QUIC) or
`WT-Available-Protocols` (WebTransport) as the string `moqt-NN`, and no version
number is sent at all — so the entries above `'14'` are derived identifiers, not
values a peer ever puts on the wire. Report the protocol string instead:

```typescript
import { PROTOCOL_STRING } from '@moqtap/codec/draft21' // 'moqt-21'
```

## Reading across drafts

A field moves between messages as the drafts evolve — a track alias travels in
SUBSCRIBE through draft-11 and in SUBSCRIBE_OK from draft-12. Code spanning
drafts can ask for the answer instead of tracking where each version keeps it:

```typescript
import { joiningRequestIdOf, requestIdOf, trackAliasOf, trackOf } from '@moqtap/codec'

const decoded = codec.decodeMessage(bytes)
if (decoded.ok) {
  requestIdOf(decoded.value) // bigint, whichever name this draft uses
  trackAliasOf(decoded.value) // bigint, or undefined if not assigned yet
  trackOf(decoded.value) // the track this message names, or undefined
  joiningRequestIdOf(decoded.value) // for a joining FETCH, the request it continues
}
```

Each returns `undefined` when the message does not carry the field, including
when the draft has not assigned it yet — `trackAliasOf` on a draft-14 SUBSCRIBE
is `undefined` because the publisher chooses the alias in SUBSCRIBE_OK.

## Session state machine

Validates protocol message sequences without transport coupling:

```typescript
import { createDraft21SessionState } from '@moqtap/codec/draft21/session'

const session = createDraft21SessionState('client')

const result = session.receive(incomingMessage)
if (!result.ok) {
  console.error('Protocol violation:', result.violation)
}
```

## Documentation

<https://moqtap.com/npm-packages/moqtap-codec/>

## License

MIT
