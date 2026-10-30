/**
 * What catalog and timeline problems share: the rule each breaks as data
 * (draft, revision, section, keyword and the sentence that states it), and
 * the words every tool shows for a problem, so they all say the same thing.
 */

import type { JsonValue } from './catalog'

// ─── Types ───────────────────────────────────────────────────────────

/**
 * The BCP 14 keyword of a rule. `REQUIRED` is a field the draft marks
 * required; `TYPE` a value whose JSON type the draft gives. `null` when the
 * draft states the rule without a keyword.
 */
export type SpecKeyword = 'MUST' | 'MUST NOT' | 'REQUIRED' | 'TYPE' | 'SHOULD' | 'SHOULD NOT' | null

/** A section of an IETF draft, pinned to its revision. */
export interface SpecRef {
  /** `msf` is draft-ietf-moq-msf, `cmsf` draft-ietf-moq-cmsf */
  draft: 'msf' | 'cmsf'
  /** `'01'` */
  revision: string
  /** `'3.1'` */
  section: string
  keyword: SpecKeyword
  /** The sentence that states the rule, verbatim apart from line breaks and list markers */
  quote: string
}

/**
 * A problem's stable identifier, e.g. `catalog.init.other-draft-field`,
 * `catalog.track.packaging.missing`, `timeline.event.index.mixed`. An id
 * ending `.missing` is a required field that is absent, `.type` a value of
 * the wrong JSON type.
 */
export type CheckId = `catalog.${string}` | `timeline.${string}`

/** What a problem is about */
export type ProblemSubject =
  /** The whole document, or a field at its root */
  | { kind: 'root' }
  /** `tracks[index]` */
  | { kind: 'track'; index: number; name: string | null }
  /**
   * A track entry of a delta operation: `deltaUpdate[op].tracks[index]`, or
   * MSF-00's `addTracks[index]` (op counts the operation fields in order)
   */
  | {
      kind: 'delta'
      op: number
      operation: 'add' | 'remove' | 'clone' | null
      index: number | null
      name: string | null
    }
  /** `initDataList[index]`, `contentProtections[index]` */
  | { kind: 'entry'; list: 'initDataList' | 'contentProtections'; index: number }
  /** A timeline record, by its position in the document */
  | { kind: 'record'; index: number }
  /** The catalog object as carried: its Group, Subgroup and Object IDs */
  | { kind: 'object' }

/** What the data holds where the rule looked */
export type ProblemActual =
  | { kind: 'absent' }
  | { kind: 'value'; value: JsonValue }
  /** The value is absent, and the field another draft defines for it is present */
  | { kind: 'other-field'; field: string; bytes: number | null }

/** The fields catalog and timeline problems share */
export interface MediaProblem {
  /** Kept from 0.2: whether the object (or record) was refused; see `effect` */
  severity: 'error' | 'warning'
  path: string
  /** The draft and section, e.g. `CMSF-01 3.1` */
  section: string
  /** {@link problemTitle} of this problem alone */
  message: string
  id: CheckId
  /** Problems of one family on one subject show as one row */
  family: string
  spec: SpecRef
  /** Other sections the rule depends on */
  also: SpecRef[]
  /** `refused`: the object or record was not applied; `applied`: it was */
  effect: 'refused' | 'applied'
  subject: ProblemSubject
  /** The field the rule is about, relative to the subject; `null` for the subject itself */
  field: string | null
  /** What the rule asks for, in one line */
  expected: string
  actual: ProblemActual
  /** Values the wording names: a packaging value, a Group ID, a record's media time */
  values: Record<string, JsonValue>
  /** Catalog problems: the catalog's version field, and the drafts its rules came from */
  readAs?: { version: JsonValue; drafts: string[] }
}

// ─── Severity and links ─────────────────────────────────────────────

/**
 * How much a problem matters, from its rule's keyword: `error` for MUST,
 * MUST NOT, a required field or a JSON type; `warning` for SHOULD, SHOULD NOT
 * and rules stated without a keyword; `info` for `catalog.draft.ambiguous`,
 * which says which rules went unchecked.
 */
export function severityOf(p: { spec: SpecRef; id?: string }): 'error' | 'warning' | 'info' {
  if (p.id === 'catalog.draft.ambiguous') return 'info'
  switch (p.spec.keyword) {
    case 'MUST':
    case 'MUST NOT':
    case 'REQUIRED':
    case 'TYPE':
      return 'error'
    default:
      return 'warning'
  }
}

/** `https://datatracker.ietf.org/doc/html/draft-ietf-moq-cmsf-01#section-3.1` */
export function specUrl(ref: { draft: string; revision: string; section: string }): string {
  const name = ref.draft === 'moqt' ? 'transport' : ref.draft
  return `https://datatracker.ietf.org/doc/html/draft-ietf-moq-${name}-${ref.revision}#section-${ref.section}`
}

/** `CMSF-01 3.1` */
export function specLabel(ref: SpecRef): string {
  return `${ref.draft.toUpperCase()}-${ref.revision} ${ref.section}`
}

// ─── Rules as data ──────────────────────────────────────────────────

type Rule = readonly [section: string, keyword: SpecKeyword, quote: string]

/** A rule by draft: `msf-00`, `msf-01`, `cmsf-00`, `cmsf-01` */
type RuleSet = Partial<Record<'msf-00' | 'msf-01' | 'cmsf-00' | 'cmsf-01', Rule>>

const CATALOG_IS_JSON =
  'A catalog is a JSON [JSON] document, comprised of a series of mandatory and optional fields.'
const REMOVE_ENTRY_00 =
  'Each track object MUST include a Track Name Section 5.1.11 field, MAY include a Track Namespace Section 5.1.10 field and MUST NOT hold any other fields.'
const REMOVE_ENTRY_01 =
  'Each track object MUST include a Track Name Section 5.2.3 field, MAY include a Track Namespace Section 5.2.2 field, and MUST NOT hold any other fields.'
const PARENT_ONLY_IN_CLONE_01 =
  'This field MUST only be included inside a clone operation in a delta update Section 5.1.6.'
const AUDIO_FIELDS_01 = 'This property MUST accompany tracks for which audio codecs are specified.'
const CMSF_INIT_00 =
  'The header for a given MOQT Track MUST be packaged by encoding the header using [BASE64] and then inserting that payload as the value of the Initialization data "initData" field in the catalog entry for that Track.'
const CMSF_INIT_01 =
  'The header for a given MOQT Track MUST be added to the catalog by generating an initDataList entry with a "type" of "inline", a "data" value of the header encoded using [BASE64] and an "id" which is unique across the initDataList items.'
const SAP_TIMELINE_CATALOG =
  "In the catalog, the SAP-type timeline track MUST include a 'packaging' value of 'eventtimeline\" and MUST include an 'eventType' value of 'org.ietf.moq.cmsf.sap'."
const NOT_LIVE_AGAIN = 'A True value MUST never follow a False value.'
const FIXED_TRACK =
  'The tuple of Track Namespace and Track Name defines a fixed set of Track attributes which MUST NOT be modified after being declared.'

