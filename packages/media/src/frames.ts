/**
 * Frame types read from H.264, H.265 and AV1 bitstreams, per sample of a
 * CMAF object, beside what the sample flags claim.
 *
 * Read from the bitstream: H.264 nal_unit_type and slice_type, H.265
 * nal_unit_type, AV1 frame_type and show_frame. Nothing is inferred: what
 * the bytes do not state is `null`.
 */

import type { InitSegment, InitTrack } from './bmff'
import { topLevel } from './box'
import {
  decodeSampleFlags,
  type FirstSample,
  parseCmafObject,
  type SampleFlags,
  type SampleFlagsSource,
  type SampleFlagsUnknown,
  type TrackFragmentHeader,
  type TrackRun,
} from './cmaf'
import type { VideoCodecConfig } from './codecconfig'
import {
  H264_IDR,
  H264_SLICE_TYPES,
  type H264SliceType,
  type H265NalKind,
  h264HasSliceHeader,
  h265NalKind,
  isH264Vcl,
  isH265Irap,
} from './nal'
import {
  type Av1SequenceHeader,
  OBU_FRAME,
  OBU_FRAME_HEADER,
  OBU_SEQUENCE_HEADER,
  readSequenceHeader,
  walkObus,
} from './obu'

export type {
  Av1CodecConfig,
  Av1SequenceHeader,
  AvcCodecConfig,
  HevcCodecConfig,
  VideoCodecConfig,
} from './codecconfig'
export { readAv1C, readAvcC, readHvcC } from './codecconfig'
export type { H264SliceType, H265NalKind } from './nal'

// ─── Types ───────────────────────────────────────────────────────────

/**
 * How to read one sample: NAL units with big-endian length fields of
 * `lengthSize` bytes (as in `avcC` / `hvcC`) or Annex-B start codes; AV1
 * OBUs with the sequence header in effect, if any. Any
 * {@link VideoCodecConfig} is one.
 */
export type FrameConfig =
  | { codec: 'h264' | 'h265'; lengthSize: number }
  | { codec: 'h264' | 'h265'; annexB: true }
  | { codec: 'av1'; sequenceHeader: Av1SequenceHeader | null }

/**
 * - `length-size-invalid`: a NAL length field size other than 1 to 4
 * - `nal-length-zero`: a zero NAL unit length
 * - `nal-past-end`: a NAL unit length runs past the sample (the unit is read as far as it goes)
 * - `partial-length`: bytes after the last NAL unit, too few for a length field
 * - `no-start-code`: Annex-B input that does not begin with a start code
 * - `forbidden-zero-bit`: a NAL unit header with forbidden_zero_bit set
 * - `slice-header-truncated`: a slice ends before its slice_type
 * - `slice-type-invalid`: slice_type above 9
 * - `vcl-types-mixed`: the VCL NAL units of one sample disagree on IDR (H.264) or IRAP (H.265)
 * - `obu-forbidden-bit`, `obu-header-truncated`, `obu-size-past-end`: an OBU that cannot be framed
 * - `no-sequence-header`: frame headers without a sequence header to read them by
 * - `frame-header-truncated`: a frame header OBU ends before its first fields
 */
export type FrameIssue =
  | 'length-size-invalid'
  | 'nal-length-zero'
  | 'nal-past-end'
  | 'partial-length'
  | 'no-start-code'
  | 'forbidden-zero-bit'
  | 'slice-header-truncated'
  | 'slice-type-invalid'
  | 'vcl-types-mixed'
  | 'obu-forbidden-bit'
  | 'obu-header-truncated'
  | 'obu-size-past-end'
  | 'no-sequence-header'
  | 'frame-header-truncated'

interface NalSpan {
  /** Offset of the NAL unit header within the sample */
  offset: number
  /** NAL unit bytes present, header included */
  size: number
  /** The unit runs past the sample */
  truncated: boolean
}

/** One H.264 NAL unit (H.264 7.3.1) */
export interface H264NalUnit extends NalSpan {
  nalUnitType: number
  nalRefIdc: number
  /** slice_type as coded, 0 to 9, for nal_unit_type 1, 2 and 5; else `null` */
  sliceTypeValue: number | null
  /** slice_type mod 5 (Table 7-6) */
  sliceType: H264SliceType | null
}

