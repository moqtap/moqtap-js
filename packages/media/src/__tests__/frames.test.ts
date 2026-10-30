import { describe, expect, it } from 'vitest'
import { parseInitSegment } from '../bmff'
import { type FrameConfig, readFrameType, readSampleFrames } from '../frames'
import {
  box,
  concat,
  fromHex,
  initSegment,
  mfhd,
  NON_SYNC,
  SYNC,
  tfdt,
  tfhd,
  traf,
  trex,
  trun,
  u8,
} from './box-fixtures'
import {
  AAC_OBJECT_HEX,
  AUDIO_INIT_HEX,
  IDR_OBJECT_HEX,
  P_OBJECT_HEX,
  VIDEO_INIT_HEX,
} from './frame-fixtures'

// ─── Assembled bitstreams ────────────────────────────────────────────

/** Bits as a string of 0/1, padded with rbsp_stop_one_bit and zeros */
function rbspBits(bits: string): number[] {
  const all = `${bits}1`.padEnd(Math.ceil((bits.length + 1) / 8) * 8, '0')
  const out: number[] = []
  for (let i = 0; i < all.length; i += 8) out.push(parseInt(all.slice(i, i + 8), 2))
  return out
}

/** ue(v) (H.264 9.1) */
function ue(v: number): string {
  const code = (v + 1).toString(2)
  return '0'.repeat(code.length - 1) + code
}

/** Insert emulation_prevention_three_byte (H.264 7.4.1) */
function addEmulationPrevention(rbsp: number[]): number[] {
  const out: number[] = []
  let zeros = 0
  for (const b of rbsp) {
    if (zeros >= 2 && b <= 3) {
      out.push(3)
      zeros = 0
    }
    out.push(b)
    zeros = b === 0 ? zeros + 1 : 0
  }
  return out
}

/** An H.264 slice NAL unit: header byte, then first_mb_in_slice and slice_type */
function h264Slice(type: number, sliceType: number, firstMb = 0): Uint8Array {
  const refIdc = type === 5 ? 3 : 2
  return u8(
    (refIdc << 5) | type,
    ...addEmulationPrevention(rbspBits(ue(firstMb) + ue(sliceType) + ue(0))),
  )
}

/** Length-prefix each NAL unit with `size` bytes */
function lengthPrefixed(size: number, ...nals: Uint8Array[]): Uint8Array {
  return concat(
    ...nals.map((n) => {
      const len = new Uint8Array(size)
      for (let k = 0; k < size; k++) len[size - 1 - k] = (n.length >>> (8 * k)) & 0xff
      return concat(len, n)
    }),
  )
}

/** An H.265 NAL unit header (layer 0 unless given, temporal id 0) and one payload byte */
function h265Nal(type: number, layerId = 0): Uint8Array {
  return u8((type << 1) | (layerId >> 5), ((layerId & 0x1f) << 3) | 1, 0xaf)
}

function obu(type: number, payload: Uint8Array, extension?: number): Uint8Array {
  const head = extension === undefined ? u8((type << 3) | 0x02) : u8((type << 3) | 0x06, extension)
  return concat(head, u8(payload.length), payload)
}

function seqHeader(reduced: boolean, profile = 0): Uint8Array {
  return obu(1, u8((profile << 5) | (reduced ? 0x18 : 0), 0, 0))
}

/** OBU_FRAME_HEADER (3) or OBU_FRAME (6): show_existing_frame(1) frame_type(2) show_frame(1) */
function frameObu(frameType: number, showFrame: boolean, type = 6): Uint8Array {
  return obu(type, u8((frameType << 5) | (showFrame ? 0x10 : 0), 0x55))
}

const H264_4: FrameConfig = { codec: 'h264', lengthSize: 4 }
const H265_4: FrameConfig = { codec: 'h265', lengthSize: 4 }

// ─── Real recording ──────────────────────────────────────────────────

