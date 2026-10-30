import { describe, expect, it } from 'vitest'
import { type InitSegment, parseInitSegment } from '../bmff'
import { checkCmafObject, decodeSampleFlags, describeSapReason, parseCmafObject } from '../cmaf'
import {
  ascii,
  box,
  concat,
  fullBox,
  initSegment,
  initTrak,
  MDAT,
  moof,
  NON_SYNC,
  SYNC,
  sbgp,
  sgpdDefault,
  sgpdSap,
  simpleTraf,
  tfdt,
  tfhd,
  traf,
  trex,
  trun,
  u8,
  u32,
} from './box-fixtures'

const INIT = parseInitSegment(initSegment([{ trackId: 1 }], [trex(1, NON_SYNC)]))!
const INIT_SYNC = parseInitSegment(initSegment([{ trackId: 1 }], [trex(1, SYNC)]))!

describe('decodeSampleFlags', () => {
  it('splits the fields', () => {
    // is_leading 3, depends_on 2, is_depended_on 1, redundancy 2, padding 5, non-sync, priority 0x1234
    const value = (3 << 26) | (2 << 24) | (1 << 22) | (2 << 20) | (5 << 17) | (1 << 16) | 0x1234
    expect(decodeSampleFlags(value >>> 0)).toEqual({
      value: value >>> 0,
      isLeading: 3,
      dependsOn: 2,
      isDependedOn: 1,
      hasRedundancy: 2,
      paddingValue: 5,
      isNonSync: true,
      degradationPriority: 0x1234,
    })
  })
})

