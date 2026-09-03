# `.moqtrace` Specification

> **Version:** 2
> **Status:** Draft

## Overview

This document defines two layered artifacts:

1. **The MoQT trace event model** (Part 1, normative) — the set of event types, their fields, and their semantics. This model is transport-independent; it can be serialized to a file, streamed over MoQT, shipped as JSON to a collector, or embedded in another container.
2. **The `.moqtrace` binary file format** (Part 2, normative) — a CBOR-based container for the event model above. Streamable, segmentable, self-describing.

A third artifact, the MoQT carriage convention for live trace transport, is **Appendix A (informative)**. It is transport behavior rather than file-format core and is expected to migrate to a separate moqtap protocol draft; it is included here only so early implementers have a single reference.

Design goals of the `.moqtrace` container:

- **Streamable** — events can be appended as they occur; no backpatching required
- **Segmentable** — a stream can be carved into self-contained segments, each independently parseable, enabling live carriage and capture rotation
- **Compact** — CBOR encoding handles binary data natively (no base64 overhead)
- **Self-describing** — the header declares the detail level, protocol version, and recording context so readers know what to expect without scanning events
- **Cross-language** — readable by any language with a CBOR library (JS, Rust, Go, Python)

---

# Part 1: Event Model (normative)

## Detail Levels

The `"detail"` field (see Part 2 header) declares what was recorded. Each level is a strict superset of the one above it. Readers can handle any level — they just find more or fewer fields populated per event.

