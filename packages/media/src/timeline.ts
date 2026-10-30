/**
 * MSF media timeline payloads and template (draft-ietf-moq-msf-00 and -01, 7),
 * MSF event timeline payloads (8.1), and the CMSF SAP type timeline read from
 * them (draft-ietf-moq-cmsf-00 and -01, 3.6.1).
 */

import type { JsonValue } from './catalog'

// ─── Types ───────────────────────────────────────────────────────────

export type TimelineDraft = 'msf-00' | 'msf-01'

/** The eventType of a CMSF SAP type timeline track (cmsf 3.6.1) */
export const SAP_TIMELINE_EVENT_TYPE = 'org.ietf.moq.cmsf.sap'

/**
 * One event record, by its index reference: `t` wallclock time in milliseconds
 * since 1970-01-01T00:00:00Z, `m` media PTS in milliseconds, `l` a Location
 * (msf 8.1, by reference to 7.1). `at` is the record's position in the document.
 */
export type EventRecord =
  | { index: 't'; time: number; data: JsonValue; at: number }
  | { index: 'm'; mediaTime: number; data: JsonValue; at: number }
  | { index: 'l'; group: number; object: number; data: JsonValue; at: number }

/**
 * - `invalid_json`: not JSON text (RFC 8259), including bytes that are not UTF-8
 * - `missing_field`: an event record without `data`, a media timeline record
 *   with fewer than three items, or a template with fewer than six values
 * - `invalid_index`: a record without exactly one index reference, or one the
 *   timeline does not allow
 * - `invalid_value`: a value of the wrong JSON type, or outside what the draft allows
 * - `mixed_index`: records use more than one index reference type
 * - `conflicting_records`: two SAP timeline records for one Location disagree
 */
export type TimelineProblemCategory =
  | 'invalid_json'
  | 'missing_field'
  | 'invalid_index'
  | 'invalid_value'
  | 'mixed_index'
  | 'conflicting_records'

export interface TimelineProblem {
  /**
   * `error`: the record (or document) cannot be read, or breaks a rule the
   * draft states for its values, and is left out.
   * `warning`: breaks a rule the draft states for the publisher; the record is kept.
   */
  severity: 'error' | 'warning'
  category: TimelineProblemCategory
  /** Where, as a path into the document: `[3]`, `[3].l`, `[3].data` */
  path: string
  /** The draft and section that state the rule, e.g. `MSF-01 8.1` */
  section: string
  /** What is wrong, as a sentence to show: capitalised, no closing period */
  message: string
}

export type ParsedEventTimeline =
  | { kind: 'records'; records: EventRecord[]; problems: TimelineProblem[] }
  | { kind: 'invalid'; problems: TimelineProblem[] }

export interface ParseTimelineOptions {
  /** Cite this draft only; without it, both MSF drafts */
  draft?: TimelineDraft
}

/**
 * One media timeline entry (msf-00 7.1, msf-01 7.1.1): media presentation time
 * in milliseconds, Location, and wallclock time in milliseconds since
 * 1970-01-01T00:00:00Z.
 */
export interface MediaTimelineEntry {
  mediaTime: number
  group: number
  object: number
  wallclock: number
}

/** A record of an explicit media timeline; `at` is its position in the document */
export interface MediaTimelineRecord extends MediaTimelineEntry {
  at: number
}

/** `unread`: under MSF-01, a document that is not an array of records */
export type ParsedMediaTimeline =
  | { kind: 'records'; records: MediaTimelineRecord[]; problems: TimelineProblem[] }
  | { kind: 'invalid'; problems: TimelineProblem[] }
  | { kind: 'unread'; problems: TimelineProblem[] }

/** The six values of a media timeline template, in milliseconds and Location IDs (msf-01 7.4.1) */
export interface MediaTimelineTemplate {
  startMediaTime: number
  deltaMediaTime: number
  startGroup: number
  startObject: number
  deltaGroup: number
  deltaObject: number
  startWallclock: number
  deltaWallclock: number
}

