/**
 * LOC (Low Overhead Media Container): object properties and H.264/H.265 payload
 * framing, per draft-ietf-moq-loc-00 to -04 and draft-mzanaty-moq-loc-05.
 *
 * The drafts assign property IDs differently, so a track is read under the
 * profiles its property IDs allow, or under one the caller pins.
 */

import { H264_IDR, H264_KNOWN, isH265Irap, isKnownH265 } from './nal'

// ─── Profiles ────────────────────────────────────────────────────────

/** ietf-00 and ietf-01 are wire-identical and form one profile. */
export type LocProfile = 'ietf-00/01' | 'ietf-02' | 'ietf-03' | 'ietf-04' | 'mzanaty-05'

export const LOC_PROFILES: readonly LocProfile[] = [
  'ietf-00/01',
  'ietf-02',
  'ietf-03',
  'ietf-04',
  'mzanaty-05',
]

/** A MoQT draft number, as `@moqtap/codec` names it */
export type TransportDraft =
  | '08'
  | '09'
  | '10'
  | '11'
  | '12'
  | '13'
  | '14'
  | '15'
  | '16'
  | '17'
  | '18'
  | '19'
  | '20'
  | '21'
  | '22'

export type LocMeaning =
  | 'capture-timestamp'
  | 'timestamp'
  | 'timescale'
  | 'video-frame-marking'
  | 'video-config'
  | 'audio-level'
  | 'audio-config'
  | 'secure-objects-key-id'

/**
 * - `varint`: an even ID, one varint
 * - `bytes`: an odd ID, length and bytes
 * - `declared-bytes`: the draft gives an even ID a length and bytes, which the
 *   transport's property framing cannot carry
 * - `reference`: a [SecureObjects] property type the draft names, with no LOC layout
 */
export type LocValueEncoding = 'varint' | 'bytes' | 'declared-bytes' | 'reference'

export interface LocPropertyDefinition {
  id: number
  name: string
  meaning: LocMeaning
  encoding: LocValueEncoding
  /** Where the draft defines it */
  section: string
  /** Track and/or Object, where the draft states it */
  scope?: string
  /** Defined only inside Immutable Properties */
  immutableOnly?: true
  /** The largest value the draft's stated size allows, for an even ID */
  maxValue?: bigint
  /** The value lengths the draft states, for an odd ID */
  lengthRange?: [number, number]
}

export interface LocProfileDescription {
  profile: LocProfile
  drafts: string[]
  /** The [MoQTransport] draft each of `drafts` references, in the same order */
  transportReferences: string[]
  /** An ID listed twice has two meanings within the profile */
  properties: LocPropertyDefinition[]
}

const IETF_00_01: LocPropertyDefinition[] = [
  {
    id: 0x02,
    name: 'Capture Timestamp',
    meaning: 'capture-timestamp',
    encoding: 'varint',
    section: '2.3.1.1',
    maxValue: (1n << 62n) - 1n,
  },
  {
    id: 0x0d,
    name: 'Video Config',
    meaning: 'video-config',
    encoding: 'bytes',
    section: '2.3.2.1',
  },
  {
    id: 0x04,
    name: 'Video Frame Marking',
    meaning: 'video-frame-marking',
    encoding: 'varint',
    section: '2.3.2.2',
    maxValue: (1n << 30n) - 1n,
  },
  {
    id: 0x06,
    name: 'Audio Level',
    meaning: 'audio-level',
    encoding: 'varint',
    section: '2.3.3.1',
    maxValue: (1n << 14n) - 1n,
  },
]

// LOC-02..04 3.1.1 names [SecureObjects] type 0x2.
const SECURE_OBJECTS_KEY_ID: LocPropertyDefinition = {
  id: 0x02,
  name: 'Key ID (Secure Objects type 0x2)',
  meaning: 'secure-objects-key-id',
  encoding: 'reference',
  section: '3.1.1',
  scope: 'Immutable Properties',
  immutableOnly: true,
}

const IETF_02: LocPropertyDefinition[] = [
  {
    id: 0x06,
    name: 'Timestamp',
    meaning: 'timestamp',
    encoding: 'varint',
    section: '2.3.1.1, 6.1',
    scope: 'Object',
    maxValue: (1n << 56n) - 1n,
  },
  {
    id: 0x08,
    name: 'Timescale',
    meaning: 'timescale',
    encoding: 'varint',
    section: '2.3.1.2, 6.1',
    scope: 'Track or Object',
  },
  {
    id: 0x0d,
    name: 'Video Config',
    meaning: 'video-config',
    encoding: 'bytes',
    section: '2.3.2.1',
  },
  {
    id: 0x04,
    name: 'Video Frame Marking',
    meaning: 'video-frame-marking',
    encoding: 'varint',
    section: '2.3.2.2',
    maxValue: (1n << 28n) - 1n,
  },
  {
    id: 0x06,
    name: 'Audio Level',
    meaning: 'audio-level',
    encoding: 'varint',
    section: '2.3.3.1',
    maxValue: (1n << 14n) - 1n,
  },
  SECURE_OBJECTS_KEY_ID,
]