describe('readSampleFrames on a real H.264 recording', () => {
  const init = parseInitSegment(fromHex(VIDEO_INIT_HEX))!

  it('reads the avcC of the CMAF header', () => {
    const config = init.tracks[0]!.codecConfig
    expect(config).toMatchObject({ codec: 'h264', profile: 0x42, level: 0x28, lengthSize: 4 })
    expect(config?.codec === 'h264' && config.sps.length).toBe(1)
    expect(config?.codec === 'h264' && config.pps.length).toBe(1)
  })

  it('reads an IDR I picture flagged sync', () => {
    const read = readSampleFrames(fromHex(IDR_OBJECT_HEX), init)
    expect(read.sampleCount).toBe(1)
    expect(read.malformed).toBe(false)
    const s = read.samples[0]!
    expect(s).toMatchObject({
      trackId: 1,
      span: 'ok',
      size: 52,
      flagsSource: 'trun-first-sample-flags',
      sync: true,
      dependsOn: 2,
      randomAccess: true,
      agrees: true,
      framesAbsent: null,
    })
    expect(s.frames).toMatchObject({ codec: 'h264', idr: true, sliceType: 'I', issues: [] })
    expect(s.frames?.codec === 'h264' && s.frames.nalUnits).toEqual([
      expect.objectContaining({ nalUnitType: 5, sliceTypeValue: 7, sliceType: 'I', size: 48 }),
    ])
  })

  it('reads a P picture flagged non-sync', () => {
    const s = readSampleFrames(fromHex(P_OBJECT_HEX), init).samples[0]!
    expect(s).toMatchObject({
      flagsSource: 'tfhd-default',
      sync: false,
      dependsOn: 1,
      randomAccess: false,
      agrees: true,
    })
    expect(s.frames).toMatchObject({ idr: false, sliceType: 'P' })
    expect(s.frames?.codec === 'h264' && s.frames.nalUnits[0]).toMatchObject({
      nalUnitType: 1,
      sliceTypeValue: 5,
    })
  })

  it('reads nothing for the init it lacks, or reads by a given config', () => {
    const payload = fromHex(IDR_OBJECT_HEX)
    expect(readSampleFrames(payload, null).samples[0]).toMatchObject({
      frames: null,
      framesAbsent: 'no-init',
      flagsSource: 'trun-first-sample-flags',
      agrees: null,
    })
    const s = readSampleFrames(payload, null, { config: H264_4 }).samples[0]!
    expect(s.frames).toMatchObject({ idr: true, sliceType: 'I' })
  })

  it('reads no frame types for audio', () => {
    const audio = parseInitSegment(fromHex(AUDIO_INIT_HEX))!
    expect(audio.tracks[0]!.codecConfig).toBeNull()
    const s = readSampleFrames(fromHex(AAC_OBJECT_HEX), audio).samples[0]!
    expect(s).toMatchObject({
      span: 'ok',
      frames: null,
      framesAbsent: 'not-applicable',
      sync: true,
      randomAccess: null,
      agrees: null,
    })
  })
})

// ─── H.264 ───────────────────────────────────────────────────────────

