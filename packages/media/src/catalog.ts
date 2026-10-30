/**
 * MSF and CMSF catalogs: draft-ietf-moq-msf-00 and -01, draft-ietf-moq-cmsf-00
 * and -01 (msf-00 5, msf-01 5, cmsf 2). Deltas: msf-00 5.2, msf-01 5.3.
 * Unknown fields are kept (msf-00 5.1, msf-01 5).
 */

import {
  type CheckId,
  fieldRef,
  fieldType,
  type MediaProblem,
  type ProblemActual,
  type ProblemSubject,
  problemTitle,
  ruleRef,
  type SpecRef,
  specLabel,
} from './problems'

export type {
  CheckId,
  MediaProblem,
  ProblemActual,
  ProblemSubject,
  SpecKeyword,
  SpecRef,
} from './problems'
export {
  problemExpected as catalogProblemExpected,
  problemFound as catalogProblemFound,
  problemRemedy as catalogProblemRemedy,
  problemTitle as catalogProblemTitle,
  problemTracks as catalogProblemTracks,
  severityOf,
  specLabel,
  specUrl,
} from './problems'

// ─── Types ───────────────────────────────────────────────────────────

/** A catalog draft, as the catalog's shape or the caller says. */
export type CatalogDraft = 'msf-00' | 'msf-01' | 'cmsf-00' | 'cmsf-01'

export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject

export interface JsonObject {
  [key: string]: JsonValue
}

/**
 * The kind of rule a catalog breaks, named as in the catalog vectors of
 * @moqtap/test-vectors, plus this package's own `ambiguous_draft`.
 *
 * - `invalid_json`: not JSON text (RFC 8259), including bytes that are not UTF-8
 * - `unsupported_version`: a version the reader does not understand (msf 5.1.1)
 * - `missing_field`: a field the draft requires, always or under a condition
 *   met here, is absent
 * - `invalid_value`: a field of the wrong JSON type, or outside the values the
 *   draft allows
 * - `forbidden_field`: a field present where the draft says it MUST NOT be
 * - `misplaced_field`: a field present but not where the draft puts it
 *   (msf-01's initDataList after tracks)
 * - `delta_not_allowed_field`: a delta carrying `tracks` or `version`
 * - `delta_without_base`: a delta with no catalog before it to apply to
 * - `unknown_track`: a remove or clone naming a track not declared
 * - `duplicate_track`: two tracks with one namespace and name
 * - `unknown_reference`: initRef or contentProtectionRefIDs naming nothing
 * - `duplicate_id`: an initDataList id or contentProtections refID repeated
 * - `illegal_update`: a later catalog changing what the draft says cannot
 *   change once published
 * - `ambiguous_draft`: no draft given, and the shape does not tell MSF from
 *   CMSF; only the rules both share are checked (cmsf 2)
 * - `object_order`: a catalog object on the wrong Subgroup, or independent or
 *   a delta where its Object ID says otherwise (msf 5); see
 *   {@link checkCatalogObjectPlacement}
 */
export type CatalogProblemCategory =
  | 'invalid_json'
  | 'unsupported_version'
  | 'missing_field'
  | 'invalid_value'
  | 'forbidden_field'
  | 'misplaced_field'
  | 'delta_not_allowed_field'
  | 'delta_without_base'
  | 'unknown_track'
  | 'duplicate_track'
  | 'unknown_reference'
  | 'duplicate_id'
  | 'illegal_update'
  | 'ambiguous_draft'
  | 'object_order'

/**
 * One problem with a catalog object. How much it matters comes from its
 * rule's keyword: {@link severityOf}. Its words come from
 * {@link catalogProblemTitle} and the functions beside it.
 */
export interface CatalogProblem extends MediaProblem {
  /**
   * Whether the object applies: `error` breaks a rule that binds whoever
   * reads the catalog, or leaves nothing to resolve, and the object is not
   * applied; `warning` lets it apply. Not how much the problem matters: that
   * is {@link severityOf}. `effect` says the same as `refused` or `applied`.
   */
  severity: 'error' | 'warning'
  category: CatalogProblemCategory
  /** Where, as a path into the object's JSON: `tracks[0].packaging`, `deltaUpdate[1].op` */
  path: string
  /** The draft and section that state the rule, e.g. `MSF-01 5.2.4` */
  section: string
  /** {@link catalogProblemTitle} of this problem alone: capitalised, no closing period */
  message: string
  readAs: { version: JsonValue; drafts: CatalogDraft[] }
}

/**
 * One delta operation, in the order the delta declares it. MSF-01 lists them
 * in its `deltaUpdate` array; MSF-00 declares them as the root fields
 * `addTracks`, `removeTracks` and `cloneTracks`, applied "in the order they
 * are declared in the document" (msf-00 5.2).
 */
export interface DeltaOperation {
  op: 'add' | 'remove' | 'clone'
  /** The operation's track objects. Entries that are not objects are left out (and reported). */
  tracks: JsonObject[]
  /** Path of the tracks array in the delta: `addTracks`, `deltaUpdate[0].tracks` */
  path: string
}

export type ParsedCatalog =
  /** Not UTF-8, not JSON, or not a JSON object */
  | { kind: 'invalid'; draft: CatalogDraft | null; problems: CatalogProblem[] }
  | {
      kind: 'independent'
      draft: CatalogDraft | null
      /** The drafts the object can follow; see {@link parseCatalog} */
      candidates: CatalogDraft[]
      document: JsonObject
      problems: CatalogProblem[]
    }
  | {
      kind: 'delta'
      draft: CatalogDraft | null
      candidates: CatalogDraft[]
      document: JsonObject
      operations: DeltaOperation[]
      problems: CatalogProblem[]
    }

export interface ParseCatalogOptions {
  /**
   * The draft the catalog follows, when the caller knows it. Without it the
   * draft comes from the catalog's shape; see {@link parseCatalog}.
   */
  draft?: CatalogDraft
  /**
   * The catalog track's own namespace, which every track without a
   * `namespace` inherits (msf-00 5.1.10, msf-01 5.2.2). Only used to tell
   * whether two tracks share a namespace and name; tracks without one share
   * it whether or not it is given.
   */
  catalogNamespace?: string
}

// ─── Small helpers ───────────────────────────────────────────────────

const REDACTED = '[redacted]'

/** The event type of CMSF's SAP Type timeline track (cmsf 3.6.1) */
const SAP_EVENT_TYPE = 'org.ietf.moq.cmsf.sap'

/** "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" (cmsf-01 4.1.1.2, 4.1.1.4.1) */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

type JsonKind = 'string' | 'number' | 'boolean' | 'array' | 'object' | 'null'

function kindOf(value: JsonValue): JsonKind {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value as JsonKind
}

/** The key two tracks share exactly when they are the same track */
function trackKey(namespace: string | null, name: string): string {
  return JSON.stringify([namespace, name])
}

function namespaceOf(track: JsonObject, catalogNamespace: string | null): string | null {
  return typeof track.namespace === 'string' ? track.namespace : catalogNamespace
}

/** A catalog object's text, or `null` when its bytes are not UTF-8 */
function decodeText(input: string | Uint8Array): string | null {
  if (typeof input === 'string') return input
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(input)
  } catch {
    return null
  }
}

/** The catalog track's name. It is case-sensitive (msf-00 5, msf-01 5). */
export const CATALOG_TRACK_NAME = 'catalog'

/** Whether a track name is the catalog's: exactly "catalog". */
export function isCatalogTrackName(name: string): boolean {
  return name === CATALOG_TRACK_NAME
}

// ─── Base64 ──────────────────────────────────────────────────────────

/** The 6-bit value of a Base64 alphabet character (RFC 4648 4), or -1 */
function sextet(c: number): number {
  if (c >= 0x41 && c <= 0x5a) return c - 0x41 // A-Z
  if (c >= 0x61 && c <= 0x7a) return c - 0x61 + 26 // a-z
  if (c >= 0x30 && c <= 0x39) return c - 0x30 + 52 // 0-9
  if (c === 0x2b) return 62 // +
  if (c === 0x2f) return 63 // /
  return -1
}

/**
 * Decode Base64 as the drafts cite it ([BASE64] is RFC 4648): the standard
 * alphabet, padded to a multiple of four characters, nothing else in the
 * string. Returns `null` for anything else, the drafts' own elided examples
 * ("AAAAHGZ0eXBjbWYy...") included. No `Buffer` and no `atob`.
 */
export function decodeBase64(text: string): Uint8Array | null {
  if (text.length % 4 !== 0) return null
  const pad = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0
  const out = new Uint8Array((text.length / 4) * 3 - pad)
  let o = 0
  for (let i = 0; i < text.length; i += 4) {
    const last = i + 4 === text.length
    const a = sextet(text.charCodeAt(i))
    const b = sextet(text.charCodeAt(i + 1))
    const c = last && pad === 2 ? 0 : sextet(text.charCodeAt(i + 2))
    const d = last && pad >= 1 ? 0 : sextet(text.charCodeAt(i + 3))
    if (a < 0 || b < 0 || c < 0 || d < 0) return null
    const n = (a << 18) | (b << 12) | (c << 6) | d
    out[o++] = (n >> 16) & 0xff
    if (o < out.length) out[o++] = (n >> 8) & 0xff
    if (o < out.length) out[o++] = n & 0xff
  }
  return out
}

// ─── Rules ───────────────────────────────────────────────────────────

/** The draft being checked against, and where its problems go */
interface Rules {
  /** 0 for MSF-00 and CMSF-00, 1 for MSF-01 and CMSF-01 */
  base: 0 | 1
  cmsf: boolean
  draft: CatalogDraft
  catalogNamespace: string | null
  problems: CatalogProblem[]
  /** The object being checked, to name the tracks its problems are about */
  root: JsonObject | null
  readAs: CatalogProblem['readAs']
}

function draftBase(draft: CatalogDraft): 0 | 1 {
  return draft === 'msf-00' || draft === 'cmsf-00' ? 0 : 1
}

function rulesFor(
  draft: CatalogDraft,
  catalogNamespace: string | null,
  problems: CatalogProblem[],
  root: JsonObject | null = null,
  drafts: readonly CatalogDraft[] = [draft],
): Rules {
  return {
    base: draftBase(draft),
    cmsf: draft === 'cmsf-00' || draft === 'cmsf-01',
    draft,
    catalogNamespace,
    problems,
    root,
    readAs: { version: root?.version ?? null, drafts: [...drafts] },
  }
}

/** "MSF-01", "CMSF-00" */
function draftName(draft: CatalogDraft): string {
  return draft.toUpperCase()
}

const OPERATION_FIELDS = ['addTracks', 'removeTracks', 'cloneTracks'] as const

function stringAt(value: JsonValue | undefined): string | null {
  return typeof value === 'string' ? value : null
}