const IETF_03: LocPropertyDefinition[] = [
  { id: 0x0a, name: 'Timestamp', meaning: 'timestamp', encoding: 'varint', section: '2.3.1.1' },
  {
    id: 0x06,
    name: 'Timestamp',
    meaning: 'timestamp',
    encoding: 'varint',
    section: '6.1',
    scope: 'Object',
  },
  {
    id: 0x08,
    name: 'Timescale',
    meaning: 'timescale',
    encoding: 'varint',
    section: '2.3.1.2, 6.1',
    scope: 'Track or Object',
  },
  {
    id: 0x0d,
    name: 'Video Config',
    meaning: 'video-config',
    encoding: 'bytes',
    section: '2.3.2.1',
  },
  {
    id: 0x09,
    name: 'Video Frame Marking',
    meaning: 'video-frame-marking',
    encoding: 'bytes',
    section: '2.3.2.2',
    lengthRange: [1, 4],
  },
  {
    id: 0x0f,
    name: 'Audio Config',
    meaning: 'audio-config',
    encoding: 'bytes',
    section: '2.3.3.1',
  },
  {
    id: 0x0c,
    name: 'Audio Level',
    meaning: 'audio-level',
    encoding: 'varint',
    section: '2.3.3.2',
    maxValue: 0xffn,
  },
  SECURE_OBJECTS_KEY_ID,
]

const IETF_04: LocPropertyDefinition[] = [
  {
    id: 0x10,
    name: 'Timestamp',
    meaning: 'timestamp',
    encoding: 'varint',
    section: '2.3.1.1, 6.1',
    scope: 'Object',
  },
  {
    id: 0x08,
    name: 'Timescale',
    meaning: 'timescale',
    encoding: 'varint',
    section: '2.3.1.2, 6.1',
    scope: 'Track, Object',
  },
  {
    id: 0x09,
    name: 'Video Frame Marking',
    meaning: 'video-frame-marking',
    encoding: 'bytes',
    section: '2.3.2.2, 6.1',
    scope: 'Object',
    lengthRange: [1, 4],
  },
  {
    id: 0x0c,
    name: 'Audio Level',
    meaning: 'audio-level',
    encoding: 'varint',
    section: '2.3.3.2, 6.1',
    scope: 'Object',
    maxValue: 0xffn,
  },
  {
    id: 0x0d,
    name: 'Video Config',
    meaning: 'video-config',
    encoding: 'bytes',
    section: '2.3.2.1, 6.1',
    scope: 'Track, Object',
  },
  {
    id: 0x0f,
    name: 'Audio Config',
    meaning: 'audio-config',
    encoding: 'bytes',
    section: '2.3.3.1, 6.1',
    scope: 'Track, Object',
  },
  SECURE_OBJECTS_KEY_ID,
]

// mzanaty-05 2.3 inverts the parity rule: even IDs carry a length and bytes.
const MZANATY_05: LocPropertyDefinition[] = [
  {
    id: 0x02,
    name: 'Capture Timestamp',
    meaning: 'capture-timestamp',
    encoding: 'declared-bytes',
    section: '2.3.1.1',
  },
  {
    id: 0x10,
    name: 'Video Config',
    meaning: 'video-config',
    encoding: 'declared-bytes',
    section: '2.3.2.1',
  },
  {
    id: 0x04,
    name: 'Video Frame Marking',
    meaning: 'video-frame-marking',
    encoding: 'declared-bytes',
    section: '2.3.2.2',
  },
  {
    id: 0x06,
    name: 'Audio Level',
    meaning: 'audio-level',
    encoding: 'declared-bytes',
    section: '2.3.3.1',
  },
]

const PROFILES: Record<LocProfile, Omit<LocProfileDescription, 'profile'>> = {
  'ietf-00/01': {
    drafts: ['draft-ietf-moq-loc-00', 'draft-ietf-moq-loc-01'],
    transportReferences: ['draft-ietf-moq-transport-10', 'draft-ietf-moq-transport-12'],
    properties: IETF_00_01,
  },
  'ietf-02': {
    drafts: ['draft-ietf-moq-loc-02'],
    transportReferences: ['draft-ietf-moq-transport-17'],
    properties: IETF_02,
  },
  'ietf-03': {
    drafts: ['draft-ietf-moq-loc-03'],
    transportReferences: ['draft-ietf-moq-transport-18'],
    properties: IETF_03,
  },
  'ietf-04': {
    drafts: ['draft-ietf-moq-loc-04'],
    transportReferences: ['draft-ietf-moq-transport-19'],
    properties: IETF_04,
  },
  'mzanaty-05': {
    drafts: ['draft-mzanaty-moq-loc-05'],
    transportReferences: ['draft-ietf-moq-transport-10'],
    properties: MZANATY_05,
  },
}

export function describeProfile(profile: LocProfile): LocProfileDescription {
  const p = PROFILES[profile]
  return {
    profile,
    drafts: [...p.drafts],
    transportReferences: [...p.transportReferences],
    properties: p.properties.map((d) => ({ ...d })),
  }
}

