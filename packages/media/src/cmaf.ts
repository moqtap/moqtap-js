/**
 * CMAF object payloads under CMSF (draft-ietf-moq-cmsf-00 and -01): the
 * chunks an object carries, what their samples signal, and the checks
 * cmsf 3.3 and 3.4 state for an object.
 *
 * Read a track as CMAF only when its catalog `packaging` is `"cmaf"`
 * (cmsf 3.5.1), or the user says so.
 *
 * Box layouts: ISO/IEC 14496-12 8.8 (movie fragments), 8.9 (sample groups).
 */

import type { Brands, InitSegment, InitTrack } from './bmff'
import {
  brandsAt,
  type Child,
  readSbgp,
  readSgpd,
  type SampleGroupDescription,
  type SampleToGroup,
  u32,
  u64,
  versionFlags,
  walk,
} from './box'

export type { SampleToGroup } from './box'

export type CmsfDraft = 'cmsf-00' | 'cmsf-01'

// ─── Types ───────────────────────────────────────────────────────────

/** sample_flags (ISO/IEC 14496-12 8.8.3.1) */
export interface SampleFlags {
  value: number
  /** 0 unknown, 1 leading and depends on an earlier sample, 2 not leading, 3 leading and decodable */
  isLeading: number
  /** 0 unknown, 1 depends on others, 2 does not */
  dependsOn: number
  isDependedOn: number
  hasRedundancy: number
  paddingValue: number
  isNonSync: boolean
  degradationPriority: number
}

/** tfhd (8.8.7). An optional field is `null` when its flag is not set. */
export interface TrackFragmentHeader {
  trackId: number
  flags: number
  baseDataOffset: bigint | null
  sampleDescriptionIndex: number | null
  defaultSampleDuration: number | null
  defaultSampleSize: number | null
  defaultSampleFlags: number | null
  durationIsEmpty: boolean
  defaultBaseIsMoof: boolean
}

/** One trun sample: a field is present when the trun's flags carry it. */
export interface TrackRunSample {
  duration?: number
  size?: number
  flags?: number
  compositionTimeOffset?: number
}

/** trun (8.8.8) */
export interface TrackRun {
  version: number
  flags: number
  sampleCount: number
  dataOffset: number | null
  firstSampleFlags: number | null
  /**
   * The per-sample fields, as many as the box holds: fewer than
   * `sampleCount` when it is cut short, none when the trun carries no
   * per-sample fields
   */
  samples: TrackRunSample[]
}

export type SampleFlagsSource =
  | 'trun-first-sample-flags'
  | 'trun-sample-flags'
  | 'tfhd-default'
  | 'trex-default'

/**
 * Why a first sample's flags are unknown:
 * - `no-samples`: no trun holds a sample
 * - `unreadable`: no sample is found in the boxes read, and some boxes are malformed
 * - `conflicting`: the trun carries both first_sample_flags and per-sample
 *   flags, which ISO/IEC 14496-12 does not rank (`conflicting` holds both)
 * - `no-init`: trun and tfhd give no flags, and no init segment was given
 * - `track-not-in-init`: as `no-init`, and the init segment has no trak for the track_ID
 * - `track-ambiguous`: as `no-init`, and the init segment names the track_ID
 *   in more than one trak or trex
 * - `no-trex`: as `no-init`, and the init segment has no trex for the track_ID
 * - `truncated`: the trun or tfhd announces flags, but ends before them
 */
export type SampleFlagsUnknown =
  | 'no-samples'
  | 'unreadable'
  | 'conflicting'
  | 'no-init'
  | 'track-not-in-init'
  | 'track-ambiguous'
  | 'no-trex'
  | 'truncated'

export interface FirstSample {
  flags: SampleFlags | null
  /** Where the flags come from: trun first_sample_flags, trun per-sample, tfhd default, trex default */
  source: SampleFlagsSource | null
  unknown: SampleFlagsUnknown | null
  /** With `unknown` `conflicting`: the trun's first_sample_flags and the sample's own flags */
  conflicting?: { firstSampleFlags: SampleFlags; sampleFlags: SampleFlags }
  /** `!flags.isNonSync`, or `null` when the flags are unknown */
  sync: boolean | null
}

/**
 * Why a SAP type is not known:
 * - `no-samples`: nothing to read
 * - `unreadable`: no sample is found in the boxes read, and some boxes are malformed
 * - `sync-sample`: a sync sample, a SAP of type 1 or 2, with no `sap ` sample
 *   group saying which and no later sample known to be presented before it
 *   (`candidates` is [1, 2])
 * - `leading-samples-not-signalled`: a sync sample that a later sample is
 *   presented before, which rules out type 1, and not every such sample is
 *   signalled decodable (is_leading 3) (`candidates` is [2, 3])
 * - `leading-sample-not-decodable`: as `leading-samples-not-signalled`, with a
 *   sample of is_leading 1, which points to type 3 against the sync flag
 *   (`candidates` is [2, 3])
 * - `sample-flags-conflicting`, `sample-flags-truncated`: the first sample's
 *   flags are unknown, as {@link SampleFlagsUnknown} `conflicting` and `truncated`
 * - `no-init`: not a sync sample, or its flags unknown, and without the init
 *   segment the track's sample groups and trex defaults are unknown
 * - `track-not-in-init`: the init segment has no trak for the track_ID
 * - `track-ambiguous`: the init segment names the track_ID in more than one trak or trex
 * - `sample-flags-unknown`: the init segment has no trex for the track_ID, and
 *   trun and tfhd give no flags
 * - `rap-sample-group`, `roll-sample-group`: in a `rap ` or `roll` sample
 *   group, which states no SAP type
 * - `no-sap-signalled`: not a sync sample, in no `sap `, `rap ` or `roll` group
 * - `sap-sample-group-unresolved`: mapped to a `sap ` entry that is not there,
 *   or by more than one `sbgp`
 * - `sample-group-default-not-read`: a version 2 `sgpd` of these grouping
 *   types names a default entry, which applies to samples no `sbgp` maps;
 *   it is not read
 * - `sap-type-undefined`: the `sap ` entry gives a SAP_type outside 1 to 6
 *   (`sampleGroupSapType`)
 */