export interface ParsedMediaTimelineTemplate {
  /** `null` when the value is not a template */
  template: MediaTimelineTemplate | null
  problems: TimelineProblem[]
}

/** One SAP type timeline record (cmsf 3.6.1) */
export interface SapTimelineEntry {
  group: number
  object: number
  /** 0: the Object does not start with a SAP; 1 to 3: it begins with a SAP of that type */
  sapType: 0 | 1 | 2 | 3
  /** Earliest presentation time of the Object's samples, in milliseconds */
  ept: number
  /** The record's position in the document */
  at: number
}

export interface SapTimeline {
  entries: SapTimelineEntry[]
  problems: TimelineProblem[]
}

export interface ReadSapTimelineOptions {
  /** Cite this draft only; without it, both CMSF drafts */
  draft?: 'cmsf-00' | 'cmsf-01'
}

/** Where Object 0 is the first Object of its Group: cmsf-00 cites draft-ietf-moq-transport-10 as [MoQTransport] */
const FIRST_OBJECT_SECTION = {
  'cmsf-00': 'CMSF-00 3.6.1, draft-ietf-moq-transport-10 9.1.1',
  'cmsf-01': 'CMSF-01 3.6.1, MSF-01 6.2',
}

// ─── Helpers ─────────────────────────────────────────────────────────

function decodeText(input: string | Uint8Array): string | null {
  if (typeof input === 'string') return input
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(input)
  } catch {
    return null
  }
}

function isObject(v: JsonValue | undefined): v is { [key: string]: JsonValue } {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isId(v: JsonValue | undefined): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
}

/** A Location: an Array of a Group ID and an Object ID */
function isLocation(v: JsonValue | undefined): v is [number, number] {
  return Array.isArray(v) && v.length === 2 && isId(v[0]) && isId(v[1])
}

/** Where a media time is defined: a whole number of milliseconds, rounded (msf-00) or floored (msf-01) */
const MEDIA_TIME_SECTION = { 'msf-00': '7.1', 'msf-01': '7.1.1' }

function citeDrafts(draft: TimelineDraft | undefined, cite: (d: TimelineDraft) => string): string {
  return draft ? cite(draft) : `${cite('msf-00')}; ${cite('msf-01')}`
}

/** The JSON document of a timeline payload, or `null` with the problem that stops it */
function readDocument(input: string | Uint8Array, problems: TimelineProblem[]): JsonValue | null {
  const text = decodeText(input)
  if (text === null) {
    problems.push({
      severity: 'error',
      category: 'invalid_json',
      path: '',
      section: 'RFC 8259 8.1',
      message: 'The payload is not UTF-8',
    })
    return null
  }
  try {
    return JSON.parse(text) as JsonValue
  } catch (e) {
    problems.push({
      severity: 'error',
      category: 'invalid_json',
      path: '',
      section: 'RFC 8259',
      message: `The payload is not JSON: ${e instanceof Error ? e.message : String(e)}`,
    })
    return null
  }
}

// ─── Media timelines ─────────────────────────────────────────────────

/**
 * Read one media timeline object's payload in the explicit format, as text or
 * bytes. Never throws. Each record is `[mediaTime, [group, object], wallclock]`;
 * a record that cannot be read is left out of `records`, with an `error`
 * problem.
 */