function definitions(
  profile: LocProfile,
  type: bigint,
  immutable: boolean,
  scope: 'object' | 'track' = 'object',
): LocPropertyDefinition[] {
  return PROFILES[profile].properties.filter(
    (d) =>
      BigInt(d.id) === type &&
      (immutable || !d.immutableOnly) &&
      (scope === 'object' || d.scope?.includes('Track') === true),
  )
}

// ─── Transport-owned property types ──────────────────────────────────

const IMMUTABLE_PROPERTIES = 0x0bn

/**
 * Whether `transportDraft` defines `type` as an Object property: Prior Group ID
 * Gap 0x40 (drafts 11-13); Immutable Properties 0x0B and the gap properties
 * 0x3C/0x3E (14 on); OBJECT_ and SUBGROUP_DELIVERY_TIMEOUT 0x02/0x06 (19 on,
 * draft-19 Sections 12.1-12.2); grease types 0x7F * N + 0x9D (17 on).
 */
export function isTransportObjectProperty(type: bigint, transportDraft: TransportDraft): boolean {
  const draft = Number(transportDraft)
  if (draft >= 11 && draft <= 13) return type === 0x40n
  if (draft >= 14 && (type === IMMUTABLE_PROPERTIES || type === 0x3cn || type === 0x3en))
    return true
  if (draft >= 19 && (type === 0x02n || type === 0x06n)) return true
  if (draft >= 17 && type >= 0x9dn && (type - 0x9dn) % 0x7fn === 0n) return true
  return false
}

/**
 * Whether `transportDraft` defines `type` as a Track property: 0x02, 0x04,
 * Immutable Properties 0x0B, 0x0E, 0x22 and 0x30 (16 on), 0x06 (18 on), grease
 * types (17 on).
 */
export function isTransportTrackProperty(type: bigint, transportDraft: TransportDraft): boolean {
  const draft = Number(transportDraft)
  if (draft < 16) return false
  if (TRANSPORT_TRACK_TYPES.has(type)) return true
  if (draft >= 18 && type === 0x06n) return true
  if (draft >= 17 && type >= 0x9dn && (type - 0x9dn) % 0x7fn === 0n) return true
  return false
}

const TRANSPORT_TRACK_TYPES = new Set([0x02n, 0x04n, IMMUTABLE_PROPERTIES, 0x0en, 0x22n, 0x30n])

function hasImmutableProperties(transportDraft: TransportDraft | undefined): boolean {
  return transportDraft !== undefined && Number(transportDraft) >= 14
}

/** A property as `@moqtap/codec` reads it */
export interface LocPropertyInput {
  type: bigint
  value?: bigint
  bytes?: Uint8Array
  /** The contents of Immutable Properties */
  properties?: readonly LocPropertyInput[]
}

/** A property type as seen on an object, and where */
export interface LocPropertyType {
  type: bigint
  /** Carried inside Immutable Properties */
  immutable: boolean
}

/**
 * The distinct property types of one object that count toward its track's LOC
 * profile: every type the transport draft does not define at Object scope,
 * including those inside Immutable Properties. Without a transport draft,
 * every type counts.
 */
export function locPropertyTypes(
  properties: readonly LocPropertyInput[],
  transportDraft?: TransportDraft,
): LocPropertyType[] {
  const types = new Map<string, LocPropertyType>()
  const visit = (list: readonly LocPropertyInput[], immutable: boolean) => {
    for (const p of list) {
      if (transportDraft !== undefined && isTransportObjectProperty(p.type, transportDraft)) {
        if (
          p.type === IMMUTABLE_PROPERTIES &&
          p.properties &&
          hasImmutableProperties(transportDraft)
        ) {
          visit(p.properties, true)
        }
        continue
      }
      types.set(`${immutable}:${p.type}`, { type: p.type, immutable })
    }
  }
  visit(properties, false)
  return [...types.values()]
}

// ─── Resolution ──────────────────────────────────────────────────────

/**
 * The profiles that define every one of `propertyTypes` where it was seen,
 * after removing the types `transportDraft` defines at Object scope.
 */
export function possibleProfiles(
  propertyTypes: readonly LocPropertyType[],
  transportDraft?: TransportDraft,
): LocProfile[] {
  const types = propertyTypes.filter(
    (t) => transportDraft === undefined || !isTransportObjectProperty(t.type, transportDraft),
  )
  return LOC_PROFILES.filter((p) =>
    types.every((t) => definitions(p, t.type, t.immutable).length > 0),
  )
}

/** One profile, or the candidates when the property IDs do not settle it */
export type LocResolution = { profile: LocProfile } | { candidates: LocProfile[] }

/** A pin always wins; otherwise one possible profile is the profile. */
export function resolveProfile(
  possible: readonly LocProfile[],
  pinned?: LocProfile,
): LocResolution {
  if (pinned !== undefined) return { profile: pinned }
  if (possible.length === 1) return { profile: possible[0]! }
  return { candidates: [...possible] }
}

