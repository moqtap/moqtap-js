# Changelog

All notable changes to `@moqtap/collector` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-09-17

### Added

- **Draft-21.** The counting decoder, adapter and session probe now cover
  drafts 07 through 21, with `@moqtap/collector/draft21` as its own entry
  point. Draft-21 is wire-identical to draft-20 — the change is
  renumbering — so a draft-21 session is measured exactly as a draft-20
  one is. A session still downloads only the draft its peer negotiated.

### Changed

- **`@moqtap/codec` is an ordinary dependency, not a peer.** `npm install
  @moqtap/collector` is the whole install; nothing else has to be named.
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

- **Three entry points** — the root plus `@moqtap/collector/draft19` and
  `@moqtap/collector/draft20`, spelled `draftNN` to match `@moqtap/codec`'s
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
  bare `import '@moqtap/collector'` entirely, and the failure would be silent:
  the hook never installs, no bytes are seen, and the session reports as healthy
  with no data.