/** What a path into a catalog object is about, and the rest of the path past it */
function subjectOf(
  root: JsonObject | null,
  path: string,
): { subject: ProblemSubject; rest: string | null } {
  const rest = (s: string | undefined): string | null => (s === undefined || s === '' ? null : s)
  let m = /^tracks\[(\d+)\](?:\.(.*))?$/.exec(path)
  if (m !== null) {
    const index = Number(m[1])
    const track = Array.isArray(root?.tracks) ? root.tracks[index] : undefined
    const name = isObject(track) ? stringAt(track.name) : null
    return { subject: { kind: 'track', index, name }, rest: rest(m[2]) }
  }
  m = /^deltaUpdate\[(\d+)\](?:\.tracks\[(\d+)\])?(?:\.(.*))?$/.exec(path)
  if (m !== null) {
    const op = Number(m[1])
    const entry = Array.isArray(root?.deltaUpdate) ? root.deltaUpdate[op] : undefined
    const kind = isObject(entry) ? entry.op : undefined
    const operation = kind === 'add' || kind === 'remove' || kind === 'clone' ? kind : null
    const index = m[2] === undefined ? null : Number(m[2])
    const tracks = isObject(entry) && Array.isArray(entry.tracks) ? entry.tracks : []
    const track = index === null ? undefined : tracks[index]
    const name = isObject(track) ? stringAt(track.name) : null
    return {
      subject: { kind: 'delta', op, operation, index, name },
      rest: index === null && m[3] === 'tracks' ? 'tracks' : rest(m[3]),
    }
  }
  m = /^(addTracks|removeTracks|cloneTracks)\[(\d+)\](?:\.(.*))?$/.exec(path)
  if (m !== null) {
    const field = m[1] as (typeof OPERATION_FIELDS)[number]
    const index = Number(m[2])
    const op = Object.keys(root ?? {})
      .filter((f) => msf00Operation(f) !== null)
      .indexOf(field)
    const list = root?.[field]
    const track = Array.isArray(list) ? list[index] : undefined
    return {
      subject: {
        kind: 'delta',
        op,
        operation: msf00Operation(field),
        index,
        name: isObject(track) ? stringAt(track.name) : null,
      },
      rest: rest(m[3]),
    }
  }
  m = /^(initDataList|contentProtections)\[(\d+)\](?:\.(.*))?$/.exec(path)
  if (m !== null) {
    return {
      subject: {
        kind: 'entry',
        list: m[1] as 'initDataList' | 'contentProtections',
        index: Number(m[2]),
      },
      rest: rest(m[3]),
    }
  }
  return { subject: { kind: 'root' }, rest: rest(path) }
}

/** One problem as a check states it; the rest is filled in from the path */
interface Report {
  id: CheckId
  category: CatalogProblemCategory
  path: string
  spec: SpecRef
  also?: SpecRef[]
  family?: string
  /** Default: the path past the subject */
  field?: string | null
  expected: string
  /** Default: absent */
  actual?: ProblemActual
  values?: Record<string, JsonValue>
  subject?: ProblemSubject
}

function makeProblem(
  severity: CatalogProblem['severity'],
  rep: Report,
  root: JsonObject | null,
  readAs: CatalogProblem['readAs'],
): CatalogProblem {
  const at = subjectOf(root, rep.path)
  const p: CatalogProblem = {
    severity,
    category: rep.category,
    path: rep.path,
    section: specLabel(rep.spec),
    message: '',
    id: rep.id,
    family: rep.family ?? rep.id,
    spec: rep.spec,
    also: rep.also ?? [],
    effect: severity === 'error' ? 'refused' : 'applied',
    subject: rep.subject ?? at.subject,
    field: rep.field !== undefined ? rep.field : at.rest,
    expected: rep.expected,
    actual: rep.actual ?? { kind: 'absent' },
    values: rep.values ?? {},
    readAs,
  }
  p.message = problemTitle([p])
  return p
}

function error(r: Rules, rep: Report): void {
  r.problems.push(makeProblem('error', rep, r.root, r.readAs))
}

function warn(r: Rules, rep: Report): void {
  r.problems.push(makeProblem('warning', rep, r.root, r.readAs))
}

/** The `.missing` problem of a required field */
function missing(
  r: Rules,
  scope: string,
  path: string,
  field: string,
  options: {
    spec?: SpecRef
    family?: string
    id?: CheckId
    values?: Record<string, JsonValue>
  } = {},
): Report {
  const type = fieldType(field, r.draft)
  const spec = options.spec ?? fieldRef(field, r.draft, 'REQUIRED')
  if (spec === null) throw new Error(`no definition of ${field}`)
  return {
    id: options.id ?? (`${scope}.${field}.missing` as CheckId),
    category: 'missing_field',
    path,
    spec,
    ...(options.family === undefined ? {} : { family: options.family }),
    expected: type === null ? `${field} present` : `${field}: ${type}`,
    values: { ...(type === null ? {} : { type }), ...options.values },
  }
}

/** The `.type` problem of a value of the wrong JSON type */
function wrongType(
  r: Rules,
  scope: string,
  path: string,
  field: string,
  value: JsonValue,
  options: { spec?: SpecRef; type?: string; idField?: string } = {},
): Report {
  const type = options.type ?? fieldType(field, r.draft) ?? 'String'
  const spec = options.spec ?? fieldRef(field, r.draft, 'TYPE')
  if (spec === null) throw new Error(`no definition of ${field}`)
  return {
    id: `${scope}.${options.idField ?? field}.type` as CheckId,
    category: 'invalid_value',
    path,
    spec,
    family: 'catalog.type',
    expected: `JSON ${type}`,
    actual: { kind: 'value', value },
    values: { type },
  }
}

/**
 * The JSON type a track field must have under the draft, or `undefined` for a
 * field the draft does not define (which a parser ignores). `name` and
 * `namespace` are checked on their own, since a reader needs them.
 */
function trackFieldKind(r: Rules, field: string): JsonKind | undefined {
  switch (field) {
    // Both MSF drafts (msf-00 5.1.x, msf-01 5.2.x)
    case 'packaging':
    case 'eventType':
    case 'role':
    case 'label':
    case 'codec':
    case 'mimeType':
    case 'channelConfig':
    case 'lang':
    case 'parentName':
      return 'string'
    case 'isLive':
      return 'boolean'
    case 'targetLatency':
    case 'renderGroup':
    case 'altGroup':
    case 'temporalId':
    case 'spatialId':
    case 'framerate':
    case 'timescale':
    case 'bitrate':
    case 'width':
    case 'height':
    case 'samplerate':
    case 'displayWidth':
    case 'displayHeight':
    case 'trackDuration':
      return 'number'
    case 'depends':
      return 'array'
    // MSF-00 only (5.1.20)
    case 'initData':
      return r.base === 0 ? 'string' : undefined
    // MSF-01 only (5.2.x)
    case 'parentNamespace':
    case 'initRef':
    case 'connectionUri':
    case 'token':
    case 'encryptionScheme':
    case 'cipherSuite':
    case 'keyId':
    case 'trackBaseKey':
      return r.base === 1 ? 'string' : undefined
    case 'avgBitrate':
    case 'maxGopDuration':
    case 'maxGroupDuration':
      return r.base === 1 ? 'number' : undefined
    case 'buffers':
    case 'authInfo':
      return r.base === 1 ? 'object' : undefined
    case 'template':
    case 'accessibility':
      return r.base === 1 ? 'array' : undefined
    // CMSF (3.5.2, and CMSF-01 4.1.2)
    case 'maxGrpSapStartingType':
    case 'maxObjSapStartingType':
      return r.cmsf ? 'number' : undefined
    case 'contentProtectionRefIDs':
      return r.cmsf && r.base === 1 ? 'array' : undefined
    default:
      return undefined
  }
}

/** Allowed packaging values (msf-00 Table 3, msf-01 Table 4, cmsf 3.5.1 Table 1) */
function packagingAllowed(r: Rules, value: string): boolean {
  switch (value) {
    case 'loc':
    case 'mediatimeline':
    case 'eventtimeline':
      return true
    case 'moqlog':
    case 'moqmetrics':
      return r.base === 1
    case 'cmaf':
      return r.cmsf
    default:
      return false
  }
}

/** The init field of the other CMSF revision: initData for -01, initRef for -00 */
function otherInitField(r: Rules, track: JsonObject): ProblemActual {
  if (r.base === 1 && track.initData !== undefined) {
    const bytes = typeof track.initData === 'string' ? decodeBase64(track.initData) : null
    return { kind: 'other-field', field: 'initData', bytes: bytes === null ? null : bytes.length }
  }
  if (r.base === 0 && track.initRef !== undefined) {
    return { kind: 'other-field', field: 'initRef', bytes: null }
  }
  return { kind: 'absent' }
}

/**
 * Check one track object. `clone` marks the track a clone operation produced,
 * where the parent fields were allowed. Returns false when the track cannot
 * be keyed by namespace and name.
 */