// ─── Property decoding ───────────────────────────────────────────────

export interface FrameMarking {
  /** The RFC 9626 form: 1 (S E I D B TID), 2 (+ LID) or 3 (+ TL0PICIDX) octets */
  octets: 1 | 2 | 3
  startOfFrame: boolean
  endOfFrame: boolean
  independent: boolean
  discardable: boolean
  baseLayerSync: boolean
  temporalId: number
  layerId?: number
  tl0PicIdx?: number
}

export interface AudioLevel {
  /** 0 to 127 */
  level: number
  /** 0 to -127; -127 is digital silence */
  dBov: number
  voiceActivity: boolean
}

export interface AvcConfig {
  codec: 'h264'
  profile: number
  compatibility: number
  level: number
  /** Bytes in each NAL unit length field */
  lengthSize: number
  spsCount: number
  ppsCount: number
}

export interface HevcConfig {
  codec: 'h265'
  profileSpace: number
  tier: number
  profile: number
  level: number
  /** Bytes in each NAL unit length field */
  lengthSize: number
  /** NAL unit count per array, by NAL unit type */
  arrays: { nalType: number; count: number }[]
}

export type VideoConfig = AvcConfig | HevcConfig

export type LocDecoded =
  | { kind: 'capture-timestamp'; microseconds: bigint }
  /**
   * `timescales` holds the distinct Timescale values known for the object.
   * Empty means none: the drafts then read the value as wall-clock
   * microseconds since the Unix epoch.
   */
  | { kind: 'timestamp'; value: bigint; timescales: bigint[] }
  | { kind: 'timescale'; unitsPerSecond: bigint }
  /** One candidate when the form is known, several when the value fits several */
  | { kind: 'video-frame-marking'; candidates: FrameMarking[] }
  | ({ kind: 'audio-level' } & AudioLevel)
  | { kind: 'video-config'; config: VideoConfig }

export interface LocPropertyResult {
  type: bigint
  /** The value of an even type, the bytes of an odd one */
  raw: bigint | Uint8Array | undefined
  /** Defined by the transport draft at Object scope; not read as LOC */
  transport?: true
  /** Carried inside Immutable Properties */
  immutable?: true
  /** Set when the profile, or every candidate, gives the type one meaning */
  name?: string
  meaning?: LocMeaning
  decoded?: LocDecoded
  /** The draft admits the value but defines no reading for it */
  uninterpreted?: true
  /**
   * The value is outside what the draft states: `invalid_length` for an odd
   * type's length, `out_of_range` for an even type's value
   */
  error?: 'invalid_length' | 'out_of_range'
  /**
   * The meanings per profile, when they differ or a profile gives two, or
   * when the profiles agree on the meaning but not on whether the value is
   * within what they state. From transport draft 19, a 0x02 or 0x06 that a
   * profile defines lists OBJECT_ or SUBGROUP_DELIVERY_TIMEOUT beside it.
   */
  ambiguous?: LocMeanings[]
}

/** The names a profile gives one property type; empty when it defines none */
export interface LocMeanings {
  profile: LocProfile
  meanings: string[]
  /** The value is outside what this profile states */
  error?: 'invalid_length' | 'out_of_range'
}

export interface DecodeLocOptions {
  transportDraft?: TransportDraft
  /** The Timescales the track's Track Properties carry, from {@link decodeLocTrackProperties} */
  trackTimescales?: readonly bigint[]
  /** The track's codec string, from the catalog; Video Config is decoded for avc1, avc3, hvc1 and hev1 */
  videoCodec?: string
}

interface ProfileDefinition {
  profile: LocProfile
  definition: LocPropertyDefinition
}

/**
 * Each profile's definition, when every profile of the resolution gives the
 * type the same meaning and encoding, or the disagreement
 */
function meaningOf(
  resolution: LocResolution,
  type: bigint,
  immutable: boolean,
  scope: 'object' | 'track',
): { definitions: ProfileDefinition[] } | { ambiguous: LocMeanings[] } | null {
  const perProfile = profilesOf(resolution).map((profile) => ({
    profile,
    defs: definitions(profile, type, immutable, scope),
  }))
  if (perProfile.every((p) => p.defs.length === 0)) return null
  const first = perProfile[0]!.defs[0]
  const agreed =
    first !== undefined &&
    perProfile.every(
      (p) =>
        p.defs.length === 1 &&
        p.defs[0]!.meaning === first.meaning &&
        p.defs[0]!.encoding === first.encoding,
    )
  if (agreed) {
    return { definitions: perProfile.map((p) => ({ profile: p.profile, definition: p.defs[0]! })) }
  }
  return {
    ambiguous: perProfile.map((p) => ({ profile: p.profile, meanings: p.defs.map((d) => d.name) })),
  }
}

function profilesOf(resolution: LocResolution): LocProfile[] {
  return 'profile' in resolution ? [resolution.profile] : resolution.candidates
}