/** Rules stated in a sentence, by name */
const RULES = {
  json: { 'msf-00': ['5.1', 'TYPE', CATALOG_IS_JSON], 'msf-01': ['5', 'TYPE', CATALOG_IS_JSON] },
  versionUnsupported: {
    'msf-00': [
      '5.1.1',
      'MUST NOT',
      'A subscriber MUST NOT attempt to parse a catalog version which it does not understand.',
    ],
    'msf-01': [
      '5.1.1',
      'MUST NOT',
      'A subscriber MUST NOT attempt to parse a catalog version which it does not understand.',
    ],
  },
  isCompleteFalse: {
    'msf-00': ['5.1.7', 'MUST NOT', 'This field MUST NOT be included if it is FALSE.'],
    'msf-01': ['5.1.3', 'MUST NOT', 'This field MUST NOT be included if it is FALSE.'],
  },
  isCompleteRemoved: {
    'msf-00': [
      '5.1.7',
      'MUST NOT',
      'This field MUST NOT be removed from a catalog once it has been added.',
    ],
    'msf-01': [
      '5.1.3',
      'MUST NOT',
      'This field MUST NOT be removed from a catalog once it has been added.',
    ],
  },
  isCompleteNoNewTracks: {
    'msf-00': [
      '5.1.7',
      null,
      'This is a commitment that all tracks are complete, no new tracks will be added and no new content will be published.',
    ],
    'msf-01': [
      '5.1.3',
      null,
      'This is a commitment that all tracks are complete, no new tracks will be added to the catalog, and no new content will be published on any track.',
    ],
  },
  uniqueNames: {
    'msf-00': ['5.1.11', 'MUST', 'Within the catalog, track names MUST be unique per namespace.'],
    'msf-01': ['5.2.3', 'MUST', 'Within the catalog, track names MUST be unique per namespace.'],
  },
  trackObject: {
    'msf-00': [
      '5.1.9',
      'TYPE',
      "A track object is JSON Object containing a collection of fields whose location is specified 'T' in Table 2.",
    ],
    'msf-01': [
      '5.2.1',
      'TYPE',
      'A track object is a JSON Object containing a collection of fields whose location is specified in Table 2.',
    ],
  },
  packagingAllowed: {
    'msf-00': ['5.1.12', null, 'Allowed values are strings as defined in Table 3.'],
    'msf-01': ['5.2.4', null, 'Allowed values are strings as defined in Table 3.'],
    'cmsf-00': [
      '3.5.1',
      null,
      'This specification extends the allowed packaging values defined in [MSF] to include one new entry, as defined in Table 1 below:',
    ],
    'cmsf-01': [
      '3.5.1',
      null,
      'This specification extends the allowed packaging values defined in [MSF] to include one new entry, as defined in Table 1 below:',
    ],
  },
  eventTypeRequired: {
    'msf-00': [
      '5.1.13',
      'REQUIRED',
      'This field is required if the Section 5.1.12 value is "eventtimeline".',
    ],
    'msf-01': [
      '5.2.5',
      'REQUIRED',
      'This field is required if the Section 5.2.4 value is "eventtimeline".',
    ],
  },
  eventTypeForbidden: {
    'msf-00': [
      '5.1.13',
      'MUST NOT',
      'This field MUST NOT be used if the packaging value is not "eventtimeline".',
    ],
    'msf-01': [
      '5.2.5',
      'MUST NOT',
      'This field MUST NOT be used if the packaging value is not "eventtimeline".',
    ],
  },
  targetLatencyNotLive: {
    'msf-00': ['5.1.16', 'MUST NOT', 'This field MUST NOT be included if isLive is FALSE.'],
  },
  buffersWithLatency: {
    'msf-01': [
      '5.2.9',
      'MUST NOT',
      'This property MUST NOT be present if the target latency Section 5.2.8 property is present within a track definition.',
    ],
  },
  trackDurationLive: {
    'msf-00': [
      '5.1.37',
      'MUST NOT',
      'This field MUST NOT be included if the isLive Section 5.1.15 field value is true.',
    ],
    'msf-01': [
      '5.2.35',
      'MUST NOT',
      'This field MUST NOT be included if the isLive Section 5.2.7 field value is true.',
    ],
  },
  parentName: {
    'msf-00': [
      '5.1.36',
      'MUST',
      'This field MUST only be included inside a Clone tracks Section 5.1.5 object.',
    ],
    'msf-01': ['5.2.33', 'MUST', PARENT_ONLY_IN_CLONE_01],
  },
  parentNamespace: { 'msf-01': ['5.2.34', 'MUST', PARENT_ONLY_IN_CLONE_01] },
  codec: {
    'msf-01': [
      '5.2.18',
      'MUST',
      'This property MUST be specified for tracks which have an inherent codec associated with them (e.g., audio and video tracks).',
    ],
  },
  bitrate: {
    'msf-01': ['5.2.22', 'MUST', 'This property MUST be specified for audio and video tracks.'],
  },
  samplerate: { 'msf-01': ['5.2.28', 'MUST', AUDIO_FIELDS_01] },
  channelConfig: { 'msf-01': ['5.2.29', 'MUST', AUDIO_FIELDS_01] },
  cipherSuite: {
    'msf-01': ['5.2.39', 'MUST', 'This field MUST be present when encryptionScheme is specified.'],
  },
  initDataBase64: {
    'msf-00': [
      '5.1.20',
      null,
      'A string holding Base64 [BASE64] encoded initialization data for the track.',
    ],
    'cmsf-00': ['3.1', 'MUST', CMSF_INIT_00],
  },
  cmsfInit: { 'cmsf-00': ['3.1', 'MUST', CMSF_INIT_00], 'cmsf-01': ['3.1', 'MUST', CMSF_INIT_01] },
  initDataField: {
    'msf-00': [
      '5.1.20',
      null,
      'A string holding Base64 [BASE64] encoded initialization data for the track.',
    ],
  },
  initDataList: {
    'msf-01': ['5.1.7', null, 'Each initialization reference object has the following fields:'],
  },
  initDataListAfterTracks: {
    'msf-01': [
      '5.1.7',
      'MUST',
      'The Initialization Data List, if present, MUST be located after the tracks array in the root of the JSON catalog.',
    ],
  },
  initDataListId: {
    'msf-01': [
      '5.1.7',
      null,
      'id : a string defining a reference to this initialization data which is unique within the scope of the catalog.',
    ],
    'cmsf-01': ['3.1', 'MUST', CMSF_INIT_01],
  },
  initDataListType: {
    'msf-01': ['5.1.7', null, 'type: as string defining the type of reference.'],
  },
  initDataListInline: {
    'msf-01': ['5.1.7', null, 'data: a string holding the init payload as defined by the type.'],
  },
  initRef: {
    'msf-01': [
      '5.2.13',
      null,
      'A string pointing at the id field of an entry in the Initialization Data List Section 5.1.7.',
    ],
  },
  maxGrpSap: {
    'cmsf-00': [
      '3.4',
      'MUST',
      'Each MOQT Group MUST begin with an Object containing a stream access point (SAP type 1 or 2).',
    ],
    'cmsf-01': [
      '3.4',
      'MUST',
      'Each MOQT Group MUST begin with an Object containing a stream access point (SAP) type 1 or 2.',
    ],
  },
  maxGrpSapField: {
    'cmsf-00': [
      '3.5.2.1',
      null,
      'A number indicating the maximum SAP type the MOQT Groups in the track start with.',
    ],
    'cmsf-01': [
      '3.5.2.1',
      null,
      'A number indicating the maximum SAP type the MOQT Groups in the track start with.',
    ],
  },
  sapTimelineCatalog: {
    'cmsf-00': ['3.6.1', 'MUST', SAP_TIMELINE_CATALOG],
    'cmsf-01': ['3.6.1', 'MUST', SAP_TIMELINE_CATALOG],
  },
  contentProtectionsAtTrack: {
    'cmsf-01': [
      '4.1.1',
      'MUST NOT',
      'Content protection information MUST NOT be duplicated at the track level; all tracks reference the root-level entries.',
    ],
  },
  contentProtectionEntry: {
    'cmsf-01': ['4.1.1', null, 'Each Content Protection object contains the following fields:'],
  },
  refIdUnique: {
    'cmsf-01': ['4.1.1.1', null, 'A unique identifier for this content protection entry.'],
  },
  defaultKid: {
    'cmsf-01': [
      '4.1.1.2',
      null,
      'An array of default Key IDs (KIDs) expressed as UUID strings in the format "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx".',
    ],
  },
  scheme: {
    'cmsf-01': ['4.1.1.3', null, 'The Common Encryption protection scheme as defined in [CENC].'],
  },
  systemId: { 'cmsf-01': ['4.1.1.4.1', null, 'The DRM System ID expressed as a UUID string.'] },
  laUrl: {
    'cmsf-01': ['4.1.1.4.2', 'REQUIRED', 'url (String, Required): The URL of the license server.'],
  },
  certUrl: {
    'cmsf-01': [
      '4.1.1.4.3',
      'REQUIRED',
      'url (String, Required): The URL of the certificate server.',
    ],
  },
  pssh: {
    'cmsf-01': [
      '4.1.1.4.5',
      null,
      'A Base64-encoded [BASE64] Protection System Specific Header (PSSH) box as defined in [CENC] Section 8.1.',
    ],
  },
  contentProtectionRefs: {
    'cmsf-01': [
      '4.1.2',
      null,
      'An array of Reference ID strings (see Section 4.1.1.1) identifying which content protection entries from the root-level contentProtections array apply to this track.',
    ],
  },
  isLiveAgain: { 'msf-01': ['5.2.7', 'MUST', NOT_LIVE_AGAIN] },
  deltaFlag: {
    'msf-00': [
      '5.2',
      'MUST',
      'A delta update MUST include the Delta Update Section 5.1.2 field set to true.',
    ],
  },
  deltaOperations: {
    'msf-00': [
      '5.2',
      'MUST',
      'A delta update catalog MUST contain at least one instance of Add tracks Section 5.1.3, Remove tracks Section 5.1.4 or Clone Tracks Section 5.1.5 fields and MAY contain more.',
    ],
    'msf-01': [
      '5.3',
      'MUST',
      'A delta update MUST include the Delta Update Section 5.1.6 field with at least one operation.',
    ],
  },
  deltaForbidden: {
    'msf-00': [
      '5.2',
      'MUST NOT',
      'It MUST NOT contain an instance of a Tracks Section 5.1.8 field or an MSF version Section 5.1.1 field.',
    ],
    'msf-01': [
      '5.3',
      'MUST NOT',
      'It MUST NOT contain an instance of a Tracks Section 5.1.4 field or an MSF version Section 5.1.1 field.',
    ],
  },
  operationFields: {
    'msf-01': [
      '5.1.6',
      'MUST',
      'Each operation object MUST contain an "op" field indicating the operation type, and a "tracks" field containing an Array of track objects Section 5.2.1.',
    ],
  },
  operationTypes: { 'msf-01': ['5.1.6', null, 'The following operation types are defined:'] },
  removeEntry: {
    'msf-00': ['5.1.4', 'MUST', REMOVE_ENTRY_00],
    'msf-01': ['5.1.6', 'MUST', REMOVE_ENTRY_01],
  },
  cloneEntry: {
    'msf-00': [
      '5.1.5',
      'MUST',
      'Each track object MUST include a Parent Name Section 5.1.36 field.',
    ],
    'msf-01': [
      '5.1.6',
      'MUST',
      'Each track object MUST include a Parent Name Section 5.2.33 field and MAY include a Parent namespace Section 5.2.34 field.',
    ],
  },
  cloneName: {
    'msf-00': [
      '5.2',
      'MUST',
      'A Cloned track inherits all the attributes of the track defined by the Parent Name Section 5.1.36, except the Track Name which MUST be new.',
    ],
    'msf-01': [
      '5.1.6',
      'MUST',
      'The cloned track inherits all attributes from the parent except the Track Name which MUST be new.',
    ],
  },
  removeDeclared: {
    'msf-00': ['5.2', null, 'Remove a track that has been previously declared.'],
    'msf-01': ['5.3', null, 'Remove a track that has been previously declared.'],
  },
  fixedTrack: {
    'msf-00': ['5.2', 'MUST NOT', FIXED_TRACK],
    'msf-01': ['5.3', 'MUST NOT', FIXED_TRACK],
  },
  deltaBase: {
    'msf-00': [
      '5',
      'MUST',
      'The first catalog object published within a new group MUST be independent.',
    ],
    'msf-01': [
      '5',
      'MUST',
      'The first catalog object published within a new group MUST be independent and MUST provide a complete catalog that does not require any prior catalog object for interpretation.',
    ],
  },
  firstIndependent: {
    'msf-00': [
      '5',
      'MUST',
      'The first catalog object published within a new group MUST be independent.',
    ],
    'msf-01': [
      '5',
      'MUST',
      'The first Object (with Object ID 0) in any Group in a catalog track MUST hold an independent copy of the catalog.',
    ],
  },
  laterDelta: {
    'msf-01': [
      '5',
      'MUST',
      'All subsequent Objects within that Group (i.e Objects IDs >= 1) MUST hold a delta update.',
    ],
  },
  subgroupZero: {
    'msf-01': [
      '5',
      'MUST',
      'All catalog updates, both independent and delta, MUST be mapped to MOQT sub-group 0.',
    ],
  },
  ambiguous: {
    'cmsf-00': [
      '2',
      null,
      'All of the specifications, requirements, and terminology defined in [MSF] apply to implementations of this extension unless explicitly noted otherwise in this document.',
    ],
    'cmsf-01': [
      '2',
      null,
      'All of the specifications, requirements, and terminology defined in [MSF] apply to implementations of this extension unless explicitly noted otherwise in this document.',
    ],
  },
} satisfies Record<string, RuleSet>

