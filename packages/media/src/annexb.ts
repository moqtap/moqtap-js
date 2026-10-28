/**
 * Annex-B elementary stream sniffing (H.264 and H.265, Annex B byte stream). The
 * first start code may follow an unknown prefix, e.g. an 8-byte varint timestamp:
 *
 *   c0 00 00 00 87 d0 6d d3 | 00 00 00 01 09 10 | 00 00 00 01 67 64 00 1f ...
 *   └── 8-byte varint ─────┘ └─ AUD (NAL 9) ──┘ └─ SPS (NAL 7), High@3.1 ─
 *
 * A start code alone is not evidence: the NAL headers after it must be valid.
 */

/** The furthest offset the first start code is looked for at */
const SCAN_LIMIT = 64

/** Maximum NAL units to walk — enough to classify without scanning whole frames */
const MAX_NALS = 16

export interface AnnexBInfo {
  codec: 'h264' | 'h265'
  /** RFC 6381 codec string, e.g. "avc1.64001F". H.264 only — needs the SPS. */
  codecString?: string
  /** True when a keyframe NAL (H.264 IDR, H.265 IRAP) is among the first 16 NAL units */
  keyframe: boolean
  /** Types of the first 16 NAL units, in order of first appearance */
  nalTypes: number[]
  /** Offset of the first start code — anything before it is container framing */
  offset: number
}

/** Length of the start code at `i`, or 0 if there isn't one */
function startCodeLength(d: Uint8Array, i: number): 0 | 3 | 4 {
  if (i + 3 < d.length && d[i] === 0 && d[i + 1] === 0 && d[i + 2] === 0 && d[i + 3] === 1) {
    return 4
  }
  if (i + 2 < d.length && d[i] === 0 && d[i + 1] === 0 && d[i + 2] === 1) {
    return 3
  }
  return 0
}

interface RawNal {
  /** Offset of the NAL header byte (after the start code) */
  offset: number
}

/** Walk start codes from `start`, collecting NAL header offsets */
function collectNals(data: Uint8Array, start: number): RawNal[] {
  const nals: RawNal[] = []
  let i = start
  while (i < data.length && nals.length < MAX_NALS) {
    const sc = startCodeLength(data, i)
    if (sc === 0) {
      i++
      continue
    }
    const headerOffset = i + sc
    if (headerOffset >= data.length) break
    nals.push({ offset: headerOffset })
    i = headerOffset + 1
  }
  return nals
}

// ─── H.264 ───────────────────────────────────────────────────────────

// nal_unit_type: H.264 7.3.1, 7.4.1, Table 7-1

/** Types that alone identify H.264: slices, SPS, PPS, AUD */
const H264_STRONG = new Set([1, 5, 7, 8, 9])
/**
 * Types Table 7-1 specifies. Reserved (17, 18, 22, 23) and unspecified (0,
 * 24-31) types mean not H.264.
 */
const H264_KNOWN = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 19, 20, 21])

function classifyH264(
  data: Uint8Array,
  nals: RawNal[],
): { types: number[]; keyframe: boolean; sps: number | undefined } | null {
  const types: number[] = []
  let keyframe = false
  let sps: number | undefined

  for (const nal of nals) {
    const b = data[nal.offset]!
    // forbidden_zero_bit must be 0
    if ((b & 0x80) !== 0) return null
    const type = b & 0x1f
    if (!H264_KNOWN.has(type)) return null
    if (!types.includes(type)) types.push(type)
    if (type === 5) keyframe = true
    if (type === 7 && sps === undefined) sps = nal.offset + 1
  }

  if (!types.some((t) => H264_STRONG.has(t))) return null
  return { types, keyframe, sps }
}

/**
 * Build the RFC 6381 (3.3) codec string from the first three SPS bytes
 * (profile_idc, constraint flags, level_idc) — e.g. 64 00 1f → "avc1.64001F".
 * They precede any emulation-prevention byte, so no RBSP unescaping.
 */
function h264CodecString(data: Uint8Array, spsOffset: number): string | undefined {
  if (spsOffset + 2 >= data.length) return undefined
  let hex = ''
  for (let i = 0; i < 3; i++) {
    hex += data[spsOffset + i]!.toString(16).padStart(2, '0')
  }
  return `avc1.${hex.toUpperCase()}`
}

// ─── H.265 ───────────────────────────────────────────────────────────

// NAL unit header: H.265 7.3.1.2, 7.4.2.2, Table 7-1

/** VPS, SPS, PPS, AUD; slices also identify H.265 */
const H265_STRONG = new Set([32, 33, 34, 35])
/** IRAP types in use: BLA_W_LP (16) through CRA_NUT (21); 22-23 are reserved IRAP types (H.265 Table 7-1) */
const H265_IRAP_MIN = 16
const H265_IRAP_MAX = 21

/**
 * Types Table 7-1 specifies: VCL 0-9 and 16-21, non-VCL 32-40. Reserved (10-15,
 * 22-31, 41-47) and unspecified (48-63) types mean not H.265.
 */
function isKnownH265(type: number): boolean {
  return type <= 9 || (type >= H265_IRAP_MIN && type <= H265_IRAP_MAX) || (type >= 32 && type <= 40)
}

function classifyH265(
  data: Uint8Array,
  nals: RawNal[],
): { types: number[]; keyframe: boolean } | null {
  const types: number[] = []
  let keyframe = false
  let strong = false

  for (const nal of nals) {
    if (nal.offset + 1 >= data.length) return null
    const b0 = data[nal.offset]!
    const b1 = data[nal.offset + 1]!
    // forbidden_zero_bit must be 0
    if ((b0 & 0x80) !== 0) return null
    const type = (b0 >> 1) & 0x3f
    const layerId = ((b0 & 0x01) << 5) | (b1 >> 3)
    const tidPlus1 = b1 & 0x07
    // nuh_temporal_id_plus1 0 is forbidden; a NAL unit outside the base layer
    // (nuh_layer_id > 0) gives null.
    if (tidPlus1 === 0 || layerId !== 0 || !isKnownH265(type)) return null
    if (!types.includes(type)) types.push(type)
    const irap = type >= H265_IRAP_MIN && type <= H265_IRAP_MAX
    if (irap) keyframe = true
    if (H265_STRONG.has(type) || type <= 9 || irap) strong = true
  }

  if (!strong) return null
  return { types, keyframe }
}

// ─── Entry point ─────────────────────────────────────────────────────

/**
 * Sniff `data` for an Annex-B elementary stream whose first start code is at
 * most SCAN_LIMIT bytes in. Returns null when the payload is neither H.264 nor
 * H.265, or when its NAL headers are valid for both.
 */
export function detectAnnexB(data: Uint8Array): AnnexBInfo | null {
  if (data.length < 8) return null

  for (let i = 0; i <= SCAN_LIMIT && i < data.length; i++) {
    const sc = startCodeLength(data, i)
    if (sc === 0) continue

    const nals = collectNals(data, i)
    if (nals.length === 0) continue

    const h264 = classifyH264(data, nals)
    const h265 = classifyH265(data, nals)
    if (h264 && h265) return null
    if (h264) {
      const info: AnnexBInfo = {
        codec: 'h264',
        keyframe: h264.keyframe,
        nalTypes: h264.types,
        offset: i,
      }
      const codecString = h264.sps !== undefined ? h264CodecString(data, h264.sps) : undefined
      if (codecString !== undefined) info.codecString = codecString
      return info
    }

    if (h265) {
      return {
        codec: 'h265',
        keyframe: h265.keyframe,
        nalTypes: h265.types,
        offset: i,
      }
    }
  }

  return null
}