/**
 * From draft-19, 0x02 and 0x06 are also OBJECT_ and SUBGROUP_DELIVERY_TIMEOUT
 * at Object scope (draft-19 Sections 12.1-12.2), also inside Immutable
 * Properties (draft-22 Section 10.7). The readings per profile when some
 * profile of the resolution defines the type where it was seen; null otherwise.
 */
function deliveryTimeoutReadings(
  resolution: LocResolution,
  type: bigint,
  immutable: boolean,
  transportDraft: TransportDraft,
): LocMeanings[] | null {
  const draft = Number(transportDraft)
  if (draft < 19 || (type !== 0x02n && type !== 0x06n)) return null
  const perProfile = profilesOf(resolution).map((profile) => ({
    profile,
    names: definitions(profile, type, immutable).map((d) => d.name),
  }))
  if (perProfile.every((p) => p.names.length === 0)) return null
  const section = (draft >= 21 ? 10 : 12) + (type === 0x06n ? '.1' : '.2')
  const name = type === 0x06n ? 'SUBGROUP_DELIVERY_TIMEOUT' : 'OBJECT_DELIVERY_TIMEOUT'
  const timeout = `${name} (draft-${transportDraft} Section ${section})`
  return perProfile.map((p) => ({ profile: p.profile, meanings: [timeout, ...p.names] }))
}

interface FlatProperty {
  p: LocPropertyInput
  immutable: boolean
  transport: boolean
}

/** The properties, each Immutable Properties followed by its contents. */
function flatten(
  properties: readonly LocPropertyInput[],
  isTransport: (type: bigint) => boolean,
  transportDraft: TransportDraft | undefined,
): FlatProperty[] {
  const flat: FlatProperty[] = []
  for (const p of properties) {
    const transport = isTransport(p.type)
    flat.push({ p, immutable: false, transport })
    if (
      transport &&
      p.type === IMMUTABLE_PROPERTIES &&
      p.properties &&
      hasImmutableProperties(transportDraft)
    ) {
      for (const inner of p.properties) {
        flat.push({ p: inner, immutable: true, transport: isTransport(inner.type) })
      }
    }
  }
  return flat
}

type ReadProperty = { result: LocPropertyResult; definitions: ProfileDefinition[] | undefined }

function readProperty(
  { p, immutable, transport }: FlatProperty,
  resolution: LocResolution,
  scope: 'object' | 'track',
  transportDraft: TransportDraft | undefined,
): ReadProperty {
  const result: LocPropertyResult = { type: p.type, raw: p.bytes ?? p.value }
  if (immutable) result.immutable = true
  if (transport) {
    const readings =
      scope === 'object'
        ? deliveryTimeoutReadings(resolution, p.type, immutable, transportDraft!)
        : null
    if (readings === null) result.transport = true
    else result.ambiguous = readings
    return { result, definitions: undefined }
  }
  const meaning = meaningOf(resolution, p.type, immutable, scope)
  if (meaning === null) return { result, definitions: undefined }
  if ('ambiguous' in meaning) {
    result.ambiguous = meaning.ambiguous
    return { result, definitions: undefined }
  }
  const { definition } = meaning.definitions[0]!
  result.name = definition.name
  result.meaning = definition.meaning
  return { result, definitions: meaning.definitions }
}

/**
 * Decode one object's properties under a resolution. A property is decoded
 * when the profile, or every candidate profile, gives its type the same
 * meaning and encoding and the same verdict on its value; otherwise it is
 * left raw, with the meanings listed.
 *
 * A Timestamp is read with every distinct Timescale of the object and of
 * `trackTimescales`: the drafts give neither precedence.
 */
export function decodeLocProperties(
  properties: readonly LocPropertyInput[],
  resolution: LocResolution,
  options: DecodeLocOptions = {},
): LocPropertyResult[] {
  const { transportDraft } = options
  const isTransport = (type: bigint) =>
    transportDraft !== undefined && isTransportObjectProperty(type, transportDraft)
  const results = flatten(properties, isTransport, transportDraft).map((f) =>
    readProperty(f, resolution, 'object', transportDraft),
  )

  const timescales = new Set<bigint>(options.trackTimescales ?? [])
  for (const { result, definitions } of results) {
    if (definitions?.[0]?.definition.meaning === 'timescale' && typeof result.raw === 'bigint')
      timescales.add(result.raw)
  }

  for (const { result, definitions } of results) {
    if (definitions === undefined) continue
    decodeInto(result, definitions, [...timescales], options.videoCodec)
  }
  return results.map((r) => r.result)
}

export interface DecodeLocTrackOptions {
  transportDraft?: TransportDraft
  /** The track's codec string, from the catalog; Video Config is decoded for avc1, avc3, hvc1 and hev1 */
  videoCodec?: string
}

/**
 * Decode a track's Track Properties (draft-16 Track Extensions) under a
 * resolution, as {@link decodeLocProperties} does an object's. Only the
 * properties a profile defines at Track scope (LOC-04 6.1: Timescale, Video
 * Config, Audio Config; LOC-02, LOC-03 6.1: Timescale) are read as LOC.
 */
