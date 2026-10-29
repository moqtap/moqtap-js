import { describe, expect, it } from 'vitest'
import {
  mediaTimelineTemplateEntry,
  parseEventTimeline,
  parseMediaTimeline,
  parseMediaTimelineTemplate,
  readSapTimeline,
  SAP_TIMELINE_EVENT_TYPE,
} from '../timeline'

/** msf-00 7.1 and msf-01 7.1.1 */
const MSF_MEDIA_EXAMPLE = `[
  [0, [0,0], 1759924158381],
  [2002, [1,0], 1759924160383],
  [4004, [2,0], 1759924162385],
  [6006, [3,0], 1759924164387],
  [8008, [4,0], 1759924166389]
]`

/** msf-01 7.4.1 */
const MSF_TEMPLATE_EXAMPLE = [0, 2002, [0, 0], [1, 0], 1759924158381, 2002]

describe('parseMediaTimeline', () => {
  it('reads the msf 7.1 example', () => {
    const parsed = parseMediaTimeline(MSF_MEDIA_EXAMPLE, { draft: 'msf-01' })
    if (parsed.kind !== 'records') throw new Error(parsed.kind)
    expect(parsed.problems).toEqual([])
    expect(parsed.records).toHaveLength(5)
    expect(parsed.records[1]).toEqual({
      mediaTime: 2002,
      group: 1,
      object: 0,
      wallclock: 1759924160383,
      at: 1,
    })
  })

  it('reads bytes and an empty document', () => {
    expect(parseMediaTimeline(new TextEncoder().encode('[[0, [0,0], 0]]'))).toEqual({
      kind: 'records',
      records: [{ mediaTime: 0, group: 0, object: 0, wallclock: 0, at: 0 }],
      problems: [],
    })
    expect(parseMediaTimeline('[]')).toEqual({ kind: 'records', records: [], problems: [] })
  })

  it('leaves out records it cannot read, and says why', () => {
    const parsed = parseMediaTimeline(
      JSON.stringify([
        { m: 0 },
        [0, [0, 0]],
        [0, [0, 0], 0, 1],
        ['0', [0, 0], 0],
        [0, [0, -1], 0],
        [0, [0, 0], null],
        [0, 2002, [0, 0], [1, 0], 1759924158381, 2002],
        [2002.5, [1, 0], 0],
        [10, [5, 0], 0],
      ]),
      { draft: 'msf-00' },
    )
    if (parsed.kind !== 'records') throw new Error(parsed.kind)
    expect(parsed.records).toEqual([{ mediaTime: 10, group: 5, object: 0, wallclock: 0, at: 8 }])
    expect(parsed.problems.map((p) => [p.severity, p.category, p.path, p.section])).toEqual([
      ['error', 'invalid_value', '[0]', 'MSF-00 7.1'],
      ['error', 'missing_field', '[1][2]', 'MSF-00 7.1'],
      ['error', 'invalid_value', '[2]', 'MSF-00 7.1'],
      ['error', 'invalid_value', '[3][0]', 'MSF-00 7.1'],
      ['error', 'invalid_value', '[4][1]', 'MSF-00 7.1'],
      ['error', 'invalid_value', '[5][2]', 'MSF-00 7.1'],
      ['error', 'invalid_value', '[6]', 'MSF-00 7.1'],
      ['error', 'invalid_value', '[7][0]', 'MSF-00 7.1'],
    ])
    expect(parseMediaTimeline('[[2002.5, [1,0], 0]]').problems[0]?.section).toBe(
      'MSF-00 7.1; MSF-01 7.1.1',
    )
  })

  it('leaves out an Array of more than three items without a problem, except under msf-00', () => {
    const doc =
      '[[0, [0, 0], 0, 1], [0, 2002, [0, 0], [1, 0], 1759924158381, 2002], [10, [5, 0], 0]]'
    for (const options of [{ draft: 'msf-01' } as const, {}]) {
      expect(parseMediaTimeline(doc, options)).toEqual({
        kind: 'records',
        records: [{ mediaTime: 10, group: 5, object: 0, wallclock: 0, at: 2 }],
        problems: [],
      })
    }
  })

  it('keeps records in document order, repeated Locations included', () => {
    const parsed = parseMediaTimeline('[[4004, [2,0], 0], [0, [0,0], 0], [0, [0,0], 0]]')
    if (parsed.kind !== 'records') throw new Error(parsed.kind)
    expect(parsed.records.map((r) => [r.group, r.at])).toEqual([
      [2, 0],
      [0, 1],
      [0, 2],
    ])
    expect(parsed.problems).toEqual([])
  })

  it('is invalid when the document is not JSON or not UTF-8, or under MSF-00 not an array', () => {
    const notArray = {
      severity: 'error',
      category: 'invalid_value',
      path: '',
      section: 'MSF-00 7.1',
      message: 'a media timeline is an array of records',
    }
    expect(parseMediaTimeline('{}', { draft: 'msf-00' })).toEqual({
      kind: 'invalid',
      problems: [notArray],
    })
    expect(parseMediaTimeline('{}', { draft: 'msf-01' })).toEqual({ kind: 'unread', problems: [] })
    expect(parseMediaTimeline('{}')).toEqual({ kind: 'unread', problems: [] })
    expect(parseMediaTimeline('[')).toMatchObject({
      kind: 'invalid',
      problems: [{ category: 'invalid_json' }],
    })
    expect(parseMediaTimeline(new Uint8Array([0x1f, 0x8b, 8, 0]))).toMatchObject({
      kind: 'invalid',
      problems: [{ category: 'invalid_json' }],
    })
  })
})

