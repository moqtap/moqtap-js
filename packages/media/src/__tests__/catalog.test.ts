import { describe, expect, it } from 'vitest'
import {
  applyCatalogObject,
  type CatalogState,
  catalogTracks,
  createCatalogState,
  decodeBase64,
  isCatalogTrackName,
  type JsonObject,
  parseCatalog,
  redactCatalogText,
  redactJsonText,
} from '../catalog'

/** Parse and apply a sequence of payloads, failing on any refused object */
function follow(payloads: string[], state: CatalogState = createCatalogState()): CatalogState {
  for (const payload of payloads) {
    const update = applyCatalogObject(state, parseCatalog(payload))
    expect(update.applied).toBe(true)
    state = update.state
  }
  return state
}

const ftypBase64 = 'AAAAGGZ0eXBjbWYyAAAAAGNtZjJpc282'

describe('decodeBase64', () => {
  it('decodes RFC 4648 Base64 with and without padding', () => {
    expect([...decodeBase64('TWFu')!]).toEqual([0x4d, 0x61, 0x6e])
    expect([...decodeBase64('TWE=')!]).toEqual([0x4d, 0x61])
    expect([...decodeBase64('TQ==')!]).toEqual([0x4d])
    expect([...decodeBase64('')!]).toEqual([])
    expect([...decodeBase64('+/8=')!]).toEqual([0xfb, 0xff])
  })

  it('refuses what is not Base64', () => {
    expect(decodeBase64('TWF')).toBeNull() // not a multiple of 4
    expect(decodeBase64('TW=u')).toBeNull() // padding inside
    expect(decodeBase64('TQ==TWFu')).toBeNull()
    expect(decodeBase64('-_8=')).toBeNull() // base64url alphabet
    expect(decodeBase64('AAAAHGZ0eXBjbWYyAAAAAGNtZjJpc282bXA0MQ...')).toBeNull() // the drafts' elision
  })

  it('decodes the 24-byte ftyp the vectors use', () => {
    const bytes = decodeBase64(ftypBase64)!
    expect(bytes.length).toBe(24)
    expect(new TextDecoder().decode(bytes.subarray(4, 8))).toBe('ftyp')
  })
})

describe('isCatalogTrackName', () => {
  it('matches "catalog" exactly', () => {
    expect(isCatalogTrackName('catalog')).toBe(true)
    expect(isCatalogTrackName('Catalog')).toBe(false)
    expect(isCatalogTrackName('catalog ')).toBe(false)
  })
})