export function decodeLocTrackProperties(
  properties: readonly LocPropertyInput[],
  resolution: LocResolution,
  options: DecodeLocTrackOptions = {},
): LocPropertyResult[] {
  const { transportDraft } = options
  const isTransport = (type: bigint) =>
    transportDraft !== undefined && isTransportTrackProperty(type, transportDraft)
  const results = flatten(properties, isTransport, transportDraft).map((f) =>
    readProperty(f, resolution, 'track', transportDraft),
  )
  for (const { result, definitions } of results) {
    if (definitions === undefined) continue
    decodeInto(result, definitions, [], options.videoCodec)
  }
  return results.map((r) => r.result)
}

/** Whether `raw` is outside the size `definition` states */
function limitError(
  definition: LocPropertyDefinition,
  raw: bigint | Uint8Array,
): 'invalid_length' | 'out_of_range' | undefined {
  if (typeof raw === 'bigint') {
    return definition.maxValue !== undefined && raw > definition.maxValue
      ? 'out_of_range'
      : undefined
  }
  const range = definition.lengthRange
  return range !== undefined && (raw.length < range[0] || raw.length > range[1])
    ? 'invalid_length'
    : undefined
}

function decodeInto(
  result: LocPropertyResult,
  definitions: ProfileDefinition[],
  timescales: bigint[],
  videoCodec: string | undefined,
): void {
  const { raw } = result
  const { definition } = definitions[0]!
  if (definition.encoding === 'declared-bytes' || definition.encoding === 'reference') {
    result.uninterpreted = true
    return
  }
  if (definition.encoding === 'varint' ? typeof raw !== 'bigint' : !(raw instanceof Uint8Array))
    return
  const errors = definitions.map((d) => limitError(d.definition, raw!))
  if (errors.some((e) => e !== errors[0])) {
    result.ambiguous = definitions.map((d, i) => ({
      profile: d.profile,
      meanings: [d.definition.name],
      ...(errors[i] !== undefined ? { error: errors[i] } : {}),
    }))
    return
  }
  if (errors[0] !== undefined) {
    result.error = errors[0]
    return
  }
  let decoded: LocDecoded | null | undefined
  if (typeof raw === 'bigint') {
    switch (definition.meaning) {
      case 'capture-timestamp':
        decoded = { kind: 'capture-timestamp', microseconds: raw }
        break
      case 'timestamp':
        decoded = { kind: 'timestamp', value: raw, timescales: [...timescales] }
        break
      case 'timescale':
        decoded = { kind: 'timescale', unitsPerSecond: raw }
        break
      case 'video-frame-marking': {
        const candidates = decodeFrameMarkingVarint(raw)
        decoded = candidates && { kind: 'video-frame-marking', candidates }
        break
      }
      case 'audio-level': {
        const level = decodeAudioLevel(raw)
        decoded = level && { kind: 'audio-level', ...level }
        break
      }
    }
  } else if (raw instanceof Uint8Array) {
    switch (definition.meaning) {
      case 'video-frame-marking': {
        const candidates = decodeFrameMarkingBytes(raw)
        decoded = candidates && { kind: 'video-frame-marking', candidates }
        break
      }
      // The config bytes are the codec's own; read only when the codec is known.
      case 'video-config': {
        const config = videoCodec !== undefined ? decodeVideoConfig(raw, videoCodec) : null
        if (config !== null) decoded = { kind: 'video-config', config }
        break
      }
    }
  }
  if (decoded === null) result.uninterpreted = true
  else if (decoded !== undefined) result.decoded = decoded
}

// ─── Frame Marking (RFC 9626 Section 3) ──────────────────────────────

function frameMarking(octets: number[]): FrameMarking {
  const b = octets[0]!
  const marking: FrameMarking = {
    octets: octets.length as 1 | 2 | 3,
    startOfFrame: (b & 0x80) !== 0,
    endOfFrame: (b & 0x40) !== 0,
    independent: (b & 0x20) !== 0,
    discardable: (b & 0x10) !== 0,
    baseLayerSync: (b & 0x08) !== 0,
    temporalId: b & 0x07,
  }
  if (octets.length >= 2) marking.layerId = octets[1]!
  if (octets.length === 3) marking.tl0PicIdx = octets[2]!
  return marking
}

/**
 * Frame Marking carried with a length (ietf-03/04): the length gives the form.
 * One octet reads as S E I D B TID, which also covers the short form (3.2),
 * whose low bits are zero. Null for any length but 1 to 3.
 */
export function decodeFrameMarkingBytes(bytes: Uint8Array): FrameMarking[] | null {
  if (bytes.length < 1 || bytes.length > 3) return null
  return [frameMarking([...bytes])]
}

/**
 * Frame Marking in the least significant bits of a varint (ietf-00/01/02),
 * taken as the octets in order. The form is not carried, so a value that fits
 * several forms gives each: below 2^8 the 1-, 2- and 3-octet forms, below 2^16
 * the 2- and 3-octet forms. Null from 2^24.
 */
