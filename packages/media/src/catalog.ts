/**
 * MSF and CMSF catalogs: draft-ietf-moq-msf-00 and -01, draft-ietf-moq-cmsf-00
 * and -01 (msf-00 5, msf-01 5, cmsf 2). Deltas: msf-00 5.2, msf-01 5.3.
 * Unknown fields are kept (msf-00 5.1, msf-01 5). gzip (msf-01 12.1) is not decompressed.
 */

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

export interface CatalogProblem {
  /**
   * `error`: breaks a rule that binds whoever reads the catalog, or leaves
   * nothing to resolve; the object is not applied. `warning`: breaks a rule
   * the draft states for the catalog's producer, or (`ambiguous_draft`) says
   * which rules were left unchecked; the object still applies.
   */
  severity: 'error' | 'warning'
  category: CatalogProblemCategory
  /** Where, as a path into the object's JSON: `tracks[0].packaging`, `deltaUpdate[1].op` */
  path: string
  /** The draft and section that state the rule, e.g. `MSF-01 5.2.4` */
  section: string
  message: string
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
  /** gzip magic bytes (1f 8b): compressed per MSF_COMPRESSION, not read here */
  | { kind: 'compressed'; draft: null; problems: CatalogProblem[] }
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

/** "a String", "an Array": the drafts' JSON Type names, with an article */
function kindName(kind: JsonKind): string {
  const name = kind.charAt(0).toUpperCase() + kind.slice(1)
  return kind === 'array' || kind === 'object' ? `an ${name}` : `a ${name}`
}

/** The key two tracks share exactly when they are the same track */
function trackKey(namespace: string | null, name: string): string {
  return JSON.stringify([namespace, name])
}

function namespaceOf(track: JsonObject, catalogNamespace: string | null): string | null {
  return typeof track.namespace === 'string' ? track.namespace : catalogNamespace
}

function isGzip(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b
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
  catalogNamespace: string | null
  problems: CatalogProblem[]
}

function draftBase(draft: CatalogDraft): 0 | 1 {
  return draft === 'msf-00' || draft === 'cmsf-00' ? 0 : 1
}

function rulesFor(
  draft: CatalogDraft,
  catalogNamespace: string | null,
  problems: CatalogProblem[],
): Rules {
  return {
    base: draftBase(draft),
    cmsf: draft === 'cmsf-00' || draft === 'cmsf-01',
    catalogNamespace,
    problems,
  }
}

/** The MSF section a rule is stated in: MSF-00's number or MSF-01's */
function msf(r: Rules, s00: string, s01: string): string {
  return r.base === 0 ? `MSF-00 ${s00}` : `MSF-01 ${s01}`
}

function msfSection(draft: CatalogDraft, s00: string, s01: string): string {
  return draftBase(draft) === 0 ? `MSF-00 ${s00}` : `MSF-01 ${s01}`
}

/** "MSF-01", "CMSF-00" */
function draftName(draft: CatalogDraft): string {
  return draft.toUpperCase()
}

function cmsf(r: Rules, section: string): string {
  return `CMSF-0${r.base} ${section}`
}

function report(
  problems: CatalogProblem[],
  severity: CatalogProblem['severity'],
  category: CatalogProblemCategory,
  path: string,
  section: string,
  message: string,
): void {
  problems.push({ severity, category, path, section, message })
}

function error(
  r: Rules,
  category: CatalogProblemCategory,
  path: string,
  section: string,
  message: string,
): void {
  report(r.problems, 'error', category, path, section, message)
}

function warn(
  r: Rules,
  category: CatalogProblemCategory,
  path: string,
  section: string,
  message: string,
): void {
  report(r.problems, 'warning', category, path, section, message)
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

/** The section that defines a track field, for problem citations */
function trackFieldSection(r: Rules, field: string): string {
  if (field === 'maxGrpSapStartingType') return cmsf(r, '3.5.2.1')
  if (field === 'maxObjSapStartingType') return cmsf(r, '3.5.2.2')
  if (field === 'contentProtectionRefIDs') return cmsf(r, '4.1.2')
  return msf(r, '5.1', '5.2')
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

/**
 * Check one track object. `clone` marks the track a clone operation produced,
 * where the parent fields were allowed. Returns false when the track cannot
 * be keyed by namespace and name.
 */
function checkTrack(r: Rules, track: JsonValue, path: string, clone = false): boolean {
  if (!isObject(track)) {
    error(r, 'invalid_value', path, msf(r, '5.1.9', '5.2.1'), 'a track must be a JSON Object')
    return false
  }
  let keyed = true
  if (track.name === undefined) {
    error(r, 'missing_field', `${path}.name`, msf(r, '5.1.11', '5.2.3'), 'a track needs a name')
    keyed = false
  } else if (typeof track.name !== 'string') {
    error(r, 'invalid_value', `${path}.name`, msf(r, '5.1.11', '5.2.3'), 'name must be a String')
    keyed = false
  }
  if (track.namespace !== undefined && typeof track.namespace !== 'string') {
    error(
      r,
      'invalid_value',
      `${path}.namespace`,
      msf(r, '5.1.10', '5.2.2'),
      'namespace must be a String',
    )
    keyed = false
  }

  for (const [field, value] of Object.entries(track)) {
    const kind = trackFieldKind(r, field)
    if (kind !== undefined && kindOf(value) !== kind) {
      warn(
        r,
        'invalid_value',
        `${path}.${field}`,
        trackFieldSection(r, field),
        `${field} must be ${kindName(kind)}`,
      )
    }
  }

  const { packaging, isLive, eventType } = track
  if (packaging === undefined) {
    warn(
      r,
      'missing_field',
      `${path}.packaging`,
      msf(r, '5.1.12', '5.2.4'),
      'packaging is Required: Yes',
    )
  } else if (typeof packaging === 'string' && !packagingAllowed(r, packaging)) {
    warn(
      r,
      'invalid_value',
      `${path}.packaging`,
      r.cmsf ? cmsf(r, '3.5.1') : msf(r, '5.1.12', '5.2.4'),
      `packaging "${packaging}" is not a value the draft allows`,
    )
  }
  if (isLive === undefined) {
    warn(r, 'missing_field', `${path}.isLive`, msf(r, '5.1.15', '5.2.7'), 'isLive is Required: Yes')
  }

  // eventType: required with eventtimeline packaging, and only allowed there
  if (packaging === 'eventtimeline' && eventType === undefined) {
    warn(
      r,
      'missing_field',
      `${path}.eventType`,
      msf(r, '5.1.13', '5.2.5'),
      'an eventtimeline track needs an eventType',
    )
  } else if (
    typeof packaging === 'string' &&
    packaging !== 'eventtimeline' &&
    eventType !== undefined
  ) {
    warn(
      r,
      'forbidden_field',
      `${path}.eventType`,
      msf(r, '5.1.13', '5.2.5'),
      'eventType MUST NOT be used unless packaging is "eventtimeline"',
    )
  }

  if (r.base === 0 && track.targetLatency !== undefined && isLive === false) {
    warn(
      r,
      'forbidden_field',
      `${path}.targetLatency`,
      'MSF-00 5.1.16',
      'targetLatency MUST NOT be included if isLive is FALSE',
    )
  }
  // MSF-01 ignores targetLatency when not live (5.2.8), and makes
  // targetLatency and buffers exclusive (5.2.8, 5.2.9).
  if (r.base === 1 && track.targetLatency !== undefined && track.buffers !== undefined) {
    warn(
      r,
      'forbidden_field',
      `${path}.buffers`,
      'MSF-01 5.2.9',
      'buffers MUST NOT be present with targetLatency',
    )
  }
  if (track.trackDuration !== undefined && isLive === true) {
    warn(
      r,
      'forbidden_field',
      `${path}.trackDuration`,
      msf(r, '5.1.37', '5.2.35'),
      'trackDuration MUST NOT be included while isLive is true',
    )
  }
  if (!clone) {
    if (track.parentName !== undefined) {
      warn(
        r,
        'forbidden_field',
        `${path}.parentName`,
        msf(r, '5.1.36', '5.2.33'),
        'parentName belongs only inside a clone operation',
      )
    }
    if (r.base === 1 && track.parentNamespace !== undefined) {
      warn(
        r,
        'forbidden_field',
        `${path}.parentNamespace`,
        'MSF-01 5.2.34',
        'parentNamespace belongs only inside a clone operation',
      )
    }
  }

  if (r.base === 1) {
    // MSF-01's conditional fields for roles 'audio' and 'video' (Table 5,
    // 5.2.6): codec (5.2.18), bitrate (5.2.22), and for audio samplerate and
    // channelConfig (5.2.28, 5.2.29).
    const role = track.role
    const audio = role === 'audio'
    if (audio || role === 'video') {
      if (track.codec === undefined) {
        warn(
          r,
          'missing_field',
          `${path}.codec`,
          'MSF-01 5.2.18',
          `a ${role} track names its codec`,
        )
      }
      if (track.bitrate === undefined) {
        warn(
          r,
          'missing_field',
          `${path}.bitrate`,
          'MSF-01 5.2.22',
          `a ${role} track gives its bitrate`,
        )
      }
    }
    if (audio) {
      for (const field of ['samplerate', 'channelConfig'] as const) {
        if (track[field] === undefined) {
          warn(
            r,
            'missing_field',
            `${path}.${field}`,
            field === 'samplerate' ? 'MSF-01 5.2.28' : 'MSF-01 5.2.29',
            `an audio track carries ${field}`,
          )
        }
      }
    }
    if (track.encryptionScheme !== undefined && track.cipherSuite === undefined) {
      warn(
        r,
        'missing_field',
        `${path}.cipherSuite`,
        'MSF-01 5.2.39',
        'cipherSuite MUST be present when encryptionScheme is',
      )
    }
  }

  if (r.base === 0 && typeof track.initData === 'string' && decodeBase64(track.initData) === null) {
    warn(
      r,
      'invalid_value',
      `${path}.initData`,
      r.cmsf ? cmsf(r, '3.1') : 'MSF-00 5.1.20',
      'initData is not Base64',
    )
  }

  if (r.cmsf) {
    if (packaging === 'cmaf') {
      // CMSF-00 carries the CMAF header in the track's initData; CMSF-01 in
      // an initDataList entry the track names by initRef (3.1).
      const field = r.base === 0 ? 'initData' : 'initRef'
      if (track[field] === undefined) {
        warn(
          r,
          'missing_field',
          `${path}.${field}`,
          cmsf(r, '3.1'),
          `a cmaf track's header is given ${r.base === 0 ? 'in initData' : 'by initRef'}`,
        )
      }
    }
    // Each Group "MUST begin with an Object containing a stream access point
    // (SAP) type 1 or 2" (3.4), so the most a Group starts with is 1 or 2.
    const maxGrp = track.maxGrpSapStartingType
    if (typeof maxGrp === 'number' && maxGrp !== 1 && maxGrp !== 2) {
      warn(
        r,
        'invalid_value',
        `${path}.maxGrpSapStartingType`,
        cmsf(r, '3.4, 3.5.2.1'),
        'Groups start with SAP type 1 or 2',
      )
    }
    if (eventType === SAP_EVENT_TYPE && packaging !== 'eventtimeline') {
      warn(
        r,
        'invalid_value',
        `${path}.packaging`,
        cmsf(r, '3.6.1'),
        'the SAP Type timeline track MUST have packaging "eventtimeline"',
      )
    }
    if (r.base === 1 && track.contentProtections !== undefined) {
      warn(
        r,
        'forbidden_field',
        `${path}.contentProtections`,
        'CMSF-01 4.1.1',
        'content protection MUST NOT be duplicated at the track level',
      )
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
      warn(
        r,
        'duplicate_track',
        `${path}[${i}]`,
        msf(r, '5.1.11', '5.2.3'),
        `track names MUST be unique per namespace: "${track.name}" again`,
      )
    }
    seen.add(key)
  })
}

/** MSF-01's initDataList (5.1.7), as CMSF-01 uses it (3.1) */
function checkInitDataList(r: Rules, root: JsonObject): void {
  const list = root.initDataList
  if (list === undefined) return
  if (!Array.isArray(list)) {
    warn(r, 'invalid_value', 'initDataList', 'MSF-01 5.1.7', 'initDataList must be an Array')
    return
  }
  // Member order is the document's: JSON.parse keeps the order of string keys.
  const keys = Object.keys(root)
  const tracksAt = keys.indexOf('tracks')
  if (tracksAt >= 0 && keys.indexOf('initDataList') < tracksAt) {
    warn(
      r,
      'misplaced_field',
      'initDataList',
      'MSF-01 5.1.7',
      'initDataList MUST be located after the tracks array',
    )
  }
  const ids = new Set<string>()
  list.forEach((entry, i) => {
    const path = `initDataList[${i}]`
    if (!isObject(entry)) {
      warn(r, 'invalid_value', path, 'MSF-01 5.1.7', 'an initDataList entry must be an Object')
      return
    }
    for (const field of ['id', 'type', 'data'] as const) {
      const value = entry[field]
      if (value === undefined) {
        warn(r, 'missing_field', `${path}.${field}`, 'MSF-01 5.1.7', `an entry needs ${field}`)
      } else if (typeof value !== 'string') {
        warn(r, 'invalid_value', `${path}.${field}`, 'MSF-01 5.1.7', `${field} must be a String`)
      }
    }
    if (typeof entry.id === 'string') {
      if (ids.has(entry.id)) {
        warn(
          r,
          'duplicate_id',
          `${path}.id`,
          r.cmsf ? 'CMSF-01 3.1' : 'MSF-01 5.1.7',
          `initDataList id "${entry.id}" is not unique`,
        )
      }
      ids.add(entry.id)
    }
    if (typeof entry.type === 'string' && entry.type !== 'inline') {
      warn(
        r,
        'invalid_value',
        `${path}.type`,
        'MSF-01 5.1.7',
        `type "${entry.type}": the only type defined is "inline"`,
      )
    } else if (
      entry.type === 'inline' &&
      typeof entry.data === 'string' &&
      decodeBase64(entry.data) === null
    ) {
      warn(r, 'invalid_value', `${path}.data`, 'MSF-01 5.1.7', 'inline data is not Base64')
    }
  })
}

/** An object holding a url: laURL, certURL (cmsf-01 4.1.1.4.2, 4.1.1.4.3) */
function checkUrlObject(r: Rules, value: JsonValue, path: string, section: string): void {
  if (!isObject(value)) {
    warn(r, 'invalid_value', path, section, 'must be an Object')
  } else if (value.url === undefined) {
    warn(r, 'missing_field', `${path}.url`, section, 'url is Required')
  } else if (typeof value.url !== 'string') {
    warn(r, 'invalid_value', `${path}.url`, section, 'url must be a String')
  }
}

/** CMSF-01's root contentProtections (4.1.1) */
function checkContentProtections(r: Rules, root: JsonObject): void {
  const list = root.contentProtections
  if (list === undefined) return
  if (!Array.isArray(list)) {
    warn(r, 'invalid_value', 'contentProtections', 'CMSF-01 4.1.1', 'must be an Array')
    return
  }
  const refIds = new Set<string>()
  list.forEach((entry, i) => {
    const path = `contentProtections[${i}]`
    if (!isObject(entry)) {
      warn(r, 'invalid_value', path, 'CMSF-01 4.1.1', 'an entry must be an Object')
      return
    }
    const { refID, defaultKID, scheme, drmSystem } = entry
    if (refID === undefined) {
      warn(r, 'missing_field', `${path}.refID`, 'CMSF-01 4.1.1.1', 'refID is Required')
    } else if (typeof refID !== 'string') {
      warn(r, 'invalid_value', `${path}.refID`, 'CMSF-01 4.1.1.1', 'refID must be a String')
    } else {
      if (refIds.has(refID)) {
        warn(
          r,
          'duplicate_id',
          `${path}.refID`,
          'CMSF-01 4.1.1.1',
          `refID "${refID}" is not unique`,
        )
      }
      refIds.add(refID)
    }
    if (defaultKID === undefined) {
      warn(r, 'missing_field', `${path}.defaultKID`, 'CMSF-01 4.1.1.2', 'defaultKID is Required')
    } else if (!Array.isArray(defaultKID)) {
      warn(r, 'invalid_value', `${path}.defaultKID`, 'CMSF-01 4.1.1.2', 'must be an Array')
    } else {
      defaultKID.forEach((kid, k) => {
        if (typeof kid !== 'string' || !UUID.test(kid)) {
          warn(
            r,
            'invalid_value',
            `${path}.defaultKID[${k}]`,
            'CMSF-01 4.1.1.2',
            'a default KID is a UUID string, xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
          )
        }
      })
    }
    if (scheme === undefined) {
      warn(r, 'missing_field', `${path}.scheme`, 'CMSF-01 4.1.1.3', 'scheme is Required')
    } else if (scheme !== 'cenc' && scheme !== 'cbcs') {
      warn(r, 'invalid_value', `${path}.scheme`, 'CMSF-01 4.1.1.3', 'scheme is "cenc" or "cbcs"')
    }
    if (drmSystem === undefined) {
      warn(r, 'missing_field', `${path}.drmSystem`, 'CMSF-01 4.1.1.4', 'drmSystem is Required')
      return
    }
    if (!isObject(drmSystem)) {
      warn(r, 'invalid_value', `${path}.drmSystem`, 'CMSF-01 4.1.1.4', 'must be an Object')
      return
    }
    const drm = `${path}.drmSystem`
    const systemID = drmSystem.systemID
    if (systemID === undefined) {
      warn(r, 'missing_field', `${drm}.systemID`, 'CMSF-01 4.1.1.4.1', 'systemID is Required')
    } else if (typeof systemID !== 'string' || !UUID.test(systemID)) {
      warn(r, 'invalid_value', `${drm}.systemID`, 'CMSF-01 4.1.1.4.1', 'systemID is a UUID string')
    }
    if (drmSystem.laURL !== undefined) {
      checkUrlObject(r, drmSystem.laURL, `${drm}.laURL`, 'CMSF-01 4.1.1.4.2')
    }
    if (drmSystem.certURL !== undefined) {
      checkUrlObject(r, drmSystem.certURL, `${drm}.certURL`, 'CMSF-01 4.1.1.4.3')
    }
    const pssh = drmSystem.pssh
    if (pssh !== undefined && (typeof pssh !== 'string' || decodeBase64(pssh) === null)) {
      warn(r, 'invalid_value', `${drm}.pssh`, 'CMSF-01 4.1.1.4.5', 'pssh is a Base64 PSSH box')
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
      if (entry === undefined) {
        warn(
          r,
          'unknown_reference',
          `${path}.initRef`,
          'MSF-01 5.2.13',
          `initRef "${track.initRef}" names no initDataList entry`,
        )
      } else if (entry === null) {
        warn(
          r,
          'duplicate_id',
          `${path}.initRef`,
          'MSF-01 5.1.7',
          `initRef "${track.initRef}" names more than one initDataList entry`,
        )
      }
    }
    const refs = track.contentProtectionRefIDs
    if (!r.cmsf || !Array.isArray(refs)) continue
    refs.forEach((ref, k) => {
      const at = `${path}.contentProtectionRefIDs[${k}]`
      if (typeof ref !== 'string') {
        warn(r, 'invalid_value', at, 'CMSF-01 4.1.2', 'a reference ID is a String')
      } else if (protections.get(ref) === undefined) {
        warn(
          r,
          'unknown_reference',
          at,
          'CMSF-01 4.1.2',
          `"${ref}" names no contentProtections entry`,
        )
      } else if (protections.get(ref) === null) {
        warn(
          r,
          'duplicate_id',
          at,
          'CMSF-01 4.1.1.1',
          `"${ref}" names more than one contentProtections entry`,
        )
      }
    })
  }
}

/** Whether the version is one this module reads (msf 5.1.1); reports when not */
function checkVersion(r: Rules, root: JsonObject): boolean {
  const version = root.version
  if (version === undefined) {
    error(r, 'missing_field', 'version', msf(r, '5.1.1', '5.1.1'), 'version is Required: Yes')
    return false
  }
  if (r.base === 0) {
    if (typeof version !== 'number') {
      error(r, 'invalid_value', 'version', 'MSF-00 5.1.1', 'version must be a Number in MSF-00')
      return false
    }
    // MSF-00 describes version 1, and CMSF-00's example writes 1.
    if (version !== 1) {
      error(r, 'unsupported_version', 'version', 'MSF-00 5.1.1', `version ${version} is not 1`)
      return false
    }
    return true
  }
  if (typeof version !== 'string') {
    error(r, 'invalid_value', 'version', 'MSF-01 5.1.1', 'version must be a String in MSF-01')
    return false
  }
  // 5.1.1 asks for "draft-01", but every MSF-01 and CMSF-01 example writes "1".
  if (version !== 'draft-01' && version !== '1') {
    error(
      r,
      'unsupported_version',
      'version',
      'MSF-01 5.1.1',
      `version "${version}" is not "draft-01" (or "1", as MSF-01's examples write it)`,
    )
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
  const tracks = root.tracks
  if (tracks === undefined) {
    error(r, 'missing_field', 'tracks', msf(r, '5.1.8', '5.1.4'), 'tracks is Required: Yes')
  } else if (!Array.isArray(tracks)) {
    error(r, 'invalid_value', 'tracks', msf(r, '5.1.8', '5.1.4'), 'tracks must be an Array')
  } else {
    tracks.forEach((track, i) => {
      checkTrack(r, track, `tracks[${i}]`)
    })
    checkDuplicates(r, tracks, 'tracks')
  }

  if (root.generatedAt !== undefined && typeof root.generatedAt !== 'number') {
    warn(r, 'invalid_value', 'generatedAt', msf(r, '5.1.6', '5.1.2'), 'must be a Number')
  }
  if (root.isComplete !== undefined) {
    if (typeof root.isComplete !== 'boolean') {
      warn(r, 'invalid_value', 'isComplete', msf(r, '5.1.7', '5.1.3'), 'must be a Boolean')
    } else if (!root.isComplete) {
      warn(
        r,
        'forbidden_field',
        'isComplete',
        msf(r, '5.1.7', '5.1.3'),
        'isComplete MUST NOT be included if it is FALSE',
      )
    }
  }
  if (r.base === 1) {
    if (root.publishTracks !== undefined && !Array.isArray(root.publishTracks)) {
      warn(r, 'invalid_value', 'publishTracks', 'MSF-01 5.1.5', 'must be an Array')
    }
    checkInitDataList(r, root)
  }
  if (r.cmsf && r.base === 1) checkContentProtections(r, root)
  checkReferences(r, root, objectEntries(tracks ?? null, 'tracks'))
}

/** A remove entry: a name, perhaps a namespace, nothing else (msf-00 5.1.4, msf-01 5.1.6) */
function checkRemoveEntry(r: Rules, entry: JsonObject, path: string): void {
  const section = msf(r, '5.1.4', '5.1.6')
  if (entry.name === undefined) {
    error(r, 'missing_field', `${path}.name`, section, 'a removed track is named by name')
  } else if (typeof entry.name !== 'string') {
    error(r, 'invalid_value', `${path}.name`, section, 'name must be a String')
  }
  if (entry.namespace !== undefined && typeof entry.namespace !== 'string') {
    error(r, 'invalid_value', `${path}.namespace`, section, 'namespace must be a String')
  }
  for (const field of Object.keys(entry)) {
    if (field !== 'name' && field !== 'namespace') {
      warn(
        r,
        'forbidden_field',
        `${path}.${field}`,
        section,
        'a remove entry MUST NOT hold fields besides name and namespace',
      )
    }
  }
}

/** A clone entry, before it meets its parent (msf-00 5.1.5, msf-01 5.1.6) */
function checkCloneEntry(r: Rules, entry: JsonObject, path: string): void {
  const section = msf(r, '5.1.5', '5.1.6')
  if (entry.parentName === undefined) {
    error(r, 'missing_field', `${path}.parentName`, section, 'a clone names its parent')
  } else if (typeof entry.parentName !== 'string') {
    error(r, 'invalid_value', `${path}.parentName`, section, 'parentName must be a String')
  }
  if (
    r.base === 1 &&
    entry.parentNamespace !== undefined &&
    typeof entry.parentNamespace !== 'string'
  ) {
    error(
      r,
      'invalid_value',
      `${path}.parentNamespace`,
      section,
      'parentNamespace must be a String',
    )
  }
  // The clone's name "MUST be new" (msf-00 5.2, msf-01 5.1.6); without one it
  // would be its parent's.
  if (entry.name === undefined) {
    error(r, 'missing_field', `${path}.name`, section, 'a clone needs a name of its own')
  } else if (typeof entry.name !== 'string') {
    error(r, 'invalid_value', `${path}.name`, section, 'name must be a String')
  }
  if (entry.namespace !== undefined && typeof entry.namespace !== 'string') {
    error(r, 'invalid_value', `${path}.namespace`, section, 'namespace must be a String')
  }
}

/** One operation's track entries; any that is not an object is reported */
function operationTracks(r: Rules, list: JsonValue[], path: string): JsonObject[] {
  const tracks: JsonObject[] = []
  list.forEach((entry, i) => {
    if (isObject(entry)) tracks.push(entry)
    else error(r, 'invalid_value', `${path}[${i}]`, msf(r, '5.1.9', '5.2.1'), 'must be an Object')
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
  const section = msf(r, '5.2', '5.3')
  for (const field of ['tracks', 'version'] as const) {
    if (root[field] !== undefined) {
      error(
        r,
        'delta_not_allowed_field',
        field,
        section,
        `a delta update MUST NOT contain ${field}`,
      )
    }
  }
  const operations: DeltaOperation[] = []
  const deltaUpdate = root.deltaUpdate as JsonValue

  if (r.base === 0) {
    if (deltaUpdate !== true) {
      error(
        r,
        'invalid_value',
        'deltaUpdate',
        'MSF-00 5.1.2',
        Array.isArray(deltaUpdate)
          ? 'deltaUpdate must be a Boolean in MSF-00'
          : 'a delta update sets deltaUpdate to true',
      )
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
        error(r, 'invalid_value', field, 'MSF-00 5.1.3-5.1.5', `${field} must be an Array`)
      }
    }
    if (!Object.keys(root).some((field) => msf00Operation(field) !== null)) {
      error(
        r,
        'missing_field',
        'addTracks',
        'MSF-00 5.2',
        'a delta update MUST contain at least one of addTracks, removeTracks or cloneTracks',
      )
    }
  } else if (!Array.isArray(deltaUpdate)) {
    error(
      r,
      'invalid_value',
      'deltaUpdate',
      'MSF-01 5.1.6',
      'deltaUpdate must be an Array in MSF-01',
    )
  } else if (deltaUpdate.length === 0) {
    error(r, 'invalid_value', 'deltaUpdate', 'MSF-01 5.3', 'a delta update needs an operation')
  } else {
    deltaUpdate.forEach((entry, i) => {
      const path = `deltaUpdate[${i}]`
      if (!isObject(entry)) {
        error(r, 'invalid_value', path, 'MSF-01 5.1.6', 'an operation must be an Object')
        return
      }
      const { op, tracks } = entry
      let ok = true
      if (op === undefined) {
        error(r, 'missing_field', `${path}.op`, 'MSF-01 5.1.6', 'an operation needs op')
        ok = false
      } else if (op !== 'add' && op !== 'remove' && op !== 'clone') {
        error(
          r,
          'invalid_value',
          `${path}.op`,
          'MSF-01 5.1.6',
          `op ${JSON.stringify(op)} is not add, remove or clone`,
        )
        ok = false
      }
      if (tracks === undefined) {
        error(r, 'missing_field', `${path}.tracks`, 'MSF-01 5.1.6', 'an operation needs tracks')
        ok = false
      } else if (!Array.isArray(tracks)) {
        error(r, 'invalid_value', `${path}.tracks`, 'MSF-01 5.1.6', 'tracks must be an Array')
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
    warn(r, 'invalid_value', 'generatedAt', msf(r, '5.1.6', '5.1.2'), 'must be a Number')
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
 * object, `invalid` before that, `compressed` for a gzip payload. An `error`
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
  if (typeof input !== 'string' && isGzip(input)) {
    return { kind: 'compressed', draft: null, problems }
  }
  const hint = options.draft ?? null
  const text = decodeText(input)
  if (text === null) {
    report(problems, 'error', 'invalid_json', '', 'RFC 8259 8.1', 'the payload is not UTF-8')
    return { kind: 'invalid', draft: hint, problems }
  }
  let root: JsonValue
  try {
    root = JSON.parse(text) as JsonValue
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e)
    report(problems, 'error', 'invalid_json', '', 'RFC 8259', `not JSON: ${detail}`)
    return { kind: 'invalid', draft: hint, problems }
  }
  if (!isObject(root)) {
    const section = hint === null ? 'MSF-00 5.1, MSF-01 5' : msfSection(hint, '5.1', '5')
    report(problems, 'error', 'invalid_value', '', section, 'a catalog is a JSON Object')
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
    report(
      problems,
      'error',
      'missing_field',
      'version',
      'MSF-00 5.1.1, MSF-01 5.1.1',
      'version is Required: Yes',
    )
    return { kind: 'independent', draft, candidates, document: root, problems }
  }
  if (draft === null) {
    report(
      problems,
      'warning',
      'ambiguous_draft',
      '',
      `CMSF-0${draftBase(rulesDraft)} 2`,
      `the catalog may be ${candidates.map(draftName).join(' or ')}; only the rules both share are checked`,
    )
  }

  const r = rulesFor(rulesDraft, options.catalogNamespace ?? null, problems)
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
      warn(
        r,
        'illegal_update',
        `${path}.isLive`,
        'MSF-01 5.2.7',
        `"${track.name}" was declared with isLive false, and true MUST never follow false`,
      )
    }
    if (state.isComplete && !previous.has(key)) {
      warn(
        r,
        'illegal_update',
        path,
        msf(r, '5.1.7', '5.1.3'),
        `"${track.name}" is new after isComplete, which commits that no tracks will be added`,
      )
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
  if (parsed.kind === 'compressed' || parsed.kind === 'invalid') return refused
  if (parsed.problems.some((p) => p.severity === 'error')) return refused
  const parsedDraft = parsed.draft ?? parsed.candidates[0]
  if (parsedDraft === undefined) return refused
  const ns = state.catalogNamespace

  if (parsed.kind === 'independent') {
    const r = rulesFor(parsedDraft, ns, problems)
    const root = parsed.document
    if (state.isComplete && root.isComplete !== true) {
      warn(
        r,
        'illegal_update',
        'isComplete',
        msf(r, '5.1.7', '5.1.3'),
        'isComplete MUST NOT be removed from a catalog once it has been added',
      )
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
    const r = rulesFor(parsedDraft, ns, problems)
    error(r, 'delta_without_base', '', msf(r, '5', '5'), 'a delta needs a catalog to apply to')
    return refused
  }
  let draft = state.draft
  let candidates = state.candidates
  if (draft === null && parsed.draft !== null && candidates.includes(parsed.draft)) {
    draft = parsed.draft
    candidates = [draft]
  }
  const r = rulesFor(draft ?? candidates[0]!, ns, problems)
  const section = msf(r, '5.2', '5.3')
  if (draftBase(parsedDraft) !== r.base) {
    error(
      r,
      'invalid_value',
      'deltaUpdate',
      msf(r, '5.1.2', '5.1.6'),
      `a ${draftsName(parsed.draft, parsed.candidates)} delta cannot apply to a ${draftsName(draft, candidates)} catalog`,
    )
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
  const declaredAt = (key: string, label: string, path: string): number => {
    const at = matches(key)
    if (at.length === 1) return at[0]!
    if (at.length === 0) error(r, 'unknown_track', path, section, `${label} is not declared`)
    else {
      error(
        r,
        'duplicate_track',
        path,
        msf(r, '5.1.11', '5.2.3'),
        `${label} names ${at.length} declared tracks`,
      )
    }
    return -1
  }
  const declared: [JsonObject, string][] = []
  // On a CMSF catalog, recheck added tracks under CMSF rules: parseCatalog
  // read a delta without a cmaf track by MSF rules.
  const addRules = r.cmsf && parsed.draft !== draft ? rulesFor(draft!, ns, []) : null

  for (const op of parsed.operations) {
    op.tracks.forEach((entry, i) => {
      const path = `${op.path}[${i}]`
      // parseCatalog refused entries without a string name (and a clone's
      // without a string parentName), so these casts hold.
      if (op.op === 'add') {
        if (matches(trackKey(namespaceOf(entry, ns), entry.name as string)).length > 0) {
          error(r, 'duplicate_track', path, section, `"${entry.name}" is already declared`)
          return
        }
        if (addRules !== null) checkTrack(addRules, entry, path)
        tracks.push(entry)
        declared.push([entry, path])
      } else if (op.op === 'remove') {
        const key = trackKey(namespaceOf(entry, ns), entry.name as string)
        const at = declaredAt(key, `"${entry.name}"`, path)
        if (at >= 0) tracks.splice(at, 1)
      } else {
        const parentNs = typeof entry.parentNamespace === 'string' ? entry.parentNamespace : ns
        const key = trackKey(parentNs, entry.parentName as string)
        const at = declaredAt(key, `parent "${entry.parentName}"`, path)
        if (at < 0) return
        // The parent's fields, the clone's own over them (msf-00 5.2, msf-01 5.1.6);
        // parentName and parentNamespace belong to the operation (msf-00 5.1.36, msf-01 5.2.33, 5.2.34).
        const { parentName: _name, parentNamespace: _ns, ...clone } = { ...tracks[at]!, ...entry }
        if (matches(trackKey(namespaceOf(clone, ns), clone.name as string)).length > 0) {
          error(r, 'duplicate_track', path, section, `"${clone.name}" is already declared`)
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
 * Returns `null` when the payload cannot be read as a catalog: compressed, not
 * UTF-8, not JSON, or JSON without a catalog's shape.
 */
export function redactCatalogText(
  input: string | Uint8Array,
  options: RedactCatalogOptions = {},
): string | null {
  if (typeof input !== 'string' && isGzip(input)) return null
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
