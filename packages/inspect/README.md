# @moqtap/inspect

Make decoded MoQT (Media over QUIC Transport) control messages readable:
setup versions as `draft-NN`, byte strings as text where they are printable,
large integers in full, the implementation each end names, and track aliases
joined to the namespace and name the control plane gave them, error codes by
name for the session's draft, requests paired with their responses, and the
problems a session's control messages show. Works on the messages
`@moqtap/codec` decodes, for drafts 07-22.

## Install

```bash
npm install @moqtap/inspect @moqtap/codec
```

`@moqtap/codec` is a peer dependency: the error code names come from its
registries.

## Usage

```typescript
import {
  displayFields,
  errorName,
  messageAliases,
  pairRequests,
  problemTitle,
  problems,
  setupImplementation,
  type TrackFields,
  TrackRegistry,
  trackDisplayName,
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
messageAliases('ANNOUNCE') // ['PUBLISH_NAMESPACE']

const events = [
  { name: 'SUBSCRIBE', fields: msg, direction: 'tx', streamId: 4, atMs: 0 },
  { name: 'REQUEST_ERROR', fields: err, direction: 'rx', streamId: 4, atMs: 212 },
]
pairRequests(events, { draft: 22 }) // [{ request, response, rttMs: 212 }]
const found = problems(events, { draft: 22, pendingMs: 5000 })
// [{ kind: 'error', message: 'REQUEST_ERROR', code: '16', codeName: 'DOES_NOT_EXIST', ... }]
problemTitle(found[0], { draft: 22, pendingMs: 5000 })
// 'REQUEST_ERROR DOES_NOT_EXIST (0x10) "no such track"'
```

## API

| Export                                   | What it does                                                                            |
| ---------------------------------------- | --------------------------------------------------------------------------------------- |
| `displayFields(name, fields)`            | A message's fields made readable, setup versions as drafts                              |
| `displayValue(value)`                    | One value made readable                                                                 |
| `displayBytes(bytes)`                    | Text when printable ASCII, otherwise a hex preview                                      |
| `setupImplementation(name, fields)`      | The `moqt_implementation` a setup message names, and which end                          |
| `setupVersionLabel(version)`             | `0xff00000e` as `draft-14`                                                              |
| `draftOfProtocol(protocol)`              | The draft a negotiated protocol (`moqt-16`) or label names                              |
| `TrackRegistry`                          | Joins track aliases to namespace and name from control messages                         |
| `trackDisplayName(track)`                | `namespace / name` for a registered track                                               |
| `errorName(draft, message, code)`        | A code's name in that draft's registry, or `null`                                       |
| `messageAliases(name, draft?)`           | The same message's names in other drafts                                                |
| `pairRequests(events, { draft })`        | Each request with its response and round-trip time                                      |
| `problems(events, { pendingMs, draft })` | Errors, pending requests, blocked request ids, GOAWAY, undecodable bytes, in time order |
| `rollupDelivery(annotations)`            | Each track's delivery and rollup intervals from a collector trace's `collector.rollup`s |
| `quantileBucket(counts, q)`              | The duration-ladder bucket holding a quantile of a histogram                            |
| `highestBucket(counts)`                  | The highest duration-ladder bucket with a count                                         |
| `problemTitle(problem, options)`         | A problem in one line                                                                   |
| `problemDetail(problem, options)`        | The request an error answers, or a pending request's track; `null` when nothing more    |
| `problemSeverity(kind)`                  | `error` for an error response or undecodable bytes, `warning` for the rest              |
| `codeLabel(code, name, draft)`           | `TRACK_DOES_NOT_EXIST (0x4)`, or `0x4, unknown for draft-14`                            |
| `requestIdOf(name, fields)`              | The request id a message carries, in decimal                                            |

A value that needs both a shown form and the recorded one is a `Displayed`
record (`{ $shown, text, raw }`), so the result survives `postMessage` and
`JSON.stringify`.

`TrackRegistry.apply(name, fields, context)` takes the message name in either
case and follows each draft's join: the alias in SUBSCRIBE (drafts 07-11), in
SUBSCRIBE_OK or PUBLISH (12+), and the request stream where responses carry no
request id (17+).

## Requests and problems

`pairRequests` and `problems` take control events in the order they were
seen: `{ name, fields, direction, streamId, atMs, connection }`, with
`{ kind: 'undecodable' }` for bytes that did not decode. Fields may be raw
from the codec or from `displayFields`. A response is matched by request id,
by the namespace it repeats (ANNOUNCE and TRACK_STATUS_REQUEST through
draft-10), or by the stream it came back on (draft-17 on), and only against
requests that went the other way on the same connection.

`problems` reports:

| `kind`                  | When                                                               |
| ----------------------- | ------------------------------------------------------------------ |
| `error`                 | A `*_ERROR` or REQUEST_ERROR, with the code's name and its request |
| `pending`               | A request without a response `pendingMs` after it was sent         |
| `requests-blocked`      | REQUESTS_BLOCKED or SUBSCRIBES_BLOCKED, repeats counted in `count` |
| `request-limit-reached` | A request used the last id the peer's MAX_REQUEST_ID allowed       |
| `goaway`                | GOAWAY, with the URI it names                                      |
| `undecodable`           | Bytes that did not decode                                          |

`problemTitle` and `problemDetail` take the same `draft` and `pendingMs`,
the recording end as `perspective` (`client` or `server`) to say which end
sent a GOAWAY, and `trackOf(event)` to name a request's track.

## Delivery

`rollupDelivery` takes a collector trace's annotations in trace order,
`{ segment, atMs, label, data, connection }`, and sums each track's
`collector.rollup` figures per connection and direction: objects, bytes,
group ID gaps, skipped objects, stalls and the longest by bucket, cadence
and arrival percentiles by bucket, and the send side's blocked time and
acknowledged bytes. It returns `tracks`, one entry per track, and
`intervals`, one per track per rollup interval. Durations are buckets on the
collector's ladder: bucket `i` holds `[2^i, 2^(i+1))` ms.

`errorName` reads `session` as the code a session closed with and
`stream_reset` as a data stream's reset code. It never borrows a name from
another draft: a code the draft does not define answers `null`.

## License

MIT