describe('parseMediaTimelineTemplate', () => {
  it('reads the msf-01 7.4.1 example', () => {
    expect(parseMediaTimelineTemplate(MSF_TEMPLATE_EXAMPLE)).toEqual({
      template: {
        startMediaTime: 0,
        deltaMediaTime: 2002,
        startGroup: 0,
        startObject: 0,
        deltaGroup: 1,
        deltaObject: 0,
        startWallclock: 1759924158381,
        deltaWallclock: 2002,
      },
      problems: [],
    })
  })

  it('is null when the value is not six values', () => {
    for (const value of [null, {}, [0, 2002, [0, 0], [1, 0], 0, 0, 0]]) {
      expect(parseMediaTimelineTemplate(value)).toEqual({
        template: null,
        problems: [
          {
            severity: 'error',
            category: 'invalid_value',
            path: '',
            section: 'MSF-01 7.4.1',
            message: 'a media timeline template is an Array of six values',
          },
        ],
      })
    }
    expect(parseMediaTimelineTemplate([0, 2002, [0, 0], [1, 0], 0]).problems).toEqual([
      {
        severity: 'error',
        category: 'missing_field',
        path: '[5]',
        section: 'MSF-01 7.4.1',
        message: 'a media timeline template has six mandatory values',
      },
    ])
  })

  it('names each value of the wrong type', () => {
    const parsed = parseMediaTimelineTemplate(['0', null, [0], [1, '0'], true, {}])
    expect(parsed.template).toBeNull()
    expect(parsed.problems.map((p) => p.path)).toEqual(['[0]', '[1]', '[2]', '[3]', '[4]', '[5]'])
  })

  it('keeps fractional deltas, and is null for a fractional startMediaTime', () => {
    const parsed = parseMediaTimelineTemplate([0, 21.333, [0, 0], [1, 0], 0, 0.5])
    expect(parsed.template).toMatchObject({ deltaMediaTime: 21.333, deltaWallclock: 0.5 })
    expect(parsed.problems).toEqual([])
    expect(parseMediaTimelineTemplate([0.5, 2002, [0, 0], [1, 0], 0, 0])).toEqual({
      template: null,
      problems: [
        {
          severity: 'error',
          category: 'invalid_value',
          path: '[0]',
          section: 'MSF-01 7.4.1',
          message: 'startMediaTime is a whole number of milliseconds',
        },
      ],
    })
  })
})

describe('mediaTimelineTemplateEntry', () => {
  const template = parseMediaTimelineTemplate(MSF_TEMPLATE_EXAMPLE).template!

  it('gives the entries the msf-01 7.4.1 formulas give', () => {
    expect(mediaTimelineTemplateEntry(template, 0)).toEqual({
      mediaTime: 0,
      group: 0,
      object: 0,
      wallclock: 1759924158381,
    })
    expect(mediaTimelineTemplateEntry(template, 3)).toEqual({
      mediaTime: 6006,
      group: 3,
      object: 0,
      wallclock: 1759924164387,
    })
  })

  it('is null for an n that is not a non-negative integer', () => {
    for (const n of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(mediaTimelineTemplateEntry(template, n)).toBeNull()
    }
  })

  it('is null where the formulas give no Location', () => {
    const t = parseMediaTimelineTemplate([0, 1000, [2, 0], [-1, 0.5], 0, 0]).template!
    expect(mediaTimelineTemplateEntry(t, 1)).toBeNull()
    expect(mediaTimelineTemplateEntry(t, 2)).toEqual({
      mediaTime: 2000,
      group: 0,
      object: 1,
      wallclock: 0,
    })
    expect(mediaTimelineTemplateEntry(t, 4)).toBeNull()
  })
})

