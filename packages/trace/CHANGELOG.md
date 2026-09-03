# Changelog

All notable changes to `@moqtap/trace` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This file starts at 0.4.0. Earlier releases are in the git history. Versions
0.3.1 and an earlier 0.4.0 were prepared in the working tree but never
published; their contents are folded into the 0.4.0 below, so every "before"
in it describes 0.3.0 — the last version anyone can install.

## [0.4.0] - 2026-09-03

**Breaking, which is why this is 0.4.0 and not 0.3.1.** Two changes to what
this package accepts, both below: `ControlMessageEvent.message` is now
`unknown`, and a header with no usable value for a required key now fails the
read.

`ControlMessageEvent.message` is `unknown` rather than
`Record<string, unknown>`. Anything reading a key straight off it stops
compiling, which is the point: the old type was a claim the runtime did not
keep. Every `capture-*` file in the conformance corpus carries a text rendering
of the message there, so `event.message.request_id` typechecked and read
`undefined` on exactly the files the tolerance rule exists for. Narrow with the
new `controlMessageFields()` before reading keys.

**Breaking: a header with no usable value for a required key now fails the
read.** `readMoqtrace`, `readMoqtraceSegments` and `readMoqtraceHeader` throw
the new `MalformedHeaderError` when `"protocol"`, `"perspective"`, `"detail"`,
`"startTime"` or `"segment.sequence"` is absent or carries a value the field
cannot hold. They used to return a header instead — `protocol` reading
`undefined` through a field declared `string`, `startTime` reading `NaN`,
`segment.sequence` reading `0`. Each of those is a value the file never
carried, and nothing downstream could tell one from a real one: a fabricated
trace reported as evidence, and `sequence: 0` in particular is not a missing
answer but a wrong one, since it claims the segment is the first in its stream.
Rejecting is the right trade because the only thing lost is a header that was
never in the file. The writer now refuses the same two keys before it emits
anything, so this package never produces a file it would then refuse to read —
see **The writer refuses a required header integer its own reader would not
read back** below.

Which files this reaches: none that either implementation's writer produces,
and none in the shared conformance corpus — every case is a header no
conformant writer emits. A tool that reads third-party or hand-built traces
should catch `MalformedHeaderError`, and can pass `recover` to skip the
offending segment and keep the rest of a segmented capture. The three
unrecognised-key stores added below are new optional fields on existing
interfaces, so code that constructs a header still compiles; code that compares
a decoded header against an object literal will see `extra` where it did not
before.

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
  (`@moqtap/test-traces`, under `moqtrace/`) as part of its test suite, against
  files written by the Rust implementation and by third-party relays rather
  than by itself.
- **The header preserves the keys it does not recognise**, in three stores:
  `extra` on `TraceHeader`, on `SegmentInfo` and on `SamplingInfo` — the same
  field, spelt the same way, as the one `TraceEvent` already carries, so a user
  of this package meets one concept rather than two. Three and not one because
  a private key on `"segment"` and a key of the same name at the top level are
  different keys, and re-emitting either in the other's map changes what the
  file says. `"custom"` gets none: every key in it belongs to whoever wrote the
  trace, so there is no such thing as an unrecognised key there.
- `MalformedHeaderError`, exported alongside `TruncatedTraceError`, carrying
  the `key` it could not read. A distinct type so a caller can tell a header it
  must not trust from a truncated file it can still use. Its constructor takes
  the key and the fault as a whole predicate — `new MalformedHeaderError(
  'protocol', 'is missing')` — which is not public surface in practice, since
  the reader and the writer are its only callers.
- `extra` on `RecorderOptions`, carried through to the finalized header, for a
  recorder with something to say that the format has no key for. Use the `"x-"`
  prefix the format reserves for private use.
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
- **Event 6 can say which stream failed, how, and with what bytes**:
  `streamId`, `errorKind`, `rawLength` and `raw` on `TraceErrorEvent`, from the
  new `"sid"`, `"ek"`, `"rawlen"` and `"raw"` keys, with `ErrorKind` and an
  `ErrorDetails` argument to `recordError`. The event had nowhere to put the
  bytes that caused it, so a recorder keeping the evidence had to record the
  violation as a control message — asserting a decodable message where there
  was none, in a way no reader can tell from a real one.
  - `streamId` is optional on Event 0's terms: absent means no stream or none
    known, and must not be read as stream `0`. `bigint`, to stay exact past
    2^53 rather than disagree with the Rust reader silently.
  - `errorKind` is an open vocabulary — `'protocol'`, `'transport'`, `'decode'`,
    or any other string. Not spelt `kind`: `SubscriptionDerivationEvent` owns
    that name with an unrelated vocabulary, and two vocabularies under one name
    become one column in any flat export of a trace.
  - `rawLength` is gated at `'headers+sizes'` and `raw` at `'full'`. A size
    separates a truncated message from a mistyped one and carries no content;
    the bytes behind an error naming a data stream are payload.
  - `MAX_ERROR_RAW_BYTES` (4096) is applied in `recordError`, which truncates,
    reports the untruncated length, and writes the bytes once per flow. It is
    deliberately absent from `binary.ts`: a serializer cannot tell an event
    just built from observed bytes from one that arrived by being read, so a
    cap there would shorten evidence on every rewrite.