export function parseMediaTimeline(
  input: string | Uint8Array,
  options: ParseTimelineOptions = {},
): ParsedMediaTimeline {
  const problems: TimelineProblem[] = []
  const doc = readDocument(input, problems)
  if (doc === null) return { kind: 'invalid', problems }
  const section = citeDrafts(options.draft, (d) => `${d.toUpperCase()} ${MEDIA_TIME_SECTION[d]}`)
  const report = (
    path: string,
    message: string,
    category: TimelineProblemCategory = 'invalid_value',
  ) => problems.push({ severity: 'error', category, path, section, message })

  if (!Array.isArray(doc)) {
    // MSF-00 7.1 states the array; MSF-01 7.1 also names a template format
    // for the document, which 7.4.1 defines only as a catalog field.
    if (options.draft !== 'msf-00') return { kind: 'unread', problems }
    problems.push({
      severity: 'error',
      category: 'invalid_value',
      path: '',
      section: 'MSF-00 7.1',
      message: 'A media timeline is an array of records',
    })
    return { kind: 'invalid', problems }
  }

  const records: MediaTimelineRecord[] = []
  doc.forEach((record, at) => {
    const path = `[${at}]`
    if (!Array.isArray(record)) {
      report(path, 'A record is an Array of three items')
      return
    }
    if (record.length > 3) {
      // MSF-01 7.1 lets a document combine the explicit and template formats
      // without giving the combined form.
      if (options.draft === 'msf-00') report(path, 'A record is an Array of three items')
      return
    }
    if (record.length < 3) {
      report(`${path}[${record.length}]`, 'A record has three required items', 'missing_field')
      return
    }
    const [mediaTime, location, wallclock] = record
    let ok = true
    if (typeof mediaTime !== 'number') {
      report(`${path}[0]`, 'The media presentation time is a JSON Number')
      ok = false
    } else if (!Number.isInteger(mediaTime)) {
      report(
        `${path}[0]`,
        `The media presentation time ${mediaTime} is not a whole number of milliseconds`,
      )
      ok = false
    }
    if (!isLocation(location)) {
      report(`${path}[1]`, 'A Location is an Array of a Group ID and an Object ID')
      ok = false
    }
    if (typeof wallclock !== 'number') {
      report(`${path}[2]`, 'The wallclock time is a JSON Number')
      ok = false
    }
    if (!ok) return
    records.push({
      mediaTime: mediaTime as number,
      group: (location as [number, number])[0],
      object: (location as [number, number])[1],
      wallclock: wallclock as number,
      at,
    })
  })
  return { kind: 'records', records, problems }
}

/**
 * Read a track's `template` catalog field (msf-01 5.2.15, 7.4.1): six values,
 * `[startMediaTime, deltaMediaTime, [startGroup, startObject], [deltaGroup,
 * deltaObject], startWallclock, deltaWallclock]`. Never throws.
 */
export function parseMediaTimelineTemplate(value: JsonValue): ParsedMediaTimelineTemplate {
  const problems: TimelineProblem[] = []
  const report = (
    path: string,
    message: string,
    category: TimelineProblemCategory = 'invalid_value',
  ) => problems.push({ severity: 'error', category, path, section: 'MSF-01 7.4.1', message })

  if (!Array.isArray(value) || value.length > 6) {
    report('', 'A media timeline template is an Array of six values')
    return { template: null, problems }
  }
  if (value.length < 6) {
    report(
      `[${value.length}]`,
      'A media timeline template has six mandatory values',
      'missing_field',
    )
    return { template: null, problems }
  }
  const [
    startMediaTime,
    deltaMediaTime,
    startLocation,
    deltaLocation,
    startWallclock,
    deltaWallclock,
  ] = value
  const checks: [boolean, string][] = [
    [
      typeof startMediaTime === 'number' && Number.isInteger(startMediaTime),
      'The startMediaTime value is a whole number of milliseconds',
    ],
    [typeof deltaMediaTime === 'number', 'The deltaMediaTime value is a JSON Number'],
    [
      isLocation(startLocation),
      'The startLocation value is an Array of a Group ID and an Object ID',
    ],
    [
      Array.isArray(deltaLocation) &&
        deltaLocation.length === 2 &&
        typeof deltaLocation[0] === 'number' &&
        typeof deltaLocation[1] === 'number',
      'The deltaLocation value is an Array of two Numbers',
    ],
    [typeof startWallclock === 'number', 'The startWallclock value is a JSON Number'],
    [typeof deltaWallclock === 'number', 'The deltaWallclock value is a JSON Number'],
  ]
  checks.forEach(([ok, message], i) => {
    if (!ok) report(`[${i}]`, message)
  })
  if (problems.length > 0) return { template: null, problems }
  const start = startLocation as [number, number]
  const delta = deltaLocation as [number, number]
  const template: MediaTimelineTemplate = {
    startMediaTime: startMediaTime as number,
    deltaMediaTime: deltaMediaTime as number,
    startGroup: start[0],
    startObject: start[1],
    deltaGroup: delta[0],
    deltaObject: delta[1],
    startWallclock: startWallclock as number,
    deltaWallclock: deltaWallclock as number,
  }
  return { template, problems }
}

