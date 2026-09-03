# Changelog

All notable changes to `@moqtap/codec` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This file starts at 0.9.0. Earlier releases are in the git history.

## [0.10.0] - 2026-09-03

### Changed

- **Breaking.** `authorization_token` is `readonly AuthorizationToken[]` on
  drafts 11 through 20, on message parameters and on setup options. A single
  token is a one-element array.

  Section 10.2.2 and its equivalents: "The AUTHORIZATION TOKEN parameter MAY be
  repeated within a message as long as the combination of Token Type and Token
  Value are unique after resolving any aliases."

- **Breaking.** `subgroup_filter`, `objectid_filter`, `priority_filter`,
  `object_property_filter` and `track_property_filter` are
  `readonly RangeFilter[]` on drafts 19 and 20, on message parameters and on
  draft-20's `FILL_PARAMETERS`. A single filter is a one-element array.

  Section 5.1.3 on draft-19 and 5.1.4 on draft-20: "All other filter parameters
  MAY appear multiple times in a FETCH, SUBSCRIBE, SUBSCRIBE_TRACKS, or
  REQUEST_UPDATE". One filter parameter carries one SetID and the sets are ORed,
  so two alternatives over the same field need two parameters.

- `@moqtap/test-vectors` raised to `^0.15.0`, where a `decoded` message spells
  each Key-Value-Pair block as a list of entries in wire order rather than as a
  map keyed by parameter name.

## [0.9.0] - 2026-09-03

Draft-20 support, and a fix to draft-19 that changes which state machine a
draft-19 session runs.

### Added

- **Draft-20**: codec, message and data-stream tables, wire rules, error codes
  and session FSM, exported as `@moqtap/codec/draft20` and
  `@moqtap/codec/draft20/session`. `createCodec({ draft: '20' })` and
  `createDraft20Codec()` both reach it.
- `PUBLISH_STATE_NOTIFY` (`0x22`), the one control message draft-20 adds. It is
  unilateral and not subject to `MAX_REQUEST_UPDATES`.
- Draft-20's rewritten `FETCH`. The message keeps codepoint `0x16` but drops the
  Fetch Type discriminator, carries Track Namespace and Track Name inline, and
  moves its range into a `LOCATION_FILTER` parameter. Nothing on the wire
  distinguishes it from a draft-19 `FETCH` at the type byte, so a session
  decoded under the wrong draft will silently misparse it — pick the draft from
  the negotiated `moqt-NN` protocol string, not from message content.
- `INCLUDE_PROPERTIES` (`0x35`), a uint8 boolean defaulting to `1`.

### Fixed

- **`createDraft19Codec()` reported `draft: '18'`.** Since `createSessionState()`
  keys off `codec.draft`, every draft-19 session was validated by the draft-18
  FSM. Draft-19 sessions now run the draft-19 FSM, which enforces rules the
  draft-18 one does not — a session that passed validation on 0.8.1 may now be
  rejected, correctly.

### Changed

- Draft-20 ranges are **inclusive**. An end location names the last object, not
  one past it; do not carry a draft-19 `+ 1` forward.
- Retired error codes decode rather than being refused. Draft-20 Section 14
  requires an unknown error code in any error context to be treated as
  `INTERNAL_ERROR`, and forbids closing the session over one in `REQUEST_ERROR`
  or `PUBLISH_DONE`. The `RETIRED_*` sets remain exported as advisory
  diagnostics — useful for "this peer looks like draft-19" — but are no longer
  decode gates.
- `@moqtap/test-vectors` dependency raised to `^0.13.0` for the draft-20 corpus.