export interface H264FrameReading {
  codec: 'h264'
  nalUnits: H264NalUnit[]
  /** Every VCL NAL unit is IDR (5): true; none is: false; no VCL unit, or mixed: `null` */
  idr: boolean | null
  /**
   * The slices' type when every slice states the same; `mixed` when two
   * differ; `null` without slices, or when one is unread and the rest agree
   */
  sliceType: H264SliceType | 'mixed' | null
  /** `idr` */
  randomAccess: boolean | null
  issues: FrameIssue[]
}

/** One H.265 NAL unit (H.265 7.3.1.2) */
export interface H265NalUnit extends NalSpan {
  nalUnitType: number
  layerId: number
  /** nuh_temporal_id_plus1 - 1 */
  temporalId: number
  kind: H265NalKind
}

/** slice_type is not read for H.265: it follows PPS-dependent fields. */
export interface H265FrameReading {
  codec: 'h265'
  nalUnits: H265NalUnit[]
  /**
   * Over the VCL NAL units of layer 0: all IRAP (16-21): true; none: false;
   * none present, a reserved type, or mixed: `null`
   */
  irap: boolean | null
  /** The kind every layer-0 VCL NAL unit shares, `mixed` when they differ, `null` without one */
  pictureKind: H265NalKind | 'mixed' | null
  /** `irap` */
  randomAccess: boolean | null
  issues: FrameIssue[]
}

export type Av1FrameType = 'KEY' | 'INTER' | 'INTRA_ONLY' | 'SWITCH'

export interface Av1Obu {
  offset: number
  /** OBU bytes present, header included */
  size: number
  obuType: number
  temporalId: number | null
  spatialId: number | null
  truncated: boolean
}

/**
 * The start of one uncompressed_header (AV1 5.9.2). With show_existing_frame
 * the header names frame `frameToShowMapIdx` and codes neither frame_type nor
 * show_frame, so both are `null`. All fields are `null` without a sequence header.
 */
export interface Av1FrameHeader {
  /** Index into {@link Av1FrameReading.obus} */
  obuIndex: number
  obuType: typeof OBU_FRAME_HEADER | typeof OBU_FRAME
  showExistingFrame: boolean | null
  frameToShowMapIdx: number | null
  frameType: Av1FrameType | null
  showFrame: boolean | null
}

export interface Av1FrameReading {
  codec: 'av1'
  obus: Av1Obu[]
  /** The sequence header in effect after this sample: its own last one, else the config's */
  sequenceHeader: Av1SequenceHeader | null
  /** One per OBU_FRAME_HEADER and OBU_FRAME, in order */
  frameHeaders: Av1FrameHeader[]
  /**
   * A frame header with frame_type KEY and show_frame 1: true; none, and every
   * header read with a known frame type: false; otherwise `null`
   */
  keyFrameShown: boolean | null
  /** `keyFrameShown` */
  randomAccess: boolean | null
  issues: FrameIssue[]
}

export type FrameTypeReading = H264FrameReading | H265FrameReading | Av1FrameReading

// ─── Bits ────────────────────────────────────────────────────────────

/** RBSP of up to `max` bytes from `start`: emulation_prevention_three_byte removed (H.264 7.3.1, 7.4.1) */
function rbsp(d: Uint8Array, start: number, end: number, max: number): Uint8Array {
  const out: number[] = []
  let zeros = 0
  for (let i = start; i < end && out.length < max; i++) {
    const b = d[i]!
    if (zeros >= 2 && b === 0x03) {
      zeros = 0
      continue
    }
    zeros = b === 0 ? zeros + 1 : 0
    out.push(b)
  }
  return Uint8Array.from(out)
}

class Bits {
  private pos = 0
  constructor(private readonly d: Uint8Array) {}

  bit(): number | null {
    if (this.pos >= this.d.length * 8) return null
    const b = (this.d[this.pos >> 3]! >> (7 - (this.pos & 7))) & 1
    this.pos++
    return b
  }

