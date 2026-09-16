# @moqtap/collector

**Importing this package patches `globalThis.WebTransport`.** It happens at
module-evaluation time — before your own entry file's body runs, because ESM
imports are hoisted — and there is no call site to see it at. The patch wraps
the `getReader()` / `getWriter()` seam on the session's streams so bytes can be
counted as they cross it. It does not tee the stream: teeing would double the
buffering and change the backpressure your player observes. **Until you call
`init()` with a key, it is dormant — it copies recent wire bytes into a small
bounded in-memory ring, continuously overwrites that ring, and transmits
nothing, anywhere, ever.** No network request of any kind is made before a key
arrives. Both `stop()` and `abort()` restore the original global and detach the
per-instance patches on sessions already open. This is the first paragraph
rather than a line in the install guide because a dependency that patches a
global with no visible call site is exactly the shape security reviewers are
trained to flag, and you should not have to find it yourself.

Why it installs that early: the hook has to be in place before the first
`new WebTransport()` in your application, and configuration — your API key, your
endpoint — is frequently not known until later. Installing dormant and
configuring afterwards is what lets both be true. The ordering is the reason;
the dormancy is the safeguard.

## Content Security Policy

The only thing that ever leaves the page is an upload to the `endpoint`: a
`fetch()` POST on the main path, and a `navigator.sendBeacon()` for the session
tail at `pagehide`. Both are governed by `connect-src`, so the endpoint's
**origin** has to be in it.

`endpoint` defaults to the hosted ingest, so unless you override it the
directive is:

```
Content-Security-Policy: connect-src 'self' https://ingest.moqtap.com;
```

If you point `endpoint` at your own collector, use that origin instead — scheme
and host, no path. If that is your own domain, `'self'` alone is enough and no
change is needed at all.

