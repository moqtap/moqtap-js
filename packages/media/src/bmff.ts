/**
 * ISO BMFF (ISO/IEC 14496-12) boxes in MoQT object payloads, with the MoQT
 * framing already stripped.
 *
 * Box structure (ISO/IEC 14496-12 4.2):
 *   [4-byte size (big-endian uint32)][4-byte type][payload...]
 *   - size includes the 8-byte header
 *   - size 0 = box extends to the end of its container (the file, at top level)
 *   - size 1 = 64-bit `largesize` follows the type
 *
 * Nothing reads past the bytes given: a truncated payload yields what its
 * bytes hold.
 */

import {
  brandsAt,
  type Child,
  child,
  children,
  childrenOf,
  fourcc,
  fullBoxU32,
  hex,
  readSgpd,
  type SampleGroupDescription,
  topLevel,
  u32,
  versionFlags,
} from './box'
import { readCodecConfigBox, type VideoCodecConfig } from './codecconfig'

export type { SampleGroupDescription } from './box'
export type {
  Av1CodecConfig,
  Av1SequenceHeader,
  AvcCodecConfig,
  HevcCodecConfig,
  VideoCodecConfig,
} from './codecconfig'

// ─── Types ───────────────────────────────────────────────────────────

export interface BmffBox {
  /** 4-char box type, e.g. 'ftyp', 'moof', 'mdat' */
  type: string
  /** Byte offset within the payload */
  offset: number
  /**
   * Total box size in bytes, header included. For a box whose size field is
   * 0 this is the rest of the data; it can exceed the bytes actually present
   * when the payload is truncated.
   */
  size: number
}

/**
 * - `cmaf`: a `styp` (media segment) or `ftyp` (CMAF header) carrying a CMAF
 *   brand — the structural brands `cmfc` (first edition) and `cmf2` (second
 *   edition), or `cmfs`, `cmfl` or `cmff` (ISO/IEC 23000-19, 7.2).
 * - `fmp4`: any other run of BMFF boxes.
 *
 * A catalog's `packaging` overrides this: a CMSF object may hold only
 * `moof`+`mdat` (cmsf-01, 3.3), which carry no brand.
 */
export type MediaVariant = 'cmaf' | 'fmp4'

export interface PayloadMediaInfo {
  /** Container variant */
  variant: MediaVariant
  /** The first 32 top-level box types, in order (e.g. ['styp', 'moof', 'mdat']) */
  boxes: string[]
}

/** The brands of an `ftyp` or `styp` box (ISO/IEC 14496-12, 4.3). */
export interface Brands {
  major: string
  minorVersion: number
  compatible: string[]
}

/**
 * One `trak` of an init segment. A field is `null` when its box is missing
 * or cut short.
 */
export interface InitTrack {
  /** `tkhd` track_ID — what each fragment's `tfhd` must name */
  trackId: number | null
  /** `hdlr` handler_type: 'vide', 'soun', 'text', 'subt', 'meta', ... */
  handler: string | null
  /**
   * The 4CC of the first sample entry in `stsd`: 'avc1', 'hvc1', 'mp4a',
   * 'Opus', ... An encrypted track shows 'encv' or 'enca' here.
   */
  sampleEntry: string | null
  /** `sampleEntry`, or for 'encv' and 'enca' the original format in `sinf/frma` */
  codec: string | null
  /** `mdhd` timescale, in units per second */
  timescale: number | null
  /** The `moov/mvex/trex` naming this track_ID, or `null` when there is none or more than one */
  trex: TrackExtends | null
  /** The protection boxes of an 'encv' or 'enca' sample entry, else `null` */
  encryption: TrackEncryption | null
  /** The `sgpd` boxes of the track's `stbl` */
  sampleGroups: SampleGroupDescription[]
  /** The trak has an `edts` (edit list container) */
  hasEditList: boolean
  /**
   * The `avcC`, `hvcC` or `av1C` of a 'vide' track's first sample entry, or
   * `null` when it has none or the record does not parse
   */
  codecConfig: VideoCodecConfig | null
}

/** `trex` defaults (ISO/IEC 14496-12 8.8.3) */
export interface TrackExtends {
  defaultSampleDescriptionIndex: number
  defaultSampleDuration: number
  defaultSampleSize: number
  defaultSampleFlags: number
}