  /** ue(v) (H.264 9.1); `null` when cut short or over 31 leading zeros */
  ue(): number | null {
    let zeros = 0
    for (;;) {
      const b = this.bit()
      if (b === null) return null
      if (b === 1) break
      if (++zeros > 31) return null
    }
    let v = 0
    for (let i = 0; i < zeros; i++) {
      const b = this.bit()
      if (b === null) return null
      v = v * 2 + b
    }
    return 2 ** zeros - 1 + v
  }
}

// ─── NAL unit framing ────────────────────────────────────────────────

function readUint(d: Uint8Array, at: number, size: number): number {
  let v = 0
  for (let k = 0; k < size; k++) v = v * 256 + d[at + k]!
  return v
}

function lengthPrefixed(d: Uint8Array, lengthSize: number, issues: FrameIssue[]): NalSpan[] {
  if (!Number.isInteger(lengthSize) || lengthSize < 1 || lengthSize > 4) {
    issues.push('length-size-invalid')
    return []
  }
  const out: NalSpan[] = []
  let i = 0
  while (i < d.length) {
    if (i + lengthSize > d.length) {
      issues.push('partial-length')
      break
    }
    const length = readUint(d, i, lengthSize)
    const start = i + lengthSize
    if (length === 0) {
      issues.push('nal-length-zero')
      i = start
      continue
    }
    const truncated = start + length > d.length
    out.push({ offset: start, size: Math.min(length, d.length - start), truncated })
    if (truncated) {
      issues.push('nal-past-end')
      break
    }
    i = start + length
  }
  return out
}

/** Annex-B byte stream (H.264 B.2): a NAL unit ends where 00 00 00, 00 00 01 or 00 00 02 begins */
function annexB(d: Uint8Array, issues: FrameIssue[]): NalSpan[] {
  const out: NalSpan[] = []
  let i = 0
  while (i < d.length && d[i] === 0) i++
  if (i < 2 || i >= d.length || d[i] !== 1) {
    issues.push('no-start-code')
    return out
  }
  while (i < d.length) {
    // `i` is at the 01 of a start code
    const start = i + 1
    let end = start
    while (end + 2 < d.length && !(d[end] === 0 && d[end + 1] === 0 && d[end + 2]! <= 2)) end++
    if (end + 2 >= d.length) end = d.length
    if (end > start) out.push({ offset: start, size: end - start, truncated: false })
    i = end
    while (i < d.length && d[i] === 0) i++
    if (i < d.length && d[i] !== 1) break
  }
  return out
}

type NalConfig = Exclude<FrameConfig, { codec: 'av1' }>

function nalSpans(d: Uint8Array, config: NalConfig, issues: FrameIssue[]): NalSpan[] {
  return 'annexB' in config ? annexB(d, issues) : lengthPrefixed(d, config.lengthSize, issues)
}

// ─── H.264 ───────────────────────────────────────────────────────────

/** first_mb_in_slice ue(v) then slice_type ue(v) (H.264 7.3.3); 16 RBSP bytes cover both */
function h264SliceTypeValue(d: Uint8Array, nal: NalSpan, issues: FrameIssue[]): number | null {
  const bits = new Bits(rbsp(d, nal.offset + 1, nal.offset + nal.size, 16))
  if (bits.ue() === null) {
    issues.push('slice-header-truncated')
    return null
  }
  const v = bits.ue()
  if (v === null) {
    issues.push('slice-header-truncated')
    return null
  }
  if (v > 9) {
    issues.push('slice-type-invalid')
    return null
  }
  return v
}

/** The one value all share, `mixed` when two differ, `null` when empty or one is unknown and the rest agree */
function summary<T extends string>(values: (T | null)[]): T | 'mixed' | null {
  const known = values.filter((v): v is T => v !== null)
  if (known.some((v) => v !== known[0])) return 'mixed'
  if (known.length === 0 || known.length < values.length) return null
  return known[0]!
}

/** All true: true; all false: false; empty: null; mixed: null and an issue */
function allOrNone(values: boolean[], issues: FrameIssue[]): boolean | null {
  if (values.length === 0) return null
  if (values.every((v) => v)) return true
  if (values.every((v) => !v)) return false
  issues.push('vcl-types-mixed')
  return null
}