function checkTrack(r: Rules, track: JsonValue, path: string, clone = false): boolean {
  if (!isObject(track)) {
    error(r, {
      id: 'catalog.track.object',
      category: 'invalid_value',
      path,
      spec: ruleRef('trackObject', r.draft),
      field: null,
      expected: 'JSON Object',
      actual: { kind: 'value', value: track },
    })
    return false
  }
  const S = 'catalog.track'
  let keyed = true
  if (track.name === undefined) {
    error(r, missing(r, S, `${path}.name`, 'name', { family: 'catalog.track.fields' }))
    keyed = false
  } else if (typeof track.name !== 'string') {
    error(r, wrongType(r, S, `${path}.name`, 'name', track.name))
    keyed = false
  }
  if (track.namespace !== undefined && typeof track.namespace !== 'string') {
    error(r, wrongType(r, S, `${path}.namespace`, 'namespace', track.namespace))
    keyed = false
  }

  for (const [field, value] of Object.entries(track)) {
    const kind = trackFieldKind(r, field)
    if (kind !== undefined && kindOf(value) !== kind) {
      warn(r, wrongType(r, S, `${path}.${field}`, field, value))
    }
  }

  const { packaging, isLive, eventType } = track
  if (packaging === undefined) {
    warn(r, missing(r, S, `${path}.packaging`, 'packaging', { family: 'catalog.track.fields' }))
  } else if (typeof packaging === 'string' && !packagingAllowed(r, packaging)) {
    warn(r, {
      id: 'catalog.track.packaging.value',
      category: 'invalid_value',
      path: `${path}.packaging`,
      spec: ruleRef('packagingAllowed', r.draft),
      expected: `a packaging value ${draftName(r.draft)} lists`,
      actual: { kind: 'value', value: packaging },
      values: { packaging },
    })
  }
  if (isLive === undefined) {
    warn(r, missing(r, S, `${path}.isLive`, 'isLive', { family: 'catalog.track.fields' }))
  }

  // eventType: required with eventtimeline packaging, and only allowed there
  if (packaging === 'eventtimeline' && eventType === undefined) {
    warn(
      r,
      missing(r, S, `${path}.eventType`, 'eventType', {
        spec: ruleRef('eventTypeRequired', r.draft),
        family: 'catalog.track.fields',
      }),
    )
  } else if (
    typeof packaging === 'string' &&
    packaging !== 'eventtimeline' &&
    eventType !== undefined
  ) {
    warn(r, {
      id: 'catalog.track.eventType.forbidden',
      category: 'forbidden_field',
      path: `${path}.eventType`,
      spec: ruleRef('eventTypeForbidden', r.draft),
      expected: 'no eventType unless packaging is "eventtimeline"',
      actual: { kind: 'value', value: eventType },
      values: { packaging },
    })
  }

  if (r.base === 0 && track.targetLatency !== undefined && isLive === false) {
    warn(r, {
      id: 'catalog.track.targetLatency.forbidden',
      category: 'forbidden_field',
      path: `${path}.targetLatency`,
      spec: ruleRef('targetLatencyNotLive', r.draft),
      expected: 'no targetLatency while isLive is false',
      actual: { kind: 'value', value: track.targetLatency },
    })
  }
  // MSF-01 ignores targetLatency when not live (5.2.8), and makes
  // targetLatency and buffers exclusive (5.2.8, 5.2.9).
  if (r.base === 1 && track.targetLatency !== undefined && track.buffers !== undefined) {
    warn(r, {
      id: 'catalog.track.buffers.forbidden',
      category: 'forbidden_field',
      path: `${path}.buffers`,
      spec: ruleRef('buffersWithLatency', r.draft),
      expected: 'buffers or targetLatency, not both',
      actual: { kind: 'value', value: track.buffers },
    })
  }
  if (track.trackDuration !== undefined && isLive === true) {
    warn(r, {
      id: 'catalog.track.trackDuration.forbidden',
      category: 'forbidden_field',
      path: `${path}.trackDuration`,
      spec: ruleRef('trackDurationLive', r.draft),
      expected: 'no trackDuration while isLive is true',
      actual: { kind: 'value', value: track.trackDuration },
    })
  }
  if (!clone) {
    if (track.parentName !== undefined) {
      warn(r, {
        id: 'catalog.track.parentName.forbidden',
        category: 'forbidden_field',
        path: `${path}.parentName`,
        spec: ruleRef('parentName', r.draft),
        expected: 'parentName only inside a clone operation',
        actual: { kind: 'value', value: track.parentName },
      })
    }
    if (r.base === 1 && track.parentNamespace !== undefined) {
      warn(r, {
        id: 'catalog.track.parentNamespace.forbidden',
        category: 'forbidden_field',
        path: `${path}.parentNamespace`,
        spec: ruleRef('parentNamespace', r.draft),
        expected: 'parentNamespace only inside a clone operation',
        actual: { kind: 'value', value: track.parentNamespace },
      })
    }
  }

  if (r.base === 1) {
    // MSF-01's conditional fields for roles 'audio' and 'video' (Table 5,
    // 5.2.6): codec (5.2.18), bitrate (5.2.22), and for audio samplerate and
    // channelConfig (5.2.28, 5.2.29).
    const role = track.role
    const audio = role === 'audio'
    if (audio || role === 'video') {
      for (const field of ['codec', 'bitrate'] as const) {
        if (track[field] === undefined) {
          warn(
            r,
            missing(r, S, `${path}.${field}`, field, {
              spec: ruleRef(field, r.draft),
              family: 'catalog.media.fields',
              values: { role },
            }),
          )
        }
      }
    }
    if (audio) {
      for (const field of ['samplerate', 'channelConfig'] as const) {
        if (track[field] === undefined) {
          warn(
            r,
            missing(r, 'catalog.audio', `${path}.${field}`, field, {
              spec: ruleRef(field, r.draft),
              family: 'catalog.audio.fields',
              values: { role },
            }),
          )
        }
      }
    }
    if (track.encryptionScheme !== undefined && track.cipherSuite === undefined) {
      warn(
        r,
        missing(r, S, `${path}.cipherSuite`, 'cipherSuite', {
          spec: ruleRef('cipherSuite', r.draft),
        }),
      )
    }
  }

  if (r.base === 0 && typeof track.initData === 'string' && decodeBase64(track.initData) === null) {
    warn(r, {
      id: 'catalog.track.initData.base64',
      category: 'invalid_value',
      path: `${path}.initData`,
      spec: ruleRef('initDataBase64', r.draft),
      expected: 'Base64 (RFC 4648), padded',
      actual: { kind: 'value', value: track.initData },
    })
  }

  if (r.cmsf) {
    if (packaging === 'cmaf') {
      // CMSF-00 carries the CMAF header in the track's initData; CMSF-01 in
      // an initDataList entry the track names by initRef (3.1).
      const field = r.base === 0 ? 'initData' : 'initRef'
      if (track[field] === undefined) {
        const actual = otherInitField(r, track)
        const other = actual.kind === 'other-field'
        warn(r, {
          id: other ? 'catalog.init.other-draft-field' : 'catalog.init.missing',
          category: 'missing_field',
          path: `${path}.${field}`,
          spec: ruleRef('cmsfInit', r.draft),
          also:
            r.base === 1
              ? [fieldRef('initDataList', r.draft, 'TYPE')!, fieldRef('initRef', r.draft, 'TYPE')!]
              : [fieldRef('initData', r.draft, 'TYPE')!],
          expected:
            r.base === 1
              ? 'initDataList entry {id, type "inline", data}; the track\'s initRef = that id'
              : 'initData: the CMAF header as Base64',
          actual,
        })
      }
    }
    // Each Group "MUST begin with an Object containing a stream access point
    // (SAP) type 1 or 2" (3.4), so the most a Group starts with is 1 or 2.
    const maxGrp = track.maxGrpSapStartingType
    if (typeof maxGrp === 'number' && maxGrp !== 1 && maxGrp !== 2) {
      warn(r, {
        id: 'catalog.track.maxGrpSapStartingType.value',
        category: 'invalid_value',
        path: `${path}.maxGrpSapStartingType`,
        spec: ruleRef('maxGrpSap', r.draft),
        also: [ruleRef('maxGrpSapField', r.draft)],
        expected: '1 or 2',
        actual: { kind: 'value', value: maxGrp },
        values: { value: maxGrp },
      })
    }
    if (eventType === SAP_EVENT_TYPE && packaging !== 'eventtimeline') {
      warn(r, {
        id: 'catalog.track.sapTimeline.packaging',
        category: 'invalid_value',
        path: `${path}.packaging`,
        spec: ruleRef('sapTimelineCatalog', r.draft),
        expected: 'packaging "eventtimeline"',
        actual: packaging === undefined ? { kind: 'absent' } : { kind: 'value', value: packaging },
      })
    }
    if (r.base === 1 && track.contentProtections !== undefined) {
      warn(r, {
        id: 'catalog.track.contentProtections.forbidden',
        category: 'forbidden_field',
        path: `${path}.contentProtections`,
        spec: ruleRef('contentProtectionsAtTrack', r.draft),
        expected: 'content protection only at the root, named by contentProtectionRefIDs',
        actual: { kind: 'value', value: track.contentProtections },
      })
    }
  }
  return keyed
}

/** Repeated (namespace, name) pairs in one tracks array */
function checkDuplicates(r: Rules, tracks: JsonValue[], path: string): void {
  const seen = new Set<string>()
  tracks.forEach((track, i) => {
    if (!isObject(track) || typeof track.name !== 'string') return
    const key = trackKey(namespaceOf(track, r.catalogNamespace), track.name)
    if (seen.has(key)) {
      warn(r, {
        id: 'catalog.track.duplicate',
        category: 'duplicate_track',
        path: `${path}[${i}]`,
        spec: ruleRef('uniqueNames', r.draft),
        field: 'name',
        expected: 'a name unique within its namespace',
        actual: { kind: 'value', value: track.name },
      })
    }
    seen.add(key)
  })
}

/** MSF-01's initDataList (5.1.7), as CMSF-01 uses it (3.1) */
function checkInitDataList(r: Rules, root: JsonObject): void {
  const list = root.initDataList
  if (list === undefined) return
  if (!Array.isArray(list)) {
    warn(r, wrongType(r, 'catalog.root', 'initDataList', 'initDataList', list))
    return
  }
  // Member order is the document's: JSON.parse keeps the order of string keys.
  const keys = Object.keys(root)
  const tracksAt = keys.indexOf('tracks')
  if (tracksAt >= 0 && keys.indexOf('initDataList') < tracksAt) {
    warn(r, {
      id: 'catalog.root.initDataList.misplaced',
      category: 'misplaced_field',
      path: 'initDataList',
      spec: ruleRef('initDataListAfterTracks', r.draft),
      expected: 'initDataList after tracks',
      actual: { kind: 'value', value: 'before tracks' },
    })
  }
  const S = 'catalog.initDataList'
  const entryRule = ruleRef('initDataList', r.draft)
  const ids = new Set<string>()
  list.forEach((entry, i) => {
    const path = `initDataList[${i}]`
    if (!isObject(entry)) {
      warn(r, {
        id: 'catalog.initDataList.entry.object',
        category: 'invalid_value',
        path,
        spec: entryRule,
        field: null,
        expected: 'JSON Object {id, type, data}',
        actual: { kind: 'value', value: entry },
      })
      return
    }
    for (const field of ['id', 'type', 'data'] as const) {
      const value = entry[field]
      if (value === undefined) {
        warn(r, {
          id: `${S}.${field}.missing`,
          category: 'missing_field',
          path: `${path}.${field}`,
          spec: entryRule,
          family: 'catalog.initDataList.fields',
          expected: `${field}: String`,
          values: { type: 'String' },
        })
      } else if (typeof value !== 'string') {
        warn(
          r,
          wrongType(r, S, `${path}.${field}`, field, value, { spec: entryRule, type: 'String' }),
        )
      }
    }
    if (typeof entry.id === 'string') {
      if (ids.has(entry.id)) {
        warn(r, {
          id: 'catalog.initDataList.id.duplicate',
          category: 'duplicate_id',
          path: `${path}.id`,
          spec: ruleRef('initDataListId', r.draft),
          expected: 'an id unique within the catalog',
          actual: { kind: 'value', value: entry.id },
          values: { id: entry.id },
        })
      }
      ids.add(entry.id)
    }
    if (typeof entry.type === 'string' && entry.type !== 'inline') {
      warn(r, {
        id: 'catalog.initDataList.type.value',
        category: 'invalid_value',
        path: `${path}.type`,
        spec: ruleRef('initDataListType', r.draft),
        expected: 'type "inline"',
        actual: { kind: 'value', value: entry.type },
        values: { type: entry.type },
      })
    } else if (
      entry.type === 'inline' &&
      typeof entry.data === 'string' &&
      decodeBase64(entry.data) === null
    ) {
      warn(r, {
        id: 'catalog.initDataList.data.base64',
        category: 'invalid_value',
        path: `${path}.data`,
        spec: ruleRef('initDataListInline', r.draft),
        expected: 'Base64 (RFC 4648), padded',
        actual: { kind: 'value', value: entry.data },
      })
    }
  })
}

const CP = 'catalog.contentProtections'

