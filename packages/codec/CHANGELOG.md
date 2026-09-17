# Changelog

All notable changes to `@moqtap/codec` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This file starts at 0.9.0. Earlier releases are in the git history.

## [0.12.0] - 2026-09-17

### Added

- **draft-21, as `@moqtap/codec/draft21` and `createCodec({ draft: '21' })`.**
  Draft-21 restructures draft-20 and changes nothing on the wire: every code
  point, every table row and every wire diagram is identical, so the codec, the
  message and data-stream tables, the wire rules, the error registries and the
  session FSM are draft-20's. The two are told apart only by what they
  negotiate, `moqt-21` against `moqt-20`.

  `message-type-names.test.ts` records that as a fact rather than a claim:
  `20/21` joins the list of draft pairs whose whole name table coincides, which
  until now held only drafts 08, 09 and 10.

  What did move is where the draft says things -- 200 numbered sections became
  214 and only 11 keep both their title and their number -- so every citation
  in the new module is retargeted, two figure references with them. Requires
  `@moqtap/test-vectors` 0.17.0, which adds the draft-21 corpus.

### Fixed

- **A private path no longer ships in the package.** Three source files carried
  a "Spec of record" reference to an internal planning document. `files`
  includes `src`, and the generated `dist/*.d.ts` reproduced it, so the path was
  in the published tarball. The comments now say why the code is as it is
  without naming the document.

## [0.11.0] - 2026-09-17

### Added

- **`redactAuthTokens`, on all fourteen drafts.** Every draft entry point now
  exports `redactAuthTokens`, with the `AuthRedaction` result type and the
  `REDACTION_FILL` byte. It decodes a control frame for one purpose -- learning
  where the credentials sat -- discards the message and returns the frame with
  those bytes overwritten, so a caller never has to hold a frame containing one.

  There are two credential shapes and the difference is not cosmetic. Drafts 07
  through 10 have no Authorization Token: they carry AUTHORIZATION_INFO, a bare
  UTF-8 string which *is* the bearer credential, so the whole parameter value
  goes. From draft-11 only the Token Value is overwritten, and the Alias Type,
  Token Alias and Token Type stay -- those are structure rather than secret, and
  they are what distinguishes a session that failed to authenticate from one
  that never tried.

  A frame that fails to decode is still redacted as far as the decode reached,
  which is the useful direction to fail in: a value that was read is a value
  that was exposed, whatever went wrong after it. The result reports that case
  as `incomplete`.

- **Every draft's error-code registries are reachable from its entry point.**
  draft-17's were written, committed and left unexported, so the constants sat
  in the published package with no way to name them from outside their own file.

### Fixed

- **draft-16 Setup Parameters are delta-encoded, and were read as absolute.**
  draft-16 Section 1.4.2 introduced Key-Value-Pair Types carried as "a delta
  from the previous Type value", with the Length-present-when-odd parity decided
  by the *resolved* type. `decodeParams` had always done this; `decodeSetupParams`
  never did. Drafts 07-15 are unaffected because delta encoding did not exist
  yet, and 17-20 route their setup through the delta-aware decoder -- 16 was the
  only hole.

  **This leaked credentials rather than merely misreading them.** With absolute
  types an AUTHORIZATION_TOKEN in any position but the first resolves to the
  wrong type -- 0x03 reads as 0x01, PATH, which is also odd and whose Length
  happens to cover the token exactly -- so the decode *completes*, no span is
  recorded, and the frame comes back unredacted with `redacted: 0` and nothing
  to notice. Found by pointing a real session at a public relay, whose
  SERVER_SETUP ends where the frame does only under the delta reading.

- **draft-17's Token Value is not length-prefixed.** The encoder wrote, and the
  decoder read, a varint length in front of the Token Value that draft-17 does
  not define. Figure 5 writes the field as `Token Value (..)` -- the rest of the
  value -- and the only length genuinely present is the Key-Value-Pair's own.
  Draft-18 repeats that figure and its prose verbatim and already encoded none.
  Because the redactor locates the credential from the outer length, the stray
  byte also left draft-17 frames unredacted. Requires `@moqtap/test-vectors`
  0.16.0, which drops the same byte from ten vectors.

- **A status Object no longer desynchronises the streaming decoders.** draft-20
  Section 11.4.2: "The Object Status field is only sent if the Object Payload
  Length is zero." The streaming subgroup transforms read the length, saw zero
  and went to the next Object, leaving the status varint to be taken for the
  next Object's Object ID Delta -- so one status Object silently decoded every
  Object after it as garbage. Drafts 15, 17, 18, 19 and 20 were affected, and
  draft-15's fetch decoder with them; each draft's one-shot decoder always had
  the branch.

