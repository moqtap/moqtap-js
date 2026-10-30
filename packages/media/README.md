# @moqtap/media

**Read the media inside MoQT objects.**

[npm](https://www.npmjs.com/package/@moqtap/media) | [GitHub](https://github.com/moqtap/moqtap-js/tree/master/packages/media)

## What it does

`@moqtap/media` looks at object payloads, with the MoQT framing already stripped, and says
what media they carry:

- **ISO BMFF boxes**: the top-level boxes of a payload, or sniffed for behind an unknown
  prefix.
- **CMAF or plain fMP4**: CMAF when a `styp` or `ftyp` names a CMAF brand.
- **Init segments**: the brands, the `pssh` boxes, and per track the track ID, handler, sample
  entry and codec, timescale, `trex` defaults, protection boxes, sample group descriptions and,
  for video, the avcC, hvcC or av1C.
- **Fragments**: the track ID each `moof/traf/tfhd` names, to check against the init
  segment as CMSF requires.
- **CMAF objects**: what one object of a CMSF track carries: its chunks, its first sample's
  flags and SAP type, its earliest presentation time, and the CMSF rules for an object.
- **Annex-B streams**: H.264 and H.265 by their NAL units, with keyframes and the H.264
  codec string.
- **Frame types**: each sample's H.264, H.265 or AV1 frame type read from its bitstream, beside
  what its sample flags claim.
- **MSF and CMSF catalogs**: each catalog object read and checked against its draft, deltas
  applied, tracks normalised, and credentials redacted for sharing.
- **Timelines**: MSF media timeline records and template, MSF event timeline records, and
  the CMSF SAP type timeline.
- **LOC**: object properties read under the LOC draft a track's property types allow, and
  the NAL unit framing of H.264 and H.265 payloads.

No runtime dependencies. Works in Node.js, Bun, Deno and browsers. Every result is plain
data, so it survives `postMessage`. Results holding a `Uint8Array` or a `bigint`, such as
decoded catalog init data, LOC property values and CMAF decode times, do not survive
`JSON.stringify` as they are.

## Installation

```bash
npm install @moqtap/media
```

## Quick start

Each area is its own subpath, so importing one pulls in only what it needs; `frames` reads CMAF
objects through `cmaf`.

```typescript
import { detectMediaInfo, fragmentTrackIds, parseInitSegment } from '@moqtap/media/bmff'
import { detectAnnexB } from '@moqtap/media/annexb'

detectMediaInfo(payload)
// { variant: 'cmaf', boxes: ['styp', 'moof', 'mdat'] }

const init = parseInitSegment(initData)
// { brands: { major: 'cmfc', minorVersion: 0, compatible: ['iso6', 'cmfc'] },
//   tracks: [{ trackId: 1, handler: 'vide', sampleEntry: 'avc1', codec: 'avc1', timescale: 90000, ... }],
//   pssh: [] }

const known = new Set(init?.tracks.map((t) => t.trackId))
fragmentTrackIds(payload).every((id) => known.has(id))

detectAnnexB(frame)
// { codec: 'h264', codecString: 'avc1.64001F', keyframe: true, nalTypes: [9, 7, 8, 5], offset: 8 }
```

## ISO BMFF: `@moqtap/media/bmff`

| Export | What it does |
| --- | --- |
| `parseBoxes(data, limit?)` | Top-level boxes: type, offset, size, up to `limit` boxes (32). Stops at the first unknown type. |
| `detectMediaInfo(payload)` | Variant and the first 32 top-level box types, or `null` when the payload is not BMFF. |
| `scanAndDetectMedia(data, scanLimit?)` | Payload sniffing: variant and the first 32 top-level box types, behind an unknown prefix of up to `scanLimit` bytes (256). |
| `classifyVariant(boxes, data)` | `cmaf` when a `styp` or `ftyp` names a CMAF brand, else `fmp4`. |
| `readBrands(data, box)` | An `ftyp` or `styp` box's major brand, minor version and compatible brands. |
| `isCmafBrand(brand)` | `cmfc`, `cmf2`, `cmfs`, `cmfl` or `cmff`. |
| `fragmentTrackIds(data)` | The track ID of every `moof/traf/tfhd`. |
| `parseInitSegment(data)` | `ftyp` brands, `pssh` boxes and, per `trak`, track ID, handler, first sample entry, codec, timescale, `trex` defaults, protection boxes, `sgpd` boxes and whether it has an edit list; `null` without a `moov`. |

A fragment of only `moof`+`mdat` carries no brand and classifies as `fmp4`, even on a CMAF
track. A catalog's `packaging` says whether a track is CMAF.

A payload cut short yields what its bytes hold: fields past the end come back as `null`.

For an `encv` or `enca` sample entry, `encryption` gives the `frma` original format (also
`codec`), the `schm` scheme type and version, and the `tenc` fields. Key IDs and system IDs
are 32 hex digits in byte order.

## CMAF objects: `@moqtap/media/cmaf`

One object payload of a CMAF track, read against the track's CMAF header (CMSF-00 `initData`,
CMSF-01 `initDataList`). Only read a track as CMAF when its catalog `packaging` is `"cmaf"`,
or the user says so.

