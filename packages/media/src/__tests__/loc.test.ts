import { describe, expect, it } from 'vitest'
import {
  analyzeLocPayload,
  decodeAudioLevel,
  decodeFrameMarkingBytes,
  decodeFrameMarkingVarint,
  decodeLocProperties,
  decodeLocTrackProperties,
  decodeVideoConfig,
  describeProfile,
  isTransportObjectProperty,
  isTransportTrackProperty,
  LOC_PROFILES,
  type LocProfile,
  locPropertyTypes,
  possibleProfiles,
  resolveProfile,
  videoCodecFamily,
} from '../loc'

function bytes(hex: string): Uint8Array {
  const parts = hex.trim().split(/\s+/).filter(Boolean)
  return new Uint8Array(parts.map((b) => parseInt(b, 16)))
}

describe('profiles', () => {
  it('lists five profiles', () => {
    expect(LOC_PROFILES).toEqual(['ietf-00/01', 'ietf-02', 'ietf-03', 'ietf-04', 'mzanaty-05'])
  })

  it('describes a profile as plain data', () => {
    const p = describeProfile('ietf-04')
    expect(p.drafts).toEqual(['draft-ietf-moq-loc-04'])
    expect(p.transportReferences).toEqual(['draft-ietf-moq-transport-19'])
    expect(p.properties.find((d) => d.id === 0x10)).toMatchObject({
      name: 'Timestamp',
      encoding: 'varint',
    })
    p.properties.length = 0
    expect(describeProfile('ietf-04').properties.length).toBeGreaterThan(0)
  })

  it('lists both ietf-02 meanings of 0x06', () => {
    const ids = describeProfile('ietf-02').properties.filter((d) => d.id === 0x06)
    expect(ids.map((d) => d.name)).toEqual(['Timestamp', 'Audio Level'])
  })

  it('declares every mzanaty-05 property as length and bytes on an even ID', () => {
    for (const d of describeProfile('mzanaty-05').properties) {
      expect(d.id % 2).toBe(0)
      expect(d.encoding).toBe('declared-bytes')
    }
  })
})

describe('transport object properties', () => {
  it('follows each draft', () => {
    expect(isTransportObjectProperty(0x40n, '12')).toBe(true)
    expect(isTransportObjectProperty(0x40n, '14')).toBe(false)
    expect(isTransportObjectProperty(0x0bn, '13')).toBe(false)
    expect(isTransportObjectProperty(0x0bn, '14')).toBe(true)
    expect(isTransportObjectProperty(0x3cn, '16')).toBe(true)
    expect(isTransportObjectProperty(0x02n, '18')).toBe(false)
    expect(isTransportObjectProperty(0x06n, '18')).toBe(false)
    expect(isTransportObjectProperty(0x02n, '19')).toBe(true)
    expect(isTransportObjectProperty(0x06n, '22')).toBe(true)
    expect(isTransportObjectProperty(0x04n, '22')).toBe(false)
    expect(isTransportObjectProperty(0x02n, '10')).toBe(false)
  })

  it('treats grease types as transport from draft-17', () => {
    expect(isTransportObjectProperty(0x9dn, '17')).toBe(true)
    expect(isTransportObjectProperty(0x9dn + 0x7fn * 3n, '22')).toBe(true)
    expect(isTransportObjectProperty(0x9en, '22')).toBe(false)
    expect(isTransportObjectProperty(0x9dn, '16')).toBe(false)
  })

  it('names the Track properties of each draft', () => {
    expect(isTransportTrackProperty(0x02n, '15')).toBe(false)
    expect(isTransportTrackProperty(0x02n, '16')).toBe(true)
    expect(isTransportTrackProperty(0x30n, '16')).toBe(true)
    expect(isTransportTrackProperty(0x06n, '17')).toBe(false)
    expect(isTransportTrackProperty(0x06n, '18')).toBe(true)
    expect(isTransportTrackProperty(0x9dn, '16')).toBe(false)
    expect(isTransportTrackProperty(0x9dn, '17')).toBe(true)
    for (const type of [0x08n, 0x0dn, 0x0fn]) {
      expect(isTransportTrackProperty(type, '22')).toBe(false)
    }
  })

  it('collects the LOC types of an object, inside Immutable Properties too', () => {
    const props = [
      { type: 0x08n, value: 90000n },
      {
        type: 0x0bn,
        bytes: new Uint8Array(),
        properties: [
          { type: 0x10n, value: 1n },
          { type: 0x3cn, value: 0n },
        ],
      },
      { type: 0x3en, value: 1n },
      { type: 0x08n, value: 90000n },
    ]
    expect(locPropertyTypes(props, '22')).toEqual([
      { type: 0x08n, immutable: false },
      { type: 0x10n, immutable: true },
    ])
    expect(locPropertyTypes(props)).toEqual([
      { type: 0x08n, immutable: false },
      { type: 0x0bn, immutable: false },
      { type: 0x3en, immutable: false },
    ])
  })
})