export type SapUnknownReason =
  | 'no-samples'
  | 'unreadable'
  | 'sync-sample'
  | 'leading-samples-not-signalled'
  | 'leading-sample-not-decodable'
  | 'sample-flags-conflicting'
  | 'sample-flags-truncated'
  | 'no-init'
  | 'track-not-in-init'
  | 'track-ambiguous'
  | 'sample-flags-unknown'
  | 'rap-sample-group'
  | 'roll-sample-group'
  | 'no-sap-signalled'
  | 'sap-sample-group-unresolved'
  | 'sample-group-default-not-read'
  | 'sap-type-undefined'

/**
 * The SAP type of a first sample, when the data decides it:
 * - `sap-sample-group`: a `sap ` sample group states it
 * - `decodable-leading-samples`: a sync sample (type 1 or 2) that later
 *   samples of the object are presented before, which type 1 excludes, all
 *   of them signalled decodable (is_leading 3) (ISO/IEC 14496-12 Annex I)
 *
 * Otherwise `null`, with the reason and the types still possible.
 */
export type SapReading =
  | { sapType: number; source: 'sap-sample-group'; dependentFlag: boolean }
  | { sapType: 2; source: 'decodable-leading-samples' }
  | {
      sapType: null
      candidates: number[]
      reason: SapUnknownReason
      sampleGroupSapType?: number
    }

/** One traf (8.8.6) */
export interface TrackFragment {
  offset: number
  /** `null` when the traf has no tfhd, or it ends before track_ID */
  header: TrackFragmentHeader | null
  /** tfdt baseMediaDecodeTime (8.8.12), or `null` without a tfdt */
  baseMediaDecodeTime: bigint | null
  runs: TrackRun[]
  /** The sum of the runs' sample_count */
  sampleCount: number
  sampleGroups: SampleGroupDescription[]
  sampleToGroups: SampleToGroup[]
  firstSample: FirstSample
  /** Within this traf; the object's own reading is {@link CmafObject.sap} */
  sap: SapReading
}

/** One moof (8.8.4) */
export interface MovieFragment {
  offset: number
  /** mfhd sequence_number (8.8.5), or `null` without an mfhd */
  sequenceNumber: number | null
  hasMfhd: boolean
  /** An mdat comes after this moof and before the next one: together a CMAF chunk */
  mdatFollows: boolean
  /** The moof runs past the end of the payload */
  truncated: boolean
  trackFragments: TrackFragment[]
}

/**
 * - `size-below-header`: a size field smaller than the box header
 * - `past-container`: a box runs past its parent, or past the payload
 * - `fields-past-end`: a box ends before the fields it announces
 * - `partial-header`: bytes after the last box, too few for a box header
 */
export type MalformedReason =
  | 'size-below-header'
  | 'past-container'
  | 'fields-past-end'
  | 'partial-header'

export interface MalformedBox {
  offset: number
  /** The box type, or `null` for a partial header */
  type: string | null
  reason: MalformedReason
}

/**
 * Why a time is unknown:
 * - `no-samples`, `unreadable` (as in {@link SampleFlagsUnknown}), `truncated`
 * - `multiple-tracks`: the trafs with samples name more than one track_ID
 * - `no-tfdt`: a traf with samples has no tfdt
 * - `durations-unknown`: a sample duration is given by neither trun nor tfhd,
 *   and there is no trex default for it, so a later sample may be presented earliest
 * - `no-init`, `track-not-in-init`, `track-ambiguous`, `no-timescale`: the timescale is unknown
 * - `edit-list`: the trak has an edit list; CMSF does not say whether the
 *   milliseconds are before or after it
 */
export type TimeUnknown =
  | 'no-samples'
  | 'unreadable'
  | 'truncated'
  | 'multiple-tracks'
  | 'no-tfdt'
  | 'durations-unknown'
  | 'no-init'
  | 'track-not-in-init'
  | 'track-ambiguous'
  | 'no-timescale'
  | 'edit-list'

export interface CmafTiming {
  /**
   * The earliest presentation time of the object's samples, in the track's
   * timescale: tfdt, plus the durations of the samples before, plus the
   * composition offset. No edit list is applied.
   */
  earliestPresentationTime: bigint | null
  /**
   * `earliestPresentationTime` in milliseconds, rounded to the nearest, as
   * the SAP type timeline records it (cmsf 3.6.1). Two candidates when it is
   * exactly halfway, since the drafts do not say which way that rounds.
   */
  eptMs: number[] | null
  /** Why `earliestPresentationTime`, or else `eptMs`, is null */
  unknown: TimeUnknown | null
}

