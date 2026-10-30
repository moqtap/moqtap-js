/**
 * MSF media timeline payloads and template (draft-ietf-moq-msf-00 and -01, 7),
 * MSF event timeline payloads (8.1), and the CMSF SAP type timeline read from
 * them (draft-ietf-moq-cmsf-00 and -01, 3.6.1).
 */

import type { JsonValue } from './catalog'
import {
  type CheckId,
  type MediaProblem,
  type ProblemActual,
  type ProblemSubject,
  problemTitle,
  type SpecRef,
  type TimelineRuleName,
  timelineRuleRef,
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
  problemExpected as timelineProblemExpected,
  problemFound as timelineProblemFound,
  problemRemedy as timelineProblemRemedy,
  problemTitle as timelineProblemTitle,
  severityOf,
  specLabel,
  specUrl,
} from './problems'

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

/**
 * One problem with a timeline payload. How much it matters comes from its
 * rule's keyword: `severityOf`. Its words come from {@link timelineProblemTitle}
 * and the functions beside it. Without a draft, `spec` cites the latest
 * draft and `also` the earlier one.
 */
export interface TimelineProblem extends MediaProblem {
  /**
   * Whether the record is kept: `error` when the record (or document) cannot
   * be read, or breaks a rule the draft states for its values, and is left
   * out; `warning` when it is kept. `effect` says the same as `refused` or
   * `applied`.
   */
  severity: 'error' | 'warning'
  category: TimelineProblemCategory
  /** Where, as a path into the document: `[3]`, `[3].l`, `[3].data` */
  path: string
  /** The draft and section that state the rule, e.g. `MSF-01 8.1` */
  section: string
  /** {@link timelineProblemTitle} of this problem alone: capitalised, no closing period */
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

type RuleDraft = 'msf-00' | 'msf-01' | 'cmsf-00' | 'cmsf-01'

/** The rule as `draft` states it; without one, the latest draft's, and the earlier one's in `also` */
function specFor(
  rule: TimelineRuleName,
  draft: RuleDraft | undefined,
  family: 'msf' | 'cmsf',
): { spec: SpecRef; also: SpecRef[] } {
  if (draft !== undefined) return { spec: timelineRuleRef(rule, draft), also: [] }
  const spec = timelineRuleRef(rule, `${family}-01`)
  const older = timelineRuleRef(rule, `${family}-00`)
  return { spec, also: older.revision === '00' ? [older] : [] }
}

interface TimelineReport {
  id: CheckId
  category: TimelineProblemCategory
  path: string
  section: string
  rule: TimelineRuleName
  field?: string | null
  expected: string
  actual?: ProblemActual
  values?: Record<string, JsonValue>
  subject?: ProblemSubject
}

function timelineProblem(
  severity: TimelineProblem['severity'],
  rep: TimelineReport,
  draft: RuleDraft | undefined,
  family: 'msf' | 'cmsf',
): TimelineProblem {
  const at = /^\[(\d+)\]/.exec(rep.path)
  const subject: ProblemSubject =
    at === null ? { kind: 'root' } : { kind: 'record', index: Number(at[1]) }
  const p: TimelineProblem = {
    severity,
    category: rep.category,
    path: rep.path,
    section: rep.section,
    message: '',
    id: rep.id,
    family: rep.id,
    ...specFor(rep.rule, draft, family),
    effect: severity === 'error' ? 'refused' : 'applied',
    subject: rep.subject ?? subject,
    field: rep.field ?? null,
    expected: rep.expected,
    actual: rep.actual ?? { kind: 'absent' },
    values: rep.values ?? {},
  }
  p.message = problemTitle([p])
  return p
}

function actualOf(value: JsonValue | undefined): ProblemActual {
  return value === undefined ? { kind: 'absent' } : { kind: 'value', value }
}

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
function readDocument(
  input: string | Uint8Array,
  problems: TimelineProblem[],
  rule: 'mediaJson' | 'eventJson',
  draft: TimelineDraft | undefined,
): JsonValue | null {
  const text = decodeText(input)
  if (text === null) {
    problems.push(
      timelineProblem(
        'error',
        {
          id: 'timeline.json.utf8',
          category: 'invalid_json',
          path: '',
          section: 'RFC 8259 8.1',
          rule,
          expected: 'UTF-8 JSON text (RFC 8259 8.1)',
          actual: { kind: 'value', value: 'bytes that are not UTF-8' },
        },
        draft,
        'msf',
      ),
    )
    return null
  }
  try {
    return JSON.parse(text) as JsonValue
  } catch (e) {
    problems.push(
      timelineProblem(
        'error',
        {
          id: 'timeline.json.syntax',
          category: 'invalid_json',
          path: '',
          section: 'RFC 8259',
          rule,
          expected: 'JSON text (RFC 8259)',
          actual: { kind: 'value', value: e instanceof Error ? e.message : String(e) },
        },
        draft,
        'msf',
      ),
    )
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
  const draft = options.draft
  const doc = readDocument(input, problems, 'mediaJson', draft)
  if (doc === null) return { kind: 'invalid', problems }
  const section = citeDrafts(draft, (d) => `${d.toUpperCase()} ${MEDIA_TIME_SECTION[d]}`)
  const report = (rep: Partial<TimelineReport> & Omit<TimelineReport, 'section' | 'category'>) =>
    problems.push(
      timelineProblem('error', { category: 'invalid_value', section, ...rep }, draft, 'msf'),
    )

  if (!Array.isArray(doc)) {
    // MSF-00 7.1 states the array; MSF-01 7.1 also names a template format
    // for the document, which 7.4.1 defines only as a catalog field.
    if (draft !== 'msf-00') return { kind: 'unread', problems }
    report({
      id: 'timeline.media.array',
      path: '',
      section: 'MSF-00 7.1',
      rule: 'mediaArray',
      expected: 'a JSON Array of records',
      actual: { kind: 'value', value: doc },
    })
    return { kind: 'invalid', problems }
  }

  const records: MediaTimelineRecord[] = []
  doc.forEach((record, at) => {
    const path = `[${at}]`
    const notRecord = () =>
      report({
        id: 'timeline.media.record.type',
        path,
        rule: 'mediaRecord',
        expected: '[mediaTime, [group, object], wallclock]',
        actual: { kind: 'value', value: record },
      })
    if (!Array.isArray(record)) {
      notRecord()
      return
    }
    if (record.length > 3) {
      // MSF-01 7.1 lets a document combine the explicit and template formats
      // without giving the combined form.
      if (draft === 'msf-00') notRecord()
      return
    }
    if (record.length < 3) {
      report({
        id: 'timeline.media.record.missing',
        category: 'missing_field',
        path: `${path}[${record.length}]`,
        rule: 'mediaRecordItems',
        expected: 'three items',
        actual: { kind: 'value', value: record },
      })
      return
    }
    const [mediaTime, location, wallclock] = record
    let ok = true
    if (typeof mediaTime !== 'number') {
      report({
        id: 'timeline.media.mediaTime.type',
        path: `${path}[0]`,
        rule: 'mediaTimeType',
        field: 'mediaTime',
        expected: 'JSON Number',
        actual: actualOf(mediaTime),
      })
      ok = false
    } else if (!Number.isInteger(mediaTime)) {
      report({
        id: 'timeline.media.mediaTime.integer',
        path: `${path}[0]`,
        rule: 'mediaTimeValue',
        field: 'mediaTime',
        expected: 'whole milliseconds',
        actual: actualOf(mediaTime),
        values: { value: mediaTime },
      })
      ok = false
    }
    if (!isLocation(location)) {
      report({
        id: 'timeline.media.location.type',
        path: `${path}[1]`,
        rule: 'location',
        field: 'location',
        expected: '[Group ID, Object ID]',
        actual: actualOf(location),
      })
      ok = false
    }
    if (typeof wallclock !== 'number') {
      report({
        id: 'timeline.media.wallclock.type',
        path: `${path}[2]`,
        rule: 'wallclock',
        field: 'wallclock',
        expected: 'JSON Number',
        actual: actualOf(wallclock),
      })
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
  const report = (rep: Partial<TimelineReport> & Omit<TimelineReport, 'section' | 'category'>) =>
    problems.push(
      timelineProblem(
        'error',
        { category: 'invalid_value', section: 'MSF-01 7.4.1', ...rep },
        'msf-01',
        'msf',
      ),
    )

  if (!Array.isArray(value) || value.length > 6) {
    report({
      id: 'timeline.template.type',
      path: '',
      rule: 'template',
      expected: 'a JSON Array of six values',
      actual: { kind: 'value', value },
    })
    return { template: null, problems }
  }
  if (value.length < 6) {
    report({
      id: 'timeline.template.missing',
      subject: { kind: 'root' },
      category: 'missing_field',
      path: `[${value.length}]`,
      rule: 'templateValues',
      expected: 'six values',
      actual: { kind: 'value', value },
    })
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
  const checks: [boolean, string, string][] = [
    [
      typeof startMediaTime === 'number' && Number.isInteger(startMediaTime),
      'startMediaTime',
      'whole milliseconds',
    ],
    [typeof deltaMediaTime === 'number', 'deltaMediaTime', 'a JSON Number'],
    [isLocation(startLocation), 'startLocation', '[Group ID, Object ID]'],
    [
      Array.isArray(deltaLocation) &&
        deltaLocation.length === 2 &&
        typeof deltaLocation[0] === 'number' &&
        typeof deltaLocation[1] === 'number',
      'deltaLocation',
      'an Array of two Numbers',
    ],
    [typeof startWallclock === 'number', 'startWallclock', 'a JSON Number'],
    [typeof deltaWallclock === 'number', 'deltaWallclock', 'a JSON Number'],
  ]
  checks.forEach(([ok, name, expected], i) => {
    if (!ok) {
      report({
        id: 'timeline.template.value.type',
        path: `[${i}]`,
        rule: 'template',
        field: name,
        expected: `${name}: ${expected}`,
        actual: actualOf(value[i]),
        values: { what: expected },
        subject: { kind: 'root' },
      })
    }
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
  const draft = options.draft
  const doc = readDocument(input, problems, 'eventJson', draft)
  if (doc === null) return { kind: 'invalid', problems }
  const section = draft ? `${draft.toUpperCase()} 8.1` : 'MSF-00 8.1, MSF-01 8.1'
  const report = (
    severity: TimelineProblem['severity'],
    rep: Partial<TimelineReport> & Omit<TimelineReport, 'section' | 'category'>,
  ) =>
    problems.push(
      timelineProblem(severity, { category: 'invalid_value', section, ...rep }, draft, 'msf'),
    )

  if (!Array.isArray(doc)) {
    report('error', {
      id: 'timeline.event.array',
      path: '',
      rule: 'eventArray',
      expected: 'a JSON Array of records',
      actual: { kind: 'value', value: doc },
    })
    return { kind: 'invalid', problems }
  }

  const records: EventRecord[] = []
  doc.forEach((record, at) => {
    const path = `[${at}]`
    if (!isObject(record)) {
      report('error', {
        id: 'timeline.event.record.object',
        path,
        rule: 'eventRecord',
        expected: 'JSON Object',
        actual: { kind: 'value', value: record },
      })
      return
    }
    const keys = INDEX_KEYS.filter((k) => record[k] !== undefined)
    let ok = true
    if (keys.length === 0) {
      report('error', {
        id: 'timeline.event.index.missing',
        category: 'invalid_index',
        path,
        rule: 'eventIndex',
        expected: "one index reference: 't', 'l' or 'm'",
        actual: { kind: 'absent' },
      })
      ok = false
    } else if (keys.length > 1) {
      report('error', {
        id: 'timeline.event.index.multiple',
        category: 'invalid_index',
        path,
        rule: 'eventOneIndex',
        expected: 'one index reference',
        actual: { kind: 'value', value: keys.join(', ') },
        values: { indexes: keys.join(', ') },
      })
      ok = false
    }
    if (record.data === undefined) {
      report('error', {
        id: 'timeline.event.data.missing',
        category: 'missing_field',
        path: `${path}.data`,
        rule: 'eventData',
        field: 'data',
        expected: 'data present',
      })
      ok = false
    }
    if (!ok) return
    const key = keys[0]!
    const value = record[key]
    const data = record.data!
    if (key === 'l') {
      if (!isLocation(value)) {
        report('error', {
          id: 'timeline.event.location.type',
          path: `${path}.l`,
          rule: 'eventValues',
          field: 'l',
          expected: '[Group ID, Object ID]',
          actual: actualOf(value),
        })
        return
      }
      records.push({ index: 'l', group: value[0], object: value[1], data, at })
      return
    }
    if (typeof value !== 'number') {
      report('error', {
        id: 'timeline.event.time.type',
        path: `${path}.${key}`,
        rule: 'eventValues',
        field: key,
        expected: 'JSON Number',
        actual: actualOf(value),
        values: { index: key },
      })
      return
    }
    if (key === 'm' && !Number.isInteger(value)) {
      report('error', {
        id: 'timeline.event.mediaTime.integer',
        path: `${path}.m`,
        section: citeDrafts(draft, (d) => `${d.toUpperCase()} 8.1, ${MEDIA_TIME_SECTION[d]}`),
        rule: 'mediaTimeValue',
        field: 'm',
        expected: 'whole milliseconds',
        actual: actualOf(value),
        values: { value },
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
    report('warning', {
      id: 'timeline.event.index.mixed',
      category: 'mixed_index',
      path: '',
      rule: 'eventSameIndex',
      expected: 'one index reference type for every record',
      actual: { kind: 'value', value: used.join(', ') },
      values: { indexes: used.join(', ') },
    })
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
  const draft = options.draft
  const section = draft ? `${draft.toUpperCase()} 3.6.1` : 'CMSF-00 3.6.1, CMSF-01 3.6.1'
  const report = (
    severity: TimelineProblem['severity'],
    rep: Partial<TimelineReport> & Omit<TimelineReport, 'section' | 'category'>,
  ) =>
    problems.push(
      timelineProblem(severity, { category: 'invalid_value', section, ...rep }, draft, 'cmsf'),
    )

  const entries: SapTimelineEntry[] = []
  const byLocation = new Map<string, SapTimelineEntry>()
  for (const record of records) {
    const path = `[${record.at}]`
    if (record.index !== 'l') {
      report('error', {
        id: 'timeline.sap.index',
        category: 'invalid_index',
        path,
        rule: 'sapIndex',
        expected: "index reference 'l'",
        actual: { kind: 'value', value: record.index },
      })
      continue
    }
    const d = record.data
    if (!Array.isArray(d) || d.length !== 2 || !Number.isInteger(d[0]) || !Number.isInteger(d[1])) {
      report('error', {
        id: 'timeline.sap.data.type',
        path: `${path}.data`,
        rule: 'sapData',
        field: 'data',
        expected: '[SAP type, EPT], two integers',
        actual: { kind: 'value', value: d },
      })
      continue
    }
    const sapType = d[0] as number
    if (sapType < 0 || sapType > 3) {
      report('error', {
        id: 'timeline.sap.type.value',
        path: `${path}.data[0]`,
        rule: 'sapType',
        field: 'data[0]',
        expected: 'SAP type 0, 1, 2 or 3',
        actual: { kind: 'value', value: sapType },
        values: { sapType },
      })
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
      report('error', {
        id: 'timeline.sap.first-object',
        path: `${path}.data[0]`,
        section: draft
          ? FIRST_OBJECT_SECTION[draft]
          : `${FIRST_OBJECT_SECTION['cmsf-00']}; ${FIRST_OBJECT_SECTION['cmsf-01']}`,
        rule: 'sapFirst',
        field: 'data[0]',
        expected: 'SAP type 1 or 2 for the first Object of a Group',
        actual: { kind: 'value', value: sapType },
        values: { group: entry.group, sapType },
      })
      continue
    }
    const key = `${entry.group}/${entry.object}`
    const earlier = byLocation.get(key)
    if (earlier === undefined) {
      byLocation.set(key, entry)
    } else if (earlier.sapType !== entry.sapType || earlier.ept !== entry.ept) {
      report('warning', {
        id: 'timeline.sap.conflict',
        category: 'conflicting_records',
        path,
        rule: 'sapConflict',
        field: 'data',
        expected: `[${earlier.sapType},${earlier.ept}], as record ${earlier.at} gives it`,
        actual: { kind: 'value', value: [entry.sapType, entry.ept] },
        values: { location: `[${entry.group},${entry.object}]`, earlier: earlier.at },
      })
    }
    entries.push(entry)
  }
  return { entries, problems }
}