const top = (...types: bigint[]) => types.map((type) => ({ type, immutable: false }))

describe('possibleProfiles', () => {
  it('keeps the profiles that define every type', () => {
    expect(possibleProfiles(top(0x10n, 0x09n, 0x08n), '22')).toEqual(['ietf-04'])
    expect(possibleProfiles(top(0x04n, 0x0dn), '16')).toEqual(['ietf-00/01', 'ietf-02'])
    expect(possibleProfiles(top(0x0cn, 0x0fn), '18')).toEqual(['ietf-03', 'ietf-04'])
  })

  it('counts the Secure Objects Key ID only inside Immutable Properties', () => {
    expect(possibleProfiles(top(0x02n, 0x08n), '17')).toEqual([])
    expect(possibleProfiles([{ type: 0x02n, immutable: true }, ...top(0x08n)], '17')).toEqual([
      'ietf-02',
      'ietf-03',
      'ietf-04',
    ])
    expect(possibleProfiles(top(0x02n, 0x04n, 0x0dn), '16')).toEqual(['ietf-00/01'])
  })

  it('leaves 0x0A out of the ietf-02 and ietf-04 profiles', () => {
    expect(possibleProfiles(top(0x0an, 0x10n), '19')).toEqual([])
    expect(possibleProfiles(top(0x0an), '18')).toEqual(['ietf-03'])
  })

  it('removes transport-owned types first', () => {
    // 0x06 is SUBGROUP_DELIVERY_TIMEOUT on objects from draft-19
    expect(possibleProfiles(top(0x06n, 0x0cn), '19')).toEqual(['ietf-03', 'ietf-04'])
    expect(possibleProfiles(top(0x06n, 0x0cn), '18')).toEqual(['ietf-03'])
    expect(possibleProfiles(top(0x0bn, 0x10n), '17')).toEqual(['ietf-04', 'mzanaty-05'])
  })

  it('gives no profile for a type none defines', () => {
    expect(possibleProfiles(top(0x0en))).toEqual([])
  })

  it('gives every profile when no type is seen', () => {
    expect(possibleProfiles([])).toEqual([...LOC_PROFILES])
  })
})

describe('resolveProfile', () => {
  it('takes the one possible profile', () => {
    expect(resolveProfile(['ietf-04'])).toEqual({ profile: 'ietf-04' })
  })

  it('reports candidates when several or none are possible', () => {
    expect(resolveProfile(['ietf-03', 'ietf-04'])).toEqual({ candidates: ['ietf-03', 'ietf-04'] })
    expect(resolveProfile([])).toEqual({ candidates: [] })
  })

  it('lets a pin win', () => {
    expect(resolveProfile(['ietf-03', 'ietf-04'], 'ietf-03')).toEqual({ profile: 'ietf-03' })
    expect(resolveProfile([], 'ietf-02')).toEqual({ profile: 'ietf-02' })
  })
})