- **An incremental reader, for a stream that arrives in pieces**:
  `createMoqtraceReader()` returns a `MoqtraceReader` whose `push(chunk)` and
  `end()` hand back the `ReadItem`s that have become whole, keeping the
  remainder for the next chunk. The three entry points in `binary.ts` all take
  a finished file, which a live capture does not have: chunk boundaries fall
  wherever the transport put them, almost never on an item boundary. Header
  and event decoding is imported from `binary.ts` rather than written again,
  so a trace read in instalments and the same trace read whole produce the
  same values.
- `TruncatedStreamError`, thrown by `end()` when bytes remain that do not form
  a whole item. Deliberately not `TruncatedTraceError`, whose `segments` field
  promises everything that decoded before the cut: an incremental reader has
  already handed those events to its caller and does not keep them, so it
  cannot fill that field, and filling it with an empty array would report a
  trace that decoded nothing — a wrong answer rather than a missing one.

### Fixed

- **`recover` no longer discards a damaged region silently.** Pass
  `onRecovered` alongside it and the reader reports each skipped region: the
  offset it began at, whether a header, an event or a truncation ended it, and
  the offset the read resumed at — `undefined` when nothing followed, meaning
  the rest of the file was dropped. `Trace[]` has no error channel, so before
  this a capture that lost a segment and one that never had it were the same
  value, and the largest loss of all — recovery finding no further segment and
  returning what it had — looked exactly like a clean end of file.

- **A header no longer loses every key this version does not know.** An
  `"x-note"` in a header was gone after a read and absent after a write-back,
  so any read-modify-write — a redaction pass, a filter, a re-segmentation, an
  annotated download — emitted a valid file that looked as though it had never
  carried the key. Both reference implementations did this; SPEC.md gained a
  section naming it.
- **A defined header key whose value is unusable goes to a store rather than
  into the field.** `"transport": 42` used to reach `header.transport` as a
  number wearing the type `string`, which no compiler catches; it is now kept
  verbatim in `header.extra`, `transport` reads as absent, and the key is
  written back unchanged. The whole header decode was `as` casts and
  `Number(...)` calls, so this covers every key at once — and, as on the event
  side, what goes to a store is decided by what the decode consumed rather than
  by a list of key names that would have to be kept in step with it.
- **`"sampling.appliesTo"` is kept whole or not at all.** An `[3, "x", 5]` was
  read as `[3, NaN, 5]` and the `NaN` written back to disk. Keeping only the
  elements that read cleanly would be no better: the key names the event types
  a drop policy touched, and readers may treat every type absent from it as
  complete, so a shortened array reports a sampled type as fully recorded.
- **A `"segment"` that is not a map no longer invents `{sequence: 0}`.** A
  header carrying `"segment": 5` read back as a segmented trace at sequence 0 —
  a claim about the file's place in a stream that the file never made. The
  value now goes to the header's store, the trace reads as non-segmented, and
  the file is *not* rejected: one unreadable metadata value must not cost every
  event behind it. The same holds for a `"sampling"` that is not a map.
- **A `"custom"` that is not a map no longer sits in a field declared
  `Record<string, unknown>`.** It goes to the header's store, `custom` reads as
  absent, and the bytes still survive a rewrite. Losing typed access is the
  smaller harm — nothing in the format gives `"custom"` keys meaning, and the
  old field lied to every caller that iterated it.
- **A `"sampling.effectiveRate"` that is not a number in `(0.0, 1.0]` is no
  longer handed to the caller as a sampling rate.** The key was read as
  `Number(obj.effectiveRate)`, so `2.0`, `0.0` and `-0.5` reached
  `sampling.effectiveRate` and a consumer reconstructing true event counts
  divided by them: a division by zero for one and a count larger than what was
  recorded for another, each produced silently out of a header the reader had
  already decided to trust. A text `"half"` reached it too, as the `NaN` that
  conversion answers, and `samplingToCbor` then wrote the `NaN` back to disk —
  No finite check existed anywhere, and `NaN != null` is true, so nothing
  stopped either end of that. The format states a range for this key and for no
  other in the header, and a value outside the range a key's meaning allows is
  unusable — so all of these now go to the sampling map's store with their
  bytes intact, and the file is not refused over them. The interval is open at
  `0` and closed at `1`, so `1.0` — "no rate-based dropping", the commonest
  rate there is — still reads into the field.