function readH264(d: Uint8Array, config: NalConfig): H264FrameReading {
  const issues: FrameIssue[] = []
  const nalUnits: H264NalUnit[] = []
  for (const span of nalSpans(d, config, issues)) {
    const h = d[span.offset]!
    if ((h & 0x80) !== 0) {
      issues.push('forbidden-zero-bit')
      break
    }
    const nalUnitType = h & 0x1f
    const value = h264HasSliceHeader(nalUnitType) ? h264SliceTypeValue(d, span, issues) : null
    nalUnits.push({
      ...span,
      nalUnitType,
      nalRefIdc: (h >> 5) & 0x03,
      sliceTypeValue: value,
      sliceType: value === null ? null : H264_SLICE_TYPES[value % 5]!,
    })
  }
  const vcl = nalUnits.filter((n) => isH264Vcl(n.nalUnitType))
  const idr = allOrNone(
    vcl.map((n) => n.nalUnitType === H264_IDR),
    issues,
  )
  const slices = nalUnits.filter((n) => h264HasSliceHeader(n.nalUnitType))
  return {
    codec: 'h264',
    nalUnits,
    idr,
    sliceType: summary(slices.map((n) => n.sliceType)),
    randomAccess: idr,
    issues,
  }
}

// ─── H.265 ───────────────────────────────────────────────────────────

function readH265(d: Uint8Array, config: NalConfig): H265FrameReading {
  const issues: FrameIssue[] = []
  const nalUnits: H265NalUnit[] = []
  for (const span of nalSpans(d, config, issues)) {
    if (span.size < 2) {
      issues.push(span.truncated ? 'nal-past-end' : 'partial-length')
      break
    }
    const b0 = d[span.offset]!
    const b1 = d[span.offset + 1]!
    // forbidden_zero_bit(1) nal_unit_type(6) nuh_layer_id(6) nuh_temporal_id_plus1(3)
    if ((b0 & 0x80) !== 0) {
      issues.push('forbidden-zero-bit')
      break
    }
    const nalUnitType = (b0 >> 1) & 0x3f
    nalUnits.push({
      ...span,
      nalUnitType,
      layerId: ((b0 & 0x01) << 5) | (b1 >> 3),
      temporalId: (b1 & 0x07) - 1,
      kind: h265NalKind(nalUnitType),
    })
  }
  const vcl = nalUnits.filter((n) => n.kind !== 'non-vcl' && n.layerId === 0)
  const irap = vcl.some((n) => n.kind === 'reserved-vcl')
    ? null
    : allOrNone(
        vcl.map((n) => isH265Irap(n.nalUnitType)),
        issues,
      )
  return {
    codec: 'h265',
    nalUnits,
    irap,
    pictureKind: summary(vcl.map((n) => n.kind)),
    randomAccess: irap,
    issues,
  }
}

// ─── AV1 ─────────────────────────────────────────────────────────────

const AV1_FRAME_TYPES: readonly Av1FrameType[] = ['KEY', 'INTER', 'INTRA_ONLY', 'SWITCH']

