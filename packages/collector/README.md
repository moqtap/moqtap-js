# @moqtap/collector

Client-side monitoring for [MoQT](https://datatracker.ietf.org/doc/draft-ietf-moq-transport/)
sessions in the browser. It reports per-track throughput, object and group
cadence, stalls, gaps, duplicates, out-of-order arrivals and control-exchange
latency for every WebTransport MoQT session in the page, with no change to your
player code.

> **Importing this package wraps `globalThis.WebTransport`,** so import it
> before the first `new WebTransport()` runs; a connection opened earlier is
> invisible to it. Until you call `init()` with a key it sends nothing. A
> connection opened between the import and `init()` is still measured,
> including its setup and subscribe exchanges. `end()` and `discard()` restore
> the original `WebTransport`.

Object payloads never leave the device, and authorization tokens are masked
before anything records them.

## Install

```bash
npm install @moqtap/collector
```

## Quick Start

```typescript
import { init } from '@moqtap/collector'

const vitals = init({
  apiKey: 'mqt_pk_...',
  context: {
    actorId: currentUser.id,
    contentId: 'live/room-42',
    environment: 'production',
    release: '4.2.1',
  },
})
```

That is a complete baseline session: control messages plus an interval
rollup, reporting per-track object rate, bitrate, group cadence, group gaps,
duplicates, out-of-order arrivals, stall duration and control-exchange
latencies. The session begins when the page constructs its first
`WebTransport`; until then nothing is recorded or sent.

## Content Security Policy

The collector connects only to `endpoint`, with `fetch()` and
`navigator.sendBeacon()`. Both are governed by `connect-src`, so the
endpoint's origin has to be in it. `endpoint` defaults to
`https://moqgest.com/v1/ingest`:

```http
Content-Security-Policy: connect-src 'self' https://moqgest.com;
```

Point `endpoint` at your own collector and use that origin instead — scheme and
host, no path. Nothing else in your policy has to move: there is no `eval`, no
`new Function`, no injected `<script>` element, no `blob:` worker and no
runtime chunk loading.

## Configuration

`apiKey` is the only required key. The rest is grouped by what you are deciding:

| Key              | What it controls                                                      |
| ---------------- | --------------------------------------------------------------------- |
| `endpoint`       | Where uploads go. Defaults to the hosted ingest.                      |
| `sessionId`      | Your own id for the first session, up to 128 UTF-8 bytes; else minted |
| `context`        | `actorId`, `contentId`, `environment`, `release`, `tags`              |
| `detail`         | `baseline`, `headers`, `headers+sizes` or `headers+data`              |
| `metrics`        | How often the rollup closes, how many tracks it follows               |
| `flightRecorder` | Memory depth, triggers, how long a triggered window stays open        |
| `budget`         | Elevated minutes                                                      |
| `upload`         | When to upload, how hard to retry, when to give up                    |
| `storage`        | Space for uploads waiting to be sent                                  |
| `privacy`        | Auth-token masking, on by default; actor-id hashing, off              |
| `limits`         | Safety valves a healthy integration never touches                     |

```typescript
init({
  apiKey: 'mqt_pk_...',
  endpoint: 'https://ingest.your-company.example/v1/ingest',
  metrics: { intervalMs: 10_000 },
  budget: { elevatedMinutes: 60 },
  upload: { intervalMs: 60_000, byteThreshold: 32 * 1024 },
})
```

By default a session uploads when it is ready, 45 s later, then every 60 s or
once 32 KB is waiting, whichever comes first. `upload.earlyFlushesMs`,
`upload.intervalMs` and `upload.byteThreshold` set those.

The flight recorder uses memory (`depth`, 32 MB by default) only when a trigger
is set, in each page or worker that opens a WebTransport. A page that only
links workers uses none. Its triggers are `stall` and `cadence`, both off
unless listed.

`context.tags` labels the session with up to 16 pairs of your own, such as
`{ experiment: 'abr-b' }`; a key is 1 to 32 characters and a value 1 to 128.
With `privacy.hashActorId: true`, `actorId` is sent as the first 32 hex digits
of `sha256(apiKey + ':' + actorId)`, and `ids()` reports that hash.

Every threshold is a config key with a recorded default. Read the defaults from
`DEFAULTS`, and each one's provenance from `DEFAULT_PROVENANCE`.

## Detail levels

`detail` sets the level for the whole session. `escalate()` raises it for a
window that `resolve()` closes, and a flight-recorder trigger raises it to
`headers` for the window it opens. Time above `baseline` counts toward the
workspace's recording minutes for the month; `budget.elevatedMinutes` limits
how many one session uses.

| Level           | Uploads                                                                                                                        |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `baseline`      | Control messages and the interval rollup                                                                                       |
| `headers`       | Also one `hdr` record per object: connection, track, stream, group, subgroup, object, status, publisher priority, arrival time |
| `headers+sizes` | Also each object's payload size                                                                                                |
| `headers+data`  | The same as `headers+sizes`: payloads never leave the device                                                                   |

If uploads fall behind, `hdr` records are dropped first, and the session's
`end` record says so.

Insight can change three things while a session runs, within these bounds:

| What                      | When                                                           | Bounds                                                                             |
| ------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| a shorter interval        | someone has the session open in the dashboard                  | 1 to 10 s, for at most 10 minutes at a time                                        |
| raised detail             | a capture window covers the session's release, user or content | up to `headers+sizes`, for at most 30 minutes, within `budget.elevatedMinutes`     |
| detail held at `baseline` | the workspace has used its recording minutes for the month     | `baseline` only, for at most 10 minutes from each upload, repeated on every upload |

Raised detail is recorded as a `remote` escalation and counts toward recording
minutes. `resolve()` does not close it; `escalate()` takes it over.

When the workspace has used its recording minutes for the month, detail stays
at `baseline` until the UTC month ends or the workspace moves to a plan with
more minutes. `escalate()`, flight-recorder triggers and capture windows are
refused, and a raised level drops to `baseline` at the next rollup interval
(`metrics.intervalMs`). A refused `escalate()` is not applied later; call it
again once the hold ends. After a move to a plan with more minutes, a held
session returns to its configured level within 10 minutes. Each change is
recorded as an escalation with `by.kind: 'hold'`.

## Sessions, instances and connections

- **Session**: the WebTransport activity of one page and its linked workers.
  It begins when a `WebTransport` is constructed, in the page or in a linked
  worker, whether or not it connects. It ends when its last connection has
  closed and no other is attempted within 30 s, when the page closes, or when
  you call `end()` or `newSession()`. The next `WebTransport` after that
  begins a new session, with new ids and the context so far.
- **Instance**: one session's recording in one page. A reload that passes the
  same `sessionId` is a second instance of the same session.
- **Connection**: one WebTransport, in the page or in a linked worker. A
  connection that fails to open is still reported, in the session its attempt
  began or joined.

A page that never constructs a `WebTransport` has no session: it records,
stores and uploads nothing, and does not count toward the month's sessions.
Every session that begins does, including one whose only connection failed to
open.

Before a session begins, `ids()` already answers with the ids it will be
uploaded under, and context passed to `init()` or `setContext()` is sent with
it. Annotations, metric samples and `escalate()` calls made before then are
not recorded; metric definitions are kept. A capture window still open when
a session ends closes with it, and the next session starts at `detail`.

Without any call, the collector:

| When                                   | It                                                         |
| -------------------------------------- | ---------------------------------------------------------- |
| a `WebTransport` is constructed        | begins a session, unless one is running                    |
| a connection closes                    | records why, and uploads that connection's records         |
| no connection is open for 30 s         | ends the session                                           |
| the page is hidden                     | uploads what it holds                                      |
| the page closes                        | ends the session and uploads the rest                      |
| the page enters the back/forward cache | uploads what it holds; the session goes on if restored     |
| an upload fails                        | retries it                                                 |
| the page closes with an upload unsent  | sends it with the next session on the same origin          |
| a linked worker is terminated          | records its connections closed, with what it last reported |

A tab killed with no `pagehide` while visible loses at most the last 60 s.

## API

```typescript
// Synchronous, available before the first object arrives.
const { sessionId, instanceId } = vitals.ids()

// Every WebTransport seen in this page and its linked workers, open ones first.
vitals.connections()
// The id of a WebTransport you created, to join your own logs.
const conn = vitals.connectionIdOf(transport)

// A marker in the timeline, optionally about one connection.
vitals.annotate('quality-switch', { to: '720p' }, conn)

// Your own numbers. Observing more often does not upload more.
vitals.defineMetric('decodeMs', { unit: 'ms', agg: 'histogram' })
vitals.observe('decodeMs', frame.decodeDuration)

// Raise detail for an incident, then close the capture window.
vitals.escalate('headers+sizes', 'user reported a stall')
vitals.resolve() // safe with nothing open, and safe to call twice

// Connections opened from now on carry this content id. The user and tags
// apply from now on too; tags add to the session's.
vitals.setContext({
  contentId: 'live/room-43',
  actorId: 'user-81',
  tags: { cdn: 'edge-2' },
})
// Or one session per playback: ends this one and returns the new ids. With no
// connection open, the new session begins with the next WebTransport.
vitals.newSession({ contentId: 'vod/episode-2' })

await vitals.flush() // upload everything recorded so far; ends nothing
await vitals.end() // end the session, upload everything, restore WebTransport
await vitals.discard() // delete everything unsent and send nothing more
```

You need `end()` only when you stop collecting for good while the page stays
open; closing the page ends the session. A native shell that kills its webview
without `pagehide` should `await vitals.flush()` first.

`discard()` is the one to call when the reason you are stopping is that you no
longer want the data to leave the device — a consent withdrawal, an opt-out, a
test fixture. It deletes every stored upload as well.

## Entry points

Drafts 07 through 22. Your bundle holds the drafts and features you import and
nothing else. Pick the entry that matches your player:

| Import                             | Drafts | Features  | Gzipped    |
| ---------------------------------- | ------ | --------- | ---------- |
| `@moqtap/collector`                | all    | all       | 65.5 KB    |
| `@moqtap/collector/draftNN`        | one    | all       | 46–48.5 KB |
| `@moqtap/collector/draftNN/thin`   | one    | none      | 38–40.5 KB |
| `compose({ features: [workers] })` | none   | `workers` | 17 KB      |

```typescript
import { init } from '@moqtap/collector/draft14'
```

Every entry has the same API. A session that negotiates a draft the entry does
not carry is reported as `draft-mismatch` and not decoded. A call that needs a
feature the entry does not carry is ignored and reported once, as `MQ1006`
with the feature's name, through `onInternalError`.

The features:

- `workers`: `linkWorker()`. See [Workers](#workers).
- `escalation`: `escalate()`, and a `detail` above `baseline`.
- `flightRecorder`: the `stall` and `cadence` triggers. In the page it needs
  `escalation` as well.
- `customMetrics`: `defineMetric()` and `observe()`.
- `persistence`: stores each upload in IndexedDB until ingest accepts it, so
  one the page could not send is sent on the next page load.

### Compose your own

`compose()` builds a collector from the drafts and features you name. Call it
at module level, before your player constructs its first `WebTransport`:

```typescript
// collector.ts
import { compose } from '@moqtap/collector/compose'
import { draft14 } from '@moqtap/collector/draft14/decoder'
import { persistence, workers } from '@moqtap/collector/features'

export const init = compose({
  drafts: [draft14],
  features: [workers, persistence],
})
```

If every `WebTransport` your player opens lives in a worker, the page needs no
draft. It then leaves the page's `WebTransport` alone and records what its
linked workers send:

```typescript
export const init = compose({ features: [workers, persistence] })
```

`composeWorker({ drafts, features })` does the same for a worker. Of the
features, a worker uses `flightRecorder`; everything else it reports goes to
the page.

The collector loads no code at runtime, so it works in single-file bundles,
IIFE worker builds and pages whose CSP blocks runtime chunk loading.

> **If your own code imports `@moqtap/codec`, import its draft entries.** The
> `@moqtap/codec` root and `@moqtap/codec/session` pull in every draft.

## Workers

A dedicated `Worker` that opens its own WebTransport has its own
`globalThis`, so the collector in the page cannot see it. Import the package in
the worker as well and link the two: the page names the worker, and the
worker's connections join the page's session. The worker needs neither the key
nor a `connect-src` entry; everything it records is uploaded by the page.

```typescript
// main.ts -- the page
import { init } from '@moqtap/collector/draft14'

const vitals = init({ apiKey: 'mqt_pk_...' })

const worker = new Worker(new URL('./transport.worker.ts', import.meta.url), {
  type: 'module',
})
vitals.linkWorker(worker)
```

```typescript
// transport.worker.ts -- the worker
import { initWorker } from '@moqtap/collector/draft14/worker'

// With no argument the link runs over the worker's own global, which is what
// a plain `new Worker()` gives you; pass a port for an explicit MessageChannel.
const vitals = initWorker()

const transport = new WebTransport('https://relay.example.com/moq')
await transport.ready
vitals.annotate('joined', undefined, vitals.connectionIdOf(transport))
```

The worker's `annotate`, `observe`, `escalate` and `resolve` go to the page's
session, and calls made before the worker is linked are kept until it is. As
in the page, those made before a session begins are not recorded; a
`WebTransport` the worker constructs begins one. All configuration comes from
the page's `init()`. `ids()` answers with the page's ids once linked, and
follows the page into each new session.

If the worker also runs an RPC library such as Comlink on its global, give the
link its own channel so neither side sees the other's messages:

```typescript
const { port1, port2 } = new MessageChannel()
worker.postMessage({ moqtapPort: port2 }, [port2]) // page
vitals.linkWorker(port1)

// worker: wait for that message, then
const vitals = initWorker(event.data.moqtapPort)
```

Call `linkWorker()` once per worker, including each replacement. You can
terminate a worker at any time: its open connections are recorded closed at
once, with everything measured up to that point. A worker linked over a
`MessagePort` and then terminated is counted gone after 10 s.

A worker that never answers is reported as an unlinked worker for that link,
and the rest of the session is unaffected. On the worker side, `vitals.linked`
resolves `false` after `limits.linkTimeoutMs` (5 s) and the probe stays inert.
Update the page and worker bundles together: a page links only a worker of
its own release.

### Worker entry points

The worker entries export `initWorker` alone, without the page's uploader,
storage and session:

| Import                                  | Drafts | Flight recorder | Gzipped    |
| --------------------------------------- | ------ | --------------- | ---------- |
| `@moqtap/collector/worker`              | all    | yes             | 49.3 KB    |
| `@moqtap/collector/draftNN/worker`      | one    | yes             | 30–32.5 KB |
| `@moqtap/collector/draftNN/thin/worker` | one    | no              | 26.5–29 KB |

When every connection lives in the worker, pair one of these with a page that
imports no draft, as in [Compose your own](#compose-your-own). Like every
prebuilt entry, importing one wraps the worker's `WebTransport`.

## Troubleshooting

### No sessions appear

Open the browser's developer tools, play a stream, and filter the Network panel
for your `endpoint` (`moqgest.com` by default). Uploads come from the page,
never from a worker. The first one goes out as soon as a session begins, when
the page or a linked worker constructs a `WebTransport`.

**No upload requests at all** means the collector never saw a `WebTransport`:

- **The player opens its `WebTransport` in a Worker.** This is the most common
  cause. The collector in the page cannot see a worker's connections; add
  `initWorker()` in the worker and `linkWorker()` in the page, as in
  [Workers](#workers). Search your player's code for `new Worker(` if you are
  not sure.
- **The collector was imported too late.** A `new WebTransport()` that ran
  before the import is invisible. Import it before the code that creates your
  player.
- **The player is not using WebTransport.** A player that falls back to
  WebSocket is not measured.

**Requests that fail before reaching the network** are blocked by your Content
Security Policy; the console names the directive. Add the endpoint's origin to
`connect-src`, as in [Content Security Policy](#content-security-policy).

**Requests answered `401` or `403`** were refused by ingest:

- `401`: the key is wrong, or was created in the last two minutes and is not
  live yet.
- `403`: the key is disabled, or the page's origin is not on the key's allowed
  origins.

Uploads answered `202` are accepted, and the session appears in Insight within
a minute or two.

## Errors

Every error carries a code, and the runtime message is the code plus the
offending value — `MQ2101: 1.5`. The wording lives in
[ERROR-CODES.md](./ERROR-CODES.md), and in
[`error-codes.json`](./error-codes.json) for tooling. Configuration problems are
reported rather than thrown, arriving as `{ key, code, got }` on
`onConfigProblem`, so you can switch on the code rather than parse a sentence.

## Documentation

<https://moqtap.com/npm-packages/moqtap-collector/>

## License

[Functional Source License 1.1, MIT Future License](./LICENSE) (`FSL-1.1-MIT`).
Embed it in your application, commercial or not, modify it, ship it to your
users; the one thing it withholds is publishing a competing product built from
this code. Two years after each release, that release becomes MIT.
