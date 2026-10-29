/**
 * The CMSF object vectors and the MSF and CMSF timeline vectors of
 * @moqtap/test-vectors: every file in the `objects` and `timeline`
 * directories of each msf and cmsf version.
 * A category that no runner of this package reads fails the run.
 *
 * Vectors come from MOQTAP_TEST_VECTORS, else the installed
 * @moqtap/test-vectors when it has object vectors, else a `test-vectors`
 * checkout beside this repository.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { type InitSegment, parseInitSegment } from '../bmff'
import type { JsonValue } from '../catalog'
import {
  type CmafFindingCode,
  type CmafObject,
  type CmsfDraft,
  checkCmafObject,
  parseCmafObject,
  type SampleFlagsSource,
} from '../cmaf'
import {
  type EventRecord,
  type MediaTimelineEntry,
  mediaTimelineTemplateEntry,
  parseEventTimeline,
  parseMediaTimeline,
  parseMediaTimelineTemplate,
  readSapTimeline,
  SAP_TIMELINE_EVENT_TYPE,
  type TimelineDraft,
  type TimelineProblem,
} from '../timeline'

// ─── Locating the vectors ────────────────────────────────────────────

interface Manifest {
  specs: Record<string, { versions: { id: string; path: string }[] }>
}

function hasObjectVectors(root: string): boolean {
  const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf-8')) as Manifest
  return (manifest.specs.cmsf?.versions ?? []).some((v) => {
    const meta = join(root, v.path, 'meta.json')
    return (
      existsSync(meta) && JSON.parse(readFileSync(meta, 'utf-8')).categories.includes('objects')
    )
  })
}

function installedVectors(): string | null {
  try {
    const root = dirname(createRequire(import.meta.url).resolve('@moqtap/test-vectors/manifest'))
    return hasObjectVectors(root) ? root : null
  } catch {
    return null
  }
}

function vectorsRoot(): string {
  const fromEnv = process.env.MOQTAP_TEST_VECTORS
  if (fromEnv) return resolve(fromEnv)
  const installed = installedVectors()
  if (installed !== null) return installed
  // packages/media/src/__tests__ -> the directory holding this repository
  return resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../test-vectors')
}

/** Categories other runners of this package read */
const ELSEWHERE = new Set(['catalog'])

const NS = 'not_signalled'
const AMBIGUOUS = 'ambiguous'

interface ObjectVector {
  id: string
  header?: { hex: string }
  object: { hex: string }
  first_in_group?: true
  decoded?: Record<string, unknown>
  error?: string
}

interface TimelineVector {
  id: string
  input: { text: string }
  entries?: string
  decoded?: { template?: Record<string, string>; records: Record<string, unknown>[] }
  error?: string
}

type TimelineFormat = 'mediatimeline' | 'eventtimeline' | 'template'

interface VectorFile<V> {
  name: string
  draft: string
  format?: TimelineFormat
  eventType?: string
  vectors: V[]
}

function loadVectors() {
  const root = vectorsRoot()
  if (!existsSync(join(root, 'manifest.json'))) {
    throw new Error(
      `No test vectors at ${root}. Clone moqtap/test-vectors beside this repository or set MOQTAP_TEST_VECTORS.`,
    )
  }
  const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf-8')) as Manifest
  const objects: VectorFile<ObjectVector>[] = []
  const timelines: VectorFile<TimelineVector>[] = []
  const notRun: string[] = []
  for (const spec of ['msf', 'cmsf']) {
    for (const version of manifest.specs[spec]?.versions ?? []) {
      const draft = `${spec}-${version.id.slice(-2)}`
      const meta = JSON.parse(readFileSync(join(root, version.path, 'meta.json'), 'utf-8')) as {
        categories: string[]
      }
      for (const category of meta.categories) {
        if (ELSEWHERE.has(category)) continue
        const dir = join(root, version.path, category)
        if ((category !== 'objects' && category !== 'timeline') || !existsSync(dir)) {
          notRun.push(`${version.path}${category}`)
          continue
        }
        for (const file of readdirSync(dir).sort()) {
          if (!file.endsWith('.json')) continue
          const data = JSON.parse(readFileSync(join(dir, file), 'utf-8'))
          const name = `${version.path}${category}/${file}`
          if (category === 'objects') objects.push({ name, draft, vectors: data.vectors })
          else
            timelines.push({
              name,
              draft,
              format: data.format,
              eventType: data.event_type,
              vectors: data.vectors,
            })
        }
      }
    }
  }
  return { objects, timelines, notRun }
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return bytes
}

// ─── Objects ─────────────────────────────────────────────────────────