/** cmsf-00 and cmsf-01 3.6.2 */
const CMSF_EXAMPLE = `[
    { "l": [0,0], "data": [2,0] },
    { "l": [0,60], "data": [3,2100] },
    { "l": [1,0], "data": [2,4000] },
    { "l": [1,60], "data": [3,6100] }
]`

function records(text: string) {
  const parsed = parseEventTimeline(text)
  if (parsed.kind !== 'records') throw new Error(parsed.kind)
  return parsed.records
}

describe('parseEventTimeline', () => {
  it('reads wallclock records (msf 8.4.1)', () => {
    const parsed = parseEventTimeline(
      '[{"t": 1756885678361, "data": {"period": 1}}, {"t": 1756885981542, "data": {"period": 1}}]',
      { draft: 'msf-01' },
    )
    expect(parsed).toEqual({
      kind: 'records',
      records: [
        { index: 't', time: 1756885678361, data: { period: 1 }, at: 0 },
        { index: 't', time: 1756885981542, data: { period: 1 }, at: 1 },
      ],
      problems: [],
    })
  })

  it('reads Location records whose data is an array (msf 8.4.2)', () => {
    expect(records('[{"l": [0,0], "data": [47.1812,8.4592]}]')).toEqual([
      { index: 'l', group: 0, object: 0, data: [47.1812, 8.4592], at: 0 },
    ])
  })

  it('reads media PTS records and bytes', () => {
    const parsed = parseEventTimeline(new TextEncoder().encode('[{"m": 2002, "data": null}]'))
    expect(parsed).toMatchObject({
      kind: 'records',
      records: [{ index: 'm', mediaTime: 2002, data: null }],
    })
  })

  it('leaves out records it cannot read, and says why', () => {
    const parsed = parseEventTimeline(
      JSON.stringify([
        1,
        { data: 1 },
        { t: 1, l: [0, 0], data: 1 },
        { t: 1 },
        { l: [0], data: 1 },
        { l: [0, -1], data: 1 },
        { l: [0, 1.5], data: 1 },
        { t: '1', data: 1 },
        { t: 5, data: 'kept' },
      ]),
      { draft: 'msf-00' },
    )
    if (parsed.kind !== 'records') throw new Error(parsed.kind)
    expect(parsed.records).toEqual([{ index: 't', time: 5, data: 'kept', at: 8 }])
    expect(parsed.problems.map((p) => [p.severity, p.category, p.path, p.section])).toEqual([
      ['error', 'invalid_value', '[0]', 'MSF-00 8.1'],
      ['error', 'invalid_index', '[1]', 'MSF-00 8.1'],
      ['error', 'invalid_index', '[2]', 'MSF-00 8.1'],
      ['error', 'missing_field', '[3].data', 'MSF-00 8.1'],
      ['error', 'invalid_value', '[4].l', 'MSF-00 8.1'],
      ['error', 'invalid_value', '[5].l', 'MSF-00 8.1'],
      ['error', 'invalid_value', '[6].l', 'MSF-00 8.1'],
      ['error', 'invalid_value', '[7].t', 'MSF-00 8.1'],
    ])
  })

  it('leaves out a media PTS that is not whole milliseconds', () => {
    const parsed = parseEventTimeline('[{"m": 33.3, "data": 1}]', { draft: 'msf-01' })
    expect(parsed).toEqual({
      kind: 'records',
      records: [],
      problems: [
        {
          severity: 'error',
          category: 'invalid_value',
          path: '[0].m',
          section: 'MSF-01 8.1, 7.1.1',
          message: 'media PTS 33.3 is not a whole number of milliseconds',
        },
      ],
    })
    expect(parseEventTimeline('[{"m": 33.3, "data": 1}]').problems[0]?.section).toBe(
      'MSF-00 8.1, 7.1; MSF-01 8.1, 7.1.1',
    )
    expect(parseEventTimeline('[{"t": 1756885678361.5, "data": 1}]').problems).toEqual([])
  })

  it('warns when records mix index reference types', () => {
    const parsed = parseEventTimeline('[{"t": 1, "data": 1}, {"m": 1, "data": 1}]')
    expect(parsed.problems).toEqual([
      {
        severity: 'warning',
        category: 'mixed_index',
        path: '',
        section: 'MSF-00 8.1, MSF-01 8.1',
        message: 'records SHOULD use one index reference type; these use t, m',
      },
    ])
  })

  it('is invalid when the document is not an array, not JSON or not UTF-8', () => {
    expect(parseEventTimeline('{"t": 1, "data": 1}')).toMatchObject({
      kind: 'invalid',
      problems: [{ category: 'invalid_value', path: '' }],
    })
    expect(parseEventTimeline('[')).toMatchObject({
      kind: 'invalid',
      problems: [{ category: 'invalid_json' }],
    })
    expect(parseEventTimeline(new Uint8Array([0x5b, 0xff, 0x5d]))).toMatchObject({
      kind: 'invalid',
      problems: [{ category: 'invalid_json', section: 'RFC 8259 8.1' }],
    })
  })

  it('reads gzip bytes as invalid like any payload that is not JSON', () => {
    expect(parseEventTimeline(new Uint8Array([0x1f, 0x8b, 8, 0]))).toMatchObject({
      kind: 'invalid',
      problems: [{ category: 'invalid_json' }],
    })
    expect(parseEventTimeline(new TextEncoder().encode('[]'))).toMatchObject({ kind: 'records' })
  })
})