/**
 * The `sinf` of a protected sample entry (ISO/IEC 14496-12 8.12, ISO/IEC
 * 23001-7). `sinf` is `false` when the sample entry holds none.
 */
export interface TrackEncryption {
  sinf: boolean
  /** `frma` data_format */
  originalFormat: string | null
  /** `schm` scheme_type: 'cenc', 'cbcs', ... */
  schemeType: string | null
  schemeVersion: number | null
  /** `schi/tenc` */
  tenc: TrackEncryptionBox | null
}

export interface TrackEncryptionBox {
  version: number
  isProtected: number
  perSampleIvSize: number
  /** default_KID as 32 hex digits, in byte order */
  defaultKid: string
  /** Version 1 and later, else `null` */
  cryptByteBlock: number | null
  skipByteBlock: number | null
  /** Hex, when isProtected is 1 and perSampleIvSize is 0 */
  constantIv: string | null
}

/** A `pssh` box (ISO/IEC 23001-7). IDs are 32 hex digits, in byte order. */
export interface ProtectionSystemHeader {
  systemId: string
  /** The KIDs of a version 1 box; empty for version 0 */
  kids: string[]
  dataSize: number
}

/** What an init segment (CMAF header) says about itself and its tracks. */
export interface InitSegment {
  /** The `ftyp` brands, or `null` when there is no `ftyp` */
  brands: Brands | null
  /** One entry per `moov/trak`, in order */
  tracks: InitTrack[]
  /** The `moov/pssh` boxes, in order */
  pssh: ProtectionSystemHeader[]
  /** track_IDs that more than one `trak` or more than one `trex` names */
  ambiguousTrackIds: number[]
}

// ─── Known box types ─────────────────────────────────────────────────

/**
 * Box types accepted at the top level by {@link parseBoxes}. A known type is
 * required because arbitrary binary is full of printable 4CCs.
 */
const KNOWN_BOX_TYPES = new Set([
  // File/segment type
  'ftyp',
  'styp',
  // Movie structure
  'moov',
  'mvhd',
  'mvex',
  'trex',
  // Track structure
  'trak',
  'tkhd',
  'mdia',
  'mdhd',
  'hdlr',
  'minf',
  'dinf',
  'stbl',
  // Sample table (init segment)
  'stsd',
  'stts',
  'stsc',
  'stsz',
  'stco',
  'co64',
  'ctts',
  'stss',
  // Fragment structure
  'moof',
  'mfhd',
  'traf',
  'tfhd',
  'tfdt',
  'trun',
  // Media data
  'mdat',
  // Segment index & metadata
  'sidx',
  'emsg',
  'prft',
  // Common extensions
  'uuid',
  'edts',
  'elst',
  'udta',
  'meta',
  'iloc',
  'iinf',
  // Skip/free space
  'free',
  'skip',
])

// ─── Top-level box parser ────────────────────────────────────────────

/**
 * Parse top-level ISO BMFF boxes from a payload buffer.
 *
 * Walks the data sequentially, reading [size][type] headers.
 * Stops at the first invalid or unknown box or when data is exhausted.
 *
 * @param data  Raw payload bytes (MoQT framing already stripped)
 * @param limit Maximum number of boxes to parse (default 32)
 */
export function parseBoxes(data: Uint8Array, limit = 32): BmffBox[] {
  const boxes: BmffBox[] = []
  let offset = 0
  const len = data.length

  while (offset + 8 <= len && boxes.length < limit) {
    const rawSize = u32(data, offset)

    // Type bytes must be printable ASCII
    let printable = true
    for (let i = 4; i < 8; i++) {
      const c = data[offset + i]!
      if (c < 0x20 || c > 0x7e) printable = false
    }
    if (!printable) break

    const type = fourcc(data, offset + 4)
    if (!KNOWN_BOX_TYPES.has(type)) break

    let boxSize: number

    if (rawSize === 0) {
      // Box extends to end of data
      boxSize = len - offset
    } else if (rawSize === 1) {
      // 64-bit largesize
      if (offset + 16 > len) break
      if (u32(data, offset + 8) > 0) {
        // Larger than 4 GiB: runs to the end of data.
        boxSize = len - offset
      } else {
        boxSize = u32(data, offset + 12)
        if (boxSize < 16) break
      }
    } else if (rawSize >= 8) {
      boxSize = rawSize
    } else {
      // Invalid size (2-7)
      break
    }

    boxes.push({ type, offset, size: boxSize })

    // Advance to next box
    if (rawSize === 0) break // last box — extends to EOF
    offset += boxSize
  }

  return boxes
}

