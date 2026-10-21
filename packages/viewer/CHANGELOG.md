# Changelog

## [0.3.0]

- Requests are paired with their responses: each row shows its request id
  and `→ RESPONSE 212 ms`, and the detail links the two. Copy thread copies
  a request with everything that followed under it.
- A request with no response past the pending threshold is marked. The
  threshold comes from `pendingMs` on `moqtrace` and `moqtrace-replace`
  (500–60000 ms), 5000 without it.
- Error codes by name for the session's draft, or "unknown for draft-NN";
  renamed messages show their other names (ANNOUNCE for PUBLISH_NAMESPACE).
- Findings for error responses, requests past the threshold,
  REQUESTS_BLOCKED, an exhausted request ID limit and GOAWAY, from
  `@moqtap/inspect`.
- Bytes that did not decode on a control stream are kept in the message log.
- Unknown parameters show their id, length and bytes; a Fields/Hex toggle.
- A message filter.
- A Timeline tab: a control lane and per-track lanes in rollup intervals,
  with stall and group ID gap cells labelled, flight-dump objects and
  stalls, detail-raised bands and the player's annotations.
- Tracks: subscribe to OK, first object, objects, group ID gaps, skipped,
  stalls, cadence p50/p95 and arrival p95, and a table for sent tracks.
- Connections are told apart by `p`, with a picker; aliases and request ids
  are per connection.
- Keys: `j`/`k`, `n`/`p`, `e`, `g`, `/`.
- `t` and `msg` on `moqtrace` and `moqtrace-replace` open at a moment or a
  message; `{ type: 'moqtrace-view-selection', t, msg }` reports the
  reader's selection to the bound parent.
- Design system v2: the vendored styles now carry the theme's
  `color-scheme`, the hex offset contrast and the categorical chart colours.
- Each track alias has a colour swatch in the streams view, with a legend in
  the overview.
- Identifiers longer than 20 characters show their first and last eight;
  addresses wrap whole.
- "Choose a file" is a secondary button.
- `{ type: 'moqtrace-replace', bytes, name? }` from the bound parent swaps
  in a newer copy of the trace on screen, keeping the tab, the selected
  message or stream, and the scroll positions. Answered with
  `moqtrace-view-state`; a copy that fails to read leaves the trace on screen.
- A Tracks tab: each track by namespace and name, with its alias, request,
  status, request time, response time and error. Streams and messages show
  the track's name.
- Setup versions read as drafts (`draft-14`), with the hex on hover;
  printable byte fields as text; integers past 2^53 in full.
- The overview shows the client and relay implementations from setup, and
  how the draft is known: the negotiated protocol or the SERVER_SETUP version.
- Message detail: the name links to its spec page, followed by the wire ID
  and the `draft-14 §9.8` citation as text; Copy as JSON. The printed spec
  address, the Type row and the segment and sequence line are gone.
- Directions read `↑ Client → relay` and `↓ Relay → client`, or `Sent` and
  `Received` from a recorder that was neither end.
- Spec links end in `/`, the path the site serves.
- The findings card is left out when there are none, and finding titles are
  shorter. "SUBSCRIBE never answered" is replaced by the pending threshold.

## [0.2.0]

Breaking for a deployment:

- Serve all of `dist/view/`, not a fixed list of files: it adds
  `theme-boot.js`, `tokens.css`, `bundle.css`, `fonts/`, `licenses/` and
  `LICENSE-lucide-static.txt`. The release tarball and `SHA256SUMS` cover
  every file.
- The CSP must allow `font-src 'self'`; the fonts ship in the bundle.

Also:

- Light, dark and system themes, set by the parent through `?theme=` and a
  `{ type: 'moqtap:theme', theme }` message.
- Control messages as a log with a detail pane (fields, raw bytes as hex, a
  `§` spec citation), and a Streams and objects view.

## [0.1.0]

First release.