export function decodeFrameMarkingVarint(value: bigint): FrameMarking[] | null {
  if (value < 0n || value >= 1n << 24n) return null
  const v = Number(value)
  const b2 = v >> 16
  const b1 = (v >> 8) & 0xff
  const b0 = v & 0xff
  if (v >= 1 << 16) return [frameMarking([b2, b1, b0])]
  if (v >= 1 << 8) return [frameMarking([b1, b0]), frameMarking([0, b1, b0])]
  return [frameMarking([b0]), frameMarking([0, b0]), frameMarking([0, 0, b0])]
}

// ─── Audio Level (RFC 6464 Section 3) ────────────────────────────────

/**
 * The RFC 6464 octet in the low 8 bits of a varint (ietf-00..04): V, then the
 * level in -dBov. Null above 0xFF.
 */
export function decodeAudioLevel(value: bigint): AudioLevel | null {
  if (value < 0n || value > 0xffn) return null
  const b = Number(value)
  const level = b & 0x7f
  return { level, dBov: level === 0 ? 0 : -level, voiceActivity: (b & 0x80) !== 0 }
}

// ─── Video Config ────────────────────────────────────────────────────

/** `h264` for avc1/avc3, `h265` for hvc1/hev1, else null */
export function videoCodecFamily(codec: string): 'h264' | 'h265' | null {
  const fourcc = codec.split('.')[0]
  if (fourcc === 'avc1' || fourcc === 'avc3') return 'h264'
  if (fourcc === 'hvc1' || fourcc === 'hev1') return 'h265'
  return null
}

/**
 * Video Config is the WebCodecs VideoDecoderConfig.description: for H.264 an
 * AVCDecoderConfigurationRecord (ISO/IEC 14496-15 5.3.3.1), for H.265 an
 * HEVCDecoderConfigurationRecord (8.3.3.1). Null when the codec is neither, or
 * the record does not parse.
 */
export function decodeVideoConfig(bytes: Uint8Array, codec: string): VideoConfig | null {
  const family = videoCodecFamily(codec)
  if (family === 'h264') return parseAvcC(bytes)
  if (family === 'h265') return parseHvcC(bytes)
  return null
}

function parseAvcC(d: Uint8Array): AvcConfig | null {
  if (d.length < 7 || d[0] !== 1) return null
  let i = 6
  const spsCount = d[5]! & 0x1f
  for (let n = 0; n < spsCount; n++) {
    if (i + 2 > d.length) return null
    i += 2 + ((d[i]! << 8) | d[i + 1]!)
  }
  if (i >= d.length) return null
  const ppsCount = d[i]!
  i++
  for (let n = 0; n < ppsCount; n++) {
    if (i + 2 > d.length) return null
    i += 2 + ((d[i]! << 8) | d[i + 1]!)
  }
  if (i > d.length) return null
  return {
    codec: 'h264',
    profile: d[1]!,
    compatibility: d[2]!,
    level: d[3]!,
    lengthSize: (d[4]! & 0x03) + 1,
    spsCount,
    ppsCount,
  }
}

function parseHvcC(d: Uint8Array): HevcConfig | null {
  if (d.length < 23 || d[0] !== 1) return null
  const arrays: HevcConfig['arrays'] = []
  let i = 23
  for (let a = 0; a < d[22]!; a++) {
    if (i + 3 > d.length) return null
    const nalType = d[i]! & 0x3f
    const count = (d[i + 1]! << 8) | d[i + 2]!
    i += 3
    for (let n = 0; n < count; n++) {
      if (i + 2 > d.length) return null
      i += 2 + ((d[i]! << 8) | d[i + 1]!)
    }
    if (i > d.length) return null
    arrays.push({ nalType, count })
  }
  return {
    codec: 'h265',
    profileSpace: d[1]! >> 6,
    tier: (d[1]! >> 5) & 1,
    profile: d[1]! & 0x1f,
    level: d[12]!,
    lengthSize: (d[21]! & 0x03) + 1,
    arrays,
  }
}

// ─── Payload framing (H.264 / H.265) ─────────────────────────────────

export interface NalFraming {
  /** `mixed`: length-prefixed NAL units, then a length of 1 starts start-code framing */
  framing: 'start-code' | 'length-prefixed' | 'mixed'
  /** Bytes in each length field, for `length-prefixed` and `mixed` */
  lengthSize?: number
  /** A 3-byte start code is present */
  threeByteStartCodes?: true
  /** The type of every NAL unit, in order */
  nalTypes: number[]
  /** An H.264 IDR or H.265 IRAP NAL unit is present */
  keyframe: boolean
}

export type LocPayloadFraming = NalFraming | { framing: 'ambiguous'; candidates: NalFraming[] }

/**
 * How an H.264 or H.265 LOC payload delimits its NAL units (LOC 2.1.3-2.1.4):
 * start codes, or big-endian lengths of `config.lengthSize` bytes (4 without a
 * config), where a 4-byte length of 1 is a start code. Every NAL header must
 * be valid for the codec. Null when the payload fits neither framing.
 *
 * 3-byte start codes are read and marked: 2.1.4 makes 4 bytes a SHOULD, and
 * 3 bytes a MAY only on a track that never uses length prefixes or a Video
 * Config, which one payload cannot show.
 *
 * The payload is read from its first byte. Under ietf-02..04 an object payload
 * may begin with LOC Private Properties, whose framing those drafts do not
 * specify outside Secure Objects.
 */