export type RuleName = keyof typeof RULES

type CatalogDraftName = 'msf-00' | 'msf-01' | 'cmsf-00' | 'cmsf-01'

function toRef(draft: CatalogDraftName, rule: Rule): SpecRef {
  return {
    draft: draft.startsWith('cmsf') ? 'cmsf' : 'msf',
    revision: draft.slice(-2),
    section: rule[0],
    keyword: rule[1],
    quote: rule[2],
  }
}

/**
 * A named rule as `draft` states it. A CMSF draft falls back to the MSF
 * draft of the same revision, which it extends (cmsf 2); a draft that
 * states the rule only in its other revision gets that revision's.
 */
export function ruleRef(name: RuleName, draft: CatalogDraftName): SpecRef {
  const set: RuleSet = RULES[name]
  const msf = draft.replace('cmsf', 'msf') as CatalogDraftName
  const other = (
    draft.endsWith('00') ? draft.replace('00', '01') : draft.replace('01', '00')
  ) as CatalogDraftName
  const otherMsf = other.replace('cmsf', 'msf') as CatalogDraftName
  for (const d of [draft, msf, other, otherMsf]) {
    const rule = set[d]
    if (rule !== undefined) return toRef(d, rule)
  }
  throw new Error(`no rule ${name}`)
}

// ─── Field definitions ──────────────────────────────────────────────

/** Section, Required and JSON Type of each field, as its definition states them */
type FieldTable = Record<string, readonly [section: string, required: string, type: string]>

const MSF00_FIELDS: FieldTable = {
  version: ['5.1.1', 'Yes', 'Number'],
  deltaUpdate: ['5.1.2', 'Optional', 'Boolean'],
  addTracks: ['5.1.3', 'Optional', 'Array'],
  removeTracks: ['5.1.4', 'Optional', 'Array'],
  cloneTracks: ['5.1.5', 'Optional', 'Array'],
  generatedAt: ['5.1.6', 'Optional', 'Number'],
  isComplete: ['5.1.7', 'Optional', 'Boolean'],
  tracks: ['5.1.8', 'Yes', 'Array'],
  namespace: ['5.1.10', 'Optional', 'String'],
  name: ['5.1.11', 'Yes', 'String'],
  packaging: ['5.1.12', 'Yes', 'String'],
  eventType: ['5.1.13', 'Optional', 'String'],
  isLive: ['5.1.15', 'Yes', 'Boolean'],
  targetLatency: ['5.1.16', 'Optional', 'Number'],
  role: ['5.1.14', 'Optional', 'String'],
  label: ['5.1.17', 'Optional', 'String'],
  renderGroup: ['5.1.18', 'Optional', 'Number'],
  altGroup: ['5.1.19', 'Optional', 'Number'],
  initData: ['5.1.20', 'Optional', 'String'],
  depends: ['5.1.21', 'Optional', 'Array'],
  temporalId: ['5.1.22', 'Optional', 'Number'],
  spatialId: ['5.1.23', 'Optional', 'Number'],
  codec: ['5.1.24', 'Optional', 'String'],
  mimeType: ['5.1.25', 'Optional', 'String'],
  framerate: ['5.1.26', 'Optional', 'Number'],
  timescale: ['5.1.27', 'Optional', 'Number'],
  bitrate: ['5.1.28', 'Optional', 'Number'],
  width: ['5.1.29', 'Optional', 'Number'],
  height: ['5.1.30', 'Optional', 'Number'],
  samplerate: ['5.1.31', 'Optional', 'Number'],
  channelConfig: ['5.1.32', 'Optional', 'String'],
  displayWidth: ['5.1.33', 'Optional', 'Number'],
  displayHeight: ['5.1.34', 'Optional', 'Number'],
  lang: ['5.1.35', 'Optional', 'String'],
  parentName: ['5.1.36', 'Optional', 'String'],
  trackDuration: ['5.1.37', 'Optional', 'Number'],
}