/** An object holding a url: laURL, certURL (cmsf-01 4.1.1.4.2, 4.1.1.4.3) */
function checkUrlObject(
  r: Rules,
  value: JsonValue,
  path: string,
  field: 'laURL' | 'certURL',
): void {
  const spec = ruleRef(field === 'laURL' ? 'laUrl' : 'certUrl', r.draft)
  if (!isObject(value)) {
    warn(r, wrongType(r, CP, path, field, value))
  } else if (value.url === undefined) {
    warn(r, {
      id: `${CP}.url.missing`,
      category: 'missing_field',
      path: `${path}.url`,
      spec,
      family: `${CP}.fields`,
      expected: 'url: String',
      values: { type: 'String' },
    })
  } else if (typeof value.url !== 'string') {
    warn(r, wrongType(r, CP, `${path}.url`, 'url', value.url, { spec, type: 'String' }))
  }
}

/** CMSF-01's root contentProtections (4.1.1) */
function checkContentProtections(r: Rules, root: JsonObject): void {
  const list = root.contentProtections
  if (list === undefined) return
  if (!Array.isArray(list)) {
    warn(r, wrongType(r, 'catalog.root', 'contentProtections', 'contentProtections', list))
    return
  }
  const required = (path: string, field: string): Report =>
    missing(r, CP, path, field, { family: `${CP}.fields` })
  const refIds = new Set<string>()
  list.forEach((entry, i) => {
    const path = `contentProtections[${i}]`
    if (!isObject(entry)) {
      warn(r, {
        id: 'catalog.contentProtections.entry.object',
        category: 'invalid_value',
        path,
        spec: ruleRef('contentProtectionEntry', r.draft),
        field: null,
        expected: 'JSON Object',
        actual: { kind: 'value', value: entry },
      })
      return
    }
    const { refID, defaultKID, scheme, drmSystem } = entry
    if (refID === undefined) {
      warn(r, required(`${path}.refID`, 'refID'))
    } else if (typeof refID !== 'string') {
      warn(r, wrongType(r, CP, `${path}.refID`, 'refID', refID))
    } else {
      if (refIds.has(refID)) {
        warn(r, {
          id: 'catalog.contentProtections.refID.duplicate',
          category: 'duplicate_id',
          path: `${path}.refID`,
          spec: ruleRef('refIdUnique', r.draft),
          expected: 'a refID unique within contentProtections',
          actual: { kind: 'value', value: refID },
          values: { refID },
        })
      }
      refIds.add(refID)
    }
    if (defaultKID === undefined) {
      warn(r, required(`${path}.defaultKID`, 'defaultKID'))
    } else if (!Array.isArray(defaultKID)) {
      warn(r, wrongType(r, CP, `${path}.defaultKID`, 'defaultKID', defaultKID))
    } else {
      defaultKID.forEach((kid, k) => {
        if (typeof kid !== 'string' || !UUID.test(kid)) {
          warn(r, {
            id: 'catalog.contentProtections.defaultKID.value',
            category: 'invalid_value',
            path: `${path}.defaultKID[${k}]`,
            spec: ruleRef('defaultKid', r.draft),
            expected: 'a UUID string, xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
            actual: { kind: 'value', value: kid },
          })
        }
      })
    }
    if (scheme === undefined) {
      warn(r, required(`${path}.scheme`, 'scheme'))
    } else if (scheme !== 'cenc' && scheme !== 'cbcs') {
      warn(r, {
        id: 'catalog.contentProtections.scheme.value',
        category: 'invalid_value',
        path: `${path}.scheme`,
        spec: ruleRef('scheme', r.draft),
        expected: '"cenc" or "cbcs"',
        actual: { kind: 'value', value: scheme },
        values: { scheme },
      })
    }
    if (drmSystem === undefined) {
      warn(r, required(`${path}.drmSystem`, 'drmSystem'))
      return
    }
    if (!isObject(drmSystem)) {
      warn(r, wrongType(r, CP, `${path}.drmSystem`, 'drmSystem', drmSystem))
      return
    }
    const drm = `${path}.drmSystem`
    const systemID = drmSystem.systemID
    if (systemID === undefined) {
      warn(r, required(`${drm}.systemID`, 'systemID'))
    } else if (typeof systemID !== 'string' || !UUID.test(systemID)) {
      warn(r, {
        id: 'catalog.contentProtections.systemID.value',
        category: 'invalid_value',
        path: `${drm}.systemID`,
        spec: ruleRef('systemId', r.draft),
        expected: 'a UUID string',
        actual: { kind: 'value', value: systemID },
      })
    }
    if (drmSystem.laURL !== undefined) {
      checkUrlObject(r, drmSystem.laURL, `${drm}.laURL`, 'laURL')
    }
    if (drmSystem.certURL !== undefined) {
      checkUrlObject(r, drmSystem.certURL, `${drm}.certURL`, 'certURL')
    }
    const pssh = drmSystem.pssh
    if (pssh !== undefined && (typeof pssh !== 'string' || decodeBase64(pssh) === null)) {
      warn(r, {
        id: 'catalog.contentProtections.pssh.value',
        category: 'invalid_value',
        path: `${drm}.pssh`,
        spec: ruleRef('pssh', r.draft),
        expected: 'a Base64 PSSH box',
        actual: { kind: 'value', value: pssh },
      })
    }
  })
}

/** The entries of a root array by id; an id given more than once maps to `null` */
function entriesById(list: JsonValue | undefined, idField: string): Map<string, JsonObject | null> {
  const byId = new Map<string, JsonObject | null>()
  if (!Array.isArray(list)) return byId
  for (const entry of list) {
    if (!isObject(entry)) continue
    const id = entry[idField]
    if (typeof id === 'string') byId.set(id, byId.has(id) ? null : entry)
  }
  return byId
}

/**
 * initRef (msf-01 5.2.13) and contentProtectionRefIDs (cmsf-01 4.1.2) that
 * name no entry, or an id given more than once (msf-01 5.1.7, cmsf-01
 * 4.1.1.1). Warnings.
 */
function checkReferences(r: Rules, document: JsonObject, tracks: [JsonObject, string][]): void {
  if (r.base !== 1) return
  const inits = entriesById(document.initDataList, 'id')
  const protections = r.cmsf
    ? entriesById(document.contentProtections, 'refID')
    : new Map<string, JsonObject | null>()
  for (const [track, path] of tracks) {
    if (typeof track.initRef === 'string') {
      const entry = inits.get(track.initRef)
      if (entry === undefined || entry === null) {
        warn(r, {
          id:
            entry === undefined
              ? 'catalog.track.initRef.unknown'
              : 'catalog.track.initRef.ambiguous',
          category: entry === undefined ? 'unknown_reference' : 'duplicate_id',
          path: `${path}.initRef`,
          spec:
            entry === undefined ? ruleRef('initRef', r.draft) : ruleRef('initDataListId', r.draft),
          expected: 'the id of exactly one initDataList entry',
          actual: { kind: 'value', value: track.initRef },
          values: { ref: track.initRef },
        })
      }
    }
    const refs = track.contentProtectionRefIDs
    if (!r.cmsf || !Array.isArray(refs)) continue
    refs.forEach((ref, k) => {
      const at = `${path}.contentProtectionRefIDs[${k}]`
      if (typeof ref !== 'string') {
        warn(
          r,
          wrongType(r, 'catalog.track', at, `contentProtectionRefIDs[${k}]`, ref, {
            spec: ruleRef('contentProtectionRefs', r.draft),
            type: 'String',
            idField: 'contentProtectionRefIDs',
          }),
        )
        return
      }
      const entry = protections.get(ref)
      if (entry === undefined || entry === null) {
        warn(r, {
          id:
            entry === undefined
              ? 'catalog.track.contentProtectionRef.unknown'
              : 'catalog.track.contentProtectionRef.ambiguous',
          category: entry === undefined ? 'unknown_reference' : 'duplicate_id',
          path: at,
          spec:
            entry === undefined
              ? ruleRef('contentProtectionRefs', r.draft)
              : ruleRef('refIdUnique', r.draft),
          expected: 'the refID of exactly one contentProtections entry',
          actual: { kind: 'value', value: ref },
          values: { ref },
        })
      }
    })
  }
}

/** Whether the version is one this module reads (msf 5.1.1); reports when not */
function checkVersion(r: Rules, root: JsonObject): boolean {
  const version = root.version
  if (version === undefined) {
    error(r, missing(r, 'catalog.root', 'version', 'version'))
    return false
  }
  if (r.base === 0 && typeof version !== 'number') {
    error(r, wrongType(r, 'catalog.root', 'version', 'version', version))
    return false
  }
  if (r.base === 1 && typeof version !== 'string') {
    error(r, wrongType(r, 'catalog.root', 'version', 'version', version))
    return false
  }
  // MSF-00 describes version 1, and CMSF-00's example writes 1. MSF-01 5.1.1
  // asks for "draft-01", but every MSF-01 and CMSF-01 example writes "1".
  const ok = r.base === 0 ? version === 1 : version === 'draft-01' || version === '1'
  if (!ok) {
    error(r, {
      id: 'catalog.root.version.unsupported',
      category: 'unsupported_version',
      path: 'version',
      spec: ruleRef('versionUnsupported', r.draft),
      expected:
        r.base === 0 ? 'version 1' : 'version "draft-01" (or "1", as the examples write it)',
      actual: { kind: 'value', value: version },
      values: { version, supported: r.base === 0 ? '1' : '"draft-01"' },
    })
    return false
  }
  return true
}

function objectEntries(list: JsonValue, path: string): [JsonObject, string][] {
  const out: [JsonObject, string][] = []
  if (Array.isArray(list)) {
    list.forEach((t, i) => {
      if (isObject(t)) out.push([t, `${path}[${i}]`])
    })
  }
  return out
}

function checkIndependent(r: Rules, root: JsonObject): void {
  // "A subscriber MUST NOT attempt to parse a catalog version which it does
  // not understand" (5.1.1): nothing past the version is read.
  if (!checkVersion(r, root)) return
  const R = 'catalog.root'
  const tracks = root.tracks
  if (tracks === undefined) {
    error(r, missing(r, R, 'tracks', 'tracks'))
  } else if (!Array.isArray(tracks)) {
    error(r, wrongType(r, R, 'tracks', 'tracks', tracks))
  } else {
    tracks.forEach((track, i) => {
      checkTrack(r, track, `tracks[${i}]`)
    })
    checkDuplicates(r, tracks, 'tracks')
  }

  if (root.generatedAt !== undefined && typeof root.generatedAt !== 'number') {
    warn(r, wrongType(r, R, 'generatedAt', 'generatedAt', root.generatedAt))
  }
  if (root.isComplete !== undefined) {
    if (typeof root.isComplete !== 'boolean') {
      warn(r, wrongType(r, R, 'isComplete', 'isComplete', root.isComplete))
    } else if (!root.isComplete) {
      warn(r, {
        id: 'catalog.root.isComplete.false',
        category: 'forbidden_field',
        path: 'isComplete',
        spec: ruleRef('isCompleteFalse', r.draft),
        expected: 'isComplete absent, or true',
        actual: { kind: 'value', value: false },
      })
    }
  }
  if (r.base === 1) {
    if (root.publishTracks !== undefined && !Array.isArray(root.publishTracks)) {
      warn(r, wrongType(r, R, 'publishTracks', 'publishTracks', root.publishTracks))
    }
    checkInitDataList(r, root)
  }
  if (r.cmsf && r.base === 1) checkContentProtections(r, root)
  checkReferences(r, root, objectEntries(tracks ?? null, 'tracks'))
}