| Detail Level      | What's Recorded                                                                                                                                  | Typical Use Case                                      |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| `"control"`       | Control messages only (setup, subscribe, publish, goaway, etc.). No data stream events, no object payloads.                                      | Lightweight protocol flow analysis. DevTools default. |
| `"headers"`       | Control messages + data stream headers (subgroup/fetch/datagram headers, object metadata: group, object ID, priority, status). No payload bytes. | Delivery pattern analysis, timing.                    |
| `"headers+sizes"` | Everything in `"headers"` + payload byte lengths for each object, and the size of the bytes behind an error ([Event 6](#event-6-error) `"rawlen"`).                                                                                | Bandwidth analysis without storing media.             |
| `"headers+data"`  | Everything in `"headers"` + full payload bytes for each object.                                                                                  | Full session replay, debugging media corruption.      |
| `"full"`          | Everything above + raw wire bytes for every *control* message (pre-decode), and the bytes behind an error event ([Event 6](#event-6-error) `"raw"`). See the note below on data-stream framing.                            | Wire-level debugging, compliance testing.             |

Levels `"headers+data"` and `"full"`, and the `"raw"` field on Event 0 and [Event 6](#event-6-error), are **payload-bearing** — see [Privacy Considerations](#privacy-considerations). So is [Event 6](#event-6-error)'s `"raw"`, which is why it is gated at `"full"` and not at Event 6's own `control`+: an error naming a *data* stream has subgroup framing and object payload behind it, which is media, and inheriting the event's level would have put it in traces whose declared level excludes payloads entirely.

**No level carries data-stream framing bytes.** `"raw"` exists only on Event 0,
and Event 4's `"pl"` begins after the object header, so the bytes of a
`SUBGROUP_HEADER`, a fetch header or a datagram header are recorded at no level
including `"full"`. What those headers carry is recorded as decoded fields
instead — see [Event 1](#event-1-stream-opened). Closing that gap needs a new
key and is not in this revision; the level's description no longer implies
otherwise.

At any detail level, the recorder MAY be configured to **mask payloads** — replacing payload bytes with zeroes before writing. This preserves payload sizes for bandwidth analysis while stripping media content. Sources MUST advertise masking via `"payloadMasked": true` in the header's `"custom"` map when active.

## Event Types

| `"e"` Value | Name                    | Description                                                                                                        |
| ----------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `0`         | Control message         | A control-stream message was sent or received                                                                      |
| `1`         | Stream opened           | A unidirectional or bidirectional QUIC stream was opened                                                           |
| `2`         | Stream closed           | A QUIC stream was closed                                                                                           |
| `3`         | Object header           | An object header was parsed from a data stream                                                                     |
| `4`         | Object payload          | Object payload bytes were received/sent                                                                            |
| `5`         | State change            | Session FSM phase transition                                                                                       |
| `6`         | Error                   | Protocol error or transport error                                                                                  |
| `7`         | Annotation              | User-defined event (custom label + data)                                                                           |
| `8`         | Peer connected          | A new peer session was established (relay-tap)                                                                     |
| `9`         | Peer disconnected       | A peer session ended (relay-tap)                                                                                   |
| `10`        | Subscription derivation | A subscription was created or extended in causal response to other subscriptions (relay-tap; multi-hop correlation) |

Event types `8`, `9` and `10` are defined by this version but are emitted only by `"relay-tap"` sources. A reader MUST be able to parse them; a recorder that is not a relay tap never produces them.

## Common Event Fields

Every event is a CBOR map with at minimum:

| Key   | CBOR Type        | Description                                                                                         |
| ----- | ---------------- | --------------------------------------------------------------------------------------------------- |
| `"n"` | unsigned integer | Monotonically increasing sequence number (0-based). Disambiguates events with identical timestamps. Segment-local in segmented traces. |
| `"t"` | integer          | Timestamp in microseconds since the containing segment's `startTime`.                               |
| `"e"` | integer          | Event type (see table above).                                                                       |
| `"p"` | text string      | **Optional.** Peer identifier. REQUIRED when `"perspective": "relay-tap"`; identifies which connected peer the event pertains to. Source-local scope — see [Identifier Scoping](#identifier-scoping). |

Short key names are used intentionally — traces can contain hundreds of thousands of events, and CBOR encodes short strings more compactly.

## Identifier Scoping

The event model uses three distinct identifiers with different scopes. Tooling MUST NOT conflate them.

| Identifier     | Scope                                                | Assigned by                                       | Purpose                                                        |
| -------------- | ---------------------------------------------------- | ------------------------------------------------- | -------------------------------------------------------------- |
| `"p"`          | **Source-local** — unique only within one trace source (one recorder, one `sessionId`) | The recording source; format is source-chosen (UUID, numeric ID, `version@addr`, etc.) | Demultiplexing events from multiple peers within a relay-tap trace. |
| `"sessionId"`  | **Capture-correlation** — groups traces recorded from a single logical session by different capture points (e.g., client + server + observer) | Chosen out-of-band by the operator, or propagated via session setup | Aligning multiple viewpoints on the **same** session.         |
| `"traceId"`    | **End-to-end / federated** — globally unique across operator boundaries | The originating endpoint, propagated on-wire via `MOQTAP_TRACE_ID` | Stitching multi-hop subscription chains into a single tree, even across organizations. |

Because `"p"` is source-local, a collector correlating traces from multiple sources MUST NOT assume that the same `"p"` value in two different traces refers to the same peer. To cross-reference peers across sources, use `"traceId"` (for subscription-linked events) or compose `(source, p)` as the effective key (using the header's `"source"` field).

`"sessionId"` and `"traceId"` are **orthogonal**: a single session may carry many subscriptions each with a distinct trace ID, and a single end-to-end trace may span many sessions on many hosts. Presence rules:

- `"sessionId"` SHOULD be set whenever the recording party has a stable session handle and more than one vantage point is likely to be captured (e.g., client-side and server-side of the same WebTransport session). It MAY be absent in single-vantage captures.
- `"traceId"` appears **only on events derived from a SUBSCRIBE carrying `MOQTAP_TRACE_ID`**. It is never required on the header. An event with no triggering subscription (e.g., Event 8 Peer Connected) has no trace ID.

## Event-Specific Fields

### Event 0: Control Message

| Key     | Type        | Detail Level | Description                                       |
| ------- | ----------- | ------------ | ------------------------------------------------- |
| `"d"`   | integer     | `control`+   | Direction: `0` = sent (tx), `1` = received (rx)   |
| `"mt"`  | integer     | `control`+   | Wire message type ID (e.g., `0x03` for SUBSCRIBE) |
| `"msg"` | map         | `control`+   | Decoded message fields, keyed in snake_case (see below) |
| `"sid"` | unsigned integer | `control`+ | QUIC stream ID the message travelled on. Optional (see below). |
| `"raw"` | byte string | `full` only  | Raw wire bytes (including type and length prefix). Payload-bearing — see [Privacy Considerations](#privacy-considerations). |

`"sid"` is optional: a recorder that sits at the session level rather than the
stream level has no stream to report, and omitting the key says so. Readers
MUST distinguish an absent `"sid"` from stream `0`.

Recorders SHOULD write it. From draft-17 the control plane is no longer a
single stream — the session control stream became a pair of unidirectional
streams, and every request (SUBSCRIBE, PUBLISH, FETCH, …) gets its own
bidirectional stream. Responses on those streams carry no request ID, because
the stream itself is the correlation, so a trace without `"sid"` cannot tie a
SUBSCRIBE_OK back to its SUBSCRIBE, and everything derived from that pairing —
track names, aliases, request outcomes — is lost to the reader. Through
draft-16 all control messages share one stream and the field is merely
informative.

#### `"msg"` field naming and shape

`"msg"` MUST be a CBOR map. Its keys are the message's field names **in
snake_case** — `request_id`, `track_alias`, `group_order` — which is what the
drafts themselves use and what the shared codec vectors carry, so a reader can
address a field without knowing which implementation wrote the file.

A writer that has no decoded fields — the message type is one it cannot parse,
or the recorder is not decoding bodies at all — MUST write an empty map `{}`
rather than omit the key. Omission costs a reader more than the one byte it
saves: Event 0 is one of the types [sampling](#sampling) MUST NOT drop, so a
reader that treats a missing `"msg"` as a malformed event discards exactly the
events the format promises to keep.

Readers MUST be more tolerant than writers, because files predating this rule
exist:

- An **absent** `"msg"` MUST be read as an empty map, not as an error.
- A `"msg"` that is **not a map** MUST be preserved verbatim and offered to the
  caller unchanged. It MUST NOT cause the event to be rejected. Recordings
  written before this revision carry a text rendering of the decoded message
  here — every `capture-*` case in the conformance corpus is such a file — and
  they remain readable, with the field simply not addressable by key.

CBOR `null` is a value, not an absence: a writer put it there, so it falls
under "not a map" and MUST be preserved. CBOR `undefined` (major type 7,
simple value 23) is **not** preservable here, and writers MUST NOT emit it.
Neither reference implementation can represent it distinctly *as a `"msg"`* —
the TypeScript reader cannot tell it from a field the caller never set, and the
Rust reader's CBOR library decodes it to `null` before the reader sees it — so
a reader MAY normalise it to an empty map or to `null`, and the two will
disagree about which. There is no file this matters for unless one is written
deliberately; the rule exists so that nobody writes one expecting it to
survive. It is one row of a general table — see [Shapes a CBOR library may
normalise before you see them](#shapes-a-cbor-library-may-normalise-before-you-see-them),
which also explains why the answer differs by *where* in a trace the value sits:
the same `undefined` inside an unrecognised-key store is preserved by one
implementation and not the other.

**A tool that reads a trace and writes it back MUST preserve a non-map `"msg"`
as it found it**, and MUST NOT replace it with an empty map to satisfy the
writer rule above. Replacing it would discard the only record of a message that
will never be seen again. This is one instance of a general rule stated under
[Versioning and Compatibility](#versioning-and-compatibility): on a rewrite the
reader rule outranks the writer rule.

### Event 1: Stream Opened

| Key     | Type    | Detail Level | Description                                              |
| ------- | ------- | ------------ | -------------------------------------------------------- |
| `"sid"` | integer | `headers`+   | QUIC stream ID                                           |
| `"d"`   | integer | `headers`+   | Direction: `0` = outgoing, `1` = incoming                |
| `"st"`  | integer | `headers`+   | Stream type: `0` = subgroup, `1` = datagram, `2` = fetch |
| `"ta"`  | integer | `headers`+   | Track alias the stream carries. Optional.                |
| `"sg"`  | integer | `headers`+   | Subgroup ID. Optional; only meaningful when `st == 0`.   |
| `"fri"` | integer | `headers`+   | Fetch request ID. Optional; only meaningful when `st == 2`. |
| `"g"`   | integer | `headers`+   | Group ID. Optional; only meaningful when `st == 1`.       |

#### Why these four keys exist

A `SUBGROUP_HEADER` carries a track alias, a group, a subgroup and a publisher
priority. A fetch header carries a request ID. A datagram header carries a track
alias, a group, an object and a priority. Before this revision the model could
express group, object, priority and status and nothing else — **track alias,
subgroup ID and fetch request ID had nowhere to live**, and at `"headers"` there
are no payload bytes to re-parse them from. A `"headers"` recording therefore
could not answer which track a stream belonged to, which is most of what the
level exists for.

**A writer MUST write `"fri"` on a fetch stream** (`st == 2`), where it is the
only correlation between the stream and the FETCH that asked for it. A reader
MUST NOT reject a fetch stream that lacks it: recordings predating this revision
have none, and Event 1 is not a type a reader may discard on a missing optional
key. The same asymmetry as [`"msg"`](#msg-field-naming-and-shape) — writers
conform, readers tolerate.

The other three are written when known. `"sg"`, `"fri"` and `"g"` are each
scoped to one stream type because on the others they have no source; a writer
MUST NOT write one outside its scope, and a reader that meets one there MUST
**keep** it — read it into the field it names, and write it back — rather than
reject the event or route it elsewhere.

"Keep", not "ignore": a reader is free to disregard the *meaning* of an
out-of-scope key, but it does not get to drop the value. Dropping would violate
[the preservation rule](#versioning-and-compatibility), and routing it to the
unrecognised-key store would be wrong twice over — the key *is* recognised, its
value *is* usable, and a key held in both places is written back twice.

Wrong *place* is not wrong *shape*, and they part company here. A `"sg"` on a
fetch stream is a usable value in a position that means nothing: it reaches the
field. A `"sg"` carrying a text string is not a usable value at all, wherever it
sits, and goes to the unrecognised-key store under [the rule for unusable
types](#versioning-and-compatibility). A reader has to answer both questions,
in that order.

**Event 3 wins.** Where a value appears both here and on an Event 3 for the same
stream — a group ID, most obviously — **Event 3 is authoritative** and this copy
is a convenience for readers that have not yet seen an object. A reader MUST NOT
treat a disagreement as corruption; it MUST prefer Event 3.

`"g"` is scoped to datagrams for that reason: on a subgroup stream every object
carries the same group by construction, so a copy here would be a second field
with no independent source. `"pp"` is deliberately **not** added for the same
reason — Event 3's `"pp"` is the stream header's publisher priority copied per
object, and a second copy would have no tiebreak.

#### Integer keys decode to the same type as their Event 3 counterparts

`"ta"`, `"sg"`, `"fri"` and `"g"` MUST decode to whatever language type an
implementation gives Event 3's `"g"`, `"o"` and `"sid"` — not to whatever it
gives Event 1's existing `"st"` and `"d"`.

Those two groups differ today, for a good reason that does not extend here:
`"st"` and `"d"` are small enumerations, and an implementation may reasonably
hold them in a narrow type. The keys added above are wire identifiers with the
same range as Event 3's. An implementer following the enclosing event's local
convention would type Event 1's `"g"` as a JavaScript `number` while Event 3's
is a `bigint`, and `event1.g === event3.groupId` would then evaluate `42 === 42n`
as `false` — silently, and for every reader that made the same reasonable
choice.

### Event 2: Stream Closed

| Key     | Type    | Detail Level | Description                  |
| ------- | ------- | ------------ | ---------------------------- |
| `"sid"` | integer | `headers`+   | QUIC stream ID               |
| `"ec"`  | integer | `headers`+   | Error code (0 = clean close) |

### Event 3: Object Header

Object header events and object payload events (event 4) for the same object share `(sid, g, o)` as a composite key. An object header event is always emitted before its corresponding payload event.

| Key     | Type    | Detail Level | Description                                                                |
| ------- | ------- | ------------ | -------------------------------------------------------------------------- |
| `"sid"` | integer | `headers`+   | Stream ID this object arrived on                                           |
| `"g"`   | integer | `headers`+   | Group ID                                                                   |
| `"o"`   | integer | `headers`+   | Object ID                                                                  |
| `"pp"`  | integer | `headers`+   | Publisher priority                                                         |
| `"os"`  | integer | `headers`+   | Object status (0=normal, 1=end-of-group, 2=end-of-track, 3=does-not-exist) |

### Event 4: Object Payload

**Payload-bearing event** — see [Privacy Considerations](#privacy-considerations).

| Key     | Type        | Detail Level     | Description                                                |
| ------- | ----------- | ---------------- | ---------------------------------------------------------- |
| `"sid"` | integer     | `headers+sizes`+ | Stream ID                                                  |
| `"g"`   | integer     | `headers+sizes`+ | Group ID                                                   |
| `"o"`   | integer     | `headers+sizes`+ | Object ID                                                  |
| `"sz"`  | integer     | `headers+sizes`+ | Payload size in bytes                                      |
| `"pl"`  | byte string | `headers+data`+  | Payload bytes (or zeroed if masked). Payload-bearing.      |

### Event 5: State Change

| Key      | Type        | Detail Level | Description            |
| -------- | ----------- | ------------ | ---------------------- |
| `"from"` | text string | `control`+   | Previous session phase |
| `"to"`   | text string | `control`+   | New session phase      |

### Event 6: Error

| Key        | Type             | Detail Level | Description           |
| ---------- | ---------------- | ------------ | --------------------- |
| `"ec"`     | integer          | `control`+   | Error code            |
| `"reason"` | text string      | `control`+   | Human-readable reason |
| `"sid"`    | unsigned integer | `control`+   | QUIC stream ID the error was observed on. **Optional**, on the same terms as [Event 0's `"sid"`](#event-0-control-message): absent means there was no stream or none is known, and readers MUST distinguish that from stream `0`. |
| `"ek"`     | text string      | `control`+   | Error kind. **Optional.** See below. |
| `"rawlen"` | unsigned integer | `headers+sizes`+ | Byte length of the input the recorder held for this error, before any truncation. **Optional.** See below. |
| `"raw"`    | byte string      | `full` only  | The offending bytes, truncated to the cap below. **Optional.** Payload-bearing — see [Privacy Considerations](#privacy-considerations). |

#### Why an error event carries bytes

A peer that sends something malformed is one of the few things a shared trace
is uniquely good for: the recording party can see it and the sending party
cannot. A report saying "your SUBSCRIBE_OK did not parse" is an assertion; the
same report carrying the bytes that did not parse is evidence, and the other
party can run it against their own encoder without reproducing the session.

Before these keys the only field able to hold bytes was Event 0's `"raw"`, and
a recorder wanting to keep the evidence had to claim the violation was a
control message in order to have somewhere to put it. That is a worse record
than none: it asserts a decodable message where there was a protocol
violation, and no reader can tell the two apart. One recorder in this project
declined the trade and left the note behind in its source — *"the offending
bytes stay behind: Event 6 has no field to carry them"* — which is the gap
these keys close.

#### `"ek"` — error kind

An open vocabulary. This revision names `"protocol"` (the peer violated the
protocol), `"transport"` (the QUIC or WebTransport layer failed), and
`"decode"` (bytes that would not parse as any message this recorder knows).
Other values MAY be used and MAY be added without a version bump; readers MUST
preserve a value they do not recognise and MUST NOT reject the event, as with
[`"perspective"`](#perspective).

`"ek"` is spelled in full rather than as `"kind"` because `"kind"` is already a
top-level key on [Event 10](#event-10-subscription-derivation) with the
vocabulary `"created"` / `"shared"`. Two vocabularies under one key at the same
map level survive in a typed reader and break in every flat projection of a
trace — a JSONL export, a warehouse load, a column-oriented viewer — where
`kind` becomes one column holding both.

#### `"raw"` is capped, and `"rawlen"` says whether the cap bit

**A recorder MUST NOT write more than 4096 bytes in `"raw"`.** Where it holds
more, it writes the first 4096 and records the full length in `"rawlen"`.

The cap is a MUST and a fixed number rather than a SHOULD and a suggestion,
because Event 6 is [non-droppable](#non-droppable-event-types). Every other
high-volume field in this format is bounded by sampling; this one cannot be,
so if it is not bounded here it is not bounded at all. A peer opening ten
thousand streams and sending garbage on each is not a hypothetical — it is
what a fuzzer does to a relay, and a trace of it should not be larger than the
attack. A number a reader can test also means the corpus can hold a case
proving the cap was applied rather than merely described; "SHOULD keep it
small" cannot be tested by anyone.

4096 was chosen against two known quantities. It is far above what control
messages actually measure: the largest encoded control message across every
draft in the shared codec vectors is 95 bytes, and each of the four real
third-party captures in the conformance corpus is under 3 kB *in total*,
control messages, object headers and all. And it sits well below
`MAX_MESSAGE_LENGTH`, the 65535-byte ceiling the protocol itself puts on a
control message from draft-11 onward — deliberately below, because `"raw"`
exists for diagnosis and not for replay. A message can legitimately be larger
than the cap; the cap is not a claim that it cannot. A fault that leaves no trace in the
first 4096 bytes is a real possibility, and it is what `"rawlen"` is for: the
reader learns that the record is partial and how much is missing, which is
enough to go and ask for the rest.

**`"rawlen"` sits at `headers+sizes`, not at `full` and not at `control`.** It
is available in every trace where `"raw"` MUST NOT appear, which is the point
of having it: how large a malformed message was is often enough on its own to
separate a truncated message from a mistyped one, and it carries no content.

It is nonetheless a **size**, and this format gates sizes deliberately —
`headers+sizes` exists precisely to mean "how much, but not what". Putting
`"rawlen"` at `control` would let a `control`-level trace carry a fact about
data-stream volume that its own declared level excludes, because Event 6's
`"sid"` may name a data stream: the length would then be the size of a run of
media framing. One number is a small leak, but the latch below bounds `"raw"`
and not `"rawlen"`, so on a repeatedly failing stream it is a *sequence* of
sizes, which is the shape traffic analysis wants. Gating it with the other
sizes costs a `control`-level trace one diagnostic and keeps each level's
promise exactly what it says.

A recorder at `headers+sizes` or above SHOULD write it whether or not it is
also writing the bytes.

When `"raw"` is present, `"rawlen"` SHOULD be present too, and a reader MAY
take `rawlen > len(raw)` as the definition of a truncated capture. If
`"rawlen"` is absent, a `"raw"` of exactly 4096 bytes MUST be treated as
possibly truncated, since that is the one length the cap makes ambiguous.

**A recorder that does not know the true length MUST omit `"rawlen"` rather
than write the length it happens to hold.** This is the case the key is most
easily got wrong in, and it defeats the key entirely. A recorder that stops
*reading* at the cap — which is the sensible thing to do with a stream that
will not parse, and what the recorder cited below does — never holds more than
4096 bytes. Writing `rawlen` as 4096 there says `rawlen == len(raw)`, which is
this section's own signal for **not truncated**: the field would assert
completeness precisely when the recorder has the least idea whether the input
was complete. Omitting it falls through to the rule above, where a `"raw"` of
exactly the cap is treated as possibly truncated, which is the truth.

Where the length *is* knowable without keeping the bytes, write it. A
length-prefixed control message supplies it from its own length field, and a
recorder that read that prefix and then gave up on the body knows exactly how
much it did not keep. That is the case `"rawlen"` exists for, and it is common:
the fault is often the body, and the prefix is what got the recorder as far as
noticing.

**The cap binds the recorder, and nothing else.** It is addressed to the party
deciding what to say about traffic it has just observed. It is *not* addressed
to a tool that reads an event and serializes it again: a reader meeting a
`"raw"` longer than 4096 bytes MUST NOT reject the event, and a rewrite MUST
NOT shorten it. That is [the reader rule outranking the writer
rule](#versioning-and-compatibility), and this is the case it exists for.
Re-truncating someone else's file destroys evidence in order to make it conform
to a rule that was never addressed to the tool doing the truncating. Report the
non-conformance if it is worth reporting; do not repair it.

The distinction has a consequence worth stating for implementers, because
getting it wrong is easy and the result is silent. **A serializer is the wrong
place to enforce this cap.** A serializer cannot tell a freshly recorded event
from one that arrived by being read, so a cap applied there either truncates
evidence on rewrite or rejects a file the reader was required to accept —
whichever it does, it does to the wrong events. The cap belongs where the event
is *constructed from observed bytes*.

#### One `"raw"` per flow

**A recorder MUST NOT emit `"raw"` more than once per flow** — per stream where
the error names one, per peer where it does not, and once for the whole
recording where it writes no peer identifier either. That last case is every
recorder but a relay tap, since `"p"` is only required of one: the three
collapse to "the narrowest scope the recorder can name", and a recorder that
can name none has one flow. Later errors on a flow that
has already carried its bytes are still recorded; they simply carry no `"raw"`.

The latch is on the field, not on the event, and the distinction is the whole
point. Event 6 is non-droppable: suppressing the *event* would discard the
causal record this document elsewhere forbids discarding, and would do it
precisely when a peer is misbehaving repeatedly, which is when the record
matters most. What actually grows without bound is the bytes, so that is what
is bounded. The first failure on a flow is the diagnostic one in any case —
once a stream will not parse, a recorder is no longer interpreting what
follows, so the "bytes" of the second error are the same undifferentiated run
as the first.

This matches what a recorder in this project already does, one level up: its
control-stream reader latches on the first undecodable run and stops reading
that stream, capping the kept bytes at 4096. This section takes that behaviour,
which was chosen for a panel display, and makes it the format's rule.

### Event 7: Annotation

| Key       | Type        | Detail Level | Description                       |
| --------- | ----------- | ------------ | --------------------------------- |
| `"label"` | text string | any          | User-defined label                |
| `"data"`  | any         | any          | User-defined data (any CBOR type) |

### Event 8: Peer Connected

Emitted by `"relay-tap"` recorders when a new peer session is established through the relay.

| Key            | Type        | Detail Level | Description                                                                          |
| -------------- | ----------- | ------------ | ------------------------------------------------------------------------------------ |
| `"p"`          | text string | `control`+   | Peer identifier (source-local); subsequent events from this peer carry the same `"p"`. |
| `"endpoint"`   | text string | `control`+   | Peer-reported endpoint URI or remote address (best-effort). Optional.                |
| `"transport"`  | text string | `control`+   | Transport type (`"webtransport"`, `"raw-quic"`, etc.). Optional.                     |
| `"role"`       | text string | `control`+   | `"publisher"`, `"subscriber"`, or `"both"` if known at connection time; else absent. |
| `"side"`       | text string | `control`+   | `"downstream"` if the peer connected *to* this relay; `"upstream"` if this relay connected *to* the peer (origin or upstream relay). Absent for non-relay perspectives. Identifies the connection direction, not subscription causality — see Event 10 for subscription chains. |

### Event 9: Peer Disconnected

| Key        | Type        | Detail Level | Description                                              |
| ---------- | ----------- | ------------ | -------------------------------------------------------- |
| `"p"`      | text string | `control`+   | Peer identifier (matches the corresponding event 8).     |
| `"ec"`     | integer     | `control`+   | Error/close code (0 = clean close).                      |
| `"reason"` | text string | `control`+   | Human-readable reason. Optional.                         |

### Event 10: Subscription Derivation

Emitted by `"relay-tap"` recorders when an upstream subscription is causally created or extended to satisfy one or more downstream subscriptions. This is the structural primitive for multi-hop correlation: the collector reconstructs end-to-end trace trees from these derivation links plus `"traceId"` propagation (see [Trace ID Propagation](#trace-id-propagation)).

The same event is emitted again when an additional downstream subscription is satisfied by an existing upstream subscription (subscription fan-in over time) — the `"d"` array reflects all currently linked downstream subs at emission time.

| Key         | Type                  | Detail Level | Description                                                                             |
| ----------- | --------------------- | ------------ | --------------------------------------------------------------------------------------- |
| `"u"`       | array `[text, uint]`  | `control`+   | `[upstream-peer-id, upstream-request-id]` — the upstream subscription. Peer IDs are source-local. |
| `"d"`       | array of arrays       | `control`+   | List of `[downstream-peer-id, downstream-request-id]` pairs causing/sharing this upstream sub. |
| `"kind"`    | text string           | `control`+   | `"created"` (new upstream sub) or `"shared"` (existing upstream sub now serving an additional downstream sub). |
| `"traceId"` | byte string           | `control`+   | Optional. 16-byte trace ID propagated via the `MOQTAP_TRACE_ID` extension parameter (see [Trace ID Propagation](#trace-id-propagation)). |
| `"ns"`      | array of byte strings | `control`+   | Optional. Track namespace the subscription targets, one byte string per namespace field. |
| `"tn"`      | byte string           | `control`+   | Optional. Track name the subscription targets.                                          |
| `"tdr"`     | integer               | `control`+   | Optional. Timestamp at which the downstream SUBSCRIBE was received.                     |
| `"tus"`     | integer               | `control`+   | Optional. Timestamp at which the upstream SUBSCRIBE was transmitted. Absent for terminal subscriptions, where the relay is the content origin. |
| `"tuo"`     | integer               | `control`+   | Optional. Timestamp at which SUBSCRIBE_OK was received from upstream. Absent for terminal or still-in-flight subscriptions. |
| `"tdo"`     | integer               | `control`+   | Optional. Timestamp at which SUBSCRIBE_OK was transmitted downstream. Absent for still-in-flight subscriptions. |

**Timestamps.** `"tdr"`, `"tus"`, `"tuo"` and `"tdo"` use the same timebase as the common `"t"` field — microseconds since the containing segment's `startTime`, on the emitting source's clock. Differences between them are therefore meaningful without any cross-hop clock agreement, which is the point: they measure how long *this* relay took, not when two relays each think it was. A consumer MUST NOT subtract a timestamp produced by one source from one produced by another.

**Emission and update.** A source SHOULD emit this event as soon as the downstream SUBSCRIBE is received, carrying whichever timestamps are known at that moment, and MAY emit further events for the same `(u, d)` pair as later timestamps become available. A consumer MUST treat a later event for the same pair as an update, overwriting earlier field values, rather than recording a second derivation.

**Track identity is optional but recommended.** `"ns"` and `"tn"` are not required — the pair can in principle be recovered by correlating request IDs against the SUBSCRIBE control-message events. Including them makes the event self-contained, which matters when the trace is filtered, sampled at the control-message level, or joined across sources that do not share a control-message stream.

## Sampling

When the source dropped, sampled, or filtered events before writing them, the header SHOULD include a `"sampling"` map so consumers know they are seeing a partial view.

| Key                | CBOR Type        | Required | Description                                                                                              |
| ------------------ | ---------------- | -------- | -------------------------------------------------------------------------------------------------------- |
| `"effectiveRate"`  | float            | No       | Effective fraction of source events retained, in `(0.0, 1.0]`. `1.0` means no rate-based dropping.       |
| `"maxEventsPerSec"`| unsigned integer | No       | Per-segment cap that triggered drops, if rate-limited.                                                   |
| `"dropPolicy"`     | text string      | No       | Drop strategy when the cap was exceeded: `"head"`, `"tail"`, or `"sampled"`.                             |
| `"droppedTotal"`   | unsigned integer | No       | Cumulative events dropped since `startTime`. In segmented traces, this is the running total at segment start. |
| `"droppedSegment"` | unsigned integer | No       | Events dropped within this segment only. Only meaningful when `"segment"` is present.                    |
| `"rule"`           | text string      | No       | Source-side filter rule that selected events (e.g., `"namespace prefix=foo/bar"`).                       |
| `"ruleLang"`       | text string      | No       | Filter language identifier: `"prefix"`, `"suffix"`, `"glob"`, `"cel"`, etc.                              |
| `"appliesTo"`      | array of int     | When sampling is active | Event type IDs to which the drop policy was applied.                                        |

A reader that sees a `"sampling"` map SHOULD surface the fact that the trace is partial. A trace without `"sampling"` is presumed complete relative to the declared detail level.

### Non-droppable Event Types

Some event types carry causal or structural information that is destroyed by random sampling — a SUBSCRIBE without its SUBSCRIBE_OK, a state change with no following events, a peer-disconnect with no matching peer-connect — yielding a misleading trace. Sources MUST NOT drop or sample the following event types under any drop policy:

- Event `0` — Control message
- Event `5` — State change
- Event `6` — Error
- Event `8` — Peer connected
- Event `9` — Peer disconnected
- Event `10` — Subscription derivation

If a source cannot keep up with the rate of these event types, it MUST refuse the recording or subscription rather than emit a sampled trace. Source-side **filtering** (e.g., dropping all events for namespace `foo/bar`) is not sampling and remains permitted — filtered traces are still causally complete with respect to what passed the filter.

Sampling MAY apply to the high-volume event types: `1` (Stream opened), `2` (Stream closed), `3` (Object header), `4` (Object payload), and `7` (Annotation). When sampling is applied, `"appliesTo"` MUST list the affected event types; readers MAY then assume non-listed event types are complete.

## Trace ID Propagation

For end-to-end correlation across multiple relays and clients, moqtap defines a `MOQTAP_TRACE_ID` extension parameter (see the moqtap draft for the assigned parameter ID) carried on SUBSCRIBE messages. The trace ID is a **16-byte opaque identifier** that:

- Is generated by the originating endpoint (publisher client, subscriber client, or first moqtap-aware relay if no upstream party set one).
- MUST be propagated unchanged onto upstream SUBSCRIBEs that a relay creates to satisfy a downstream SUBSCRIBE carrying it.
- SHOULD appear as the `"traceId"` field on Event 10 (Subscription Derivation) and MAY appear on any other event whose triggering subscription carries one.
- Allows a moqtap collector to stitch traces from multiple sources (clients pushing moqtraces, relays exposing tap tracks) into a unified end-to-end view, with no topology configuration required.

**The trace ID is carried as raw bytes at every layer** — a 16-byte parameter value on the wire, a 16-byte CBOR byte string in `"traceId"`. It is never hex-encoded, base64-encoded, or otherwise transformed. This is not a stylistic preference: stitching only works if two independently written implementations produce byte-identical values for the same subscription chain, and every encoding step is a place for them to disagree. A source holding a trace ID whose length is not exactly 16 bytes MUST treat it as malformed rather than pad, truncate, or re-encode it.

Privacy: trace IDs reveal subscription patterns across operator boundaries. Relay operators MAY hash, replace, or strip the trace ID at egress per their policy. The moqtap draft documents the recommended defaults.

## Privacy Considerations

Trace recording ranges from protocol-metadata-only (low sensitivity) to full media capture (very high sensitivity). Implementers and operators MUST treat the following as elevated-risk capabilities:

1. **Payload-bearing events and fields.** These carry or reveal user content:
   - Event 4 `"pl"` (object payload bytes, `"headers+data"`+)
   - Event 0 `"raw"` (raw control-message bytes, `"full"`)
   - [Event 6](#event-6-error) `"raw"` (the bytes behind an error, `"full"`).
     Easy to overlook, because an error event sounds like metadata: its
     `"sid"` may name a *data* stream, in which case the bytes behind the
     error are subgroup framing and object payload — media, arriving through
     the one event type sampling may never drop.
   - Detail levels `"headers+data"` and `"full"` in aggregate

   Capturing them is **optional** for all conformant recorders. Observer- and tap-based capture of these fields is equivalent to intercepting user media; recorders MUST NOT enable it by default and SHOULD require explicit operator opt-in per session or per track. The default detail level for general-purpose tools SHOULD be `"control"` or `"headers"`.

2. **Payload size leakage.** Even without payload bytes, `"headers+sizes"` reveals object sizes, which can fingerprint media content. [Event 6](#event-6-error)'s `"rawlen"` belongs to this class rather than to the one above — it is gated with the sizes for that reason — and it leaks a little differently: the one-`"raw"`-per-flow latch does not bind it, so a stream that fails repeatedly yields a *sequence* of sizes rather than a single one. Operators handling sensitive traffic SHOULD evaluate size leakage as part of their threat model.

3. **Trace ID correlation.** `MOQTAP_TRACE_ID` enables cross-operator correlation of subscription behavior. See [Trace ID Propagation](#trace-id-propagation) for egress mitigations.

4. **Peer identifiers.** The `"p"` field is source-local but may encode address- or user-identifying information if the source chooses to. Publishers of traces SHOULD redact or opaquely hash `"p"` before sharing traces outside the recording operator's trust boundary.

5. **Passive (observer / relay-tap) capture.** Perspectives `"observer"` and `"relay-tap"` record traffic that the recording party is not a direct participant in. Operators MUST ensure they have authorization to record such traffic under applicable law and session-setup consent; this specification does not grant such authorization.

Retention, access control, and disclosure of `.moqtrace` files are out of scope here but are expected to be governed by the deploying operator's policy.

---

# Part 2: `.moqtrace` Binary File Format

A `.moqtrace` file serializes the event model above to a self-describing CBOR container.

## File Layout

```
Offset  Length  Content
------  ------  -------
0       8       Magic bytes: "MOQTRACE" (0x4d4f515452414345)
8       4       Format version (uint32 LE) — currently 2
12      4       Header length (uint32 LE) — byte length of the CBOR header blob
16      N       Header (CBOR map) — session metadata and recording configuration
16+N    ...     Event stream (CBOR sequence) — concatenated CBOR items, one per event
```

A **segmented** trace is a concatenation of one or more such layouts back-to-back; each segment begins with magic bytes and is independently parseable. See [Segmented Traces](#segmented-traces).

### Magic Bytes

The 8-byte ASCII string `MOQTRACE` identifies the file format. Any tool can check these bytes before attempting to parse. In segmented traces, the same bytes also serve as a segment delimiter — readers can resync to the next segment by scanning for the magic.

### Format Version

uint32 little-endian. Currently `2`. See [Versioning and Compatibility](#versioning-and-compatibility) for which versions a reader must accept.

### Header Length

uint32 little-endian. The byte length of the CBOR-encoded header that immediately follows. This allows readers to extract metadata without scanning the event stream — useful for file browsers, search indexing, and quick filtering ("show me all draft-17 client traces").

## Header

A single CBOR map with the following keys:

| Key             | CBOR Type   | Required | Description                                                                                              |
| --------------- | ----------- | -------- | -------------------------------------------------------------------------------------------------------- |
| `"protocol"`    | text string | Yes      | MoQT version identifier (e.g., `"moq-transport-17"`, `"moq-transport-rfc9999"`)                          |
| `"perspective"` | text string | Yes      | Recording viewpoint: `"client"`, `"server"`, `"observer"`, or `"relay-tap"`                              |
| `"detail"`      | text string | Yes      | Detail level (see [Detail Levels](#detail-levels))                                                       |
| `"startTime"`   | unsigned integer | Yes | Recording start time (Unix epoch milliseconds). Unsigned: a trace from before 1970 is a clock fault, not a recording, and a reader that accepts one has no way to say so.                                                           |
| `"transport"`   | text string | No       | Transport type (e.g., `"webtransport"`, `"raw-quic"`)                                                    |
| `"endTime"`     | unsigned integer | No  | Recording end time (Unix epoch milliseconds). Written when trace is finalized.                           |
| `"source"`      | text string | No       | Software that produced the trace (e.g., `"moqtap-devtools/0.1.0"`, `"my-relay/2.3.1"`). Also serves as the namespace for source-local `"p"` values. |
| `"endpoint"`    | text string | No       | Remote peer URI (e.g., `"https://relay.example.com/moq"`)                                                |
| `"sessionId"`   | text string | No       | Capture-correlation identifier — see [Identifier Scoping](#identifier-scoping).                          |
| `"segment"`     | map         | No       | Segment metadata; present iff this trace is one segment of a segmented stream. See [Segmented Traces](#segmented-traces). |
| `"sampling"`    | map         | No       | Sampling/filter metadata; present iff events were sampled or filtered at the source. See [Sampling](#sampling). |
| `"custom"`      | map         | No       | User-defined metadata (arbitrary key-value pairs). `"payloadMasked": true` here indicates payload masking is active. |

### Unrecognised keys in the header

[Versioning and Compatibility](#versioning-and-compatibility) requires a reader
that writes a trace back out to preserve the unrecognised keys it read, in
"header maps or event maps". This section says what that means for the header,
because the header is where the rule was least obviously binding and where both
reference implementations broke it: each read a header, dropped every key it
did not know, and wrote out a file that looked as though it had never carried
them.

**Three maps in the header have keys this document names**: the header map
itself, `"segment"`, and `"sampling"`. Each MUST carry its own
unrecognised-key store, and each store MUST be written back into the map it
came from. One store for the whole header would not do — a private key on
`"segment"` and a key of the same name at the top level are different keys, and
re-emitting either in the other's map changes what the file says.

Everything the [key-preservation rules](#versioning-and-compatibility) say
about events applies here unchanged, reading "header" for "event" and "the
segment" for "the event":

- A key this document does not define goes to the store of the map it appeared
  in, and is written back from there.
- A key this document *does* define, carrying a value the reader cannot use,
  goes to that same store. Knowing more about a key must not mean preserving it
  less. `"transport": 42` is not a transport; it is also not nothing.
- Which values are usable is settled by [the same
  list](#versioning-and-compatibility) — integral floats yes, fractional no,
  negative no for a key defined as unsigned, and no rounding of a value the
  reader cannot represent.
- **The range clause binds only where this document states a range.** In the
  header that is one key: `"effectiveRate"`, defined as lying in `(0.0, 1.0]`.
  A rate of `1.5`, of `0.0`, or of NaN is unusable and goes to the sampling
  store. This is a semantic check rather than a type check and it is the only
  one in the header, deliberately — every other key here is bounded by its type
  alone, and a reader inventing bounds this document does not state would start
  rejecting values a future revision means to allow. The reason `"effectiveRate"`
  earns the check is that consumers divide by it: a rate of `0.0` handed to a
  caller reconstructing true event counts is a division by zero, and `1.5` is a
  count larger than what was recorded.
- **A value under a CBOR tag is unusable**, tag 64 excepted. This format uses
  no tags; a writer MUST NOT emit one. Tag 64 is the exception readers already
  MUST accept for byte strings (see [Interoperability](#interoperability)), and
  a reader that unwraps it and re-emits the bytes as major type 2 has done what
  that rule asks — so "written back unchanged" binds the value, not its
  encoding. Any other tag is a shape this document gives no meaning, and it
  goes to the store with its tag intact where the reader can hold one.

#### A composite value is usable only as a whole

`"sampling.appliesTo"` is an array of event type IDs. If one element is not
one, the array is unusable and goes to the store **entire**. A reader MUST NOT
keep the elements it liked and discard the rest.

This is the shape where discarding is not merely lossy but wrong. An
`"appliesTo"` of `[3, "x", 5]` read as `[3, 5]` is not a partial answer: the
key names the event types the drop policy touched, and every type absent from
it may be treated as complete. Shortening the array therefore reports a sampled
event type as fully recorded — the opposite of what the file said, stated with
the same confidence. The same reasoning governs `"ns"` on Event 10, and any
array or map a future key defines.

#### `"custom"`, and values a reader cannot hold

`"custom"` is not one of the three maps above: every key in it belongs to
whoever wrote the trace, so there is no such thing as an unrecognised key
there and it needs no store. It is a passthrough. A reader MUST hand back what
the file carried, key for key and value for value, and MUST write back what it
was handed.

A reader whose representation cannot hold that map exactly MUST treat
`"custom"` as unusable and route the whole value to the *header's* store,
rather than hand back a version of it that lost something. Both reference
implementations declare `"custom"` as a string-keyed map, so for them a
`"custom"` that is not a map at all is unusable — and so is one carrying a
non-text key, *where the reader can see that it does*; the next subsection
explains why that qualifier is not a loophole. Losing typed access is the
smaller harm: nothing in this document gives `"custom"` keys meaning, so there
is nothing to lose but convenience, and the bytes survive.

A reader whose decoder happens to hand back a shape its own declared type
cannot describe — a map object where a string-keyed record was promised — is
not thereby conformant. It is preserving the bytes by accident, through a type
that lies to every caller reading the field, and the first caller to iterate
the keys finds a shape it was told could not occur. Route the value to the
store and keep the field's type true.

That generalises to a test worth applying to every key in this section:
**can this reader write back exactly what it read?** Where it can, the value
belongs in the field. Where it cannot, the value belongs in the store. A
reader that answers "no" and keeps the field anyway is the defect this section
exists to name.

#### Keys in these maps are text

Every key this document defines — in the header map, in `"segment"`, in
`"sampling"`, and by the nature of the field in `"custom"` — is a text string,
and **a writer MUST NOT emit a key of any other kind.**

What a reader does with one is deliberately left undefined, and nothing may
depend on two readers agreeing about it. The reason is worth stating, because
the obvious rule is one that cannot be implemented: **some CBOR decoders
cannot tell.** A decoder that returns maps as language-native objects coerces
the integer key `1` into the text key `"1"` before any code written against
this document runs, at which point it is indistinguishable from a text `"1"`
the same map might also carry — and the two collide. One of the two reference
implementations decodes exactly this way. Requiring it to report the
difference would be requiring something it cannot observe, and a specification
that mandates the impossible teaches implementers which of its rules to skip.

This is one instance of a general problem, not a special case: see [Shapes a
CBOR library may normalise before you see them](#shapes-a-cbor-library-may-normalise-before-you-see-them)
for the full list and the rule that governs all of it. A non-text key is the
most obvious member; the text key `"__proto__"`, a duplicate key, and CBOR
`undefined` are others, and each is invisible to at least one of the two
reference implementations.

So the requirement lands on the writer, where it can be met. What a reader
MUST NOT do is **re-key** — turn an integer key into a text key and write that
back — because the result is a file asserting a key the original never carried,
possibly colliding with a real one. A reader that can hold the key as it found
it SHOULD do exactly that and preserve it in the store; a reader whose decoder
has already re-keyed it before it was asked is not thereby non-conformant,
having never had the choice.

Rejecting the header is *not* the recommended answer here, which is worth
saying because an earlier draft of this section recommended it. Failing the
header loses every event behind it, and this subsection would then be
prescribing, for the most capable reader, the most destructive outcome — the
same harm the `"segment"`/`"sampling"` subsection below forbids for a value it
merely cannot use. Preserve it and move on. This is the one place in this
section where the two implementations are permitted to differ, and it is
permitted only because no conformant file reaches it.

#### `"segment"` and `"sampling"` are optional keys

A `"segment"` or `"sampling"` that is not a map MUST NOT fail the file. It goes
to the store like any other unusable optional value. A reader that rejects the
file instead has turned one unreadable metadata value into the loss of every
event behind it.

**But an unusable `"segment"` is not an absent one.** [Segmented
Traces](#segmented-traces) requires a reader to treat an absent `"segment"` as
"this is a complete, single-segment file", and that assertion MUST NOT be made
here: the file said it was a segment and the reader merely could not place it.
Making it would be the same invention as defaulting `"sequence"` to `0`, and
worse in a segmented stream, where a segment read as non-segmented has its
`"n"` and `"t"` taken as file-global when they are segment-local, silently
misordering every event in it.

No new field is needed to tell the two apart: the unusable value is sitting in
the header's store under the key `"segment"`, so a reader that finds it there
knows exactly which case it is in. What it MUST NOT do is answer "complete
single-segment file" to a caller that asks.

`"segment.sequence"` is the exception, and the only key in the header whose
absence or unusability makes the header itself malformed. It is the sole
ordering key of a segmented stream: a reader that cannot read it cannot place
the segment, and a default invents an order the file never had. The four
required top-level keys — `"protocol"`, `"perspective"`, `"detail"`,
`"startTime"` — are malformed on the same terms, there being no header to
construct without them.

Malformed here means malformed *for that segment*. A reader MUST report it and
MUST NOT present the segment as read; it MAY continue to the next segment, on
the same terms as [a malformed event](#versioning-and-compatibility). What it
MUST NOT do is return a header it invented — a required key filled in with a
default, an empty string, or a language's null standing in for a value the file
never carried. That reader reports a fabricated trace as a real one, which is
worse than reporting nothing.

#### The store is written last, and never twice

A store entry whose key the surrounding map already writes MUST NOT be written
a second time. A reader never produces such an entry — a key it recognised and
used is by definition not unrecognised — but a caller assembling a header by
hand can, and a CBOR map carrying one key twice is a map no two readers need
agree on. The field wins and the store entry is dropped. Event serialization
already resolves the collision this way.

### Protocol Identifier

The `"protocol"` field identifies the MoQT version without assuming lifecycle stage. Use the IETF document name minus the `draft-ietf-` prefix for drafts, and the RFC number for published standards:

- Draft phase: `"moq-transport-07"`, `"moq-transport-17"`
- RFC phase: `"moq-transport-rfc9999"`

### Perspective

The `"perspective"` field describes the vantage point of the recording:

- `"client"` — captured at the MoQT client (initiator of the QUIC connection)
- `"server"` — captured at the MoQT server or relay (single-session view from inside the endpoint)
- `"observer"` — passive capture (e.g., DevTools extension, network tap) that intercepts traffic without participating in the session
- `"relay-tap"` — active capture from inside a relay, reporting on **multiple** concurrent peer sessions through that relay. Distinct from `"server"` because events span peers; see the `"p"` field on events.

A reader that encounters a perspective value it does not recognize MUST NOT reject the trace. New values may be added without a version bump, and every event in the file remains parseable regardless. Preserve the value verbatim and surface it to the caller.

## Event Stream

After the header, the remainder of the file (or segment) is a sequence of concatenated CBOR items (one per event). This is a standard CBOR sequence (RFC 8742) — no array wrapper, no separators. Event contents are defined in [Part 1](#part-1-event-model-normative).

## Segmented Traces

A **segmented trace** is a sequence of self-contained `.moqtrace` blobs concatenated back-to-back. Each segment is independently parseable and includes its own magic bytes, format version, header, and event sequence. This enables:

- **On-disk capture rotation.** A long-running recorder can rotate to a new segment every N seconds or M megabytes without finalizing the file; consumers process completed segments while the recorder writes the next.
- **Live carriage.** A transport that wants to carry a `.moqtrace` stream live uses segment boundaries as its cut points — see [Appendix A](#appendix-a-moqt-carriage-convention-informative).
- **Best-effort recovery.** If a segment is truncated or corrupt, readers can skip forward to the next magic-byte sequence and resume.

A trace is segmented iff its header contains a `"segment"` map:

| Key                | CBOR Type        | Required | Description                                                                                                |
| ------------------ | ---------------- | -------- | ---------------------------------------------------------------------------------------------------------- |
| `"sequence"`       | unsigned integer | Yes      | 0-based sequence number of this segment within the stream. Monotonically increasing, no gaps in a single source. |
| `"durationMs"`     | unsigned integer | No       | Nominal segment duration in milliseconds (hint to readers; actual duration may differ).                    |
| `"streamId"`       | text string      | No       | Opaque identifier shared across all segments of the same logical stream.                                   |
| `"continues"`      | boolean          | No       | `true` if this segment continues a previous one with the same `streamId`. `false` (or absent) for the first segment. |

Within a single segmented stream:

- The `"protocol"`, `"perspective"`, `"detail"`, and `"sessionId"` fields MUST be identical across all segments.
- `"startTime"` in each segment header refers to that segment's start, NOT the stream's start.
- Event `"n"` (sequence number) and `"t"` (timestamp) are **segment-local** in segmented traces: they restart at 0 in each segment. Readers stitching segments together compute global ordering from `(segment.sequence, n)`.
- `"sampling.droppedTotal"` is cumulative across the stream; `"sampling.droppedSegment"` is local to the segment.

A non-segmented trace MUST NOT include a `"segment"` field. Readers MUST treat the absence of `"segment"` as "this is a complete, single-segment file."

## Reading a `.moqtrace` File

```
1. Read 8 bytes, verify magic == "MOQTRACE"
2. Read 4 bytes (uint32 LE) → format version. Reject if unsupported.
3. Read 4 bytes (uint32 LE) → header length N.
4. Read N bytes → CBOR-decode to get header map.
5. Read CBOR items one at a time:
   - If the next 8 bytes are the magic "MOQTRACE", a new segment begins —
     loop back to step 2 (segmented trace).
   - Otherwise, CBOR-decode one item → one event map.
   - Stop at EOF.
```

A reader that does not implement segmented mode MAY treat the first occurrence of `MOQTRACE` after byte 0 as EOF for the current trace.

If the stream ends part-way through a CBOR item, the file was truncated — a crashed recorder, an interrupted transfer. Readers SHOULD report this distinctly from a clean end-of-file, and SHOULD return the events decoded up to that point rather than discarding them. A truncated trace is still evidence, and the events before the cut are exactly as valid as they were.

## Writing a `.moqtrace` File

### Single-segment (file) writer

```
1. Write magic bytes "MOQTRACE"
2. Write format version (uint32 LE, currently 2)
3. CBOR-encode the header map → get header bytes
4. Write header length (uint32 LE)
5. Write header bytes
6. For each event:
   - CBOR-encode the event map
   - Append to file
7. When finalizing:
   - Optionally seek back and update header (e.g., set endTime)
   - Or accept that endTime may be absent in crash-truncated files
```

### Segmented writer (file rotation)

```
1. For each segment:
   a. Construct the segment header (include "segment.sequence", increment per segment).
   b. Emit magic + version + headerLen + header bytes.
   c. Emit one or more event CBOR items.
   d. Close the segment (file rotation, etc.).
2. The next segment begins fresh at step 1a; do NOT carry over event "n" or "t".
```

## Versioning and Compatibility

- **Version 2** is defined by this document. **Version 1** is defined by the previous revision.
- **Writers SHOULD write version 2.**
- **Readers MUST accept both version 1 and version 2, and MUST reject any other version.** A version-1 file is exactly a non-segmented version-2 trace without the keys this revision adds, and every added key is optional. Accepting version 1 therefore costs a reader nothing and keeps every previously recorded capture readable.
- Unknown keys in header maps or event maps MUST be ignored (forward-compatible). For the header specifically, see [Unrecognised keys in the header](#unrecognised-keys-in-the-header) — the header has three maps with named keys, not one, and each keeps its own.
- **A reader that writes a trace back out MUST preserve the unrecognised keys it read**, on a recognised event type as much as on an unrecognised one, and in the header as much as in an event. "Ignore" above means read past, not discard. Skipping a key costs a reader nothing; dropping it costs every reader downstream, because the output is a valid file that looks like it never carried the key — and the tools that read and rewrite traces are exactly the ones a trace passes through on its way to someone else: a redaction pass, a filter, a re-segmentation, a download with annotations applied.
- Optional keys MAY be added to an existing event type without a version bump — `"sid"` on event 0 was added this way. A reader must therefore treat any optional key as absent-by-default rather than assuming files of a given version all carry the same keys.
- New event types (`"e"` values) MAY be added without a version bump; readers MUST skip unknown event types rather than failing. A reader that rejects an unknown `"e"` value turns every future addition into a breaking change.
- New `"perspective"` and `"detail"` values MAY likewise be added; see [Perspective](#perspective).
- **A defined key whose value has an unusable type is treated as unrecognised.**
  If this document says `"ta"` is an integer and a file carries `"ta": "hello"`,
  a reader cannot use the value — but it MUST NOT delete it. The key goes to the
  unrecognised-key store, is ignored for meaning, and is written back unchanged,
  exactly as a key the reader had never heard of would be. A reader that knows
  more about a key must not therefore preserve it less. "Unchanged" binds the
  value, not its position: such a key is written wherever the store is emitted,
  which is generally after the keys the event type owns rather than where the
  key originally sat. CBOR maps are unordered, so this loses nothing — but a
  byte-for-byte diff against the input will show it.

  This matters most where it is least expected: adding a key to a reader's
  vocabulary must never *reduce* what that reader preserves. Before a key is
  defined, a wrong-typed value survives as an unrecognised key; after, a reader
  that simply type-checks and moves on drops it. Both reference implementations
  did precisely that when Event 1's keys were added, and lost values they had
  previously kept.

  Two bounds on the rule. A **required** key with an unusable type is a
  malformed event, indistinguishable from that key being absent, because there
  is no event to construct without it. And an unusable **optional** key MUST NOT fail
  the event at all — it is the case this whole rule exists for, and the value
  goes to the store.

  That bound is about the event, not the API. Whether a malformed event ends the
  read is a property of how a reader is driven: a streaming reader whose
  idiomatic use collects into a fallible result stops at the first one, so for
  that caller failing an event *is* failing the file. Readers MAY stop and MAY
  continue, but MUST make which one is happening visible to the caller, and MUST
  NOT report a partial event list as a complete one. Two conformant readers can
  return different event counts for the same malformed file; nothing may depend
  on them agreeing.

  **What "unusable" means**, because two readers that draw this line differently
  disagree about which values reach a field and which reach the store — and that
  disagreement is invisible until someone diffs their output:

  - A CBOR integer and a float with an integral value are both usable for an
    integer key. Files carrying the float form exist and readers already MUST
    accept them (see [Interoperability](#interoperability)); this rule does not
    take that back.
  - A number with a fractional part is **unusable** for an integer key.
  - A negative value is **unusable** for a key this document defines as
    unsigned. Every identifier here is a wire varint and has no negative form.
  - A value outside the range the key's meaning allows is **unusable** where the
    key is optional — `"sg"` as `-1`. Where the key is **required**, a reader
    that can represent the value MUST still build the event: `"pp": 999` is a
    number no conformant writer produces, but discarding the event loses far
    more than the odd priority does. Report it if you like; do not delete it.
    A required value the reader genuinely cannot represent remains malformed,
    which is the same outcome as the key being absent.
  - An implementation that holds a key in a type narrower than the key's range
    MUST treat an unrepresentable value as unusable rather than rounding it.
    Rounding invents a value the file never carried. This is why the identifier
    keys must be held in a 64-bit-capable type: in a language where the ordinary
    number type stops being exact at 2^53, using it for a `u64` identifier makes
    that reader disagree with every other one above 2^53 — silently, and only
    for large values, which is to say only in production.
- **On a rewrite, the reader rule outranks the writer rule.** A tool that reads
  a trace and writes it back is bound by what it read, not by what a recorder
  should have written. Where this document tells a writer MUST NOT emit
  something — a `"msg"` that is not a map, a key outside its stream-type scope —
  and tells a reader to keep it, a rewrite **keeps it**. The writer rules bind a
  recorder deciding what to say about traffic it just saw; they do not license a
  redaction pass, a filter or a format converter to quietly correct someone
  else's file into one that no longer says what happened. A tool that wants to
  report non-conformance should report it, not silently repair it.
- **Keys beginning `"x-"` are reserved for private use.** No revision of this
  specification will define one, so a tool may add its own without ever
  colliding with a future key — and a conformance test can rely on such a key
  staying unrecognised. Every rule above applies to them unchanged: ignore them,
  and preserve them on a rewrite. Absent this reservation there is no key an
  implementation can be *sure* stays unknown, which matters more than it sounds:
  a test fixture built from keys borrowed from a live proposal silently stops
  testing anything the moment that proposal ships, and this specification did
  exactly that to its own corpus once.
- The detail level in the header is informational — readers MUST handle missing fields gracefully regardless of declared level.

### Why version 2 exists

Every field this revision adds is additive and would have been legal in a version-1 file under the rules above. **Segmentation is the exception, and it is the sole reason for the bump.** A segmented stream splices a preamble — magic bytes, version, header length, header — into the middle of what a version-1 reader believes is an uninterrupted CBOR sequence. That reader decodes the `M` of `MOQTRACE` (`0x4D`) as the start of a 13-byte CBOR byte string, consumes 13 bytes of the preamble, and desynchronizes with no way to recover. Nothing in version 1 lets it detect the boundary or resynchronize past it.

Declaring version 2 converts that silent corruption into an explicit rejection at byte 8. A source that never writes segmented traces could in principle keep writing version 1, but SHOULD NOT: one declared version per revision keeps the compatibility matrix a line rather than a grid.

## Interoperability

The `.moqtrace` format is shared between the JavaScript (`@moqtap/trace`) and Rust (`moqtap-trace`) implementations. A file written by either is readable by both. CBOR libraries used:

- JavaScript: `cbor-x`
- Rust: `ciborium`

Both produce deterministic CBOR output (canonical CBOR is NOT required, but map keys SHOULD be sorted for consistency).

Two encoding choices are **normative**, because a CBOR library's defaults are not necessarily readable by another CBOR library:

- **An integral value MUST be written as a CBOR integer (major type 0 or 1), not as a float.** CBOR permits a float carrying an integral value, and some encoders emit one for any number beyond 32 bits — which every epoch-millisecond timestamp is. A reader MUST nevertheless accept the float form for any integer field, rejecting only a value that is fractional or outside the range a float represents exactly, since files written that way exist.
- **A byte string MUST be written as major type 2, not wrapped in the typed-array tag 64 of RFC 8746.** A reader MUST nevertheless accept tag 64 wrapping a byte string, for the same reason.

The first rule is about the **value**, not about the type this document gives
the key. `"effectiveRate"` is defined as a float and its most common value is
`1.0` — "no rate-based dropping" — which is integral, so it is written as the
CBOR integer `1`. Conversely a reader MUST accept a CBOR integer for a key this
document types as a float, which is the mirror of the sentence above and was
left implicit for one revision too long: the two reference implementations
disagreed on exactly this value, one writing a float64 and one an integer, for
a key whose commonest setting triggers it.

Both directions are byte-level differences that preserve the number exactly.
That is the general shape of these rules: they exist so that two encoders
produce the same bytes for the same trace, not because either encoding loses
anything.

Both rules exist because both were broken in opposite directions by the two implementations, and neither test suite could see it: each read only bytes it had written itself, so each agreed with a convention the other did not implement.

This claim is maintained by a shared corpus of `.moqtrace` files that both implementations read and write as part of their test suites, covering at minimum: a version-1 file, a non-segmented version-2 file, a segmented version-2 stream, a file carrying an unknown event type, a file carrying an unknown perspective, and a truncated file. An implementation that cannot round-trip the corpus is not conformant, whatever this document says.

The corpus is [`moqtrace/` in the `test-traces` repository](https://github.com/moqtap/test-traces/tree/master/moqtrace), published as `@moqtap/test-traces`. Its `manifest.json` indexes every case with the format version, segment count, header fields, event count and event-type histogram a conformant reader must agree on, so a third implementation can use it without reading either reference implementation. Two files there carry the non-canonical encodings the rules above require readers to accept — integers as floats, and byte strings under tag 64 — because a rule with no file exercising it is a rule nobody is held to.

### Shapes a CBOR library may normalise before you see them

Every rule in this document about preserving a value assumes the reader is
handed what the file carried. Sometimes it is not. A CBOR library may normalise
a decoded value before any code written against this specification runs, and in
each case below the normalisation is invisible: the reader cannot report a
difference it was never shown.

The two reference implementations are known to do the following, and neither
can be configured out of it without changing decoders:

| Shape in the file | What one library hands back |
| ----------------- | --------------------------- |
| An integer map key, `1` | The text key `"1"` — which then collides with a real `"1"` |
| The text key `"__proto__"` | The text key `"__proto_"` — which then collides with a real `"__proto_"` |
| The same key twice † | One entry — `cbor-x` keeps the last. **`ciborium` keeps both**, so a Rust reader *can* see this one |
| CBOR `undefined` (major type 7, value 23) | CBOR `null` |
| A byte string under RFC 8746 tag 64 | A bare byte string |
| A float carrying an integral value | An integer |

† **The duplicate-key row is asymmetric, and that asymmetry is the point.**
`ciborium` models a map as a list of pairs and hands back both entries, so part
2 binds a Rust reader there: it can see the duplicate and must not delete
either entry. `cbor-x` has already collapsed the pair before its caller runs,
so part 3 applies to a JavaScript reader on the same file. A row in this table
is not automatically excused for every implementation — read parts 2 and 3
against the library actually in use, and expect a shape to be observable to one
reader and invisible to the other.

**The rule, in three parts.**

1. **A writer MUST NOT *choose* any shape in that table.** Nothing this format
   defines needs one, so a recorder composing a trace out of what it observed
   has no reason to produce one, and this is where the requirement can actually
   be met.

   This binds what a writer **originates**, not what it relays. A store may
   legitimately hold one of these shapes — the Rust reader hands back
   `"__proto__"` and an integer map key intact — and writing that store back
   offers exactly three options: drop the entry, rename it, or emit it as it
   stands. The first loses a value and the second invents one, and part 2
   forbids both. So the third is what a conformant rewrite does, and this rule
   does not stand in its way: **a stored entry is written as it stands.**
   Anything else would make a reader non-conformant for faithfully preserving
   what it was given, which is the opposite of what this section is for.

   **Two rows are exceptions, for opposite reasons.** The last two — an
   integral float, and a byte string under tag 64 — are exceptions because a
   value-preserving re-encoding *exists*: rewriting them costs nothing but
   bytes, and the paragraph after this one requires it. The duplicate-key row
   is an exception because no such re-encoding exists at all: a map cannot
   carry one key twice and still be a map any two readers agree on, so a
   rewrite must drop an entry, and dropping it loses a value. That is the one
   place this document knowingly accepts a loss, and it is set out at the end
   of this section rather than waved at here.
2. **Where a reader can observe the shape, it MUST NOT substitute a different
   one.** Route it to the unrecognised-key store and preserve it, or report the
   value as unusable — but do not hand back a value the file did not carry. A
   reader that turns `undefined` into `null`, or `"__proto__"` into
   `"__proto_"`, has invented data, and it has done so in the one code path
   whose entire purpose is preservation.
3. **Where a reader cannot observe it, the reader is not non-conformant, and
   nothing may depend on the outcome.** A rule that requires reporting a
   difference the reader was never shown is a rule no one can implement, and
   this document does not issue one.

Part 3 is not an escape hatch for the merely inconvenient. It applies only
where the normalisation happens *below* the implementation — where the value
reaching this specification's code is already the normalised one. Anything the
reader can still see, part 2 governs.

**The last two rows are different from the rest**, and are the exception that
proves the rule: this document already requires readers to accept them and
writers not to produce them (see the two normative encoding choices above).
They are listed here because a reader that *preserves* one — a byte string
still wrapped in tag 64, sitting in a store — is preserving a shape its own
writer rule forbids, and would then emit it.

**So the two encoding rules apply to stored values too.** When a store is
written back, an integral float in it is written as an integer and a tag-64
byte string as major type 2, at any depth. That is a change of encoding and not
of value, which is exactly the line this document already draws elsewhere:
"written back unchanged" binds the value, not its encoding. The alternative —
verbatim bytes — cannot be implemented by a reader whose decoder already
normalised them on the way in, so requiring it would make one implementation
permanently non-conformant while the other did nothing useful with its
compliance.

One value does change under this rule: negative zero, whose sign is lost when
`-0.0` is written as `0`. It is called out here rather than carved out, because
a trace has no field where negative zero means anything, and an exception would
cost more than it buys.

**Duplicate keys.** A writer MUST NOT emit a map carrying the same key twice.
Readers are not required to agree about which entry of a duplicate pair wins,
and no file may depend on it. RFC 8949 already calls such a map invalid; this
document adds that a conformant tool must not *emit* one, having read one.

Two places produce one without anybody meaning to. A store built by hand is an
ordered list of pairs rather than a map, so nothing stops a caller putting the
same key in twice. And a map **nested inside** a stored value can carry a
duplicate that came from the file itself — which is the more likely of the two,
since it needs no mistake at all, only a non-conformant peer. The rule reaches
both: a tool that read one must not emit one, at any depth.

**This is the one rule in this document that loses data, and it does so
knowingly.** Collapsing a duplicate pair to a single entry discards the other
entry's value. The alternative is emitting a map RFC 8949 calls invalid, which
every downstream reader would then resolve differently — so the choice is not
between losing a value and keeping it, but between losing it once, here, and
losing it unpredictably at each reader thereafter. The input was already
invalid; no rewrite of it can be lossless. Where the loss matters, report the
duplicate rather than passing it on silently.

**And the two implementations will not lose the same one.** The distinction
worth keeping straight, because the table above makes it and this paragraph
once contradicted it: `ciborium` keeps **both** entries and makes no choice at
all, so the Rust *reader* is the thing that keeps the first, by the first-match
lookup it uses for every key. `cbor-x` has kept only the last before its caller
runs. So the same input file rewritten through each yields two files differing
in **value**, not merely in encoding.

That is a worse divergence than anything the two encoding rules address, and it
is stated here rather than left to be discovered because it cannot be fixed:
making one of them normative would require the other to report a difference its
decoder discarded before any of this document's code ran. Keeping the first
entry is the better behaviour where the choice exists, and it is what a
first-match reader does anyway — but it is a SHOULD only the implementation
that can still see both entries can be held to.

That asymmetry is exactly why this is worth a rule. A reader handed both
entries can *delete* one silently, which a reader handed one cannot; the
capable implementation is the one at risk, and both reference implementations
did lose a value here — the Rust one on its read path, for a key a field had
already taken — until it was found by inspection rather than by any test.

What keeps this from mattering is the rule at the top of this paragraph: **no
conformant writer produces a duplicate key**, so a file carrying one came from
a non-conformant peer, and a trace of a non-conformant peer is exactly the
thing [Event 6](#event-6-error) exists to record. Record it there; do not rely
on the rewrite.

---

# Appendix A: MoQT Carriage Convention (informative)

> **Scoping note.** This appendix describes how a live `.moqtrace` stream maps onto a MoQT track. It is transport behavior, not file-format behavior, and is expected to migrate into a separate **moqtap** protocol draft. It is included here only so early implementers have a single reference while the drafts stabilize. The normative Part 1 and Part 2 of this document do not depend on anything in this appendix, and no released implementation currently provides it.

When a `.moqtrace` stream is carried over MoQT as a track:

- One MoQT **group** carries one segment (as defined in [Segmented Traces](#segmented-traces)).
- **Object 0** of each group carries the segment header bytes: `MOQTRACE` + version + headerLen + headerCBOR.
- **Objects 1..N** of each group each carry exactly one CBOR-encoded event.
- Concatenating all object payloads of a group, in order, reproduces a valid single-segment `.moqtrace` file.
- A subscriber joining at the latest group receives object 0 first and can begin parsing immediately without prior context.

Implementations MAY batch multiple events into one object for efficiency at high event rates; if so, each object payload remains a valid CBOR sequence.

**Late-subscriber join latency.** A subscriber joining mid-segment using SUBSCRIBE Filter Type `Largest Object` (0x2) starts at the next object after the current largest, missing the segment header object — its trace is unparseable until the next group begins. Subscribers SHOULD therefore use Filter Type `Next Group Start` (0x1), which delivers object 0 (the header) of the next group first. Worst-case time-to-first-event is one segment duration. Producers SHOULD pick segment duration to balance join latency against per-segment overhead; 1 s suits interactive debugging, longer suits archival capture.

**On-demand production.** A source SHOULD NOT produce trace events when no subscriber is attached. The producer launches when the first subscriber arrives, segment 0 begins at that moment, and the producer stops (or pauses) when the last subscriber leaves. Sources requiring retroactive history (FETCH-style backfill) need a ring buffer; this is out of scope for this specification.

**Refusing recording on overload.** When a source would otherwise drop a non-droppable event type (see [Non-droppable Event Types](#non-droppable-event-types)), the carriage convention is to return `REQUEST_ERROR` on the subscription rather than emit a sampled trace.

---

# Changes from version 1

- **Format version bumped to 2**, solely to make segmentation detectable. See [Why version 2 exists](#why-version-2-exists).
- **Readers must now accept both versions.** Version 1 said readers "MUST reject files with a version they don't support", which reads as license to reject version 1 once version 2 exists. It is now explicit that a conformant reader accepts 1 and 2.
- **Document restructured** into a normative event model (Part 1), a normative binary container (Part 2), and an informative MoQT carriage appendix. Event semantics are no longer fused with container semantics, so the model can be reused in other containers.
- **New Identifier Scoping section** distinguishing source-local `"p"`, capture-correlation `"sessionId"`, and federated `"traceId"`, with their orthogonality and presence rules.
- **New Privacy Considerations section** flagging payload-bearing events (Event 4 `"pl"`, Event 0 `"raw"`, detail levels `"headers+data"` and `"full"`) as optional and high-risk, requiring operator opt-in and recommending default-off for general-purpose tools.
- **New header field `"segment"`** enabling [Segmented Traces](#segmented-traces).
- **New header field `"sampling"`** declaring effective rate, drop policy, drop counters, and the source-side filter rule.
- **New `"perspective"` value `"relay-tap"`**, distinguishing a relay reporting on multiple concurrent peer sessions from `"server"` (single-session view) and `"observer"` (passive sniffer).
- **New common event field `"p"`** — peer identifier, required for `"relay-tap"` so multi-peer events can be demultiplexed.
- **New event types 8 (Peer connected), 9 (Peer disconnected) and 10 (Subscription derivation).**
- **Event 10 carries track identity and per-hop timestamps** — `"ns"`, `"tn"`, `"tdr"`, `"tus"`, `"tuo"`, `"tdo"` — making per-hop latency attribution possible from the event alone, plus explicit update semantics for events emitted before all four timestamps are known.
- **Event 10's trace ID is `"traceId"`, a 16-byte byte string.** An earlier revision of this proposal spelled it `"trace"` and left the type open; a text-string spelling invites per-implementation encodings, which defeats the cross-operator stitching the field exists for.
- **Unknown event types, perspectives and detail levels must be tolerated, not rejected.** Version 1 said readers "SHOULD skip unknown event types"; neither reference implementation did, which is why the purely additive parts of this revision would have broken them anyway.
- **Unrecognised keys must survive a read-modify-write.** Version 1 said only that unknown keys must be ignored, which both implementations read as permission to drop them — so every optional key either revision adds was safe to read past and silently destroyed by any tool that rewrote the file.
- **The key-preservation rule now says what it means for the header**, in a section of its own. "Header maps" was plural and neither implementation read it that way: both dropped every unknown header key outright, which is the same data loss as on an event and strictly larger, since it applies to every unknown key rather than only a wrong-typed one. The header has three maps with named keys — the header itself, `"segment"` and `"sampling"` — and each keeps its own store. See [Unrecognised keys in the header](#unrecognised-keys-in-the-header).
- **Event 6 can carry the bytes behind the error** — `"sid"`, `"ek"`, a `"rawlen"` gated at `"headers+sizes"` and a `"raw"` gated at `"full"`, with a normative 4096-byte cap and a one-per-flow latch. Version 1's error event held a code and a sentence, so a recorder that wanted to keep the offending bytes had to record the violation as a control message to have a field to put them in. See [Event 6](#event-6-error).
- Event `"n"` and `"t"` clarified as **segment-local** in segmented traces.
- **Non-droppable event types rule** added to the Sampling section.
- **Trace ID Propagation section** defining the role of the `MOQTAP_TRACE_ID` extension parameter.
- **Truncated files** now have defined reader behavior: report distinctly, return what decoded.
- **Two CBOR encoding choices are now normative** — integral values as integers, byte strings as major type 2 — with readers required to accept the other form as well. See [Interoperability](#interoperability).
- `"payloadMasked"` advertisement strengthened from SHOULD to MUST when masking is active.
- The header table's `"protocol"` examples (`"draft-14"`, `"rfc9999"`) contradicted the Protocol Identifier section below it; corrected to `"moq-transport-17"` / `"moq-transport-rfc9999"`.