const MSF01_FIELDS: FieldTable = {
  version: ['5.1.1', 'Yes', 'String'],
  generatedAt: ['5.1.2', 'Optional', 'Number'],
  isComplete: ['5.1.3', 'Optional', 'Boolean'],
  tracks: ['5.1.4', 'Yes', 'Array'],
  publishTracks: ['5.1.5', 'Optional', 'Array'],
  deltaUpdate: ['5.1.6', 'Optional', 'Array'],
  initDataList: ['5.1.7', 'Optional', 'Array'],
  namespace: ['5.2.2', 'Optional', 'String'],
  name: ['5.2.3', 'Yes', 'String'],
  packaging: ['5.2.4', 'Yes', 'String'],
  eventType: ['5.2.5', 'Optional', 'String'],
  isLive: ['5.2.7', 'Yes', 'Boolean'],
  targetLatency: ['5.2.8', 'Optional', 'Number'],
  buffers: ['5.2.9', 'Optional', 'Object'],
  role: ['5.2.6', 'Optional', 'String'],
  label: ['5.2.10', 'Optional', 'String'],
  renderGroup: ['5.2.11', 'Optional', 'Number'],
  altGroup: ['5.2.12', 'Optional', 'Number'],
  initRef: ['5.2.13', 'Optional', 'String'],
  depends: ['5.2.14', 'Optional', 'Array'],
  template: ['5.2.15', 'Optional', 'Array'],
  temporalId: ['5.2.16', 'Optional', 'Number'],
  spatialId: ['5.2.17', 'Optional', 'Number'],
  codec: ['5.2.18', 'Conditional', 'String'],
  mimeType: ['5.2.19', 'Optional', 'String'],
  framerate: ['5.2.20', 'Optional', 'Number'],
  timescale: ['5.2.21', 'Optional', 'Number'],
  bitrate: ['5.2.22', 'Conditional', 'Number'],
  avgBitrate: ['5.2.23', 'Optional', 'Number'],
  maxGopDuration: ['5.2.24', 'Optional', 'Number'],
  maxGroupDuration: ['5.2.25', 'Optional', 'Number'],
  width: ['5.2.26', 'Optional', 'Number'],
  height: ['5.2.27', 'Optional', 'Number'],
  samplerate: ['5.2.28', 'Conditional', 'Number'],
  channelConfig: ['5.2.29', 'Conditional', 'String'],
  displayWidth: ['5.2.30', 'Optional', 'Number'],
  displayHeight: ['5.2.31', 'Optional', 'Number'],
  lang: ['5.2.32', 'Optional', 'String'],
  parentName: ['5.2.33', 'Optional', 'String'],
  parentNamespace: ['5.2.34', 'Optional', 'String'],
  trackDuration: ['5.2.35', 'Optional', 'Number'],
  connectionUri: ['5.2.36', 'Optional', 'String'],
  token: ['5.2.37', 'Optional', 'String'],
  encryptionScheme: ['5.2.38', 'Optional', 'String'],
  cipherSuite: ['5.2.39', 'Optional', 'String'],
  keyId: ['5.2.40', 'Optional', 'String'],
  trackBaseKey: ['5.2.41', 'Optional', 'String'],
  authInfo: ['5.2.42', 'Optional', 'Object'],
  accessibility: ['5.2.44', 'Optional', 'Array'],
}

const CMSF_SAP_FIELDS: FieldTable = {
  maxGrpSapStartingType: ['3.5.2.1', 'Optional', 'Number'],
  maxObjSapStartingType: ['3.5.2.2', 'Optional', 'Number'],
}

const CMSF01_FIELDS: FieldTable = {
  ...CMSF_SAP_FIELDS,
  contentProtections: ['4.1.1', 'Optional', 'Array'],
  refID: ['4.1.1.1', 'Required', 'String'],
  defaultKID: ['4.1.1.2', 'Required', 'Array of Strings'],
  scheme: ['4.1.1.3', 'Required', 'String'],
  drmSystem: ['4.1.1.4', 'Required', 'Object'],
  systemID: ['4.1.1.4.1', 'Required', 'String'],
  laURL: ['4.1.1.4.2', 'Optional', 'Object'],
  certURL: ['4.1.1.4.3', 'Optional', 'Object'],
  pssh: ['4.1.1.4.5', 'Optional', 'String'],
  contentProtectionRefIDs: ['4.1.2', 'Optional', 'Array of Strings'],
}

const FIELDS: Record<CatalogDraftName, FieldTable> = {
  'msf-00': MSF00_FIELDS,
  'msf-01': MSF01_FIELDS,
  'cmsf-00': CMSF_SAP_FIELDS,
  'cmsf-01': CMSF01_FIELDS,
}

/**
 * The definition of `field` under `draft`, as a reference: `REQUIRED` or
 * `TYPE` with the definition's "Required: … JSON Type: …" line. `null` for a
 * field the draft does not define.
 */
export function fieldRef(
  field: string,
  draft: CatalogDraftName,
  keyword: 'REQUIRED' | 'TYPE',
): SpecRef | null {
  const msf = draft.replace('cmsf', 'msf') as CatalogDraftName
  for (const d of [draft, msf]) {
    const def = FIELDS[d][field]
    if (def !== undefined) {
      return toRef(d, [def[0], keyword, `Required: ${def[1]} JSON Type: ${def[2]}`])
    }
  }
  return null
}

/** The JSON type a field's definition gives: `String`, `Array of Strings` */
export function fieldType(field: string, draft: CatalogDraftName): string | null {
  const msf = draft.replace('cmsf', 'msf') as CatalogDraftName
  return FIELDS[draft][field]?.[2] ?? FIELDS[msf][field]?.[2] ?? null
}

// ─── Timeline rules ─────────────────────────────────────────────────

type TimelineDraftName = 'msf-00' | 'msf-01' | 'cmsf-00' | 'cmsf-01'

const RECORD_ITEMS =
  'Each record consists of an array of three required items, whose ordinal position defines their type:'
const LOCATION_ITEM =
  'The second item holds the MOQT Location of the entry, defined as a tuple of the MOQT Group ID and MOQT Object ID, and expressed as a JSON Array of Numbers, where the first number is the Group ID and the second number is the Object ID.'
const EVENT_VALUES =
  'Wallclock time and media PTS values are JSON Number, while Location value is an Array of Numbers, where the first item represents the MOQT GroupID and the second item the MOQT Object ID.'
const EVENT_INDEX =
  "An index reference, which MUST be either 't' for wallclock time, 'l' for Location or 'm' for Media PTS."
const SAP_INDEX = "The index reference MUST be 'l' for Location"
const SAP_DATA = 'The data field is a JSON Array containing two integers.'