function readAv1(d: Uint8Array, initial: Av1SequenceHeader | null): Av1FrameReading {
  const issues: FrameIssue[] = []
  const walked = walkObus(d)
  if (walked.issue) issues.push(walked.issue)
  let seq = initial
  const frameHeaders: Av1FrameHeader[] = []
  walked.obus.forEach((obu, obuIndex) => {
    if (obu.obuType === OBU_SEQUENCE_HEADER) {
      seq = readSequenceHeader(d, obu) ?? seq
      return
    }
    if (obu.obuType !== OBU_FRAME_HEADER && obu.obuType !== OBU_FRAME) return
    const header: Av1FrameHeader = {
      obuIndex,
      obuType: obu.obuType,
      showExistingFrame: null,
      frameToShowMapIdx: null,
      frameType: null,
      showFrame: null,
    }
    frameHeaders.push(header)
    if (seq === null) {
      if (!issues.includes('no-sequence-header')) issues.push('no-sequence-header')
      return
    }
    if (seq.reducedStillPictureHeader) {
      header.showExistingFrame = false
      header.frameType = 'KEY'
      header.showFrame = true
      return
    }
    if (obu.payloadStart >= obu.payloadEnd) {
      issues.push('frame-header-truncated')
      return
    }
    // show_existing_frame(1), then frame_to_show_map_idx(3) or frame_type(2) show_frame(1)
    const b = d[obu.payloadStart]!
    header.showExistingFrame = b >> 7 === 1
    if (header.showExistingFrame) {
      header.frameToShowMapIdx = (b >> 4) & 0x07
    } else {
      header.frameType = AV1_FRAME_TYPES[(b >> 5) & 0x03]!
      header.showFrame = ((b >> 4) & 1) === 1
    }
  })
  let keyFrameShown: boolean | null = null
  if (frameHeaders.some((h) => h.frameType === 'KEY' && h.showFrame)) keyFrameShown = true
  else if (frameHeaders.length > 0 && frameHeaders.every((h) => h.frameType !== null)) {
    keyFrameShown = false
  }
  return {
    codec: 'av1',
    obus: walked.obus.map((o) => ({
      offset: o.offset,
      size: o.payloadEnd - o.offset,
      obuType: o.obuType,
      temporalId: o.temporalId,
      spatialId: o.spatialId,
      truncated: o.truncated,
    })),
    sequenceHeader: seq,
    frameHeaders,
    keyFrameShown,
    randomAccess: keyFrameShown,
    issues,
  }
}

// ─── One sample ──────────────────────────────────────────────────────

/**
 * Read the frame types of one sample (an access unit, or an AV1 temporal
 * unit). Never throws: framing problems are listed in `issues`.
 */
export function readFrameType(sample: Uint8Array, config: FrameConfig): FrameTypeReading {
  if (config.codec === 'av1') return readAv1(sample, config.sequenceHeader)
  return config.codec === 'h264' ? readH264(sample, config) : readH265(sample, config)
}

// ─── CMAF object ─────────────────────────────────────────────────────

/**
 * Where a sample's bytes are:
 * - `ok`: inside one mdat
 * - `past-mdat`: starts in an mdat and runs past its end (read up to the end)
 * - `past-payload`: starts in an mdat that runs past the payload (read as far as the payload goes)
 * - `outside-mdat`: starts in no mdat
 * - `offset-unknown`: the run's data offset cannot be worked out
 * - `size-unknown`: neither trun, tfhd nor trex gives the size
 */
export type SampleSpan =
  | 'ok'
  | 'past-mdat'
  | 'past-payload'
  | 'outside-mdat'
  | 'offset-unknown'
  | 'size-unknown'

/**
 * Why a sample has no frame reading:
 * - `not-applicable`: the track is not video ('soun', 'text', ...)
 * - `no-init`, `track-not-in-init`, `track-ambiguous`: no codec config to read by
 * - `no-codec-config`: the trak has no `avcC`, `hvcC` or `av1C` that parses
 * - `no-bytes`: the sample's bytes cannot be located (see {@link SampleSpan})
 */
export type FramesAbsent =
  | 'not-applicable'
  | 'no-init'
  | 'track-not-in-init'
  | 'track-ambiguous'
  | 'no-codec-config'
  | 'no-bytes'

export interface SampleFrame {
  /** tfhd track_ID, or `null` without one */
  trackId: number | null
  /** moof index in the object, traf index in the moof, sample index in the traf */
  moof: number
  traf: number
  sample: number
  /** Payload offset of the sample's first byte */
  offset: number | null
  size: number | null
  span: SampleSpan
  flags: SampleFlags | null
  flagsSource: SampleFlagsSource | null
  flagsUnknown: SampleFlagsUnknown | null
  /** `!flags.isNonSync` */
  sync: boolean | null
  /** `flags.dependsOn`: 0 unknown, 1 depends on others, 2 does not */
  dependsOn: number | null
  frames: FrameTypeReading | null
  framesAbsent: FramesAbsent | null
  /** `frames.randomAccess` */
  randomAccess: boolean | null
  /**
   * `false` when the flags say sync but the bitstream is not IDR / IRAP / a
   * shown KEY frame, or say non-sync but it is; `null` when either is unknown.
   * An open-GOP I picture flagged sync therefore disagrees: ISO/IEC 14496-12
   * sync samples are compared to the bitstream's own random access type only.
   */
  agrees: boolean | null
}

