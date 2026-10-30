/**
 * Problem ids, spec references and wording, for every kind the catalog and
 * timeline readers report.
 */

import { describe, expect, it } from 'vitest'
import {
  applyCatalogObject,
  type CatalogDraft,
  type CatalogProblem,
  catalogProblemExpected,
  catalogProblemFound,
  catalogProblemRemedy,
  catalogProblemTitle,
  catalogProblemTracks,
  checkCatalogObjectPlacement,
  createCatalogState,
  type JsonObject,
  parseCatalog,
  severityOf,
  specUrl,
} from '../catalog'
import { problemTitle } from '../problems'
import {
  type EventRecord,
  parseEventTimeline,
  parseMediaTimeline,
  parseMediaTimelineTemplate,
  readSapTimeline,
  type TimelineProblem,
} from '../timeline'

const B64 = 'AAAAAA=='

function track(fields: JsonObject): JsonObject {
  return { name: 'v', packaging: 'loc', isLive: true, ...fields }
}

function catalog(draft: CatalogDraft, tracks: JsonObject[], root: JsonObject = {}): string {
  const version = draft.endsWith('00') ? 1 : 'draft-01'
  return JSON.stringify({ version, tracks, ...root })
}

function parse(input: string | Uint8Array, draft?: CatalogDraft): CatalogProblem[] {
  return parseCatalog(input, draft === undefined ? {} : { draft }).problems
}

/** Each object's problems, parse and apply, after the objects before it */
function follow(draft: CatalogDraft, ...objects: string[]): CatalogProblem[] {
  let state = createCatalogState({ draft })
  const out: CatalogProblem[] = []
  for (const text of objects) {
    const parsed = parseCatalog(text, { draft })
    const update = applyCatalogObject(state, parsed)
    out.push(...parsed.problems, ...update.problems)
    state = update.state
  }
  return out
}

