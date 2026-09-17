# @moqtap/collector

Client-side monitoring for [MoQT](https://datatracker.ietf.org/doc/draft-ietf-moq-transport/)
sessions in the browser. It reports per-track throughput, object and group
cadence, stalls, gaps, duplicates, out-of-order arrivals and control-exchange
latency for every WebTransport MoQT session in the page, with no change to your
player code.

> **Importing this package patches `globalThis.WebTransport`,** at
> module-evaluation time — that is how it sees a session with no call site in
> your code. Until you call `init()` with a key it stays dormant: it copies
> recent wire bytes into a small bounded in-memory ring and makes no network
> request of any kind. `stop()` and `abort()` restore the original global.

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
  apiKey: 'pk_live_...',
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
has to be in it. `endpoint` defaults to `https://ingest.moqtap.com/v1/ingest`:

```http
Content-Security-Policy: connect-src 'self' https://ingest.moqtap.com;
```

Point `endpoint` at your own collector and use that origin instead — scheme and
host, no path. Nothing else in your policy has to move: there is no `eval`, no
`new Function`, no injected `<script>` element and no `blob:` worker.

## Configuration

`apiKey` is the only required key. The rest is grouped by what you are deciding:

| Key              | What it controls                                                  |
| ---------------- | ----------------------------------------------------------------- |
| `endpoint`       | Where uploads go. Defaults to the hosted ingest.                   |
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
  apiKey: 'pk_live_...',
  endpoint: 'https://ingest.your-company.example/v1/ingest',
  metrics: { intervalMs: 10_000 },
  budget: { elevatedMinutes: 60 },
  upload: { intervalMs: 60_000, byteThreshold: 32 * 1024 },
})
```

Every threshold is a config key with a recorded default. Read the defaults from
`DEFAULTS`, and each one's provenance from `DEFAULT_PROVENANCE`.

## API

```typescript
// Your own numbers, folded at fixed cost per interval regardless of sample count.
vitals.defineMetric('decodeMs', { unit: 'ms', agg: 'histogram' })
vitals.observe('decodeMs', frame.decodeDuration)

// A marker in the timeline.
vitals.annotate('quality-switch', { to: '720p' })

// Synchronous, available before the first object arrives.
const { sessionId, connectionId } = vitals.ids()

// Raise detail for an incident, then close the capture window.
vitals.escalate('headers+sizes', 'user reported a stall')
vitals.resolve() // safe with nothing open, and safe to call twice

await vitals.stop() // flush what is buffered, then tear down
await vitals.abort() // drop everything, transmit nothing further, tear down
```

`abort()` is the one to call when the reason you are stopping is that you no
longer want the data to leave the device — a consent withdrawal, an opt-out, a
test fixture. It clears this session's persisted queue unconditionally.
`stop()` clears only what it successfully sent, so a `stop()` that fails to
reach the network leaves the backlog for the next page load.

## Drafts

Drafts 07 through 21, negotiated per session. Only the negotiated draft's
decoder is loaded, behind a static literal specifier a bundler can follow.

> **Never import the `@moqtap/codec` root or `@moqtap/codec/session` yourself.**
> Both statically pull every draft, against a fraction of that for one draft's
> decoder, and it looks exactly like every other import line in review. Import
> `@moqtap/codec/draft20` — a static string, never
> `` import(`@moqtap/codec/draft${n}`) ``, which defeats bundler analysis.

For builds that cannot dynamic-import — a strict CSP with no chunk loading, a
single-file bundler — pin the drafts instead. The pin selects among the same
literal specifiers the bundler can already see, and the import becomes eager at
init:

```typescript
init({ apiKey, drafts: [20, 18] })
```

`@moqtap/collector/draft07` through `@moqtap/collector/draft21` are the
draft-partitioned entry points for referencing one draft's adapter directly.

## Workers

A dedicated `Worker` that opens its own WebTransport is a separate JavaScript
realm with its own `globalThis`, so the page's hook cannot see it. Import the
package in both realms and link them: the page names the worker, the worker
waits for the page's config.

```typescript
// main.ts -- the page
import { init } from '@moqtap/collector'

const vitals = init({ apiKey: 'pk_live_...' })

const worker = new Worker(new URL('./transport.worker.ts', import.meta.url), {
  type: 'module',
})
vitals.linkWorker(worker)
```

```typescript
// transport.worker.ts -- the worker
import { initWorker } from '@moqtap/collector'

// The import already installed the dormant hook in this realm. With no
// argument the handshake runs over the worker's own global, which is what a
// plain `new Worker()` gives you; pass a port for a SharedWorker or an
// explicit MessageChannel. The key is never repeated here -- it arrives from
// the page.
const vitals = await initWorker()

const transport = new WebTransport('https://relay.example.com/moq')
await transport.ready
```

`linkWorker()` arms the fail-closed rule: from that call the session is marked
`partial` on its setup and terminal records until the worker answers, so a
worker that never imports the collector leaves the session reported partial
rather than complete. If the page never links it, the worker's handshake times
out after 5 s, `vitals.linked` is `false`, and every verb on the returned
collector is inert -- it transmits nothing.

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