export interface CmafObject {
  /** Top-level box types, in order */
  boxes: string[]
  /** The first styp's brands */
  styp: Brands | null
  emsgCount: number
  prftCount: number
  mdatCount: number
  movieFragments: MovieFragment[]
  /** The distinct tfhd track_IDs, in order of appearance */
  trackIds: number[]
  /** The object's first sample: the first sample of the first traf that holds one */
  firstSample: FirstSample
  sap: SapReading
  timing: CmafTiming
  /** A top-level box runs past the end of the payload */
  truncated: boolean
  /** Bytes at the end of the payload not read as boxes: after an invalid box size, or too few for a header */
  unreadBytes: number
  /** Every malformed box, in reading order; empty for a well-formed payload */
  malformed: MalformedBox[]
}

// ─── Sample flags ────────────────────────────────────────────────────

/** Split a 32-bit sample_flags value into its fields. */
export function decodeSampleFlags(value: number): SampleFlags {
  return {
    value,
    isLeading: (value >>> 26) & 0x3,
    dependsOn: (value >>> 24) & 0x3,
    isDependedOn: (value >>> 22) & 0x3,
    hasRedundancy: (value >>> 20) & 0x3,
    paddingValue: (value >>> 17) & 0x7,
    isNonSync: ((value >>> 16) & 0x1) === 1,
    degradationPriority: value & 0xffff,
  }
}

// ─── Reading ─────────────────────────────────────────────────────────

class Reader {
  readonly malformed: MalformedBox[] = []

  constructor(
    readonly data: Uint8Array,
    readonly init: InitSegment | null | undefined,
  ) {}

  short(box: Child): void {
    this.malformed.push({ offset: box.offset, type: box.type, reason: 'fields-past-end' })
  }

  /** The boxes inside [start, end), recording what is malformed */
  boxes(start: number, end: number): Child[] {
    const w = walk(this.data, start, end)
    for (const b of w.boxes) {
      if (b.truncated)
        this.malformed.push({ offset: b.offset, type: b.type, reason: 'past-container' })
    }
    if (w.invalidAt !== null) {
      this.malformed.push({
        offset: w.invalidAt,
        type: null,
        reason: 'size-below-header',
      })
    } else if (w.trailing > 0) {
      this.malformed.push({ offset: end - w.trailing, type: null, reason: 'partial-header' })
    }
    return w.boxes
  }

  tfhd(box: Child): TrackFragmentHeader | null {
    const { data } = this
    const vf = versionFlags(data, box)
    if (vf === null || box.body + 8 > box.end) {
      this.short(box)
      return null
    }
    const { flags } = vf
    let at = box.body + 8
    let short = false
    const field = (flag: number, size: 4 | 8): number | bigint | null => {
      if ((flags & flag) === 0) return null
      const start = at
      at += size
      if (at > box.end) {
        short = true
        return null
      }
      return size === 8 ? u64(data, start) : u32(data, start)
    }
    const header: TrackFragmentHeader = {
      trackId: u32(data, box.body + 4),
      flags,
      baseDataOffset: field(0x01, 8) as bigint | null,
      sampleDescriptionIndex: field(0x02, 4) as number | null,
      defaultSampleDuration: field(0x08, 4) as number | null,
      defaultSampleSize: field(0x10, 4) as number | null,
      defaultSampleFlags: field(0x20, 4) as number | null,
      durationIsEmpty: (flags & 0x10000) !== 0,
      defaultBaseIsMoof: (flags & 0x20000) !== 0,
    }
    if (short) this.short(box)
    return header
  }

  trun(box: Child): TrackRun | null {
    const { data } = this
    const vf = versionFlags(data, box)
    if (vf === null || box.body + 8 > box.end) {
      this.short(box)
      return null
    }
    const { version, flags } = vf
    const sampleCount = u32(data, box.body + 4)
    let at = box.body + 8
    let dataOffset: number | null = null
    let firstSampleFlags: number | null = null
    if (flags & 0x01) {
      if (at + 4 <= box.end) dataOffset = u32(data, at) | 0
      at += 4
    }
    if (flags & 0x04) {
      if (at + 4 <= box.end) firstSampleFlags = u32(data, at)
      at += 4
    }
    const perSample = [0x100, 0x200, 0x400, 0x800].filter((f) => flags & f).length * 4
    const samples: TrackRunSample[] = []
    for (let i = 0; perSample > 0 && i < sampleCount && at + perSample <= box.end; i++) {
      const s: TrackRunSample = {}
      if (flags & 0x100) {
        s.duration = u32(data, at)
        at += 4
      }
      if (flags & 0x200) {
        s.size = u32(data, at)
        at += 4
      }
      if (flags & 0x400) {
        s.flags = u32(data, at)
        at += 4
      }
      if (flags & 0x800) {
        const v = u32(data, at)
        s.compositionTimeOffset = version === 0 ? v : v | 0
        at += 4
      }
      samples.push(s)
    }
    if (at > box.end || (perSample > 0 && samples.length < sampleCount)) this.short(box)
    return { version, flags, sampleCount, dataOffset, firstSampleFlags, samples }
  }

  tfdt(box: Child): bigint | null {
    const { data } = this
    const vf = versionFlags(data, box)
    const size = vf?.version === 1 ? 8 : 4
    if (vf === null || box.body + 4 + size > box.end) {
      this.short(box)
      return null
    }
    return size === 8 ? u64(data, box.body + 4) : BigInt(u32(data, box.body + 4))
  }