**Nothing else in your policy has to move.** There is no `eval`, no
`new Function`, no injected `<script>` element, and no `blob:` worker, so
`script-src`, `worker-src` and `unsafe-eval` are untouched. The one nuance is
`import()`: the collector loads the decoder for the negotiated draft with a
dynamic import, which your bundler emits as an ordinary chunk served from your
own origin, so an existing `script-src 'self'` (or a `'strict-dynamic'` policy)
already covers it. If your build cannot emit chunks at all, pin the draft
instead — see [Draft loading](#draft-loading-and-bundle-size) — and no dynamic
import happens.

## What it collects, and what it never does

It reads MoQT wire structure off the WebTransport seam: object and group ids,
byte counts, arrival times, control-message frames, and the negotiated draft.
What goes to your endpoint is a rollup — per-track counters and fixed-boundary
histograms on an interval — plus the control-plane frames, and, only when you
raise the detail level, object headers.

**Object payloads never leave the device.** On the counting path they are
skipped outright: the decoder walks each header, adds to counters, and advances
past the payload without copying it out of the page's buffer or retaining it.
The flight-recorder ring is the only place raw payload bytes are held at all,
and that ring is memory-only, continuously overwritten, never persisted and
never uploaded — what crosses out of it on a trigger is derived timings, not the
bytes that produced them. That is also why its `depth` is a memory budget on
your user's device and nothing else.

Track *names*, namespaces and status strings never leave the device. Rollup
buckets are keyed by the number already on the wire — the track alias for
subgroup and datagram streams, the request id for fetch streams — tagged with
direction and an epoch that increments when the control plane rebinds a live
alias. Names are joined server-side from control bytes that were shipped
anyway.

**Authorization tokens are removed before anything keeps them, and that is on
by default.** SETUP and SUBSCRIBE parameters carry bearer tokens alongside the
namespaces and track names, and a collector that shipped those verbatim would
have turned a debugging tool into a credential-exfiltration path. Every
Authorization Token *value* is overwritten at the point of parse, per draft,
using the codec that already knows which parameter carries what — not by a
regex over bytes, which would be both leaky and unstable.

What survives is the *fact*, not the value: the parameter, its Alias Type, its
Token Alias and its Token Type all stay, so a session that failed to
authenticate still looks different from one that never tried, and a token
reused across messages is still visible as the same alias. The frame keeps its
exact length. Nothing downstream — the envelope, the rollup, the flight
recorder — is ever handed a structure containing a token, because the frame is
masked before it is decoded.

Set `privacy: { maskAuthParams: false }` if you have decided your tokens may
travel to your endpoint. Nothing else turns it off: a value that merely looks
false, out of JSON or an environment variable, is reported and ignored.

The control plane is also, deliberately, the one thing the flight-recorder ring
does not hold. Nothing read those bytes — the replay walks data streams only,
and baseline already ships every control frame — so dropping them removes the
one place a token could have sat in memory unmasked.

Percentiles are never computed here either. Histograms go out as fixed
log-spaced buckets that merge by elementwise addition, and every mean ships its
denominator.

## Install

```bash
npm install @moqtap/collector @moqtap/codec
```

`@moqtap/codec` is a peer dependency — install it alongside. The collector pulls
in one draft's decoder from it, not the whole codec; see below.

## Quick Start

```typescript
import { init } from '@moqtap/collector'

const vitals = init({
  apiKey: 'pk_live_...',
  // `endpoint` is optional: it defaults to https://ingest.moqtap.com/v1/ingest.
  // Set it to send somewhere else instead.
  // What this session is about. actorId is whoever is at this end — a viewer, a
  // broadcaster or a service. It is not hashed and it is not bounded; see the
  // docs on cardinality.
  context: {
    actorId: currentUser.id,
    contentId: 'live/room-42',
    environment: 'production',
    release: '4.2.1',
  },
})
```

Everything else is grouped by what you are deciding, not by which module reads
it — `metrics` (how often the rollup closes, how many tracks it follows),
`flightRecorder` (depth, triggers, and how long a triggered window stays open),
`budget` (elevated minutes), `upload` (when to flush, how hard to retry, when to
give up), `storage`, `privacy` (auth-token masking, on by default) and
`limits`. `limits` means what it says: safety valves a
healthy integration never touches.

```typescript
const vitals = init({
  apiKey: 'pk_live_...',
  endpoint: 'https://ingest.your-company.example/v1/ingest', // overrides the default
  metrics: { intervalMs: 10_000 },
  budget: { elevatedMinutes: 60 },
  upload: { intervalMs: 60_000, byteThreshold: 32 * 1024 },
})
```

That is a complete baseline session: control-plane bytes plus an interval
rollup — 1.8 KB gzipped per ten minutes on the captures it was measured
against — reporting per-track object rate, bitrate, group cadence, group gaps,
duplicates, out-of-order arrivals, stall duration and control-exchange
latencies. Baseline is always on and always the same. Everything above it is a
dial you turn.

```typescript
// Your own numbers, folded at fixed cost per interval regardless of sample count.
vitals.defineMetric('decodeMs', { unit: 'ms', agg: 'histogram' })
vitals.observe('decodeMs', frame.decodeDuration)

// A marker in the timeline.
vitals.annotate('quality-switch', { to: '720p' })

// Session, connection and actor ids — synchronous, available before the first
// object arrives, so you can put them in your own logs and join later.
const { sessionId, connectionId } = vitals.ids()
```

### Stopping

Two verbs, and they differ in exactly one thing.

```typescript
await vitals.stop()   // flush what is buffered, then tear down
await vitals.abort()  // drop everything, transmit nothing further, tear down
```

`abort()` is the one to call when the reason you are stopping is that you no
longer want the data to leave the device — a consent withdrawal, an opt-out, a
test fixture. It clears this session's persisted queue unconditionally.
`stop()` clears only what it successfully sent: a `stop()` that fails to reach
the network leaves the backlog persisted for the next page load rather than
destroying it, because a backlog is largest exactly when the session was most
worth having.

## Draft loading and bundle size

MoQT is pre-RFC and the wire format differs per draft, so a decoder has to match
the negotiated protocol. The collector speaks **drafts 07 through 20** — every
draft `@moqtap/codec` implements — and loads **only the one negotiated**, with a
static literal specifier a bundler can follow:

```typescript
// what the collector does internally — fourteen literals, one chunk each
 7: () => import('@moqtap/codec/draft07'),
 8: () => import('@moqtap/codec/draft08'),
// …
20: () => import('@moqtap/codec/draft20'),
```

Fourteen drafts cost **182 bytes gzipped** on the always-loaded entry, because
the drafts themselves are not in it. A session downloads its own draft's chunk
and no other:

| what a page pays | gzipped |
| --- | ---: |
| the always-loaded entry, any draft | 33.4 KB |
| **+ the one draft chunk it negotiates** | **+1.9 KB** |
| + that draft's codec decoder | +5.2 – 7.8 KB |

The sum of all fourteen chunks is 42.9 KB, and nothing downloads it. It is worth
naming only because a jump in it means a shared module stopped being shared.

### Which draft a session is speaking

From draft-15 the ALPN says: `moqt-15` through `moqt-20` each name one draft, and
the version appears nowhere else on the wire.

**Drafts 07 through 14 all negotiate `moq-00`** — one ALPN for eight drafts —
and settle the version in band, in SETUP. For those the collector reads the
selected version out of the handshake it is already buffering, and matches it
against a table of the fourteen it has decoders for. A version outside that
table, including real drafts like -06 that predate `@moqtap/codec`, degrades the
session to transport-only metrics rather than being rounded to the nearest draft
that exists.

Nothing is ever guessed. A draft the collector cannot identify from evidence
means the adapter is withheld entirely, raw control bytes keep shipping for
server-side reparse, and `SetupRecord.degraded` says so — because the two varint
families disagree on the same bytes and the loser returns a plausible wrong
number rather than an error.

> **Never import the `@moqtap/codec` root or `@moqtap/codec/session` yourself.**
> Both statically pull all fourteen drafts: **39.6 KB gz**, against **5.3 KB**
> for one draft's decoder. That is a 7.5x regression, and it looks exactly like
> every other import line in review. Import `@moqtap/codec/draft20` — a static
> string, never `` import(`@moqtap/codec/draft${n}`) ``, which defeats bundler
> analysis and pulls all fourteen anyway. This package's own build refuses to
> compile if any file under `src/` names the root entry.
>
> The same applies to this package: `@moqtap/collector/draft14` is one draft;
> there is deliberately no entry point that means "all of them".

| bundle | gzipped |
| --- | ---: |
| `@moqtap/codec` root — all fourteen drafts | 39.6 KB |
| draft-20 entry, full | 13.6 KB |
| **draft-20, decode only** | **5.3 KB** |
| **draft-14, decode only** | **4.0 KB** |

For builds that cannot dynamic-import — a strict CSP with no chunk loading, a
single-file bundler — pin the drafts instead. The pin selects among the same
literal specifiers the bundler can already see; it substitutes nothing, and the
import becomes eager at init:

```typescript
init({ apiKey, endpoint, drafts: [16, 14] })
```

Pinning is also how a build that only ever talks to one relay avoids shipping the
question at all. `@moqtap/collector/draft07` through `@moqtap/collector/draft20`
are the draft-partitioned entry points for referencing one draft's adapter
directly.

## Detail, and what it costs

```typescript
init({
  apiKey,
  endpoint,
  detail: 'baseline', // 'baseline' | 'headers' | 'headers+sizes' | 'headers+data'
})
```

Raising detail changes how much is **shipped**, not how precisely anything is
measured. Against real draft-14 captures, `headers` is 191x the control plane
and `headers+sizes` is 282x. That range is too wide for one flat price, which
is why elevation is metered and baseline is not. Elevation can also be raised
from code:

```typescript
vitals.escalate('headers+sizes', 'user reported a stall')
// ...once the incident is over:
vitals.resolve()
```

Elevation is billed as a **capture window**, in whole seconds, rounded down,
with a one-second minimum. A window that lasts 4.9 s bills 4 s, one that lasts
200 ms bills 1 s, and two 200 ms windows bill 2 s — the rounding is per window,
not per session.

`resolve()` is the primary way a window closes. It is safe to call with nothing
open and safe to call twice, so it belongs in the `catch` block beside the call
that raised detail. A window also closes when the recorder's ring fills, when
the page unloads, and — for a window a trigger opened — after
`flightRecorder.windowMs`, 15 s by default. There is deliberately no automatic
"the fault recovered" close: the collector sees objects arriving, not a rebuffer
ending or a seek completing, and a collector that guessed would close early on a
stall that was still happening and hold open through one that had ended.

The flight recorder is the other axis, and it is not the same one. It is a ring
of raw wire bytes — payloads included — held **in memory only**, never
persisted, never uploaded as-is, continuously overwritten, with nothing parsed
out of it in the ordinary case. On a trigger it is re-parsed at full resolution
and yields per-object wire timings for the window *before* the event. Armed
costs nothing and is not billable; a trigger opens a capture window, and that
is.

```typescript
init({
  apiKey,
  endpoint,
  flightRecorder: {
    depth: '32MB', // a memory budget on your user's device, bounded in bytes
    triggers: {
      stall: { afterMs: 2000 },
      cadence: { multiple: 3, minSamples: 20 }, // 3x this track's own median
    },
  },
})
```

All triggers are absent by default: automated mode ships **off**. The cadence
trigger is a multiple of the track's own observed median interval, so one config
key fires at 6,000 ms on a 2 s GOP and at 750 ms on a 250 ms one without your
telling it your GOP length — and it does not fire at all until that median is
warm.

## Workers

A dedicated `Worker` that opens its own WebTransport is a separate JavaScript
realm with its own `globalThis`, so the page's hook cannot see it. Call
`initWorker()` inside the worker; it handshakes over the `MessagePort` you
already have. Nothing is rewritten, no `blob:` URL is substituted for your
worker, and if the worker never imports the collector the handshake message is
ignored.

**It fails closed.** A session whose worker never handshook is marked `partial`
on its setup and terminal records rather than being reported as complete —
reporting a partial session as whole is worse than reporting nothing.

## Limits are named, not constant

Every threshold is a config key with a recorded default, including the ones a
specification would ordinarily hard-code: the flush schedule, the byte
threshold, the concurrent-transport cap, the storage quota, the dormant ring's
own size. Read them from `DEFAULTS`, and each one's provenance — including
`"guess, pending field data"`, which is a legitimate answer — from
`DEFAULT_PROVENANCE`.

Where a bound would clip real data, the collector counts and reports instead of
clipping. Over-counting is visible; truncation is not, and a clipped session
looks exactly like a short one to the developer who came to find it.

## Errors

Every error this package reports carries a code, and the runtime message is the
code plus the offending value:

```
MQ2101: 1.5
│       └ the value that was rejected
└ the code
```

The wording lives in **[ERROR-CODES.md](./ERROR-CODES.md)**, not in the bundle.
That is deliberate: an explanation worth reading is longer than any message a
library should make every page carry, and a code costs six bytes. The same
content is in [`error-codes.json`](./error-codes.json) for tooling.

Configuration problems are reported rather than thrown — `init()` throws only
for a missing config object, a missing `apiKey`, and an `endpoint` that was
supplied but is not a usable string — and arrive as `{ key, code, got }` on
`onConfigProblem`, so you can switch on the code rather than parse a sentence.

Codes are permanent. A retired code is never reissued for a new meaning.

## Status

Version 0.1.0, not yet published. The wire envelope and the record schemas are
still moving; treat both as unstable until 1.0.

## License

[Functional Source License 1.1, MIT Future License](./LICENSE) (`FSL-1.1-MIT`).

Embed it in your application, commercial or not, modify it, ship it to your
users. The one thing it withholds is publishing a competing product built from
this code. Two years after each release, that release becomes MIT.