describe('readFrameType, H.264', () => {
  it('names every slice type, and mod 5', () => {
    const names = ['P', 'B', 'I', 'SP', 'SI']
    for (let v = 0; v <= 9; v++) {
      const r = readFrameType(lengthPrefixed(4, h264Slice(1, v)), H264_4)
      expect(r).toMatchObject({ sliceType: names[v % 5], idr: false })
    }
  })

  it('reports a B picture and a mixed one', () => {
    const b = lengthPrefixed(4, h264Slice(1, 1), h264Slice(1, 6, 10))
    expect(readFrameType(b, H264_4)).toMatchObject({ sliceType: 'B' })
    const mixed = lengthPrefixed(4, h264Slice(1, 2), h264Slice(1, 0, 10))
    const r = readFrameType(mixed, H264_4)
    expect(r).toMatchObject({ sliceType: 'mixed', idr: false })
    expect(r.codec === 'h264' && r.nalUnits.map((n) => n.sliceType)).toEqual(['I', 'P'])
  })

  it('reads non-IDR I slices as not IDR', () => {
    const r = readFrameType(lengthPrefixed(4, h264Slice(1, 7)), H264_4)
    expect(r).toMatchObject({ idr: false, sliceType: 'I', randomAccess: false })
  })

  it('removes emulation prevention bytes before reading the slice header', () => {
    // first_mb_in_slice 2^22 - 1 codes 22 zero bits, so 00 00 03 follows the header
    const nal = h264Slice(1, 1, 2 ** 22 - 1)
    expect([...nal.subarray(1, 4)]).toEqual([0, 0, 3])
    const r = readFrameType(lengthPrefixed(4, nal), H264_4)
    expect(r).toMatchObject({ sliceType: 'B', issues: [] })
  })

  it('walks 1, 2 and 4 byte length fields', () => {
    for (const size of [1, 2, 4]) {
      const sample = lengthPrefixed(size, u8(0x67, 0x42), h264Slice(5, 2))
      const r = readFrameType(sample, { codec: 'h264', lengthSize: size })
      expect(r.codec === 'h264' && r.nalUnits.map((n) => n.nalUnitType)).toEqual([7, 5])
      expect(r).toMatchObject({ idr: true, sliceType: 'I', issues: [] })
    }
  })

  it('reads Annex-B input', () => {
    const sample = concat(u8(0, 0, 0, 1, 0x09, 0xf0), u8(0, 0, 1), h264Slice(5, 7))
    const r = readFrameType(sample, { codec: 'h264', annexB: true })
    expect(r.codec === 'h264' && r.nalUnits.map((n) => n.nalUnitType)).toEqual([9, 5])
    expect(r).toMatchObject({ idr: true, sliceType: 'I' })
    expect(readFrameType(u8(1, 2, 3), { codec: 'h264', annexB: true }).issues).toEqual([
      'no-start-code',
    ])
  })

  it('flags IDR and non-IDR slices in one sample as mixed', () => {
    const r = readFrameType(lengthPrefixed(4, h264Slice(5, 7), h264Slice(1, 7, 1)), H264_4)
    expect(r).toMatchObject({ idr: null, randomAccess: null, issues: ['vcl-types-mixed'] })
  })

  it('reports truncation and malformed framing as data', () => {
    const whole = lengthPrefixed(4, h264Slice(1, 0))
    const cut = readFrameType(whole.subarray(0, 5), H264_4)
    expect(cut).toMatchObject({ sliceType: null, idr: false })
    expect(cut.issues).toEqual(['nal-past-end', 'slice-header-truncated'])
    expect(readFrameType(u8(0, 0), H264_4).issues).toEqual(['partial-length'])
    expect(readFrameType(u8(0, 0, 0, 0), H264_4).issues).toEqual(['nal-length-zero'])
    expect(readFrameType(lengthPrefixed(4, u8(0x85)), H264_4).issues).toEqual([
      'forbidden-zero-bit',
    ])
    expect(readFrameType(whole, { codec: 'h264', lengthSize: 5 }).issues).toEqual([
      'length-size-invalid',
    ])
    // slice_type 10 is coded 0001011
    const bad = u8(0x41, ...rbspBits(`1${ue(10)}`))
    expect(readFrameType(lengthPrefixed(4, bad), H264_4).issues).toEqual(['slice-type-invalid'])
  })
})

// ─── H.265 ───────────────────────────────────────────────────────────

describe('readFrameType, H.265', () => {
  it.each([
    [16, 'bla'],
    [17, 'bla'],
    [18, 'bla'],
    [19, 'idr'],
    [20, 'idr'],
    [21, 'cra'],
  ])('reads NAL type %i as IRAP (%s)', (type, kind) => {
    const r = readFrameType(lengthPrefixed(4, h265Nal(32), h265Nal(type)), H265_4)
    expect(r).toMatchObject({ irap: true, pictureKind: kind, randomAccess: true, issues: [] })
  })

  it.each([
    [1, 'trail'],
    [3, 'tsa'],
    [5, 'stsa'],
    [7, 'radl'],
    [9, 'rasl'],
  ])('reads NAL type %i as not IRAP (%s)', (type, kind) => {
    const r = readFrameType(lengthPrefixed(4, h265Nal(type)), H265_4)
    expect(r).toMatchObject({ irap: false, pictureKind: kind })
    expect(r).not.toHaveProperty('sliceType')
  })

  it('reads layer and temporal ids, and leaves higher layers out of IRAP', () => {
    const r = readFrameType(lengthPrefixed(2, h265Nal(19), h265Nal(1, 1)), {
      codec: 'h265',
      lengthSize: 2,
    })
    expect(r.codec === 'h265' && r.nalUnits.map((n) => [n.layerId, n.temporalId])).toEqual([
      [0, 0],
      [1, 0],
    ])
    expect(r).toMatchObject({ irap: true })
  })

  it('gives no IRAP reading for reserved or mixed types', () => {
    expect(readFrameType(lengthPrefixed(4, h265Nal(22)), H265_4)).toMatchObject({ irap: null })
    const mixed = readFrameType(lengthPrefixed(4, h265Nal(19), h265Nal(1)), H265_4)
    expect(mixed).toMatchObject({ irap: null, pictureKind: 'mixed', issues: ['vcl-types-mixed'] })
    expect(readFrameType(lengthPrefixed(4, h265Nal(32)), H265_4)).toMatchObject({ irap: null })
  })

  it('reads the hvcC length size from a CMAF header', () => {
    const hvcC = concat(
      u8(1),
      new Uint8Array(20),
      u8(0xfc | 1),
      u8(1),
      u8(32, 0, 1, 0, 3),
      h265Nal(32),
    )
    const entry = box('hvc1', new Uint8Array(78), box('hvcC', hvcC))
    const init = parseInitSegment(initSegment([{ trackId: 1, entry }]))!
    expect(init.tracks[0]!.codecConfig).toEqual({
      codec: 'h265',
      lengthSize: 2,
      arrays: [{ nalType: 32, nalus: [h265Nal(32)] }],
    })
  })
})

