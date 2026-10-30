# Changelog

All notable changes to `@moqtap/media` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.0] - 2026-10-30

### Added

- Catalog and timeline problems carry a stable `id`, a `family`, the rule as data (`spec`:
  draft, revision, section, keyword and quote), `also`, `effect`, `subject`, `field`,
  `expected` and `actual`; catalog problems also `readAs`.
- `severityOf`, `specUrl`, `specLabel`, and the wording functions `catalogProblemTitle`,
  `catalogProblemRemedy`, `catalogProblemFound`, `catalogProblemExpected` and
  `catalogProblemTracks`, and `timelineProblemTitle`, `timelineProblemRemedy`,
  `timelineProblemFound` and `timelineProblemExpected`.
- `checkCatalogObjectPlacement`: the MSF Group rules for a catalog object's Group, Subgroup
  and Object IDs.
- `catalog.init.other-draft-field`: a CMSF cmaf track that carries the other revision's init
  field.
- `@moqtap/media/frames`: per-sample frame types read from H.264 (IDR, slice types), H.265
  (NAL unit kinds, IRAP) and AV1 (frame type, shown key frames) samples, with each CMAF
  sample's span, its sample flags, and whether the flags agree with the bitstream.
- `InitTrack.codecConfig`: the avcC, hvcC or av1C of a video track.

### Changed

- Catalog and timeline problem messages are titles that say what is wrong with the data,
  naming the track; CMAF problem messages are sentences that start with a capital letter.
- A few problems cite one section where they cited two; the other is in `also`.

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