const TIMELINE_RULES = {
  mediaJson: {
    'msf-00': ['7.1', 'TYPE', 'A media timeline track is a JSON [JSON] document.'],
    'msf-01': ['7.1', 'TYPE', 'A media timeline track is a JSON [JSON] document.'],
  },
  eventJson: {
    'msf-00': ['8.1', 'TYPE', 'An event timeline track is a JSON [JSON] document.'],
    'msf-01': ['8.1', 'TYPE', 'An event timeline track is a JSON [JSON] document.'],
  },
  mediaArray: {
    'msf-00': ['7.1', 'TYPE', 'The document contains an array of records.'],
    'msf-01': ['7.1.1', 'TYPE', 'The explicit format contains an array of records.'],
  },
  mediaRecord: {
    'msf-00': ['7.1', 'TYPE', RECORD_ITEMS],
    'msf-01': ['7.1.1', 'TYPE', RECORD_ITEMS],
  },
  mediaRecordItems: {
    'msf-00': ['7.1', 'REQUIRED', RECORD_ITEMS],
    'msf-01': ['7.1.1', 'REQUIRED', RECORD_ITEMS],
  },
  mediaTimeType: {
    'msf-00': [
      '7.1',
      'TYPE',
      'The first item holds the media presentation timestamp, expressed as a JSON Number.',
    ],
    'msf-01': [
      '7.1.1',
      'TYPE',
      'The first item holds the media presentation timestamp, expressed as a JSON Number.',
    ],
  },
  mediaTimeValue: {
    'msf-00': [
      '7.1',
      'MUST',
      'This value MUST match the media presentation timestamp, rounded to the nearest millisecond, of the first media sample in the referenced Object',
    ],
    'msf-01': [
      '7.1.1',
      'MUST',
      'This value MUST match the media presentation timestamp, expressed as the floor in integral milliseconds, of the first media sample in the referenced Object.',
    ],
  },
  location: {
    'msf-00': ['7.1', 'TYPE', LOCATION_ITEM],
    'msf-01': ['7.1.1', 'TYPE', LOCATION_ITEM],
  },
  wallclock: {
    'msf-00': [
      '7.1',
      'TYPE',
      'The third time holds the wallclock time at which the media was encoded, defined as the number of milliseconds that have elapsed since January 1, 1970 (midnight UTC/GMT) and expressed as a JSON Number.',
    ],
    'msf-01': [
      '7.1.1',
      'TYPE',
      'The third item holds the wallclock time at which the media was encoded, defined as the number of milliseconds that have elapsed since January 1, 1970 (midnight UTC/GMT) and expressed as a JSON Number.',
    ],
  },
  template: {
    'msf-01': [
      '7.4.1',
      'TYPE',
      'The template is a JSON Array containing six mandatory values in the following fixed order:',
    ],
  },
  templateValues: {
    'msf-01': [
      '7.4.1',
      'MUST',
      'All six values are mandatory and MUST appear in the specified order.',
    ],
  },
  eventArray: {
    'msf-00': ['8.1', 'TYPE', 'The document contains an array of records.'],
    'msf-01': ['8.1', 'TYPE', 'The document contains an array of records.'],
  },
  eventRecord: {
    'msf-00': [
      '8.1',
      'TYPE',
      'Each record consists of a JSON Object containing the following required fields:',
    ],
    'msf-01': [
      '8.1',
      'TYPE',
      'Each record consists of a JSON Object containing the following required fields:',
    ],
  },
  eventData: {
    'msf-00': [
      '8.1',
      'REQUIRED',
      'Each record consists of a JSON Object containing the following required fields:',
    ],
    'msf-01': [
      '8.1',
      'REQUIRED',
      'Each record consists of a JSON Object containing the following required fields:',
    ],
  },
  eventIndex: { 'msf-00': ['8.1', 'MUST', EVENT_INDEX], 'msf-01': ['8.1', 'MUST', EVENT_INDEX] },
  eventOneIndex: {
    'msf-00': ['8.1', null, 'Only one of these index values may be used within each record.'],
    'msf-01': ['8.1', null, 'Only one of these index values may be used within each record.'],
  },
  eventValues: { 'msf-00': ['8.1', 'TYPE', EVENT_VALUES], 'msf-01': ['8.1', 'TYPE', EVENT_VALUES] },
  eventSameIndex: {
    'msf-00': [
      '8.1',
      'SHOULD',
      'Event timelines SHOULD use the same index reference type for each record.',
    ],
    'msf-01': [
      '8.1',
      'SHOULD',
      'Event timelines SHOULD use the same index reference type for each record.',
    ],
  },
  sapIndex: { 'cmsf-00': ['3.6.1', 'MUST', SAP_INDEX], 'cmsf-01': ['3.6.1', 'MUST', SAP_INDEX] },
  sapData: { 'cmsf-00': ['3.6.1', 'TYPE', SAP_DATA], 'cmsf-01': ['3.6.1', 'TYPE', SAP_DATA] },
  sapType: {
    'cmsf-00': [
      '3.6.1',
      null,
      'The first integer defines SAP type with an allowed value of 0,1,2 or 3.',
    ],
    'cmsf-01': [
      '3.6.1',
      null,
      'The first integer defines SAP type with an allowed value of 0,1,2 or 3.',
    ],
  },
  sapFirst: {
    'cmsf-00': [
      '3.6.1',
      'MUST',
      'When the Object is the first Object in the Group, the value MUST be equal to 1 or 2.',
    ],
    'cmsf-01': [
      '3.6.1',
      'MUST',
      'When the Object is the first Object in the Group, the value MUST be equal to 1 or 2.',
    ],
  },
  sapConflict: {
    'cmsf-00': [
      '3.6.1',
      null,
      'The second integer defines the earliest media presentation timestamp, rounded to the nearest millisecond, of all media samples in the Object defined by the Location of that record.',
    ],
    'cmsf-01': [
      '3.6.1',
      null,
      'The second integer defines the earliest media presentation timestamp, rounded to the nearest millisecond, of all media samples in the Object defined by the Location of that record.',
    ],
  },
} satisfies Record<string, RuleSet>

export type TimelineRuleName = keyof typeof TIMELINE_RULES

/** A timeline rule as `draft` states it, or as the latest revision does */
export function timelineRuleRef(name: TimelineRuleName, draft: TimelineDraftName): SpecRef {
  const set: RuleSet = TIMELINE_RULES[name]
  const rule = set[draft]
  if (rule !== undefined) return toRef(draft, rule)
  const fallback = (draft.startsWith('cmsf') ? 'cmsf-01' : 'msf-01') as TimelineDraftName
  return toRef(fallback, set[fallback]!)
}

// ─── Wording ────────────────────────────────────────────────────────

const ELLIPSIS = '…'

/** A value as the wording shows it: JSON, strings over 40 characters shortened */
export function shownValue(value: JsonValue): string {
  if (typeof value === 'string') {
    const cut = value.length > 40 ? `${value.slice(0, 32)}${ELLIPSIS}` : value
    return JSON.stringify(cut)
  }
  const text = JSON.stringify(value)
  return text.length > 40 ? `${text.slice(0, 32)}${ELLIPSIS}` : text
}

function kindOfValue(value: JsonValue): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'an Array'
  if (typeof value === 'object') return 'an Object'
  const name = (typeof value).charAt(0).toUpperCase() + (typeof value).slice(1)
  return `a ${name}`
}

function article(type: string): string {
  return /^[AEIOU]/.test(type) ? `an ${type}` : `a ${type}`
}

function list(items: readonly string[], last: 'and' | 'or'): string {
  if (items.length <= 1) return items[0] ?? ''
  return `${items.slice(0, -1).join(', ')} ${last} ${items[items.length - 1]}`
}

function unique<T>(items: readonly T[]): T[] {
  return [...new Set(items)]
}

function subjectKey(s: ProblemSubject): string {
  switch (s.kind) {
    case 'track':
      return `t${s.index}`
    case 'delta':
      return `d${s.op}.${s.index}`
    case 'entry':
      return `${s.list}${s.index}`
    case 'record':
      return `r${s.index}`
    default:
      return s.kind
  }
}

/** `tracks[9] "audio"`, `initDataList[0]`, `record 3` */
export function subjectLabel(s: ProblemSubject): string {
  switch (s.kind) {
    case 'root':
      return 'catalog'
    case 'object':
      return 'catalog object'
    case 'track':
      return s.name === null ? `tracks[${s.index}]` : `tracks[${s.index}] "${s.name}"`
    case 'delta':
      return s.name === null ? `delta entry ${s.op}` : `delta entry "${s.name}"`
    case 'entry':
      return `${s.list}[${s.index}]`
    case 'record':
      return `record ${s.index}`
  }
}

/** One family of problems, ready to word */
interface Group {
  p: MediaProblem
  all: readonly MediaProblem[]
  subjects: ProblemSubject[]
  one: boolean
  fields: string[]
}

/** A nested field by its own name: `drmSystem.laURL` as `laURL` */
function short(field: string): string {
  return field.slice(field.lastIndexOf('.') + 1)
}

function groupOf(problems: readonly MediaProblem[]): Group {
  const p = problems[0]
  if (p === undefined) throw new Error('an empty problem group')
  const seen = new Map<string, ProblemSubject>()
  for (const q of problems) seen.set(subjectKey(q.subject), q.subject)
  const subjects = [...seen.values()]
  const fields = unique(
    problems
      .map((q) => q.field)
      .filter((f): f is string => f !== null)
      .map(short),
  )
  return { p, all: problems, subjects, one: subjects.length === 1, fields }
}

function trackName(s: ProblemSubject): string | null {
  return s.kind === 'track' || s.kind === 'delta' ? s.name : null
}

/**
 * Who a title is about: `Track "video"`, `Tracks`, `Catalog`, `Entry 2 of
 * initDataList`. `noun` replaces "track" (`Audio track`).
 */