// ─── Brands and classification ───────────────────────────────────────

/**
 * CMAF brands (ISO/IEC 23000-19, 7.2): any one of them makes a file CMAF.
 * `cmf2` is the second edition's structural brand.
 */
const CMAF_BRANDS = new Set(['cmfc', 'cmf2', 'cmfs', 'cmfl', 'cmff'])

/** Whether `brand` is one of the CMAF brands. */
export function isCmafBrand(brand: string): boolean {
  return CMAF_BRANDS.has(brand)
}

/**
 * Read the brands of an `ftyp` or `styp` box.
 *
 * Layout: [size][type][major_brand(4)][minor_version(4)][compatible_brands(4 each)...]
 *
 * Returns `null` when the box is too short to hold a major brand and minor
 * version. Compatible brands are read as far as the box and the data go.
 */
export function readBrands(data: Uint8Array, box: BmffBox): Brands | null {
  return brandsAt(data, box.offset + 8, Math.min(box.offset + box.size, data.length))
}

function hasCmafBrand(brands: Brands | null): boolean {
  return brands !== null && (isCmafBrand(brands.major) || brands.compatible.some(isCmafBrand))
}

/**
 * Classify a run of boxes as CMAF or plain fMP4 (see {@link MediaVariant}).
 *
 * CMAF only when a `styp` (a segment) or an `ftyp` (a CMAF header, i.e. an
 * init segment) names a CMAF brand. `styp`+`moof`+`mdat` without one is
 * `fmp4`: ordinary fragmented MP4 (ISO/IEC 14496-12, 8.16).
 */
export function classifyVariant(boxes: BmffBox[], data: Uint8Array): MediaVariant {
  for (const box of boxes) {
    if ((box.type === 'styp' || box.type === 'ftyp') && hasCmafBrand(readBrands(data, box))) {
      return 'cmaf'
    }
  }
  return 'fmp4'
}

// ─── High-level detection ────────────────────────────────────────────

/**
 * Detect media info from a raw payload buffer.
 *
 * Returns null if the data doesn't start with valid ISO BMFF boxes.
 */
export function detectMediaInfo(payload: Uint8Array): PayloadMediaInfo | null {
  if (payload.length < 8) return null

  const boxes = parseBoxes(payload)
  if (boxes.length === 0) return null

  return {
    variant: classifyVariant(boxes, payload),
    boxes: boxes.map((b) => b.type),
  }
}

/**
 * Sniff for BMFF boxes behind an unknown prefix of up to `scanLimit` bytes:
 * the first offset where {@link parseBoxes} finds a box wins.
 */
export function scanAndDetectMedia(data: Uint8Array, scanLimit = 256): PayloadMediaInfo | null {
  for (let i = 0; i <= scanLimit && i + 8 <= data.length; i++) {
    const view = data.subarray(i)
    const boxes = parseBoxes(view)
    if (boxes.length > 0) {
      return {
        variant: classifyVariant(boxes, view),
        boxes: boxes.map((b) => b.type),
      }
    }
  }

  return null
}

// ─── Fragments ───────────────────────────────────────────────────────

/**
 * The track_ID of every `moof/traf/tfhd` in `data`, in order.
 *
 * CMSF (-00, -01, 3.3) requires each fragment's track_ID to match the init
 * segment's; a fragment names it in `tfhd` (ISO/IEC 14496-12, 8.8.7).
 *
 * tfhd: FullBox(version, flags) then track_ID(4).
 */
export function fragmentTrackIds(data: Uint8Array): number[] {
  const ids: number[] = []
  for (const moof of topLevel(data)) {
    if (moof.type !== 'moof') continue
    for (const traf of children(data, moof.body, moof.end)) {
      if (traf.type !== 'traf') continue
      const tfhd = child(data, traf, 'tfhd')
      if (tfhd && tfhd.body + 8 <= tfhd.end) ids.push(u32(data, tfhd.body + 4))
    }
  }
  return ids
}