// ─── AV1 ─────────────────────────────────────────────────────────────

describe('readFrameType, AV1', () => {
  const seq = { seqProfile: 0, stillPicture: false, reducedStillPictureHeader: false }
  const av1: FrameConfig = { codec: 'av1', sequenceHeader: seq }

  it.each([
    [0, 'KEY'],
    [1, 'INTER'],
    [2, 'INTRA_ONLY'],
    [3, 'SWITCH'],
  ])('reads frame_type %i as %s', (type, name) => {
    const r = readFrameType(frameObu(type, true), av1)
    expect(r.codec === 'av1' && r.frameHeaders).toEqual([
      {
        obuIndex: 0,
        obuType: 6,
        showExistingFrame: false,
        frameToShowMapIdx: null,
        frameType: name,
        showFrame: true,
      },
    ])
    expect(r.randomAccess).toBe(type === 0)
  })

  it('reads show_existing_frame without a frame type', () => {
    const r = readFrameType(obu(3, u8(0x80 | (5 << 4))), av1)
    expect(r).toMatchObject({
      frameHeaders: [{ showExistingFrame: true, frameToShowMapIdx: 5, frameType: null }],
      keyFrameShown: null,
    })
  })

  it('reads every frame header of a temporal unit', () => {
    const tu = concat(frameObu(1, false, 3), obu(4, u8(0)), frameObu(1, true))
    const r = readFrameType(tu, av1)
    expect(r.codec === 'av1' && r.frameHeaders.map((h) => [h.obuIndex, h.showFrame])).toEqual([
      [0, false],
      [2, true],
    ])
    expect(r).toMatchObject({ keyFrameShown: false })
    // a hidden KEY frame is not a shown one
    expect(readFrameType(frameObu(0, false), av1)).toMatchObject({ keyFrameShown: false })
  })

  it('reads every frame as a shown KEY under reduced_still_picture_header', () => {
    const r = readFrameType(concat(seqHeader(true), frameObu(1, false)), {
      codec: 'av1',
      sequenceHeader: null,
    })
    expect(r).toMatchObject({
      sequenceHeader: { reducedStillPictureHeader: true },
      frameHeaders: [{ frameType: 'KEY', showFrame: true, showExistingFrame: false }],
      keyFrameShown: true,
    })
  })

  it('uses an in-band sequence header', () => {
    const r = readFrameType(concat(seqHeader(false), frameObu(0, true)), {
      codec: 'av1',
      sequenceHeader: null,
    })
    expect(r).toMatchObject({ keyFrameShown: true, issues: [] })
  })

  it('reads nothing without a sequence header', () => {
    const r = readFrameType(frameObu(0, true), { codec: 'av1', sequenceHeader: null })
    expect(r).toMatchObject({
      frameHeaders: [{ showExistingFrame: null, frameType: null, showFrame: null }],
      keyFrameShown: null,
      issues: ['no-sequence-header'],
    })
  })

  it('reads OBU extension headers and reports bad framing', () => {
    const r = readFrameType(obu(6, u8(0x10), (2 << 5) | (1 << 3)), av1)
    expect(r.codec === 'av1' && r.obus[0]).toMatchObject({ temporalId: 2, spatialId: 1 })
    expect(readFrameType(u8(0x32, 9, 0x10), av1).issues).toEqual(['obu-size-past-end'])
    expect(readFrameType(u8(0x80), av1).issues).toEqual(['obu-forbidden-bit'])
    expect(readFrameType(u8(0x32), av1).issues).toEqual(['obu-header-truncated'])
    expect(readFrameType(obu(6, u8()), av1).issues).toEqual(['frame-header-truncated'])
  })

  it('reads the av1C of a CMAF header', () => {
    const av1C = concat(u8(0x81, 0, 0, 0), seqHeader(true, 1))
    const entry = box('av01', new Uint8Array(78), box('av1C', av1C))
    const init = parseInitSegment(initSegment([{ trackId: 1, entry }]))!
    expect(init.tracks[0]!.codecConfig).toMatchObject({
      codec: 'av1',
      sequenceHeader: { seqProfile: 1, stillPicture: true, reducedStillPictureHeader: true },
    })
  })
})