```typescript
import { parseInitSegment } from '@moqtap/media/bmff'
import { checkCmafObject, parseCmafObject } from '@moqtap/media/cmaf'

const init = parseInitSegment(header)
const object = parseCmafObject(payload, init)
// { boxes: ['moof', 'mdat'], trackIds: [1],
//   firstSample: { source: 'trun-first-sample-flags', sync: true, ... },
//   sap: { sapType: null, candidates: [1, 2], reason: 'sync-sample' },
//   timing: { earliestPresentationTime: 900000n, eptMs: [10000], unknown: null }, ... }

checkCmafObject(object, init, { draft: 'cmsf-01', firstInGroup: true })
// [] or [{ kind: 'violation', code: 'track-id-not-in-init', section: 'CMSF-01 3.3', ... }]
```

| Export | What it does |
| --- | --- |
| `parseCmafObject(payload, init?)` | Top-level boxes, `styp` brands, `emsg`/`prft`/`mdat` counts, and per `moof` the `mfhd` sequence number and per `traf` the `tfhd`, `tfdt`, `trun` samples and sample groups. Then the object's first sample, SAP type and timing. |
| `checkCmafObject(object, init?, options?)` | Findings against CMSF 3.3 and 3.4. |
| `decodeSampleFlags(value)` | The fields of a `sample_flags` value. |
| `describeSapReason(reason)` | Why a SAP type is not known, in words. |

Without the header, the `trex` defaults, the timescale and the header's sample groups are
unknown, so less is decided. A track_ID that the header names in more than one `trak` or
`trex` is listed in `ambiguousTrackIds`, and nothing is taken from the header for it.

**First sample.** Its flags come from the `trun` first_sample_flags or the `trun` per-sample
flags, else the `tfhd` default, else the header's `trex` default. A `trun` that carries both
first_sample_flags and per-sample flags leaves them unknown (`unknown: 'conflicting'`, both
values in `conflicting`). `unknown` says why they are missing.

**SAP type.** A number only when the data decides it:

- a `sap ` sample group states it (`source: 'sap-sample-group'`), or
- the first sample is a sync sample, later samples of the object are presented before it, and
  every one of them has is_leading 3, decodable: type 2 (`source: 'decodable-leading-samples'`).

Otherwise `sapType` is `null`, with `candidates` and a `reason`. A sync sample gives `[1, 2]`;
`[2, 3]` when a later sample is presented before it and not every such sample has is_leading 3.
A sample that is not a sync sample and in no `sap `, `rap ` or `roll` group signals no type. A
version 2 `sgpd` default entry is not read.