/** A remove entry: a name, perhaps a namespace, nothing else (msf-00 5.1.4, msf-01 5.1.6) */
function checkRemoveEntry(r: Rules, entry: JsonObject, path: string): void {
  const spec = ruleRef('removeEntry', r.draft)
  const S = 'catalog.delta.remove'
  if (entry.name === undefined) {
    error(r, missing(r, S, `${path}.name`, 'name', { spec }))
  } else if (typeof entry.name !== 'string') {
    error(r, wrongType(r, S, `${path}.name`, 'name', entry.name))
  }
  if (entry.namespace !== undefined && typeof entry.namespace !== 'string') {
    error(r, wrongType(r, S, `${path}.namespace`, 'namespace', entry.namespace))
  }
  for (const field of Object.keys(entry)) {
    if (field !== 'name' && field !== 'namespace') {
      warn(r, {
        id: 'catalog.delta.remove.field.forbidden',
        category: 'forbidden_field',
        path: `${path}.${field}`,
        spec,
        expected: 'name and, perhaps, namespace; no other field',
        actual: { kind: 'value', value: entry[field]! },
      })
    }
  }
}

/** A clone entry, before it meets its parent (msf-00 5.1.5, msf-01 5.1.6) */
function checkCloneEntry(r: Rules, entry: JsonObject, path: string): void {
  const S = 'catalog.delta.clone'
  if (entry.parentName === undefined) {
    error(
      r,
      missing(r, S, `${path}.parentName`, 'parentName', { spec: ruleRef('cloneEntry', r.draft) }),
    )
  } else if (typeof entry.parentName !== 'string') {
    error(r, wrongType(r, S, `${path}.parentName`, 'parentName', entry.parentName))
  }
  if (
    r.base === 1 &&
    entry.parentNamespace !== undefined &&
    typeof entry.parentNamespace !== 'string'
  ) {
    error(r, wrongType(r, S, `${path}.parentNamespace`, 'parentNamespace', entry.parentNamespace))
  }
  // The clone's name "MUST be new" (msf-00 5.2, msf-01 5.1.6); without one it
  // would be its parent's.
  if (entry.name === undefined) {
    error(r, missing(r, S, `${path}.name`, 'name', { spec: ruleRef('cloneName', r.draft) }))
  } else if (typeof entry.name !== 'string') {
    error(r, wrongType(r, S, `${path}.name`, 'name', entry.name))
  }
  if (entry.namespace !== undefined && typeof entry.namespace !== 'string') {
    error(r, wrongType(r, S, `${path}.namespace`, 'namespace', entry.namespace))
  }
}

/** One operation's track entries; any that is not an object is reported */
function operationTracks(r: Rules, list: JsonValue[], path: string): JsonObject[] {
  const tracks: JsonObject[] = []
  list.forEach((entry, i) => {
    if (isObject(entry)) tracks.push(entry)
    else
      error(r, {
        id: 'catalog.track.object',
        category: 'invalid_value',
        path: `${path}[${i}]`,
        spec: ruleRef('trackObject', r.draft),
        field: null,
        expected: 'JSON Object',
        actual: { kind: 'value', value: entry },
      })
  })
  return tracks
}

/** MSF-00's delta operation fields, in the order of its 5.1.3-5.1.5 */
function msf00Operation(field: string): DeltaOperation['op'] | null {
  if (field === 'addTracks') return 'add'
  if (field === 'removeTracks') return 'remove'
  if (field === 'cloneTracks') return 'clone'
  return null
}

/** A delta's operations, in order, by its draft's shape */
function checkDelta(r: Rules, root: JsonObject): DeltaOperation[] {
  const D = 'catalog.delta'
  for (const field of ['tracks', 'version'] as const) {
    if (root[field] !== undefined) {
      error(r, {
        id: `${D}.${field}.forbidden`,
        category: 'delta_not_allowed_field',
        path: field,
        spec: ruleRef('deltaForbidden', r.draft),
        family: 'catalog.delta.forbidden',
        expected: 'no tracks and no version in a delta update',
        actual: { kind: 'value', value: root[field]! },
      })
    }
  }
  const operations: DeltaOperation[] = []
  const deltaUpdate = root.deltaUpdate as JsonValue

  if (r.base === 0) {
    if (Array.isArray(deltaUpdate)) {
      error(r, wrongType(r, D, 'deltaUpdate', 'deltaUpdate', deltaUpdate))
    } else if (deltaUpdate !== true) {
      error(r, {
        id: 'catalog.delta.deltaUpdate.value',
        category: 'invalid_value',
        path: 'deltaUpdate',
        spec: ruleRef('deltaFlag', r.draft),
        expected: 'deltaUpdate: true',
        actual:
          deltaUpdate === undefined ? { kind: 'absent' } : { kind: 'value', value: deltaUpdate },
      })
    }
    // "The Add, Delete and Clone operations are applied sequentially in the
    // order they are declared in the document" (5.2).
    for (const field of Object.keys(root)) {
      const op = msf00Operation(field)
      if (op === null) continue
      const list = root[field] as JsonValue
      if (Array.isArray(list)) {
        operations.push({ op, tracks: operationTracks(r, list, field), path: field })
      } else {
        error(r, wrongType(r, D, field, field, list))
      }
    }
    if (!Object.keys(root).some((field) => msf00Operation(field) !== null)) {
      error(r, {
        id: 'catalog.delta.operations.missing',
        category: 'missing_field',
        path: 'addTracks',
        spec: ruleRef('deltaOperations', r.draft),
        field: null,
        expected: 'addTracks, removeTracks or cloneTracks',
      })
    }
  } else if (!Array.isArray(deltaUpdate)) {
    error(r, wrongType(r, D, 'deltaUpdate', 'deltaUpdate', deltaUpdate))
  } else if (deltaUpdate.length === 0) {
    error(r, {
      id: 'catalog.delta.operations.empty',
      category: 'invalid_value',
      path: 'deltaUpdate',
      spec: ruleRef('deltaOperations', r.draft),
      expected: 'at least one operation',
      actual: { kind: 'value', value: [] },
    })
  } else {
    const O = 'catalog.delta.operation'
    const opRule = ruleRef('operationFields', r.draft)
    deltaUpdate.forEach((entry, i) => {
      const path = `deltaUpdate[${i}]`
      if (!isObject(entry)) {
        error(r, {
          id: 'catalog.delta.operation.object',
          category: 'invalid_value',
          path,
          spec: opRule,
          field: null,
          expected: 'JSON Object {op, tracks}',
          actual: { kind: 'value', value: entry },
          values: { op: i },
        })
        return
      }
      const { op, tracks } = entry
      let ok = true
      if (op === undefined) {
        error(r, {
          ...missing(r, O, `${path}.op`, 'op', { spec: opRule }),
          expected: 'op: String',
          values: { type: 'String' },
        })
        ok = false
      } else if (op !== 'add' && op !== 'remove' && op !== 'clone') {
        error(r, {
          id: 'catalog.delta.operation.op.value',
          category: 'invalid_value',
          path: `${path}.op`,
          spec: ruleRef('operationTypes', r.draft),
          expected: 'op "add", "remove" or "clone"',
          actual: { kind: 'value', value: op },
          values: { op: i, value: op },
        })
        ok = false
      }
      if (tracks === undefined) {
        error(r, missing(r, O, `${path}.tracks`, 'tracks', { spec: opRule }))
        ok = false
      } else if (!Array.isArray(tracks)) {
        error(
          r,
          wrongType(r, O, `${path}.tracks`, 'tracks', tracks, { spec: opRule, type: 'Array' }),
        )
        ok = false
      }
      if (ok) {
        const at = `${path}.tracks`
        operations.push({
          op: op as DeltaOperation['op'],
          tracks: operationTracks(r, tracks as JsonValue[], at),
          path: at,
        })
      }
    })
  }

  for (const op of operations) {
    op.tracks.forEach((entry, i) => {
      const path = `${op.path}[${i}]`
      if (op.op === 'add') checkTrack(r, entry, path)
      else if (op.op === 'remove') checkRemoveEntry(r, entry, path)
      else checkCloneEntry(r, entry, path)
    })
  }
  if (root.generatedAt !== undefined && typeof root.generatedAt !== 'number') {
    warn(r, wrongType(r, 'catalog.root', 'generatedAt', 'generatedAt', root.generatedAt))
  }
  return operations
}

// ─── Parsing ─────────────────────────────────────────────────────────

/** 0 or 1 from the document's shape, or null when it shows neither */
function baseFromShape(root: JsonObject): 0 | 1 | null {
  if (typeof root.version === 'number') return 0
  if (typeof root.version === 'string') return 1
  if (typeof root.deltaUpdate === 'boolean') return 0
  if (Array.isArray(root.deltaUpdate)) return 1
  if (Object.keys(root).some((field) => msf00Operation(field) !== null)) return 0
  return null
}

function hasCmafTrack(list: JsonValue | undefined): boolean {
  return Array.isArray(list) && list.some((t) => isObject(t) && t.packaging === 'cmaf')
}

/** A cmaf track anywhere, or contentProtections: only CMSF defines either */
function looksCmsf(root: JsonObject): boolean {
  if (root.contentProtections !== undefined) return true
  if (hasCmafTrack(root.tracks) || hasCmafTrack(root.addTracks)) return true
  if (hasCmafTrack(root.cloneTracks)) return true
  return (
    Array.isArray(root.deltaUpdate) &&
    root.deltaUpdate.some((op) => isObject(op) && hasCmafTrack(op.tracks))
  )
}

/** Whether the object is a delta (msf-00 5.1.2-5.1.5, msf-01 5.1.6) */
function isDeltaShape(root: JsonObject, base: 0 | 1): boolean {
  if (root.deltaUpdate !== undefined) return base === 1 || root.deltaUpdate !== false
  return root.tracks === undefined && Object.keys(root).some((f) => msf00Operation(f) !== null)
}

/**
 * Read one catalog object's payload. Never throws: whatever is wrong with it
 * comes back in `problems`, each with the section that says so.
 *
 * `kind` is the object's shape: `independent` or `delta` once it is a JSON
 * object, `invalid` before that. An `error`
 * among the problems means {@link applyCatalogObject} will refuse it.
 *
 * Without `options.draft`, the draft comes from the shape. A Number or String
 * `version`, or a Boolean or Array `deltaUpdate`, tells -00 from -01; a `cmaf`
 * track or a root `contentProtections` makes it CMSF. When nothing makes it
 * CMSF, `draft` is `null`, `candidates` holds the MSF and the CMSF draft, an
 * `ambiguous_draft` warning is reported, and only MSF's rules, which CMSF
 * keeps (cmsf 2), are checked. A shape with no version and no delta fields
 * leaves `candidates` empty.
 */