/**
 * Entry `n` (zero-based) of a media timeline template, by the msf-01 7.4.1
 * formulas. `null` when `n` is not a non-negative integer, or the Location it
 * gives is not one.
 */
export function mediaTimelineTemplateEntry(
  template: MediaTimelineTemplate,
  n: number,
): MediaTimelineEntry | null {
  if (!Number.isSafeInteger(n) || n < 0) return null
  const group = template.startGroup + n * template.deltaGroup
  const object = template.startObject + n * template.deltaObject
  if (!isId(group) || !isId(object)) return null
  return {
    mediaTime: template.startMediaTime + n * template.deltaMediaTime,
    group,
    object,
    wallclock: template.startWallclock + n * template.deltaWallclock,
  }
}

// ─── Event timelines ─────────────────────────────────────────────────

const INDEX_KEYS = ['t', 'l', 'm'] as const

/**
 * Read one event timeline object's payload, as text or bytes. Never throws.
 * A record that cannot be read is left out of `records`, with an `error`
 * problem. `data` is kept as any JSON value: msf 8.1 calls it an Object, while
 * its own examples and the CMSF SAP timeline use an Array.
 */
export function parseEventTimeline(
  input: string | Uint8Array,
  options: ParseTimelineOptions = {},
): ParsedEventTimeline {
  const problems: TimelineProblem[] = []
  const doc = readDocument(input, problems)
  if (doc === null) return { kind: 'invalid', problems }
  const section = options.draft ? `${options.draft.toUpperCase()} 8.1` : 'MSF-00 8.1, MSF-01 8.1'
  const report = (
    severity: TimelineProblem['severity'],
    category: TimelineProblemCategory,
    path: string,
    message: string,
  ) => problems.push({ severity, category, path, section, message })

  if (!Array.isArray(doc)) {
    report('error', 'invalid_value', '', 'An event timeline is an array of records')
    return { kind: 'invalid', problems }
  }

  const records: EventRecord[] = []
  doc.forEach((record, at) => {
    const path = `[${at}]`
    if (!isObject(record)) {
      report('error', 'invalid_value', path, 'A record is a JSON Object')
      return
    }
    const keys = INDEX_KEYS.filter((k) => record[k] !== undefined)
    let ok = true
    if (keys.length === 0) {
      report('error', 'invalid_index', path, "A record needs an index reference: 't', 'l' or 'm'")
      ok = false
    } else if (keys.length > 1) {
      report(
        'error',
        'invalid_index',
        path,
        `Only one index reference per record, not ${keys.join(', ')}`,
      )
      ok = false
    }
    if (record.data === undefined) {
      report('error', 'missing_field', `${path}.data`, "A record needs 'data'")
      ok = false
    }
    if (!ok) return
    const key = keys[0]!
    const value = record[key]
    const data = record.data!
    if (key === 'l') {
      if (!isLocation(value)) {
        report(
          'error',
          'invalid_value',
          `${path}.l`,
          'A Location is an Array of a Group ID and an Object ID',
        )
        return
      }
      records.push({ index: 'l', group: value[0], object: value[1], data, at })
      return
    }
    if (typeof value !== 'number') {
      report(
        'error',
        'invalid_value',
        `${path}.${key}`,
        `The index reference '${key}' is a JSON Number`,
      )
      return
    }
    if (key === 'm' && !Number.isInteger(value)) {
      problems.push({
        severity: 'error',
        category: 'invalid_value',
        path: `${path}.m`,
        section: citeDrafts(
          options.draft,
          (d) => `${d.toUpperCase()} 8.1, ${MEDIA_TIME_SECTION[d]}`,
        ),
        message: `The media PTS ${value} is not a whole number of milliseconds`,
      })
      return
    }
    records.push(
      key === 't'
        ? { index: 't', time: value, data, at }
        : { index: 'm', mediaTime: value, data, at },
    )
  })

  const used = [...new Set(records.map((r) => r.index))]
  if (used.length > 1) {
    report(
      'warning',
      'mixed_index',
      '',
      `Records SHOULD use one index reference type; these use ${used.join(', ')}`,
    )
  }
  return { kind: 'records', records, problems }
}