  traf(box: Child): Omit<TrackFragment, 'sap'> {
    let header: TrackFragmentHeader | null = null
    let baseMediaDecodeTime: bigint | null = null
    let sawTfhd = false
    let sawTfdt = false
    const runs: TrackRun[] = []
    const sampleGroups: SampleGroupDescription[] = []
    const sampleToGroups: SampleToGroup[] = []
    for (const c of this.boxes(box.body, box.end)) {
      if (c.type === 'tfhd' && !sawTfhd) {
        sawTfhd = true
        header = this.tfhd(c)
      } else if (c.type === 'tfdt' && !sawTfdt) {
        sawTfdt = true
        baseMediaDecodeTime = this.tfdt(c)
      } else if (c.type === 'trun') {
        const run = this.trun(c)
        if (run) runs.push(run)
      } else if (c.type === 'sgpd') {
        const g = readSgpd(this.data, c, () => this.short(c))
        if (g) sampleGroups.push(g)
      } else if (c.type === 'sbgp') {
        const g = readSbgp(this.data, c, () => this.short(c))
        if (g) sampleToGroups.push(g)
      }
    }
    return {
      offset: box.offset,
      header,
      baseMediaDecodeTime,
      runs,
      sampleCount: runs.reduce((n, r) => n + r.sampleCount, 0),
      sampleGroups,
      sampleToGroups,
      firstSample: resolveFirstSample(header, runs, this.init),
    }
  }
}

// ─── First sample ────────────────────────────────────────────────────

/** The trak of a track_ID, or `ambiguous` when the header names it in more than one trak or trex */
function initTrackFor(
  init: InitSegment | null | undefined,
  trackId: number | undefined,
): InitTrack | 'ambiguous' | undefined {
  if (!init || trackId === undefined) return undefined
  if (init.ambiguousTrackIds.includes(trackId)) return 'ambiguous'
  return init.tracks.find((t) => t.trackId === trackId)
}

function noSamples(unknown: 'no-samples' | 'unreadable'): FirstSample {
  return { flags: null, source: null, unknown, sync: null }
}

function resolveFirstSample(
  header: TrackFragmentHeader | null,
  runs: TrackRun[],
  init: InitSegment | null | undefined,
): FirstSample {
  const unknown = (reason: SampleFlagsUnknown): FirstSample => ({
    flags: null,
    source: null,
    unknown: reason,
    sync: null,
  })
  const known = (value: number, source: SampleFlagsSource): FirstSample => {
    const flags = decodeSampleFlags(value)
    return { flags, source, unknown: null, sync: !flags.isNonSync }
  }
  const run = runs.find((r) => r.sampleCount > 0)
  if (!run) return noSamples('no-samples')
  if (run.flags & 0x04 && run.flags & 0x400) {
    const own = run.samples[0]?.flags
    if (run.firstSampleFlags === null || own === undefined) return unknown('truncated')
    return {
      ...unknown('conflicting'),
      conflicting: {
        firstSampleFlags: decodeSampleFlags(run.firstSampleFlags),
        sampleFlags: decodeSampleFlags(own),
      },
    }
  }
  if (run.firstSampleFlags !== null) return known(run.firstSampleFlags, 'trun-first-sample-flags')
  if (run.flags & 0x04) return unknown('truncated')
  if (run.flags & 0x400) {
    const flags = run.samples[0]?.flags
    return flags === undefined ? unknown('truncated') : known(flags, 'trun-sample-flags')
  }
  if (header?.defaultSampleFlags != null) return known(header.defaultSampleFlags, 'tfhd-default')
  if (header && header.flags & 0x20) return unknown('truncated')
  if (!init) return unknown('no-init')
  const track = initTrackFor(init, header?.trackId)
  if (track === 'ambiguous') return unknown('track-ambiguous')
  if (!track) return unknown('track-not-in-init')
  if (!track.trex) return unknown('no-trex')
  return known(track.trex.defaultSampleFlags, 'trex-default')
}

/** The sample_flags of sample `i` of a run, or `null` when unknown or conflicting */
function sampleFlagsAt(
  run: TrackRun,
  i: number,
  header: TrackFragmentHeader | null,
  track: InitTrack | 'ambiguous' | undefined,
): number | null {
  if (run.flags & 0x400) {
    if (i === 0 && run.flags & 0x04) return null
    return run.samples[i]?.flags ?? null
  }
  if (i === 0 && run.flags & 0x04) return run.firstSampleFlags
  if (header && header.flags & 0x20) return header.defaultSampleFlags
  return track && track !== 'ambiguous' ? (track.trex?.defaultSampleFlags ?? null) : null
}

// ─── Presentation times ──────────────────────────────────────────────

/**
 * A sample's presentation time relative to its traf's decode start: `time`
 * when known; else, after a sample whose duration is unknown, at least `atLeast`.
 */
interface Presented {
  time: bigint | null
  atLeast: bigint
  flags: number | null
}

/**
 * The presentation times of a traf's samples: decode time from the durations
 * before, plus the composition offset. A run without per-sample fields gives
 * its first sample and one entry for the rest, which share their flags and
 * are presented no earlier than the second.
 */