export function parseCatalog(
  input: string | Uint8Array,
  options: ParseCatalogOptions = {},
): ParsedCatalog {
  const problems: CatalogProblem[] = []
  const hint = options.draft ?? null
  // Before the draft is known, the latest one's rules are cited.
  const early = rulesFor(hint ?? 'msf-01', null, problems, null, hint === null ? [] : [hint])
  const json = ruleRef('json', early.draft)
  const text = decodeText(input)
  if (text === null) {
    error(early, {
      id: 'catalog.json.utf8',
      category: 'invalid_json',
      path: '',
      spec: json,
      field: null,
      expected: 'UTF-8 JSON text (RFC 8259 8.1)',
      actual: { kind: 'value', value: 'bytes that are not UTF-8' },
    })
    return { kind: 'invalid', draft: hint, problems }
  }
  let root: JsonValue
  try {
    root = JSON.parse(text) as JsonValue
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e)
    error(early, {
      id: 'catalog.json.syntax',
      category: 'invalid_json',
      path: '',
      spec: json,
      field: null,
      expected: 'JSON text (RFC 8259)',
      actual: { kind: 'value', value: detail },
    })
    return { kind: 'invalid', draft: hint, problems }
  }
  if (!isObject(root)) {
    error(early, {
      id: 'catalog.root.object',
      category: 'invalid_value',
      path: '',
      spec: json,
      field: null,
      expected: 'JSON Object',
      actual: { kind: 'value', value: root },
    })
    return { kind: 'invalid', draft: hint, problems }
  }

  let draft = hint
  let candidates: CatalogDraft[] = hint === null ? [] : [hint]
  if (hint === null) {
    const base = baseFromShape(root)
    if (base !== null && looksCmsf(root)) {
      draft = `cmsf-0${base}`
      candidates = [draft]
    } else if (base !== null) {
      candidates = [`msf-0${base}`, `cmsf-0${base}`]
    }
  }
  const rulesDraft = draft ?? candidates[0]
  if (rulesDraft === undefined) {
    // No version and no delta fields: nothing says which rules apply.
    const r = rulesFor('msf-01', null, problems, root, [])
    error(r, {
      ...missing(r, 'catalog.root', 'version', 'version'),
      also: [fieldRef('version', 'msf-00', 'REQUIRED')!],
      expected: 'version: String ("draft-01") or Number (1, MSF-00)',
    })
    return { kind: 'independent', draft, candidates, document: root, problems }
  }
  const r = rulesFor(rulesDraft, options.catalogNamespace ?? null, problems, root, candidates)
  if (draft === null) {
    const drafts = candidates.map(draftName).join(' or ')
    warn(r, {
      id: 'catalog.draft.ambiguous',
      category: 'ambiguous_draft',
      path: '',
      spec: ruleRef('ambiguous', `cmsf-0${r.base}`),
      field: null,
      expected: 'a cmaf track or contentProtections, which only CMSF defines',
      actual: { kind: 'absent' },
      values: { drafts },
    })
  }

  if (isDeltaShape(root, r.base)) {
    const operations = checkDelta(r, root)
    return { kind: 'delta', draft, candidates, document: root, operations, problems }
  }
  checkIndependent(r, root)
  return { kind: 'independent', draft, candidates, document: root, problems }
}

// ─── Following a catalog track ───────────────────────────────────────

/**
 * What a catalog track has said so far. Plain data: it survives
 * `structuredClone`, `postMessage` and `JSON.stringify`. Never mutated;
 * {@link applyCatalogObject} returns a new one.
 */
export interface CatalogState {
  /** The draft of the catalog in force, or the one the caller said to expect */
  readonly draft: CatalogDraft | null
  /**
   * The drafts the catalog in force can follow: `[draft]`; while `draft` is
   * `null`, the two candidate drafts, or none before any catalog has applied
   */
  readonly candidates: readonly CatalogDraft[]
  /** The catalog track's namespace, inherited by tracks without one */
  readonly catalogNamespace: string | null
  /**
   * The catalog as an independent catalog would state it now: the last
   * independent catalog with every delta since applied. `null` until an
   * independent catalog arrives.
   */
  readonly document: JsonObject | null
  /** Whether a catalog has said isComplete, which "MUST NOT be removed" (msf-00 5.1.7, msf-01 5.1.3) */
  readonly isComplete: boolean
  /**
   * Opaque keys of the tracks declared with isLive false so far: "A True
   * value MUST never follow a False value" (msf-01 5.2.7). Kept under every
   * draft, but only MSF-01 and CMSF-01 catalogs are checked against it.
   */
  readonly endedTracks: readonly string[]
}

export interface CreateCatalogStateOptions {
  /** The catalog track's namespace, which tracks without their own inherit */
  catalogNamespace?: string
  /** The draft, when known before any catalog arrives */
  draft?: CatalogDraft
}

export function createCatalogState(options: CreateCatalogStateOptions = {}): CatalogState {
  return {
    draft: options.draft ?? null,
    candidates: options.draft === undefined ? [] : [options.draft],
    catalogNamespace: options.catalogNamespace ?? null,
    document: null,
    isComplete: false,
    endedTracks: [],
  }
}

export interface CatalogUpdate {
  state: CatalogState
  /** Whether the object changed the catalog. When false, `state` is the one passed in. */
  applied: boolean
  /** Problems found applying the object, beyond those {@link parseCatalog} reported */
  problems: CatalogProblem[]
}

function trackKeys(tracks: JsonValue | undefined, catalogNamespace: string | null): Set<string> {
  const keys = new Set<string>()
  for (const [track] of objectEntries(tracks ?? null, '')) {
    if (typeof track.name === 'string') {
      keys.add(trackKey(namespaceOf(track, catalogNamespace), track.name))
    }
  }
  return keys
}

/** isLive false then true (msf-01 5.2.7); a new track after isComplete (msf-00 5.1.7, msf-01 5.1.3) */
function checkUpdateRules(
  r: Rules,
  state: CatalogState,
  tracks: [JsonObject, string][],
  previous: Set<string>,
): void {
  for (const [track, path] of tracks) {
    if (typeof track.name !== 'string') continue
    const key = trackKey(namespaceOf(track, r.catalogNamespace), track.name)
    if (r.base === 1 && track.isLive === true && state.endedTracks.includes(key)) {
      warn(r, {
        id: 'catalog.track.isLive.revived',
        category: 'illegal_update',
        path: `${path}.isLive`,
        spec: ruleRef('isLiveAgain', r.draft),
        expected: 'isLive false, as declared before',
        actual: { kind: 'value', value: true },
        subject: subjectOf(r.root, path).subject,
      })
    }
    if (state.isComplete && !previous.has(key)) {
      warn(r, {
        id: 'catalog.track.added-after-complete',
        category: 'illegal_update',
        path,
        spec: ruleRef('isCompleteNoNewTracks', r.draft),
        field: null,
        expected: 'no new tracks once isComplete is set',
        actual: { kind: 'value', value: track.name },
        subject: subjectOf(r.root, path).subject,
      })
    }
  }
}

/** A problem's identity, to drop one already reported */
function problemKey(p: CatalogProblem): string {
  return [p.severity, p.category, p.path, p.section, p.message].join('\n')
}

/** The ended-track keys once `tracks` is the catalog's */
function endedAfter(
  state: CatalogState,
  tracks: JsonValue | undefined,
  catalogNamespace: string | null,
): string[] {
  const ended = new Set(state.endedTracks)
  for (const [track] of objectEntries(tracks ?? null, '')) {
    if (typeof track.name === 'string' && track.isLive === false) {
      ended.add(trackKey(namespaceOf(track, catalogNamespace), track.name))
    }
  }
  return [...ended]
}

/** "MSF-01", or "MSF-01 or CMSF-01" while the draft is open */
function draftsName(draft: CatalogDraft | null, candidates: readonly CatalogDraft[]): string {
  return draft !== null ? draftName(draft) : candidates.map(draftName).join(' or ')
}

/**
 * Apply one parsed catalog object to what the catalog track has said so far.
 *
 * - An independent catalog replaces it (msf-00 5, msf-01 5).
 * - A delta applies its operations in order, each to the document the one
 *   before produced (msf-00 5.2, msf-01 5.3): `add` declares tracks that are
 *   new, `remove` drops declared ones (named by name and, when not the
 *   catalog's, namespace), `clone` declares a new track holding its parent's
 *   fields with its own over them. A delta that breaks one of these rules, or
 *   names a track the catalog declares more than once, is refused whole: none
 *   of its operations apply. Its other root fields do not change the catalog.
 *
 * While the catalog in force is open between MSF and CMSF, a delta whose
 * shape is CMSF settles it.
 *
 * Group and Object IDs are the caller's. MSF-01 requires Object 0 of each
 * Group to be independent and later Objects in it to be deltas, and catalog
 * updates "that precede the first Object of the latest Group MUST be
 * ignored" (msf-01 5): apply objects in order, and start again from the
 * newest Group's first object.
 */
