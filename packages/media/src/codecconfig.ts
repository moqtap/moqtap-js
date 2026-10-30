// Decoder configuration records of video sample entries (ISO/IEC 14496-15, AV1-ISOBMFF).

import { type Av1SequenceHeader, OBU_SEQUENCE_HEADER, readSequenceHeader, walkObus } from './obu'

export type { Av1SequenceHeader } from './obu'

/** AVCDecoderConfigurationRecord, `avcC` (ISO/IEC 14496-15 5.3.3.1) */
export interface AvcCodecConfig {
  codec: 'h264'
  profile: number
  compatibility: number
  level: number
  /** lengthSizeMinusOne + 1: bytes in each NAL unit length field of a sample */
  lengthSize: number
  /** The sequence and picture parameter set NAL units, header byte included */
  sps: Uint8Array[]
  pps: Uint8Array[]
}

/** HEVCDecoderConfigurationRecord, `hvcC` (ISO/IEC 14496-15 8.3.3.1) */
export interface HevcCodecConfig {
  codec: 'h265'
  /** lengthSizeMinusOne + 1 */
  lengthSize: number
  /** The NAL unit arrays (VPS, SPS, PPS, SEI), header bytes included */
  arrays: { nalType: number; nalus: Uint8Array[] }[]
}

/** AV1CodecConfigurationRecord, `av1C` (AV1-ISOBMFF 2.3.3) */
export interface Av1CodecConfig {
  codec: 'av1'
  configObus: Uint8Array
  /** From the first OBU_SEQUENCE_HEADER of configOBUs, else `null` */
  sequenceHeader: Av1SequenceHeader | null
}

export type VideoCodecConfig = AvcCodecConfig | HevcCodecConfig | Av1CodecConfig

function u16(d: Uint8Array, at: number): number {
  return (d[at]! << 8) | d[at + 1]!
}

/** `count` units of u16 length + bytes from `at`; `null` when cut short */
function units(
  d: Uint8Array,
  at: number,
  count: number,
): { list: Uint8Array[]; at: number } | null {
  const list: Uint8Array[] = []
  for (let n = 0; n < count; n++) {
    if (at + 2 > d.length) return null
    const len = u16(d, at)
    if (at + 2 + len > d.length) return null
    list.push(d.slice(at + 2, at + 2 + len))
    at += 2 + len
  }
  return { list, at }
}

/** Read an `avcC` body. `null` when it is not version 1 or is cut short. */
export function readAvcC(record: Uint8Array): AvcCodecConfig | null {
  if (record.length < 7 || record[0] !== 1) return null
  const sps = units(record, 6, record[5]! & 0x1f)
  if (sps === null || sps.at >= record.length) return null
  const pps = units(record, sps.at + 1, record[sps.at]!)
  if (pps === null) return null
  return {
    codec: 'h264',
    profile: record[1]!,
    compatibility: record[2]!,
    level: record[3]!,
    lengthSize: (record[4]! & 0x03) + 1,
    sps: sps.list,
    pps: pps.list,
  }
}

/** Read an `hvcC` body. `null` when it is not version 1 or is cut short. */
export function readHvcC(record: Uint8Array): HevcCodecConfig | null {
  if (record.length < 23 || record[0] !== 1) return null
  const arrays: HevcCodecConfig['arrays'] = []
  let at = 23
  for (let a = 0; a < record[22]!; a++) {
    if (at + 3 > record.length) return null
    const nalType = record[at]! & 0x3f
    const read = units(record, at + 3, u16(record, at + 1))
    if (read === null) return null
    arrays.push({ nalType, nalus: read.list })
    at = read.at
  }
  return { codec: 'h265', lengthSize: (record[21]! & 0x03) + 1, arrays }
}

/** Read an `av1C` body: marker(1) version(7) must be 1 and 1; configOBUs follow the 4 fixed bytes. */
export function readAv1C(record: Uint8Array): Av1CodecConfig | null {
  if (record.length < 4 || record[0] !== 0x81) return null
  const configObus = record.slice(4)
  const { obus } = walkObus(configObus)
  const seq = obus.find((o) => o.obuType === OBU_SEQUENCE_HEADER && !o.truncated)
  return {
    codec: 'av1',
    configObus,
    sequenceHeader: seq ? readSequenceHeader(configObus, seq) : null,
  }
}

const READERS = new Map<string, (record: Uint8Array) => VideoCodecConfig | null>([
  ['avcC', readAvcC],
  ['hvcC', readHvcC],
  ['av1C', readAv1C],
])

/** The first `avcC`, `hvcC` or `av1C` among a visual sample entry's child boxes, read */
export function readCodecConfigBox(
  data: Uint8Array,
  boxes: { type: string; body: number; end: number }[],
): VideoCodecConfig | null {
  const box = boxes.find((b) => READERS.has(b.type))
  return box ? READERS.get(box.type)!(data.subarray(box.body, box.end)) : null
}