**Timing.** `earliestPresentationTime` is the earliest presentation time of the object's
samples in the track's timescale, from `tfdt`, the sample durations and the composition
offsets, with no edit list applied. Durations are needed only where a sample has a composition
offset. It is `null` when the object's trafs name more than one track_ID. `eptMs` is that time in milliseconds rounded to the
nearest, as a CMSF SAP type timeline records it. It has two candidates when the time is
exactly halfway, and is `null` when the track has an edit list. `unknown` says why a value is
missing.

**Findings.** `violation` when the data breaks a rule, `not-signalled` when the data does not
say:

| Code | Kind | Rule |
| --- | --- | --- |
| `malformed-box` | violation | A box size below its header, a box past its container or the payload, a box ending before its fields, or a partial header. |
| `no-moof-mdat` | violation | No `moof` followed by an `mdat` (3.3). Not checked when the payload is not read to its end. |
| `no-mfhd`, `no-traf`, `no-tfhd` | violation | A `moof` without its `mfhd` or a `traf`, or a `traf` without its `tfhd` (3.3). |
| `multiple-tracks` | violation | `tfhd` boxes name more than one track_ID (3.3). |
| `track-id-not-in-init` | violation | A track_ID that no `trak` of the header has (3.3). |
| `track-id-unchecked` | not-signalled | No header to check the track_ID against. |
| `group-start-sap-type` | violation | With `firstInGroup`: the object begins with a decided SAP type other than 1 or 2 (3.4 with 3.6.1). |
| `group-start-sap-not-signalled` | not-signalled | With `firstInGroup`: the SAP type is not decided, and its candidates are not all 1 or 2. |

`styp`, `emsg`, `prft` and other boxes CMSF does not address are reported, not flagged. An
object does not signal CMAF fragment boundaries, so `movieFragments` are read as chunks: a
`moof` and the `mdat` after it.

## Timelines: `@moqtap/media/timeline`

Media timeline objects in the explicit format (MSF-00 7.1, MSF-01 7.1.1) and the media
timeline template (MSF-01 7.4.1), event timeline objects (MSF-00 and MSF-01 8.1), and the CMSF
SAP type timeline read from their records (CMSF-00 and CMSF-01 3.6.1).

```typescript
import {
  mediaTimelineTemplateEntry,
  parseEventTimeline,
  parseMediaTimeline,
  parseMediaTimelineTemplate,
  readSapTimeline,
} from '@moqtap/media/timeline'

parseMediaTimeline('[[0, [0,0], 1759924158381], [2002, [1,0], 1759924160383]]')
// { kind: 'records', records: [{ mediaTime: 0, group: 0, object: 0, wallclock: 1759924158381, at: 0 }, ...], problems: [] }

const { template } = parseMediaTimelineTemplate([0, 2002, [0, 0], [1, 0], 1759924158381, 2002])
if (template) mediaTimelineTemplateEntry(template, 2)
// { mediaTime: 4004, group: 2, object: 0, wallclock: 1759924162385 }

const parsed = parseEventTimeline(payload, { draft: 'msf-01' })
if (parsed.kind === 'records') {
  readSapTimeline(parsed.records, { draft: 'cmsf-01' })
  // { entries: [{ group: 0, object: 0, sapType: 2, ept: 0, at: 0 }, ...], problems: [] }
}
```