// ─── CMSF SAP type timeline ──────────────────────────────────────────

/**
 * Read event records as a SAP type timeline: each an `l` record whose `data`
 * is `[sapType, ept]`, two integers, sapType 0 to 3, and 1 or 2 for Object 0,
 * the first Object of its Group (cmsf 3.6.1). A record that breaks this is
 * left out, with an `error` problem. Two records for one Location that
 * disagree are both kept, with a `conflicting_records` warning.
 */
export function readSapTimeline(
  records: readonly EventRecord[],
  options: ReadSapTimelineOptions = {},
): SapTimeline {
  const problems: TimelineProblem[] = []
  const section = options.draft
    ? `${options.draft.toUpperCase()} 3.6.1`
    : 'CMSF-00 3.6.1, CMSF-01 3.6.1'
  const report = (
    severity: TimelineProblem['severity'],
    category: TimelineProblemCategory,
    path: string,
    message: string,
    s = section,
  ) => problems.push({ severity, category, path, section: s, message })

  const entries: SapTimelineEntry[] = []
  const byLocation = new Map<string, SapTimelineEntry>()
  for (const record of records) {
    const path = `[${record.at}]`
    if (record.index !== 'l') {
      report('error', 'invalid_index', path, "A SAP timeline record's index reference is 'l'")
      continue
    }
    const d = record.data
    if (!Array.isArray(d) || d.length !== 2 || !Number.isInteger(d[0]) || !Number.isInteger(d[1])) {
      report(
        'error',
        'invalid_value',
        `${path}.data`,
        "The record's data is an Array of two integers",
      )
      continue
    }
    const sapType = d[0] as number
    if (sapType < 0 || sapType > 3) {
      report('error', 'invalid_value', `${path}.data[0]`, `SAP type ${sapType} is not 0, 1, 2 or 3`)
      continue
    }
    const entry: SapTimelineEntry = {
      group: record.group,
      object: record.object,
      sapType: sapType as SapTimelineEntry['sapType'],
      ept: d[1] as number,
      at: record.at,
    }
    if (entry.object === 0 && sapType !== 1 && sapType !== 2) {
      report(
        'error',
        'invalid_value',
        `${path}.data[0]`,
        `The first Object of Group ${entry.group} has SAP type ${sapType}; it MUST be 1 or 2`,
        options.draft
          ? FIRST_OBJECT_SECTION[options.draft]
          : `${FIRST_OBJECT_SECTION['cmsf-00']}; ${FIRST_OBJECT_SECTION['cmsf-01']}`,
      )
      continue
    }
    const key = `${entry.group}/${entry.object}`
    const earlier = byLocation.get(key)
    if (earlier === undefined) {
      byLocation.set(key, entry)
    } else if (earlier.sapType !== entry.sapType || earlier.ept !== entry.ept) {
      report(
        'warning',
        'conflicting_records',
        path,
        `Location [${entry.group},${entry.object}] is also given as [${earlier.sapType},${earlier.ept}] at [${earlier.at}]`,
      )
    }
    entries.push(entry)
  }
  return { entries, problems }
}