function presentation(
  traf: Omit<TrackFragment, 'sap'>,
  init: InitSegment | null | undefined,
): Presented[] | TimeUnknown {
  const { header } = traf
  const track = initTrackFor(init, header?.trackId)
  const trexDuration =
    track && track !== 'ambiguous' ? (track.trex?.defaultSampleDuration ?? null) : null
  const defaultDuration =
    header && header.flags & 0x08 ? header.defaultSampleDuration : trexDuration
  const out: Presented[] = []
  // `decode` is null once a duration is unknown; `atLeast` stays a lower bound.
  let decode: bigint | null = 0n
  let atLeast = 0n
  const push = (offset: bigint, flags: number | null) =>
    out.push(
      decode === null
        ? { time: null, atLeast: atLeast + offset, flags }
        : { time: decode + offset, atLeast: decode + offset, flags },
    )
  const advance = (duration: number | null | undefined, count = 1) => {
    if (duration == null) {
      decode = null
      return
    }
    atLeast += BigInt(duration) * BigInt(count)
    if (decode !== null) decode = atLeast
  }
  for (const run of traf.runs) {
    if (run.sampleCount === 0) continue
    if ((run.flags & 0xf00) === 0) {
      push(0n, sampleFlagsAt(run, 0, header, track))
      advance(defaultDuration)
      if (run.sampleCount > 1) {
        push(0n, sampleFlagsAt(run, 1, header, track))
        advance(defaultDuration, run.sampleCount - 1)
      }
      continue
    }
    if (run.samples.length < run.sampleCount) return 'truncated'
    run.samples.forEach((s, i) => {
      push(BigInt(s.compositionTimeOffset ?? 0), sampleFlagsAt(run, i, header, track))
      advance(s.duration ?? defaultDuration)
    })
  }
  return out
}

function minOf(values: bigint[]): bigint {
  return values.reduce((a, b) => (b < a ? b : a))
}

/** `value / timescale` seconds in milliseconds, rounded to the nearest; both neighbours at exactly .5 */
function roundMs(value: bigint, timescale: number): number[] {
  const num = value * 1000n
  const den = BigInt(timescale)
  let floor = num / den
  if (num % den !== 0n && num < 0n) floor -= 1n
  const twice = (num - floor * den) * 2n
  if (twice < den) return [Number(floor)]
  if (twice > den) return [Number(floor + 1n)]
  return [Number(floor), Number(floor + 1n)]
}

/** The samples after the first in decode order that are presented before it */
interface Leading {
  /** The sample_flags of those known to be, `null` where unknown */
  flags: (number | null)[]
  /** Some sample's time is not known well enough to tell */
  maybeMore: boolean
}

interface Timed {
  timing: CmafTiming
  leading: Leading
}

/**
 * The object's timing, and the samples presented before its first. Leading
 * samples are looked for only in trafs of the first traf's track_ID.
 */
function objectTiming(
  trafs: Omit<TrackFragment, 'sap'>[],
  init: InitSegment | null | undefined,
  empty: 'no-samples' | 'unreadable',
): Timed {
  const none = (unknown: TimeUnknown): CmafTiming => ({
    earliestPresentationTime: null,
    eptMs: null,
    unknown,
  })
  const withSamples = trafs.filter((t) => t.sampleCount > 0)
  if (withSamples.length === 0) {
    return { timing: none(empty), leading: { flags: [], maybeMore: false } }
  }

  const trackId = withSamples[0]!.header?.trackId ?? null
  const ofTrack = withSamples.filter(
    (t, i) => i === 0 || (trackId !== null && t.header?.trackId === trackId),
  )
  const presented = ofTrack.map((t) => presentation(t, init))

  const leading: Leading = { flags: [], maybeMore: false }
  const first = presented[0]!
  if (typeof first === 'string') {
    leading.maybeMore = true
  } else {
    const base = ofTrack[0]!.baseMediaDecodeTime
    const firstTime = first[0]!.time!
    presented.forEach((samples, k) => {
      const shift = k === 0 ? 0n : base === null ? null : ofTrack[k]!.baseMediaDecodeTime
      if (typeof samples === 'string' || shift === null) {
        leading.maybeMore = true
        return
      }
      // Relative to the first traf's decode start.
      const offset = k === 0 ? 0n : shift - base!
      samples.forEach((s, i) => {
        if (k === 0 && i === 0) return
        if (s.time !== null) {
          if (s.time + offset < firstTime) leading.flags.push(s.flags)
        } else if (s.atLeast + offset < firstTime) {
          leading.maybeMore = true
        }
      })
    })
  }

  const ids = new Set(withSamples.map((t) => t.header?.trackId ?? null))
  if (ids.size > 1) return { timing: none('multiple-tracks'), leading }
  const unknownTimes = presented.find((p): p is TimeUnknown => typeof p === 'string')
  if (unknownTimes) return { timing: none(unknownTimes), leading }
  if (ofTrack.some((t) => t.baseMediaDecodeTime === null)) {
    return { timing: none('no-tfdt'), leading }
  }
  const absolute = ofTrack.flatMap((t, k) =>
    (presented[k] as Presented[]).map((s) => ({
      time: s.time === null ? null : s.time + t.baseMediaDecodeTime!,
      atLeast: s.atLeast + t.baseMediaDecodeTime!,
    })),
  )
  const ept = minOf(absolute.flatMap((s) => (s.time === null ? [] : [s.time])))
  if (absolute.some((s) => s.time === null && s.atLeast < ept)) {
    return { timing: none('durations-unknown'), leading }
  }

  const partial = (unknown: TimeUnknown): Timed => ({
    timing: { earliestPresentationTime: ept, eptMs: null, unknown },
    leading,
  })
  if (!init) return partial('no-init')
  const track = initTrackFor(init, trackId ?? undefined)
  if (track === 'ambiguous') return partial('track-ambiguous')
  if (!track) return partial('track-not-in-init')
  if (!track.timescale) return partial('no-timescale')
  if (track.hasEditList) return partial('edit-list')
  return {
    timing: { earliestPresentationTime: ept, eptMs: roundMs(ept, track.timescale), unknown: null },
    leading,
  }
}