| Export | What it does |
| --- | --- |
| `parseMediaTimeline(input, options?)` | One media timeline object, as text or bytes: `records`, `invalid`, or under MSF-01 `unread`. Each record's media time and wallclock time in milliseconds, and its Location. Never throws. |
| `parseMediaTimelineTemplate(value)` | A track's `template` catalog field: the six template values, or `null` with the problems that stop it. Never throws. |
| `mediaTimelineTemplateEntry(template, n)` | Entry `n`, counted from 0, by the MSF-01 7.4.1 formulas; `null` when `n` is not a non-negative integer or the Location is not one. |
| `parseEventTimeline(input, options?)` | One event timeline object, as text or bytes: `records` or `invalid`. Each record by its index reference: `t` wallclock in milliseconds, `m` media PTS in milliseconds or `l` Location, with its `data` as any JSON value. Never throws. |
| `readSapTimeline(records, options?)` | The SAP type timeline entries: Location, SAP type 0 to 3, and earliest presentation time in milliseconds. |
| `SAP_TIMELINE_EVENT_TYPE` | `"org.ietf.moq.cmsf.sap"`. |

Problems have the same shape as catalog problems. An `error` leaves the record out. On a media
timeline: a record that is not an Array, one with fewer than three items (`missing_field`) or,
with `draft: 'msf-00'`, more than three, a wallclock time that is not a Number, a media time
that is not a whole number of milliseconds, or a Location that is not two Group and Object IDs.
Otherwise an Array of more than three items is left out with no problem, since MSF-01 7.1 lets
a document combine both formats. On a template: a value that is not an
Array of six values of the types MSF-01 7.4.1 gives (`missing_field` when it has fewer), or a
`startMediaTime` that is not a whole number of milliseconds. On an event timeline: a record
that is not an Object, without exactly one index reference (`invalid_index`), without `data`,
with a value of the wrong type, or with an `m` that is not a whole number of milliseconds. On
the SAP type timeline, a record whose index is not `l`, whose `data` is not two integers, whose
SAP type is not 0 to 3, or whose Object 0, the first Object of its Group, has a SAP type other
than 1 or 2, is an error. Warnings keep the record:

- `mixed_index`: records use more than one index reference type.
- `conflicting_records`: two SAP type timeline records for one Location disagree. Both are
  kept.

A media timeline document that is not an Array is an `invalid_value` error under MSF-00 7.1.
Under MSF-01, or without a draft, it is `unread`, with no problem.

## Frame types: `@moqtap/media/frames`

`readSampleFrames(payload, init)` lists every sample of a CMAF object with its byte span, its
sample flags, and what its bitstream says: H.264 IDR and slice types, H.265 NAL unit kinds and
IRAP, AV1 frame types and shown key frames. The codec configuration comes from the init
segment's avcC, hvcC or av1C, which `parseInitSegment` gives as `codecConfig` on each video
track. `agrees` is `false` when the sync flag and the bitstream's random access point disagree,
and `null` when either is unknown. `readFrameType(sample, config)` reads one access unit or
temporal unit, with length prefixes, Annex-B start codes or an AV1 sequence header. Audio tracks
get no frame types. Values the data does not state are `null`, and framing problems are listed as
issue codes.

## Annex-B: `@moqtap/media/annexb`

`detectAnnexB(data)` sniffs a payload for an H.264 or H.265 Annex-B stream behind an unknown
prefix of up to 64 bytes, such as a varint timestamp, and reports:

- `codec`: `'h264'` or `'h265'`
- `codecString`: the RFC 6381 string from the SPS, H.264 only, when an SPS is present
- `keyframe`: an H.264 IDR or H.265 IRAP NAL unit is among the first 16 NAL units
- `nalTypes`: the types of the first 16 NAL units, in order of first appearance
- `offset`: where the first start code is

Matching is strict: a `00 00 01` alone is not enough, the NAL headers that follow must be
valid for the codec. NAL headers valid for both codecs give `null`, and so does an H.265 NAL unit
outside the base layer (`nuh_layer_id` > 0).

## Catalogs: `@moqtap/media/catalog`

MSF (draft-ietf-moq-msf-00, -01) and CMSF (draft-ietf-moq-cmsf-00, -01) catalogs: the JSON
objects on a track named `catalog`, each an independent catalog or a delta update to the one
before. Everything is synchronous.