// ─── Init segments ───────────────────────────────────────────────────

function readTrex(data: Uint8Array, box: Child): (TrackExtends & { trackId: number }) | null {
  if (box.body + 24 > box.end) return null
  return {
    trackId: u32(data, box.body + 4),
    defaultSampleDescriptionIndex: u32(data, box.body + 8),
    defaultSampleDuration: u32(data, box.body + 12),
    defaultSampleSize: u32(data, box.body + 16),
    defaultSampleFlags: u32(data, box.body + 20),
  }
}

/**
 * tenc (ISO/IEC 23001-7): reserved(1), then reserved(1) for version 0 or
 * crypt_byte_block(4 bits) skip_byte_block(4 bits), isProtected(1),
 * Per_Sample_IV_Size(1), KID(16), and a constant IV when isProtected is 1
 * and the IV size is 0.
 */
function readTenc(data: Uint8Array, box: Child): TrackEncryptionBox | null {
  const vf = versionFlags(data, box)
  const at = box.body + 4
  if (vf === null || at + 20 > box.end) return null
  const pattern = data[at + 1]!
  const isProtected = data[at + 2]!
  const perSampleIvSize = data[at + 3]!
  let constantIv: string | null = null
  if (isProtected === 1 && perSampleIvSize === 0 && at + 21 <= box.end) {
    const size = data[at + 20]!
    if (at + 21 + size <= box.end) constantIv = hex(data, at + 21, at + 21 + size)
  }
  return {
    version: vf.version,
    isProtected,
    perSampleIvSize,
    defaultKid: hex(data, at + 4, at + 20),
    cryptByteBlock: vf.version >= 1 ? pattern >> 4 : null,
    skipByteBlock: vf.version >= 1 ? pattern & 0x0f : null,
    constantIv,
  }
}

/**
 * The `sinf` of an 'encv' or 'enca' entry, among the child boxes after the
 * VisualSampleEntry fields (78 bytes into the body) or the AudioSampleEntry
 * fields (28 bytes).
 */
function readEncryption(data: Uint8Array, entry: Child): TrackEncryption {
  const start = entry.body + (entry.type === 'encv' ? 78 : 28)
  const sinf = children(data, start, entry.end).find((c) => c.type === 'sinf')
  if (!sinf) {
    return { sinf: false, originalFormat: null, schemeType: null, schemeVersion: null, tenc: null }
  }
  const frma = child(data, sinf, 'frma')
  const schm = child(data, sinf, 'schm')
  const schi = child(data, sinf, 'schi')
  const tenc = schi && child(data, schi, 'tenc')
  return {
    sinf: true,
    originalFormat: frma && frma.body + 4 <= frma.end ? fourcc(data, frma.body) : null,
    schemeType: schm && schm.body + 8 <= schm.end ? fourcc(data, schm.body + 4) : null,
    schemeVersion: schm && schm.body + 12 <= schm.end ? u32(data, schm.body + 8) : null,
    tenc: tenc ? readTenc(data, tenc) : null,
  }
}

/** The decoder configuration box after the VisualSampleEntry fields (78 bytes into the body) */
function readVisualCodecConfig(data: Uint8Array, entry: Child): VideoCodecConfig | null {
  return readCodecConfigBox(data, children(data, entry.body + 78, entry.end))
}

/** pssh (ISO/IEC 23001-7): SystemID(16), KID_count and KIDs for version 1, DataSize(4) */
function readPssh(data: Uint8Array, box: Child): ProtectionSystemHeader | null {
  const vf = versionFlags(data, box)
  let at = box.body + 4
  if (vf === null || at + 16 > box.end) return null
  const systemId = hex(data, at, at + 16)
  at += 16
  const kids: string[] = []
  if (vf.version > 0) {
    if (at + 4 > box.end) return null
    const count = u32(data, at)
    at += 4
    for (let i = 0; i < count; i++, at += 16) {
      if (at + 16 > box.end) return null
      kids.push(hex(data, at, at + 16))
    }
  }
  if (at + 4 > box.end) return null
  return { systemId, kids, dataSize: u32(data, at) }
}