export function analyzeLocPayload(
  payload: Uint8Array,
  codec: 'h264' | 'h265',
  config?: Pick<VideoConfig, 'lengthSize'>,
): LocPayloadFraming | null {
  const found: NalFraming[] = []
  const startCode = readStartCodeFraming(payload, 0, codec)
  if (startCode !== null) found.push({ framing: 'start-code', ...startCode })
  const lengthSize = config?.lengthSize ?? 4
  const lengths = readLengthFraming(payload, codec, lengthSize)
  // A first length of 1 is the start-code framing already found.
  if (lengths !== null && !(lengthSize === 4 && readUint(payload, 0, 4) === 1)) {
    found.push(lengths)
  }
  if (found.length === 0) return null
  if (found.length === 1) return found[0]!
  return { framing: 'ambiguous', candidates: found }
}

function readUint(d: Uint8Array, at: number, size: number): number {
  let v = 0
  for (let k = 0; k < size; k++) v = v * 256 + d[at + k]!
  return v
}

function validNal(
  d: Uint8Array,
  start: number,
  end: number,
  codec: 'h264' | 'h265',
): number | null {
  if (codec === 'h264') {
    if (end - start < 1) return null
    const b = d[start]!
    const type = b & 0x1f
    return (b & 0x80) === 0 && H264_KNOWN.has(type) ? type : null
  }
  if (end - start < 2) return null
  const b0 = d[start]!
  const type = (b0 >> 1) & 0x3f
  // forbidden_zero_bit 0, nuh_temporal_id_plus1 not 0 (H.265 7.4.2.2)
  return (b0 & 0x80) === 0 && (d[start + 1]! & 0x07) !== 0 && isKnownH265(type) ? type : null
}

function isKeyframe(codec: 'h264' | 'h265', type: number): boolean {
  return codec === 'h264' ? type === H264_IDR : isH265Irap(type)
}

/**
 * Start-code framing from `at`, which must hold a start code. A NAL unit ends
 * where 00 00 00, 00 00 01 or 00 00 02 begins (H.264/H.265 7.4.2); zeros after
 * it are trailing_zero_8bits.
 */
function readStartCodeFraming(
  d: Uint8Array,
  at: number,
  codec: 'h264' | 'h265',
): Omit<NalFraming, 'framing'> | null {
  const nalTypes: number[] = []
  let keyframe = false
  let threeByte = false
  let i = at
  let first = true
  while (i < d.length) {
    // A start code: two or more zero bytes, then 01.
    let zeros = 0
    while (i + zeros < d.length && d[i + zeros] === 0) zeros++
    if (i + zeros === d.length && !first) break
    if (zeros < 2 || d[i + zeros] !== 1) return null
    if (first && zeros !== 2 && zeros !== 3) return null
    if (zeros === 2) threeByte = true
    first = false
    const start = i + zeros + 1
    let end = start
    while (end + 2 < d.length && !(d[end] === 0 && d[end + 1] === 0 && d[end + 2]! <= 2)) end++
    if (end + 2 >= d.length) end = d.length
    const type = validNal(d, start, end, codec)
    if (type === null) return null
    nalTypes.push(type)
    if (isKeyframe(codec, type)) keyframe = true
    i = end
  }
  if (nalTypes.length === 0) return null
  const result: Omit<NalFraming, 'framing'> = { nalTypes, keyframe }
  if (threeByte) result.threeByteStartCodes = true
  return result
}

function readLengthFraming(
  d: Uint8Array,
  codec: 'h264' | 'h265',
  lengthSize: number,
): NalFraming | null {
  const nalTypes: number[] = []
  let keyframe = false
  let i = 0
  while (i < d.length) {
    if (i + lengthSize > d.length) return null
    const length = readUint(d, i, lengthSize)
    if (lengthSize === 4 && length === 1) {
      // LOC 2.1.3: a length of 1 is a start code; the rest is start-code framed.
      const rest = readStartCodeFraming(d, i, codec)
      if (rest === null) return null
      return {
        framing: nalTypes.length === 0 ? 'start-code' : 'mixed',
        lengthSize,
        ...(rest.threeByteStartCodes ? { threeByteStartCodes: true as const } : {}),
        nalTypes: [...nalTypes, ...rest.nalTypes],
        keyframe: keyframe || rest.keyframe,
      }
    }
    const start = i + lengthSize
    const end = start + length
    if (length === 0 || end > d.length) return null
    const type = validNal(d, start, end, codec)
    if (type === null) return null
    nalTypes.push(type)
    if (isKeyframe(codec, type)) keyframe = true
    i = end
  }
  if (nalTypes.length === 0) return null
  return { framing: 'length-prefixed', lengthSize, nalTypes, keyframe }
}
