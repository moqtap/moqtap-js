import { describe, expect, it } from 'vitest'
import { detectAnnexB } from '../annexb'

/** Build a Uint8Array from a hex string like "00 00 00 01 67" */
function bytes(hex: string): Uint8Array {
  return new Uint8Array(
    hex
      .trim()
      .split(/\s+/)
      .map((b) => parseInt(b, 16)),
  )
}

// An 8-byte QUIC varint timestamp, then an H.264 Annex-B access unit.
const KEYFRAME = bytes(`
  c0 00 00 00 87 d0 6d d3
  00 00 00 01 09 10
  00 00 00 01 67 64 00 1f ac 2b 40 28 02 dd 80 88 00 00 1f 40 00 07 53 00 78 e1
`)
const DELTA_FRAME = bytes(`
  c0 00 00 00 87 d0 e5 04
  00 00 00 01 09 30
  00 00 00 01 61 e0 22 6f 00 00 41 ac 1e 80 00 00 03 00 00 03 00 00 03 00 a2 9d
`)

describe('Annex-B detection', () => {
  it('detects H.264 behind a varint timestamp prefix', () => {
    const info = detectAnnexB(KEYFRAME)
    expect(info).not.toBeNull()
    expect(info!.codec).toBe('h264')
    // The elementary stream starts after the 8-byte timestamp
    expect(info!.offset).toBe(8)
  })

  it('reads the codec string from the SPS', () => {
    // profile_idc=0x64 (High), constraints=0x00, level_idc=0x1f (3.1)
    expect(detectAnnexB(KEYFRAME)!.codecString).toBe('avc1.64001F')
  })

  it('flags keyframes by NAL type', () => {
    // Keyframe access unit carries AUD + SPS; delta carries AUD + non-IDR slice
    expect(detectAnnexB(KEYFRAME)!.nalTypes).toContain(7)
    expect(detectAnnexB(DELTA_FRAME)!.nalTypes).toEqual([9, 1])
    expect(detectAnnexB(DELTA_FRAME)!.keyframe).toBe(false)
  })

  it('has no codec string for a delta frame (no SPS present)', () => {
    expect(detectAnnexB(DELTA_FRAME)!.codecString).toBeUndefined()
  })

  it('detects a start code at offset 0 (no container prefix)', () => {
    const raw = KEYFRAME.subarray(8)
    const info = detectAnnexB(raw)
    expect(info!.codec).toBe('h264')
    expect(info!.offset).toBe(0)
  })

  it('detects H.265 by its two-byte NAL header', () => {
    // NAL type 32 (VPS) then 33 (SPS): header bytes 0x40 0x01 / 0x42 0x01
    const hevc = bytes(`
      00 00 00 01 40 01 0c 01 ff ff 01 60 00 00 03 00
      00 00 00 01 42 01 01 01 60 00 00 03 00 b0 00 00
    `)
    const info = detectAnnexB(hevc)
    expect(info).not.toBeNull()
    expect(info!.codec).toBe('h265')
    expect(info!.nalTypes).toEqual([32, 33])
  })

  it('detects an H.265 access unit holding only IRAP slices as a keyframe', () => {
    // NAL type 19 (IDR_W_RADL): header bytes 0x26 0x01
    const info = detectAnnexB(bytes('00 00 00 01 26 01 af 08 40 00 00 00'))
    expect(info!.codec).toBe('h265')
    expect(info!.nalTypes).toEqual([19])
    expect(info!.keyframe).toBe(true)
  })

  it('rejects reserved H.265 VCL types (Table 7-1)', () => {
    // TRAIL_R then type 12 (RSV_VCL_N12)
    expect(detectAnnexB(bytes('00 00 00 01 02 01 00 00 00 01 18 01 00 00'))).toBeNull()
    // IDR_W_RADL then type 22 (RSV_IRAP_VCL22)
    expect(detectAnnexB(bytes('00 00 00 01 26 01 00 00 00 01 2c 01 00 00'))).toBeNull()
  })

  it('rejects arbitrary binary that happens to contain a start code', () => {
    // 00 00 01 followed by a byte with forbidden_zero_bit set
    expect(detectAnnexB(bytes('de ad be ef 00 00 01 ff 11 22 33 44'))).toBeNull()
    // and a payload with no start code at all
    expect(detectAnnexB(bytes('01 02 03 04 05 06 07 08 09 0a 0b 0c'))).toBeNull()
  })

  it('gives no codec when the NAL headers are valid for both H.264 and H.265', () => {
    // 0x08 0x01: an H.264 PPS, or an H.265 STSA_N slice in layer 0
    expect(detectAnnexB(bytes('00 00 00 01 08 01 02 03'))).toBeNull()
  })

  it('finds the first start code up to 64 bytes in', () => {
    const raw = KEYFRAME.subarray(8)
    const behind = (n: number) => {
      const data = new Uint8Array(n + raw.length).fill(0xff)
      data.set(raw, n)
      return detectAnnexB(data)
    }
    expect(behind(64)!.offset).toBe(64)
    expect(behind(65)).toBeNull()
  })

  it('rejects payloads too short to classify', () => {
    expect(detectAnnexB(bytes('00 00 00 01 67'))).toBeNull()
  })

  it('does not claim fMP4 or JSON payloads', () => {
    const fmp4 = bytes('00 00 00 18 66 74 79 70 69 73 6f 6d 00 00 02 00 69 73 6f 6d 69 73 6f 32')
    expect(detectAnnexB(fmp4)).toBeNull()
    expect(detectAnnexB(new TextEncoder().encode('{"video":{"a":1}}'))).toBeNull()
  })
})
