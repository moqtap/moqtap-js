import { describe, expect, it } from 'vitest'
import {
  classifyVariant,
  detectMediaInfo,
  fragmentTrackIds,
  isCmafBrand,
  parseBoxes,
  parseInitSegment,
  readBrands,
  scanAndDetectMedia,
} from '../bmff'

// ─── Fixture builders ────────────────────────────────────────────────
// Fixtures are built from the field layouts in ISO/IEC 14496-12.

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

function u32(n: number): Uint8Array {
  return new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff])
}

function u64(n: number): Uint8Array {
  return concat(u32(Math.floor(n / 2 ** 32)), u32(n >>> 0))
}

function ascii(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

function box(type: string, ...body: Uint8Array[]): Uint8Array {
  const payload = concat(...body)
  return concat(u32(8 + payload.length), ascii(type), payload)
}

/** A FullBox: version(1) flags(3) then the body */
function fullBox(type: string, version: number, ...body: Uint8Array[]): Uint8Array {
  return box(type, new Uint8Array([version, 0, 0, 0]), ...body)
}

function brandsBox(type: 'ftyp' | 'styp', major: string, compatible: string[]): Uint8Array {
  return box(type, ascii(major), u32(0), ...compatible.map(ascii))
}

const mfhd = fullBox('mfhd', 0, u32(1))
const mdat = box('mdat', new Uint8Array([1, 2, 3, 4]))

function moof(...trackIds: number[]): Uint8Array {
  return box(
    'moof',
    mfhd,
    ...trackIds.map((id) =>
      box('traf', fullBox('tfhd', 0, u32(id)), fullBox('tfdt', 1, u64(90000))),
    ),
  )
}

interface TrakSpec {
  trackId: number
  handler: string
  sampleEntry: string
  timescale: number
  version?: 0 | 1
}

function trak({ trackId, handler, sampleEntry, timescale, version = 0 }: TrakSpec): Uint8Array {
  // tkhd/mdhd: creation and modification times are 4 bytes in v0, 8 in v1
  const times = version === 1 ? concat(u64(0), u64(0)) : concat(u32(0), u32(0))
  const tkhd = fullBox('tkhd', version, times, u32(trackId), u32(0), new Uint8Array(60))
  const mdhd = fullBox('mdhd', version, times, u32(timescale), u32(0), u32(0))
  const hdlr = fullBox('hdlr', 0, u32(0), ascii(handler), new Uint8Array(12), ascii('h\0'))
  const entry = box(sampleEntry, new Uint8Array(6), new Uint8Array([0, 1]))
  const stsd = fullBox('stsd', 0, u32(1), entry)
  const stbl = box('stbl', stsd, fullBox('stts', 0, u32(0)))
  const minf = box('minf', box('vmhd', new Uint8Array(12)), stbl)
  return box('trak', tkhd, box('mdia', mdhd, hdlr, minf))
}

function moov(...traks: TrakSpec[]): Uint8Array {
  return box('moov', fullBox('mvhd', 0, new Uint8Array(96)), ...traks.map(trak))
}

const VIDEO: TrakSpec = { trackId: 1, handler: 'vide', sampleEntry: 'avc1', timescale: 90000 }
const AUDIO: TrakSpec = { trackId: 2, handler: 'soun', sampleEntry: 'mp4a', timescale: 48000 }

// ─── parseBoxes ──────────────────────────────────────────────────────

describe('parseBoxes', () => {
  it('lists top-level boxes with offsets and sizes', () => {
    const styp = brandsBox('styp', 'msdh', ['msdh', 'msix'])
    const data = concat(styp, moof(1), mdat)
    const boxes = parseBoxes(data)
    expect(boxes.map((b) => b.type)).toEqual(['styp', 'moof', 'mdat'])
    expect(boxes[0]).toEqual({ type: 'styp', offset: 0, size: styp.length })
    expect(boxes[2]!.offset).toBe(data.length - mdat.length)
  })

  it('treats size 0 as running to the end of the data, and stops there', () => {
    const data = concat(box('moof', mfhd), u32(0), ascii('mdat'), new Uint8Array(10))
    const boxes = parseBoxes(data)
    expect(boxes.map((b) => b.type)).toEqual(['moof', 'mdat'])
    expect(boxes[1]!.size).toBe(18)
  })

  it('reads a 64-bit largesize', () => {
    const big = concat(u32(1), ascii('mdat'), u64(20), new Uint8Array(4))
    const data = concat(big, box('free'))
    expect(parseBoxes(data)).toEqual([
      { type: 'mdat', offset: 0, size: 20 },
      { type: 'free', offset: 20, size: 8 },
    ])
  })

  it('stops at a 64-bit largesize smaller than its own 16-byte header', () => {
    expect(parseBoxes(concat(u32(1), ascii('mdat'), u64(0), new Uint8Array(4)))).toEqual([])
    expect(parseBoxes(concat(u32(1), ascii('mdat'), u64(15), new Uint8Array(4)))).toEqual([])
  })

  it('stops at an unknown type, a non-printable type or an impossible size', () => {
    expect(parseBoxes(concat(box('moof', mfhd), box('zzzz')))).toHaveLength(1)
    expect(parseBoxes(concat(u32(8), new Uint8Array([0x6d, 0x6f, 0x6f, 0x01])))).toEqual([])
    expect(parseBoxes(concat(u32(4), ascii('mdat')))).toEqual([])
  })

  it('keeps a declared size that runs past truncated data', () => {
    const cut = moof(1).subarray(0, 20)
    expect(parseBoxes(cut)).toEqual([{ type: 'moof', offset: 0, size: moof(1).length }])
  })
})

// ─── Brands and classification ───────────────────────────────────────

describe('readBrands', () => {
  it('reads the major brand, minor version and compatible brands', () => {
    const data = box('ftyp', ascii('iso6'), u32(512), ascii('iso6'), ascii('cmfc'))
    expect(readBrands(data, parseBoxes(data)[0]!)).toEqual({
      major: 'iso6',
      minorVersion: 512,
      compatible: ['iso6', 'cmfc'],
    })
  })

  it('is null for a box too short to hold a major brand and version', () => {
    const data = box('styp', ascii('cmfc'))
    expect(readBrands(data, parseBoxes(data)[0]!)).toBeNull()
  })
})

describe('isCmafBrand', () => {
  it('accepts exactly the five CMAF brands', () => {
    for (const b of ['cmfc', 'cmf2', 'cmfs', 'cmfl', 'cmff']) expect(isCmafBrand(b)).toBe(true)
    for (const b of ['iso6', 'msdh', 'cmf3', 'CMFC']) expect(isCmafBrand(b)).toBe(false)
  })
})

describe('classifyVariant', () => {
  const classify = (data: Uint8Array) => classifyVariant(parseBoxes(data), data)

  it('is cmaf for a segment whose styp names a CMAF brand', () => {
    expect(classify(concat(brandsBox('styp', 'cmfs', []), moof(1), mdat))).toBe('cmaf')
    expect(classify(concat(brandsBox('styp', 'msdh', ['cmfl']), moof(1), mdat))).toBe('cmaf')
  })

  it('is cmaf for an init segment whose ftyp names a CMAF brand', () => {
    expect(classify(concat(brandsBox('ftyp', 'iso6', ['cmfc']), moov(VIDEO)))).toBe('cmaf')
  })

  it('is cmaf for the second-edition cmf2 header of the CMSF catalog vectors', () => {
    // initData of cmsf/draft00 and draft01 cmaf-track: a 24-byte ftyp with
    // major brand cmf2 and compatible brands cmf2, iso6.
    const header = Uint8Array.from(atob('AAAAGGZ0eXBjbWYyAAAAAGNtZjJpc282'), (c) => c.charCodeAt(0))
    expect(classify(header)).toBe('cmaf')
  })

  it('is fmp4 for styp+moof+mdat without a CMAF brand', () => {
    expect(classify(concat(brandsBox('styp', 'msdh', ['msdh', 'msix']), moof(1), mdat))).toBe(
      'fmp4',
    )
  })

  it('is fmp4 for a bare moof+mdat chunk and a non-CMAF init segment', () => {
    expect(classify(concat(moof(1), mdat))).toBe('fmp4')
    expect(classify(concat(brandsBox('ftyp', 'isom', ['iso6', 'mp41']), moov(VIDEO)))).toBe('fmp4')
  })

  it('does not read brands past a truncated styp', () => {
    const data = brandsBox('styp', 'msdh', ['cmfc']).subarray(0, 16)
    expect(classify(data)).toBe('fmp4')
  })
})

// ─── Detection ───────────────────────────────────────────────────────

describe('detectMediaInfo', () => {
  it('reports the variant and the top-level boxes', () => {
    expect(detectMediaInfo(concat(brandsBox('styp', 'cmfc', []), moof(1), mdat))).toEqual({
      variant: 'cmaf',
      boxes: ['styp', 'moof', 'mdat'],
    })
  })

  it('is null for non-BMFF and short payloads', () => {
    expect(detectMediaInfo(ascii('{"version":1,"tracks":[]}'))).toBeNull()
    expect(detectMediaInfo(new Uint8Array([0, 0, 0, 8]))).toBeNull()
  })
})

describe('scanAndDetectMedia', () => {
  it('finds boxes behind an unknown framing prefix', () => {
    const prefix = new Uint8Array([0x40, 0x05, 0x00, 0x11, 0xfe])
    const data = concat(prefix, brandsBox('styp', 'cmfs', []), moof(1), mdat)
    expect(scanAndDetectMedia(data)).toEqual({
      variant: 'cmaf',
      boxes: ['styp', 'moof', 'mdat'],
    })
  })

  it('gives up past the scan limit', () => {
    const data = concat(new Uint8Array(40).fill(0xff), moof(1), mdat)
    expect(scanAndDetectMedia(data, 16)).toBeNull()
    expect(scanAndDetectMedia(data)).not.toBeNull()
  })

  it('finds boxes behind a prefix of exactly the scan limit', () => {
    const data = concat(new Uint8Array(40).fill(0xff), moof(1), mdat)
    expect(scanAndDetectMedia(data, 40)!.boxes).toEqual(['moof', 'mdat'])
    expect(scanAndDetectMedia(data, 39)).toBeNull()
  })
})

// ─── Fragments ───────────────────────────────────────────────────────

describe('fragmentTrackIds', () => {
  it('reads the track_ID from each traf/tfhd', () => {
    expect(fragmentTrackIds(concat(brandsBox('styp', 'cmfs', []), moof(7), mdat))).toEqual([7])
  })

  it('lists every traf, across every moof, in order', () => {
    expect(fragmentTrackIds(concat(moof(1, 2), mdat, moof(3), mdat))).toEqual([1, 2, 3])
  })

  it('reads track_IDs above 2^31 as unsigned', () => {
    expect(fragmentTrackIds(concat(moof(0xfffffffe), mdat))).toEqual([0xfffffffe])
  })

  it('finds tfhd wherever it sits among the traf children', () => {
    const traf = box('traf', fullBox('tfdt', 0, u32(0)), fullBox('tfhd', 0, u32(9)))
    expect(fragmentTrackIds(box('moof', mfhd, traf))).toEqual([9])
  })

  it('is empty when there is no moof, and skips a tfhd cut short', () => {
    expect(fragmentTrackIds(concat(box('free'), mdat))).toEqual([])
    const data = moof(5)
    // moof(8) mfhd(16) traf header(8) tfhd header(8) version/flags(4) | track_ID
    expect(fragmentTrackIds(data.subarray(0, 8 + 16 + 8 + 8 + 4 + 2))).toEqual([])
    expect(fragmentTrackIds(data.subarray(0, 8 + 16 + 8 + 8 + 4 + 4))).toEqual([5])
  })

  it('ignores a traf outside a moof', () => {
    expect(fragmentTrackIds(box('traf', fullBox('tfhd', 0, u32(1))))).toEqual([])
  })
})

// ─── Init segments ───────────────────────────────────────────────────

const NEW_FIELDS = {
  trex: null,
  encryption: null,
  sampleGroups: [],
  hasEditList: false,
  codecConfig: null,
}

describe('parseInitSegment', () => {
  it('summarises brands and each track', () => {
    const data = concat(brandsBox('ftyp', 'cmfc', ['iso6', 'cmfc']), moov(VIDEO, AUDIO))
    expect(parseInitSegment(data)).toEqual({
      brands: { major: 'cmfc', minorVersion: 0, compatible: ['iso6', 'cmfc'] },
      tracks: [
        {
          trackId: 1,
          handler: 'vide',
          sampleEntry: 'avc1',
          timescale: 90000,
          ...NEW_FIELDS,
          codec: 'avc1',
        },
        {
          trackId: 2,
          handler: 'soun',
          sampleEntry: 'mp4a',
          timescale: 48000,
          ...NEW_FIELDS,
          codec: 'mp4a',
        },
      ],
      pssh: [],
      ambiguousTrackIds: [],
    })
  })

  it('reads tkhd and mdhd version 1 (64-bit times)', () => {
    const data = moov({ ...VIDEO, trackId: 3, timescale: 1000, version: 1 })
    expect(parseInitSegment(data)!.tracks).toEqual([
      {
        trackId: 3,
        handler: 'vide',
        sampleEntry: 'avc1',
        timescale: 1000,
        ...NEW_FIELDS,
        codec: 'avc1',
      },
    ])
  })

  it('has null brands without an ftyp', () => {
    expect(parseInitSegment(moov(AUDIO))!.brands).toBeNull()
  })

  it('reports an encrypted sample entry as it is written', () => {
    const data = moov({ ...VIDEO, sampleEntry: 'encv' })
    expect(parseInitSegment(data)!.tracks[0]!.sampleEntry).toBe('encv')
  })

  it('leaves fields null when their boxes are missing or cut short', () => {
    // A trak with only a tkhd
    const bare = box('moov', box('trak', fullBox('tkhd', 0, u32(0), u32(0), u32(4))))
    expect(parseInitSegment(bare)!.tracks).toEqual([
      { trackId: 4, handler: null, sampleEntry: null, timescale: null, ...NEW_FIELDS, codec: null },
    ])
    // The whole init segment cut off inside the tkhd, before track_ID
    const ftyp = brandsBox('ftyp', 'iso6', [])
    const cut = concat(ftyp, moov(VIDEO)).subarray(0, ftyp.length + 8 + 108 + 8 + 8 + 4 + 8)
    expect(parseInitSegment(cut)!.tracks).toEqual([
      {
        trackId: null,
        handler: null,
        sampleEntry: null,
        timescale: null,
        ...NEW_FIELDS,
        codec: null,
      },
    ])
  })

  it('is null without a moov', () => {
    expect(parseInitSegment(concat(brandsBox('styp', 'cmfs', []), moof(1), mdat))).toBeNull()
    expect(parseInitSegment(new Uint8Array(0))).toBeNull()
  })
})