const ERROR_CODES: Record<string, CmafFindingCode[]> = {
  malformed_box: ['malformed-box'],
  missing_chunk: ['no-moof-mdat'],
  missing_box: ['no-mfhd', 'no-traf', 'no-tfhd'],
  unknown_track_id: ['track-id-not-in-init'],
  multiple_tracks: ['multiple-tracks'],
  invalid_group_start: ['group-start-sap-type'],
}

const FLAGS_FROM: Record<SampleFlagsSource, string> = {
  'trun-sample-flags': 'trun_sample_flags',
  'trun-first-sample-flags': 'trun_first_sample_flags',
  'tfhd-default': 'tfhd_default_sample_flags',
  'trex-default': 'trex_default_sample_flags',
}

/** The object in the vectors' terms */
function asDecoded(object: CmafObject, init: InitSegment | null): Record<string, unknown> {
  const track = init?.tracks.find((t) => t.trackId === object.trackIds[0])
  const { firstSample, sap, timing } = object
  const conflicting = firstSample.unknown === 'conflicting'
  const first: Record<string, unknown> = {
    flags_from: conflicting
      ? AMBIGUOUS
      : firstSample.source === null
        ? NS
        : FLAGS_FROM[firstSample.source],
  }
  if (firstSample.flags) {
    first.is_leading = String(firstSample.flags.isLeading)
    first.depends_on = String(firstSample.flags.dependsOn)
  }
  first.sync = conflicting ? AMBIGUOUS : (firstSample.sync ?? NS)
  first.sap_type =
    sap.sapType !== null
      ? [String(sap.sapType)]
      : sap.candidates.length > 0
        ? sap.candidates.map(String)
        : sap.reason === 'sample-flags-conflicting'
          ? AMBIGUOUS
          : NS
  return {
    boxes: object.boxes,
    chunks: object.movieFragments
      .filter((m) => m.mdatFollows)
      .map((m) => ({
        sequence_number: String(m.sequenceNumber),
        trafs: m.trackFragments.map((t) => ({
          track_id: String(t.header?.trackId),
          base_media_decode_time:
            t.baseMediaDecodeTime === null ? NS : String(t.baseMediaDecodeTime),
          sample_count: String(t.sampleCount),
        })),
      })),
    track_id_in_header: init ? object.trackIds.every((id) => track?.trackId === id) : NS,
    timescale: track?.timescale != null ? String(track.timescale) : NS,
    first_sample: first,
    earliest_presentation_time:
      timing.earliestPresentationTime === null ? NS : String(timing.earliestPresentationTime),
    ept_ms: timing.eptMs === null ? NS : timing.eptMs.map(String),
  }
}

// ─── Timelines ───────────────────────────────────────────────────────

function mediaEntry(e: MediaTimelineEntry): Record<string, string> {
  return {
    media_time_ms: String(e.mediaTime),
    group_id: String(e.group),
    object_id: String(e.object),
    wallclock_ms: String(e.wallclock),
  }
}

function eventRecord(r: EventRecord): Record<string, unknown> {
  if (r.index === 't') return { index: 't', wallclock_ms: String(r.time), data: r.data }
  if (r.index === 'm') return { index: 'm', media_time_ms: String(r.mediaTime), data: r.data }
  return { index: 'l', group_id: String(r.group), object_id: String(r.object), data: r.data }
}

interface TimelineOutcome {
  problems: Pick<TimelineProblem, 'severity' | 'category'>[]
  decoded: TimelineVector['decoded'] | null
}

/** Read a vector's input as its file's format says, in the vectors' terms */
function readTimeline(file: VectorFile<TimelineVector>, vector: TimelineVector): TimelineOutcome {
  const text = vector.input.text
  if (file.format === 'mediatimeline') {
    const parsed = parseMediaTimeline(text, { draft: file.draft as TimelineDraft })
    return {
      problems: parsed.problems,
      decoded: parsed.kind === 'records' ? { records: parsed.records.map(mediaEntry) } : null,
    }
  }
  if (file.format === 'template') {
    let value: JsonValue
    try {
      value = JSON.parse(text) as JsonValue
    } catch {
      return { problems: [{ severity: 'error', category: 'invalid_json' }], decoded: null }
    }
    const { template, problems } = parseMediaTimelineTemplate(value)
    if (template === null) return { problems, decoded: null }
    const records: Record<string, string>[] = []
    for (let n = 0; n < Number(vector.entries); n++) {
      const entry = mediaTimelineTemplateEntry(template, n)
      expect(entry).not.toBeNull()
      records.push(mediaEntry(entry!))
    }
    return {
      problems,
      decoded: {
        template: {
          start_media_time_ms: String(template.startMediaTime),
          delta_media_time_ms: String(template.deltaMediaTime),
          start_group_id: String(template.startGroup),
          start_object_id: String(template.startObject),
          delta_group_id: String(template.deltaGroup),
          delta_object_id: String(template.deltaObject),
          start_wallclock_ms: String(template.startWallclock),
          delta_wallclock_ms: String(template.deltaWallclock),
        },
        records,
      },
    }
  }
  if (file.eventType === undefined) {
    const parsed = parseEventTimeline(text, { draft: file.draft as TimelineDraft })
    return {
      problems: parsed.problems,
      decoded: parsed.kind === 'records' ? { records: parsed.records.map(eventRecord) } : null,
    }
  }
  const draft = file.draft as CmsfDraft
  const parsed = parseEventTimeline(text, draft === 'cmsf-01' ? { draft: 'msf-01' } : {})
  const sap = parsed.kind === 'records' ? readSapTimeline(parsed.records, { draft }) : null
  return {
    problems: [...parsed.problems, ...(sap?.problems ?? [])],
    decoded: sap && {
      records: sap.entries.map((e) => ({
        group_id: String(e.group),
        object_id: String(e.object),
        sap_type: String(e.sapType),
        ept_ms: String(e.ept),
      })),
    },
  }
}