```typescript
import {
  applyCatalogObject,
  catalogTracks,
  createCatalogState,
  parseCatalog,
} from '@moqtap/media/catalog'

let state = createCatalogState({ catalogNamespace: 'live/event' })
for (const payload of catalogObjects) {
  const parsed = parseCatalog(payload)
  const update = applyCatalogObject(state, parsed)
  state = update.state
}
catalogTracks(state.document, { catalogNamespace: 'live/event' })
```

| Export | What it does |
| --- | --- |
| `parseCatalog(input, options?)` | Reads one object, as text or bytes: `independent`, `delta` or `invalid`. Gives the draft, or the candidate drafts, and every problem. Never throws. |
| `createCatalogState(options?)` | An empty catalog for one catalog track, with that track's namespace. |
| `applyCatalogObject(state, parsed)` | A new state: an independent catalog replaces, a delta adds, removes and clones tracks. A refused object leaves the state as it was. |
| `catalogTracks(document, options?)` | One normalised record per track. `publish: true` reads `publishTracks`. |
| `redactCatalogText(input, options?)` | The payload ready to share, or `null` when it cannot be read as a catalog. |
| `redactJsonText(input, options?)` | The same redaction for JSON of any shape, or `null` when it is not UTF-8 JSON. |
| `decodeBase64(text)` | RFC 4648 Base64 without `Buffer`, or `null`. |
| `isCatalogTrackName(name)` | Exactly `"catalog"`. |
| `CATALOG_TRACK_NAME` | `"catalog"`. |

### Which draft

The drafts differ by shape. MSF-00 writes `version` as a Number and a delta as
`deltaUpdate: true` beside `addTracks`, `removeTracks` and `cloneTracks`. MSF-01 writes
`version` as a String and a delta as a `deltaUpdate` array of `{op, tracks}`. A `cmaf` track,
or a root `contentProtections`, makes a catalog CMSF. CMSF-00 puts a track's CMAF header in its
`initData`; CMSF-01 in a root `initDataList` entry that the track names by `initRef`.

When the draft is known, pass it as `draft`. The shape is then checked against it. Without it,
a catalog whose shape does not make it CMSF has `draft` `null`, the MSF and CMSF drafts in
`candidates` and an `ambiguous_draft` warning, and only the rules both drafts share are checked.

### Problems

Each problem gives:

- `category`: the kind of rule broken, with the names `@moqtap/test-vectors` uses
  (`missing_field`, `forbidden_field`, `unknown_track`, ...), plus this package's own
  `ambiguous_draft`
- `path`: where, such as `tracks[0].packaging` or `deltaUpdate[1].op`
- `section`: the draft and section that state the rule, such as `MSF-01 5.2.4`
- `severity`: `error` or `warning`
- `message`: what is wrong, as a sentence to show, with field names spelled as in the catalog

A warning breaks a rule that binds the producer, or is `ambiguous_draft`, and the object still
applies. An error breaks a rule that binds the reader, or leaves nothing to resolve: an
unsupported version, a delta that removes a track that was never declared, a track without a
name. The object is refused.

### Deltas

A delta's operations apply in order, keyed by namespace and name. A track without a namespace
has the catalog track's. A clone holds its parent's fields with its own on top. A remove or
clone naming a track the catalog declares more than once fails. If one operation fails, none
apply. A delta's other root fields do not change the catalog.

Group and Object IDs are the caller's to follow: in MSF-01, Object 0 of each Group is
independent, and earlier updates are ignored once a newer Group starts.

### Normalised view

`catalogTracks` gives each track's namespace, name, packaging, role, codec, sizes, rates,
groups, timing and dependencies. A field of the wrong JSON type comes back as `null`, and `raw`
keeps the track as written. In addition:

- `mimeType` also reads `mimetype`.
- `initData` is decoded to bytes, from the `initDataList` entry that `initRef` names or, when the
  track has no `initRef`, from its own `initData`.