export function applyCatalogObject(state: CatalogState, parsed: ParsedCatalog): CatalogUpdate {
  const problems: CatalogProblem[] = []
  const refused: CatalogUpdate = { state, applied: false, problems }
  if (parsed.kind === 'invalid') return refused
  if (parsed.problems.some((p) => p.severity === 'error')) return refused
  const parsedDraft = parsed.draft ?? parsed.candidates[0]
  if (parsedDraft === undefined) return refused
  const ns = state.catalogNamespace

  if (parsed.kind === 'independent') {
    const root = parsed.document
    const r = rulesFor(
      parsedDraft,
      ns,
      problems,
      root,
      parsed.draft ? [parsed.draft] : parsed.candidates,
    )
    if (state.isComplete && root.isComplete !== true) {
      warn(r, {
        id: 'catalog.root.isComplete.removed',
        category: 'illegal_update',
        path: 'isComplete',
        spec: ruleRef('isCompleteRemoved', r.draft),
        expected: 'isComplete: true, as set before',
        actual:
          root.isComplete === undefined
            ? { kind: 'absent' }
            : { kind: 'value', value: root.isComplete },
      })
    }
    checkUpdateRules(
      r,
      state,
      objectEntries(root.tracks ?? null, 'tracks'),
      trackKeys(state.document?.tracks, ns),
    )
    return {
      state: {
        draft: parsed.draft,
        candidates: parsed.candidates,
        catalogNamespace: ns,
        document: root,
        isComplete: state.isComplete || root.isComplete === true,
        endedTracks: endedAfter(state, root.tracks, ns),
      },
      applied: true,
      problems,
    }
  }

  // A delta. The catalog in force decides the rules: a delta without a cmaf
  // track looks like plain MSF but applies to a CMSF catalog as CMSF.
  if (state.document === null) {
    const r = rulesFor(parsedDraft, ns, problems, parsed.document, parsed.candidates)
    error(r, {
      id: 'catalog.delta.base.missing',
      category: 'delta_without_base',
      path: '',
      spec: ruleRef('deltaBase', r.draft),
      field: null,
      expected: 'an independent catalog earlier in the track',
      actual: { kind: 'absent' },
    })
    return refused
  }
  let draft = state.draft
  let candidates = state.candidates
  if (draft === null && parsed.draft !== null && candidates.includes(parsed.draft)) {
    draft = parsed.draft
    candidates = [draft]
  }
  const r = rulesFor(draft ?? candidates[0]!, ns, problems, parsed.document, candidates)
  if (draftBase(parsedDraft) !== r.base) {
    error(r, {
      id: 'catalog.delta.draft.mismatch',
      category: 'invalid_value',
      path: 'deltaUpdate',
      spec: fieldRef('deltaUpdate', r.draft, 'TYPE')!,
      expected: `a delta of ${draftsName(draft, candidates)}`,
      actual: { kind: 'value', value: parsed.document.deltaUpdate ?? null },
      values: {
        delta: draftsName(parsed.draft, parsed.candidates),
        catalog: draftsName(draft, candidates),
      },
    })
    return refused
  }

  const tracks: JsonObject[] = objectEntries(state.document.tracks ?? null, '').map(([t]) => t)
  const matches = (key: string): number[] => {
    const at: number[] = []
    tracks.forEach((t, i) => {
      if (typeof t.name === 'string' && trackKey(namespaceOf(t, ns), t.name) === key) at.push(i)
    })
    return at
  }
  /** The one declared track `key` names, or -1 after reporting none or several */
  const declaredAt = (key: string, name: string, parent: boolean, path: string): number => {
    const at = matches(key)
    if (at.length === 1) return at[0]!
    const field = parent ? 'parentName' : 'name'
    if (at.length === 0) {
      error(r, {
        id: 'catalog.delta.track.unknown',
        category: 'unknown_track',
        path,
        spec: ruleRef('removeDeclared', r.draft),
        field,
        expected: 'a track the catalog declares',
        actual: { kind: 'value', value: name },
        values: parent ? { parent: name } : { name },
      })
    } else {
      error(r, {
        id: 'catalog.delta.track.ambiguous',
        category: 'duplicate_track',
        path,
        spec: ruleRef('uniqueNames', r.draft),
        field,
        expected: 'exactly one declared track',
        actual: { kind: 'value', value: name },
        values: { name, count: at.length },
      })
    }
    return -1
  }
  const exists = (path: string, name: JsonValue | undefined): void => {
    error(r, {
      id: 'catalog.delta.track.exists',
      category: 'duplicate_track',
      path,
      spec: ruleRef('fixedTrack', r.draft),
      field: 'name',
      expected: 'a track name not yet declared',
      actual: { kind: 'value', value: name ?? null },
      values: { name: name ?? null },
    })
  }
  const declared: [JsonObject, string][] = []
  // On a CMSF catalog, recheck added tracks under CMSF rules: parseCatalog
  // read a delta without a cmaf track by MSF rules.
  const addRules =
    r.cmsf && parsed.draft !== draft ? rulesFor(draft!, ns, [], parsed.document, candidates) : null

  for (const op of parsed.operations) {
    op.tracks.forEach((entry, i) => {
      const path = `${op.path}[${i}]`
      // parseCatalog refused entries without a string name (and a clone's
      // without a string parentName), so these casts hold.
      if (op.op === 'add') {
        if (matches(trackKey(namespaceOf(entry, ns), entry.name as string)).length > 0) {
          exists(path, entry.name)
          return
        }
        if (addRules !== null) checkTrack(addRules, entry, path)
        tracks.push(entry)
        declared.push([entry, path])
      } else if (op.op === 'remove') {
        const key = trackKey(namespaceOf(entry, ns), entry.name as string)
        const at = declaredAt(key, entry.name as string, false, path)
        if (at >= 0) tracks.splice(at, 1)
      } else {
        const parentNs = typeof entry.parentNamespace === 'string' ? entry.parentNamespace : ns
        const key = trackKey(parentNs, entry.parentName as string)
        const at = declaredAt(key, entry.parentName as string, true, path)
        if (at < 0) return
        // The parent's fields, the clone's own over them (msf-00 5.2, msf-01 5.1.6);
        // parentName and parentNamespace belong to the operation (msf-00 5.1.36, msf-01 5.2.33, 5.2.34).
        const { parentName: _name, parentNamespace: _ns, ...clone } = { ...tracks[at]!, ...entry }
        if (matches(trackKey(namespaceOf(clone, ns), clone.name as string)).length > 0) {
          exists(path, clone.name)
          return
        }
        checkTrack(r, clone, path, true)
        tracks.push(clone)
        declared.push([clone, path])
      }
    })
  }
  if (addRules !== null) {
    const known = new Set(parsed.problems.map(problemKey))
    for (const p of addRules.problems) if (!known.has(problemKey(p))) problems.push(p)
  }
  if (problems.some((p) => p.severity === 'error')) return refused

  const document: JsonObject = {}
  for (const [key, value] of Object.entries(state.document)) {
    document[key] = key === 'tracks' ? tracks : value
  }
  if (!('tracks' in document)) document.tracks = tracks

  checkReferences(r, document, declared)
  checkUpdateRules(r, state, declared, trackKeys(state.document.tracks, ns))
  return {
    state: {
      draft,
      candidates,
      catalogNamespace: ns,
      document,
      isComplete: state.isComplete,
      endedTracks: endedAfter(state, tracks, ns),
    },
    applied: true,
    problems,
  }
}

/** Where a catalog object was carried, and whether it is independent */
export interface CatalogObjectPlacement {
  groupId: number
  subgroupId: number
  objectId: number
  /** `parseCatalog` read it as an independent catalog; a delta otherwise */
  independent: boolean
}

/**
 * The Group rules for one catalog object (msf-00 5, msf-01 5): Object 0 of a
 * Group is independent; under MSF-01 every later Object is a delta, and every
 * catalog object is on Subgroup 0. `drafts` is the object's draft, or its
 * candidate drafts while it is open; when they disagree on these rules,
 * nothing is checked. The problems never refuse the object.
 */
export function checkCatalogObjectPlacement(
  o: CatalogObjectPlacement,
  drafts: CatalogDraft | readonly CatalogDraft[],
): CatalogProblem[] {
  const list: readonly CatalogDraft[] = typeof drafts === 'string' ? [drafts] : drafts
  const bases = new Set(list.map(draftBase))
  if (bases.size !== 1) return []
  const r = rulesFor(list[0]!, null, [], null, list)
  const subject: ProblemSubject = { kind: 'object' }
  const values = { group: o.groupId, subgroup: o.subgroupId, object: o.objectId }
  if (!o.independent && o.objectId === 0) {
    warn(r, {
      id: 'catalog.object.first-delta',
      category: 'object_order',
      path: '',
      spec: ruleRef('firstIndependent', r.draft),
      field: null,
      expected: 'Object 0 of a group holds an independent catalog',
      actual: { kind: 'value', value: 'delta' },
      values,
      subject,
    })
  }
  if (r.base === 1 && o.independent && o.objectId > 0) {
    warn(r, {
      id: 'catalog.object.later-independent',
      category: 'object_order',
      path: '',
      spec: ruleRef('laterDelta', r.draft),
      field: null,
      expected: 'Objects after the first in a group hold deltas',
      actual: { kind: 'value', value: 'independent' },
      values,
      subject,
    })
  }
  if (r.base === 1 && o.subgroupId !== 0) {
    warn(r, {
      id: 'catalog.object.subgroup',
      category: 'object_order',
      path: '',
      spec: ruleRef('subgroupZero', r.draft),
      field: 'subgroup',
      expected: 'Subgroup ID 0',
      actual: { kind: 'value', value: o.subgroupId },
      values,
      subject,
    })
  }
  return r.problems
}

// ─── Normalised view ─────────────────────────────────────────────────

/**
 * One track as consumers want it. A field is `null` when the catalog leaves
 * it out or gives it the wrong JSON type; `raw` holds the track object as
 * written, unknown fields included.
 */
export interface CatalogTrack {
  /** The track's namespace, else the catalog track's when given, else `null` */
  namespace: string | null
  name: string
  packaging: string | null
  role: string | null
  codec: string | null
  /** `mimeType`, else `mimetype` as the timeline examples write it (msf-00 5.3.8, msf-01 5.6.9) */
  mimeType: string | null
  label: string | null
  lang: string | null
  isLive: boolean | null
  eventType: string | null
  timescale: number | null
  framerate: number | null
  /** Maximum bitrate, bits per second (MSF-00 calls it just the bitrate) */
  bitrate: number | null
  avgBitrate: number | null
  width: number | null
  height: number | null
  displayWidth: number | null
  displayHeight: number | null
  samplerate: number | null
  channelConfig: string | null
  renderGroup: number | null
  altGroup: number | null
  temporalId: number | null
  spatialId: number | null
  targetLatency: number | null
  trackDuration: number | null
  /** Names of the tracks this one depends on, in its own namespace */
  depends: string[]
  /** MSF-01 / CMSF-01: the initDataList id the track names */
  initRef: string | null
  /**
   * The init data, decoded: the data of the inline initDataList entry `initRef`
   * names (msf-01 5.1.7, cmsf-01 3.1); for a track without `initRef`, its own
   * `initData` (msf-00 5.1.20, cmsf-00 3.1). An entry that is missing, given more
   * than once or not inline counts as none. `null` when there is no text, or it
   * is not Base64.
   */
  initData: Uint8Array | null
  /** CMSF-01: the root contentProtections entries the track's contentProtectionRefIDs name */
  contentProtections: JsonObject[]
  /** MSF-01 Secure Objects (5.2.38-5.2.40). trackBaseKey stays in `raw`. */
  encryptionScheme: string | null
  cipherSuite: string | null
  keyId: string | null
  /** CMSF 3.5.2 */
  maxGrpSapStartingType: number | null
  maxObjSapStartingType: number | null
  raw: JsonObject
}

function str(value: JsonValue | undefined): string | null {
  return typeof value === 'string' ? value : null
}

function num(value: JsonValue | undefined): number | null {
  return typeof value === 'number' ? value : null
}

export interface CatalogTracksOptions {
  /** The catalog track's namespace, for tracks without their own */
  catalogNamespace?: string | null
  /** Read `publishTracks` (msf-01 5.1.5) instead of `tracks` */
  publish?: boolean
}

/**
 * The tracks of a catalog document (a parsed independent catalog, or
 * `CatalogState.document`), normalised. Entries that are not objects or have
 * no string name are left out.
 */