function who(g: Group, noun = 'track'): string {
  const s = g.subjects[0]!
  const Noun = noun.charAt(0).toUpperCase() + noun.slice(1)
  if (!g.one) {
    if (s.kind === 'entry') return `Entries of ${s.list}`
    if (s.kind === 'record') return 'Records'
    return `${Noun}s`
  }
  switch (s.kind) {
    case 'root':
      return g.p.id.startsWith('catalog.delta.') ? 'Delta update' : 'Catalog'
    case 'object':
      return 'Catalog object'
    case 'track':
      return s.name === null ? `${Noun} tracks[${s.index}]` : `${Noun} "${s.name}"`
    case 'delta': {
      if (s.index === null) return `Operation ${s.op} of deltaUpdate`
      const verb =
        s.operation === 'remove' ? 'Removed' : s.operation === 'clone' ? 'Cloned' : 'Added'
      return s.name === null ? `${verb} ${noun}` : `${verb} ${noun} "${s.name}"`
    }
    case 'entry':
      return `Entry ${s.index} of ${s.list}`
    case 'record':
      return `Record ${s.index}`
  }
}

function has(g: Group): string {
  return g.one ? 'has' : 'have'
}

function is(g: Group): string {
  return g.one ? 'is' : 'are'
}

function value(g: Group, key: string): string {
  const v = g.p.values[key]
  return v === undefined ? '' : shownValue(v)
}

function raw(g: Group, key: string): string {
  const v = g.p.values[key]
  return v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v)
}

/** `samplerate (Number) and channelConfig (String)` */
function typedFields(g: Group, join: 'and' | 'or'): string {
  const types = new Map<string, string>()
  for (const q of g.all) {
    const t = q.values.type
    if (q.field !== null && typeof t === 'string') types.set(short(q.field), t)
  }
  return list(
    g.fields.map((f) => (types.has(f) ? `${f} (${types.get(f)})` : f)),
    join,
  )
}

function roleNoun(g: Group): string {
  const roles = unique(g.all.map((q) => q.values.role))
  if (roles.length === 1 && roles[0] === 'audio') return 'audio track'
  if (roles.length === 1 && roles[0] === 'video') return 'video track'
  return 'track'
}

/** `Event record 3`, `Event records` */
function rec(g: Group, kind: string): string {
  const s = g.subjects[0]!
  if (!g.one || s.kind !== 'record') return `${kind} records`
  return `${kind} record ${s.index}`
}

interface Wording {
  title: (g: Group) => string
  remedy: (g: Group) => string
}

const W = (title: (g: Group) => string, remedy: string | ((g: Group) => string)): Wording => ({
  title,
  remedy: typeof remedy === 'string' ? () => remedy : remedy,
})

const MISSING: Wording = W(
  (g) => `${who(g)} ${has(g)} no ${list(g.fields, 'or')}`,
  (g) => `Add ${typedFields(g, 'and')} to the ${noun(g)}`,
)

const WRONG_TYPE: Wording = W(
  (g) => {
    if (g.fields.length !== 1) return `${who(g)} ${has(g)} fields of the wrong JSON type`
    const actual = g.p.actual
    const as = actual.kind === 'value' ? ` as ${kindOfValue(actual.value)}` : ''
    const type = g.p.values.type
    return typeof type === 'string'
      ? `${who(g)} ${has(g)} ${g.fields[0]}${as}, not ${article(type.replace(' of Strings', ''))}`
      : `${who(g)} ${has(g)} ${g.fields[0]} of the wrong JSON type`
  },
  (g) => {
    const type = g.p.values.type
    return g.fields.length === 1 && typeof type === 'string'
      ? `Write ${g.fields[0]} as ${article(type)}`
      : 'Write each field as the JSON type its definition gives'
  },
)

function noun(g: Group): string {
  const s = g.subjects[0]!
  switch (s.kind) {
    case 'root':
      return g.p.id.startsWith('catalog.delta.') ? 'delta update' : 'catalog'
    case 'entry':
      return `${s.list} entry`
    case 'record':
      return 'record'
    case 'delta':
      return s.operation === null || s.index === null ? 'operation' : `${s.operation} entry`
    default:
      return g.one ? 'track' : 'tracks'
  }
}

function draftOf(g: Group): string {
  const d = g.p.spec
  return `${d.draft.toUpperCase()}-${d.revision}`
}

function otherFieldBytes(g: Group): string {
  const sizes = g.all
    .map((q) => (q.actual.kind === 'other-field' ? q.actual.bytes : null))
    .filter((b): b is number => b !== null)
  if (sizes.length === 0) return ''
  const lo = Math.min(...sizes)
  const hi = Math.max(...sizes)
  return lo === hi ? ` (${lo} B)` : ` (${lo}–${hi} B)`
}

