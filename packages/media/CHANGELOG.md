# Changelog

All notable changes to `@moqtap/media` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-10-29

### Added

- `@moqtap/media/loc`: LOC object and Track properties and H.264/H.265 payload framing, for
  draft-ietf-moq-loc-00 to -04 and draft-mzanaty-moq-loc-05.
- `@moqtap/media/cmaf`: CMAF object payloads under CMSF-00 and -01: chunks, sample flags, SAP
  types, earliest presentation time, and the CMSF object checks.
- `@moqtap/media/timeline`: MSF media timeline records and template, MSF event timeline records,
  and the CMSF SAP type timeline.
- `parseInitSegment` also gives the `pssh` boxes, the track_IDs named by more than one `trak`
  or `trex`, and, per track, the codec, `trex` defaults, protection boxes, sample group
  descriptions and whether it has an edit list.

### Removed

- `parseCatalog` no longer reports gzip payloads as `compressed`; they are `invalid` like any
  payload that is not JSON.

## [0.1.0] - 2026-10-28

Initial release.
