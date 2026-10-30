# Changelog

All notable changes to `@moqtap/monitor-browser`, published as `@moqtap/collector`
until 0.11.0, will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Rollup tracks carry `rq`, the request they are delivered for, and receive
  tracks carry `ga`, the first-object arrival of a sample of groups, at most
  ten a second a track. New session counters: `ga.dropped`, `ga.late`.
- The batch record carries `clock` `{o, r, n, a}`, the device's clock against
  ingest's. Absent when no recent `fetch()` upload got
  ingest's timestamped reply.

## [0.12.0] - 2026-10-28

### Changed

- Renamed from `@moqtap/collector`.

## [0.11.0] - 2026-10-26

### Added

- A flight dump too large for one upload is sent in slices. Each slice is a
  `flight` record with `part`, `parts`, `dump` and `dumpEnd`; group them by
  `conn` and `dump`.
- `TrackLiveness` type.
- With `persistence`, a hold on detail is kept across page loads, in a second
  IndexedDB database, `moqtap-collector:holds`. A new session in the same page
  starts held, with or without `persistence`.

### Changed

- **Breaking:** a page and its workers must use the same release; a worker
  from another release is reported as `timeout` and not linked.
- `stall` fires only on a track still subscribed or fetching on an open
  connection, after the cadence warm-up (`cadence.minSamples`, or 20), and only
  when the track's median is shorter than `afterMs`.
- While detail is raised, `upload.byteThreshold` counts gzipped bytes; an
  upload holds at most 64 times the threshold uncompressed.
- `truncated` on a flight record also means the oldest objects were left out
  to fit the dump's budget; `windowStart` is then the first object kept.
- A capture window still open when a session ends is recorded as closed by
  `unload`, and a level held at `baseline` stays there.
- With workers linked, `MQ1006` for `flightRecorder.triggers` is reported when
  a WebTransport opens in a page without a flight recorder, or when a worker
  without one links.
- Compression runs 32 KB at a time, with a task between pieces.

### Fixed

- A trigger refused by a hold or the ceiling no longer leaves a worker
  recording at `headers`.
- `stall` and `cadence` no longer fire on a track that has ended or whose
  connection has closed.
- A flight dump no longer pushes stored or queued uploads out.
- Flight dumps after a reconnect hold only the triggering connection's objects.
- A worker that goes silent and resumes no longer has its interval counted twice.
- A burst of worker forwards larger than the page's buffer is no longer dropped.
- Everything sent at `pagehide` fits the beacon.

## [0.10.0] - 2026-10-24

### Added

- While the workspace has used its recording minutes for the month, detail
  is held at `baseline`: `escalate()`, flight-recorder triggers and capture
  windows are refused, and a raised level drops to `baseline` at the next
  rollup interval. The hold ends when the UTC month ends, or within 10
  minutes of a move to a plan with more minutes.
- `EscalationRecord.by` has a new kind, `hold`, and `Directive` has a new
  field, `hold`.

## [0.9.1] - 2026-10-22

### Changed

- Smaller in pages built for browsers without class private fields (es2019,
  Safari 13, Chrome 87): a worker-linked page is 21 KB gzipped at es2019,
  down from 23 KB.

## [0.9.0] - 2026-10-22

### Added

- `@moqtap/monitor-browser/draftNN/thin` and `@moqtap/monitor-browser/draftNN/thin/worker`:
  one draft and no optional feature.
- `@moqtap/monitor-browser/compose`: `compose()` and `composeWorker()` build a
  collector from the drafts in `@moqtap/monitor-browser/draftNN/decoder` and the
  features in `@moqtap/monitor-browser/features`: `workers`, `escalation`,
  `flightRecorder`, `customMetrics` and `persistence`.
- A page built with no draft leaves its own `WebTransport` unwrapped and records
  what its linked workers send.
- `MQ1006`: a call or an option needs a feature the build does not include.

### Changed

- A bundle holds only the drafts and features its entry imports.
  `@moqtap/monitor-browser/draft14` is 46.9 KB gzipped as a page imports it, a
  worker-only page 17 KB.