/**
 * Summarise an init segment: its `ftyp` brands, its `pssh` boxes, and per
 * `moov/trak` the track_ID, handler, sample entry and coding, timescale,
 * `trex` defaults, protection boxes and sample group descriptions. Returns
 * `null` when `data` has no `moov`.
 *
 * Boxes read (ISO/IEC 14496-12):
 *   - tkhd (8.3.2): v0 creation(4) modification(4) track_ID; v1 8, 8, track_ID
 *   - mdhd (8.4.2): v0 creation(4) modification(4) timescale; v1 8, 8, timescale
 *   - hdlr (8.4.3): pre_defined(4) handler_type(4)
 *   - stsd (8.5.2): entry_count(4) then sample entries, each a box
 *   - trex (8.8.3): track_ID and the four sample defaults
 *   - avcC, hvcC, av1C in a 'vide' sample entry (ISO/IEC 14496-15, AV1-ISOBMFF)
 */
export function parseInitSegment(data: Uint8Array): InitSegment | null {
  const top = topLevel(data)
  const moov = top.find((b) => b.type === 'moov')
  if (!moov) return null

  const ftyp = top.find((b) => b.type === 'ftyp')
  const brands = ftyp ? brandsAt(data, ftyp.body, ftyp.end) : null

  const inMoov = children(data, moov.body, moov.end)
  const trexById = new Map<number, TrackExtends>()
  const ambiguous = new Set<number>()
  for (const mvex of inMoov) {
    if (mvex.type !== 'mvex') continue
    for (const box of childrenOf(data, mvex, 'trex')) {
      const trex = readTrex(data, box)
      if (trex === null) continue
      const { trackId, ...defaults } = trex
      if (trexById.has(trackId)) ambiguous.add(trackId)
      else trexById.set(trackId, defaults)
    }
  }

  const tracks: InitTrack[] = []
  for (const trak of inMoov) {
    if (trak.type !== 'trak') continue
    const tkhd = child(data, trak, 'tkhd')
    const mdia = child(data, trak, 'mdia')
    const mdhd = mdia && child(data, mdia, 'mdhd')
    const hdlr = mdia && child(data, mdia, 'hdlr')
    const minf = mdia && child(data, mdia, 'minf')
    const stbl = minf && child(data, minf, 'stbl')
    const stsd = stbl && child(data, stbl, 'stsd')

    // version/flags(4) entry_count(4), then the first entry
    const entry =
      stsd && stsd.body + 16 <= stsd.end ? children(data, stsd.body + 8, stsd.end)[0] : undefined
    const sampleEntry = entry?.type ?? null
    const encryption =
      entry && (entry.type === 'encv' || entry.type === 'enca') ? readEncryption(data, entry) : null
    const trackId = tkhd ? fullBoxU32(data, tkhd, 12, 20) : null
    const sampleGroups: SampleGroupDescription[] = []
    for (const sgpd of stbl ? childrenOf(data, stbl, 'sgpd') : []) {
      const read = readSgpd(data, sgpd)
      if (read) sampleGroups.push(read)
    }

    const handler = hdlr && hdlr.body + 12 <= hdlr.end ? fourcc(data, hdlr.body + 8) : null
    tracks.push({
      trackId,
      handler,
      sampleEntry,
      codec: encryption ? encryption.originalFormat : sampleEntry,
      timescale: mdhd ? fullBoxU32(data, mdhd, 12, 20) : null,
      trex: trackId === null || ambiguous.has(trackId) ? null : (trexById.get(trackId) ?? null),
      encryption,
      sampleGroups,
      hasEditList: child(data, trak, 'edts') !== undefined,
      codecConfig: entry && handler === 'vide' ? readVisualCodecConfig(data, entry) : null,
    })
  }

  const pssh: ProtectionSystemHeader[] = []
  for (const box of inMoov) {
    if (box.type !== 'pssh') continue
    const read = readPssh(data, box)
    if (read) pssh.push(read)
  }

  const seen = new Set<number>()
  for (const t of tracks) {
    if (t.trackId === null) continue
    if (seen.has(t.trackId)) ambiguous.add(t.trackId)
    seen.add(t.trackId)
  }

  return { brands, tracks, pssh, ambiguousTrackIds: [...ambiguous].sort((a, b) => a - b) }
}