export interface ReadSampleFramesOptions {
  /** Read every sample by this, instead of the init segment's codec config */
  config?: FrameConfig
}

export interface SampleFrames {
  /** In decode order; at most 65536 */
  samples: SampleFrame[]
  /** The sum of the trun sample_counts */
  sampleCount: number
  /** Some box is malformed or cut short */
  malformed: boolean
}

const MAX_SAMPLES = 65536

type TrackLookup = InitTrack | 'ambiguous' | undefined

function trackFor(init: InitSegment | null, trackId: number | undefined): TrackLookup {
  if (!init || trackId === undefined) return undefined
  if (init.ambiguousTrackIds.includes(trackId)) return 'ambiguous'
  return init.tracks.find((t) => t.trackId === trackId)
}

/** sample_flags of sample `i` of a run: trun, then tfhd, then trex (ISO/IEC 14496-12 8.8.3.1) */
function flagsAt(
  run: TrackRun,
  i: number,
  header: TrackFragmentHeader | null,
  init: InitSegment | null,
  track: TrackLookup,
): Pick<FirstSample, 'flags' | 'source' | 'unknown'> {
  const known = (v: number, source: SampleFlagsSource) => ({
    flags: decodeSampleFlags(v),
    source,
    unknown: null,
  })
  const unknown = (reason: SampleFlagsUnknown) => ({ flags: null, source: null, unknown: reason })
  if (run.flags & 0x400) {
    const own = run.samples[i]?.flags
    if (i === 0 && run.flags & 0x04) {
      return own === undefined || run.firstSampleFlags === null
        ? unknown('truncated')
        : unknown('conflicting')
    }
    return own === undefined ? unknown('truncated') : known(own, 'trun-sample-flags')
  }
  if (i === 0 && run.flags & 0x04) {
    return run.firstSampleFlags === null
      ? unknown('truncated')
      : known(run.firstSampleFlags, 'trun-first-sample-flags')
  }
  if (header && header.flags & 0x20) {
    return header.defaultSampleFlags === null
      ? unknown('truncated')
      : known(header.defaultSampleFlags, 'tfhd-default')
  }
  if (!init) return unknown('no-init')
  if (track === 'ambiguous') return unknown('track-ambiguous')
  if (!track) return unknown('track-not-in-init')
  if (!track.trex) return unknown('no-trex')
  return known(track.trex.defaultSampleFlags, 'trex-default')
}

function configFor(
  init: InitSegment | null,
  track: TrackLookup,
  opts: ReadSampleFramesOptions,
): FrameConfig | FramesAbsent {
  if (opts.config) return opts.config
  if (!init) return 'no-init'
  if (track === 'ambiguous') return 'track-ambiguous'
  if (!track) return 'track-not-in-init'
  if (track.codecConfig) return track.codecConfig
  if (track.handler !== null && track.handler !== 'vide') return 'not-applicable'
  return 'no-codec-config'
}

/**
 * Read every sample of a CMAF object: its byte span from trun sizes and data
 * offsets (tfhd and trex size defaults, base-data-offset or
 * default-base-is-moof), its sample flags, and its frame types read from the
 * bitstream. `init` is the track's CMAF header; `opts.config` reads without
 * one, or overrides it. Never throws.
 *
 * Within a track, an AV1 sequence header read from a sample applies to the
 * samples after it.
 */
