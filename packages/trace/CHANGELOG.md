# Changelog

All notable changes to `@moqtap/trace` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This file starts at 0.4.0. Earlier releases are in the git history. Version
0.3.1 was tagged in the working tree but never published; its contents are
folded into 0.4.0 below.

## [Unreleased]

The Event 1 keys below and the fixes to them are in the same unreleased range.
No published version of this package shipped the data loss.

### Added

- **Event 1 carries the stream header's identifiers**: `trackAlias`,
  `subgroupId`, `fetchRequestId` and `groupId` on `StreamOpenedEvent`, from the
  new `"ta"`, `"sg"`, `"fri"` and `"g"` keys. No detail level records the bytes
  of a `SUBGROUP_HEADER`, a fetch header or a datagram header, so before these a
  `'headers'` recording could not say which track a stream belonged to and had
  nothing left to re-parse it from. All four are optional; each of the last
  three is meaningful on one stream type only.
- All four are `bigint`, matching `ObjectHeaderEvent`'s `groupId`, `objectId`
  and `streamId` rather than this event's narrow `direction` and `streamType`.
  As `number` they would make `streamOpened.groupId === objectHeader.groupId`
  evaluate `42 === 42n` — `false`, silently, for two fields naming one group.

### Fixed

- **A wrong-typed value on an optional key no longer costs the whole file.**
  The four keys above were decoded with `BigInt(value)`, which throws on text,
  on a fractional number, and on an array or a map. One event carrying
  `"ta": "hello"` therefore threw a raw `SyntaxError` out of `readMoqtrace`,
  which returned nothing at all: no events, and not an error type this package
  defines, so a caller handling its error types did not catch it either. Every
  optional key is now read through a type test, and a value the field cannot
  hold is kept rather than thrown on.
- **A defined key whose value has an unusable type is preserved again**, as
  SPEC.md requires: it goes to `extra`, is ignored for meaning, and is written
  back unchanged, exactly as a key the reader had never heard of is. Adding
  `"ta"`, `"sg"`, `"fri"` and `"g"` to the reader's vocabulary had *reduced*
  what it preserved — before, a text or fractional `"ta"` survived in `extra`;
  after, it was lost. The reader now decides by what the decode could use
  rather than by a list of the keys each event type owns, so this holds for
  every optional key on every event type, not only the four that exposed it.
- **`true` is no longer read as the identifier 1, nor the text `"4"` as 4.**
  `BigInt` converts both, so a wrong-typed value could reach the event as an
  identifier the file never carried — and one the Rust reader, which coerces
  neither, does not see. The same conversion was applied to a subscription
  derivation's request id, and is gone from there too.
- A required integer key with an unusable value still fails the event, which is
  what the format asks for, but now names the key instead of surfacing whatever
  `BigInt` threw.

### Changed

- A `"traceId"` whose length is not 16 bytes is kept in `extra` rather than
  failing the event. The key is optional, and what makes the event a derivation
  — the upstream and downstream subscriptions it links — decoded fine. Writing
  a wrong-length trace id is still refused.

## [0.4.0] - 2026-09-02

**Breaking, which is why this is 0.4.0 and not 0.3.2.**
`ControlMessageEvent.message` is now `unknown` rather than
`Record<string, unknown>`. Anything reading a key straight off it stops
compiling, which is the point: the old type was a claim the runtime did not
keep. Every `capture-*` file in the conformance corpus carries a text rendering
of the message there, so `event.message.request_id` typechecked and read
`undefined` on exactly the files the tolerance rule exists for. Narrow with the
new `controlMessageFields()` before reading keys.

### Added

- `extra` on every known event type: keys a reader does not recognise are kept
  verbatim and written back out. Ignoring an unrecognised key is permitted;
  dropping one is not, or any read-modify-write — a redaction pass, a filter,
  an annotated download — emits a file that looks like it never carried the
  key. Absent on an `unknown` event, whose fields already hold everything.
- `controlMessageFields(message)`, which narrows a control event's `"msg"` to a
  field map or answers `undefined`. Provided because the check is easy to get
  wrong once per call site and silently: `typeof message === 'object'` also
  admits `null`, a CBOR array and a byte string, each of which would then be
  typed as a field map and read back `undefined` for every key.
- The package reads the shared `.moqtrace` conformance corpus
  (`test-vectors/trace/`) as part of its test suite, against files written by
  the Rust implementation and by third-party relays rather than by itself.

### Fixed

- **A control message with no `"msg"` key is read rather than dropped**, as an
  empty map. Event 0 is one of the types sampling MUST NOT drop, so treating
  the absence as malformed discarded exactly the events the format promises to
  keep.
- **`"msg"` is written even when nothing was decoded.** An event that reached
  the encoder with no `message` wrote CBOR `undefined` — a simple value, not a
  map — producing precisely the file the spec tells writers not to produce.
  It now writes an empty map.
- **A `"msg"` of `null` is preserved rather than replaced.** The decoder used
  `obj.msg ?? {}`, which conflated *absent* with *present and null*. `null` is
  a value a writer chose to put on the wire; only absence is normalised.
- A text `"msg"` — what every pre-spec recording carries — survives a
  read-modify-write unchanged. This held before and is now pinned by tests.

### Notes

`SPEC.md` gained normative rules for `"msg"`: it MUST be a CBOR map keyed in
snake_case; a writer with nothing decoded MUST write `{}` rather than omit the
key; readers MUST be more tolerant than writers; a tool rewriting a trace MUST
preserve a non-map `"msg"` rather than normalise it away; and CBOR `undefined`
MUST NOT be written, being the one shape neither implementation can preserve.