describe('parseCatalog', () => {
  it('reads the draft from the shape, leaving MSF or CMSF open when the shape does', () => {
    const drafts = (text: string) => {
      const parsed = parseCatalog(text)
      return parsed.kind === 'independent' || parsed.kind === 'delta'
        ? [parsed.draft, parsed.candidates]
        : null
    }
    expect(drafts('{"version": 1, "tracks": []}')).toEqual([null, ['msf-00', 'cmsf-00']])
    expect(drafts('{"version": "draft-01", "tracks": []}')).toEqual([null, ['msf-01', 'cmsf-01']])
    expect(drafts('{"version": 1, "tracks": [{"name": "v", "packaging": "cmaf"}]}')).toEqual([
      'cmsf-00',
      ['cmsf-00'],
    ])
    expect(drafts('{"version": "1", "contentProtections": [], "tracks": []}')).toEqual([
      'cmsf-01',
      ['cmsf-01'],
    ])
    expect(drafts('{"deltaUpdate": true, "removeTracks": [{"name": "v"}]}')).toEqual([
      null,
      ['msf-00', 'cmsf-00'],
    ])
    expect(drafts('{"deltaUpdate": [{"op": "remove", "tracks": [{"name": "v"}]}]}')).toEqual([
      null,
      ['msf-01', 'cmsf-01'],
    ])
    expect(drafts('{"tracks": []}')).toEqual([null, []])
  })

  it('reports an ambiguous draft and checks only the rules MSF and CMSF share', () => {
    const text = JSON.stringify({
      version: '1',
      tracks: [{ name: 'v', packaging: 'loc', isLive: true, maxGrpSapStartingType: 3 }],
    })
    expect(parseCatalog(text).problems).toEqual([
      {
        severity: 'warning',
        category: 'ambiguous_draft',
        path: '',
        section: 'CMSF-01 2',
        message: 'the catalog may be MSF-01 or CMSF-01; only the rules both share are checked',
      },
    ])
    expect(parseCatalog(text, { draft: 'msf-01' }).problems).toEqual([])
    expect(parseCatalog(text, { draft: 'cmsf-01' }).problems.map((p) => p.section)).toEqual([
      'CMSF-01 3.4, 3.5.2.1',
    ])
  })

  it('gives MSF-00 delta operations in document order', () => {
    const parsed = parseCatalog(
      '{"deltaUpdate": true, "removeTracks": [{"name": "a"}], "cloneTracks": [{"parentName": "b", "name": "c"}], "addTracks": [{"name": "d", "packaging": "loc", "isLive": true}]}',
    )
    expect(parsed.kind).toBe('delta')
    if (parsed.kind !== 'delta') return
    expect(parsed.operations.map((o) => o.op)).toEqual(['remove', 'clone', 'add'])
    expect(parsed.operations.map((o) => o.path)).toEqual([
      'removeTracks',
      'cloneTracks',
      'addTracks',
    ])
  })

  it('reports gzip as compressed without reading it', () => {
    const parsed = parseCatalog(new Uint8Array([0x1f, 0x8b, 0x08, 0x00]))
    expect(parsed).toEqual({ kind: 'compressed', draft: null, problems: [] })
  })

  it('never throws, whatever the payload', () => {
    for (const input of [
      '',
      'null',
      '[]',
      '42',
      '"catalog"',
      '{',
      '{"tracks": 5}',
      '{"version": {}}',
    ]) {
      const parsed = parseCatalog(input)
      expect(parsed.problems.some((p) => p.severity === 'error')).toBe(true)
    }
    expect(parseCatalog(new Uint8Array([0xff, 0xfe])).kind).toBe('invalid')
    const odd = parseCatalog(
      '{"version": "1", "tracks": [null, 3, {"name": 5}, {"name": "x", "namespace": []}], "initDataList": 4, "contentProtections": [7, {"drmSystem": 1}]}',
    )
    expect(odd.kind).toBe('independent')
  })

  it('cites the draft and section of each problem', () => {
    const parsed = parseCatalog(
      '{"version": "draft-01", "tracks": [{"name": "v", "isLive": true}]}',
      { draft: 'msf-01' },
    )
    expect(parsed.problems).toEqual([
      {
        severity: 'warning',
        category: 'missing_field',
        path: 'tracks[0].packaging',
        section: 'MSF-01 5.2.4',
        message: 'packaging is Required: Yes',
      },
    ])
  })

  it('reads any deltaUpdate in MSF-01 as a delta, false included', () => {
    // MSF-01 5.1.6: "If this field is present, the catalog represents a delta".
    const parsed = parseCatalog(
      '{"version": "1", "deltaUpdate": false, "tracks": [{"name": "v", "packaging": "loc", "isLive": true}]}',
      { draft: 'msf-01' },
    )
    expect(parsed.kind).toBe('delta')
    expect(parsed.problems.map((p) => [p.category, p.path, p.section])).toEqual([
      ['delta_not_allowed_field', 'tracks', 'MSF-01 5.3'],
      ['delta_not_allowed_field', 'version', 'MSF-01 5.3'],
      ['invalid_value', 'deltaUpdate', 'MSF-01 5.1.6'],
    ])
    // MSF-00 lets an independent catalog say false (5.1.2).
    const msf00 = parseCatalog(
      '{"version": 1, "deltaUpdate": false, "tracks": [{"name": "v", "packaging": "loc", "isLive": true}]}',
      { draft: 'msf-00' },
    )
    expect(msf00.kind).toBe('independent')
    expect(msf00.problems).toEqual([])
  })

  it('holds only roles audio and video to the MSF-01 audio and video fields', () => {
    const parsed = parseCatalog(
      JSON.stringify({
        version: '1',
        tracks: [
          { name: 'a', packaging: 'loc', isLive: true, role: 'audio' },
          { name: 'ad', packaging: 'loc', isLive: true, role: 'audiodescription' },
          { name: 'sl', packaging: 'loc', isLive: true, role: 'signlanguage' },
        ],
      }),
      { draft: 'msf-01' },
    )
    expect(parsed.problems.map((p) => [p.path, p.section])).toEqual([
      ['tracks[0].codec', 'MSF-01 5.2.18'],
      ['tracks[0].bitrate', 'MSF-01 5.2.22'],
      ['tracks[0].samplerate', 'MSF-01 5.2.28'],
      ['tracks[0].channelConfig', 'MSF-01 5.2.29'],
    ])
  })

  it('keys duplicate tracks by the catalog namespace when it is given', () => {
    const text =
      '{"version": "1", "tracks": [{"name": "v", "packaging": "loc", "isLive": true}, {"name": "v", "namespace": "live/a", "packaging": "loc", "isLive": true}]}'
    expect(parseCatalog(text, { draft: 'msf-01' }).problems).toEqual([])
    expect(
      parseCatalog(text, { draft: 'msf-01', catalogNamespace: 'live/a' }).problems.map(
        (p) => p.category,
      ),
    ).toEqual(['duplicate_track'])
  })
})

