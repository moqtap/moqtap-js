---
title: "@moqtap/inspect"
description: Make decoded MoQT control messages readable. Track names, error code names, request pairing and session problems for drafts 07–22.
version: 0.2.0
---

**Make decoded MoQT control messages readable.**

[npm](https://www.npmjs.com/package/@moqtap/inspect) | [GitHub](https://github.com/moqtap/moqtap-js/tree/master/packages/inspect)

## What it does

`@moqtap/inspect` takes the control messages [`@moqtap/codec`](/npm-packages/moqtap-codec/)
decodes and turns them into what a person debugging a session wants to read:

- **Readable fields**: setup versions as `draft-NN`, byte strings as text where they are
  printable, integers past 2^53 in full, and the implementation each end names in its setup
  message.
- **A track registry**: track aliases joined to the namespace and name the control plane gave
  them.
- **Error names**: an error or status code by its name in the session's draft.
- **Request pairing**: each request matched to its response, with the round-trip time.
- **Problems**: error responses, requests left unanswered, blocked request IDs, GOAWAY and
  undecodable bytes, in time order and in one line each.
- **Rollup delivery**: each track's delivery figures from the rollups in a
  [`@moqtap/monitor-browser`](/npm-packages/moqtap-monitor-browser/) trace.

Supports **drafts 07 through 22**. Works in Node.js, Bun, Deno and browsers. Every result is
plain data, so it survives `postMessage` and `JSON.stringify`.

## Installation

```bash
npm install @moqtap/inspect @moqtap/codec
```

`@moqtap/codec` (0.13.2 or later) is a peer dependency: the error code names come from its
registries.

## Quick start

```typescript
import {
  displayFields,
  errorName,
  pairRequests,
  problems,
  problemTitle,
  setupImplementation,
  TrackRegistry,
  trackDisplayName,
  type ControlEvent,
  type TrackFields,
} from '@moqtap/inspect'

displayFields('client_setup', msg)
// { supported_versions: [{ $shown: 'version', text: 'draft-14', raw: '0xff00000e' }], ... }

setupImplementation('client_setup', msg)
// { side: 'client', implementation: 'moxygen 0.4' }

const tracks = new Map<string, TrackFields>()
const registry = new TrackRegistry(tracks, (fields) => ({ ...fields }))
registry.apply('subscribe_ok', msg, { direction: 'rx' })
const track = registry.byAlias('3')
if (track) trackDisplayName(track) // 'live/ch4 / video/1080p'

errorName(14, 'SUBSCRIBE_ERROR', 4n) // 'TRACK_DOES_NOT_EXIST'
errorName(22, 'REQUEST_ERROR', 0x32n) // null: not a draft-22 code

const events: ControlEvent[] = [
  { name: 'SUBSCRIBE', fields: msg, direction: 'tx', streamId: 4, atMs: 0 },
  { name: 'REQUEST_ERROR', fields: err, direction: 'rx', streamId: 4, atMs: 212 },
]
pairRequests(events, { draft: 22 }) // [{ request, response, rttMs: 212 }]

for (const problem of problems(events, { draft: 22, pendingMs: 5000 })) {
  problemTitle(problem, { draft: 22, pendingMs: 5000 })
  // 'REQUEST_ERROR DOES_NOT_EXIST (0x10) "no such track"'
}
```

## Readable fields

`displayFields(name, fields)` returns a message's fields made readable. A value that needs both
a shown form and the recorded one becomes a `Displayed` record, `{ $shown, text, raw }`:

| Value | Shown as |
|---|---|
| A setup version | `draft-14`, with the raw `0xff00000e` beside it |
| Bytes that are printable ASCII | text |
| Other bytes | a hex preview |
| An integer past 2^53 | full decimal |

`setupImplementation(name, fields, sentByClient?)` reads the `moqt_implementation` a
CLIENT_SETUP, SERVER_SETUP or SETUP message advertises, and says which end sent it. For the
SETUP of draft-17 and later, pass `sentByClient`; without it the answer is `null`. The answer is
also `null` when the message names no implementation.

## Track registry

`TrackRegistry` keeps a session's tracks up to date from its control messages. You pass it a
`Map` it updates in place, and a function that builds your stored record, so you can keep your
own fields beside the track's:

```typescript
const registry = new TrackRegistry(tracks, (fields) => ({ ...fields, firstSeen: Date.now() }))

for (const m of controlMessages) {
  registry.apply(m.name, m.fields, { direction: m.direction, streamId: m.streamId })
}
```

`apply(name, fields, { direction, streamId?, timestamp? })` takes the message name in either
case and `direction` as `tx` or `rx`, and returns the track it affected, or `null`.
It follows each draft's join: the alias in SUBSCRIBE (drafts 07–11), in SUBSCRIBE_OK or PUBLISH
(12 and later), and the request stream for responses that carry no request ID (17 and later).
Pass `streamId` for draft-17 sessions and later.

`byAlias('3')` returns the track whose data streams carry alias 3. The alias is a decimal
string.

## Error names

`errorName(draft, message, code)` returns a code's name in that draft's registry, or `null`. It
never borrows a name from another draft: a code the draft does not define answers `null`. Pass
`session` as the message for the code a session closed with, and `stream_reset` for a data
stream's reset code.

`codeLabel(code, name, draft)` formats the result for display: `TRACK_DOES_NOT_EXIST (0x4)`, or
`0x4, unknown for draft-14`.

`messageAliases(name, draft?)` returns the same message's names in other drafts, such as
ANNOUNCE and PUBLISH_NAMESPACE, or SUBSCRIBE_DONE and PUBLISH_DONE.

## Requests and problems

`pairRequests` and `problems` take control events in the order they were seen:

```typescript
{ name, fields, direction, streamId, atMs, connection }
```

and `{ kind: 'undecodable' }` for bytes that did not decode. `direction` is `tx` or `rx`, or
`0` or `1` as in a trace. Fields may be raw from the codec or from `displayFields`.

A response is matched by request ID, by the namespace it repeats (ANNOUNCE and
TRACK_STATUS_REQUEST through draft-10), or by the stream it came back on (draft-17 and later),
and only against requests that went the other way on the same connection.

`problems(events, { draft, pendingMs, endMs? })` reports the following, in time order.
`endMs` is the time up to which a missing response counts as missing; it defaults to the last
event's time.

| `kind` | When |
|---|---|
| `error` | A `*_ERROR` or REQUEST_ERROR, with the code's name and the request it answers |
| `pending` | A request without a response `pendingMs` after it was sent |
| `requests-blocked` | REQUESTS_BLOCKED or SUBSCRIBES_BLOCKED, repeats counted in `count` |
| `request-limit-reached` | A request used the last ID the peer's MAX_REQUEST_ID allowed |
| `goaway` | GOAWAY, with the URI it names |
| `undecodable` | Bytes that did not decode |

Each problem carries a stable `id` (`session.` and its kind). When the draft is known and
defines the message the problem is about (the error message, GOAWAY, REQUESTS_BLOCKED or
SUBSCRIBES_BLOCKED, or for a reached limit the MAX_REQUEST_ID or MAX_SUBSCRIBE_ID message), it
also carries `spec`: the draft, revision, section and the
sentence that defines the message. `specUrl(spec)` links that section of the pinned revision on
datatracker, and `messageSpec(draft, name)` looks one up directly.

`problemTitle` and `problemDetail` put a problem into words. They take the same `draft` and
`pendingMs`, plus `perspective` (`client` or `server`, the end that recorded the session) to say
which end sent a GOAWAY, and `trackOf(event)` to name a request's track. `problemSeverity(kind)`
is `error` for an error response or undecodable bytes, and `warning` for the rest.

## Rollup delivery

`rollupDelivery(annotations)` takes a collector trace's annotations in trace order,
`{ segment, atMs, label, data, connection }`, and sums each track's `collector.rollup` figures
per connection and direction:

- objects, bytes, group ID gaps and skipped objects;
- stalls, and the longest one;
- cadence and arrival percentiles;
- on the send side, time blocked and bytes acknowledged.

It returns `tracks`, one entry per track, `intervals`, one per track per rollup interval, and
`offsets`, which place each segment's collector times in milliseconds from the session's start.

Durations are buckets on the collector's ladder: bucket `i` holds `[2^i, 2^(i+1))` ms.
`quantileBucket(counts, q)` finds the bucket holding a quantile of a histogram, and
`highestBucket(counts)` the highest one with a count.

## API reference

| Export | What it does |
|---|---|
| `displayFields(name, fields)` | A message's fields made readable, setup versions as drafts |
| `displayValue(value)` | One value made readable |
| `displayBytes(bytes)` | Text when printable ASCII, otherwise a hex preview |
| `setupImplementation(name, fields, sentByClient?)` | The `moqt_implementation` a setup message names, and which end |
| `setupVersionLabel(version)` | `0xff00000e` as `draft-14` |
| `draftOfProtocol(protocol)` | The draft a negotiated protocol (`moqt-16`) or label names |
| `TrackRegistry` | Joins track aliases to namespace and name from control messages |
| `trackDisplayName(track)` | `namespace / name` for a registered track |
| `errorName(draft, message, code)` | A code's name in that draft's registry, or `null` |
| `messageAliases(name, draft?)` | The same message's names in other drafts |
| `pairRequests(events, { draft })` | Each request with its response and round-trip time |
| `problems(events, { pendingMs, draft })` | Errors, pending requests, blocked request IDs, GOAWAY and undecodable bytes, in time order |
| `rollupDelivery(annotations)` | Each track's delivery and rollup intervals from a collector trace's `collector.rollup` annotations |
| `quantileBucket(counts, q)` | The duration-ladder bucket holding a quantile of a histogram |
| `highestBucket(counts)` | The highest duration-ladder bucket with a count |
| `problemTitle(problem, options)` | A problem in one line |
| `problemDetail(problem, options)` | The request an error answers, or a pending request's track; `null` when there is nothing more |
| `problemSeverity(kind)` | `error` for an error response or undecodable bytes, `warning` for the rest |
| `codeLabel(code, name, draft)` | `TRACK_DOES_NOT_EXIST (0x4)`, or `0x4, unknown for draft-14` |
| `requestIdOf(name, fields)` | The request ID a message carries, in decimal |
| `isDisplayed(value)` | Whether a value is a `Displayed` record |
| `bytesAsText(bytes)` | Printable ASCII as text, or `null` |
| `messageKind(name, fields?)` | A message's name in the codec's spelling (`client_setup`) |
| `trackEventFrom(name, fields)` | What a control message says about a track, or `null` |
| `deliveryKey(connection, direction, kind, id)` | The `key` of a `rollupDelivery` track |

## License

[MIT](https://github.com/moqtap/moqtap-js/blob/master/packages/inspect/LICENSE).