- `@moqtap/monitor-browser` and `@moqtap/monitor-browser/draftNN` export `init` and no
  longer `initWorker`; import that from `@moqtap/monitor-browser/worker` or
  `@moqtap/monitor-browser/draftNN/worker`.
- `adapter`, `DRAFTNN_ADAPTER` and `draft` are exported from
  `@moqtap/monitor-browser/draftNN/decoder`. `PROTOCOL_STRINGS` is no longer
  exported.
- Requires `@moqtap/codec` 0.13.4.

## [0.8.0] - 2026-10-22

### Changed

- A session begins when the page or a linked worker constructs a
  `WebTransport`, not at `init()`. Before that nothing is recorded, stored or
  uploaded, so a page without one produces no session. `ids()` answers
  beforehand with the ids the session is uploaded under.
- Clock zero is the session's begin. Context set before it is sent with
  `setup`; annotations, metric samples and `escalate()` calls before it are
  dropped.
- A session ends 30 s after its last connection closes, with `end` reason
  `idle`. The next `WebTransport` begins a new session with new ids and the
  context so far.
- `newSession()` with no connection open ends the session; the next
  `WebTransport` begins the new one.
- Metric definitions carry into each new session.

### Fixed

- A connection that failed to open before `init()`, or before its worker was
  linked, is reported.

## [0.7.1] - 2026-10-22

### Added

- Each connection reports when it became ready, so Insight tells failed
  connection attempts apart from connections that dropped.
- Each connection reports the drafts the page offered, so Insight can name them
  when none was negotiated.
- A session started by `newSession()` reports when it began, so its first
  object time is measured from then.

### Changed

- A draft-07 to draft-14 connection that closes before the server's SETUP reply
  is no longer reported as an unsupported protocol.

## [0.7.0] - 2026-10-22

### Added

- `@moqtap/monitor-browser/worker` and `@moqtap/monitor-browser/draftNN/worker` export
  `initWorker` without the page side. A draft-14 worker is 30.2 KB gzipped
  through `draft14/worker`, against 46.4 KB through `draft14`.
- `hdr` records carry `priority` and `subgroup` where the object's header
  states them. A fetch object that leaves its priority off carries the one last
  stated on its stream.
- `conn-open` carries `relay` (scheme, host and port) and `options`, the
  `WebTransport` options the page passed, with certificate hashes as a count.
- `conn-close` carries `by`: `client` when the page called `close()`, `relay`
  when the transport closed without it, `local` when it failed without it.
- Rollup track rows carry `gapRanges`, the missing groups as ranges (16 per
  interval, the rest counted in `gapRangesDropped`), and `resets`, the
  streams reset by error code. A stream reset before it named a track counts
  as `resets.untracked` on the connection.
- `context.tags`: up to 16 labels of your own on the session, sent on the
  `setup` record. A tag outside the bounds is reported as MQ1114 and left out.
- `setContext()` takes `tags`, which add to the session's, and writes a
  `context` record with what it set. Tags carry into `newSession()`.
- `privacy.hashActorId`: `actorId` is sent as the first 32 hex digits of
  `sha256(apiKey + ':' + actorId)`, and `ids()` reports the hash.
- Ingest's answer to an upload can ask, in `x-moqtap-directive`, for a
  shorter seal interval while someone watches the session (1 to 10 s, for at
  most 10 minutes), and for raised detail while a capture window covers it (up
  to `headers+sizes`, for at most 30 minutes, within the elevated-minute
  budget). A raise is recorded as `by: { kind: 'remote' }`; `resolve()` does
  not close it.

### Changed

- A linked worker compresses its reports before the page receives them, and
  sheds object headers only when their compressed size outruns the upload. At
  raised detail it keeps every header at object rates where 0.6.0 dropped most
  of them, and the page does not compress them on its main thread.
- **Breaking.** A page and a worker of different releases do not link. Update
  both bundles together.
- Requires `@moqtap/codec` 0.13.3 or later.

### Removed

- **Breaking.** The `trackSwitch` flight-recorder trigger, which was accepted
  and never fired. A `trackSwitch` key is reported as MQ1109 and ignored.

### Fixed

