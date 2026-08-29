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
| `"headers+sizes"` | Everything in `"headers"` + payload byte lengths for each object.                                                                                | Bandwidth analysis without storing media.             |
| `"headers+data"`  | Everything in `"headers"` + full payload bytes for each object.                                                                                  | Full session replay, debugging media corruption.      |
| `"full"`          | Everything above + raw wire bytes for every message (pre-decode).                                                                                | Wire-level debugging, compliance testing.             |

Levels `"headers+data"` and `"full"`, and the `"raw"` field on `"control"`-level events, are **payload-bearing** — see [Privacy Considerations](#privacy-considerations).

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
| `"msg"` | map         | `control`+   | Decoded message fields (draft-specific structure) |
| `"sid"` | integer     | `control`+   | QUIC stream ID the message travelled on. Optional (see below). |
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

### Event 1: Stream Opened

| Key     | Type    | Detail Level | Description                                              |
| ------- | ------- | ------------ | -------------------------------------------------------- |
| `"sid"` | integer | `headers`+   | QUIC stream ID                                           |
| `"d"`   | integer | `headers`+   | Direction: `0` = outgoing, `1` = incoming                |
| `"st"`  | integer | `headers`+   | Stream type: `0` = subgroup, `1` = datagram, `2` = fetch |

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

| Key        | Type        | Detail Level | Description           |
| ---------- | ----------- | ------------ | --------------------- |
| `"ec"`     | integer     | `control`+   | Error code            |
| `"reason"` | text string | `control`+   | Human-readable reason |

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
   - Detail levels `"headers+data"` and `"full"` in aggregate

   Capturing them is **optional** for all conformant recorders. Observer- and tap-based capture of these fields is equivalent to intercepting user media; recorders MUST NOT enable it by default and SHOULD require explicit operator opt-in per session or per track. The default detail level for general-purpose tools SHOULD be `"control"` or `"headers"`.

2. **Payload size leakage.** Even without payload bytes, `"headers+sizes"` reveals object sizes, which can fingerprint media content. Operators handling sensitive traffic SHOULD evaluate size leakage as part of their threat model.

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
| `"startTime"`   | integer     | Yes      | Recording start time (Unix epoch milliseconds)                                                           |
| `"transport"`   | text string | No       | Transport type (e.g., `"webtransport"`, `"raw-quic"`)                                                    |
| `"endTime"`     | integer     | No       | Recording end time (Unix epoch milliseconds). Written when trace is finalized.                           |
| `"source"`      | text string | No       | Software that produced the trace (e.g., `"moqtap-devtools/0.1.0"`, `"my-relay/2.3.1"`). Also serves as the namespace for source-local `"p"` values. |
| `"endpoint"`    | text string | No       | Remote peer URI (e.g., `"https://relay.example.com/moq"`)                                                |
| `"sessionId"`   | text string | No       | Capture-correlation identifier — see [Identifier Scoping](#identifier-scoping).                          |
| `"segment"`     | map         | No       | Segment metadata; present iff this trace is one segment of a segmented stream. See [Segmented Traces](#segmented-traces). |
| `"sampling"`    | map         | No       | Sampling/filter metadata; present iff events were sampled or filtered at the source. See [Sampling](#sampling). |
| `"custom"`      | map         | No       | User-defined metadata (arbitrary key-value pairs). `"payloadMasked": true` here indicates payload masking is active. |

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
- Unknown keys in header maps or event maps MUST be ignored (forward-compatible).
- Optional keys MAY be added to an existing event type without a version bump — `"sid"` on event 0 was added this way. A reader must therefore treat any optional key as absent-by-default rather than assuming files of a given version all carry the same keys.
- New event types (`"e"` values) MAY be added without a version bump; readers MUST skip unknown event types rather than failing. A reader that rejects an unknown `"e"` value turns every future addition into a breaking change.
- New `"perspective"` and `"detail"` values MAY likewise be added; see [Perspective](#perspective).
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

Both rules exist because both were broken in opposite directions by the two implementations, and neither test suite could see it: each read only bytes it had written itself, so each agreed with a convention the other did not implement.

This claim is maintained by a shared corpus of `.moqtrace` files that both implementations read and write as part of their test suites, covering at minimum: a version-1 file, a non-segmented version-2 file, a segmented version-2 stream, a file carrying an unknown event type, a file carrying an unknown perspective, and a truncated file. An implementation that cannot round-trip the corpus is not conformant, whatever this document says.

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
- Event `"n"` and `"t"` clarified as **segment-local** in segmented traces.
- **Non-droppable event types rule** added to the Sampling section.
- **Trace ID Propagation section** defining the role of the `MOQTAP_TRACE_ID` extension parameter.
- **Truncated files** now have defined reader behavior: report distinctly, return what decoded.
- **Two CBOR encoding choices are now normative** — integral values as integers, byte strings as major type 2 — with readers required to accept the other form as well. See [Interoperability](#interoperability).
- `"payloadMasked"` advertisement strengthened from SHOULD to MUST when masking is active.
- The header table's `"protocol"` examples (`"draft-14"`, `"rfc9999"`) contradicted the Protocol Identifier section below it; corrected to `"moq-transport-17"` / `"moq-transport-rfc9999"`.