/** Inputs that between them raise every catalog problem kind */
function catalogCases(): CatalogProblem[] {
  const all: CatalogProblem[] = []
  const add = (ps: CatalogProblem[]) => all.push(...ps)
  // Payload and root
  add(parse(new Uint8Array([0xff])))
  add(parse('{'))
  add(parse('[]'))
  add(parse('{"tracks": []}'))
  add(parse('{"version": 1, "tracks": []}', 'msf-01'))
  add(parse('{"version": "draft-03", "tracks": []}', 'msf-01'))
  add(parse('{"version": "draft-01"}', 'msf-01'))
  add(parse('{"version": "draft-01", "tracks": 3}', 'msf-01'))
  add(
    parse(
      '{"version": "draft-01", "tracks": [], "generatedAt": "x", "isComplete": 1, "publishTracks": 2}',
      'msf-01',
    ),
  )
  add(parse('{"version": "draft-01", "tracks": [], "isComplete": false}', 'msf-01'))
  add(parse('{"version": "1", "tracks": [{"name": "v", "packaging": "loc", "isLive": true}]}'))
  // Tracks
  add(
    parse(
      catalog('msf-01', [
        5 as unknown as JsonObject,
        { packaging: 'loc', isLive: true },
        { name: 1, namespace: 2, packaging: 'loc', isLive: true },
        { name: 'p' },
        track({ name: 'w', width: '640' }),
        track({ name: 'x', packaging: 'mp4' }),
        track({ name: 'e', packaging: 'eventtimeline' }),
        track({ name: 'f', eventType: 'com.example' }),
        track({ name: 'b', targetLatency: 1, buffers: {} }),
        track({ name: 'd', trackDuration: 10 }),
        track({ name: 'pn', parentName: 'a', parentNamespace: 'n' }),
        track({ name: 'vid', role: 'video' }),
        track({ name: 'aud', role: 'audio', codec: 'opus', bitrate: 1 }),
        track({ name: 'enc', encryptionScheme: 'moq-secure-objects' }),
        track({ name: 'dup' }),
        track({ name: 'dup' }),
        track({ name: 'ir', initRef: 'nope' }),
        track({ name: 'ir2', initRef: 'twice' }),
      ]),
      'msf-01',
    ),
  )
  add(
    parse(catalog('msf-00', [track({ targetLatency: 1, isLive: false, initData: 'x' })]), 'msf-00'),
  )
  // CMSF
  add(
    parse(
      catalog('cmsf-01', [
        track({ name: 'c1', packaging: 'cmaf', initData: B64 }),
        track({ name: 'c2', packaging: 'cmaf' }),
        track({ name: 'g', maxGrpSapStartingType: 3 }),
        track({ name: 's', eventType: 'org.ietf.moq.cmsf.sap' }),
        track({ name: 'cp', contentProtections: [], contentProtectionRefIDs: [1, 'none', 'dup'] }),
      ]),
      'cmsf-01',
    ),
  )
  add(
    parse(catalog('cmsf-00', [track({ name: 'c3', packaging: 'cmaf', initRef: 'i' })]), 'cmsf-00'),
  )
  // initDataList
  add(
    parse(
      JSON.stringify({
        version: 'draft-01',
        initDataList: [
          4,
          {},
          { id: 1, type: 2, data: 3 },
          { id: 'twice', type: 'url', data: 'x' },
          { id: 'twice', type: 'inline', data: 'x' },
        ],
        tracks: [],
      }),
      'cmsf-01',
    ),
  )
  add(parse(JSON.stringify({ version: 'draft-01', tracks: [], initDataList: 4 }), 'msf-01'))
  // contentProtections
  add(
    parse(
      JSON.stringify({
        version: 'draft-01',
        tracks: [],
        contentProtections: [
          4,
          {},
          { refID: 1, defaultKID: 2, scheme: 'aes', drmSystem: 3 },
          {
            refID: 'dup',
            defaultKID: ['nope'],
            scheme: 'cenc',
            drmSystem: { systemID: 'x', laURL: 1, certURL: {}, pssh: '!' },
          },
          {
            refID: 'dup',
            defaultKID: [],
            scheme: 'cbcs',
            drmSystem: { laURL: { url: 2 } },
          },
        ],
      }),
      'cmsf-01',
    ),
  )
  add(parse(JSON.stringify({ version: 'draft-01', tracks: [], contentProtections: 4 }), 'cmsf-01'))
  // Deltas
  add(parse('{"version": "1", "tracks": [], "deltaUpdate": []}', 'msf-01'))
  add(parse('{"deltaUpdate": true}', 'msf-01'))
  add(
    parse(
      JSON.stringify({
        deltaUpdate: [
          3,
          {},
          { op: 'move', tracks: 1 },
          { op: 'add', tracks: [5] },
          { op: 'remove', tracks: [{ name: 2, namespace: 3, role: 'x' }, {}] },
          { op: 'clone', tracks: [{ parentName: 1, parentNamespace: 2, name: 3, namespace: 4 }] },
          { op: 'clone', tracks: [{}] },
        ],
      }),
      'msf-01',
    ),
  )
  add(parse('{"deltaUpdate": [1], "addTracks": 3}', 'msf-00'))
  add(parse('{"removeTracks": [{"name": "v"}]}', 'msf-00'))
  add(parse('{"deltaUpdate": true}', 'msf-00'))
  add(parse('{"deltaUpdate": [{"op": "remove", "tracks": [{"name": "v"}]}]}', 'msf-01').concat())
  add(
    applyCatalogObject(
      createCatalogState({ draft: 'msf-01' }),
      parseCatalog('{"deltaUpdate": [{"op": "remove", "tracks": [{"name": "v"}]}]}', {
        draft: 'msf-01',
      }),
    ).problems,
  )
  const base = catalog('msf-01', [track({ name: 'a' }), track({ name: 'b', isLive: false })], {
    isComplete: true,
  })
  add(
    follow(
      'msf-01',
      base,
      '{"deltaUpdate": [{"op": "add", "tracks": [{"name": "a", "packaging": "loc", "isLive": true}]}]}',
    ),
  )
  add(follow('msf-01', base, '{"deltaUpdate": [{"op": "remove", "tracks": [{"name": "z"}]}]}'))
  add(
    follow(
      'msf-01',
      base,
      '{"deltaUpdate": [{"op": "clone", "tracks": [{"parentName": "z", "name": "c"}]}]}',
    ),
  )
  add(
    follow(
      'msf-01',
      catalog('msf-01', [track({ name: 'a' })]),
      '{"deltaUpdate": [{"op": "clone", "tracks": [{"parentName": "a", "name": "a"}]}]}',
    ),
  )
  add(
    follow(
      'msf-01',
      catalog('msf-01', [track({ name: 'a' }), track({ name: 'a' })]),
      '{"deltaUpdate": [{"op": "remove", "tracks": [{"name": "a"}]}]}',
    ),
  )
  add(
    follow(
      'msf-01',
      base,
      catalog('msf-01', [track({ name: 'a' }), track({ name: 'b' }), track({ name: 'n' })]),
    ),
  )
  // A delta of the other revision against the catalog in force
  let state = applyCatalogObject(
    createCatalogState(),
    parseCatalog(catalog('msf-01', [track({})])),
  ).state
  const mismatch = applyCatalogObject(
    state,
    parseCatalog('{"deltaUpdate": true, "removeTracks": [{"name": "v"}]}'),
  )
  add(mismatch.problems)
  state = mismatch.state
  // Placement
  add(
    checkCatalogObjectPlacement(
      { groupId: 7, subgroupId: 1, objectId: 0, independent: false },
      'msf-01',
    ),
  )
  add(
    checkCatalogObjectPlacement(
      { groupId: 7, subgroupId: 0, objectId: 2, independent: true },
      'msf-01',
    ),
  )
  return all
}