- Subgroup streams on drafts 07-13 and fetch streams on drafts 07-19 are
  counted with each draft's own layout. Drafts 07-11 counted no subgroup
  objects and drafts 07-14 no fetch objects; drafts 12-13 misread some object
  ids, and drafts 15-19 some fetch ids and statuses.

## [0.6.0] - 2026-10-21

### Added

- `flush()` uploads everything recorded so far and ends nothing.
- `connections()` lists every WebTransport in the page and its linked workers.
- `newSession()` ends the session and starts the next one in the same page.
  Linked workers follow.
- `setContext()` sets `contentId` and `actorId` for connections opened from then on.
- `connectionIdOf(transport)` on the page and in a worker. `annotate()` takes a
  connection id.
- A failed upload is retried in the page until ingest answers. Uploads the page
  could not send are sent by the next page load on the origin, from any session.
- Uploads when a connection closes and when the page is hidden.
- Raised detail uploads one `hdr` record per object: connection, track, stream,
  group, object and status, and the payload size from `headers+sizes`.

### Changed

- **Breaking.** `HdrRecord` carries `streamId`, `group`, `object`, `status` and
  `size`, and no raw frame follows it; `n` is removed.
- **Breaking.** `stop()` is `end()`. Unload already ends the session.
- **Breaking.** `abort()` is `discard()`.
- **Breaking.** `stop()` then `init()` for each playback is
  `newSession({ contentId })`.
- **Breaking.** `initWorker()` returns at once; `await vitals.linked` only for
  diagnostics. Linked workers report to the page, which uploads for them.
- **Breaking.** The worker's `stop()`, `abort()`, `linkWorker()` and
  `defineMetric()` are removed. Define metrics on the page; workers `observe`
  them by name.
- **Breaking.** `ids().connectionId` is removed; use `connectionIdOf(transport)`
  or `connections()`. `ids()` returns `instanceId`.
- **Breaking.** `upload.stopDrainDeadlineMs` is `upload.drainDeadlineMs`.
- **Breaking.** `WORKER_HANDSHAKE_TIMEOUT_MS` is `limits.linkTimeoutMs`.
- **Breaking.** `resolveConfig`, `CollectorRuntime`, `EscalationController`,
  `UsageMeter`, `DB_NAME`, `InitOptions`, `InitWorkerOptions`, `PRESENCE_KEY`,
  `readPresence` and the dormant-hook functions move to
  `@moqtap/monitor-browser/internal`.
- **Breaking.** Update page and worker bundles together: a page links only a
  worker of its own release.
- Workers need neither `connect-src` nor IndexedDB.
- With a trigger set, the flight-recorder ring is reserved when a realm opens its
  first WebTransport, not at `init()`. A page that only links workers reserves none.
- Upload bodies are version 2. The IndexedDB database moves to version 2; uploads
  stored by earlier releases are sent once, as they are. `MQ2102` is retired.

### Fixed

- A worker that answers while `init()` is still starting is linked, rather than
  reported as never answering.
- Closing a tab in Firefox sends the session's last uploads and ends it.
- Control messages exchanged before `init()` is running, or before a worker is
  linked, reach the session: up to 64 KB per connection and 256 KB per page or
  worker, the rest counted as dropped. Object data from that time is counted, as
  `early.dataChunks` and `early.dataBytes` on the connection's rollup.
- Counters a connection gathered since the last metrics interval are uploaded when
  the session ends with it still open.

## [0.5.1] - 2026-10-20

### Fixed

- No gap in a session's upload numbers when the page links a worker or
  `init()` runs twice with the same `sessionId`.
- The first upload goes out as soon as the session's draft is known, and the
  +45 s upload counts from there rather than from `init()`.
- Unloading the page ends the session, including one in a linked worker. A page
  entering the back/forward cache does not.
- Uploads need no CORS preflight: the key and idempotency key travel in the URL,
  as `text/plain`.

## [0.5.0] - 2026-10-20

### Added

- `@moqtap/monitor-browser/draft07` through `/draft22` export `init` and
  `initWorker` with that draft's decoder only. Importing one installs the
  hook, as the root entry does.

### Changed

- **Breaking.** Decoders are static imports; nothing is loaded at session
  time, so IIFE worker builds and CSPs without chunk loading need no setup. The
  root entry carries every draft.
