# `.moqtrace` File Format Specification

> **Version:** 1
> **Status:** Draft

## Overview

`.moqtrace` is a binary file format for recording MoQT (Media over QUIC Transport) sessions. It captures protocol-level events at configurable detail levels, from lightweight control-message-only traces to full wire-level recordings with payload bytes.

The format is designed to be:

- **Streamable** — events can be appended as they occur; no backpatching required
- **Compact** — CBOR encoding handles binary data natively (no base64 overhead)
- **Self-describing** — the header declares the detail level, protocol version, and recording context so readers know what to expect without scanning events
- **Cross-language** — readable by any language with a CBOR library (JS, Rust, Go, Python)

## File Layout

```
Offset  Length  Content
------  ------  -------
0       8       Magic bytes: "MOQTRACE" (0x4d4f515452414345)
8       4       Format version (uint32 LE) — currently 1
12      4       Header length (uint32 LE) — byte length of the CBOR header blob
16      N       Header (CBOR map) — session metadata and recording configuration
16+N    ...     Event stream (CBOR sequence) — concatenated CBOR items, one per event
```

### Magic Bytes

The 8-byte ASCII string `MOQTRACE` identifies the file format. Any tool can check these bytes before attempting to parse.

### Format Version

uint32 little-endian. Currently `1`. Readers MUST reject files with a version they don't support.

### Header Length

uint32 little-endian. The byte length of the CBOR-encoded header that immediately follows. This allows readers to extract metadata without scanning the event stream — useful for file browsers, search indexing, and quick filtering ("show me all draft-14 client traces").

## Header

A single CBOR map with the following keys:

| Key             | CBOR Type   | Required | Description                                                                                   |
| --------------- | ----------- | -------- | --------------------------------------------------------------------------------------------- |
| `"protocol"`    | text string | Yes      | MoQT version identifier (e.g., `"draft-14"`, `"rfc9999"`)                                     |
| `"perspective"` | text string | Yes      | Recording viewpoint: `"client"`, `"server"`, or `"observer"`                                  |
| `"detail"`      | text string | Yes      | Detail level (see below)                                                                      |
| `"startTime"`   | integer     | Yes      | Recording start time (Unix epoch milliseconds)                                                |
| `"transport"`   | text string | No       | Transport type (e.g., `"webtransport"`, `"raw-quic"`)                                         |
| `"endTime"`     | integer     | No       | Recording end time (Unix epoch milliseconds). Written when trace is finalized.                |
| `"source"`      | text string | No       | Software that produced the trace (e.g., `"moqtap-devtools/0.1.0"`, `"my-relay/2.3.1"`)        |
| `"endpoint"`    | text string | No       | Remote peer URI (e.g., `"https://relay.example.com/moq"`)                                     |
| `"sessionId"`   | text string | No       | Opaque identifier for correlating traces from the same session across multiple capture points |
| `"custom"`      | map         | No       | User-defined metadata (arbitrary key-value pairs)                                             |

### Protocol Identifier

The `"protocol"` field identifies the MoQT version without assuming lifecycle stage. Use the IETF document name minus the `draft-ietf-` prefix for drafts, and the RFC number for published standards:

- Draft phase: `"moq-transport-07"`, `"moq-transport-14"`
- RFC phase: `"moq-transport-rfc9999"`

### Perspective

The `"perspective"` field describes the vantage point of the recording:

- `"client"` — captured at the MoQT client (initiator of the QUIC connection)
- `"server"` — captured at the MoQT server or relay
- `"observer"` — passive capture (e.g., DevTools extension, network tap) that intercepts traffic without participating in the session

### Detail Levels

The `"detail"` field declares what was recorded. Each level is a strict superset of the one above it. Readers can handle any level — they just find more or fewer fields populated per event.

| Detail Level      | What's Recorded                                                                                                                                  | Typical Use Case                                      |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| `"control"`       | Control messages only (setup, subscribe, publish, goaway, etc.). No data stream events, no object payloads.                                      | Lightweight protocol flow analysis. DevTools default. |
| `"headers"`       | Control messages + data stream headers (subgroup/fetch/datagram headers, object metadata: group, object ID, priority, status). No payload bytes. | Delivery pattern analysis, timing.                    |
| `"headers+sizes"` | Everything in `"headers"` + payload byte lengths for each object.                                                                                | Bandwidth analysis without storing media.             |
| `"headers+data"`  | Everything in `"headers"` + full payload bytes for each object.                                                                                  | Full session replay, debugging media corruption.      |
| `"full"`          | Everything above + raw wire bytes for every message (pre-decode).                                                                                | Wire-level debugging, compliance testing.             |

At any detail level, the recorder MAY be configured to **mask payloads** — replacing payload bytes with zeroes before writing. This preserves payload sizes for bandwidth analysis while stripping media content. The header SHOULD include `"payloadMasked": true` in the `"custom"` map when this is active.

## Event Stream

After the header, the remainder of the file is a sequence of concatenated CBOR items (one per event). This is a standard CBOR sequence (RFC 8742) — no array wrapper, no separators.

### Common Event Fields

Every event is a CBOR map with at minimum:

| Key   | CBOR Type        | Description                                                                                         |
| ----- | ---------------- | --------------------------------------------------------------------------------------------------- |
| `"n"` | unsigned integer | Monotonically increasing sequence number (0-based). Disambiguates events with identical timestamps. |
| `"t"` | integer          | Timestamp in microseconds since `startTime` in the header                                           |
| `"e"` | integer          | Event type (see table below)                                                                        |