- **`bun run typecheck` no longer overwrites the published bundle.** tsup owns
  `dist`, and every package `tsconfig.json` pointed `outDir` at the same
  directory, so a local `build` followed by `typecheck` replaced the bundle with
  an unbundled compilation plus a nested tree -- and `.npmignore` excludes
  `dist/*/`, so the tarball kept the entry point and dropped the subtree it
  imported. The typecheck program now emits nothing. Published tarballs were
  unaffected only because both CI workflows happen to run `typecheck` before
  `build`; any local `build -> typecheck -> publish` shipped it.

- **The streaming decoders and the one-shot decoders now agree.** Every draft
  from 14 to 20 ships two ways to read a data stream, and nothing had ever
  compared them. They had drifted, in six ways, none of which corrupted a
  payload -- which is why it survived. A consumer that switched paths got
  objects that looked right and carried a different shape.

  On subgroup streams: the incremental decoder returned Properties as opaque
  `extensionData` where the one-shot parsed them into `objectProperties`
  (drafts 17-20); it dropped `headerType`, `endOfGroup` and `firstObject`
  entirely; it left the Subgroup ID at zero under the mode that derives it from
  the first Object's ID, rather than at that ID; and it reported every Object
  as `byteOffset: 0`.

  On fetch streams it was worse. The incremental decoder returned a bare
  `ObjectPayload` with no `serializationFlags`, no `groupId`, no `subgroupId`,
  no `publisherPriority` and no deltas, and because it carried no state between
  Objects, **DATAGRAM-mode Object IDs were simply wrong** -- 0, 0, 0 where the
  one-shot resolved 1, 2, 3.

  Both decoders now share one header reader and one object reader per draft,
  lifted out of the one-shot unchanged, so there is no second copy left to
  drift. A new cross-draft test sweeps every header type and every
  Serialization Flags combination each draft accepts and requires the two paths
  to agree, whole-buffer and one byte at a time.

- **`createDataStreamDecoder` streams.** It picked an inner decoder and then
  never wrote a byte to it: chunks accumulated in a local buffer and `flush`
  decoded the whole stream in one shot, so every event arrived at end of
  stream. On a subscription that stays open that is no events at all. It now
  pumps the inner decoder's output as the bytes arrive. Which first bytes
  select which decoder is unchanged.

### Changed

- **Breaking, at the type level.** `SubgroupStreamHeader` gains a required
  `headerType`, and `endOfGroup` and `firstObject` where the draft has them.
  Code that reads the header event is unaffected; code that constructs one has
  a field to add. The value is the same one `SubgroupStream.headerType`
  carries.

  Under the Subgroup ID mode that takes the ID from the first Object, the
  header event is now emitted after that Object has been read rather than
  before, because that is the first moment its Subgroup ID is known. It still
  arrives ahead of every Object in the output.

### Performance

- **The streaming decoders stop recopying their buffer on every chunk.** Both
  allocated an array of `unread + chunk.length` and copied both halves into it
  per chunk, which is quadratic in chunks per stream, and both built a fresh
  subarray and `BufferReader` per *object*. Capacity now grows until reclaiming
  the consumed prefix would leave the buffer at least half free, and never
  shrinks; the reader is hoisted out of the object loop.

  The buffer never compacts in place, and that is load-bearing rather than
  incidental: payloads are handed out as views into it, so moving bytes within
  it would corrupt an Object already emitted. The consumed prefix is dropped
  only when a fresh array is being allocated anyway, which keeps the old array
  alive exactly as long as the views into it.

  Four megabytes, best of five, previous strategy against this one:

  | objects | chunks | before | after |       |
  | ------- | ------ | ------ | ----- | ----- |
  | 6 KB    | 16 KB  | 0.6 ms | 0.7 ms | 0.8x  |
  | 6 KB    | 1 KB   | 2.5 ms | 1.2 ms | 2.0x  |
  | 120 KB  | 16 KB  | 2.5 ms | 0.7 ms | 3.5x  |
  | 120 KB  | 1 KB   | 27.0 ms | 0.8 ms | 32.1x |

  The first row is the shape the T10 captures have, and it is why a browser
  measurement of this moved not at all: at 6 KB objects against 16 KB chunks
  almost no chunk has an unread remainder to recopy. The last row is the same
  code on objects those captures do contain -- they reach 120 KB -- arriving in
  small chunks.

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