- **Breaking.** The `drafts` option is removed: import a draft entry instead.
  `MQ1106` and `MQ1107` are retired.

## [0.4.1] - 2026-10-20

### Fixed

- Drafts 07–14 over WebTransport are measured. They negotiate no protocol, so
  the draft is read from the SETUP exchange, including one made before `init()`.
- A session whose draft is never identified is reported with
  `degraded: 'unsupported-protocol'`.

## [0.4.0] - 2026-10-18

### Changed

- **Breaking.** Add `https://moqgest.com` to `connect-src` on a page with a
  strict CSP: the default `endpoint` is `https://moqgest.com/v1/ingest` (was
  `https://ingest.moqtap.com/v1/ingest`).
- **A `sessionId` ingest cannot store is refused at `init()`.** One over 128
  UTF-8 bytes, holding a control character, or with an unpaired surrogate is
  reported as `MQ1113` and replaced by a minted id, which `vitals.ids()`
  returns. Ingest refuses such an id, and with it the whole session.
- **One early upload, at +45 s.** `upload.earlyFlushesMs` defaults to
  `[45000]` (was `[5000, 15000, 45000]`); set it to `[5000, 15000, 45000]` to keep the old schedule.

## [0.3.0] - 2026-10-02

### Added

- **Draft-22**, with `@moqtap/monitor-browser/draft22` as its own entry point. Its
  data streams are draft-21's; the LOCATION_FILTER change is decoded by
  `@moqtap/codec` 0.13.0, now the minimum `@moqtap/codec` version.

### Fixed

- **A `drafts` pin keeps every supported draft.** It kept only 19 and 20 and
  dropped the rest with `MQ1107`.
- **`COLLECTOR_VERSION` names the installed version.** It read `0.1.0`.

## [0.2.0] - 2026-09-17

### Added

- **Draft-21.** The counting decoder, adapter and session probe now cover
  drafts 07 through 21, with `@moqtap/monitor-browser/draft21` as its own entry
  point. Draft-21 is wire-identical to draft-20 — the change is
  renumbering — so a draft-21 session is measured exactly as a draft-20
  one is. A session still downloads only the draft its peer negotiated.

### Changed

- **`@moqtap/codec` is an ordinary dependency, not a peer.** `npm install
@moqtap/monitor-browser` is the whole install; nothing else has to be named.
  Nobody using this package imports the codec themselves, so requiring them
  to resolve a peer range was asking for a decision they have no basis to
  make. The range is `>=0.11.0`, the first version carrying the token
  redaction every adapter calls.

### Fixed

- **The `license` field reads `FSL-1.1-MIT`.** It was `SEE LICENSE IN
LICENSE`, which npm renders verbatim instead of naming the licence.

## [0.1.0] - 2026-09-17

The first release. There is no earlier version to compare against, so nothing
here has ever been fixed for a consumer; this is what 0.1.0 contains.

### Added

- **Licence: [FSL-1.1-MIT](./LICENSE).** Source available rather than MIT.
  Embed it in your application, commercial or not, modify it, redistribute it,
  ship it to your users — the one thing withheld is publishing a competing
  product built from this code, and each release becomes MIT on its second
  anniversary. `@moqtap/codec` and `@moqtap/trace` stay MIT: they are the
  interop surface and are already published under it.

- **A dormant WebTransport hook.** Importing the package patches
  `globalThis.WebTransport` at module-evaluation time, because the hook has to
  be in place before the application's first `new WebTransport()` and the API
  key is frequently not known until later. Until `init()` receives a key it
  copies recent wire bytes into a small bounded in-memory ring, overwrites it
  continuously, and transmits nothing.

- **A counting decoder for drafts 07 through 20**, loaded one draft at a time
  behind a static literal specifier so a session downloads only the draft its
  peer negotiated. Object payloads are walked past, never copied out of the
  page's buffer.