describe('decodeLocProperties', () => {
  it('decodes under one profile', () => {
    const out = decodeLocProperties(
      [
        { type: 0x08n, value: 90000n },
        { type: 0x10n, value: 123456n },
        { type: 0x09n, bytes: bytes('a0') },
        { type: 0x0cn, value: 0x9en },
      ],
      { profile: 'ietf-04' },
      { transportDraft: '19' },
    )
    expect(out[0]).toMatchObject({
      name: 'Timescale',
      decoded: { kind: 'timescale', unitsPerSecond: 90000n },
    })
    expect(out[1]).toMatchObject({
      name: 'Timestamp',
      decoded: { kind: 'timestamp', value: 123456n, timescales: [90000n] },
    })
    expect(out[2]!.decoded).toMatchObject({
      kind: 'video-frame-marking',
      candidates: [{ octets: 1, startOfFrame: true, independent: true }],
    })
    expect(out[3]!.decoded).toEqual({
      kind: 'audio-level',
      level: 30,
      dBov: -30,
      voiceActivity: true,
    })
  })

  it('takes the Timescale from the track and lists conflicting ones', () => {
    const one = decodeLocProperties(
      [{ type: 0x10n, value: 5n }],
      { profile: 'ietf-04' },
      { trackTimescales: [1000n] },
    )
    expect(one[0]!.decoded).toEqual({ kind: 'timestamp', value: 5n, timescales: [1000n] })
    const two = decodeLocProperties(
      [
        { type: 0x10n, value: 5n },
        { type: 0x08n, value: 90000n },
      ],
      { profile: 'ietf-04' },
      { trackTimescales: [1000n] },
    )
    expect(two[0]!.decoded).toEqual({ kind: 'timestamp', value: 5n, timescales: [1000n, 90000n] })
    const same = decodeLocProperties(
      [
        { type: 0x10n, value: 5n },
        { type: 0x08n, value: 1000n },
      ],
      { profile: 'ietf-04' },
      { trackTimescales: [1000n] },
    )
    expect(same[0]!.decoded).toEqual({ kind: 'timestamp', value: 5n, timescales: [1000n] })
  })

  it('leaves an ID with two meanings in one profile raw', () => {
    const [p] = decodeLocProperties(
      [{ type: 0x06n, value: 7n }],
      { profile: 'ietf-02' },
      { transportDraft: '17' },
    )
    expect(p).toEqual({
      type: 0x06n,
      raw: 7n,
      ambiguous: [{ profile: 'ietf-02', meanings: ['Timestamp', 'Audio Level'] }],
    })
  })

  it('decodes both ietf-03 Timestamp types, 0x06 and 0x0A', () => {
    const out = decodeLocProperties(
      [
        { type: 0x06n, value: 1n },
        { type: 0x0an, value: 2n },
      ],
      { profile: 'ietf-03' },
      { transportDraft: '18' },
    )
    expect(out[0]).toMatchObject({ name: 'Timestamp', decoded: { kind: 'timestamp', value: 1n } })
    expect(out[1]).toMatchObject({ name: 'Timestamp', decoded: { kind: 'timestamp', value: 2n } })
  })

  it('decodes across candidates only where they agree', () => {
    const out = decodeLocProperties(
      [
        { type: 0x08n, value: 48000n },
        { type: 0x0cn, value: 0x7fn },
        { type: 0x06n, value: 3n },
      ],
      { candidates: ['ietf-03', 'ietf-04'] },
      { transportDraft: '18' },
    )
    expect(out[0]!.decoded).toEqual({ kind: 'timescale', unitsPerSecond: 48000n })
    expect(out[1]!.decoded).toEqual({
      kind: 'audio-level',
      level: 127,
      dBov: -127,
      voiceActivity: false,
    })
    expect(out[2]!.decoded).toBeUndefined()
    expect(out[2]!.ambiguous).toEqual([
      { profile: 'ietf-03', meanings: ['Timestamp'] },
      { profile: 'ietf-04', meanings: [] },
    ])
  })

  it('leaves 0x10 raw between ietf-04 and mzanaty-05', () => {
    const [p] = decodeLocProperties([{ type: 0x10n, value: 9n }], {
      candidates: ['ietf-04', 'mzanaty-05'],
    })
    expect(p!.decoded).toBeUndefined()
    expect(p!.ambiguous).toEqual([
      { profile: 'ietf-04', meanings: ['Timestamp'] },
      { profile: 'mzanaty-05', meanings: ['Video Config'] },
    ])
  })

  it('names but never decodes mzanaty-05 values', () => {
    const out = decodeLocProperties(
      [
        { type: 0x02n, value: 1n },
        { type: 0x06n, value: 0x10n },
      ],
      { profile: 'mzanaty-05' },
      { transportDraft: '10' },
    )
    for (const p of out) {
      expect(p.name).toBeDefined()
      expect(p.decoded).toBeUndefined()
      expect(p.uninterpreted).toBe(true)
    }
  })

  it('marks transport properties and reads inside Immutable Properties', () => {
    const out = decodeLocProperties(
      [
        { type: 0x02n, value: 100n },
        { type: 0x0bn, bytes: bytes('10 05'), properties: [{ type: 0x10n, value: 5n }] },
      ],
      { profile: 'ietf-04' },
      { transportDraft: '20' },
    )
    expect(out).toHaveLength(3)
    expect(out[0]).toEqual({ type: 0x02n, raw: 100n, transport: true })
    expect(out[1]).toMatchObject({ type: 0x0bn, transport: true })
    expect(out[2]).toMatchObject({ type: 0x10n, immutable: true, name: 'Timestamp' })
  })

  it('keeps 0x02 and 0x06 as LOC before draft-19', () => {
    const out = decodeLocProperties(
      [
        { type: 0x02n, value: 1_700_000_000_000_000n },
        { type: 0x06n, value: 0x05n },
      ],
      { profile: 'ietf-00/01' },
      { transportDraft: '18' },
    )
    expect(out[0]!.decoded).toEqual({
      kind: 'capture-timestamp',
      microseconds: 1_700_000_000_000_000n,
    })
    expect(out[1]!.decoded).toMatchObject({ kind: 'audio-level', level: 5 })
  })

  it('checks a value against every candidate', () => {
    const candidates = { candidates: ['ietf-00/01', 'ietf-02'] as LocProfile[] }
    const [split] = decodeLocProperties([{ type: 0x04n, value: 1n << 29n }], candidates)
    expect(split).toEqual({
      type: 0x04n,
      raw: 1n << 29n,
      name: 'Video Frame Marking',
      meaning: 'video-frame-marking',
      ambiguous: [
        { profile: 'ietf-00/01', meanings: ['Video Frame Marking'] },
        { profile: 'ietf-02', meanings: ['Video Frame Marking'], error: 'out_of_range' },
      ],
    })
    const reversed = decodeLocProperties([{ type: 0x04n, value: 1n << 29n }], {
      candidates: ['ietf-02', 'ietf-00/01'],
    })
    expect(reversed[0]!.ambiguous?.map((a) => a.profile)).toEqual(['ietf-02', 'ietf-00/01'])
    const [both] = decodeLocProperties([{ type: 0x04n, value: 1n << 30n }], candidates)
    expect(both!.error).toBe('out_of_range')
    const [neither] = decodeLocProperties([{ type: 0x04n, value: 0xe0n }], candidates)
    expect(neither!.decoded?.kind).toBe('video-frame-marking')
  })

  it('reads a top-level 0x02 as no ietf-02 property', () => {
    const [top02, , inner] = decodeLocProperties(
      [
        { type: 0x02n, value: 1n },
        { type: 0x0bn, bytes: bytes('02 01'), properties: [{ type: 0x02n, value: 1n }] },
      ],
      { profile: 'ietf-02' },
      { transportDraft: '17' },
    )
    expect(top02).toEqual({ type: 0x02n, raw: 1n })
    expect(inner).toMatchObject({ immutable: true, meaning: 'secure-objects-key-id' })
  })

  it('gives a top-level 0x02 and 0x06 both readings from draft-19 where a profile defines them', () => {
    const block = [
      { type: 0x02n, value: 1n },
      { type: 0x06n, value: 9n },
    ]
    const one = decodeLocProperties(block, { profile: 'ietf-03' }, { transportDraft: '19' })
    expect(one).toEqual([
      { type: 0x02n, raw: 1n, transport: true },
      {
        type: 0x06n,
        raw: 9n,
        ambiguous: [
          {
            profile: 'ietf-03',
            meanings: ['SUBGROUP_DELIVERY_TIMEOUT (draft-19 Section 12.1)', 'Timestamp'],
          },
        ],
      },
    ])

    const candidates = decodeLocProperties(
      block,
      { candidates: ['ietf-00/01', 'ietf-02', 'ietf-04'] },
      { transportDraft: '21' },
    )
    expect(candidates[0]!.ambiguous).toEqual([
      {
        profile: 'ietf-00/01',
        meanings: ['OBJECT_DELIVERY_TIMEOUT (draft-21 Section 10.2)', 'Capture Timestamp'],
      },
      { profile: 'ietf-02', meanings: ['OBJECT_DELIVERY_TIMEOUT (draft-21 Section 10.2)'] },
      { profile: 'ietf-04', meanings: ['OBJECT_DELIVERY_TIMEOUT (draft-21 Section 10.2)'] },
    ])
    expect(candidates[1]!.ambiguous).toEqual([
      {
        profile: 'ietf-00/01',
        meanings: ['SUBGROUP_DELIVERY_TIMEOUT (draft-21 Section 10.1)', 'Audio Level'],
      },
      {
        profile: 'ietf-02',
        meanings: ['SUBGROUP_DELIVERY_TIMEOUT (draft-21 Section 10.1)', 'Timestamp', 'Audio Level'],
      },
      { profile: 'ietf-04', meanings: ['SUBGROUP_DELIVERY_TIMEOUT (draft-21 Section 10.1)'] },
    ])

    const none = decodeLocProperties(block, { profile: 'ietf-04' }, { transportDraft: '22' })
    expect(none[1]).toEqual({ type: 0x06n, raw: 9n, transport: true })
  })

  it('gives an Immutable 0x02 both readings from draft-19 where a profile has the Key ID', () => {
    const block = [
      { type: 0x02n, value: 1n },
      { type: 0x0bn, bytes: bytes('02 07'), properties: [{ type: 0x02n, value: 7n }] },
    ]
    const [top02, , inner] = decodeLocProperties(
      block,
      { profile: 'ietf-04' },
      { transportDraft: '20' },
    )
    expect(top02).toEqual({ type: 0x02n, raw: 1n, transport: true })
    expect(inner).toEqual({
      type: 0x02n,
      raw: 7n,
      immutable: true,
      ambiguous: [
        {
          profile: 'ietf-04',
          meanings: [
            'OBJECT_DELIVERY_TIMEOUT (draft-20 Section 12.2)',
            'Key ID (Secure Objects type 0x2)',
          ],
        },
      ],
    })

    const candidates = decodeLocProperties(
      block,
      { candidates: ['ietf-00/01', 'ietf-03'] },
      { transportDraft: '22' },
    )
    expect(candidates[2]!.ambiguous).toEqual([
      {
        profile: 'ietf-00/01',
        meanings: ['OBJECT_DELIVERY_TIMEOUT (draft-22 Section 10.2)', 'Capture Timestamp'],
      },
      {
        profile: 'ietf-03',
        meanings: [
          'OBJECT_DELIVERY_TIMEOUT (draft-22 Section 10.2)',
          'Key ID (Secure Objects type 0x2)',
        ],
      },
    ])

    const keyIdOnly = decodeLocProperties(block, { profile: 'ietf-03' }, { transportDraft: '19' })
    expect(keyIdOnly[0]).toEqual({ type: 0x02n, raw: 1n, transport: true })

    const before19 = decodeLocProperties(block, { profile: 'ietf-04' }, { transportDraft: '18' })
    expect(before19[2]).toMatchObject({ immutable: true, meaning: 'secure-objects-key-id' })
  })

  it('leaves an Immutable 0x02 out of the profile from draft-19', () => {
    const types = locPropertyTypes(
      [{ type: 0x0bn, bytes: bytes('02 07'), properties: [{ type: 0x02n, value: 7n }] }],
      '19',
    )
    expect(types).toEqual([])
  })

  it('reads Track-scope LOC properties, inside Immutable Properties too', () => {
    const out = decodeLocTrackProperties(
      [
        { type: 0x02n, value: 5000n },
        { type: 0x08n, value: 90000n },
        {
          type: 0x0bn,
          bytes: bytes('08 64'),
          properties: [{ type: 0x08n, value: 1000n }],
        },
      ],
      { profile: 'ietf-04' },
      { transportDraft: '22' },
    )
    expect(out).toEqual([
      { type: 0x02n, raw: 5000n, transport: true },
      {
        type: 0x08n,
        raw: 90000n,
        name: 'Timescale',
        meaning: 'timescale',
        decoded: { kind: 'timescale', unitsPerSecond: 90000n },
      },
      expect.objectContaining({ type: 0x0bn, transport: true }),
      {
        type: 0x08n,
        raw: 1000n,
        immutable: true,
        name: 'Timescale',
        meaning: 'timescale',
        decoded: { kind: 'timescale', unitsPerSecond: 1000n },
      },
    ])
  })

  it('reads only what the profile defines at Track scope', () => {
    const avcC = bytes('01 42 c0 1e ff e1 00 02 67 42 01 00 01 68')
    const props = [
      { type: 0x0dn, bytes: avcC },
      { type: 0x10n, value: 5n },
    ]
    const ietf04 = decodeLocTrackProperties(
      props,
      { profile: 'ietf-04' },
      {
        transportDraft: '22',
        videoCodec: 'avc1.42C01E',
      },
    )
    expect(ietf04[0]!.decoded).toMatchObject({ kind: 'video-config', config: { lengthSize: 4 } })
    expect(ietf04[1]).toEqual({ type: 0x10n, raw: 5n })

    const ietf02 = decodeLocTrackProperties(props, { profile: 'ietf-02' }, { transportDraft: '17' })
    expect(ietf02[0]).toEqual({ type: 0x0dn, raw: avcC })

    const open = decodeLocTrackProperties(
      [{ type: 0x08n, value: 90000n }],
      { candidates: ['ietf-00/01', 'ietf-04'] },
      { transportDraft: '22' },
    )
    expect(open[0]!.ambiguous).toEqual([
      { profile: 'ietf-00/01', meanings: [] },
      { profile: 'ietf-04', meanings: ['Timescale'] },
    ])
  })

  it('reports values outside what the draft states', () => {
    const none = decodeLocProperties([{ type: 0x0cn, value: 0x100n }], { candidates: [] })
    expect(none).toEqual([{ type: 0x0cn, raw: 0x100n }])

    const ietf04 = decodeLocProperties(
      [
        { type: 0x0cn, value: 0x100n },
        { type: 0x09n, bytes: new Uint8Array() },
        { type: 0x09n, bytes: bytes('e0 00 2a 00 00') },
      ],
      { profile: 'ietf-04' },
    )
    expect(ietf04.map((p) => p.error)).toEqual(['out_of_range', 'invalid_length', 'invalid_length'])
    expect(ietf04.every((p) => p.decoded === undefined)).toBe(true)

    const ietf02 = decodeLocProperties([{ type: 0x04n, value: 1n << 28n }], { profile: 'ietf-02' })
    expect(ietf02[0]!.error).toBe('out_of_range')
    const ietf00 = decodeLocProperties(
      [
        { type: 0x04n, value: 1n << 30n },
        { type: 0x06n, value: 1n << 14n },
      ],
      { profile: 'ietf-00/01' },
    )
    expect(ietf00.map((p) => p.error)).toEqual(['out_of_range', 'out_of_range'])
  })

  it('leaves values without a reading uninterpreted', () => {
    const out = decodeLocProperties(
      [
        { type: 0x04n, value: 1n << 24n },
        { type: 0x06n, value: 0x17fn },
      ],
      { profile: 'ietf-00/01' },
    )
    expect(out.map((p) => p.uninterpreted)).toEqual([true, true])
    const [fm] = decodeLocProperties([{ type: 0x09n, bytes: bytes('e0 00 2a 00') }], {
      profile: 'ietf-03',
    })
    expect(fm).toMatchObject({ name: 'Video Frame Marking', uninterpreted: true })
    expect(fm!.error).toBeUndefined()
  })

  it('decodes Video Config only with a known codec', () => {
    const avcc = bytes('01 64 00 1f ff e1 00 04 67 64 00 1f 01 00 02 68 ee')
    const without = decodeLocProperties([{ type: 0x0dn, bytes: avcc }], { profile: 'ietf-04' })
    expect(without[0]).toMatchObject({ name: 'Video Config' })
    expect(without[0]!.decoded).toBeUndefined()
    expect(without[0]!.uninterpreted).toBeUndefined()
    const vp9 = decodeLocProperties(
      [{ type: 0x0dn, bytes: avcc }],
      { profile: 'ietf-04' },
      { videoCodec: 'vp09.00.10.08' },
    )
    expect(vp9[0]!.decoded).toBeUndefined()
    const avc = decodeLocProperties(
      [{ type: 0x0dn, bytes: avcc }],
      { profile: 'ietf-04' },
      { videoCodec: 'avc1.64001F' },
    )
    expect(avc[0]!.decoded).toEqual({
      kind: 'video-config',
      config: {
        codec: 'h264',
        profile: 0x64,
        compatibility: 0,
        level: 0x1f,
        lengthSize: 4,
        spsCount: 1,
        ppsCount: 1,
      },
    })
    const bad = decodeLocProperties(
      [{ type: 0x0dn, bytes: bytes('02 64') }],
      { profile: 'ietf-04' },
      { videoCodec: 'avc1.64001F' },
    )
    expect(bad[0]).toMatchObject({ name: 'Video Config' })
    expect(bad[0]!.decoded).toBeUndefined()
  })

  it('names Audio Config without decoding it', () => {
    const [p] = decodeLocProperties([{ type: 0x0fn, bytes: bytes('4f 70') }], {
      profile: 'ietf-04',
    })
    expect(p).toMatchObject({ name: 'Audio Config', meaning: 'audio-config' })
    expect(p!.decoded).toBeUndefined()
  })

  it('leaves types no profile defines without a name', () => {
    const [p] = decodeLocProperties([{ type: 0x21n, bytes: bytes('01') }], { profile: 'ietf-04' })
    expect(p).toEqual({ type: 0x21n, raw: bytes('01') })
  })
})

