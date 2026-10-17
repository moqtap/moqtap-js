# @moqtap/viewer

The `.moqtrace` viewer as a static bundle, built to be served from an origin
that holds nothing: `moqtapusercontent.com` in production.

A trace is written by someone else. Even a capture of your own session carries
track names, reason phrases and payloads chosen by the relay at the far end,
and a shared trace is written entirely by the sender. So the renderer is
reachable by an attacker, and it is served where a bug in it can neither steal
a credential nor send a trace anywhere:

- on a separate registrable domain, so no `moqtap.com` cookie is ever sent to it;
- under `connect-src 'none'`, so nothing on the page can make a request;
- under `script-src 'self'; style-src 'self'`, so markup that reaches the DOM
  does not run. None should reach it: every string from a trace goes in
  through `textContent`;
- talking to exactly one parent page, chosen by an allowlist fixed at build time.

## What is in the bundle

```
dist/view/
  index.html    the page; no inline script or style (src/__tests__/page.test.ts)
  styles.css
  main.js       the page script: ingest, render
  worker.js     decode + analyse, off the main thread, with the draft registries
```

`bun run build` writes it. The source:

| file | what it is |
|---|---|
| `src/read.ts` | reads as much of a file as it will give up, reporting where a damaged file stops |
| `src/analysis.ts` | what a trace says, reduced to findings, a session summary and a message log |
| `src/drafts.ts` | naming wire IDs against the draft the trace declares |
| `src/format.ts` | units (µs offsets, ms wall clock, bytes) |
| `src/parents.ts` | the parent allowlist, the handshake, and the two things the frame says back |
| `src/ingest.ts` | the two ways in: a parent's `postMessage`, or a local file |
| `src/worker.ts` | the decoder worker |
| `src/main.ts` | rendering |
| `src/data/message-tables.json` | every draft's control message registry, generated |

## The parent protocol

```
frame  → parent   { type: 'moqtrace-inspector-ready', version: 1 }       target '*'
parent → frame    { type: 'moqtrace', bytes: ArrayBuffer | Uint8Array, name?: string, shareable?: true, local?: true }
frame  → parent   { type: 'moqtrace-view-state', state: 'opened' | 'failed' }   target = the bound origin
frame  → parent   { type: 'moqtrace-share-request' }                      target = the bound origin, site relay only
```

1. On load, a framed viewer announces itself to `window.parent` with target
   `'*'`. It has to: it does not know who framed it yet (`document.referrer` is
   gone under `no-referrer`, and `ancestorOrigins` is Chromium-only). So the
   announcement carries a type and a version and nothing else.
2. The parent answers with the trace. The frame acts on a message only if it
   came from `window.parent` (not a sibling frame or a popup, which can carry
   an allowed origin too) and from an allowed origin:
   - `https://app.moqtap.com` and `https://moqtap.com`, exactly;
   - `http://127.0.0.1:<port>` and `http://localhost:<port>`, any port: the
     site's inspector page served on loopback by the site's dev server.
     `moqtap inspect`'s shell frames the site page, not the viewer, and
     reaches the viewer only through it;
   - extra origins passed at build time (below).
3. The first admitted message **binds** the frame to that exact origin. From
   then on it hears only that origin and addresses only that origin. Before a
   handshake it addresses nobody: there is no code path that posts anything
   but the dataless announcement to `'*'`.
4. The frame sends back whether the trace opened. Not the name, not the size,
   not an error string: the parent sent the bytes and already knows what they
   were.
5. The frame may ask for a share dialog, and nothing more. The **Share…**
   button in the bar starts hidden in the markup. It is shown only while the
   trace on screen was sent by the parent **with `shareable: true`**, and the
   bound parent is the site's inspector page (`https://moqtap.com`, or the
   same page on loopback in development). That page relays the request to the
   `moqtap inspect` shell that framed it. The mark is needed because the
   origin alone cannot decide. The site page also opens traces of its own (its
   sample, or a file dropped on its bar), and the shell answers a request by
   sharing the recording it handed over, not what is on screen. On a plain
   visit no shell is bound and the request would go nowhere. So the relay
   marks only the trace the shell delivered, and an unmarked trace hides the
   button. The mark is read only as the literal `true`.
   A click posts `{ type: 'moqtrace-share-request' }`, a type and nothing
   else, to that bound origin by name. Under the portal (`app.moqtap.com`, or
   a non-production portal host) the button stays hidden, marked or not: the
   portal has its own share dialog. For a file opened here it is hidden too.
   Choosing the audience and confirming happen in the shell's own DOM, and the
   link never comes back to the frame.