/** Inputs that between them raise every timeline problem kind */
function timelineCases(): TimelineProblem[] {
  const all: TimelineProblem[] = []
  all.push(...parseMediaTimeline(new Uint8Array([0xff])).problems)
  all.push(...parseMediaTimeline('[').problems)
  all.push(...parseMediaTimeline('{}', { draft: 'msf-00' }).problems)
  all.push(
    ...parseMediaTimeline('[3, [1, 2], [1, 2, 3, 4], ["a", 0, null], [1.5, [0, 0], 0]]', {
      draft: 'msf-00',
    }).problems,
  )
  all.push(...parseMediaTimelineTemplate({}).problems)
  all.push(...parseMediaTimelineTemplate([0, 1]).problems)
  all.push(...parseMediaTimelineTemplate([0.5, '1', [0], [1], 'a', null]).problems)
  all.push(...parseEventTimeline('{}').problems)
  all.push(
    ...parseEventTimeline(
      '[1, {}, {"t": 1, "m": 2, "data": 1}, {"t": 1}, {"l": 3, "data": 1}, {"t": "x", "data": 1}, {"m": 1.5, "data": 1}, {"t": 1, "data": 1}, {"m": 1, "data": 1}]',
    ).problems,
  )
  const records = (text: string): EventRecord[] => {
    const parsed = parseEventTimeline(text)
    return parsed.kind === 'records' ? parsed.records : []
  }
  all.push(
    ...readSapTimeline(
      records(
        '[{"t": 1, "data": [1, 0]}, {"l": [1, 1], "data": 5}, {"l": [1, 2], "data": [7, 0]}, {"l": [2, 0], "data": [3, 0]}, {"l": [3, 1], "data": [1, 0]}, {"l": [3, 1], "data": [2, 0]}]',
      ),
    ).problems,
  )
  return all
}