describe('Frame Marking', () => {
  it('reads the 1-, 2- and 3-octet forms from bytes', () => {
    expect(decodeFrameMarkingBytes(bytes('e9'))).toEqual([
      {
        octets: 1,
        startOfFrame: true,
        endOfFrame: true,
        independent: true,
        discardable: false,
        baseLayerSync: true,
        temporalId: 1,
      },
    ])
    expect(decodeFrameMarkingBytes(bytes('10 02'))![0]).toMatchObject({
      octets: 2,
      discardable: true,
      layerId: 2,
    })
    expect(decodeFrameMarkingBytes(bytes('8a 03 ff'))![0]).toMatchObject({
      octets: 3,
      temporalId: 2,
      baseLayerSync: true,
      layerId: 3,
      tl0PicIdx: 255,
    })
  })

  it('refuses lengths RFC 9626 does not define', () => {
    expect(decodeFrameMarkingBytes(new Uint8Array())).toBeNull()
    expect(decodeFrameMarkingBytes(bytes('00 00 00 00'))).toBeNull()
  })

  it('gives every form a varint fits', () => {
    const small = decodeFrameMarkingVarint(0xa0n)!
    expect(small.map((m) => m.octets)).toEqual([1, 2, 3])
    expect(small[0]).toMatchObject({ startOfFrame: true, independent: true })
    expect(small[1]).toMatchObject({ startOfFrame: false, layerId: 0xa0 })
    expect(small[2]).toMatchObject({ layerId: 0, tl0PicIdx: 0xa0 })

    const mid = decodeFrameMarkingVarint(0xa005n)!
    expect(mid.map((m) => m.octets)).toEqual([2, 3])
    expect(mid[0]).toMatchObject({ independent: true, layerId: 5 })
    expect(mid[1]).toMatchObject({ layerId: 0xa0, tl0PicIdx: 5 })

    const big = decodeFrameMarkingVarint(0xa00507n)!
    expect(big).toHaveLength(1)
    expect(big[0]).toMatchObject({ octets: 3, layerId: 5, tl0PicIdx: 7 })

    expect(decodeFrameMarkingVarint(1n << 24n)).toBeNull()
  })
})

