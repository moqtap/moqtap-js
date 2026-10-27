---
title: "@moqtap/collector"
description: Measure MoQT delivery health from real viewers' browsers. Per-track stalls, gaps, cadence and control latency, with no change to your player code.
version: 0.11.0
---

**Measure MoQT delivery health from real viewers' browsers.**

[npm](https://www.npmjs.com/package/@moqtap/collector) | [GitHub](https://github.com/moqtap/moqtap-js/tree/master/packages/collector) | sends data to [moqtap Insight](/products/insight/)

`@moqtap/collector` watches every MoQT session your page opens over WebTransport, including
sessions opened in a Web Worker, and reports, per track, how objects and groups actually
arrived: rate, bitrate, stalls, missing groups, duplicates, reordering and how long control
requests took to get an answer. You don't change your player. You import the package, call
`init()` with a key, and the numbers appear in Insight.

## Install

```bash
npm install @moqtap/collector
```

## Quick start

```typescript
// main.ts — import it before the code that creates your player
import { init } from '@moqtap/collector'
import { startPlayer } from './player'

const vitals = init({
  apiKey: 'mqt_pk_...',
  context: {
    actorId: currentUser.id,
    contentId: 'live/room-42',
    environment: 'production',
    release: '4.2.1',
  },
})

startPlayer()
```

That is a complete integration. Every MoQT session the page opens is measured and uploaded.
A session begins when the page constructs its first `WebTransport`, and ends by itself 30
seconds after its last connection closes, or when the page closes.

### Import order

The collector wraps `globalThis.WebTransport` when the module is first imported, so **import it
before the first `new WebTransport()` runs**. A connection opened earlier is invisible to it.

You don't need the key at import time. Until `init()` is called, the collector sends nothing.
A connection opened between the import and `init()` is still measured, including its setup and
subscribe exchanges. Objects that arrived before `init()` are counted as `early.dataChunks` and
`early.dataBytes`.

`end()` and `discard()` remove the wrapper and restore the original `WebTransport`.

## Sessions and connections

- **Session**: the WebTransport activity of one page and its linked workers. It begins when the
  page or a linked worker constructs a `WebTransport`, whether or not it connects. It ends 30
  seconds after its last connection closes with no other attempted (`end` reason `idle`), when
  the page closes, or when you call `end()` or `newSession()`. The next `WebTransport` after that
  begins a new session, with new IDs and the context set so far.
- **Instance**: one session's recording in one page. A reload that passes the same `sessionId`
  is a second instance of the same session.
- **Connection**: one `WebTransport`, in the page or in a linked worker. A connection that fails
  to open is still reported, in the session its attempt began or joined.

A page that never constructs a `WebTransport` has no session: it records, stores and uploads
nothing, and isn't counted.

Before a session begins:

- `ids()` already returns the IDs the session will be uploaded under.
- Context passed to `init()` or `setContext()` is sent with the session's setup.
- Metric definitions are kept, and carry into every session that follows.
- Annotations, metric samples and `escalate()` calls are dropped.

A session's clock starts at its begin. A capture window still open when a session ends closes
with it, and the next session starts at `detail`, or at `baseline` while detail is
held (see [Changes Insight makes while a session runs](#changes-insight-makes-while-a-session-runs)).

A Web Worker that opens its own `WebTransport` is measured as part of the page's session. The
worker calls `initWorker()` and the page calls `linkWorker(worker)`. The worker needs neither
the key nor a `connect-src` entry. See
[Players that run in a Web Worker](#players-that-run-in-a-web-worker).

## What it measures

Every 10 seconds (`metrics.intervalMs`) the collector records, per track and direction:

| Signal | Use it to answer |
|---|---|
| Objects, payload bytes, header bytes | Is this track delivering at the rate and bitrate I expect? |
| Inter-arrival and object-size histograms | Is delivery steady, or bursty with gaps between bursts? |
| Group cadence and how long each group stayed open | What GOP interval is the publisher actually producing? |
| Group gaps, as ranges of missing group IDs (16 ranges per interval, the rest counted) | Did any group IDs never arrive, and which? |
| Stream resets, by error code | Did the relay or publisher abandon streams on this track? |
| Stalls (count, total and longest, as a histogram) | Did a viewer see playback freeze, and for how long? |
| Out-of-order and duplicate objects | Is the relay reordering or resending? |
| Status objects and parse failures | Did the publisher signal end-of-group or end-of-track? Did anything arrive that couldn't be read? |
| Time blocked on `writer.ready`, bytes acknowledged | Publishers only: is the page waiting to send, and how much did the peer confirm? |

Per session, it also records:

- **Control-request latency**, from request to response, grouped by kind: setup, subscribe,
  fetch, announce, track status, publish.
- **The control messages themselves**, with authorization tokens masked (see
  [Privacy](#privacy)).
- **Each connection's negotiated draft**, whether it was publishing, subscribing or both, why
  it closed, and who closed it: your code calling `close()`, the relay, or a local failure.
- **Each connection's relay and options**: the relay's scheme, host and port, and the
  `WebTransport` options the page passed, with server certificate hashes reduced to a count.
- **Stream resets that came before the stream named a track**, counted per connection.

Stalls are judged against each track's own delivery rhythm, so a 2-second-GOP track and a
30 fps track are both measured fairly.

Acknowledged bytes are reported only in Chromium-based browsers.

## Common tasks

### Find a viewer's session

Pass your own identifiers in `context`, or pass your own `sessionId`:

```typescript
const vitals = init({
  apiKey: 'mqt_pk_...',
  sessionId: playbackSession.id, // optional; a UUID is generated if you leave it out
  context: { actorId: user.id, contentId: stream.id },
})
```

`ids()` returns the session and instance IDs right away, before the session has begun. Put them
in your own logs or error reports to jump from a support ticket to the exact session in
Insight:

```typescript
const { sessionId, instanceId } = vitals.ids()
Sentry.setTag('moqtap.session', sessionId)
```

To find one connection, ask for the ID of a `WebTransport` you created, or list them all:

```typescript
const conn = vitals.connectionIdOf(transport) // undefined for a transport it never saw
vitals.connections() // every connection in the page and its linked workers, open ones first
```

Each entry in `connections()` has `id`, `realm` (page or worker), `origin`, `draft`,
`contentId`, `state` (`connecting`, `open` or `closed`) and, once closed, `closeCause`.

A `sessionId` longer than 128 UTF-8 bytes, or containing control characters, is replaced by a
generated one and reported as `MQ1113`. `ids()` returns the ID actually in use.

`actorId` is stored as given. If it identifies a person, treat it as personal data under your
privacy policy, pass an opaque ID instead, or set `privacy: { hashActorId: true }`. With
hashing on, `actorId` is sent as the first 32 hex digits of `sha256(apiKey + ':' + actorId)`,
and `ids()` returns that hash, so you can still look the viewer up.

### Label sessions with your own tags

`context.tags` adds up to 16 labels of your own, such as an experiment arm or a CDN, to find
sessions by later:

```typescript
init({
  apiKey: 'mqt_pk_...',
  context: { tags: { experiment: 'abr-b', cdn: 'edge-1' } },
})
```

A key is 1 to 32 characters and a value 1 to 128. A tag past the 16th, or outside those
bounds, is left out and reported as `MQ1114`; the rest are kept.

### Add your own player metrics

Register a metric once on the page, then call `observe()` as often as you like, in the page or
in a linked worker. Calling it more often doesn't increase how much is uploaded.

```typescript
vitals.defineMetric('timeToFirstFrame', { unit: 'ms', agg: 'gauge' })
vitals.defineMetric('decodeTime', { unit: 'ms', agg: 'histogram' })
vitals.defineMetric('droppedFrames', { unit: 'frames', agg: 'sum' })

video.requestVideoFrameCallback(function onFrame(now, meta) {
  vitals.observe('decodeTime', meta.processingDuration * 1000, { codec: 'av1' })
  video.requestVideoFrameCallback(onFrame)
})
```

| `agg` | Records | Good for |
|---|---|---|
| `sum` | the total per interval | counts: dropped frames, rebuffers, retries |
| `gauge` | the latest value | levels: buffer length, current bitrate |
| `histogram` | the distribution | timings: decode time, time to first frame |

Pass `buckets` (strictly ascending numbers) to a histogram to set your own boundaries.

Definitions carry into each new session. Samples observed before a session begins are
dropped.

Limits per session: 64 metrics, 8 labels per observation, 32 distinct label combinations per
metric, label values truncated to 64 characters. Going over a limit is reported through
`onInternalError` and never throws.

### Mark events on the timeline

`annotate()` adds a timestamped marker to the session, with any JSON-serialisable data, and
optionally the connection it is about:

```typescript
player.on('qualitychange', (q) => vitals.annotate('quality-switch', { to: q.height }, conn))
player.on('seek', (t) => vitals.annotate('seek', { to: t }))
```

An annotation made before the session begins is dropped.

### Switch content, or start a new session

When the player moves to a different stream, either label the new connections or start a new
session:

```typescript
// Same session; connections opened from now on carry this content id.
vitals.setContext({ contentId: 'live/room-43', tags: { cdn: 'edge-2' } })

// One session per playback: ends this one, starts the next, returns the new ids.
const { sessionId } = vitals.newSession({ contentId: 'vod/episode-2' })
```

`setContext()` takes `contentId`, `actorId` and `tags`. Tags add to the session's, and a key
given again replaces its value. Each call is recorded in the session with what it set.
`newSession()` takes `contentId` and an optional `sessionId` of your own; the new session
keeps the actor and tags. With a connection open, the new session begins at once. With none,
`newSession()` ends the current session and the new one begins with the next `WebTransport`.
Linked workers follow the page into the new session. After `end()` or `discard()`,
`newSession()` starts nothing and returns the IDs unchanged.

Calling `init()` again while a collector is still running replaces it: the new one takes over,
and `MQ1004` is reported. Use `newSession()` instead.

### Upload now, stop collecting, or honour an opt-out

```typescript
await vitals.flush()   // upload everything recorded so far; ends nothing
await vitals.end()     // end the session, upload everything, restore WebTransport
await vitals.discard() // delete everything unsent and send nothing more
```

You need `end()` only when you stop collecting for good while the page stays open. Closing the
page ends the session by itself, and so do 30 seconds with no connection open. A native shell
that kills its webview without a `pagehide` event should `await vitals.flush()` first.

Use `discard()` when the user withdraws consent. It deletes this session's unsent data from the
browser, including data saved for retry, and sends nothing.

`flush()` and `end()` wait at most 2 seconds for the upload (`upload.drainDeadlineMs`).
Anything not sent by then stays saved in the browser and is retried.

All three are safe to call straight after `init()`, before its setup has finished. The request
is applied as soon as setup completes. After `end()` or `discard()`, `init()` starts a new
collector.

### Players that run in a Web Worker

A worker has its own `WebTransport`, so the collector in the page can't see it. Import the
package in the worker as well, and link the two. The page names the worker. If the page opens no
`WebTransport` of its own, it needs no draft:

```typescript
// main.ts — the page
import { compose } from '@moqtap/collector/compose'
import { escalation, persistence, workers } from '@moqtap/collector/features'

const init = compose({ features: [workers, escalation, persistence] })
const vitals = init({ apiKey: 'mqt_pk_...' })

const worker = new Worker(new URL('./player.worker.ts', import.meta.url), { type: 'module' })
vitals.linkWorker(worker)
```

The worker calls `initWorker()`. It returns a probe at once, with no key and no `await`:

```typescript
// player.worker.ts — the worker
import { initWorker } from '@moqtap/collector/draft14/worker'

const vitals = initWorker()

const transport = new WebTransport('https://relay.example.com/moq')
await transport.ready
vitals.annotate('joined', undefined, vitals.connectionIdOf(transport))
```

The worker's `annotate()`, `observe()`, `escalate()` and `resolve()` go to the page's session.
Calls made before the worker is linked are kept until it is. As in the page, calls made before
a session begins are dropped; a `WebTransport` the worker constructs begins one. All
configuration comes from the page's `init()`. `ids()` in the worker returns `null` until it is
linked, then the page's IDs, and follows the page into each new session.

Call `linkWorker()` once per worker, including each replacement. With no argument,
`initWorker()` links over the worker's own global, which is what a plain `new Worker()` gives
you.

If the worker also runs an RPC library such as Comlink on its global, give the link its own
channel so neither side sees the other's messages:

```typescript
// the page
const { port1, port2 } = new MessageChannel()
worker.postMessage({ moqtapPort: port2 }, [port2])
vitals.linkWorker(port1)

// the worker, on receiving that message
const vitals = initWorker(event.data.moqtapPort)
```

`vitals.linked` in the worker resolves `true` once the page links it, or `false` after
`limits.linkTimeoutMs` (5 s); after `false` the probe stays inert and sends nothing. You need
to await it only for diagnostics. A worker the page links but that never answers is recorded as a
link `timeout`, and the rest of the session is unaffected.

**Deploy the page and worker bundles together.** A page and a worker from different collector
releases may not link.

#### Worker entry points

The worker entries export `initWorker` alone, without the page side:

| Import | Drafts | Flight recorder |
|---|---|---|
| `@moqtap/collector/worker` | all | yes |
| `@moqtap/collector/draftNN/worker` | one | yes |
| `@moqtap/collector/draftNN/thin/worker` | one | no |

Like every prebuilt entry, importing one wraps the worker's `WebTransport`. A worker with the
flight recorder needs a page with `escalation`, which every page entry but `/thin` includes.

## Teardown and page lifecycle

Without any call, the collector:

| When | It |
|---|---|
| a `WebTransport` is constructed | begins a session, unless one is running |
| a connection closes | records why, and uploads that connection's records |
| no connection has been open for 30 s | ends the session |
| the page is hidden | uploads what it holds |
| the page closes | ends the session and uploads the rest |
| the page enters the back/forward cache | uploads what it holds; the session goes on if the page is restored |
| an upload fails | retries it |
| the page closes with an upload unsent | sends it with the next session on the same origin |
| a linked worker is terminated | records its connections closed, with what it last reported |

Terminating a worker is safe at any time. Its open connections are recorded closed at once,
with everything measured up to that point. A worker linked over a `MessagePort` and then
terminated is counted gone after 10 seconds.

A tab killed without a `pagehide` event while visible loses at most the last 60 seconds.

## Detail levels

`detail` sets the level for the whole session. `escalate()` raises it for a window that
`resolve()` closes, and a flight-recorder trigger raises it to `headers` for the window it
opens.

| Level | Uploads |
|---|---|
| `baseline` | Control messages and the interval rollup |
| `headers` | Also one record per object: connection, track, stream, group ID, subgroup ID and publisher priority where the object states them, object ID, status and arrival time |
| `headers+sizes` | Also each object's payload size |
| `headers+data` | The same as `headers+sizes`: payloads never leave the device |

If uploads fall behind, per-object records are dropped first, and the session records how many
were dropped.

Any level above `baseline` counts as elevated time, toward your plan's recording minutes (see
[Budget and plan limits](#budget-and-plan-limits)). `detail` set above `baseline` in `init()`
counts for the whole session.

### Capture detail when playback goes wrong

The **flight recorder** keeps recent data in memory. When a trigger fires, it uploads
per-object arrival times, group and object IDs, and sizes for the seconds **before** the
problem, then raises the level to `headers` for the window that follows. Payloads are never
uploaded.

```typescript
const vitals = init({
  apiKey: 'mqt_pk_...',
  flightRecorder: {
    depth: '32MB',
    triggers: {
      stall: { afterMs: 2000 },
      cadence: { multiple: 3, minSamples: 20 },
    },
  },
})
```

| Trigger | Fires when |
|---|---|
| `stall` | a track has received nothing for `afterMs` (default 2000), once its median gap is established (`cadence.minSamples` gaps, or 20) and shorter than `afterMs` |
| `cadence` | a gap between objects exceeds `multiple` × the track's median gap (default 3×), once at least `minSamples` gaps (default 20) have been seen |

Because `cadence` is relative to each track's own median, one setting works for a 2-second-GOP
video track (fires after 6 s) and a 250 ms audio track (fires after 750 ms).

All triggers are **off** unless you list them. Triggers open at most one capture window every 30
seconds in a session, and on any one track. No trigger fires on a track that is no longer
subscribed or fetching, or whose connection has closed, and `stall` needs a subscribe or fetch
the collector saw for that track.

`depth` is a memory limit on the viewer's device (a size string like `'32MB'` or a number of
bytes). How many seconds it holds depends on the stream's bitrate. The memory is used only when
a trigger is set, in each page or worker that opens a `WebTransport`. A page that only links
workers uses none.

A dump too large for one upload is sent in slices. Each slice is a `flight` record with `part`,
`parts`, `dump` and `dumpEnd`; group them by `conn` and `dump`. `truncated` on a flight record
also means the oldest objects were left out to fit the dump's budget, and `windowStart` is then
the first object kept. A dump sent in one record has none of these fields.

The capture window closes when you call `resolve()`, after `flightRecorder.windowMs` (15 s by
default), when the recorder's memory has filled with data from after the trigger, or when the
page unloads.
The collector can't tell when your player has recovered, so call `resolve()` from your player's
recovery event to end elevated time promptly:

```typescript
player.on('playing', () => vitals.resolve())
```

`resolve()` is safe to call when no window is open, and safe to call twice.

### Mark an incident manually

`escalate()` opens a capture window from your own code, at the level you choose, with a reason
that is shown on the session timeline. It applies to the page and every linked worker.
`resolve()` closes it. Unlike trigger windows, a manual window has no timeout.

```typescript
try {
  await player.recover()
} catch (err) {
  vitals.escalate('headers+sizes', `recover failed: ${err.message}`)
} finally {
  vitals.resolve()
}
```

### Changes Insight makes while a session runs

Insight can change three things in a running session, within these bounds:

| What | When | Bounds |
|---|---|---|
| Shorter upload interval | someone has the session open in Insight | 1 to 10 s, for at most 10 minutes at a time |
| Raised detail | a capture window in Insight covers the session's release, user or content | up to `headers+sizes`, for at most 30 minutes, within `budget.elevatedMinutes` |
| Detail held at `baseline` | the workspace has used its recording minutes for the month | `baseline` only, for at most 10 minutes from each upload, renewed on every upload |

Raised detail is recorded on the session timeline as a remote escalation
(`by: { kind: 'remote' }`) and counted like any other. `resolve()` does not close it;
`escalate()` takes it over.

When the workspace's recording minutes for the month are used up, detail stays at `baseline`
until the UTC month ends or the workspace moves to a plan with more minutes: `escalate()`,
flight-recorder triggers and capture windows are refused, and a raised level returns to
`baseline` at the next rollup interval. A refused `escalate()` is not applied later; call it
again once the hold ends. After a move to a plan with more minutes, a held session returns to
its configured level within 10 minutes. Each change is recorded as a `hold` escalation
(`by: { kind: 'hold' }`).

A new session in the same page starts held. With the `persistence` feature, the hold is also
kept across page loads, in a second IndexedDB database (`moqtap-collector:holds`). Without it,
a new page load is held once its first upload is answered.

## Configuration

`apiKey` is the only required option.

```typescript
init({
  apiKey: 'mqt_pk_...',
  endpoint: 'https://ingest.example.com/v1/ingest',
  metrics: { intervalMs: 5_000 },
  upload: { intervalMs: 30_000 },
  budget: { elevatedMinutes: 30 },
  onInternalError: (err) => console.warn('[moqtap]', err),
})
```

| Option | Default | What it controls |
|---|---|---|
| `apiKey` | — | Your Insight project key. Required. |
| `endpoint` | `https://moqgest.com/v1/ingest` | Where uploads go. Set it to use your own ingest or a proxy. |
| `sessionId` | random UUID | Your own ID for the first session, up to 128 UTF-8 bytes. Later sessions get a random UUID. |
| `context` | empty | `actorId`, `contentId`, `environment`, `release`, `tags`. |
| `detail` | `'baseline'` | The level the whole session runs at. See [Detail levels](#detail-levels). |
| `metrics.intervalMs` | `10000` | How often a rollup closes. |
| `metrics.maxTracks` | `1024` | Tracks followed per session. Tracks over the limit are counted, not silently dropped. |
| `flightRecorder.depth` | `'32MB'` | Memory the recorder may use, per page or worker that opens a `WebTransport`. |
| `flightRecorder.triggers` | none | `stall`, `cadence`. All off unless listed. |
| `flightRecorder.windowMs` | `15000` | How long a trigger's capture window stays open without `resolve()`. |
| `budget.elevatedMinutes` | `60` | Elevated time allowed per session. When it's used up the session drops to `baseline` and refuses further escalation. |
| `upload.intervalMs` | `60000` | Upload at least this often. |
| `upload.byteThreshold` | `32768` | Upload early once this many bytes are waiting. While detail is raised they are counted gzipped, and one upload holds at most 64 times this uncompressed. |
| `upload.earlyFlushesMs` | `[45000]` | Extra uploads at these offsets after the session begins. |
| `upload.maxAttempts` | `5` | Attempts per upload round. An upload that runs out of attempts stays queued and is retried. |
| `upload.timeoutMs` | `10000` | How long one upload request may go unanswered. |
| `upload.drainDeadlineMs` | `2000` | How long `flush()` and `end()` wait for uploads to finish. |
| `storage.quotaBytes` | `8388608` | Space in IndexedDB for data waiting to upload. |
| `privacy.maskAuthParams` | `true` | Mask authorization tokens before anything is stored or sent. |
| `privacy.hashActorId` | `false` | Send a hash of `actorId` instead of the value. |
| `limits.linkTimeoutMs` | `5000` | How long a worker waits for the page to link it. |
| `limits.*` | see `DEFAULTS` | Safety caps: concurrent transports (8), control messages per second (5,000), the pre-`init()` buffer (1 MB). |
| `onInternalError` | none | Receives configuration problems and internal errors. The collector never throws into your code after `init()` returns. |

The exported `DEFAULTS` object holds every default.

### Uploads and storage

The `upload` options set how often the page uploads. It also uploads when a connection closes,
when the page is hidden, on `flush()` and `end()`, and when the page closes.

Data that can't be sent is kept in IndexedDB (database `moqtap-collector`) and sent with the
next session on the same origin. If ingest is unreachable, slow or failing, your player isn't
affected.

Workers use neither the network nor IndexedDB. Everything they record is uploaded by the page.

If `endpoint` is a proxy in front of Insight's ingest, return ingest's responses with their
headers unchanged, and on a cross-origin proxy let the page read them
(`Access-Control-Expose-Headers`). Otherwise uploads still arrive, but Insight can't make the
[changes it makes while a session runs](#changes-insight-makes-while-a-session-runs).

## Content Security Policy

The collector only connects to `endpoint`, with `fetch()` and `navigator.sendBeacon()`. Add the
endpoint's origin to `connect-src`:

```http
Content-Security-Policy: connect-src 'self' https://moqgest.com;
```

If you set `endpoint` to your own domain, `'self'` already covers it.

Nothing else in your policy needs to change. The collector uses no `eval`, `new Function`,
injected `<script>`, `blob:` worker or runtime chunk loading.

## Entry points

MoQT's wire format differs between drafts. The collector supports **drafts 07 through 22**. Your
bundle holds the drafts and features you import and nothing else. If your relays use one draft,
import that draft's entry:

```typescript
import { init } from '@moqtap/collector/draft22'
```

Every entry has the same API and installs the wrapper on import. Use the same draft in the page
and its workers. A connection that negotiates a draft the entry doesn't carry is reported as
`draft-mismatch` and isn't decoded, rather than being measured with the wrong decoder. A call
that needs a feature the entry doesn't carry is ignored and reported once, as `MQ1006` with the
feature's name.

Measured as a page imports `init` or `initWorker`, with `bun build --target=browser --minify`
and `gzip -9` (`bun run size` in the package):

| What the browser downloads | gzipped |
|---|---:|
| `@moqtap/collector`: every draft, every feature | 72.3 KB |
| `@moqtap/collector/draftNN`: one draft, every feature | 52.7–55.2 KB |
| `@moqtap/collector/draftNN/thin`: one draft, no optional feature | 40.1–42.7 KB |
| `compose({ features: [workers] })`: a page whose connections are in a worker | 19.6 KB |
| `@moqtap/collector/worker`: every draft, in a worker | 51.2 KB |
| `@moqtap/collector/draftNN/worker`: one draft, in a worker | 32–34.5 KB |
| `@moqtap/collector/draftNN/thin/worker`: one draft, no flight recorder | 27.6–30.1 KB |

The optional features are:

- `workers`: `linkWorker()`.
- `escalation`: `escalate()`, and a `detail` above `baseline`.
- `flightRecorder`: the `stall` and `cadence` triggers. A page needs `escalation` with it.
- `customMetrics`: `defineMetric()` and `observe()`.
- `persistence`: stores each upload in IndexedDB until ingest accepts it, so one the page could
  not send goes out on the next page load. It also keeps a hold on detail across page loads.

### Compose your own

`compose()` builds a collector from the drafts and features you name. Call it at module level,
before your player constructs its first `WebTransport`:

```typescript
// collector.ts
import { compose } from '@moqtap/collector/compose'
import { draft14 } from '@moqtap/collector/draft14/decoder'
import { persistence, workers } from '@moqtap/collector/features'

export const init = compose({ drafts: [draft14], features: [workers, persistence] })
```

With no draft, the page leaves its own `WebTransport` unwrapped and records what its linked
workers send. `composeWorker({ drafts, features })` does the same for a worker, where
`flightRecorder` is the one feature that applies.

The collector loads no code at runtime, so it works in single-file bundles, IIFE worker builds
and pages whose CSP blocks runtime chunk loading, with no extra setup.

:::caution
If your own code imports `@moqtap/codec`, import its draft entries. The `@moqtap/codec` root and
`@moqtap/codec/session` pull in every draft, which undoes a single-draft collector entry.
:::

## Privacy

Uploaded:

- Per-track counters and histograms, including missing group ranges and stream resets.
- The session's control messages, with authorization token values masked.
- Each connection's relay (scheme, host and port), the `WebTransport` options the page passed
  (server certificate hashes as a count only), and who closed it.
- Your `context` (including tags), custom metrics and annotations. `actorId` is hashed first
  when `privacy.hashActorId` is on.
- While the level is above `baseline`: per-object header records (including subgroup and
  publisher priority where the object states them) and flight-recorder data (timings, IDs,
  status and, from `headers+sizes`, sizes).

Never uploaded:

- **Object payloads.** The flight recorder's memory stays on the device. `headers+data` uploads
  nothing more than `headers+sizes`.
- **Authorization token values.** Whether a token was sent, its type and its alias are kept, so
  a failed authentication can still be diagnosed. To send token values, set
  `privacy: { maskAuthParams: false }`. Only a real boolean `false` turns masking off; a string
  like `"false"` is reported as `MQ1102` and ignored.

## Budget and plan limits

Every session counts toward your plan's monthly sessions, including one whose only connection
failed to open. A page that never constructs a `WebTransport` produces no session and isn't
counted. A page that connects again after 30 seconds with no connection open starts a new
session.

Baseline collection is always on and does not use recording minutes.

Time above `baseline` counts toward your plan's monthly recording minutes, in whole seconds,
rounded down, with a one-second minimum per window. A 4.9-second window counts 4 seconds; two
200 ms windows count 2 seconds. `budget.elevatedMinutes` caps elevated time per session.
Nothing over a plan's limits is charged; the limits per plan are on the
[pricing page](/pricing#compare).

`vitals.usage()` returns the collector's own count of bytes sent per level and elevated
seconds. Use it to estimate recording minutes while you tune triggers. Insight counts what it
receives, not this figure.

## Errors

`init()` throws only in three cases:

| Code | Cause |
|---|---|
| `MQ1001` | no config object |
| `MQ1002` | no `apiKey` |
| `MQ1003` | `endpoint` was given but isn't a usable URL string |

Every other problem, such as a mistyped key or an out-of-range number, is reported and the
default is used. To handle these in code, pass `onConfigProblem` as the second argument:

```typescript
init(config, {
  onConfigProblem: ({ key, code, got }) => {
    console.warn(`moqtap config ${key}: ${code}`, got)
  },
})
```

Runtime errors arrive at `onInternalError` as `Error` objects whose message is the code
followed by the offending value, for example `MQ1101: metrics.intervalMs -1`. Every code is
explained in
[ERROR-CODES.md](https://github.com/moqtap/moqtap-js/blob/master/packages/collector/ERROR-CODES.md),
and the package ships the same list as `error-codes.json`. Codes are never reused for a
different meaning.

`initWorker()` never throws, and `vitals.linked` never rejects.

## Troubleshooting

### No sessions appear in Insight

Open the browser's developer tools, play a stream, and filter the Network panel for
`moqgest.com` (or your own `endpoint`). Uploads come from the page, never from a worker. The
first one goes out as soon as a session begins, when the page or a linked worker constructs a
`WebTransport`.

**There are no upload requests at all.** The collector never saw a `WebTransport`:

- **The player opens its `WebTransport` in a Web Worker.** This is the most common cause. The
  collector in the page can't see a worker's connections. Add `initWorker()` in the worker and
  `linkWorker(worker)` in the page, as in
  [Players that run in a Web Worker](#players-that-run-in-a-web-worker). If you're not sure,
  search your player's code for `new Worker(`.
- **The collector is imported too late.** A connection opened before the import is invisible.
  See [Import order](#import-order).
- **The player isn't using WebTransport.** A player that falls back to WebSocket isn't
  measured.

**A worker's connections are missing.** Check, in the worker, what `await vitals.linked`
resolves to:

- `false`: the page never linked it. Call `linkWorker()` on the page for every worker,
  including each replacement, and on the same port the worker passed to `initWorker()`.
- The page and the worker were built from different collector releases, which may not link.
  The page records the worker as a link `timeout`. Deploy both bundles together.

**A connection shows `draft-mismatch`.** It negotiated a draft the imported entry doesn't
decode. Import the root entry, or the entry for the draft your relays use, in both the page and
its workers.

**Requests fail before reaching the network.** Your Content Security Policy blocks them, and the
console names the directive. Add the endpoint's origin to `connect-src`, as in
[Content Security Policy](#content-security-policy).

**Requests are answered `401` or `403`.** Ingest refused them:

- `401`: the key is wrong, or it was created in the last two minutes and isn't live yet.
- `403`: the key is disabled, or your page's origin isn't on the key's allowed origins.

Uploads answered `202` are accepted, and the session appears in Insight within a minute or two.

## Requirements

- A browser with `WebTransport`. Pages are served over HTTPS, which `WebTransport` requires
  anyway.
- `CompressionStream` for compressed uploads. Without it, uploads are sent uncompressed and
  `MQ2201` is reported.

The [moqtap browser extension](/products/browser-extension/) shows whether the collector is
present on a page and whether `init()` has been called.

## License

[FSL-1.1-MIT](https://github.com/moqtap/moqtap-js/blob/master/packages/collector/LICENSE). You
can use it in any application, commercial or not, modify it and ship it to your users. You
can't use the code to build a competing product. Each release becomes MIT two years after it
is published.

[`@moqtap/codec`](/npm-packages/moqtap-codec/), [`@moqtap/inspect`](/npm-packages/moqtap-inspect/)
and [`@moqtap/trace`](/npm-packages/moqtap-trace/) are MIT.