const CATALOG_IDS = [
  'catalog.json.utf8',
  'catalog.json.syntax',
  'catalog.root.object',
  'catalog.root.version.missing',
  'catalog.root.version.type',
  'catalog.root.version.unsupported',
  'catalog.root.tracks.missing',
  'catalog.root.tracks.type',
  'catalog.root.generatedAt.type',
  'catalog.root.isComplete.type',
  'catalog.root.isComplete.false',
  'catalog.root.isComplete.removed',
  'catalog.root.publishTracks.type',
  'catalog.root.initDataList.type',
  'catalog.root.initDataList.misplaced',
  'catalog.root.contentProtections.type',
  'catalog.draft.ambiguous',
  'catalog.track.object',
  'catalog.track.name.missing',
  'catalog.track.name.type',
  'catalog.track.namespace.type',
  'catalog.track.width.type',
  'catalog.track.packaging.missing',
  'catalog.track.packaging.value',
  'catalog.track.isLive.missing',
  'catalog.track.eventType.missing',
  'catalog.track.eventType.forbidden',
  'catalog.track.targetLatency.forbidden',
  'catalog.track.buffers.forbidden',
  'catalog.track.trackDuration.forbidden',
  'catalog.track.parentName.forbidden',
  'catalog.track.parentNamespace.forbidden',
  'catalog.track.codec.missing',
  'catalog.track.bitrate.missing',
  'catalog.audio.samplerate.missing',
  'catalog.audio.channelConfig.missing',
  'catalog.track.cipherSuite.missing',
  'catalog.track.initData.base64',
  'catalog.init.missing',
  'catalog.init.other-draft-field',
  'catalog.track.maxGrpSapStartingType.value',
  'catalog.track.sapTimeline.packaging',
  'catalog.track.contentProtections.forbidden',
  'catalog.track.duplicate',
  'catalog.track.initRef.unknown',
  'catalog.track.contentProtectionRefIDs.type',
  'catalog.track.contentProtectionRef.unknown',
  'catalog.track.isLive.revived',
  'catalog.track.added-after-complete',
  'catalog.initDataList.entry.object',
  'catalog.initDataList.id.missing',
  'catalog.initDataList.type.missing',
  'catalog.initDataList.data.missing',
  'catalog.initDataList.id.type',
  'catalog.initDataList.type.type',
  'catalog.initDataList.data.type',
  'catalog.initDataList.id.duplicate',
  'catalog.initDataList.type.value',
  'catalog.initDataList.data.base64',
  'catalog.contentProtections.entry.object',
  'catalog.contentProtections.refID.missing',
  'catalog.contentProtections.defaultKID.missing',
  'catalog.contentProtections.scheme.missing',
  'catalog.contentProtections.drmSystem.missing',
  'catalog.contentProtections.systemID.missing',
  'catalog.contentProtections.url.missing',
  'catalog.contentProtections.refID.type',
  'catalog.contentProtections.defaultKID.type',
  'catalog.contentProtections.drmSystem.type',
  'catalog.contentProtections.laURL.type',
  'catalog.contentProtections.url.type',
  'catalog.contentProtections.refID.duplicate',
  'catalog.contentProtections.defaultKID.value',
  'catalog.contentProtections.scheme.value',
  'catalog.contentProtections.systemID.value',
  'catalog.contentProtections.pssh.value',
  'catalog.delta.tracks.forbidden',
  'catalog.delta.version.forbidden',
  'catalog.delta.deltaUpdate.type',
  'catalog.delta.deltaUpdate.value',
  'catalog.delta.addTracks.type',
  'catalog.delta.operations.missing',
  'catalog.delta.operations.empty',
  'catalog.delta.operation.object',
  'catalog.delta.operation.op.missing',
  'catalog.delta.operation.op.value',
  'catalog.delta.operation.tracks.missing',
  'catalog.delta.operation.tracks.type',
  'catalog.delta.remove.name.missing',
  'catalog.delta.remove.name.type',
  'catalog.delta.remove.namespace.type',
  'catalog.delta.remove.field.forbidden',
  'catalog.delta.clone.parentName.missing',
  'catalog.delta.clone.parentName.type',
  'catalog.delta.clone.parentNamespace.type',
  'catalog.delta.clone.name.missing',
  'catalog.delta.clone.name.type',
  'catalog.delta.clone.namespace.type',
  'catalog.delta.base.missing',
  'catalog.delta.draft.mismatch',
  'catalog.delta.track.unknown',
  'catalog.delta.track.ambiguous',
  'catalog.delta.track.exists',
  'catalog.object.first-delta',
  'catalog.object.later-independent',
  'catalog.object.subgroup',
]

const TIMELINE_IDS = [
  'timeline.json.utf8',
  'timeline.json.syntax',
  'timeline.media.array',
  'timeline.media.record.type',
  'timeline.media.record.missing',
  'timeline.media.mediaTime.type',
  'timeline.media.mediaTime.integer',
  'timeline.media.location.type',
  'timeline.media.wallclock.type',
  'timeline.template.type',
  'timeline.template.missing',
  'timeline.template.value.type',
  'timeline.event.array',
  'timeline.event.record.object',
  'timeline.event.index.missing',
  'timeline.event.index.multiple',
  'timeline.event.data.missing',
  'timeline.event.location.type',
  'timeline.event.time.type',
  'timeline.event.mediaTime.integer',
  'timeline.event.index.mixed',
  'timeline.sap.index',
  'timeline.sap.data.type',
  'timeline.sap.type.value',
  'timeline.sap.first-object',
  'timeline.sap.conflict',
]