describe('applyCatalogObject', () => {
  const base = JSON.stringify({
    version: 'draft-01',
    tracks: [
      { name: 'video', packaging: 'loc', isLive: true, role: 'video', codec: 'av01', bitrate: 1 },
      { name: 'audio', packaging: 'loc', isLive: true },
    ],
  })

  it('refuses a delta whole when one operation fails, leaving the state as it was', () => {
    const state = follow([base])
    const update = applyCatalogObject(
      state,
      parseCatalog(
        '{"deltaUpdate": [{"op": "remove", "tracks": [{"name": "audio"}]}, {"op": "remove", "tracks": [{"name": "slides"}]}]}',
      ),
    )
    expect(update.applied).toBe(false)
    expect(update.state).toBe(state)
    expect(update.problems.map((p) => [p.category, p.path])).toEqual([
      ['unknown_track', 'deltaUpdate[1].tracks[0]'],
    ])
    expect(catalogTracks(state.document).map((t) => t.name)).toEqual(['video', 'audio'])
  })

  it('does not change the state it is given', () => {
    const state = follow([base])
    const before = JSON.stringify(state)
    follow(
      ['{"deltaUpdate": [{"op": "clone", "tracks": [{"parentName": "video", "name": "v2"}]}]}'],
      state,
    )
    expect(JSON.stringify(state)).toBe(before)
  })

  it('resolves tracks without a namespace to the catalog track namespace', () => {
    const state = follow(
      [
        '{"version": "1", "tracks": [{"name": "v", "namespace": "live/a", "packaging": "loc", "isLive": true}]}',
        '{"deltaUpdate": [{"op": "remove", "tracks": [{"name": "v"}]}]}',
      ],
      createCatalogState({ catalogNamespace: 'live/a' }),
    )
    expect(state.document?.tracks).toEqual([])
  })

  it("leaves the catalog's root fields as they were whatever a delta carries", () => {
    const initDataList = [{ id: 'i1', type: 'inline', data: ftypBase64 }]
    const state = follow([
      JSON.stringify({
        version: '1',
        generatedAt: 1,
        tracks: [{ name: 'a', packaging: 'loc', isLive: true, initRef: 'i1' }],
        initDataList,
      }),
    ])
    const update = applyCatalogObject(
      state,
      parseCatalog(
        JSON.stringify({
          deltaUpdate: [
            { op: 'add', tracks: [{ name: 'b', packaging: 'loc', isLive: true, initRef: 'i2' }] },
          ],
          generatedAt: 2,
          initDataList: [{ id: 'i2', type: 'inline', data: 'TWFu' }],
        }),
      ),
    )
    expect(update.applied).toBe(true)
    expect(update.problems.map((p) => [p.category, p.path])).toEqual([
      ['unknown_reference', 'deltaUpdate[0].tracks[0].initRef'],
    ])
    expect(update.state.document?.generatedAt).toBe(1)
    expect(update.state.document?.initDataList).toEqual(initDataList)
    expect(catalogTracks(update.state.document).map((t) => [t.name, t.initData?.length])).toEqual([
      ['a', 24],
      ['b', undefined],
    ])
  })

  it('refuses a remove or clone naming a track the catalog declares twice', () => {
    const state = follow([
      JSON.stringify({
        version: '1',
        tracks: [
          { name: 'v', packaging: 'loc', isLive: true },
          { name: 'v', packaging: 'loc', isLive: true, label: 'again' },
        ],
      }),
    ])
    for (const delta of [
      '{"deltaUpdate": [{"op": "remove", "tracks": [{"name": "v"}]}]}',
      '{"deltaUpdate": [{"op": "clone", "tracks": [{"parentName": "v", "name": "w"}]}]}',
    ]) {
      const update = applyCatalogObject(state, parseCatalog(delta))
      expect(update.applied).toBe(false)
      expect(update.problems.map((p) => [p.category, p.path, p.section])).toEqual([
        ['duplicate_track', 'deltaUpdate[0].tracks[0]', 'MSF-01 5.2.3'],
      ])
    }
  })

  it('settles an ambiguous catalog by a delta whose shape is CMSF', () => {
    const state = follow([
      '{"version": "1", "tracks": [{"name": "a", "packaging": "loc", "isLive": true}]}',
    ])
    expect([state.draft, state.candidates]).toEqual([null, ['msf-01', 'cmsf-01']])
    const next = follow(
      [
        JSON.stringify({
          deltaUpdate: [{ op: 'remove', tracks: [{ name: 'a' }] }],
          contentProtections: [],
        }),
      ],
      state,
    )
    expect([next.draft, next.candidates]).toEqual(['cmsf-01', ['cmsf-01']])
  })

  it('applies a CMSF catalog delta by CMSF rules even when the delta looks like MSF', () => {
    const state = follow([
      JSON.stringify({
        version: '1',
        tracks: [{ name: 'v', packaging: 'cmaf', isLive: true, initRef: 'i' }],
        initDataList: [{ id: 'i', type: 'inline', data: ftypBase64 }],
      }),
    ])
    expect(state.draft).toBe('cmsf-01')
    const update = applyCatalogObject(
      state,
      parseCatalog(
        '{"deltaUpdate": [{"op": "clone", "tracks": [{"parentName": "v", "name": "w", "initRef": "nope"}]}]}',
      ),
    )
    expect(update.applied).toBe(true)
    expect(update.problems.map((p) => [p.category, p.path])).toEqual([
      ['unknown_reference', 'deltaUpdate[0].tracks[0].initRef'],
    ])
  })

  it('checks the tracks a delta adds to a CMSF catalog by CMSF rules', () => {
    const state = follow([
      JSON.stringify({
        version: 1,
        tracks: [{ name: 'v', packaging: 'cmaf', isLive: true, initData: ftypBase64 }],
      }),
    ])
    expect(state.draft).toBe('cmsf-00')
    const parsed = parseCatalog(
      JSON.stringify({
        deltaUpdate: true,
        addTracks: [
          {
            name: 'sap',
            packaging: 'loc',
            isLive: true,
            eventType: 'org.ietf.moq.cmsf.sap',
            maxGrpSapStartingType: 3,
          },
        ],
      }),
    )
    // By its shape alone the delta may be MSF-00, which knows no CMSF rule.
    expect(parsed.draft).toBeNull()
    expect(parsed.problems.map((p) => p.section)).toEqual(['CMSF-00 2', 'MSF-00 5.1.13'])
    const update = applyCatalogObject(state, parsed)
    expect(update.applied).toBe(true)
    // The MSF-00 problem is not reported again.
    expect(update.problems.map((p) => [p.path, p.section])).toEqual([
      ['addTracks[0].maxGrpSapStartingType', 'CMSF-00 3.4, 3.5.2.1'],
      ['addTracks[0].packaging', 'CMSF-00 3.6.1'],
    ])
  })

  it('holds isLive true after false to MSF-01 only', () => {
    const live = (version: string, isLive: boolean) =>
      `{"version": ${version}, "tracks": [{"name": "v", "packaging": "loc", "isLive": ${isLive}}]}`
    // MSF-00 5.1.15 has no "MUST never follow" sentence.
    const msf00 = follow([live('1', false)])
    expect(applyCatalogObject(msf00, parseCatalog(live('1', true))).problems).toEqual([])
    const msf01 = follow([live('"1"', false)])
    expect(
      applyCatalogObject(msf01, parseCatalog(live('"1"', true))).problems.map((p) => [
        p.category,
        p.path,
        p.section,
      ]),
    ).toEqual([['illegal_update', 'tracks[0].isLive', 'MSF-01 5.2.7']])
  })

  it('refuses a delta of the other draft against the catalog in force', () => {
    const state = follow([base])
    const update = applyCatalogObject(
      state,
      parseCatalog('{"deltaUpdate": true, "removeTracks": [{"name": "audio"}]}'),
    )
    expect(update.applied).toBe(false)
    expect(update.problems.map((p) => p.category)).toEqual(['invalid_value'])
  })

  it('reports nothing for compressed or invalid objects and keeps the state', () => {
    const state = follow([base])
    for (const parsed of [parseCatalog(new Uint8Array([0x1f, 0x8b])), parseCatalog('{')]) {
      expect(applyCatalogObject(state, parsed)).toEqual({ state, applied: false, problems: [] })
    }
  })
})