describe('Audio Level', () => {
  it('reads V and the level', () => {
    expect(decodeAudioLevel(0n)).toEqual({ level: 0, dBov: 0, voiceActivity: false })
    expect(decodeAudioLevel(0xffn)).toEqual({ level: 127, dBov: -127, voiceActivity: true })
    expect(decodeAudioLevel(0x100n)).toBeNull()
  })
})

describe('Video Config', () => {
  it('maps codec strings', () => {
    expect(videoCodecFamily('avc1.64001F')).toBe('h264')
    expect(videoCodecFamily('avc3.42E01E')).toBe('h264')
    expect(videoCodecFamily('hvc1.1.6.L93.B0')).toBe('h265')
    expect(videoCodecFamily('hev1.1.6.L93.B0')).toBe('h265')
    expect(videoCodecFamily('av01.0.04M.08')).toBeNull()
  })

  it('reads an avcC', () => {
    const cfg = decodeVideoConfig(bytes('01 42 c0 1e fd e1 00 02 67 42 01 00 01 68'), 'avc1.42C01E')
    expect(cfg).toEqual({
      codec: 'h264',
      profile: 0x42,
      compatibility: 0xc0,
      level: 0x1e,
      lengthSize: 2,
      spsCount: 1,
      ppsCount: 1,
    })
  })

  it('refuses a truncated avcC', () => {
    expect(decodeVideoConfig(bytes('01 42 c0 1e ff e1 00 09 67'), 'avc1.42C01E')).toBeNull()
    expect(decodeVideoConfig(bytes('01 42 c0 1e ff e0'), 'avc1.42C01E')).toBeNull()
  })

  it('reads an hvcC', () => {
    const header = bytes(`
      01 21 60 00 00 00 90 00 00 00 00 00 5d f0 00 fc fd f8 f8 00 00 0f 03
    `)
    const arrays = bytes(`
      a0 00 01 00 02 40 01
      a1 00 01 00 02 42 01
      a2 00 02 00 01 44 00 01 44
    `)
    const cfg = decodeVideoConfig(new Uint8Array([...header, ...arrays]), 'hvc1.1.6.L93.B0')
    expect(cfg).toEqual({
      codec: 'h265',
      profileSpace: 0,
      tier: 1,
      profile: 1,
      level: 0x5d,
      lengthSize: 4,
      arrays: [
        { nalType: 32, count: 1 },
        { nalType: 33, count: 1 },
        { nalType: 34, count: 2 },
      ],
    })
    expect(decodeVideoConfig(header, 'hvc1.1.6.L93.B0')).toBeNull()
  })
})