// ─── SAP ─────────────────────────────────────────────────────────────

/** The group_description_index sbgp gives the first sample: null when no sbgp of the type, undefined when several */
function firstSampleIndex(maps: SampleToGroup[], type: string): number | null | undefined {
  const of = maps.filter((m) => m.groupingType === type)
  if (of.length === 0) return null
  if (of.length > 1) return undefined
  return of[0]!.entries.find((e) => e.sampleCount > 0)?.groupDescriptionIndex ?? 0
}

function unknownSap(
  reason: SapUnknownReason,
  candidates: number[] = [],
): Extract<SapReading, { sapType: null }> {
  return { sapType: null, candidates, reason }
}

/** A sync sample is type 1 or 2; a sample presented before it rules out 1 (ISO/IEC 14496-12 Annex I) */
function syncSap(leading: Leading): SapReading {
  if (leading.flags.length === 0) return unknownSap('sync-sample', [1, 2])
  const isLeading = leading.flags.map((f) => (f === null ? null : decodeSampleFlags(f).isLeading))
  if (isLeading.includes(1)) return unknownSap('leading-sample-not-decodable', [2, 3])
  if (!leading.maybeMore && isLeading.every((l) => l === 3)) {
    return { sapType: 2, source: 'decodable-leading-samples' }
  }
  return unknownSap('leading-samples-not-signalled', [2, 3])
}

function readSap(
  traf: Omit<TrackFragment, 'sap'>,
  init: InitSegment | null | undefined,
  leading: Leading,
): SapReading {
  if (traf.sampleCount === 0) return unknownSap('no-samples')
  const track = initTrackFor(init, traf.header?.trackId)
  const maps = traf.sampleToGroups

  // An index above 0x10000 names an entry of the traf's own sgpd.
  const sapIndex = firstSampleIndex(maps, 'sap ')
  let unresolved = sapIndex === undefined
  const local = !!sapIndex && sapIndex > 0x10000
  if (sapIndex && !local && track === 'ambiguous') return unknownSap('track-ambiguous')
  // A header-level entry without the header falls through to `no-init` / `track-not-in-init`.
  if (sapIndex && (local || track)) {
    const descriptions = (local ? traf.sampleGroups : (track as InitTrack).sampleGroups).filter(
      (g) => g.groupingType === 'sap ',
    )
    const entry =
      descriptions.length === 1
        ? descriptions[0]!.sap?.[(local ? sapIndex - 0x10000 : sapIndex) - 1]
        : undefined
    if (entry && entry.sapType >= 1 && entry.sapType <= 6) {
      return {
        sapType: entry.sapType,
        source: 'sap-sample-group',
        dependentFlag: entry.dependentFlag,
      }
    }
    if (entry) return { ...unknownSap('sap-type-undefined'), sampleGroupSapType: entry.sapType }
    unresolved = true
  }

  if (traf.firstSample.sync === true) return syncSap(leading)
  if (unresolved) return unknownSap('sap-sample-group-unresolved')
  if (traf.firstSample.unknown === 'conflicting') return unknownSap('sample-flags-conflicting')
  if (traf.firstSample.unknown === 'truncated') return unknownSap('sample-flags-truncated')
  if (!init) return unknownSap('no-init')
  if (track === 'ambiguous') return unknownSap('track-ambiguous')
  if (!track) return unknownSap('track-not-in-init')
  if (traf.firstSample.sync === null) return unknownSap('sample-flags-unknown')

  const grouping = ['sap ', 'rap ', 'roll']
  const hasDefault = [...traf.sampleGroups, ...track.sampleGroups].some(
    (g) => grouping.includes(g.groupingType) && (g.defaultIndex ?? 0) > 0,
  )
  if (hasDefault) return unknownSap('sample-group-default-not-read')
  // Several sbgp of one type (undefined) count as mapped: the sample may be in the group.
  if (firstSampleIndex(maps, 'rap ') !== null && firstSampleIndex(maps, 'rap ') !== 0) {
    return unknownSap('rap-sample-group')
  }
  if (firstSampleIndex(maps, 'roll') !== null && firstSampleIndex(maps, 'roll') !== 0) {
    return unknownSap('roll-sample-group')
  }
  return unknownSap('no-sap-signalled')
}

// ─── Object ──────────────────────────────────────────────────────────

/**
 * Read one object payload of a CMAF track. `init` is the track's CMAF
 * header, from the catalog (cmsf-00 3.1 `initData`, cmsf-01 3.1
 * `initDataList`). Without it, trex defaults, the timescale and the header's
 * sample groups are unknown, so less is decided.
 *
 * A sample's flags resolve from trun first_sample_flags or trun per-sample
 * flags, then tfhd default_sample_flags, then trex default_sample_flags. A
 * trun with both for its first sample leaves that sample's flags unknown.
 */