const WORDING: Record<string, Wording> = {
  'catalog.json.utf8': W(
    () => 'Catalog payload is not UTF-8',
    'Send the catalog as UTF-8 JSON text',
  ),
  'catalog.json.syntax': W(
    () => 'Catalog payload is not JSON',
    'Send the catalog as a JSON document',
  ),
  'catalog.root.object': W(
    () => 'Catalog is not a JSON Object',
    'Send the catalog as a JSON Object',
  ),
  'catalog.root.version.unsupported': W(
    (g) => `Catalog version ${value(g, 'version')} is not ${raw(g, 'supported')}`,
    (g) => `Set version to ${raw(g, 'supported')}`,
  ),
  'catalog.root.isComplete.false': W(
    () => 'Catalog sets isComplete to false',
    'Leave isComplete out until it is true',
  ),
  'catalog.root.isComplete.removed': W(
    () => 'Catalog drops isComplete after it was set',
    'Keep isComplete true once it has been set',
  ),
  'catalog.root.initDataList.misplaced': W(
    () => 'Catalog has initDataList before tracks',
    'Move initDataList after the tracks array',
  ),
  'catalog.draft.ambiguous': W(
    (g) => `Catalog may be ${raw(g, 'drafts')}; only shared rules are checked`,
    '',
  ),
  'catalog.track.object': W(
    (g) => (g.one ? 'Track entry is not a JSON Object' : 'Track entries are not JSON Objects'),
    'Write each track as a JSON Object',
  ),
  'catalog.track.packaging.value': W(
    (g) =>
      `${who(g)} ${has(g)} packaging ${value(g, 'packaging')}, which ${draftOf(g)} does not define`,
    "Set packaging to a value the draft's packaging table lists",
  ),
  'catalog.track.eventType.forbidden': W(
    (g) => `${who(g)} ${has(g)} eventType but packaging is not eventtimeline`,
    'Remove eventType, or set packaging to eventtimeline',
  ),
  'catalog.track.targetLatency.forbidden': W(
    (g) => `${who(g)} ${has(g)} targetLatency while isLive is false`,
    'Remove targetLatency from tracks that are not live',
  ),
  'catalog.track.buffers.forbidden': W(
    (g) => `${who(g)} ${has(g)} both buffers and targetLatency`,
    'Keep either buffers or targetLatency, not both',
  ),
  'catalog.track.trackDuration.forbidden': W(
    (g) => `${who(g)} ${has(g)} trackDuration while isLive is true`,
    'Remove trackDuration while the track is live',
  ),
  'catalog.track.parentName.forbidden': W(
    (g) => `${who(g)} ${has(g)} parentName outside a clone operation`,
    'Remove parentName from the track',
  ),
  'catalog.track.parentNamespace.forbidden': W(
    (g) => `${who(g)} ${has(g)} parentNamespace outside a clone operation`,
    'Remove parentNamespace from the track',
  ),
  'catalog.track.cipherSuite.missing': W(
    (g) => `${who(g)} ${has(g)} encryptionScheme but no cipherSuite`,
    'Add cipherSuite (String) to the track',
  ),
  'catalog.track.initData.base64': W(
    (g) => `${who(g)} ${has(g)} initData that is not Base64`,
    'Encode initData as padded standard Base64',
  ),
  'catalog.init.missing': W(
    (g) =>
      g.one
        ? `CMAF ${who(g).charAt(0).toLowerCase()}${who(g).slice(1)} gives no header in initRef or initData`
        : 'CMAF tracks give no header in initRef or initData',
    (g) =>
      g.p.spec.revision === '00'
        ? "Add the track's header to it as Base64 initData"
        : "Add an initDataList entry for the track's header and set its initRef to that id",
  ),
  'catalog.init.other-draft-field': W(
    (g) =>
      g.p.spec.revision === '00'
        ? 'Catalog is draft-00 but gives CMAF headers by initRef, not initData'
        : 'Catalog is draft-01 but gives CMAF headers in initData, not initRef',
    (g) =>
      g.p.spec.revision === '00'
        ? "Put each track's header in its initData as Base64"
        : "Move each track's header into an initDataList entry and set its initRef to that id",
  ),
  'catalog.track.maxGrpSapStartingType.value': W(
    (g) => `${who(g)} ${has(g)} maxGrpSapStartingType ${value(g, 'value')}, not 1 or 2`,
    'Set maxGrpSapStartingType to 1 or 2',
  ),
  'catalog.track.sapTimeline.packaging': W(
    (g) => `${who(g, 'SAP type timeline track')} ${has(g)} packaging other than eventtimeline`,
    'Set packaging to "eventtimeline"',
  ),
  'catalog.track.contentProtections.forbidden': W(
    (g) => `${who(g)} ${has(g)} contentProtections of its own`,
    'Move content protection to the root and reference it by contentProtectionRefIDs',
  ),
  'catalog.track.duplicate': W(
    (g) =>
      g.one
        ? `${who(g)} is declared more than once in its namespace`
        : 'Tracks are declared more than once in their namespace',
    'Give each track a unique name within its namespace',
  ),
  'catalog.track.initRef.unknown': W(
    (g) => `${who(g)} ${has(g)} an initRef that names no initDataList entry`,
    'Set initRef to the id of an initDataList entry',
  ),
  'catalog.track.initRef.ambiguous': W(
    (g) => `${who(g)} ${has(g)} an initRef that names several entries`,
    'Give each initDataList entry a unique id',
  ),
  'catalog.track.contentProtectionRef.unknown': W(
    (g) => `${who(g)} ${g.one ? 'names' : 'name'} a refID no contentProtections entry has`,
    'Reference only refIDs of root contentProtections entries',
  ),
  'catalog.track.contentProtectionRef.ambiguous': W(
    (g) => `${who(g)} ${g.one ? 'names' : 'name'} a refID several contentProtections entries share`,
    'Give each contentProtections entry a unique refID',
  ),
  'catalog.track.isLive.revived': W(
    (g) => `${who(g)} ${is(g)} live again after isLive was false`,
    'Publish a new track instead of setting isLive back to true',
  ),
  'catalog.track.added-after-complete': W(
    (g) => `${who(g)} ${is(g)} new after the catalog set isComplete`,
    'Add no tracks once isComplete is set',
  ),
  'catalog.audio.fields': W(
    (g) => `${who(g, 'audio track')} ${has(g)} no ${list(g.fields, 'or')}`,
    (g) => `Add ${typedFields(g, 'and')} to the ${g.one ? 'track' : 'tracks'}`,
  ),
  'catalog.media.fields': W(
    (g) => `${who(g, roleNoun(g))} ${has(g)} no ${list(g.fields, 'or')}`,
    (g) => `Add ${typedFields(g, 'and')} to the ${g.one ? 'track' : 'tracks'}`,
  ),
  'catalog.initDataList.entry.object': W(
    (g) => `${who(g)} ${is(g)} not a JSON Object`,
    'Write each initDataList entry as a JSON Object',
  ),
  'catalog.initDataList.id.duplicate': W(
    (g) => `Id ${value(g, 'id')} appears more than once in initDataList`,
    'Give each initDataList entry a unique id',
  ),
  'catalog.initDataList.type.value': W(
    (g) => `${who(g)} ${has(g)} type ${value(g, 'type')}, not "inline"`,
    'Set type to "inline"',
  ),
  'catalog.initDataList.data.base64': W(
    (g) => `${who(g)} ${has(g)} data that is not Base64`,
    'Encode data as padded standard Base64',
  ),
  'catalog.contentProtections.entry.object': W(
    (g) => `${who(g)} ${is(g)} not a JSON Object`,
    'Write each contentProtections entry as a JSON Object',
  ),
  'catalog.contentProtections.refID.duplicate': W(
    (g) => `RefID ${value(g, 'refID')} appears more than once in contentProtections`,
    'Give each contentProtections entry a unique refID',
  ),
  'catalog.contentProtections.defaultKID.value': W(
    (g) => `${who(g)} ${has(g)} a default KID that is not a UUID`,
    'Write each default KID as xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
  ),
  'catalog.contentProtections.scheme.value': W(
    (g) => `${who(g)} ${has(g)} scheme ${value(g, 'scheme')}, not cenc or cbcs`,
    'Set scheme to "cenc" or "cbcs"',
  ),
  'catalog.contentProtections.systemID.value': W(
    (g) => `${who(g)} ${has(g)} a systemID that is not a UUID`,
    'Write systemID as xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
  ),
  'catalog.contentProtections.pssh.value': W(
    (g) => `${who(g)} ${has(g)} a pssh that is not Base64`,
    'Encode the PSSH box as padded standard Base64',
  ),
  'catalog.delta.forbidden': W(
    (g) => `Delta update contains ${list(g.fields, 'and')}`,
    (g) => `Remove ${list(g.fields, 'and')} from the delta update`,
  ),
  'catalog.delta.deltaUpdate.value': W(
    () => 'Delta update does not set deltaUpdate to true',
    'Set deltaUpdate to true',
  ),
  'catalog.delta.operations.missing': W(
    () => 'Delta update has no addTracks, removeTracks or cloneTracks',
    'Add at least one of addTracks, removeTracks or cloneTracks',
  ),
  'catalog.delta.operations.empty': W(
    () => 'Delta update has an empty deltaUpdate',
    'Add at least one operation to deltaUpdate',
  ),
  'catalog.delta.operation.object': W(
    (g) => `Operation ${raw(g, 'op')} of deltaUpdate is not a JSON Object`,
    'Write each operation as a JSON Object',
  ),
  'catalog.delta.operation.op.value': W(
    (g) => `Operation ${raw(g, 'op')} of deltaUpdate has op ${value(g, 'value')}`,
    'Set op to "add", "remove" or "clone"',
  ),
  'catalog.delta.remove.field.forbidden': W(
    (g) => `${who(g)} ${has(g)} fields besides name and namespace`,
    'Keep only name and namespace in a remove entry',
  ),
  'catalog.delta.clone.name.missing': W(
    (g) => `${who(g)} ${has(g)} no name of its own`,
    'Give the cloned track a new name',
  ),
  'catalog.delta.base.missing': W(
    () => 'Delta update has no catalog to apply to',
    'Start each group with an independent catalog',
  ),
  'catalog.delta.draft.mismatch': W(
    (g) => `Delta update is ${raw(g, 'delta')} but the catalog is ${raw(g, 'catalog')}`,
    "Publish deltas in the catalog's draft",
  ),
  'catalog.delta.track.unknown': W(
    (g) =>
      g.p.values.parent !== undefined
        ? `Clone parent ${value(g, 'parent')} is not declared`
        : `Removed track ${value(g, 'name')} is not declared`,
    'Remove or clone only tracks the catalog declares',
  ),
  'catalog.delta.track.ambiguous': W(
    (g) => `Delta update names ${value(g, 'name')}, which is declared ${raw(g, 'count')} times`,
    'Give each track a unique name within its namespace',
  ),
  'catalog.delta.track.exists': W(
    (g) => `Delta update adds track ${value(g, 'name')}, which is already declared`,
    'Give added and cloned tracks names not yet declared',
  ),
  'catalog.object.subgroup': W((g) => {
    const subgroups = unique(g.all.map((q) => q.values.subgroup))
    return subgroups.length === 1
      ? `Catalog objects are sent on subgroup ${raw(g, 'subgroup')}, not subgroup 0`
      : 'Catalog objects are sent on subgroups other than 0'
  }, 'Send every catalog object on subgroup 0'),
  'catalog.object.first-delta': W(
    (g) =>
      g.all.length === 1
        ? `Catalog object 0 of group ${raw(g, 'group')} is a delta`
        : 'Catalog groups start with a delta',
    'Start each group with an independent catalog',
  ),
  'catalog.object.later-independent': W(
    (g) =>
      g.all.length === 1
        ? `Catalog object ${raw(g, 'object')} of group ${raw(g, 'group')} is independent`
        : 'Independent catalogs follow object 0 in their group',
    'Start a new group for each independent catalog',
  ),

  'timeline.json.utf8': W(
    () => 'Timeline payload is not UTF-8',
    'Send the timeline as UTF-8 JSON text',
  ),
  'timeline.json.syntax': W(
    () => 'Timeline payload is not JSON',
    'Send the timeline as a JSON document',
  ),
  'timeline.media.array': W(
    () => 'Media timeline is not an array of records',
    'Send the media timeline as a JSON Array of records',
  ),
  'timeline.media.record.type': W(
    (g) => `${rec(g, 'Media timeline')} ${is(g)} not an Array of three items`,
    'Write each record as [mediaTime, [group, object], wallclock]',
  ),
  'timeline.media.record.missing': W(
    (g) => `${rec(g, 'Media timeline')} ${has(g)} fewer than three items`,
    'Give each record its media time, Location and wallclock time',
  ),
  'timeline.media.mediaTime.type': W(
    (g) => `${rec(g, 'Media timeline')} ${has(g)} a media time that is not a Number`,
    'Write the media time as a JSON Number of milliseconds',
  ),
  'timeline.media.mediaTime.integer': W(
    (g) =>
      `${rec(g, 'Media timeline')} ${has(g)} media time ${value(g, 'value')}, not whole milliseconds`,
    'Write the media time in whole milliseconds',
  ),
  'timeline.media.location.type': W(
    (g) => `${rec(g, 'Media timeline')} ${has(g)} a Location that is not [group, object]`,
    'Write the Location as [Group ID, Object ID]',
  ),
  'timeline.media.wallclock.type': W(
    (g) => `${rec(g, 'Media timeline')} ${has(g)} a wallclock time that is not a Number`,
    'Write the wallclock time as a JSON Number of milliseconds',
  ),
  'timeline.template.type': W(
    () => 'Media timeline template is not an Array of six values',
    'Write the template as an Array of its six values',
  ),
  'timeline.template.missing': W(
    () => 'Media timeline template has fewer than six values',
    'Give the template all six values, in order',
  ),
  'timeline.template.value.type': W(
    (g) =>
      g.fields.length === 1
        ? `Template value ${g.fields[0]} is not ${raw(g, 'what')}`
        : `Template values ${list(g.fields, 'and')} are not as 7.4.1 defines them`,
    'Write each template value as its definition gives',
  ),
  'timeline.event.array': W(
    () => 'Event timeline is not an array of records',
    'Send the event timeline as a JSON Array of records',
  ),
  'timeline.event.record.object': W(
    (g) => `${rec(g, 'Event')} ${is(g)} not a JSON Object`,
    'Write each record as a JSON Object',
  ),
  'timeline.event.index.missing': W(
    (g) => `${rec(g, 'Event')} ${has(g)} no index reference t, l or m`,
    "Give each record one index reference: 't', 'l' or 'm'",
  ),
  'timeline.event.index.multiple': W(
    (g) => `${rec(g, 'Event')} ${has(g)} more than one index reference`,
    'Keep one index reference per record',
  ),
  'timeline.event.data.missing': W(
    (g) => `${rec(g, 'Event')} ${has(g)} no data`,
    'Add data to each record',
  ),
  'timeline.event.location.type': W(
    (g) => `${rec(g, 'Event')} ${has(g)} a Location that is not [group, object]`,
    'Write the Location as [Group ID, Object ID]',
  ),
  'timeline.event.time.type': W(
    (g) => `${rec(g, 'Event')} ${has(g)} index ${raw(g, 'index')} that is not a Number`,
    'Write t and m as JSON Numbers of milliseconds',
  ),
  'timeline.event.mediaTime.integer': W(
    (g) => `${rec(g, 'Event')} ${has(g)} media PTS ${value(g, 'value')}, not whole milliseconds`,
    'Write the media PTS in whole milliseconds',
  ),
  'timeline.event.index.mixed': W(
    (g) => `Event records mix index references ${raw(g, 'indexes')}`,
    'Use one index reference type for every record',
  ),
  'timeline.sap.index': W(
    (g) => `${rec(g, 'SAP timeline')} ${is(g)} not indexed by Location`,
    "Index each SAP timeline record by 'l'",
  ),
  'timeline.sap.data.type': W(
    (g) => `${rec(g, 'SAP timeline')} ${has(g)} data that is not two integers`,
    'Write data as [SAP type, earliest presentation time]',
  ),
  'timeline.sap.type.value': W(
    (g) => `${rec(g, 'SAP timeline')} ${has(g)} SAP type ${raw(g, 'sapType')}, not 0 to 3`,
    'Give a SAP type of 0, 1, 2 or 3',
  ),
  'timeline.sap.first-object': W(
    (g) =>
      g.all.length === 1
        ? `Group ${raw(g, 'group')} starts with SAP type ${raw(g, 'sapType')}, not 1 or 2`
        : 'Groups start with a SAP type other than 1 or 2',
    'Start each group with SAP type 1 or 2',
  ),
  'timeline.sap.conflict': W(
    (g) => `Location ${raw(g, 'location')} has SAP records that disagree`,
    'Give each Location one SAP record',
  ),
}