describe('analyzeLocPayload', () => {
  const SPS = '67 64 00 1f ac'
  const PPS = '68 ee 3c 80'
  const IDR = '65 88 84 00 33'
  const P = '41 9a 02 0c'

  it('reads 4-byte start codes', () => {
    const payload = bytes(`00 00 00 01 ${SPS} 00 00 00 01 ${PPS} 00 00 00 01 ${IDR}`)
    expect(analyzeLocPayload(payload, 'h264')).toEqual({
      framing: 'start-code',
      nalTypes: [7, 8, 5],
      keyframe: true,
    })
  })

  it('reads 4-byte lengths', () => {
    const payload = bytes(`00 00 00 04 ${P} 00 00 00 05 ${IDR}`)
    expect(analyzeLocPayload(payload, 'h264')).toEqual({
      framing: 'length-prefixed',
      lengthSize: 4,
      nalTypes: [1, 5],
      keyframe: true,
    })
  })

  it('reads the length size from the Video Config', () => {
    const config = decodeVideoConfig(
      bytes('01 42 c0 1e fd e1 00 02 67 42 01 00 01 68'),
      'avc1.42C01E',
    )!
    expect(analyzeLocPayload(bytes(`00 04 ${P}`), 'h264', config)).toEqual({
      framing: 'length-prefixed',
      lengthSize: 2,
      nalTypes: [1],
      keyframe: false,
    })
    expect(analyzeLocPayload(bytes(`00 04 ${P}`), 'h264')).toBeNull()
  })

  it('switches to start codes at a length of 1', () => {
    const payload = bytes(`00 00 00 04 ${P} 00 00 00 01 ${IDR}`)
    expect(analyzeLocPayload(payload, 'h264')).toEqual({
      framing: 'mixed',
      lengthSize: 4,
      nalTypes: [1, 5],
      keyframe: true,
    })
  })

  it('reads and marks 3-byte start codes, with or without a Video Config', () => {
    const payload = bytes(`00 00 01 ${SPS} 00 00 01 ${PPS}`)
    const framing = {
      framing: 'start-code',
      threeByteStartCodes: true,
      nalTypes: [7, 8],
      keyframe: false,
    }
    expect(analyzeLocPayload(payload, 'h264')).toEqual(framing)
    const config = decodeVideoConfig(
      bytes('01 64 00 1f ff e1 00 01 67 01 00 01 68'),
      'avc1.64001F',
    )!
    expect(analyzeLocPayload(payload, 'h264', config)).toEqual(framing)
    expect(analyzeLocPayload(payload, 'h264', { lengthSize: 2 })).toEqual(framing)
  })

  it('marks 3-byte start codes after a switch from lengths', () => {
    const payload = bytes(`00 00 00 04 ${P} 00 00 00 01 ${SPS} 00 00 01 ${IDR}`)
    expect(analyzeLocPayload(payload, 'h264')).toEqual({
      framing: 'mixed',
      lengthSize: 4,
      threeByteStartCodes: true,
      nalTypes: [1, 7, 5],
      keyframe: true,
    })
  })

  it('reports bytes that fit both framings as ambiguous', () => {
    // 00 00 01 65: a 3-byte start code before an IDR, or a length of 0x165.
    const body = Array.from({ length: 0x165 }, (_, k) => (k === 0 ? '41' : '11')).join(' ')
    const payload = bytes(`00 00 01 65 ${body}`)
    const result = analyzeLocPayload(payload, 'h264')
    expect(result).toMatchObject({ framing: 'ambiguous' })
    if (result?.framing !== 'ambiguous') throw new Error('not ambiguous')
    expect(result.candidates).toEqual([
      { framing: 'start-code', threeByteStartCodes: true, nalTypes: [5], keyframe: true },
      { framing: 'length-prefixed', lengthSize: 4, nalTypes: [1], keyframe: false },
    ])
  })

  it('reads H.265 and finds an IRAP', () => {
    const payload = bytes('00 00 00 01 40 01 0c 00 00 00 01 26 01 af 1d')
    expect(analyzeLocPayload(payload, 'h265')).toEqual({
      framing: 'start-code',
      nalTypes: [32, 19],
      keyframe: true,
    })
  })

  it('refuses invalid NAL headers and short payloads', () => {
    expect(analyzeLocPayload(bytes('00 00 00 01 80 00'), 'h264')).toBeNull()
    expect(analyzeLocPayload(bytes('00 00 00 08 41 9a'), 'h264')).toBeNull()
    expect(analyzeLocPayload(bytes('00 00 00 01 40 00'), 'h265')).toBeNull()
    expect(analyzeLocPayload(new Uint8Array(), 'h264')).toBeNull()
  })

  it('ignores trailing zero bytes after a start-code NAL unit', () => {
    const payload = bytes(`00 00 00 01 ${P} 00 00`)
    expect(analyzeLocPayload(payload, 'h264')).toMatchObject({
      framing: 'start-code',
      nalTypes: [1],
    })
  })
})