describe('parseCmafObject', () => {
  it('reads the boxes, the moof and each traf', () => {
    const styp = box('styp', ascii('cmfs'), u32(0), ascii('cmfs'))
    const payload = concat(
      styp,
      box('prft', u8(0, 0, 0, 0)),
      box('emsg', u8(0, 0, 0, 0)),
      moof(
        7,
        traf(
          tfhd({
            trackId: 1,
            defaultSampleDuration: 3000,
            defaultSampleSize: 100,
            extraFlags: 0x20000,
          }),
          tfdt(2 ** 33 + 5),
          trun({
            dataOffset: -8,
            fields: ['duration', 'size', 'flags', 'compositionTimeOffset'],
            version: 1,
            samples: [
              { duration: 3000, size: 10, flags: SYNC, compositionTimeOffset: 3000 },
              { duration: 3000, size: 11, flags: NON_SYNC, compositionTimeOffset: -3000 },
            ],
          }),
        ),
      ),
      MDAT,
    )
    const object = parseCmafObject(payload, INIT)
    expect(object.boxes).toEqual(['styp', 'prft', 'emsg', 'moof', 'mdat'])
    expect(object.styp).toEqual({ major: 'cmfs', minorVersion: 0, compatible: ['cmfs'] })
    expect([object.emsgCount, object.prftCount, object.mdatCount]).toEqual([1, 1, 1])
    expect(object.trackIds).toEqual([1])
    expect(object.truncated).toBe(false)
    expect(object.malformed).toEqual([])

    const [m] = object.movieFragments
    expect(m).toMatchObject({
      sequenceNumber: 7,
      hasMfhd: true,
      mdatFollows: true,
      truncated: false,
    })
    const t = m!.trackFragments[0]!
    expect(t.header).toEqual({
      trackId: 1,
      flags: 0x20018,
      baseDataOffset: null,
      sampleDescriptionIndex: null,
      defaultSampleDuration: 3000,
      defaultSampleSize: 100,
      defaultSampleFlags: null,
      durationIsEmpty: false,
      defaultBaseIsMoof: true,
    })
    expect(t.baseMediaDecodeTime).toBe(2n ** 33n + 5n)
    expect(t.sampleCount).toBe(2)
    expect(t.runs).toEqual([
      {
        version: 1,
        flags: 0xf01,
        sampleCount: 2,
        dataOffset: -8,
        firstSampleFlags: null,
        samples: [
          { duration: 3000, size: 10, flags: SYNC, compositionTimeOffset: 3000 },
          { duration: 3000, size: 11, flags: NON_SYNC, compositionTimeOffset: -3000 },
        ],
      },
    ])
    expect(object.firstSample).toMatchObject({ source: 'trun-sample-flags', sync: true })
    // the second sample is presented first, and its is_leading is 0
    expect(object.sap).toEqual({
      sapType: null,
      candidates: [2, 3],
      reason: 'leading-samples-not-signalled',
    })
  })

  it('reads tfdt version 0, tfhd base_data_offset and sample_description_index', () => {
    const t = traf(
      tfhd({
        trackId: 2,
        baseDataOffset: 1000,
        sampleDescriptionIndex: 1,
        defaultSampleFlags: SYNC,
      }),
      tfdt(90000, 0),
      trun({ samples: [{}], sampleCount: 1 }),
    )
    const tf = parseCmafObject(concat(moof(1, t), MDAT)).movieFragments[0]!.trackFragments[0]!
    expect(tf.header).toMatchObject({ baseDataOffset: 1000n, sampleDescriptionIndex: 1 })
    expect(tf.baseMediaDecodeTime).toBe(90000n)
    expect(tf.firstSample).toMatchObject({ source: 'tfhd-default', sync: true })
  })

  describe('first sample flags', () => {
    const run = (extra: Partial<Parameters<typeof trun>[0]> = {}) =>
      trun({ fields: ['flags'], samples: [{ flags: NON_SYNC }], ...extra })

    it('takes trun first_sample_flags', () => {
      const p = concat(
        moof(1, traf(tfhd({ trackId: 1 }), trun({ firstSampleFlags: SYNC, samples: [{}] }))),
        MDAT,
      )
      expect(parseCmafObject(p).firstSample).toMatchObject({
        source: 'trun-first-sample-flags',
        sync: true,
      })
    })

    it('leaves the flags unknown when the trun has first_sample_flags and per-sample flags', () => {
      const p = concat(moof(1, traf(tfhd({ trackId: 1 }), run({ firstSampleFlags: SYNC }))), MDAT)
      const object = parseCmafObject(p, INIT)
      expect(object.firstSample).toEqual({
        flags: null,
        source: null,
        unknown: 'conflicting',
        conflicting: {
          firstSampleFlags: decodeSampleFlags(SYNC),
          sampleFlags: decodeSampleFlags(NON_SYNC),
        },
        sync: null,
      })
      expect(object.sap).toMatchObject({ reason: 'sample-flags-conflicting', candidates: [] })
    })

    it('takes trun per-sample flags over the tfhd default', () => {
      const p = concat(moof(1, traf(tfhd({ trackId: 1, defaultSampleFlags: SYNC }), run())), MDAT)
      expect(parseCmafObject(p).firstSample).toMatchObject({
        source: 'trun-sample-flags',
        sync: false,
      })
    })

    it('takes the tfhd default over trex', () => {
      const t = traf(tfhd({ trackId: 1, defaultSampleFlags: SYNC }), trun({ samples: [{}] }))
      expect(parseCmafObject(concat(moof(1, t), MDAT), INIT).firstSample).toMatchObject({
        source: 'tfhd-default',
        sync: true,
      })
    })

    it('falls back to the trex default only with the init segment', () => {
      const p = concat(moof(1, simpleTraf(1)), MDAT)
      expect(parseCmafObject(p, INIT_SYNC).firstSample).toMatchObject({
        source: 'trex-default',
        sync: true,
        unknown: null,
      })
      expect(parseCmafObject(p).firstSample).toEqual({
        flags: null,
        source: null,
        unknown: 'no-init',
        sync: null,
      })
    })

    it('says why it is unknown', () => {
      const p = concat(moof(1, simpleTraf(5)), MDAT)
      expect(parseCmafObject(p, INIT).firstSample.unknown).toBe('track-not-in-init')
      const noTrex = parseInitSegment(initSegment([{ trackId: 5 }]))!
      expect(parseCmafObject(p, noTrex).firstSample.unknown).toBe('no-trex')
      const empty = concat(moof(1, traf(tfhd({ trackId: 1 }), trun({ samples: [] }))), MDAT)
      expect(parseCmafObject(empty, INIT).firstSample.unknown).toBe('no-samples')
      // per-sample flags announced, the box cut short before the first sample
      const cut = concat(
        moof(
          1,
          traf(tfhd({ trackId: 1 }), trun({ fields: ['flags'], samples: [], sampleCount: 1 })),
        ),
        MDAT,
      )
      expect(parseCmafObject(cut, INIT).firstSample.unknown).toBe('truncated')
    })

    it('reads the first traf that holds a sample', () => {
      const p = concat(
        moof(1, traf(tfhd({ trackId: 1 }), trun({ samples: [] })), simpleTraf(1, SYNC)),
        MDAT,
      )
      expect(parseCmafObject(p).firstSample.source).toBe('trun-first-sample-flags')
    })
  })

  describe('SAP type', () => {
    it("is stated by a 'sap ' group in the traf", () => {
      const t = simpleTraf(
        1,
        NON_SYNC,
        sgpdSap([{ sapType: 3, dependent: true }]),
        sbgp('sap ', [[1, 0x10001]]),
      )
      expect(parseCmafObject(concat(moof(1, t), MDAT)).sap).toEqual({
        sapType: 3,
        dependentFlag: true,
        source: 'sap-sample-group',
      })
    })

    it("is stated by a 'sap ' group described in the init segment", () => {
      const init = parseInitSegment(
        initSegment(
          [{ trackId: 1, stblExtra: [sgpdSap([{ sapType: 2 }, { sapType: 1 }])] }],
          [trex(1, SYNC)],
        ),
      )!
      const t = simpleTraf(1, undefined, sbgp('sap ', [[1, 2]]))
      const p = concat(moof(1, t), MDAT)
      expect(parseCmafObject(p, init).sap).toEqual({
        sapType: 1,
        dependentFlag: false,
        source: 'sap-sample-group',
      })
      // without the init segment the entry is unknown; the sample is still not decided
      expect(parseCmafObject(p).sap).toMatchObject({ sapType: null, reason: 'no-init' })
    })

    it('gives candidates 1 and 2 for a sync sample', () => {
      const p = concat(moof(1, simpleTraf(1, SYNC)), MDAT)
      expect(parseCmafObject(p).sap).toEqual({
        sapType: null,
        candidates: [1, 2],
        reason: 'sync-sample',
      })
    })

    it('needs the init segment for a sample that is not sync', () => {
      const p = concat(moof(1, simpleTraf(1, NON_SYNC)), MDAT)
      expect(parseCmafObject(p).sap).toEqual({ sapType: null, candidates: [], reason: 'no-init' })
      expect(parseCmafObject(p, INIT).sap.sapType).toBeNull()
      expect(parseCmafObject(p, INIT).sap).toMatchObject({ reason: 'no-sap-signalled' })
    })

    it("names a 'rap ' or 'roll' group, which states no type", () => {
      const rap = concat(moof(1, simpleTraf(1, NON_SYNC, sbgp('rap ', [[1, 1]]))), MDAT)
      expect(parseCmafObject(rap, INIT).sap).toMatchObject({ reason: 'rap-sample-group' })
      const roll = concat(moof(1, simpleTraf(1, NON_SYNC, sbgp('roll', [[1, 1]]))), MDAT)
      expect(parseCmafObject(roll, INIT).sap).toMatchObject({ reason: 'roll-sample-group' })
      const notInGroup = concat(moof(1, simpleTraf(1, NON_SYNC, sbgp('rap ', [[1, 0]]))), MDAT)
      expect(parseCmafObject(notInGroup, INIT).sap).toMatchObject({ reason: 'no-sap-signalled' })
    })

    it('does not read a version 2 default entry', () => {
      const init = parseInitSegment(
        initSegment([{ trackId: 1, stblExtra: [sgpdDefault('sap ', 1)] }], [trex(1, NON_SYNC)]),
      )!
      const p = concat(moof(1, simpleTraf(1)), MDAT)
      expect(parseCmafObject(p, init).sap).toMatchObject({
        reason: 'sample-group-default-not-read',
      })
    })

    it('reports a missing entry, and a SAP_type outside 1 to 6', () => {
      const missing = simpleTraf(
        1,
        NON_SYNC,
        sgpdSap([{ sapType: 1 }]),
        sbgp('sap ', [[1, 0x10002]]),
      )
      expect(parseCmafObject(concat(moof(1, missing), MDAT), INIT).sap).toMatchObject({
        reason: 'sap-sample-group-unresolved',
      })
      const seven = simpleTraf(1, NON_SYNC, sgpdSap([{ sapType: 7 }]), sbgp('sap ', [[1, 0x10001]]))
      expect(parseCmafObject(concat(moof(1, seven), MDAT), INIT).sap).toEqual({
        sapType: null,
        candidates: [],
        reason: 'sap-type-undefined',
        sampleGroupSapType: 7,
      })
    })

    it('is no-samples for an object without samples', () => {
      expect(parseCmafObject(MDAT).sap).toMatchObject({ reason: 'no-samples' })
    })

    it('is unreadable when malformed boxes hide the samples', () => {
      const object = parseCmafObject(u8(0xfc, 0x01, 0x02), INIT)
      expect(object.sap).toMatchObject({ reason: 'unreadable' })
      expect(object.firstSample.unknown).toBe('unreadable')
      expect(object.timing.unknown).toBe('unreadable')
    })

    it('names flags the trun announces but does not hold', () => {
      const cut = concat(
        moof(
          1,
          traf(tfhd({ trackId: 1 }), trun({ fields: ['flags'], samples: [], sampleCount: 1 })),
        ),
        MDAT,
      )
      expect(parseCmafObject(cut, INIT).sap).toMatchObject({ reason: 'sample-flags-truncated' })
    })

    it('decides nothing from a track_ID the header names twice', () => {
      const twoTrex = parseInitSegment(
        initSegment([{ trackId: 1 }], [trex(1, SYNC), trex(1, NON_SYNC)]),
      )!
      expect(twoTrex.ambiguousTrackIds).toEqual([1])
      expect(twoTrex.tracks[0]!.trex).toBeNull()
      const object = parseCmafObject(concat(moof(1, simpleTraf(1)), MDAT), twoTrex)
      expect(object.firstSample.unknown).toBe('track-ambiguous')
      expect(object.sap).toMatchObject({ reason: 'track-ambiguous' })
      expect(object.timing.unknown).toBe('track-ambiguous')
      const twoTraks = parseInitSegment(
        initSegment([{ trackId: 1 }, { trackId: 1, timescale: 1000 }], [trex(1, SYNC)]),
      )!
      expect(twoTraks.ambiguousTrackIds).toEqual([1])
      expect(parseCmafObject(concat(moof(1, simpleTraf(1)), MDAT), twoTraks).timing.unknown).toBe(
        'track-ambiguous',
      )
    })

    it('has words for every reason', () => {
      expect(describeSapReason('no-sap-signalled')).toContain('not a sync sample')
    })
  })

  it('lists malformed boxes', () => {
    const p = concat(moof(1, simpleTraf(1, SYNC)), MDAT)
    const cut = parseCmafObject(p.subarray(0, p.length - 2))
    expect(cut.truncated).toBe(true)
    expect(cut.malformed).toEqual([
      { offset: p.length - MDAT.length, type: 'mdat', reason: 'past-container' },
    ])
    const bad = parseCmafObject(concat(moof(1, simpleTraf(1, SYNC)), u32(3), ascii('free')))
    expect(bad.malformed).toEqual([
      { offset: p.length - MDAT.length, type: null, reason: 'size-below-header' },
    ])
    expect(bad.unreadBytes).toBe(8)
    // the rest of the payload is unread, so whether it holds a chunk is not known
    expect(checkCmafObject(bad, INIT).map((f) => f.code)).toEqual(['malformed-box'])
    expect(parseCmafObject(concat(MDAT, u8(1, 2, 3))).malformed).toEqual([
      { offset: MDAT.length, type: null, reason: 'partial-header' },
    ])
    // A traf claiming more bytes than its moof holds
    const inner = concat(u32(8 + 9999), ascii('traf'), tfhd({ trackId: 1 }))
    const pastParent = parseCmafObject(
      concat(box('moof', concat(u32(16), ascii('mfhd'), u32(0), u32(1)), inner), MDAT),
    )
    expect(pastParent.malformed).toMatchObject([{ type: 'traf', reason: 'past-container' }])
    expect(pastParent.truncated).toBe(false)
    // A trun announcing two samples and holding one
    const short = traf(
      tfhd({ trackId: 1 }),
      trun({ fields: ['duration'], samples: [{ duration: 1 }], sampleCount: 2 }),
    )
    expect(parseCmafObject(concat(moof(1, short), MDAT)).malformed).toMatchObject([
      { type: 'trun', reason: 'fields-past-end' },
    ])
  })
})

