// AV1 OBU framing shared by the av1C reader and the frame type reader (AV1 5.3).

export const OBU_SEQUENCE_HEADER = 1
export const OBU_FRAME_HEADER = 3
export const OBU_FRAME = 6

export interface Obu {
  /** Offset of the obu_header */
  offset: number
  obuType: number
  /** From obu_extension_header, else `null` */
  temporalId: number | null
  spatialId: number | null
  payloadStart: number
  /** One past the last payload byte present */
  payloadEnd: number
  /** obu_size runs past the data, or the header is cut short */
  truncated: boolean
}

export type ObuWalkIssue = 'obu-forbidden-bit' | 'obu-header-truncated' | 'obu-size-past-end'

/** leb128() (AV1 4.10.5): at most 8 bytes; `null` when cut short or longer */
function leb128(d: Uint8Array, at: number, end: number): { value: number; size: number } | null {
  let value = 0
  for (let i = 0; i < 8; i++) {
    if (at + i >= end) return null
    const b = d[at + i]!
    value += (b & 0x7f) * 2 ** (7 * i)
    if ((b & 0x80) === 0) return { value, size: i + 1 }
  }
  return null
}

/**
 * Walk the OBUs of [start, end). An OBU without obu_has_size_field runs to
 * the end (AV1 5.2, low overhead bitstream format). The walk stops at the
 * first OBU it cannot frame.
 */
export function walkObus(
  d: Uint8Array,
  start = 0,
  end = d.length,
): { obus: Obu[]; issue: ObuWalkIssue | null } {
  const obus: Obu[] = []
  let at = start
  while (at < end) {
    const h = d[at]!
    // obu_header (5.3.2): forbidden(1) obu_type(4) extension_flag(1) has_size_field(1) reserved(1)
    if ((h & 0x80) !== 0) return { obus, issue: 'obu-forbidden-bit' }
    const obuType = (h >> 3) & 0x0f
    const extension = (h & 0x04) !== 0
    const hasSize = (h & 0x02) !== 0
    let p = at + 1
    let temporalId: number | null = null
    let spatialId: number | null = null
    if (extension) {
      if (p >= end) return { obus, issue: 'obu-header-truncated' }
      // obu_extension_header (5.3.3): temporal_id(3) spatial_id(2) reserved(3)
      temporalId = d[p]! >> 5
      spatialId = (d[p]! >> 3) & 0x03
      p++
    }
    let size = end - p
    if (hasSize) {
      const s = leb128(d, p, end)
      if (s === null) return { obus, issue: 'obu-header-truncated' }
      p += s.size
      size = s.value
    }
    const truncated = p + size > end
    obus.push({
      offset: at,
      obuType,
      temporalId,
      spatialId,
      payloadStart: p,
      payloadEnd: Math.min(p + size, end),
      truncated,
    })
    if (truncated) return { obus, issue: 'obu-size-past-end' }
    at = p + size
  }
  return { obus, issue: null }
}

/** The start of sequence_header_obu() (AV1 5.5.1) */
export interface Av1SequenceHeader {
  seqProfile: number
  stillPicture: boolean
  /** When set, every frame is a shown KEY frame and frame headers carry no frame type (5.9.2) */
  reducedStillPictureHeader: boolean
}

/** seq_profile(3) still_picture(1) reduced_still_picture_header(1); `null` for an empty payload */
export function readSequenceHeader(d: Uint8Array, obu: Obu): Av1SequenceHeader | null {
  if (obu.payloadStart >= obu.payloadEnd) return null
  const b = d[obu.payloadStart]!
  return {
    seqProfile: b >> 5,
    stillPicture: ((b >> 4) & 1) === 1,
    reducedStillPictureHeader: ((b >> 3) & 1) === 1,
  }
}
