# Changelog

All notable changes to `@moqtap/inspect` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-10-21

### Added

- `errorName`: an error or status code's name from the codec's registry for
  the session's draft, or `null` when that draft does not define it.
- `messageAliases`: a control message's names in other drafts
  (ANNOUNCE and PUBLISH_NAMESPACE, SUBSCRIBE_DONE and PUBLISH_DONE, ...).
- `pairRequests`: requests paired with their responses by request id, by
  namespace (drafts 07-10) or by request stream (17+), with round-trip time.
- `problems`: errors with code names, requests pending past a threshold,
  REQUESTS_BLOCKED and exhausted request ids, GOAWAY and undecodable bytes,
  in time order.
- `problemTitle` and `problemDetail`: a problem in words; `problemSeverity`:
  an error or a warning; `codeLabel`: an
  error code by name, or as unknown for the draft; `requestIdOf`: the request
  id a message carries.
- `rollupDelivery`: each track's delivery and rollup intervals from a
  collector trace's `collector.rollup` annotations, on the trace's clock;
  `quantileBucket` and `highestBucket` for its histograms.
- `@moqtap/codec` as a peer dependency.

## [0.1.0] - 2026-10-20

### Added

- `displayFields`, `displayValue` and `displayBytes`: a control message's
  fields made readable. Integers past 2^53 in full decimal, printable byte
  strings as text, other bytes as a hex preview, setup versions as
  `draft-NN`, each with the recorded value kept beside it.
- `setupImplementation`: the `moqt_implementation` a CLIENT_SETUP,
  SERVER_SETUP or SETUP advertises, and which end it names.
- `draftOfProtocol`, `setupVersionLabel`, `bytesAsText`, `messageKind`.
- `TrackRegistry`, `trackEventFrom` and `trackDisplayName`: track aliases
  joined to namespace and name from control messages, across drafts 07-22.
