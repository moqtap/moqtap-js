// NAL unit header rules shared by the Annex-B sniffer and the LOC payload reader.

// nal_unit_type: H.264 7.3.1, 7.4.1, Table 7-1

/**
 * Types Table 7-1 specifies. Reserved (17, 18, 22, 23) and unspecified (0,
 * 24-31) types mean not H.264.
 */
export const H264_KNOWN = new Set([
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 19, 20, 21,
])

export const H264_IDR = 5

// NAL unit header: H.265 7.3.1.2, 7.4.2.2, Table 7-1

/** IRAP types in use: BLA_W_LP (16) through CRA_NUT (21); 22-23 are reserved IRAP types (H.265 Table 7-1) */
export const H265_IRAP_MIN = 16
export const H265_IRAP_MAX = 21

/**
 * Types Table 7-1 specifies: VCL 0-9 and 16-21, non-VCL 32-40. Reserved (10-15,
 * 22-31, 41-47) and unspecified (48-63) types mean not H.265.
 */
export function isKnownH265(type: number): boolean {
  return type <= 9 || (type >= H265_IRAP_MIN && type <= H265_IRAP_MAX) || (type >= 32 && type <= 40)
}

export function isH265Irap(type: number): boolean {
  return type >= H265_IRAP_MIN && type <= H265_IRAP_MAX
}

// slice_type: H.264 7.4.3, Table 7-6. 5-9 repeat 0-4 for every slice of the picture.

export type H264SliceType = 'P' | 'B' | 'I' | 'SP' | 'SI'

export const H264_SLICE_TYPES: readonly H264SliceType[] = ['P', 'B', 'I', 'SP', 'SI']

/** nal_unit_type of slices whose RBSP starts with slice_header(): 1, 2 (partition A), 5 (H.264 7.3.2.8, 7.3.2.9.1) */
export function h264HasSliceHeader(type: number): boolean {
  return type === 1 || type === 2 || type === H264_IDR
}

/** VCL NAL unit types 1-5 (H.264 Table 7-1) */
export function isH264Vcl(type: number): boolean {
  return type >= 1 && type <= 5
}

/**
 * H.265 NAL unit types by picture kind (H.265 Table 7-1). Sub-layer
 * reference/non-reference pairs share a kind; `reserved-vcl` is 10-15 and 22-31.
 */
export type H265NalKind =
  | 'trail'
  | 'tsa'
  | 'stsa'
  | 'radl'
  | 'rasl'
  | 'bla'
  | 'idr'
  | 'cra'
  | 'reserved-vcl'
  | 'non-vcl'

export function h265NalKind(type: number): H265NalKind {
  if (type >= 32) return 'non-vcl'
  if (type <= 1) return 'trail'
  if (type <= 3) return 'tsa'
  if (type <= 5) return 'stsa'
  if (type <= 7) return 'radl'
  if (type <= 9) return 'rasl'
  if (type >= 16 && type <= 18) return 'bla'
  if (type === 19 || type === 20) return 'idr'
  if (type === 21) return 'cra'
  return 'reserved-vcl'
}