function wordingOf(p: MediaProblem): Wording {
  const exact = WORDING[p.family] ?? WORDING[p.id]
  if (exact !== undefined) return exact
  if (p.id.endsWith('.missing')) return MISSING
  if (p.id.endsWith('.type')) return WRONG_TYPE
  throw new Error(`no wording for ${p.id}`)
}

/**
 * The title of one family of problems on one or more subjects: a capitalised
 * sentence with no closing period. It names the track when exactly one is
 * affected.
 */
export function problemTitle(group: readonly MediaProblem[]): string {
  const g = groupOf(group)
  return wordingOf(g.p).title(g)
}

/** What to change, in one imperative line; empty when there is nothing to change */
export function problemRemedy(group: readonly MediaProblem[]): string {
  const g = groupOf(group)
  return wordingOf(g.p).remedy(g)
}

function actualText(p: MediaProblem): string {
  const field = p.field ?? ''
  switch (p.actual.kind) {
    case 'absent':
      return field === '' ? 'absent' : `${field} absent`
    case 'value':
      return field === '' ? shownValue(p.actual.value) : `${field} ${shownValue(p.actual.value)}`
    case 'other-field':
      return p.actual.bytes === null
        ? `${field || 'value'} absent, ${p.actual.field} present`
        : `${field} absent, ${p.actual.field} present (${p.actual.bytes} B)`
  }
}

/**
 * What the data holds, in one line: `samplerate absent · channelConfig
 * absent`, per subject when there are several.
 */
export function problemFound(group: readonly MediaProblem[]): string {
  const g = groupOf(group)
  if (g.p.family === 'catalog.init.other-draft-field') {
    const other = g.p.actual.kind === 'other-field' ? g.p.actual.field : 'initData'
    const field = g.p.field ?? 'initRef'
    const n = g.subjects.length
    return [
      `version ${shownValue(g.p.readAs?.version ?? null)}`,
      `${other} present on ${n} track${n === 1 ? '' : 's'}${otherFieldBytes(g)}`,
      `${field} absent`,
    ].join(' · ')
  }
  const bySubject = new Map<string, { s: ProblemSubject; parts: string[] }>()
  for (const p of group) {
    const key = subjectKey(p.subject)
    const entry = bySubject.get(key) ?? { s: p.subject, parts: [] }
    const text = actualText(p)
    if (!entry.parts.includes(text)) entry.parts.push(text)
    bySubject.set(key, entry)
  }
  const rows = [...bySubject.values()]
  if (rows.length === 1) return rows[0]!.parts.join(' · ')
  return rows.map((r) => `${subjectLabel(r.s)}: ${r.parts.join(' · ')}`).join('; ')
}

/** What the rule asks for, in one line; the distinct `expected` of the group */
export function problemExpected(group: readonly MediaProblem[]): string {
  return unique(group.map((p) => p.expected)).join('; ')
}

/** The track names a group of problems is about, in order of first appearance */
export function problemTracks(group: readonly MediaProblem[]): string[] {
  return unique(group.map((p) => trackName(p.subject)).filter((n): n is string => n !== null))
}
