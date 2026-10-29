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