export function parseCmafObject(payload: Uint8Array, init?: InitSegment | null): CmafObject {
  const reader = new Reader(payload, init)
  const boxes = reader.boxes(0, payload.length)
  const last = boxes[boxes.length - 1]
  const unreadBytes = last === undefined ? payload.length : payload.length - last.end
  const movieFragments: MovieFragment[] = []
  const rawTrafs: Omit<TrackFragment, 'sap'>[][] = []
  let styp: Brands | null = null
  let sawStyp = false
  boxes.forEach((box, i) => {
    if (box.type === 'styp' && !sawStyp) {
      sawStyp = true
      styp = brandsAt(payload, box.body, box.end)
      if (styp === null) reader.short(box)
    }
    if (box.type !== 'moof') return
    let mdatFollows = false
    for (const next of boxes.slice(i + 1)) {
      if (next.type === 'moof') break
      if (next.type === 'mdat') {
        mdatFollows = true
        break
      }
    }
    const inMoof = reader.boxes(box.body, box.end)
    const mfhd = inMoof.find((c) => c.type === 'mfhd')
    let sequenceNumber: number | null = null
    if (mfhd) {
      if (mfhd.body + 8 <= mfhd.end) sequenceNumber = u32(payload, mfhd.body + 4)
      else reader.short(mfhd)
    }
    rawTrafs.push(inMoof.filter((c) => c.type === 'traf').map((t) => reader.traf(t)))
    movieFragments.push({
      offset: box.offset,
      sequenceNumber,
      hasMfhd: mfhd !== undefined,
      mdatFollows,
      truncated: box.truncated,
      trackFragments: [],
    })
  })

  const all = rawTrafs.flat()
  const empty = reader.malformed.length > 0 ? 'unreadable' : 'no-samples'
  const { timing, leading } = objectTiming(all, init, empty)
  const firstIndex = all.findIndex((t) => t.sampleCount > 0)
  movieFragments.forEach((moof, m) => {
    moof.trackFragments = rawTrafs[m]!.map((t) => {
      const own = objectTiming([t], init, 'no-samples').leading
      return { ...t, sap: readSap(t, init, own) }
    })
  })

  const trackIds: number[] = []
  for (const t of all) {
    const id = t.header?.trackId
    if (id !== undefined && !trackIds.includes(id)) trackIds.push(id)
  }
  const first = firstIndex < 0 ? undefined : all[firstIndex]
  const count = (type: string) => boxes.filter((b) => b.type === type).length

  return {
    boxes: boxes.map((b) => b.type),
    styp,
    emsgCount: count('emsg'),
    prftCount: count('prft'),
    mdatCount: count('mdat'),
    movieFragments,
    trackIds,
    firstSample: first?.firstSample ?? noSamples(empty),
    sap: first ? readSap(first, init, leading) : unknownSap(empty),
    timing,
    truncated: boxes.some((b) => b.truncated),
    unreadBytes,
    malformed: reader.malformed,
  }
}

// ─── Checks ──────────────────────────────────────────────────────────

/**
 * - `malformed-box`: the payload's boxes are not well formed (ISO/IEC 14496-12)
 * - `no-moof-mdat`: no moof followed by an mdat (cmsf 3.3)
 * - `no-mfhd`: a moof without an mfhd (cmsf 3.3)
 * - `no-traf`: a moof without a traf, `no-tfhd`: a traf without a tfhd; the
 *   moof names no track_ID (cmsf 3.3, which calls it "Track Box (trak)")
 * - `multiple-tracks`: tfhd boxes name more than one track_ID (cmsf 3.3)
 * - `track-id-not-in-init`: a track_ID no trak of the CMAF header has (cmsf 3.3)
 * - `track-id-unchecked`: no CMAF header given to check track_IDs against
 * - `group-start-sap-type`: the first object of a Group begins with a SAP
 *   type that the data decides, other than 1 or 2 (cmsf 3.4 with 3.6.1)
 * - `group-start-sap-not-signalled`: the first object of a Group, whose SAP
 *   type is not signalled
 */
export type CmafFindingCode =
  | 'malformed-box'
  | 'no-moof-mdat'
  | 'no-mfhd'
  | 'no-traf'
  | 'no-tfhd'
  | 'multiple-tracks'
  | 'track-id-not-in-init'
  | 'track-id-unchecked'
  | 'group-start-sap-type'
  | 'group-start-sap-not-signalled'

export interface CmafFinding {
  /** `violation`: the data breaks the rule. `not-signalled`: the data does not say whether it does. */
  kind: 'violation' | 'not-signalled'
  code: CmafFindingCode
  /** The draft and section that state the rule, e.g. `CMSF-01 3.3` */
  section: string
  /** Where: `moof[0]`, `moof[1].traf[0]`, `@1234` for a byte offset, `''` for the whole object */
  path: string
  /** What is wrong, as a sentence to show: capitalised, no closing period */
  message: string
}

export interface CheckCmafObjectOptions {
  /** Cite this draft only; without it, both CMSF drafts (whose rules here are identical) */
  draft?: CmsfDraft
  /** The object is the first of its Group, which cmsf 3.4 and 3.6.1 require to begin with a SAP of type 1 or 2 */
  firstInGroup?: boolean
}