/** What every problem holds, whatever its kind */
function expectWellFormed(p: CatalogProblem | TimelineProblem): void {
  const at = `${p.id} at ${p.path || '(root)'}`
  expect(p.message, at).toBe(problemTitle([p]))
  expect(p.message, at).toMatch(/^[A-Z].*[^.]$/s)
  expect(p.message.length, `${at}: ${p.message}`).toBeLessThanOrEqual(70)
  const remedy = catalogProblemRemedy([p])
  expect(remedy, at).not.toMatch(/\n/)
  if (p.id !== 'catalog.draft.ambiguous') expect(remedy, at).toMatch(/^[A-Z].*[^.]$/)
  expect(catalogProblemFound([p]), at).not.toBe('')
  expect(catalogProblemExpected([p]), at).toBe(p.expected)
  expect(p.spec.quote.length, at).toBeGreaterThan(0)
  expect(p.spec.revision, at).toMatch(/^0[01]$/)
  // Timeline problems keep 0.2's sections, which cite both drafts when none is given.
  if (p.id.startsWith('catalog.')) {
    expect(p.section, at).toBe(`${p.spec.draft.toUpperCase()}-${p.spec.revision} ${p.spec.section}`)
  }
  expect(specUrl(p.spec), at).toBe(
    `https://datatracker.ietf.org/doc/html/draft-ietf-moq-${p.spec.draft}-${p.spec.revision}#section-${p.spec.section}`,
  )
  expect(p.effect, at).toBe(p.severity === 'error' ? 'refused' : 'applied')
  const keyword = p.spec.keyword
  const expected =
    p.id === 'catalog.draft.ambiguous'
      ? 'info'
      : keyword === 'MUST' || keyword === 'MUST NOT' || keyword === 'REQUIRED' || keyword === 'TYPE'
        ? 'error'
        : 'warning'
  expect(severityOf(p), at).toBe(expected)
}

describe('problem kinds', () => {
  const catalogProblems = catalogCases()
  const timelineProblems = timelineCases()

  it('raises every catalog kind, each well formed', () => {
    const ids = new Set(catalogProblems.map((p) => p.id))
    expect(
      [...ids].filter((id) => !CATALOG_IDS.includes(id)),
      'unlisted ids',
    ).toEqual([])
    expect(
      CATALOG_IDS.filter((id) => !ids.has(id as never)),
      'ids not raised',
    ).toEqual([])
    for (const p of catalogProblems) expectWellFormed(p)
  })

  it('raises every timeline kind, each well formed', () => {
    const ids = new Set(timelineProblems.map((p) => p.id))
    expect(
      [...ids].filter((id) => !TIMELINE_IDS.includes(id)),
      'unlisted ids',
    ).toEqual([])
    expect(
      TIMELINE_IDS.filter((id) => !ids.has(id as never)),
      'ids not raised',
    ).toEqual([])
    for (const p of timelineProblems) {
      expectWellFormed(p)
      expect(p.subject.kind === 'record' || p.subject.kind === 'root').toBe(true)
    }
  })

  it('gives the whole catalog a subject from the path', () => {
    const p = catalogProblems.find((q) => q.id === 'catalog.contentProtections.systemID.value')!
    expect(p.subject).toEqual({ kind: 'entry', list: 'contentProtections', index: 3 })
    expect(p.field).toBe('drmSystem.systemID')
    const d = catalogProblems.find((q) => q.id === 'catalog.delta.remove.field.forbidden')!
    expect(d.subject).toEqual({ kind: 'delta', op: 4, operation: 'remove', index: 0, name: null })
    expect(d.field).toBe('role')
  })
})