- **A malformed header names the key and says whether it was absent or
  unusable.** Neither was reported before, because there was no report at all: the
  required keys were `as` casts and a `Number(...)`, and a header missing
  `"protocol"` was returned rather than refused (see the Breaking note above).
  The message text is `Malformed header: "protocol" is missing` for an absent
  key and `Malformed header: "protocol" must be a text string` for a present
  one that no field can hold, and the Rust implementation's diagnosis of the
  same file agrees.
- `traceToJSON` renders the stores, header and event alike. This held before
  and is now stated and pinned by tests rather than left to the fact that
  `JSON.stringify` happens to walk every field: it is the view someone reaches
  for when they suspect a key went missing, so one that showed only the keys
  this version names would reintroduce the loss it was being used to look for.
- **A wrong-typed value on an optional key no longer costs the whole file.**
  The four Event 1 keys above were decoded with `BigInt(value)`, which throws
  on text, on a fractional number, and on an array or a map. One event carrying
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
- **A store entry named `__proto__` is written to the file instead of vanishing
  from it.** `map[key] = value` is the one assignment JavaScript does not
  perform for that key: it reaches the setter `Object.prototype` defines and
  replaces the map's prototype, so `Object.hasOwn` read false, `Object.entries`
  did not list it, and the entry was gone without an error or a warning. A
  caller reaches the shape without trying, because `JSON.parse` makes
  `__proto__` a real own property — JSON has no such rule — so a store parsed
  out of a sidecar file or a config wrote a trace with the key missing, on the
  one code path whose entire purpose is preservation. Every place a key from a
  file or from a store is put onto a map now goes through
  `Object.defineProperty`. Every store this reaches — an event's `extra`, an
  unknown event's `fields`, and the three header stores — is new in this
  release, so no published version ever carried the defect. The *read* half is
  not fixed and cannot be from here — see the limitation below.
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

### Changed

- **The writer refuses a required header integer its own reader would not read
  back.** `writeMoqtrace`, `writeMoqtraceSegments` and `createMoqtraceWriter`
  throw `MalformedHeaderError` when `startTime` or `segment.sequence` is
  negative, fractional or past `Number.MAX_SAFE_INTEGER`. Both are `number`
  fields, so TypeScript admits `-5` and `1.5` into either, and the writer wrote them
  out: the file was produced, the process exited 0, and the fault surfaced
  wherever someone later tried to open it, if anyone did. The Rust
  implementation cannot reach the state — its field is a `u64` — so the two
  writers now agree. The check is on the field and never on a store: a file
  that legitimately carries an unusable optional value reads with it in the
  store of the map it came from, and a rewrite of that file is not refused over
  it. Only these two keys are refused, because only these two make a file this
  package cannot open; a negative `endTime` still writes, and reads back into
  the header's store rather than failing the read.
- A `"traceId"` whose length is not 16 bytes is kept in `extra` rather than
  failing the event. The key is optional, and what makes the event a derivation
  — the upstream and downstream subscriptions it links — decoded fine. Writing
  a wrong-length trace id is still refused.

### Known limitations

- **A map key of `"__proto__"` read from a file comes back as `"__proto_"`, and
  is written back under the renamed spelling.** cbor-x rewrites it inside its
  own decoder, before any code in this package runs. There is no option for it:
  the rename is unconditional on every path that decodes a map to an object,
  and the only decoder that skips it returns a `Map` for every map in the file,
  which is a different reader from this one and a much larger change than the
  defect warrants. Two consequences worth stating plainly. A file carrying both
  `"__proto__"` and `"__proto_"` reads as *one* key and loses a value, so this
  is not only a renaming. And it reaches `"custom"`, which this package
  otherwise hands back key for key and value for value, and any preserved value
  at any depth. The Rust implementation keeps the two keys apart, so the two
  readers disagree about such a file, and a JS read-modify-write is the step
  that changes it. SPEC.md, "Shapes a CBOR library may normalise before you see
  them", part 3: the normalisation happens below this implementation, so the
  reader is not non-conformant and nothing may depend on the outcome — but it
  is not invisible either, and this is where it is on the record. The same
  decoder stringifies a non-text map key with the same collision, so `1` and
  `"1"` in one map also read as one entry. Writing is unaffected: a store entry
  spelt `__proto__` now reaches the file spelt `__proto__` (above).

### Notes

`SPEC.md` gained normative rules for `"msg"`: it MUST be a CBOR map keyed in
snake_case; a writer with nothing decoded MUST write `{}` rather than omit the
key; readers MUST be more tolerant than writers; a tool rewriting a trace MUST
preserve a non-map `"msg"` rather than normalise it away; and CBOR `undefined`
MUST NOT be written, being the one shape neither implementation can preserve.
