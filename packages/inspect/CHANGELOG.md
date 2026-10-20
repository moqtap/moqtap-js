# Changelog

All notable changes to `@moqtap/inspect` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