- `contentProtections` holds the root entries the track's `contentProtectionRefIDs` name.
- An `initDataList` id or `contentProtections` refID given more than once names nothing.

### Redaction

`redactCatalogText` replaces secret values with `"[redacted]"` and leaves every other byte of
the text as it was, except that a leading BOM is dropped.

- **Always**: `trackBaseKey`, the live content key.
- **With `credentials`** (the default): every `token`, the value of each `authInfo` scheme (the
  scheme names stay), the userinfo, query and fragment of `connectionUri` and of the `url` in a
  CMSF DRM system's `laURL` and `certURL`. Members CMSF does not name are left as they are.
- **Kept**: `keyId`, `pssh`, `defaultKID`, the encryption scheme and cipher suite, and the init
  data.

It returns `null` for a payload that is not UTF-8, not JSON or not shaped like a catalog.

`redactJsonText` applies the same rules to JSON of any shape: tracks written as an object, a
catalog nested under another key, an array at the root. Every member with one of these names is
redacted, at any depth, and the rest of the text stays byte for byte. It returns `null` only
when the payload is not UTF-8 or not JSON.

## LOC: `@moqtap/media/loc`

LOC object properties under draft-ietf-moq-loc-00 to -04 and draft-mzanaty-moq-loc-05, and the
NAL unit framing of H.264 and H.265 LOC payloads. Properties are given as `@moqtap/codec`
reads them: `{ type, value }` for an even type, `{ type, bytes }` for an odd one, and
`properties` inside Immutable Properties.

```typescript
import {
  decodeLocProperties,
  locPropertyTypes,
  possibleProfiles,
  resolveProfile,
} from '@moqtap/media/loc'

const types = locPropertyTypes(object.properties, '22')
const resolution = resolveProfile(possibleProfiles(types, '22'))
// { profile: 'ietf-04' }, or { candidates: ['ietf-03', 'ietf-04'] }

decodeLocProperties(object.properties, resolution, { transportDraft: '22', videoCodec: 'avc1.64001F' })
// [{ type: 16n, raw: 8100000n, name: 'Timestamp', meaning: 'timestamp',
//    decoded: { kind: 'timestamp', value: 8100000n, timescales: [90000n] } }, ...]
```

### Profiles

The drafts give the same property types different meanings, so properties are read under a
profile:

| Profile | Drafts |
| --- | --- |
| `ietf-00/01` | draft-ietf-moq-loc-00 and -01, which are identical on the wire |
| `ietf-02` | draft-ietf-moq-loc-02 |
| `ietf-03` | draft-ietf-moq-loc-03 |
| `ietf-04` | draft-ietf-moq-loc-04 |
| `mzanaty-05` | draft-mzanaty-moq-loc-05, the draft MSF-00 cites |

A profile is possible for a track when it defines every property type seen on the track's
objects, where it was seen, leaving out the types the transport draft defines at Object scope.
The Secure Objects Key ID (0x02 in ietf-02 to -04) counts only inside Immutable Properties.
`resolveProfile` gives the profile when exactly one is possible, or when one is pinned.
Otherwise it gives the candidates, and a property is decoded only when every candidate gives its
type the same meaning and encoding, and the same verdict on whether its value is within the
stated size.

Only read a track as LOC when its catalog `packaging` is `"loc"`, or the user says so.

