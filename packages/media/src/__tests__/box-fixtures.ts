// Box builders for tests, from the field layouts in ISO/IEC 14496-12 and 23001-7.

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

export function u8(...n: number[]): Uint8Array {
  return new Uint8Array(n)
}

export function u32(n: number): Uint8Array {
  return new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff])
}

export function u64(n: number): Uint8Array {
  return concat(u32(Math.floor(n / 2 ** 32)), u32(n >>> 0))
}

export function ascii(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

export function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

export function box(type: string, ...body: Uint8Array[]): Uint8Array {
  const payload = concat(...body)
  return concat(u32(8 + payload.length), ascii(type), payload)
}

export function fullBox(
  type: string,
  version: number,
  flags: number,
  ...body: Uint8Array[]
): Uint8Array {
  return box(type, u8(version, (flags >>> 16) & 0xff, (flags >>> 8) & 0xff, flags & 0xff), ...body)
}

// ─── Sample flags ────────────────────────────────────────────────────

export const SYNC = 0x02000000 // sample_depends_on 2 (does not depend), sync
export const NON_SYNC = 0x01010000 // sample_depends_on 1, sample_is_non_sync_sample 1

// ─── Fragments ───────────────────────────────────────────────────────

export interface TfhdSpec {
  trackId: number
  baseDataOffset?: number
  sampleDescriptionIndex?: number
  defaultSampleDuration?: number
  defaultSampleSize?: number
  defaultSampleFlags?: number
  extraFlags?: number
}

export function tfhd(spec: TfhdSpec): Uint8Array {
  let flags = spec.extraFlags ?? 0
  const fields: Uint8Array[] = [u32(spec.trackId)]
  if (spec.baseDataOffset !== undefined) {
    flags |= 0x01
    fields.push(u64(spec.baseDataOffset))
  }
  if (spec.sampleDescriptionIndex !== undefined) {
    flags |= 0x02
    fields.push(u32(spec.sampleDescriptionIndex))
  }
  if (spec.defaultSampleDuration !== undefined) {
    flags |= 0x08
    fields.push(u32(spec.defaultSampleDuration))
  }
  if (spec.defaultSampleSize !== undefined) {
    flags |= 0x10
    fields.push(u32(spec.defaultSampleSize))
  }
  if (spec.defaultSampleFlags !== undefined) {
    flags |= 0x20
    fields.push(u32(spec.defaultSampleFlags))
  }
  return fullBox('tfhd', 0, flags, ...fields)
}

export interface TrunSample {
  duration?: number
  size?: number
  flags?: number
  compositionTimeOffset?: number
}

export interface TrunSpec {
  version?: number
  dataOffset?: number
  firstSampleFlags?: number
  /** Which per-sample fields are present */
  fields?: ('duration' | 'size' | 'flags' | 'compositionTimeOffset')[]
  samples: TrunSample[]
  /** sample_count, when it should differ from samples.length */
  sampleCount?: number
}

export function trun(spec: TrunSpec): Uint8Array {
  const fields = spec.fields ?? []
  let flags = 0
  const head: Uint8Array[] = [u32(spec.sampleCount ?? spec.samples.length)]
  if (spec.dataOffset !== undefined) {
    flags |= 0x01
    head.push(u32(spec.dataOffset >>> 0))
  }
  if (spec.firstSampleFlags !== undefined) {
    flags |= 0x04
    head.push(u32(spec.firstSampleFlags))
  }
  if (fields.includes('duration')) flags |= 0x100
  if (fields.includes('size')) flags |= 0x200
  if (fields.includes('flags')) flags |= 0x400
  if (fields.includes('compositionTimeOffset')) flags |= 0x800
  const body: Uint8Array[] = []
  for (const s of spec.samples) {
    if (flags & 0x100) body.push(u32(s.duration ?? 0))
    if (flags & 0x200) body.push(u32(s.size ?? 0))
    if (flags & 0x400) body.push(u32(s.flags ?? 0))
    if (flags & 0x800) body.push(u32((s.compositionTimeOffset ?? 0) >>> 0))
  }
  return fullBox('trun', spec.version ?? 0, flags, ...head, ...body)
}

export function tfdt(time: number, version = 1): Uint8Array {
  return fullBox('tfdt', version, 0, version === 1 ? u64(time) : u32(time))
}

/** sgpd for 'sap ': one byte per entry, dependent_flag(1) reserved(3) SAP_type(4) */
export function sgpdSap(
  entries: { sapType: number; dependent?: boolean }[],
  version = 0,
): Uint8Array {
  const head: Uint8Array[] = [ascii('sap ')]
  if (version === 1) head.push(u32(1))
  if (version >= 2) head.push(u32(0))
  return fullBox(
    'sgpd',
    version,
    0,
    ...head,
    u32(entries.length),
    ...entries.map((e) => u8((e.dependent ? 0x80 : 0) | e.sapType)),
  )
}

/** sgpd of any grouping type with no entries, and a version 2 default index */
export function sgpdDefault(groupingType: string, defaultIndex: number): Uint8Array {
  return fullBox('sgpd', 2, 0, ascii(groupingType), u32(defaultIndex), u32(0))
}

export function sbgp(groupingType: string, entries: [number, number][]): Uint8Array {
  return fullBox(
    'sbgp',
    0,
    0,
    ascii(groupingType),
    u32(entries.length),
    ...entries.flatMap(([count, index]) => [u32(count), u32(index)]),
  )
}

export function traf(...children: Uint8Array[]): Uint8Array {
  return box('traf', ...children)
}

export function mfhd(sequence: number): Uint8Array {
  return fullBox('mfhd', 0, 0, u32(sequence))
}

export function moof(sequence: number, ...trafs: Uint8Array[]): Uint8Array {
  return box('moof', mfhd(sequence), ...trafs)
}

export const MDAT = box('mdat', u8(1, 2, 3, 4))

/** A one-sample traf of `trackId` whose first sample has `flags` in trun first_sample_flags */
export function simpleTraf(trackId: number, flags?: number, ...extra: Uint8Array[]): Uint8Array {
  return traf(
    tfhd({ trackId }),
    tfdt(0),
    trun({
      ...(flags === undefined ? {} : { firstSampleFlags: flags }),
      fields: ['duration', 'size'],
      samples: [{ duration: 3000, size: 4 }],
    }),
    ...extra,
  )
}

// ─── Init segments ───────────────────────────────────────────────────

export interface InitTrakSpec {
  trackId: number
  handler?: string
  /** A sample entry box; default an 8-byte 'avc1' */
  entry?: Uint8Array
  timescale?: number
  stblExtra?: Uint8Array[]
}

export function initTrak(spec: InitTrakSpec): Uint8Array {
  const times = concat(u32(0), u32(0))
  const tkhd = fullBox('tkhd', 0, 0, times, u32(spec.trackId), u32(0), new Uint8Array(60))
  const mdhd = fullBox('mdhd', 0, 0, times, u32(spec.timescale ?? 90000), u32(0), u32(0))
  const hdlr = fullBox(
    'hdlr',
    0,
    0,
    u32(0),
    ascii(spec.handler ?? 'vide'),
    new Uint8Array(12),
    u8(0),
  )
  const entry = spec.entry ?? box('avc1', new Uint8Array(6), u8(0, 1))
  const stsd = fullBox('stsd', 0, 0, u32(1), entry)
  const stbl = box('stbl', stsd, ...(spec.stblExtra ?? []))
  return box('trak', tkhd, box('mdia', mdhd, hdlr, box('minf', stbl)))
}

export function trex(trackId: number, flags: number): Uint8Array {
  return fullBox('trex', 0, 0, u32(trackId), u32(1), u32(3000), u32(0), u32(flags))
}

export function initSegment(
  traks: InitTrakSpec[],
  trexes: Uint8Array[] = [],
  ...extra: Uint8Array[]
): Uint8Array {
  return concat(
    box('ftyp', ascii('cmfc'), u32(0), ascii('iso6'), ascii('cmfc')),
    box(
      'moov',
      fullBox('mvhd', 0, 0, new Uint8Array(96)),
      ...traks.map(initTrak),
      ...(trexes.length > 0 ? [box('mvex', ...trexes)] : []),
      ...extra,
    ),
  )
}