describe('timing', () => {
  const timed = (t: Uint8Array, init: InitSegment | null = INIT) =>
    parseCmafObject(concat(moof(1, t), MDAT), init).timing

  it('is tfdt plus the durations before plus the composition offset, at its earliest', () => {
    const t = traf(
      tfhd({ trackId: 1 }),
      tfdt(90000),
      trun({
        version: 1,
        fields: ['duration', 'compositionTimeOffset'],
        samples: [
          { duration: 3000, compositionTimeOffset: 6000 },
          { duration: 3000, compositionTimeOffset: 0 },
          { duration: 3000, compositionTimeOffset: -3000 },
        ],
      }),
    )
    // presentation: 96000, 93000, 93000
    expect(timed(t)).toEqual({ earliestPresentationTime: 93000n, eptMs: [1033], unknown: null })
  })

  it('takes durations from tfhd, then trex', () => {
    const fromTfhd = traf(
      tfhd({ trackId: 1, defaultSampleDuration: 1500 }),
      tfdt(0),
      trun({ fields: ['compositionTimeOffset'], samples: [{ compositionTimeOffset: 3000 }, {}] }),
    )
    expect(timed(fromTfhd).earliestPresentationTime).toBe(1500n)
    const fromTrex = traf(
      tfhd({ trackId: 1 }),
      tfdt(0),
      trun({ fields: ['compositionTimeOffset'], samples: [{ compositionTimeOffset: 6000 }, {}] }),
    )
    expect(timed(fromTrex).earliestPresentationTime).toBe(3000n)
    expect(timed(fromTrex, null)).toEqual({
      earliestPresentationTime: null,
      eptMs: null,
      unknown: 'durations-unknown',
    })
  })

  it('needs no durations when no sample has a composition offset', () => {
    const t = traf(tfhd({ trackId: 1 }), tfdt(9000), trun({ samples: [], sampleCount: 2 }))
    expect(timed(t, null)).toEqual({
      earliestPresentationTime: 9000n,
      eptMs: null,
      unknown: 'no-init',
    })
  })

  it('is unknown for trafs of more than one track', () => {
    const init = parseInitSegment(
      initSegment(
        [{ trackId: 1 }, { trackId: 2, timescale: 1000 }],
        [trex(1, SYNC), trex(2, SYNC)],
      ),
    )!
    const one = traf(tfhd({ trackId: 1 }), tfdt(900000), trun({ samples: [], sampleCount: 1 }))
    const two = traf(tfhd({ trackId: 2 }), tfdt(5000), trun({ samples: [], sampleCount: 1 }))
    const object = parseCmafObject(concat(moof(1, one, two), MDAT), init)
    expect(object.timing.unknown).toBe('multiple-tracks')
    expect(object.sap).toMatchObject({ reason: 'sync-sample', candidates: [1, 2] })
  })

  it('reads a trun without per-sample fields from the defaults', () => {
    const t = traf(
      tfhd({ trackId: 1, defaultSampleDuration: 3000 }),
      tfdt(9000),
      trun({ samples: [], sampleCount: 30 }),
    )
    expect(timed(t).earliestPresentationTime).toBe(9000n)
  })

  it('gives both neighbours at exactly half a millisecond', () => {
    expect(timed(simpleTraf(1, SYNC)).eptMs).toEqual([0])
    const half = traf(tfhd({ trackId: 1 }), tfdt(45), trun({ samples: [], sampleCount: 1 }))
    expect(timed(half).eptMs).toEqual([0, 1])
    const negativeHalf = traf(
      tfhd({ trackId: 1 }),
      tfdt(0),
      trun({
        version: 1,
        fields: ['compositionTimeOffset'],
        samples: [{ compositionTimeOffset: -45 }],
      }),
    )
    expect(timed(negativeHalf)).toEqual({
      earliestPresentationTime: -45n,
      eptMs: [-1, 0],
      unknown: null,
    })
  })

  it('says why it is unknown', () => {
    const noTfdt = traf(tfhd({ trackId: 1 }), trun({ samples: [], sampleCount: 1 }))
    expect(timed(noTfdt).unknown).toBe('no-tfdt')
    expect(timed(simpleTraf(1), null)).toEqual({
      earliestPresentationTime: 0n,
      eptMs: null,
      unknown: 'no-init',
    })
    const withEdits = { ...INIT_SYNC, tracks: [{ ...INIT_SYNC.tracks[0]!, hasEditList: true }] }
    expect(timed(simpleTraf(1), withEdits).unknown).toBe('edit-list')
    expect(parseCmafObject(MDAT).timing.unknown).toBe('no-samples')
  })

  it('makes a sync sample type 2 when a later sample is presented before it', () => {
    const t = traf(
      tfhd({ trackId: 1 }),
      tfdt(0),
      trun({
        firstSampleFlags: SYNC,
        fields: ['duration', 'compositionTimeOffset'],
        samples: [
          { duration: 3000, compositionTimeOffset: 6000 },
          { duration: 3000, compositionTimeOffset: 0 },
        ],
      }),
    )
    expect(parseCmafObject(concat(moof(1, t), MDAT), INIT).sap).toEqual({
      sapType: null,
      candidates: [2, 3],
      reason: 'leading-samples-not-signalled',
    })
    const leading = (isLeading: number) =>
      traf(
        tfhd({ trackId: 1, defaultSampleFlags: (isLeading << 26) | NON_SYNC }),
        tfdt(0),
        trun({
          firstSampleFlags: SYNC,
          fields: ['duration', 'compositionTimeOffset'],
          samples: [
            { duration: 3000, compositionTimeOffset: 6000 },
            { duration: 3000, compositionTimeOffset: 0 },
          ],
        }),
      )
    expect(parseCmafObject(concat(moof(1, leading(3)), MDAT), INIT).sap).toEqual({
      sapType: 2,
      source: 'decodable-leading-samples',
    })
    expect(parseCmafObject(concat(moof(1, leading(1)), MDAT), INIT).sap).toEqual({
      sapType: null,
      candidates: [2, 3],
      reason: 'leading-sample-not-decodable',
    })
    // across chunks, by tfdt
    const second = traf(
      tfhd({ trackId: 1 }),
      tfdt(3000),
      trun({
        version: 1,
        fields: ['compositionTimeOffset'],
        samples: [{ compositionTimeOffset: -3000 }],
      }),
    )
    const first = traf(
      tfhd({ trackId: 1 }),
      tfdt(0),
      trun({
        firstSampleFlags: SYNC,
        fields: ['compositionTimeOffset'],
        samples: [{ compositionTimeOffset: 1 }],
      }),
    )
    const p = concat(moof(1, first), MDAT, moof(2, second), MDAT)
    expect(parseCmafObject(p, INIT).sap).toMatchObject({ candidates: [2, 3] })
    expect(parseCmafObject(p, INIT).movieFragments[0]!.trackFragments[0]!.sap).toMatchObject({
      reason: 'sync-sample',
    })
  })
})