// ─── CMAF objects ────────────────────────────────────────────────────

interface Built {
  size?: number
  flags?: number
}

/** moof + mdat of one traf: per-sample size and flags in trun, data_offset to the mdat body */
function object(samples: Uint8Array[], spec: Built[] = [], firstSampleFlags?: number) {
  const build = (dataOffset: number) =>
    box(
      'moof',
      mfhd(1),
      traf(
        tfhd({ trackId: 1, extraFlags: 0x20000 }),
        tfdt(0),
        trun({
          dataOffset,
          ...(firstSampleFlags === undefined ? {} : { firstSampleFlags }),
          fields: [
            'size',
            ...(spec.some((s) => s.flags !== undefined) ? (['flags'] as const) : []),
          ],
          samples: samples.map((s, i) => ({
            size: spec[i]?.size ?? s.length,
            ...(spec[i]?.flags === undefined ? {} : { flags: spec[i]!.flags }),
          })),
        }),
      ),
    )
  const moof = build(build(0).length + 8)
  return concat(moof, box('mdat', ...samples))
}

const AVC_INIT = parseInitSegment(
  initSegment([
    {
      trackId: 1,
      entry: box(
        'avc1',
        new Uint8Array(78),
        box('avcC', u8(1, 0x64, 0, 0x1f, 0xfc | 3, 0xe1, 0, 2, 0x67, 0x64, 1, 0, 1, 0x68)),
      ),
    },
  ]),
)!

