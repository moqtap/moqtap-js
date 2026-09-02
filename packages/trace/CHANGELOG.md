# Changelog

All notable changes to `@moqtap/trace` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This file starts at 0.4.0. Earlier releases are in the git history. Version
0.3.1 was tagged in the working tree but never published; its contents are
folded into 0.4.0 below.

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