describe('the owner-reported catalog', () => {
  // The shape of a draft-01 catalog that carries CMSF-00's track-level
  // initData: ten cmaf tracks, the audio one without samplerate or channelConfig.
  const header = (n: number) => btoa(String.fromCharCode(...new Uint8Array(n)))
  const tracks: JsonObject[] = []
  for (const r of ['1080p', '720p', '540p']) {
    for (const d of ['6s', '2s', '500ms']) {
      tracks.push({
        name: `${r}_${d}`,
        packaging: 'cmaf',
        isLive: true,
        role: 'video',
        codec: 'avc1.42C028',
        bitrate: 1,
        initData: header(r === '1080p' ? 802 : 801),
      })
    }
  }
  tracks.push({
    name: 'audio',
    packaging: 'cmaf',
    isLive: true,
    role: 'audio',
    codec: 'mp4a.40.2',
    bitrate: 1,
    initData: header(736),
  })
  const text = JSON.stringify({ version: 'draft-01', generatedAt: 1, tracks })
  const problems = parseCatalog(text, { catalogNamespace: 'ns' }).problems

  it('reads it as CMSF-01 from its shape', () => {
    expect(new Set(problems.map((p) => p.readAs.drafts.join()))).toEqual(new Set(['cmsf-01']))
  })

  it('is one initRef row naming the ten tracks, an error from the MUST', () => {
    const init = problems.filter((p) => p.family === 'catalog.init.other-draft-field')
    expect(init).toHaveLength(10)
    expect(catalogProblemTitle(init)).toBe(
      'Catalog is draft-01 but gives CMAF headers in initData, not initRef',
    )
    expect(catalogProblemRemedy(init)).toBe(
      "Move each track's header into an initDataList entry and set its initRef to that id",
    )
    expect(catalogProblemFound(init)).toBe(
      'version "draft-01" · initData present on 10 tracks (736–802 B) · initRef absent',
    )
    expect(catalogProblemTracks(init)).toEqual(tracks.map((t) => t.name))
    expect(init[0]!.spec).toEqual({
      draft: 'cmsf',
      revision: '01',
      section: '3.1',
      keyword: 'MUST',
      quote:
        'The header for a given MOQT Track MUST be added to the catalog by generating an initDataList entry with a "type" of "inline", a "data" value of the header encoded using [BASE64] and an "id" which is unique across the initDataList items.',
    })
    expect(init[0]!.also.map((r) => `${r.draft}-${r.revision} ${r.section}`)).toEqual([
      'msf-01 5.1.7',
      'msf-01 5.2.13',
    ])
    expect(init[9]!.actual).toEqual({ kind: 'other-field', field: 'initData', bytes: 736 })
    expect(severityOf(init[0]!)).toBe('error')
    expect(specUrl(init[0]!.spec)).toBe(
      'https://datatracker.ietf.org/doc/html/draft-ietf-moq-cmsf-01#section-3.1',
    )
  })

  it('is one audio row for samplerate and channelConfig', () => {
    const audio = problems.filter((p) => p.family === 'catalog.audio.fields')
    expect(audio.map((p) => p.id)).toEqual([
      'catalog.audio.samplerate.missing',
      'catalog.audio.channelConfig.missing',
    ])
    expect(catalogProblemTitle(audio)).toBe(
      'Audio track "audio" has no samplerate or channelConfig',
    )
    expect(catalogProblemRemedy(audio)).toBe(
      'Add samplerate (Number) and channelConfig (String) to the track',
    )
    expect(catalogProblemFound(audio)).toBe('samplerate absent · channelConfig absent')
    expect(audio.map(severityOf)).toEqual(['error', 'error'])
    expect(audio.map((p) => p.spec.section)).toEqual(['5.2.28', '5.2.29'])
  })

  it('has nothing else wrong', () => {
    expect(problems).toHaveLength(12)
  })

  it('words the subgroup rule over many objects', () => {
    const placed = [15912, 15913, 15916].flatMap((groupId) =>
      checkCatalogObjectPlacement({ groupId, subgroupId: 1, objectId: 0, independent: true }, [
        'cmsf-01',
      ]),
    )
    expect(placed.map((p) => p.id)).toEqual(Array(3).fill('catalog.object.subgroup'))
    expect(catalogProblemTitle(placed)).toBe(
      'Catalog objects are sent on subgroup 1, not subgroup 0',
    )
    expect(catalogProblemRemedy(placed)).toBe('Send every catalog object on subgroup 0')
    expect(catalogProblemFound(placed)).toBe('subgroup 1')
    expect(placed[0]!.spec).toMatchObject({ draft: 'msf', revision: '01', section: '5' })
    expect(placed[0]!.spec.quote).toBe(
      'All catalog updates, both independent and delta, MUST be mapped to MOQT sub-group 0.',
    )
    expect(severityOf(placed[0]!)).toBe('error')
    expect(placed[0]!.effect).toBe('applied')
    const mixed = [
      ...placed,
      ...checkCatalogObjectPlacement(
        { groupId: 1, subgroupId: 2, objectId: 0, independent: true },
        'msf-01',
      ),
    ]
    expect(catalogProblemTitle(mixed)).toBe('Catalog objects are sent on subgroups other than 0')
  })
})