describe('catalogTracks', () => {
  it('normalises MSF-01 / CMSF-01 tracks, resolving initRef and content protection', () => {
    const doc = parseCatalog(
      JSON.stringify({
        version: '1',
        contentProtections: [
          {
            refID: 'ck',
            defaultKID: ['01234567-89ab-cdef-0123-456789abcdef'],
            scheme: 'cbcs',
            drmSystem: { systemID: '1077efec-c0b2-4d02-ace3-3c1e52e2fb4b' },
          },
        ],
        tracks: [
          {
            name: 'video',
            packaging: 'cmaf',
            isLive: true,
            role: 'video',
            codec: 'avc1.640028',
            width: 1920,
            height: '1080',
            bitrate: 5000000,
            initRef: 'init-video',
            contentProtectionRefIDs: ['ck', 'missing'],
            vendorField: { kept: true },
          },
        ],
        initDataList: [{ id: 'init-video', type: 'inline', data: ftypBase64 }],
      }),
    )
    expect(doc.kind).toBe('independent')
    if (doc.kind !== 'independent') return
    const [video] = catalogTracks(doc.document, { catalogNamespace: 'live/a' })
    expect(video).toMatchObject({
      namespace: 'live/a',
      name: 'video',
      packaging: 'cmaf',
      role: 'video',
      codec: 'avc1.640028',
      width: 1920,
      height: null, // a String where the draft says Number
      bitrate: 5000000,
      initRef: 'init-video',
      isLive: true,
      depends: [],
    })
    expect(video!.initData).toEqual(decodeBase64(ftypBase64))
    expect(video!.contentProtections.map((c) => c.refID)).toEqual(['ck'])
    expect(video!.raw.vendorField).toEqual({ kept: true })
  })

  it('resolves an initDataList id or contentProtections refID given twice to nothing', () => {
    const parsed = parseCatalog(
      JSON.stringify({
        version: '1',
        contentProtections: [
          { refID: 'ck', scheme: 'cbcs' },
          { refID: 'ck', scheme: 'cenc' },
        ],
        tracks: [
          {
            name: 'v',
            packaging: 'loc',
            isLive: true,
            initRef: 'i',
            contentProtectionRefIDs: ['ck'],
          },
        ],
        initDataList: [
          { id: 'i', type: 'inline', data: ftypBase64 },
          { id: 'i', type: 'inline', data: 'TWFu' },
        ],
      }),
    )
    expect(parsed.problems.filter((p) => p.category === 'duplicate_id').map((p) => p.path)).toEqual(
      [
        'initDataList[1].id',
        'contentProtections[1].refID',
        'tracks[0].initRef',
        'tracks[0].contentProtectionRefIDs[0]',
      ],
    )
    if (parsed.kind !== 'independent') return
    const [video] = catalogTracks(parsed.document)
    expect(video!.initData).toBeNull()
    expect(video!.contentProtections).toEqual([])
  })

  it("reads CMSF-00's track initData and the examples' mimetype spelling", () => {
    const doc: JsonObject = {
      version: 1,
      tracks: [
        { name: 'v', packaging: 'cmaf', initData: ftypBase64 },
        { name: 'h', packaging: 'mediatimeline', mimetype: 'application/json', depends: ['v', 3] },
        { name: 'e', packaging: 'eventtimeline', mimeType: 'text/plain', mimetype: 'x/y' },
        { name: 'bad', initData: 'AAAA...' },
        { packaging: 'loc' },
      ],
    }
    const tracks = catalogTracks(doc)
    expect(tracks.map((t) => t.name)).toEqual(['v', 'h', 'e', 'bad'])
    expect(tracks[0]!.initData?.length).toBe(24)
    expect(tracks[1]!.mimeType).toBe('application/json')
    expect(tracks[1]!.depends).toEqual(['v'])
    expect(tracks[2]!.mimeType).toBe('text/plain')
    expect(tracks[3]!.initData).toBeNull()
    expect(tracks[0]!.namespace).toBeNull()
  })

  it('reads publishTracks on request', () => {
    const doc: JsonObject = {
      version: '1',
      tracks: [],
      publishTracks: [{ name: 'logs', packaging: 'moqlog', role: 'log' }],
    }
    expect(catalogTracks(doc)).toEqual([])
    expect(catalogTracks(doc, { publish: true }).map((t) => t.name)).toEqual(['logs'])
  })
})