const SAP_REASON_TEXT: Record<SapUnknownReason, string> = {
  'no-samples': 'the object holds no samples',
  unreadable: 'no sample is found in the boxes read, and some boxes are malformed',
  'sync-sample': 'its first sample is a sync sample, a SAP of type 1 or 2',
  'leading-samples-not-signalled':
    'its first sample is a sync sample that a later sample is presented before, so not type 1, and not every such sample is signalled decodable',
  'leading-sample-not-decodable':
    'its first sample is a sync sample, type 1 or 2, while a later sample presented before it is signalled not decodable, which points to type 3',
  'sample-flags-conflicting':
    'the trun gives its first sample both first_sample_flags and its own sample_flags',
  'sample-flags-truncated': 'the trun or tfhd ends before the flags of its first sample',
  'no-init': 'without the CMAF header, its sample groups and trex defaults are unknown',
  'track-not-in-init': 'the CMAF header has no trak for its track_ID',
  'track-ambiguous': 'the CMAF header names its track_ID in more than one trak or trex',
  'sample-flags-unknown':
    'its first sample has no flags in trun or tfhd, and the CMAF header has no trex for the track',
  'rap-sample-group': "its first sample is in a 'rap ' sample group, which states no SAP type",
  'roll-sample-group': "its first sample is in a 'roll' sample group, which states no SAP type",
  'no-sap-signalled':
    "its first sample is not a sync sample and is in no 'sap ', 'rap ' or 'roll' sample group",
  'sap-sample-group-unresolved':
    "the 'sap ' sample group entry of its first sample cannot be found",
  'sample-group-default-not-read':
    'a sample group description names a default entry for unmapped samples, which is not read',
  'sap-type-undefined':
    "the 'sap ' sample group entry of its first sample gives a SAP_type outside 1 to 6",
}

const MALFORMED_TEXT: Record<MalformedReason, string> = {
  'size-below-header': 'has a size smaller than its header',
  'past-container': 'runs past its container',
  'fields-past-end': 'ends before its fields',
  'partial-header': 'has too few bytes for its header',
}

/** Why a {@link SapReading} has no SAP type, in words. */
export function describeSapReason(reason: SapUnknownReason): string {
  return SAP_REASON_TEXT[reason]
}

/**
 * Check one parsed object against what cmsf 3.3 and 3.4 require of an
 * object. Pass the init segment the object was parsed with. A rule the data
 * does not let us decide gives a `not-signalled` finding, never a violation.
 * A moof that runs past the end of the payload is not checked further, and
 * `no-moof-mdat` is not checked when the payload is not read to its end.
 */
export function checkCmafObject(
  object: CmafObject,
  init?: InitSegment | null,
  options: CheckCmafObjectOptions = {},
): CmafFinding[] {
  const out: CmafFinding[] = []
  const drafts = options.draft ? [options.draft] : ['cmsf-00', 'cmsf-01']
  const section = (s: string[]) =>
    drafts.flatMap((d) => s.map((x) => `${d.toUpperCase()} ${x}`)).join(', ')
  const push = (
    kind: CmafFinding['kind'],
    code: CmafFindingCode,
    s: string | string[],
    path: string,
    message: string,
  ) => out.push({ kind, code, section: section(typeof s === 'string' ? [s] : s), path, message })

  for (const m of object.malformed) {
    out.push({
      kind: 'violation',
      code: 'malformed-box',
      section: 'ISO/IEC 14496-12',
      path: `@${m.offset}`,
      message:
        m.type === null
          ? `A box ${MALFORMED_TEXT[m.reason]}`
          : `The '${m.type}' box ${MALFORMED_TEXT[m.reason]}`,
    })
  }

  const readToEnd = !object.truncated && object.unreadBytes === 0
  if (readToEnd && !object.movieFragments.some((m) => m.mdatFollows)) {
    push('violation', 'no-moof-mdat', '3.3', '', 'No moof is followed by an mdat')
  }
  object.movieFragments.forEach((moof, i) => {
    if (moof.truncated) return
    if (!moof.hasMfhd) push('violation', 'no-mfhd', '3.3', `moof[${i}]`, 'The moof has no mfhd')
    if (moof.trackFragments.length === 0) {
      push('violation', 'no-traf', '3.3', `moof[${i}]`, 'The moof has no traf')
    }
    moof.trackFragments.forEach((t, j) => {
      if (t.header !== null) return
      push('violation', 'no-tfhd', '3.3', `moof[${i}].traf[${j}]`, 'The traf has no tfhd')
    })
  })

  if (object.trackIds.length > 1) {
    push(
      'violation',
      'multiple-tracks',
      '3.3',
      '',
      `The object carries track_IDs ${object.trackIds.join(', ')}; an object carries a single track`,
    )
  }
  if (init) {
    const known = new Set(init.tracks.map((t) => t.trackId))
    for (const id of object.trackIds) {
      if (known.has(id)) continue
      push(
        'violation',
        'track-id-not-in-init',
        '3.3',
        '',
        `The track_ID ${id} matches no trak of the CMAF header`,
      )
    }
  } else if (object.trackIds.length > 0) {
    push(
      'not-signalled',
      'track-id-unchecked',
      '3.3',
      '',
      'There is no CMAF header to match the track_ID against',
    )
  }

  if (options.firstInGroup) {
    const sap = object.sap
    if (sap.sapType !== null) {
      if (sap.sapType !== 1 && sap.sapType !== 2) {
        push(
          'violation',
          'group-start-sap-type',
          ['3.4', '3.6.1'],
          '',
          `The Group's first Object begins with SAP type ${sap.sapType}, not 1 or 2`,
        )
      }
    } else if (sap.candidates.length === 0 || sap.candidates.some((t) => t !== 1 && t !== 2)) {
      push(
        'not-signalled',
        'group-start-sap-not-signalled',
        ['3.4', '3.6.1'],
        '',
        `The SAP type the Group starts with is not signalled: ${describeSapReason(sap.reason)}`,
      )
    }
  }
  return out
}