describe('the other init field and none', () => {
  it('words the draft-00 mirror case', () => {
    const problems = parse(
      catalog('cmsf-00', [track({ name: 'a', packaging: 'cmaf', initRef: 'i' })]),
      'cmsf-00',
    ).filter((p) => p.family === 'catalog.init.other-draft-field')
    expect(catalogProblemTitle(problems)).toBe(
      'Catalog is draft-00 but gives CMAF headers by initRef, not initData',
    )
    expect(problems[0]!.spec).toMatchObject({ draft: 'cmsf', revision: '00', section: '3.1' })
  })

  it('names the track when neither field is there', () => {
    const one = parse(catalog('cmsf-01', [track({ name: 'a', packaging: 'cmaf' })]), 'cmsf-01')
    const missing = one.filter((p) => p.id === 'catalog.init.missing')
    expect(catalogProblemTitle(missing)).toBe(
      'CMAF track "a" gives no header in initRef or initData',
    )
    const two = parse(
      catalog('cmsf-01', [
        track({ name: 'a', packaging: 'cmaf' }),
        track({ name: 'b', packaging: 'cmaf' }),
      ]),
      'cmsf-01',
    ).filter((p) => p.id === 'catalog.init.missing')
    expect(catalogProblemTitle(two)).toBe('CMAF tracks give no header in initRef or initData')
  })
})

describe('placement', () => {
  it('checks only object 0 under MSF-00, and nothing for drafts that disagree', () => {
    expect(
      checkCatalogObjectPlacement(
        { groupId: 1, subgroupId: 3, objectId: 4, independent: true },
        'msf-00',
      ),
    ).toEqual([])
    expect(
      checkCatalogObjectPlacement(
        { groupId: 1, subgroupId: 0, objectId: 0, independent: false },
        'cmsf-00',
      ).map((p) => p.id),
    ).toEqual(['catalog.object.first-delta'])
    expect(
      checkCatalogObjectPlacement({ groupId: 1, subgroupId: 3, objectId: 0, independent: false }, [
        'msf-00',
        'msf-01',
      ]),
    ).toEqual([])
  })
})

describe('wording over groups', () => {
  it('words one field of the wrong type, and several', () => {
    const problems = parse(catalog('msf-01', [track({ width: '640', height: '360' })]), 'msf-01')
    expect(catalogProblemTitle(problems.slice(0, 1))).toBe(
      'Track "v" has width as a String, not a Number',
    )
    expect(catalogProblemRemedy(problems.slice(0, 1))).toBe('Write width as a Number')
    expect(catalogProblemTitle(problems)).toBe('Track "v" has fields of the wrong JSON type')
  })

  it('words missing fields across tracks', () => {
    const problems = parse(
      catalog('msf-01', [
        { name: 'a', packaging: 'loc' },
        { name: 'b', packaging: 'loc' },
      ]),
      'msf-01',
    )
    expect(catalogProblemTitle(problems)).toBe('Tracks have no isLive')
    expect(catalogProblemFound(problems)).toBe(
      'tracks[0] "a": isLive absent; tracks[1] "b": isLive absent',
    )
    expect(catalogProblemTracks(problems)).toEqual(['a', 'b'])
  })

  it('words the codec and bitrate of a video track', () => {
    const problems = parse(catalog('msf-01', [track({ role: 'video' })]), 'msf-01')
    expect(catalogProblemTitle(problems)).toBe('Video track "v" has no codec or bitrate')
    expect(catalogProblemRemedy(problems)).toBe(
      'Add codec (String) and bitrate (Number) to the track',
    )
  })
})