- **`privacy.maskAuthParams`, defaulting to on.** Authorization Token values are
  overwritten at the point of parse, per draft, before the frame is decoded or
  kept. The parameter, its Alias Type, Token Alias and Token Type survive, so a
  failed authentication still looks different from no attempt at one; only the
  value goes, and the frame keeps its exact length. Turning it off takes a real
  boolean `false` — a value that merely looks false is reported and ignored.

  The flight-recorder ring and the dormant pre-`init()` buffer hold no
  control-plane bytes at all. Nothing read them, and they were the one place a
  token could sit in memory unmasked — which matters most in the dormant
  buffer, since SETUP is the first message of a session and is where the token
  travels.

- **Three entry points** — the root plus `@moqtap/monitor-browser/draft19` and
  `@moqtap/monitor-browser/draft20`, spelled `draftNN` to match `@moqtap/codec`'s
  fourteen entries.

- **A build-time guard against importing the `@moqtap/codec` root or `/session`
  entry** from `src/`. Both statically import all fourteen drafts: 39.6 KB gz
  against 5.3 KB for one draft's decoder. The guard is a source scan in
  `tsup.config.ts` rather than the `external` allowlist, because tsup
  externalises declared dependencies automatically and registers that plugin
  ahead of user plugins, so a root import would have been silently externalised
  rather than refused.

- **`resolve()` on the public surface.** A flat verb beside `escalate()` that
  closes the open capture window and returns the dial to the configured level.
  It is the primary way a window closes; `flightRecorder.windowMs` (15 s) is the
  backstop. A no-op with no window open and a no-op the second time, because it
  is called from application error handlers for incidents that frequently never
  escalated at all.

  All four close conditions are implemented and no fifth is: `resolve()`, the
  ring turning over completely since the window opened, the page unloading, and
  the post-event timeout. There is deliberately no "the fault recovered"
  condition — the collector sees objects arriving, not a rebuffer ending.

- **A presence marker on the page global, for the browser extension.**
  `globalThis.__moqtapCollector`, a frozen `{ v, version, since, active }`,
  published when the hook attaches and flipped to `active` when `init()`
  receives a key. It carries no key, endpoint, session id or track name:
  everything on `globalThis` is readable by every script on the page.

- **The `pagehide` tail carries its credential and idempotency key in the URL.**
  `sendBeacon` cannot set request headers, so the key that rides as
  `Idempotency-Key` on every other upload goes as `?ik=`, beside the `?k=`
  credential. The key is also inside the gzipped first frame, but an edge that
  read it there would have to decompress every upload it receives.

  A refused beacon falls back to `fetch(..., { keepalive: true })`, which gives
  the same outlive-the-document property through a different API and carries
  both as headers. If neither mechanism takes it, the loss is reported through
  `onInternalError` and the bytes are not added to `usage()`. One case remains
  undetectable anywhere: `sendBeacon` reports queueing, never delivery, so a
  stub returning `true` and doing nothing is indistinguishable from success.

- **Elevation billed as a capture window** — whole seconds, rounded down, with a
  one-second minimum, per window. Two 200 ms windows are two billable seconds,
  not one, so the rounding cannot be recovered from a session total. A move
  between two elevated levels leaves the window open.

- **A drain deadline on `stop()`.** `stop()` awaits the outbox drain, so an
  ingest endpoint that accepts the socket and answers nobody would otherwise
  leave the promise a page awaits in its own teardown pending for the life of
  the page. One `AbortSignal`, made by `stop()` from `Limits.stopDrainDeadlineMs`
  and composed with each request's own `Limits.uploadTimeoutMs` timer —
  deliberately one mechanism rather than a timer racing the drain, which would
  resolve `stop()` while the upload carried on behind it. Against a real
  blackholed socket `stop()` settles in 2 008 ms; tarpitted, 2 007 ms. An
  expired deadline is a transient failure, so the chunk stays queued and
  persisted for the next page load.

### Notes

- `sideEffects` is an array, not `false`. Importing the root entry installs the
  WebTransport hook at module-evaluation time, so `dist/index.js`,
  `dist/index.cjs` and `src/index.ts` are declared impure while the draft
  entries stay tree-shakeable. `sideEffects: false` would let a bundler drop a
  bare `import '@moqtap/monitor-browser'` entirely, and the failure would be silent:
  the hook never installs, no bytes are seen, and the session reports as healthy
  with no data.