describe('checkCmafObject', () => {
  const codes = (payload: Uint8Array, init = INIT, firstInGroup = false) =>
    checkCmafObject(parseCmafObject(payload, init), init, { firstInGroup }).map((f) => [
      f.kind,
      f.code,
    ])

  it('finds nothing in a conforming object', () => {
    expect(codes(concat(moof(1, simpleTraf(1, SYNC)), MDAT), INIT, true)).toEqual([])
  })

  it('requires a moof followed by an mdat', () => {
    expect(codes(concat(MDAT, moof(1, simpleTraf(1, SYNC))))).toEqual([
      ['violation', 'no-moof-mdat'],
    ])
    expect(codes(concat(box('free'), MDAT))).toEqual([['violation', 'no-moof-mdat']])
  })

  it('requires an mfhd and a traf with a tfhd in each moof', () => {
    const noMfhd = box('moof', simpleTraf(1, SYNC))
    expect(codes(concat(noMfhd, MDAT))).toEqual([['violation', 'no-mfhd']])
    expect(codes(concat(moof(1), MDAT))).toEqual([['violation', 'no-traf']])
    expect(codes(concat(moof(1, traf(tfdt(0))), MDAT))).toEqual([['violation', 'no-tfhd']])
  })

  it('requires a single track', () => {
    const init = parseInitSegment(initSegment([{ trackId: 1 }, { trackId: 2 }], [trex(1, SYNC)]))!
    const p = concat(moof(1, simpleTraf(1, SYNC)), MDAT, moof(2, simpleTraf(2, SYNC)), MDAT)
    const findings = checkCmafObject(parseCmafObject(p, init), init)
    expect(findings).toEqual([
      {
        kind: 'violation',
        code: 'multiple-tracks',
        section: 'CMSF-00 3.3, CMSF-01 3.3',
        path: '',
        message: 'The object carries track_IDs 1, 2; an object carries a single track',
      },
    ])
  })

  it('matches track_ID against the init segment, or says it cannot', () => {
    expect(codes(concat(moof(1, simpleTraf(9, SYNC)), MDAT))).toEqual([
      ['violation', 'track-id-not-in-init'],
    ])
    const object = parseCmafObject(concat(moof(1, simpleTraf(1, SYNC)), MDAT))
    expect(checkCmafObject(object).map((f) => [f.kind, f.code])).toEqual([
      ['not-signalled', 'track-id-unchecked'],
    ])
  })

  it('checks the SAP type a Group starts with only where it is signalled', () => {
    const typed = (sapType: number) =>
      concat(
        moof(1, simpleTraf(1, NON_SYNC, sgpdSap([{ sapType }]), sbgp('sap ', [[1, 0x10001]]))),
        MDAT,
      )
    expect(codes(typed(3), INIT, true)).toEqual([['violation', 'group-start-sap-type']])
    expect(codes(typed(2), INIT, true)).toEqual([])
    expect(codes(typed(3), INIT, false)).toEqual([])
    expect(codes(concat(moof(1, simpleTraf(1, NON_SYNC)), MDAT), INIT, true)).toEqual([
      ['not-signalled', 'group-start-sap-not-signalled'],
    ])
    const [finding] = checkCmafObject(
      parseCmafObject(concat(moof(1, simpleTraf(1, NON_SYNC)), MDAT), INIT),
      INIT,
      {
        firstInGroup: true,
        draft: 'cmsf-01',
      },
    )
    expect(finding).toMatchObject({
      section: 'CMSF-01 3.4, CMSF-01 3.6.1',
      message:
        "The SAP type the Group starts with is not signalled: its first sample is not a sync sample and is in no 'sap ', 'rap ' or 'roll' sample group",
    })
  })

  it('reports a payload cut short as malformed, and checks no further', () => {
    const p = concat(moof(1, simpleTraf(1, SYNC)), MDAT)
    const found = codes(p.subarray(0, 20))
    expect(found.length).toBeGreaterThan(0)
    expect(found.every(([, code]) => code === 'malformed-box')).toBe(true)
  })

  it('accepts styp, prft and emsg, which CMSF does not address', () => {
    const p = concat(
      box('styp', ascii('cmfs'), u32(0)),
      box('prft', u8(0, 0, 0, 0)),
      box('emsg', u8(0, 0, 0, 0)),
      moof(1, simpleTraf(1, SYNC)),
      MDAT,
    )
    expect(codes(p, INIT, true)).toEqual([])
  })
})