| Export | What it does |
| --- | --- |
| `LOC_PROFILES` | The profile ids. |
| `describeProfile(profile)` | The profile's drafts and property definitions: ID, name, encoding, section, and the sizes the draft states. |
| `locPropertyTypes(properties, transportDraft?)` | The distinct `{ type, immutable }` pairs of one object that count toward its track's profile, including those inside Immutable Properties. |
| `possibleProfiles(types, transportDraft?)` | The profiles that define every type where it was seen. |
| `resolveProfile(possible, pinned?)` | `{ profile }` or `{ candidates }`. |
| `decodeLocProperties(properties, resolution, options?)` | One result per property, in order, with Immutable Properties' contents after it. |
| `decodeLocTrackProperties(properties, resolution, options?)` | The same for a track's Track Properties (draft-16 Track Extensions), reading only what the profile defines at Track scope. |
| `isTransportObjectProperty(type, transportDraft)` | Whether the transport draft (`'08'` to `'22'`) defines the type at Object scope. |
| `isTransportTrackProperty(type, transportDraft)` | Whether the transport draft defines the type as a Track property. |
| `decodeFrameMarkingBytes(bytes)`, `decodeFrameMarkingVarint(value)` | RFC 9626 Frame Marking readings, or `null`. |
| `decodeAudioLevel(value)` | RFC 6464 level, dBov and voice activity, or `null` above `0xFF`. |
| `decodeVideoConfig(bytes, codec)` | An avcC or hvcC summary for an `avc1`, `avc3`, `hvc1` or `hev1` codec string, or `null`. |
| `videoCodecFamily(codec)` | `'h264'`, `'h265'` or `null`. |
| `analyzeLocPayload(payload, codec, config?)` | NAL unit framing, NAL unit types and whether a keyframe is present. |

Pass `transportDraft` whenever it is known. Without it, no type is treated as the transport's.

### Property results

Each result has the `type` and the `raw` value or bytes, and:

- `transport`: the transport draft defines the type at Object scope, and no profile of the
  resolution defines it there; it is not read as LOC.
- `immutable`: the property was inside Immutable Properties.
- `name` and `meaning`: the profile, or every candidate, gives the type this one meaning.
- `decoded`: the reading.
- `ambiguous`: the meanings per profile, when they differ or one profile gives the type two
  (0x06 in ietf-02). The value is left raw. When the candidates agree on the meaning but not on
  whether the value is within the stated size (0x04 of 2^29 under ietf-00/01 and ietf-02), each
  entry carries that profile's `error`, if any. On drafts 19 to 22, 0x02 and 0x06 are also
  OBJECT_DELIVERY_TIMEOUT and SUBGROUP_DELIVERY_TIMEOUT. When a profile of the resolution
  defines the type where it was seen, such as the ietf-03 Timestamp at 0x06 or the Secure
  Objects Key ID at 0x02 inside Immutable Properties, both readings are listed. These types do
  not count toward the profile.
- `uninterpreted`: the draft allows the value but defines no reading for it, such as Frame
  Marking of 4 bytes, or any mzanaty-05 value, whose declared encodings the transport cannot
  carry.
- `error`: `invalid_length` or `out_of_range`, when the value is outside what the draft states.

Readings:

- **Timestamp** carries `timescales`, every distinct Timescale known for the object: from the
  object and from the `trackTimescales` option. Empty means wall-clock microseconds since the
  Unix epoch. Capture Timestamp (ietf-00/01) is always wall-clock microseconds.
- **Video Frame Marking** gives `candidates`. Under ietf-03/04 the length gives the form, so
  there is one. Under ietf-00/01/02 the value is a varint that does not say which form was
  sent, so a value below 2^16 fits several and all are given.
- **Audio Level** gives `level` (0 to 127), `dBov` and `voiceActivity` (the V bit).
- **Video Config** is decoded when the `videoCodec` option is an H.264 or H.265 codec string.
  Audio Config is named but not decoded.

### Payloads

`analyzeLocPayload` reads an H.264 or H.265 payload as start codes or as big-endian NAL unit
lengths. The length size comes from the Video Config, else it is 4, and a 4-byte length of 1
is a start code. A reading with 3-byte start codes carries `threeByteStartCodes`. Bytes that
fit both framings give `{ framing: 'ambiguous', candidates }`; bytes that fit neither give
`null`.

The payload is read from its first byte. Under ietf-02 to -04 an object payload can begin with
LOC Private Properties, whose framing those drafts leave unspecified outside Secure Objects.

## License

MIT
