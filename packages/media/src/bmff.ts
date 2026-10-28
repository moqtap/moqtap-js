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
   * 'Opus', ... An encrypted track shows 'encv' or 'enca' here; its
   * original format is in the entry's `sinf/frma`, which this does not read.
   */
  sampleEntry: string | null
  /** `mdhd` timescale, in units per second */
  timescale: number | null
}

/** What an init segment (CMAF header) says about itself and its tracks. */
export interface InitSegment {
  /** The `ftyp` brands, or `null` when there is no `ftyp` */
  brands: Brands | null
  /** One entry per `moov/trak`, in order */
  tracks: InitTrack[]
}

// ─── Byte helpers ────────────────────────────────────────────────────

function u32(data: Uint8Array, offset: number): number {
  return (
    ((data[offset]! << 24) |
      (data[offset + 1]! << 16) |
      (data[offset + 2]! << 8) |
      data[offset + 3]!) >>>
    0
  )
}

function fourcc(data: Uint8Array, offset: number): string {
  return String.fromCharCode(data[offset]!, data[offset + 1]!, data[offset + 2]!, data[offset + 3]!)
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

/** Brands from a box body spanning [start, end). */
function brandsAt(data: Uint8Array, start: number, end: number): Brands | null {
  if (start + 8 > end) return null
  const compatible: string[] = []
  for (let i = start + 8; i + 4 <= end; i += 4) compatible.push(fourcc(data, i))
  return { major: fourcc(data, start), minorVersion: u32(data, start + 4), compatible }
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

// ─── Nested boxes ────────────────────────────────────────────────────

/** A child box: its type and where its payload starts and ends. */
interface Child {
  type: string
  /** First byte after the header (and largesize, if any) */
  body: number
  /** One past the last byte, clamped to the container */
  end: number
}

/**
 * The boxes directly inside [start, end). Unlike {@link parseBoxes} any type
 * is accepted — the container already vouches for its contents. A child that
 * claims to run past its container is clamped to it (the data was cut
 * short), and a malformed size ends the walk.
 */
function children(data: Uint8Array, start: number, end: number): Child[] {
  const out: Child[] = []
  let offset = start
  while (offset + 8 <= end) {
    const size = u32(data, offset)
    const type = fourcc(data, offset + 4)
    let body = offset + 8
    let boxEnd: number
    if (size === 0) {
      boxEnd = end
    } else if (size === 1) {
      if (offset + 16 > end) break
      body = offset + 16
      // A child past 4 GiB is necessarily cut short here.
      boxEnd = u32(data, offset + 8) > 0 ? end : offset + u32(data, offset + 12)
      if (boxEnd < body) break
    } else if (size >= 8) {
      boxEnd = offset + size
    } else {
      break
    }
    out.push({ type, body, end: Math.min(boxEnd, end) })
    if (boxEnd >= end) break
    offset = boxEnd
  }
  return out
}

function child(data: Uint8Array, parent: Child, type: string): Child | undefined {
  return children(data, parent.body, parent.end).find((c) => c.type === type)
}

/** The top level of `data` as {@link Child} entries, for the walks below. */
function topLevel(data: Uint8Array): Child[] {
  return children(data, 0, data.length)
}

/**
 * A 32-bit FullBox field whose position depends on the box's version: at
 * `v0` bytes into the body (version/flags included) for version 0, at `v1`
 * for version 1. Null when the box is cut short before it.
 */
function fullBoxU32(data: Uint8Array, box: Child, v0: number, v1: number): number | null {
  if (box.body + 4 > box.end) return null
  const at = box.body + (data[box.body] === 1 ? v1 : v0)
  return at + 4 <= box.end ? u32(data, at) : null
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

/**
 * Summarise an init segment: its `ftyp` brands, and per `moov/trak` the
 * track_ID, handler, first sample entry and timescale. Returns `null` when
 * `data` has no `moov`.
 *
 * Boxes read (ISO/IEC 14496-12):
 *   - tkhd (8.3.2): v0 creation(4) modification(4) track_ID; v1 8, 8, track_ID
 *   - mdhd (8.4.2): v0 creation(4) modification(4) timescale; v1 8, 8, timescale
 *   - hdlr (8.4.3): pre_defined(4) handler_type(4)
 *   - stsd (8.5.2): entry_count(4) then sample entries, each a box
 */
export function parseInitSegment(data: Uint8Array): InitSegment | null {
  const top = topLevel(data)
  const moov = top.find((b) => b.type === 'moov')
  if (!moov) return null

  const ftyp = top.find((b) => b.type === 'ftyp')
  const brands = ftyp ? brandsAt(data, ftyp.body, ftyp.end) : null

  const tracks: InitTrack[] = []
  for (const trak of children(data, moov.body, moov.end)) {
    if (trak.type !== 'trak') continue
    const tkhd = child(data, trak, 'tkhd')
    const mdia = child(data, trak, 'mdia')
    const mdhd = mdia && child(data, mdia, 'mdhd')
    const hdlr = mdia && child(data, mdia, 'hdlr')
    const minf = mdia && child(data, mdia, 'minf')
    const stbl = minf && child(data, minf, 'stbl')
    const stsd = stbl && child(data, stbl, 'stsd')

    let sampleEntry: string | null = null
    if (stsd && stsd.body + 16 <= stsd.end) {
      // version/flags(4) entry_count(4), then the first entry's size(4) type(4)
      sampleEntry = fourcc(data, stsd.body + 12)
    }

    tracks.push({
      trackId: tkhd ? fullBoxU32(data, tkhd, 12, 20) : null,
      handler: hdlr && hdlr.body + 12 <= hdlr.end ? fourcc(data, hdlr.body + 8) : null,
      sampleEntry,
      timescale: mdhd ? fullBoxU32(data, mdhd, 12, 20) : null,
    })
  }

  return { brands, tracks }
}