describe('parseInitSegment, CMAF header fields', () => {
  const kid = '0123456789abcdef0123456789abcdef'
  const kidBytes = Uint8Array.from(kid.match(/../g)!.map((h) => parseInt(h, 16)))

  it('reads trex defaults by track_ID', () => {
    const init = parseInitSegment(initSegment([{ trackId: 1 }, { trackId: 2 }], [trex(2, SYNC)]))!
    expect(init.tracks.map((t) => t.trex)).toEqual([
      null,
      {
        defaultSampleDescriptionIndex: 1,
        defaultSampleDuration: 3000,
        defaultSampleSize: 0,
        defaultSampleFlags: SYNC,
      },
    ])
  })

  it('reads the protection boxes of an encv entry and the pssh boxes', () => {
    const tenc = fullBox(
      'tenc',
      1,
      0,
      u8(0, 0x19, 1, 0),
      kidBytes,
      u8(16),
      new Uint8Array(16).fill(0xaa),
    )
    const sinf = box(
      'sinf',
      box('frma', ascii('hvc1')),
      fullBox('schm', 0, 0, ascii('cbcs'), u32(0x10000)),
      box('schi', tenc),
    )
    const encv = box('encv', new Uint8Array(78), sinf)
    const systemId = new Uint8Array(16).fill(0x10)
    const pssh = fullBox('pssh', 1, 0, systemId, u32(1), kidBytes, u32(0))
    const init = parseInitSegment(initSegment([{ trackId: 1, entry: encv }], [], pssh))!
    const track = init.tracks[0]!
    expect(track.sampleEntry).toBe('encv')
    expect(track.codec).toBe('hvc1')
    expect(track.encryption).toEqual({
      sinf: true,
      originalFormat: 'hvc1',
      schemeType: 'cbcs',
      schemeVersion: 0x10000,
      tenc: {
        version: 1,
        isProtected: 1,
        perSampleIvSize: 0,
        defaultKid: kid,
        cryptByteBlock: 1,
        skipByteBlock: 9,
        constantIv: 'aa'.repeat(16),
      },
    })
    expect(init.pssh).toEqual([{ systemId: '10'.repeat(16), kids: [kid], dataSize: 0 }])
  })

  it('reads a version 0 tenc in an enca entry, and an entry without sinf', () => {
    const tenc = fullBox('tenc', 0, 0, u8(0, 0, 1, 8), kidBytes)
    const enca = box(
      'enca',
      new Uint8Array(28),
      box('sinf', box('frma', ascii('mp4a')), box('schi', tenc)),
    )
    const init = parseInitSegment(initSegment([{ trackId: 1, handler: 'soun', entry: enca }]))!
    expect(init.tracks[0]!.encryption).toEqual({
      sinf: true,
      originalFormat: 'mp4a',
      schemeType: null,
      schemeVersion: null,
      tenc: {
        version: 0,
        isProtected: 1,
        perSampleIvSize: 8,
        defaultKid: kid,
        cryptByteBlock: null,
        skipByteBlock: null,
        constantIv: null,
      },
    })
    const bare = parseInitSegment(
      initSegment([{ trackId: 1, entry: box('encv', new Uint8Array(78)) }]),
    )!
    expect(bare.tracks[0]!.encryption).toMatchObject({ sinf: false })
    expect(bare.tracks[0]!.codec).toBeNull()
  })

  it('says whether a trak has an edit list', () => {
    const trak = initTrak({ trackId: 1 })
    // trak header(8), then its children; an edts after them
    const withEdts = box('trak', trak.subarray(8), box('edts', fullBox('elst', 0, 0, u32(0))))
    const init = parseInitSegment(box('moov', withEdts))!
    expect(init.tracks[0]!.hasEditList).toBe(true)
    expect(INIT.tracks[0]!.hasEditList).toBe(false)
  })

  it("reads the stbl's sample group descriptions", () => {
    const init = parseInitSegment(
      initSegment([
        {
          trackId: 1,
          stblExtra: [sgpdSap([{ sapType: 2, dependent: true }], 1), sgpdDefault('roll', 1)],
        },
      ]),
    )!
    expect(init.tracks[0]!.sampleGroups).toEqual([
      {
        groupingType: 'sap ',
        version: 1,
        defaultIndex: null,
        entryCount: 1,
        sap: [{ dependentFlag: true, sapType: 2 }],
      },
      { groupingType: 'roll', version: 2, defaultIndex: 1, entryCount: 0, sap: null },
    ])
  })
})