6. **Open capture** in the bar also starts hidden in the markup. It is shown
   on the viewer opened on its own, beside a file opened here, and beside a
   trace the site's inspector page sent **with `local: true`**: a capture that
   page read itself (its sample, or a file dropped on its bar), where opening
   another is the point. Beside any other trace a parent sent it stays hidden:
   the portal's library and share landing, and the shell recording the site
   page relays, frame the viewer to show that one trace. The origin alone
   cannot decide, because the portal in development is served on loopback,
   where the site's dev server runs too. The mark is read only as the literal
   `true`, and only from the site relay. In a frame with nothing on screen
   the button is hidden too; the empty state carries its own file chooser.

The message shapes are the ones `moqtap inspect`'s shell speaks, and released
binaries have them compiled in. The shell speaks them to the site page, and
the site page speaks them to the viewer. `shareable` and `local` are the two
additions, and only the relay sets them.
Everything else that arrives is ignored silently: frames receive ordinary
cross-origin chatter, and none of it is a failed import.

A file the person opens with the picker or by dropping it is read in the page
and handed to the worker. It is never posted to the parent, and with
`connect-src 'none'` it cannot be sent anywhere else.

## Extra parents

```
bun run build -- --staging-parent https://<name>.workers.dev
```

The flag adds an allowed parent origin for a non-production deployment, and
may be repeated. Each value must be a bare `https://*.workers.dev` origin; the
build refuses anything else, so a mistyped command cannot widen a bundle. A
bundle built without the flag accepts no extra parent.

## Releases

Tagged `viewer-v<semver>`, matching `version` in `package.json`. The package
is not published to npm, and nothing in this repository deploys it.

A tag runs `.github/workflows/release-viewer.yml`: lint, typecheck and test this
package, build the production bundle (no extra parents), and attach it to a
GitHub release as `moqtap-viewer-<version>.tar.gz` with its `SHA256SUMS`.

A parent page and the viewer it frames have to agree on the handshake above
and on the parent allowlist, so a deployment takes a tagged release, and the
checksums let it be checked against the tag.

## Registries

`src/data/message-tables.json` is generated from the moqtap.com site's
per-draft registries, which are extracted from the draft documents and drive
its reference pages:

```
bun run registries <dir>         # regenerate from a directory of draft-NN.json registries
bun run registries:check <dir>   # fail if the committed copy has drifted from them
```

The copy is committed rather than read at build time so that `bun run build`
and `bun run test` need only this repository. `registries` and
`registries:check` are the exception: they need the site's registries, so CI
does not run them. Run the check after the site's registries change, before
tagging a release.

Spec links in the message log point at `https://moqtap.com<specPath>` and open
in a new tab, with `rel="noopener noreferrer"`. A framed viewer needs
`allow-popups allow-popups-to-escape-sandbox` in the embedder's `sandbox` for
that: without `allow-popups` the browser drops the click silently, and without
the escape the spec page would open under the viewer's sandbox. Each message
with a spec page also shows its address as selectable text, so it can be
copied and still reaches the spec under an embedder that refuses popups.

## Tests

```
bun run test     # or: vitest run, from this directory
```

- `corpus.test.ts`: every file in the shared `.moqtrace` corpus
  (`@moqtap/test-traces`, or a `test-traces` checkout beside this repository)
  through `handle()`, the function the worker runs. The summary must match the
  manifest, and each case must raise the findings it was written to provoke.
- `parents.test.ts`: the gate. Lookalike origins, non-parent sources, the
  binding, and that nothing is posted before a handshake; which parents
  answer a share request, and that the request is dataless and goes only to a
  handshaken site relay; the `shareable` and `local` marks are read only as
  `true`; Open capture is offered only where opening a local file is the
  point.
- `ingest.test.ts`: the listener that applies the gate, on fake windows. A
  refused origin or source never reaches `onTrace`, the announcement goes to
  `'*'` only when framed, and reports go only to the bound origin; Share is
  offered and posted only for a trace marked `shareable` by a handshaken site
  relay (production or loopback), withdrawn when an unmarked trace replaces
  it, and never under the portal, before a handshake or for a local file;
  Open capture is hidden beside a trace the portal or the shell handed over,
  and offered beside the site's own marked capture and on its own.
- `units.test.ts`: draft naming, units, the signature check.
- `page.test.ts`: the page has nothing the CSP would refuse, the Share and
  Open capture buttons start hidden in the markup, the built bundle has no
  network or HTML-injection sink and starts its worker by URL, and the build
  refuses a malformed `--staging-parent`.

The workspace has no DOM test environment, so the gate is tested as functions
(`ParentGate`, `isAllowedParent`, `tellParent`, `canOfferShare`,
`askParentToShare`, `canOfferLocalOpen`), and `startIngest` takes the window as
an argument, with plain objects standing in for windows in both. `main.ts`
passes the real one.

## Resolution of `@moqtap/trace`

Through `tsconfig.json` `paths` (and the matching alias in `vitest.config.ts`)
to `../trace/src/index.ts`, the same module the workspace link resolves to
under Bun. The bundle therefore never depends on a built `trace/dist`.