describe('redactCatalogText', () => {
  it('always replaces trackBaseKey, keeping the rest of the text byte for byte', () => {
    const text =
      '{ "version":"1",\n  "tracks":[{"name":"v","keyId":"k1","trackBaseKey":"c2VjcmV0","x":1.50,"y":1e3}],"2":0,"1":0 }'
    const expected =
      '{ "version":"1",\n  "tracks":[{"name":"v","keyId":"k1","trackBaseKey":"[redacted]","x":1.50,"y":1e3}],"2":0,"1":0 }'
    expect(redactCatalogText(text)).toBe(expected)
    expect(redactCatalogText(text, { credentials: false })).toBe(expected)
  })

  it('replaces token and the authInfo values, keeping the scheme names', () => {
    const text = JSON.stringify({
      version: '1',
      tracks: [
        {
          name: 'v',
          token: 'abc',
          authInfo: { cat: 'Zm9v', 'privacy-pass': { issuer: 'https://i.example' } },
        },
      ],
      publishTracks: [{ name: 'logs', token: { nested: 'xyz' } }],
    })
    const out = JSON.parse(redactCatalogText(text)!)
    expect(out.tracks[0].token).toBe('[redacted]')
    expect(out.tracks[0].authInfo).toEqual({ cat: '[redacted]', 'privacy-pass': '[redacted]' })
    expect(out.publishTracks[0].token).toBe('[redacted]')
    // credentials off: only the content key goes
    expect(redactCatalogText(text, { credentials: false })).toBe(text)
  })

  it('strips userinfo, query and fragment from connection and DRM URLs', () => {
    const text = JSON.stringify({
      version: '1',
      contentProtections: [
        {
          refID: '1',
          defaultKID: ['01234567-89ab-cdef-0123-456789abcdef'],
          scheme: 'cbcs',
          drmSystem: {
            systemID: 'edef8ba9-79d6-4ace-a3c8-27dcd51d21ed',
            laURL: { url: 'https://lic.example.com/proxy?session=s3cr3t#t=1', type: 'EME-1.0' },
            certURL: { url: 'https://user:pw@cert.example.com/c' },
            authzURL: { url: 'https://auth.example.com/a?code=1' },
            pssh: 'AAAAP3Bzc2g=',
          },
        },
      ],
      tracks: [
        {
          name: 'logs',
          connectionUri: 'moqt://logs.example.com:4443/ingest?key=1',
          initRef: 'i',
        },
      ],
      initDataList: [{ id: 'i', type: 'inline', data: ftypBase64 }],
    })
    const out = JSON.parse(redactCatalogText(text)!)
    const drm = out.contentProtections[0].drmSystem
    expect(drm.laURL).toEqual({
      url: 'https://lic.example.com/proxy?[redacted]#[redacted]',
      type: 'EME-1.0',
    })
    expect(drm.certURL.url).toBe('https://[redacted]@cert.example.com/c')
    expect(drm.authzURL).toEqual({ url: 'https://auth.example.com/a?code=1' })
    expect(drm.systemID).toBe('edef8ba9-79d6-4ace-a3c8-27dcd51d21ed')
    expect(drm.pssh).toBe('AAAAP3Bzc2g=')
    expect(out.contentProtections[0].defaultKID).toEqual(['01234567-89ab-cdef-0123-456789abcdef'])
    expect(out.tracks[0].connectionUri).toBe('moqt://logs.example.com:4443/ingest?[redacted]')
    expect(out.initDataList).toEqual([{ id: 'i', type: 'inline', data: ftypBase64 }])
  })

  it('redacts inside delta operations of both drafts', () => {
    const msf01 = redactCatalogText(
      '{"deltaUpdate": [{"op": "add", "tracks": [{"name": "s", "trackBaseKey": "k", "token": "t"}]}]}',
    )
    expect(msf01).toBe(
      '{"deltaUpdate": [{"op": "add", "tracks": [{"name": "s", "trackBaseKey": "[redacted]", "token": "[redacted]"}]}]}',
    )
    const msf00 = redactCatalogText(
      '{"deltaUpdate":true,"cloneTracks":[{"parentName":"a","name":"b","token":"t"}]}',
    )
    expect(msf00).toBe(
      '{"deltaUpdate":true,"cloneTracks":[{"parentName":"a","name":"b","token":"[redacted]"}]}',
    )
  })

  it('matches member names however they are escaped', () => {
    const out = redactCatalogText('{"tracks": [{"name": "v", "tok\\u0065n": "abc"}]}')
    expect(JSON.parse(out!).tracks[0].token).toBe('[redacted]')
  })

  it('leaves a catalog that still parses and resolves', () => {
    const text = JSON.stringify({
      version: '1',
      tracks: [
        {
          name: 'v',
          packaging: 'loc',
          isLive: true,
          encryptionScheme: 'moq-secure-objects',
          cipherSuite: 'aes-128-gcm-sha256',
          keyId: 'k',
          trackBaseKey: 'c2VjcmV0',
        },
      ],
    })
    const parsed = parseCatalog(redactCatalogText(text)!)
    expect(parsed.kind).toBe('independent')
    expect(parsed.problems.filter((p) => p.severity === 'error')).toEqual([])
  })

  it('returns null for what it cannot read as a catalog', () => {
    expect(redactCatalogText(new Uint8Array([0x1f, 0x8b, 0x08]))).toBeNull()
    expect(redactCatalogText(new Uint8Array([0x7b, 0xff, 0x7d]))).toBeNull()
    expect(redactCatalogText('{"tracks": [}')).toBeNull()
    expect(redactCatalogText('[{"token": "x"}]')).toBeNull()
    expect(redactCatalogText('{"token": "x"}')).toBeNull()
  })

  it('accepts the payload as bytes', () => {
    const bytes = new TextEncoder().encode('{"tracks": [{"name": "v", "token": "t"}]}')
    expect(redactCatalogText(bytes)).toBe('{"tracks": [{"name": "v", "token": "[redacted]"}]}')
  })
})

