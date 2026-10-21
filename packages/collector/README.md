# @moqtap/collector

Client-side monitoring for [MoQT](https://datatracker.ietf.org/doc/draft-ietf-moq-transport/)
sessions in the browser. It reports per-track throughput, object and group
cadence, stalls, gaps, duplicates, out-of-order arrivals and control-exchange
latency for every WebTransport MoQT session in the page, with no change to your
player code.

> **Importing this package patches `globalThis.WebTransport`,** at
> module-evaluation time — that is how it sees a session with no call site in
> your code. Until you call `init()` with a key it stays dormant: it copies
> recent wire bytes into a small bounded in-memory ring, holds each
> connection's first control messages for the session, and makes no network
> request of any kind. `end()` and `discard()` restore the original global.

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

That is a complete baseline session: control-plane bytes plus an interval
rollup, reporting per-track object rate, bitrate, group cadence, group gaps,
duplicates, out-of-order arrivals, stall duration and control-exchange
latencies.

## Content Security Policy

The only thing that ever leaves the page is an upload to `endpoint` — a
`fetch()` POST on the main path, and a `navigator.sendBeacon()` for the session
tail at `pagehide`. Both are governed by `connect-src`, so the endpoint's origin
has to be in it. `endpoint` defaults to `https://moqgest.com/v1/ingest`:

```http
Content-Security-Policy: connect-src 'self' https://moqgest.com;
```

Point `endpoint` at your own collector and use that origin instead — scheme and
host, no path. Nothing else in your policy has to move: there is no `eval`, no
`new Function`, no injected `<script>` element and no `blob:` worker.

## Configuration

`apiKey` is the only required key. The rest is grouped by what you are deciding:

| Key              | What it controls                                                  |
| ---------------- | ----------------------------------------------------------------- |
| `endpoint`       | Where uploads go. Defaults to the hosted ingest.                   |
| `sessionId`      | Your own id for the session, up to 128 UTF-8 bytes; else minted    |
| `context`        | `actorId`, `contentId`, `environment`, `release`                   |
| `detail`         | `baseline`, `headers`, `headers+sizes` or `headers+data`           |
| `metrics`        | How often the rollup closes, how many tracks it follows            |
| `flightRecorder` | Ring depth, triggers, how long a triggered window stays open       |
| `budget`         | Elevated minutes                                                   |
| `upload`         | When to flush, how hard to retry, when to give up                  |
| `storage`        | Persisted-queue quota                                              |
| `privacy`        | Auth-token masking, on by default                                  |
| `limits`         | Safety valves a healthy integration never touches                  |

```typescript
init({
  apiKey: 'mqt_pk_...',
  endpoint: 'https://ingest.your-company.example/v1/ingest',
  metrics: { intervalMs: 10_000 },
  budget: { elevatedMinutes: 60 },
  upload: { intervalMs: 60_000, byteThreshold: 32 * 1024 },
})
```

A session uploads at `ready`, 45 s later, then every 60 s or every 32 KB
accumulated, whichever comes first. `upload.earlyFlushesMs`,
`upload.intervalMs` and `upload.byteThreshold` set the cadence.

With a trigger set, `flightRecorder` reserves the ring (`depth`, 32 MB by
default) in each realm that opens a WebTransport, when its first one opens. A
page that only links workers reserves none.

Every threshold is a config key with a recorded default. Read the defaults from
`DEFAULTS`, and each one's provenance from `DEFAULT_PROVENANCE`.

## Detail levels

`detail` sets the level for the whole session. `escalate()` raises it for a
window that `resolve()` closes, and a flight-recorder trigger raises it to
`headers` for the window it opens. Time above `baseline` is elevated usage,
bounded by `budget.elevatedMinutes`.

| Level           | Uploads                                                                                          |
| --------------- | ------------------------------------------------------------------------------------------------ |
| `baseline`      | Control messages and the interval rollup                                                         |
| `headers`       | Also one `hdr` record per object: connection, track, stream, group, object, status, arrival time |
| `headers+sizes` | Also each object's payload size                                                                  |
| `headers+data`  | The same as `headers+sizes`: payloads never leave the device                                     |

When uploads fall behind, `hdr` records are dropped before anything else, and
the session's `end` record lists `hdr` in `sampledTypes`.

## Sessions, instances and connections

- **Session**: one playback context, by default the page. It ends when the page
  closes, or when you call `end()` or `newSession()`.
- **Instance**: one `init()`, normally one page load. A reload that passes the
  same `sessionId` is a second instance of the same session.
- **Connection**: one WebTransport, in the page or in a linked worker. It opens
  and closes by itself and never ends the session.

Only the page uploads. Without any call, the collector:

| When                                   | It                                                     |
| -------------------------------------- | ------------------------------------------------------ |
| a connection closes                    | records why, and uploads that connection's records     |
| the page is hidden                     | uploads what it holds                                  |
| the page closes                        | ends the session and uploads the rest                  |
| the page enters the back/forward cache | uploads what it holds; the session goes on if restored |
| an upload fails                        | retries in the page until ingest answers               |
| the page closes with an upload unsent  | keeps it for the next page load on the origin to send  |
| a linked worker is terminated          | records its connections closed, with what it last sent |

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

// Your own numbers, folded at fixed cost per interval regardless of sample count.
vitals.defineMetric('decodeMs', { unit: 'ms', agg: 'histogram' })
vitals.observe('decodeMs', frame.decodeDuration)

// Raise detail for an incident, then close the capture window.
vitals.escalate('headers+sizes', 'user reported a stall')
vitals.resolve() // safe with nothing open, and safe to call twice

// Connections opened from now on carry this content id.
vitals.setContext({ contentId: 'live/room-43' })
// Or one session per playback: ends this one and returns the new ids.
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

## Drafts

Drafts 07 through 22. The root entry carries a decoder for every one of them;
if your relays speak one draft, import that draft's entry instead. It is the
same API with one decoder, about 18 KB gzipped smaller:

```typescript
import { init } from '@moqtap/collector/draft14'
```

`@moqtap/collector/draft07` through `@moqtap/collector/draft22` each export
`init` and `initWorker`. A session that negotiates any other draft is reported
as `draft-mismatch` and not decoded. Every decoder is a static import, so no
build needs chunk loading.

> **Never import the `@moqtap/codec` root or `@moqtap/codec/session` yourself.**
> Both statically pull every draft, and it looks exactly like every other
> import line in review.

`@moqtap/collector/internal` exports the runtime's parts for tests and tooling.
It installs nothing and carries no compatibility promise.

## Workers

A dedicated `Worker` that opens its own WebTransport is a separate JavaScript
realm with its own `globalThis`, so the page's hook cannot see it. Import the
package in both realms and link them: the page names the worker, and the worker
reports its connections to the page every 250 ms. The page uploads them in its
own stream; the worker never uploads, stores or ends anything, and needs neither
the key nor a `connect-src` entry.

```typescript
// main.ts -- the page
import { init } from '@moqtap/collector'

const vitals = init({ apiKey: 'mqt_pk_...' })

const worker = new Worker(new URL('./transport.worker.ts', import.meta.url), {
  type: 'module',
})
vitals.linkWorker(worker)
```

```typescript
// transport.worker.ts -- the worker
import { initWorker } from '@moqtap/collector' // or '@moqtap/collector/draftNN'

// The import already installed the dormant hook in this realm. With no
// argument the link runs over the worker's own global, which is what a plain
// `new Worker()` gives you; pass a port for an explicit MessageChannel.
const vitals = initWorker()

const transport = new WebTransport('https://relay.example.com/moq')
await transport.ready
vitals.annotate('joined', undefined, vitals.connectionIdOf(transport))
```

The worker's `annotate`, `observe`, `escalate` and `resolve` go to the page's
session; the page owns the capture window and its budget. `ids()` answers with
the page's ids once linked, and follows the page into a `newSession()`.

If the worker also runs an RPC library such as Comlink on its global, give the
handshake its own channel so neither side sees the other's messages:

```typescript
const { port1, port2 } = new MessageChannel()
worker.postMessage({ moqtapPort: port2 }, [port2]) // page
vitals.linkWorker(port1)

// worker: wait for that message, then
const vitals = initWorker(event.data.moqtapPort)
```

Call `linkWorker()` once per worker, including each replacement. You can
terminate a worker at any time: `linkWorker()` wraps `terminate()` on that one
`Worker` object, so the page reports the worker's open connections closed the
moment you call it, with everything up to its last report. A worker silent for
10 s, such as one linked over a `MessagePort` and then terminated, is counted
gone; it is linked again if it speaks.

A worker that never answers is reported as an unlinked worker for that link,
and the rest of the session is unaffected. On the worker side, `vitals.linked`
resolves `false` after `limits.linkTimeoutMs` (5 s) and the probe stays inert.
Update the page and worker bundles together: a page answers only a worker of
its own release.

## Troubleshooting

### No sessions appear

Open the browser's developer tools, play a stream, and filter the Network panel
for your `endpoint` (`moqgest.com` by default). The first upload goes out as
soon as a session is ready.

**No upload requests at all** means the collector never saw a session:

- **The player opens its `WebTransport` in a Worker.** This is the most common
  cause. The page's hook cannot see a worker's connections; add `initWorker()` in
  the worker and `linkWorker()` in the page, as in [Workers](#workers). Search
  your player's code for `new Worker(` if you are not sure.
- **The collector was imported too late.** The hook is installed when the
  package is imported, so a `new WebTransport()` that ran before that import is
  invisible. Import it before the code that creates your player.
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