export function catalogTracks(
  document: JsonObject | null,
  options: CatalogTracksOptions = {},
): CatalogTrack[] {
  if (document === null) return []
  const list = options.publish ? document.publishTracks : document.tracks
  if (!Array.isArray(list)) return []
  const catalogNamespace = options.catalogNamespace ?? null

  // An id given more than once names nothing.
  const inits = entriesById(document.initDataList, 'id')
  const protections = entriesById(document.contentProtections, 'refID')

  const out: CatalogTrack[] = []
  for (const t of list) {
    if (!isObject(t) || typeof t.name !== 'string') continue
    const initRef = str(t.initRef)
    const init = initRef === null ? undefined : inits.get(initRef)
    const encoded =
      initRef === null ? str(t.initData) : init?.type === 'inline' ? str(init.data) : null
    const contentProtections: JsonObject[] = []
    if (Array.isArray(t.contentProtectionRefIDs)) {
      for (const ref of t.contentProtectionRefIDs) {
        const entry = typeof ref === 'string' ? protections.get(ref) : undefined
        if (entry !== undefined && entry !== null) contentProtections.push(entry)
      }
    }
    out.push({
      namespace: namespaceOf(t, catalogNamespace),
      name: t.name,
      packaging: str(t.packaging),
      role: str(t.role),
      codec: str(t.codec),
      mimeType: str(t.mimeType) ?? str(t.mimetype),
      label: str(t.label),
      lang: str(t.lang),
      isLive: typeof t.isLive === 'boolean' ? t.isLive : null,
      eventType: str(t.eventType),
      timescale: num(t.timescale),
      framerate: num(t.framerate),
      bitrate: num(t.bitrate),
      avgBitrate: num(t.avgBitrate),
      width: num(t.width),
      height: num(t.height),
      displayWidth: num(t.displayWidth),
      displayHeight: num(t.displayHeight),
      samplerate: num(t.samplerate),
      channelConfig: str(t.channelConfig),
      renderGroup: num(t.renderGroup),
      altGroup: num(t.altGroup),
      temporalId: num(t.temporalId),
      spatialId: num(t.spatialId),
      targetLatency: num(t.targetLatency),
      trackDuration: num(t.trackDuration),
      depends: Array.isArray(t.depends)
        ? t.depends.filter((d): d is string => typeof d === 'string')
        : [],
      initRef,
      initData: encoded === null ? null : decodeBase64(encoded),
      contentProtections,
      encryptionScheme: str(t.encryptionScheme),
      cipherSuite: str(t.cipherSuite),
      keyId: str(t.keyId),
      maxGrpSapStartingType: num(t.maxGrpSapStartingType),
      maxObjSapStartingType: num(t.maxObjSapStartingType),
      raw: t,
    })
  }
  return out
}

// ─── Redaction ───────────────────────────────────────────────────────

export interface RedactCatalogOptions {
  /**
   * Replace credentials as well as content keys: every `token`, the value of
   * each `authInfo` scheme (the scheme names stay), and the userinfo, query
   * and fragment of `connectionUri` and of the `url` in a CMSF-01
   * `drmSystem`'s `laURL` and `certURL`. A `connectionUri`, `laURL`,
   * `certURL` or `url` of the wrong type is replaced whole. Default true.
   */
  credentials?: boolean
}

/**
 * A URL with its userinfo, query and fragment each replaced by the marker.
 *
 * Read as loosely as the WHATWG URL Standard: outer spaces and C0 controls
 * trimmed, tabs and newlines dropped, `\` as `/`, and the authority after any
 * run of slashes, so `https:u:pw@h` and `https:\\u:pw@h` lose their password.
 * A scheme without an authority (`mailto:u@h`) loses what precedes `@` too.
 */
function redactUrl(url: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: C0 controls are what the parser trims
  let rest = url.replace(/^[\u0000- ]+|[\u0000- ]+$/g, '').replace(/[\t\n\r]/g, '')
  let suffix = ''
  let changed = false
  const hash = rest.indexOf('#')
  if (hash >= 0) {
    suffix = `#${REDACTED}`
    rest = rest.slice(0, hash)
  }
  const query = rest.indexOf('?')
  if (query >= 0) {
    suffix = `?${REDACTED}${suffix}`
    rest = rest.slice(0, query)
  }
  const scheme = /^[a-z][a-z0-9+.-]*:[/\\]*/i.exec(rest)
  if (scheme !== null) {
    const afterScheme = rest.slice(scheme[0].length)
    const slash = afterScheme.search(/[/\\]/)
    const authority = slash >= 0 ? afterScheme.slice(0, slash) : afterScheme
    const at = authority.lastIndexOf('@')
    if (at >= 0) {
      const path = slash >= 0 ? afterScheme.slice(slash) : ''
      rest = `${scheme[0]}${REDACTED}@${authority.slice(at + 1)}${path}`
      changed = true
    }
  }
  // A URL with nothing to remove stays byte for byte, untrimmed.
  return changed || suffix !== '' ? rest + suffix : url
}

/**
 * Where an object sits: a CMSF-01 drmSystem (`drm`), or a laURL or certURL
 * directly in one (`drmUrl`).
 */
type DrmScope = 'drm' | 'drmUrl' | null

/**
 * What becomes of a member's value, by its name, the name of the object it
 * is in, and that object's DRM scope.
 */
function redactionRule(
  key: string,
  objectKey: string | null,
  scope: DrmScope,
  credentials: boolean,
): 'keep' | 'replace' | 'url' {
  // The live content key (msf-01 5.2.41): never shared.
  if (key === 'trackBaseKey') return 'replace'
  if (!credentials) return 'keep'
  if (scope === 'drmUrl' && key === 'url') return 'url' // cmsf-01 4.1.1.4.2, 4.1.1.4.3
  if (key === 'token') return 'replace' // msf-01 5.2.37
  // authInfo maps scheme names to scheme-specific configuration (5.2.42).
  // The names only say which schemes are in use.
  if (objectKey === 'authInfo') return 'replace'
  if (key === 'connectionUri') return 'url' // msf-01 5.2.36
  return 'keep'
}

/** The text and its parsed value, or `null` when it is not UTF-8 JSON */
function readJson(input: string | Uint8Array): { text: string; root: JsonValue } | null {
  const text = decodeText(input)
  if (text === null) return null
  try {
    return { text, root: JSON.parse(text) as JsonValue }
  } catch {
    return null
  }
}

/**
 * Redact already-parsed JSON text by replacing only the spans of redacted
 * values; every other byte stays. Iterative, since JSON.parse accepts nesting
 * deeper than the call stack.
 */
function spliceRedactions(text: string, credentials: boolean): string {
  const edits: [number, number, string][] = []
  let i = 0
  const ws = (): void => {
    while (i < text.length && ' \t\n\r'.includes(text[i]!)) i++
  }
  const skipString = (): void => {
    i++ // the opening quote
    while (text[i] !== '"') i += text[i] === '\\' ? 2 : 1
    i++
  }

  /** A member whose value is being walked, and what becomes of it once it is */
  interface Member {
    start: number
    rule: 'keep' | 'replace' | 'url'
    whole: boolean
  }
  /** An object or array being walked. `key` is the member name it is the value of. */
  interface Container {
    close: '}' | ']'
    key: string | null
    scope: DrmScope
    member: Member | null
  }
  const stack: Container[] = []

  /** Once a member's value has been walked, to `i`: its edit, if any */
  const finish = (m: Member | null): void => {
    if (m === null) return
    if (m.whole) {
      // Edits inside the value go with it.
      while (edits.length > 0 && edits[edits.length - 1]![0] >= m.start) edits.pop()
      edits.push([m.start, i, JSON.stringify(REDACTED)])
    } else if (m.rule === 'url' && text[m.start] === '"') {
      const url = JSON.parse(text.slice(m.start, i)) as string
      const redacted = redactUrl(url)
      if (redacted !== url) edits.push([m.start, i, JSON.stringify(redacted)])
    }
  }
  /** Start one value at `i`: a container opens, anything else is walked whole */
  const begin = (m: Member | null, key: string | null, scope: DrmScope): void => {
    const open = text[i]
    if (open === '{' || open === '[') {
      stack.push({ close: open === '{' ? '}' : ']', key, scope, member: m })
      i++
      return
    }
    if (open === '"') skipString()
    // A number, true, false or null
    else while (i < text.length && !' \t\n\r,]}'.includes(text[i]!)) i++
    finish(m)
  }

  ws()
  begin(null, null, null)
  while (stack.length > 0) {
    const top = stack[stack.length - 1]!
    ws()
    if (text[i] === ',') {
      i++
      ws()
    }
    if (text[i] === top.close) {
      i++
      stack.pop()
      finish(top.member)
      continue
    }
    if (top.close === ']') {
      begin(null, null, null)
      continue
    }
    const keyStart = i
    skipString()
    const key = JSON.parse(text.slice(keyStart, i)) as string
    ws()
    i++ // ':'
    ws()
    const rule = redactionRule(key, top.key, top.scope, credentials)
    const first = text[i]
    const drmUrl = top.scope === 'drm' && (key === 'laURL' || key === 'certURL')
    const whole =
      rule === 'replace' ||
      // A non-object authInfo has no scheme names to keep.
      (credentials && key === 'authInfo' && first !== '{') ||
      // laURL and certURL are Objects (cmsf-01 4.1.1.4.2, 4.1.1.4.3).
      (credentials && drmUrl && first !== '{') ||
      // A URL that is not a String (msf-01 5.2.36, cmsf-01 4.1.1.4.2)
      (rule === 'url' && first !== '"')
    const scope: DrmScope = drmUrl
      ? 'drmUrl'
      : key === 'drmSystem' && top.scope === null
        ? 'drm'
        : null
    begin({ start: i, rule, whole }, key, scope)
  }
  let out = text
  for (let k = edits.length - 1; k >= 0; k--) {
    const [start, end, replacement] = edits[k]!
    out = out.slice(0, start) + replacement + out.slice(end)
  }
  return out
}

/**
 * A catalog object's payload with credentials and content keys replaced by
 * "[redacted]". Every field stays in place, so the catalog still parses.
 *
 * Always replaced: `trackBaseKey` (msf-01 5.2.41), a live content key.
 * Replaced with `credentials` (the default): `token`, the values of
 * `authInfo`, and the userinfo, query and fragment of `connectionUri` and of
 * CMSF-01 DRM system URLs.
 * Kept: `keyId`, `pssh`, `defaultKID`,
 * `encryptionScheme`, `cipherSuite` and the init data (`initData`,
 * `initDataList`, `initRef`).
 *
 * Every occurrence is redacted, at any depth: tracks, publishTracks, delta
 * operations, and anywhere else a producer used the same names.
 *
 * Returns `null` when the payload cannot be read as a catalog: not UTF-8, not
 * JSON, or JSON without a catalog's shape.
 */
export function redactCatalogText(
  input: string | Uint8Array,
  options: RedactCatalogOptions = {},
): string | null {
  const json = readJson(input)
  if (json === null || !isObject(json.root)) return null
  const root = json.root
  const catalogShaped =
    Array.isArray(root.tracks) ||
    Array.isArray(root.publishTracks) ||
    root.deltaUpdate !== undefined ||
    Object.keys(root).some((field) => msf00Operation(field) !== null)
  if (!catalogShaped) return null
  return spliceRedactions(json.text, options.credentials ?? true)
}

/**
 * {@link redactCatalogText}'s rules applied to any JSON text, at any depth. A
 * field is matched by name alone, so a member that only shares a name with a
 * catalog field is redacted too.
 *
 * Returns `null` when the payload is not UTF-8 or not JSON.
 */
export function redactJsonText(
  input: string | Uint8Array,
  options: RedactCatalogOptions = {},
): string | null {
  const json = readJson(input)
  if (json === null) return null
  return spliceRedactions(json.text, options.credentials ?? true)
}