describe('redactJsonText', () => {
  /** `out` parses and is `text` with only the given values changed, each to its pair */
  function differsOnlyAt(text: string, out: string, changed: [string, string][]): void {
    expect(() => JSON.parse(out)).not.toThrow()
    let expected = text
    for (const [from, to] of changed) expected = expected.split(from).join(to)
    expect(out).toBe(expected)
  }

  it('redacts a catalog whose tracks are an object, not an array', () => {
    const text =
      '{"version": "1", "tracks": {"v": {"name": "v", "token": "t1", "trackBaseKey": "k1"}}}'
    expect(redactCatalogText(text)).toBeNull()
    differsOnlyAt(text, redactJsonText(text)!, [
      ['"t1"', '"[redacted]"'],
      ['"k1"', '"[redacted]"'],
    ])
  })

  it('redacts a catalog nested under another key, and inside arrays of objects', () => {
    const text = JSON.stringify(
      {
        meta: { catalog: { version: '1', tracks: [{ name: 'v', token: 'tA' }] } },
        list: [
          { authInfo: { cat: 'cA' } },
          [{ connectionUri: 'moqt://h.example/p?key=1' }],
          { drmSystem: { laURL: { url: 'https://l.example/x?s=1' } } },
        ],
        n: 1.5,
      },
      null,
      2,
    )
    const out = redactJsonText(text)!
    const json = JSON.parse(out)
    expect(json.meta.catalog.tracks[0].token).toBe('[redacted]')
    expect(json.list[0].authInfo).toEqual({ cat: '[redacted]' })
    expect(json.list[1][0].connectionUri).toBe('moqt://h.example/p?[redacted]')
    expect(json.list[2].drmSystem.laURL.url).toBe('https://l.example/x?[redacted]')
    differsOnlyAt(text, out, [
      ['"tA"', '"[redacted]"'],
      ['"cA"', '"[redacted]"'],
      ['?key=1', '?[redacted]'],
      ['?s=1', '?[redacted]'],
    ])
  })

  it('replaces a value whole when it holds other redacted values', () => {
    expect(redactJsonText('{"trackBaseKey":{"token":"x","connectionUri":"h://u@h"},"z":2}')).toBe(
      '{"trackBaseKey":"[redacted]","z":2}',
    )
  })

  it('redacts at the root of an array, of a lone object, or of a scalar', () => {
    expect(redactJsonText('[{"token": "x"}, 2, "token"]')).toBe(
      '[{"token": "[redacted]"}, 2, "token"]',
    )
    expect(redactJsonText('{"token": "x"}')).toBe('{"token": "[redacted]"}')
    expect(redactJsonText('{"authInfo": "x"}')).toBe('{"authInfo": "[redacted]"}')
    expect(redactJsonText(' "token" ')).toBe(' "token" ')
    expect(redactJsonText('1e3')).toBe('1e3')
  })

  it('replaces a connectionUri that is an object, and keeps DRM members CMSF-01 does not name', () => {
    const uri = redactJsonText(
      '{"tracks":[],"connectionUri":{"href":"https://u:SECRETPW@h/p?tok=SECRETQ"}}',
    )!
    expect(JSON.parse(uri).connectionUri).toBe('[redacted]')
    const drm = redactJsonText(
      '{"tracks":[],"contentProtections":[{"drmSystem":{"laURL":{"href":"https://h?SECRETQ","type":"EME-1.0"}}}]}',
    )!
    expect(JSON.parse(drm).contentProtections[0].drmSystem.laURL).toEqual({
      href: 'https://h?SECRETQ',
      type: 'EME-1.0',
    })
    const notObjects = redactJsonText(
      '{"drmSystem":{"laURL":"https://h/l","certURL":{"url":7},"vendor":{"token":"t"}}}',
    )!
    expect(JSON.parse(notObjects)).toEqual({
      drmSystem: {
        laURL: '[redacted]',
        certURL: { url: '[redacted]' },
        vendor: { token: '[redacted]' },
      },
    })
    // With credentials off, both stay.
    const kept = '{"connectionUri":{"href":"https://u:pw@h/?q"}}'
    expect(redactJsonText(kept, { credentials: false })).toBe(kept)
  })

  it('strips userinfo from URLs a URL parser reads loosely', () => {
    for (const url of [
      'https:\\\\u:SECRETPW@h/p',
      'https:u:SECRETPW@h/p',
      ' https://u:SECRETPW@h/p',
      'ht\ttps://u:SECRETPW@h/p',
    ]) {
      expect(new URL(url).password).toBe('SECRETPW')
      const out = JSON.parse(redactJsonText(JSON.stringify({ connectionUri: url }))!)
      expect(out.connectionUri).not.toContain('SECRETPW')
      expect(out.connectionUri).toContain('[redacted]@h')
    }
    // Nothing to remove: the spelling stays, spaces and all.
    expect(redactJsonText('{"connectionUri":" https://h/p "}')).toBe(
      '{"connectionUri":" https://h/p "}',
    )
  })

  it('redacts JSON nested deeper than the call stack goes', () => {
    const depth = 100000
    const text = `${'{"a":'.repeat(depth)}{"trackBaseKey":"SECRETKEY"}${'}'.repeat(depth)}`
    expect(() => JSON.parse(text)).not.toThrow()
    const out = redactJsonText(text)!
    expect(out).not.toContain('SECRETKEY')
    expect(out.length).toBe(text.length - 'SECRETKEY'.length + '[redacted]'.length)
    const arrays = `${'['.repeat(depth)}{"token":"T"}${']'.repeat(depth)}`
    expect(redactJsonText(arrays)).not.toContain('"T"')
  })

  it('matches escaped member names and redacts every duplicate', () => {
    const text = '{"a": {"tok\u0065n": "x", "token": "y", "token": "z"}, "b": 1.50}'
    expect(redactJsonText(text)).toBe(
      '{"a": {"tok\u0065n": "[redacted]", "token": "[redacted]", "token": "[redacted]"}, "b": 1.50}',
    )
  })

  it('keeps credentials with credentials off, but never trackBaseKey', () => {
    const text = '{"x": [{"token": "t", "trackBaseKey": "k", "authInfo": {"cat": "c"}}]}'
    expect(redactJsonText(text, { credentials: false })).toBe(
      '{"x": [{"token": "t", "trackBaseKey": "[redacted]", "authInfo": {"cat": "c"}}]}',
    )
    expect(redactJsonText('{"x": 1}', { credentials: false })).toBe('{"x": 1}')
  })

  it('gives the same text as redactCatalogText for a catalog', () => {
    const text =
      '{ "version":"1",\n  "tracks":[{"name":"v","token":"t","trackBaseKey":"k","x":1.50}] }'
    expect(redactJsonText(text)).toBe(redactCatalogText(text))
    expect(redactJsonText(text, { credentials: false })).toBe(
      redactCatalogText(text, { credentials: false }),
    )
  })

  it('returns null for what is not UTF-8 JSON, and accepts bytes', () => {
    expect(redactJsonText(new Uint8Array([0x1f, 0x8b, 0x08]))).toBeNull()
    expect(redactJsonText(new Uint8Array([0x7b, 0xff, 0x7d]))).toBeNull()
    expect(redactJsonText('{"tracks": [}')).toBeNull()
    expect(redactJsonText('')).toBeNull()
    const bytes = new TextEncoder().encode('{"a": {"token": "t"}}')
    expect(redactJsonText(bytes)).toBe('{"a": {"token": "[redacted]"}}')
  })
})