describe('readSampleFrames', () => {
  const idr = lengthPrefixed(4, h264Slice(5, 7))
  const p = lengthPrefixed(4, h264Slice(1, 5))
  const i = lengthPrefixed(4, h264Slice(1, 7))

  it('reads every trun sample with its own flags', () => {
    const payload = object([idr, p, p], [{ flags: SYNC }, { flags: NON_SYNC }, { flags: NON_SYNC }])
    const read = readSampleFrames(payload, AVC_INIT)
    expect(read.samples.map((s) => [s.sample, s.sync, s.randomAccess, s.agrees, s.span])).toEqual([
      [0, true, true, true, 'ok'],
      [1, false, false, true, 'ok'],
      [2, false, false, true, 'ok'],
    ])
    expect(read.samples[1]!.offset).toBe(read.samples[0]!.offset! + idr.length)
  })

  it('reports disagreement both ways', () => {
    const payload = object([p, idr], [{ flags: SYNC }, { flags: NON_SYNC }])
    const read = readSampleFrames(payload, AVC_INIT)
    expect(read.samples.map((s) => [s.sync, s.randomAccess, s.agrees])).toEqual([
      [true, false, false],
      [false, true, false],
    ])
  })

  it('reports a sync non-IDR I picture as disagreeing, with the slice type', () => {
    const s = readSampleFrames(object([i], [{ flags: SYNC }]), AVC_INIT).samples[0]!
    expect(s).toMatchObject({ sync: true, randomAccess: false, agrees: false })
    expect(s.frames).toMatchObject({ sliceType: 'I', idr: false })
  })

  it('takes tfhd default sizes and trex default flags', () => {
    const entry = box('avc1', new Uint8Array(78), box('avcC', u8(1, 0x42, 0, 0x1e, 0xff, 0xe0, 0)))
    const init = parseInitSegment(initSegment([{ trackId: 1, entry }], [trex(1, NON_SYNC)]))!
    const build = (dataOffset: number) =>
      box(
        'moof',
        mfhd(1),
        traf(
          tfhd({ trackId: 1, extraFlags: 0x20000, defaultSampleSize: p.length }),
          trun({ dataOffset, samples: [], sampleCount: 2 }),
        ),
      )
    const payload = concat(build(build(0).length + 8), box('mdat', p, p))
    const read = readSampleFrames(payload, init)
    expect(read.samples.map((s) => [s.size, s.span, s.flagsSource, s.agrees])).toEqual([
      [p.length, 'ok', 'trex-default', true],
      [p.length, 'ok', 'trex-default', true],
    ])
  })

  it('reports a sample outside any mdat, and a video track without a codec config', () => {
    const init = parseInitSegment(initSegment([{ trackId: 1 }], [trex(1, SYNC)]))!
    const payload = box(
      'moof',
      mfhd(1),
      traf(
        tfhd({ trackId: 1, extraFlags: 0x20000, defaultSampleSize: 4 }),
        trun({ samples: [], sampleCount: 1 }),
      ),
    )
    expect(readSampleFrames(payload, init).samples[0]).toMatchObject({
      span: 'outside-mdat',
      framesAbsent: 'no-codec-config',
      flagsSource: 'trex-default',
    })
  })

  it('reports conflicting first-sample flags', () => {
    const payload = object([idr], [{ flags: SYNC }], SYNC)
    expect(readSampleFrames(payload, AVC_INIT).samples[0]).toMatchObject({
      flagsUnknown: 'conflicting',
      sync: null,
      randomAccess: true,
      agrees: null,
    })
  })

  it('carries an in-band AV1 sequence header to later samples', () => {
    const entry = box('av01', new Uint8Array(78), box('av1C', u8(0x81, 0, 0, 0)))
    const init = parseInitSegment(initSegment([{ trackId: 1, entry }]))!
    const payload = object(
      [concat(seqHeader(false), frameObu(0, true)), frameObu(1, true)],
      [{ flags: SYNC }, { flags: NON_SYNC }],
    )
    const read = readSampleFrames(payload, init)
    expect(read.samples.map((s) => [s.randomAccess, s.agrees])).toEqual([
      [true, true],
      [false, true],
    ])
  })

  it('reads a sample past the end of a cut payload as far as it goes', () => {
    const long = lengthPrefixed(4, concat(h264Slice(1, 5), new Uint8Array(8).fill(0xaa)))
    const payload = object([idr, long])
    const cut = readSampleFrames(payload.subarray(0, payload.length - 4), AVC_INIT)
    expect(cut.samples.map((s) => s.span)).toEqual(['ok', 'past-payload'])
    expect(cut.samples[1]!.frames).toMatchObject({ sliceType: 'P', issues: ['nal-past-end'] })
    expect(cut.malformed).toBe(true)
  })

  it('never throws on malformed or truncated input', () => {
    const payload = object([idr, p], [{ flags: SYNC }, { flags: NON_SYNC }])
    for (let n = 0; n <= payload.length; n++) {
      expect(() => readSampleFrames(payload.subarray(0, n), AVC_INIT)).not.toThrow()
    }
    const noisy = payload.slice()
    for (let k = 0; k < noisy.length; k += 7) noisy[k] = noisy[k]! ^ 0x5a
    expect(() => readSampleFrames(noisy, AVC_INIT)).not.toThrow()
    const configs: FrameConfig[] = [
      H264_4,
      H265_4,
      { codec: 'h264', annexB: true },
      { codec: 'av1', sequenceHeader: null },
      {
        codec: 'av1',
        sequenceHeader: { seqProfile: 0, stillPicture: false, reducedStillPictureHeader: false },
      },
    ]
    for (let seed = 1; seed < 200; seed++) {
      const junk = new Uint8Array(seed % 40)
      let x = seed
      for (let k = 0; k < junk.length; k++) {
        x = (x * 1103515245 + 12345) >>> 0
        junk[k] = x >>> 24
      }
      for (const c of configs) expect(() => readFrameType(junk, c)).not.toThrow()
    }
  })

  it('reports a size no box gives', () => {
    const payload = concat(
      box(
        'moof',
        mfhd(1),
        traf(tfhd({ trackId: 1, extraFlags: 0x20000 }), trun({ samples: [], sampleCount: 1 })),
      ),
      box('mdat', idr),
    )
    expect(readSampleFrames(payload, null, { config: H264_4 }).samples[0]).toMatchObject({
      span: 'size-unknown',
      framesAbsent: 'no-bytes',
    })
  })
})