Short key names are used intentionally — traces can contain hundreds of thousands of events, and CBOR encodes short strings more compactly.

### Event Types

| `"e"` Value | Name            | Description                                              |
| ----------- | --------------- | -------------------------------------------------------- |
| `0`         | Control message | A control-stream message was sent or received            |
| `1`         | Stream opened   | A unidirectional or bidirectional QUIC stream was opened |
| `2`         | Stream closed   | A QUIC stream was closed                                 |
| `3`         | Object header   | An object header was parsed from a data stream           |
| `4`         | Object payload  | Object payload bytes were received/sent                  |
| `5`         | State change    | Session FSM phase transition                             |
| `6`         | Error           | Protocol error or transport error                        |
| `7`         | Annotation      | User-defined event (custom label + data)                 |

### Event-Specific Fields

#### Event 0: Control Message

| Key     | Type        | Detail Level | Description                                       |
| ------- | ----------- | ------------ | ------------------------------------------------- |
| `"d"`   | integer     | `control`+   | Direction: `0` = sent (tx), `1` = received (rx)   |
| `"mt"`  | integer     | `control`+   | Wire message type ID (e.g., `0x03` for SUBSCRIBE) |
| `"msg"` | map         | `control`+   | Decoded message fields (draft-specific structure) |
| `"raw"` | byte string | `full` only  | Raw wire bytes (including type and length prefix) |

#### Event 1: Stream Opened

| Key     | Type    | Detail Level | Description                                              |
| ------- | ------- | ------------ | -------------------------------------------------------- |
| `"sid"` | integer | `headers`+   | QUIC stream ID                                           |
| `"d"`   | integer | `headers`+   | Direction: `0` = outgoing, `1` = incoming                |
| `"st"`  | integer | `headers`+   | Stream type: `0` = subgroup, `1` = datagram, `2` = fetch |

#### Event 2: Stream Closed

| Key     | Type    | Detail Level | Description                  |
| ------- | ------- | ------------ | ---------------------------- |
| `"sid"` | integer | `headers`+   | QUIC stream ID               |
| `"ec"`  | integer | `headers`+   | Error code (0 = clean close) |

#### Event 3: Object Header

Object header events and object payload events (event 4) for the same object share `(sid, g, o)` as a composite key. An object header event is always emitted before its corresponding payload event.

| Key     | Type    | Detail Level | Description                                                                |
| ------- | ------- | ------------ | -------------------------------------------------------------------------- |
| `"sid"` | integer | `headers`+   | Stream ID this object arrived on                                           |
| `"g"`   | integer | `headers`+   | Group ID                                                                   |
| `"o"`   | integer | `headers`+   | Object ID                                                                  |
| `"pp"`  | integer | `headers`+   | Publisher priority                                                         |
| `"os"`  | integer | `headers`+   | Object status (0=normal, 1=end-of-group, 2=end-of-track, 3=does-not-exist) |

#### Event 4: Object Payload

| Key     | Type        | Detail Level     | Description                         |
| ------- | ----------- | ---------------- | ----------------------------------- |
| `"sid"` | integer     | `headers+sizes`+ | Stream ID                           |
| `"g"`   | integer     | `headers+sizes`+ | Group ID                            |
| `"o"`   | integer     | `headers+sizes`+ | Object ID                           |
| `"sz"`  | integer     | `headers+sizes`+ | Payload size in bytes               |
| `"pl"`  | byte string | `headers+data`+  | Payload bytes (or zeroed if masked) |

#### Event 5: State Change

| Key      | Type        | Detail Level | Description            |
| -------- | ----------- | ------------ | ---------------------- |
| `"from"` | text string | `control`+   | Previous session phase |
| `"to"`   | text string | `control`+   | New session phase      |

#### Event 6: Error

| Key        | Type        | Detail Level | Description           |
| ---------- | ----------- | ------------ | --------------------- |
| `"ec"`     | integer     | `control`+   | Error code            |
| `"reason"` | text string | `control`+   | Human-readable reason |

#### Event 7: Annotation

| Key       | Type        | Detail Level | Description                       |
| --------- | ----------- | ------------ | --------------------------------- |
| `"label"` | text string | any          | User-defined label                |
| `"data"`  | any         | any          | User-defined data (any CBOR type) |

## Reading a `.moqtrace` File

```
1. Read 8 bytes, verify magic == "MOQTRACE"
2. Read 4 bytes (uint32 LE) → format version. Reject if unsupported.
3. Read 4 bytes (uint32 LE) → header length N.
4. Read N bytes → CBOR-decode to get header map.
5. Read remaining bytes as a CBOR sequence:
   - Repeatedly CBOR-decode one item at a time until EOF.
   - Each item is one event (a CBOR map).
```

## Writing a `.moqtrace` File

```
1. Write magic bytes "MOQTRACE"
2. Write format version (uint32 LE, currently 1)
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

## Versioning and Compatibility

- **Version 1** is defined by this document.
- Readers MUST check the format version before parsing.
- Unknown keys in header maps or event maps MUST be ignored (forward-compatible).
- New event types (`"e"` values) MAY be added in future versions; readers SHOULD skip unknown event types.
- The detail level in the header is informational — readers MUST handle missing fields gracefully regardless of declared level.

## Interoperability

The `.moqtrace` format is shared between the JavaScript (`@moqtap/trace`) and Rust (`moqtap-trace`) implementations. A file written by either is readable by both. CBOR libraries used:

- JavaScript: `cbor-x`
- Rust: `ciborium`

Both produce deterministic CBOR output (canonical CBOR is NOT required, but map keys SHOULD be sorted for consistency).