describe('readSapTimeline', () => {
  it('names the eventType', () => {
    expect(SAP_TIMELINE_EVENT_TYPE).toBe('org.ietf.moq.cmsf.sap')
  })

  it('reads the cmsf 3.6.2 example', () => {
    expect(readSapTimeline(records(CMSF_EXAMPLE), { draft: 'cmsf-01' })).toEqual({
      entries: [
        { group: 0, object: 0, sapType: 2, ept: 0, at: 0 },
        { group: 0, object: 60, sapType: 3, ept: 2100, at: 1 },
        { group: 1, object: 0, sapType: 2, ept: 4000, at: 2 },
        { group: 1, object: 60, sapType: 3, ept: 6100, at: 3 },
      ],
      problems: [],
    })
  })

  it('leaves out malformed records', () => {
    const timeline = readSapTimeline(
      records(
        JSON.stringify([
          { t: 1, data: [1, 0] },
          { l: [0, 1], data: { sap: 1 } },
          { l: [0, 2], data: [1] },
          { l: [0, 3], data: [1, 0.5] },
          { l: [0, 4], data: [4, 0] },
          { l: [0, 5], data: [-1, 0] },
          { l: [0, 6], data: [0, -40] },
        ]),
      ),
    )
    expect(timeline.entries).toEqual([{ group: 0, object: 6, sapType: 0, ept: -40, at: 6 }])
    expect(timeline.problems.map((p) => [p.severity, p.category, p.path, p.section])).toEqual([
      ['error', 'invalid_index', '[0]', 'CMSF-00 3.6.1, CMSF-01 3.6.1'],
      ['error', 'invalid_value', '[1].data', 'CMSF-00 3.6.1, CMSF-01 3.6.1'],
      ['error', 'invalid_value', '[2].data', 'CMSF-00 3.6.1, CMSF-01 3.6.1'],
      ['error', 'invalid_value', '[3].data', 'CMSF-00 3.6.1, CMSF-01 3.6.1'],
      ['error', 'invalid_value', '[4].data[0]', 'CMSF-00 3.6.1, CMSF-01 3.6.1'],
      ['error', 'invalid_value', '[5].data[0]', 'CMSF-00 3.6.1, CMSF-01 3.6.1'],
    ])
  })

  it('leaves out an Object 0 record whose SAP type is not 1 or 2', () => {
    const recs = records('[{"l": [3,0], "data": [3,100]}, {"l": [3,1], "data": [0,133]}]')
    const problem = {
      severity: 'error',
      category: 'invalid_value',
      path: '[0].data[0]',
      message: 'the first Object of Group 3 has SAP type 3; it MUST be 1 or 2',
    }
    expect(readSapTimeline(recs, { draft: 'cmsf-01' })).toEqual({
      entries: [{ group: 3, object: 1, sapType: 0, ept: 133, at: 1 }],
      problems: [{ ...problem, section: 'CMSF-01 3.6.1, MSF-01 6.2' }],
    })
    expect(readSapTimeline(recs, { draft: 'cmsf-00' }).problems).toEqual([
      { ...problem, section: 'CMSF-00 3.6.1, draft-ietf-moq-transport-10 9.1.1' },
    ])
    expect(readSapTimeline(recs).problems).toMatchObject([problem])
  })

  it('keeps both of two records that disagree on one Location', () => {
    const timeline = readSapTimeline(
      records(
        '[{"l": [0,0], "data": [1,0]}, {"l": [0,0], "data": [1,0]}, {"l": [0,0], "data": [2,0]}]',
      ),
    )
    expect(timeline.entries).toHaveLength(3)
    expect(timeline.problems).toEqual([
      {
        severity: 'warning',
        category: 'conflicting_records',
        path: '[2]',
        section: 'CMSF-00 3.6.1, CMSF-01 3.6.1',
        message: 'Location [0,0] is also given as [1,0] at [0]',
      },
    ])
  })
})