/** Warnings that keep every record, by format or event type */
const RECORD_WARNINGS: Record<string, string[]> = {
  mediatimeline: [],
  template: [],
  eventtimeline: ['mixed_index'],
  [SAP_TIMELINE_EVENT_TYPE]: ['mixed_index', 'conflicting_records'],
}

// ─── Run ─────────────────────────────────────────────────────────────

const { objects, timelines, notRun } = loadVectors()

describe('CMSF object and timeline vectors', () => {
  it('runs every category the manifest lists', () => {
    expect(notRun).toEqual([])
    const counts: Record<string, number> = {}
    for (const f of [...objects, ...timelines]) {
      const key = [f.draft, f.name.split('/').at(-2), f.format, f.eventType]
        .filter((part) => part !== undefined)
        .join(' ')
      counts[key] = (counts[key] ?? 0) + f.vectors.length
    }
    expect(counts).toEqual({
      'msf-00 timeline mediatimeline': 16,
      'msf-00 timeline eventtimeline': 16,
      'msf-01 timeline mediatimeline': 15,
      'msf-01 timeline eventtimeline': 16,
      'msf-01 timeline template': 13,
      'cmsf-00 objects': 45,
      'cmsf-00 timeline eventtimeline org.ietf.moq.cmsf.sap': 19,
      'cmsf-01 objects': 45,
      'cmsf-01 timeline eventtimeline org.ietf.moq.cmsf.sap': 23,
    })
  })

  for (const file of objects) {
    describe(file.name, () => {
      for (const vector of file.vectors) {
        it(vector.id, () => {
          const init = vector.header ? parseInitSegment(hexToBytes(vector.header.hex)) : null
          if (vector.header) expect(init).not.toBeNull()
          const object = parseCmafObject(hexToBytes(vector.object.hex), init)
          const findings = checkCmafObject(object, init, {
            draft: file.draft as CmsfDraft,
            firstInGroup: vector.first_in_group === true,
          })
          const violations = [
            ...new Set(
              findings
                .filter((f) => f.kind === 'violation')
                .map((f) => Object.keys(ERROR_CODES).find((e) => ERROR_CODES[e]!.includes(f.code))),
            ),
          ]
          if (vector.error !== undefined) {
            expect(violations).toEqual([vector.error])
            return
          }
          expect(violations).toEqual([])
          expect(asDecoded(object, init)).toEqual(vector.decoded)
        })
      }
    })
  }

  for (const file of timelines) {
    describe(file.name, () => {
      it('is a timeline this package reads', () => {
        expect(['mediatimeline', 'eventtimeline', 'template']).toContain(file.format)
        if (file.draft.startsWith('cmsf')) {
          expect(file.format).toBe('eventtimeline')
          expect(file.eventType).toBe(SAP_TIMELINE_EVENT_TYPE)
        } else {
          expect(file.eventType).toBeUndefined()
        }
      })
      for (const vector of file.vectors) {
        it(vector.id, () => {
          const { problems, decoded } = readTimeline(file, vector)
          const errors = [
            ...new Set(problems.filter((p) => p.severity === 'error').map((p) => p.category)),
          ]
          const allowed = RECORD_WARNINGS[file.eventType ?? file.format!]!
          const warnings = problems.filter((p) => p.severity === 'warning').map((p) => p.category)
          expect(warnings.filter((c) => !allowed.includes(c))).toEqual([])
          if (vector.error !== undefined) {
            expect(errors).toEqual([vector.error])
            return
          }
          expect(errors).toEqual([])
          expect(decoded).toEqual(vector.decoded)
        })
      }
    })
  }
})