export function readSampleFrames(
  payload: Uint8Array,
  init: InitSegment | null,
  opts: ReadSampleFramesOptions = {},
): SampleFrames {
  const object = parseCmafObject(payload, init)
  const mdats = topLevel(payload).filter((b) => b.type === 'mdat')
  const samples: SampleFrame[] = []
  let sampleCount = 0
  const av1Seq = new Map<number | null, Av1SequenceHeader | null>()

  object.movieFragments.forEach((moof, m) => {
    // Without base-data-offset or default-base-is-moof, a traf after the first
    // starts at the end of the previous traf's data (ISO/IEC 14496-12 8.8.7.1).
    let previousEnd: number | null = moof.offset
    moof.trackFragments.forEach((traf, t) => {
      const header = traf.header
      const trackId = header?.trackId ?? null
      const track = trackFor(init, header?.trackId)
      const trexSize =
        track && track !== 'ambiguous' ? (track.trex?.defaultSampleSize ?? null) : null
      const defaultSize = header && header.flags & 0x10 ? header.defaultSampleSize : trexSize
      let base: number | null
      if (header?.baseDataOffset != null) {
        base =
          header.baseDataOffset <= BigInt(payload.length) ? Number(header.baseDataOffset) : null
      } else if (header?.defaultBaseIsMoof || t === 0) {
        base = moof.offset
      } else {
        base = previousEnd
      }
      const config = configFor(init, track, opts)
      let next: number | null = base
      let index = 0
      traf.runs.forEach((run, r) => {
        sampleCount += run.sampleCount
        // 8.8.8.1: without data_offset, a run follows the previous one, the first starts at the base.
        let at: number | null = r === 0 ? base : next
        if (run.dataOffset !== null) at = base === null ? null : base + run.dataOffset
        for (let i = 0; i < run.sampleCount && samples.length < MAX_SAMPLES; i++, index++) {
          const own = run.samples[i]
          const perSampleSize = (run.flags & 0x200) !== 0
          const size = perSampleSize ? (own?.size ?? null) : defaultSize
          const sample = readOne(payload, mdats, at, size, config, av1Seq, trackId)
          const f = flagsAt(run, i, header, init, track)
          const sync = f.flags ? !f.flags.isNonSync : null
          const randomAccess = sample.frames?.randomAccess ?? null
          samples.push({
            trackId,
            moof: m,
            traf: t,
            sample: index,
            offset: at,
            size,
            span: sample.span,
            flags: f.flags,
            flagsSource: f.source,
            flagsUnknown: f.unknown,
            sync,
            dependsOn: f.flags?.dependsOn ?? null,
            frames: sample.frames,
            framesAbsent: sample.absent,
            randomAccess,
            agrees: sync === null || randomAccess === null ? null : sync === randomAccess,
          })
          at = at === null || size === null ? null : at + size
        }
        next = at
      })
      previousEnd = next
    })
  })

  return { samples, sampleCount, malformed: object.malformed.length > 0 }
}

function readOne(
  payload: Uint8Array,
  mdats: { body: number; end: number; truncated: boolean }[],
  at: number | null,
  size: number | null,
  config: FrameConfig | FramesAbsent,
  av1Seq: Map<number | null, Av1SequenceHeader | null>,
  trackId: number | null,
): { span: SampleSpan; frames: FrameTypeReading | null; absent: FramesAbsent | null } {
  let span: SampleSpan
  let bytes: Uint8Array | null = null
  if (at === null) span = 'offset-unknown'
  else if (size === null) span = 'size-unknown'
  else {
    const mdat = mdats.find((b) => at >= b.body && at < b.end)
    if (!mdat) span = size === 0 && mdats.some((b) => at === b.end) ? 'ok' : 'outside-mdat'
    else {
      span = at + size <= mdat.end ? 'ok' : mdat.truncated ? 'past-payload' : 'past-mdat'
      bytes = payload.subarray(at, Math.min(at + size, mdat.end))
    }
  }
  if (typeof config === 'string') return { span, frames: null, absent: config }
  if (bytes === null) return { span, frames: null, absent: 'no-bytes' }
  if (config.codec !== 'av1') return { span, frames: readFrameType(bytes, config), absent: null }
  const seq = av1Seq.has(trackId) ? av1Seq.get(trackId)! : config.sequenceHeader
  const frames = readAv1(bytes, seq)
  av1Seq.set(trackId, frames.sequenceHeader)
  return { span, frames, absent: null }
}
