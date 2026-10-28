# @moqtap/media

**Read the media inside MoQT objects.**

[npm](https://www.npmjs.com/package/@moqtap/media) | [GitHub](https://github.com/moqtap/moqtap-js/tree/master/packages/media)

## What it does

`@moqtap/media` looks at object payloads, with the MoQT framing already stripped, and says
what media they carry:

- **ISO BMFF boxes**: the top-level boxes of a payload, or sniffed for behind an unknown
  prefix.
- **CMAF or plain fMP4**: CMAF when a `styp` or `ftyp` names a CMAF brand.
- **Init segments**: the brands, and per track the track ID, handler, sample entry and
  timescale.
- **Fragments**: the track ID each `moof/traf/tfhd` names, to check against the init
  segment as CMSF requires.
- **Annex-B streams**: H.264 and H.265 by their NAL units, with keyframes and the H.264
  codec string.
- **MSF and CMSF catalogs**: each catalog object read and checked against its draft, deltas
  applied, tracks normalised, and credentials redacted for sharing.

No runtime dependencies. Works in Node.js, Bun, Deno and browsers. Every result is plain
data, so it survives `postMessage`; all but decoded catalog init data (a `Uint8Array`) also
survive `JSON.stringify`.

## Installation

```bash
npm install @moqtap/media
```

## Quick start

Each area is its own subpath, so importing one never pulls in another.

```typescript
import { detectMediaInfo, fragmentTrackIds, parseInitSegment } from '@moqtap/media/bmff'
import { detectAnnexB } from '@moqtap/media/annexb'

detectMediaInfo(payload)
// { variant: 'cmaf', boxes: ['styp', 'moof', 'mdat'] }

const init = parseInitSegment(initData)
// { brands: { major: 'cmfc', minorVersion: 0, compatible: ['iso6', 'cmfc'] },
//   tracks: [{ trackId: 1, handler: 'vide', sampleEntry: 'avc1', timescale: 90000 }] }

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
| `parseInitSegment(data)` | `ftyp` brands and, per `trak`, track ID, handler, first sample entry and timescale; `null` without a `moov`. |

A fragment of only `moof`+`mdat` carries no brand and classifies as `fmp4`, even on a CMAF
track. A catalog's `packaging` says whether a track is CMAF.

A payload cut short yields what its bytes hold: fields past the end come back as `null`.

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
| `parseCatalog(input, options?)` | Reads one object, as text or bytes: `independent`, `delta`, `invalid`, or `compressed` for gzip (not decompressed). Gives the draft, or the candidate drafts, and every problem. Never throws. |
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

It returns `null` for a payload that is compressed, not UTF-8, not JSON or not shaped like a
catalog.

`redactJsonText` applies the same rules to JSON of any shape: tracks written as an object, a
catalog nested under another key, an array at the root. Every member with one of these names is
redacted, at any depth, and the rest of the text stays byte for byte. It returns `null` only
when the payload is not UTF-8 or not JSON.

## License

MIT
