/**
 * The load decision and the bundle budget.
 *
 *  1. A recognised protocol yields an adapter that actually parses that draft's
 *     wire format — checked against a frame `@moqtap/codec` encoded, so a chunk
 *     wired to the wrong draft's codec cannot pass.
 *  2. **Every failure withholds the adapter.** The refusal is the absence of
 *     the object, so the assertion is `adapter === undefined`, not a flag.
 *  3. **`DRAFT_LOADERS` still contains static literal specifiers.** The
 *     template-literal refactor — `import(`../drafts/draft${n}/index.js`)` —
 *     type-checks, passes every behavioural test in this file, and silently
 *     costs 39.6 KB gz against 5.3 KB. Only a source-shape assertion catches it.
 */

import { encodeFetchStream as encodeFetchStream19 } from '@moqtap/codec/draft19'
import type { FetchObjectPayload, ObjectPayload } from '@moqtap/codec/draft20'
import {
  decodeFetchStream,
  decodeSubgroupStream,
  encodeDatagram,
  encodeFetchStream,
  encodeMessage,
  encodeSubgroupStream,
} from '@moqtap/codec/draft20'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_IMPORT_TIMEOUT_MS,
  degradedReasonOf,
  loadDraft,
  preloadDrafts,
} from '../../draft/loader.js'
import { DRAFT_LOADERS } from '../../draft/loaders.js'
import { SUPPORTED_DRAFTS } from '../../draft/protocol.js'
import { NEED, type SupportedDraft } from '../../types.js'

/** A real draft-20 control frame: type 0x10, uint16 length, payload. */
const GOAWAY = encodeMessage({
  type: 'goaway',
  new_session_uri: 'https://relay.example/',
  timeout: 5n,
})

afterEach(() => {
  vi.doUnmock('../../drafts/draft19/index.js')
  vi.doUnmock('../../drafts/draft20/index.js')
})

// NOTE: no blanket `vi.resetModules()` here. Resetting the registry makes the
// NEXT dynamic import build a fresh module graph with a fresh `types.js` — and
// so a second `Symbol('need')`, against which every `=== NEED` in this file is
// silently false. The mocking tests below reset deliberately and take their
// loader instance from the same import, which keeps that graph self-consistent.

describe('loadDraft — a negotiated protocol', () => {
  it('loads draft-20 and hands back an adapter that parses draft-20', async () => {
    const r = await loadDraft('moqt-20')
    expect(r.ok).toBe(true)
    expect(r.reason).toBeUndefined()
    expect(r.draft).toBe(20)
    expect(r.adapter?.draft).toBe(20)
    expect(r.adapter?.protocolString).toBe('moqt-20')

    const decoded = r.adapter?.decodeControl(GOAWAY)
    expect(decoded?.value).not.toBeNull()
    expect(decoded?.value?.type).toBe('goaway')
    // The whole frame, so a framer can skip past it: type + uint16 + payload.
    expect(decoded?.bytesRead).toBe(GOAWAY.byteLength)
  })

  it('loads draft-19 and reports the protocol string its codec entry omits', async () => {
    const r = await loadDraft('moqt-19')
    expect(r.ok).toBe(true)
    expect(r.draft).toBe(19)
    // `@moqtap/codec/draft19` exports no PROTOCOL_STRING; the adapter supplies
    // it, and it must agree with what the loader matched on.
    expect(r.adapter?.protocolString).toBe('moqt-19')
  })

  it('returns the same adapter instance on a second load — one chunk, not two', async () => {
    const a = await loadDraft('moqt-20')
    const b = await loadDraft('moqt-20')
    expect(a.adapter).toBe(b.adapter)
  })
})

describe('loadDraft — refuses rather than guesses', () => {
  const nothingParseable = (r: Awaited<ReturnType<typeof loadDraft>>) => {
    expect(r.ok).toBe(false)
    expect(r.adapter).toBeUndefined()
    expect(r.draft).toBeUndefined()
  }

  it('refuses a protocol it does not recognise', async () => {
    for (const p of ['', 'h3', 'moqt-14', 'moq-00', 'MOQT-20', 'moqt-20 ', 'moqt-2']) {
      const r = await loadDraft(p)
      nothingParseable(r)
      expect(r.reason).toBe('unsupported-protocol')
    }
  })

  it('refuses an unrecognised protocol even when the pin names exactly one draft', async () => {
    // The pin is a statement about the customer's build, never evidence about
    // the session. Falling back to it here is guessing the draft, which is the
    // one thing a mismatch forbids.
    const r = await loadDraft('', { pin: [20] })
    nothingParseable(r)
    expect(r.reason).toBe('unsupported-protocol')
  })

  it('refuses when the pin and the negotiated protocol disagree', async () => {
    const r = await loadDraft('moqt-20', { pin: [19] })
    nothingParseable(r)
    expect(r.reason).toBe('pin-mismatch')
  })

  it('refuses when the pin names only drafts this package cannot parse', async () => {
    const r = await loadDraft('moqt-20', { pin: [14, 15] as unknown as readonly (19 | 20)[] })
    nothingParseable(r)
    expect(r.reason).toBe('pin-mismatch')
  })

  it('admits every supported draft when the pin is absent or empty', async () => {
    expect((await loadDraft('moqt-19')).ok).toBe(true)
    expect((await loadDraft('moqt-19', { pin: [] })).ok).toBe(true)
    expect((await loadDraft('moqt-19', { pin: [19, 20] })).ok).toBe(true)
  })

  it('reports every refusal through onDegraded', async () => {
    const seen: string[] = []
    const onDegraded = (reason: string) => {
      seen.push(reason)
    }
    await loadDraft('h3', { onDegraded })
    await loadDraft('moqt-20', { pin: [19], onDegraded })
    await loadDraft('moqt-20', { onDegraded })
    expect(seen).toEqual(['unsupported-protocol', 'pin-mismatch'])
  })

  it('survives an onDegraded that throws — a customer callback is not this package', async () => {
    const r = await loadDraft('h3', {
      onDegraded: () => {
        throw new Error('customer handler blew up')
      },
    })
    expect(r.reason).toBe('unsupported-protocol')
  })
})

describe('loadDraft — the await window', () => {
  it('resolves inside the microtask queue once the chunk is preloaded', async () => {
    // the hazard: an `await` between `session.protocol` and the first parse
    // loses the setup exchange unless the caller buffers. `preloadDrafts` is
    // what makes the window empty — if this resolves before the timer queue
    // runs, no further stream read can have been interleaved with it.
    await preloadDrafts([20])
    let macrotaskRan = false
    setTimeout(() => {
      macrotaskRan = true
    }, 0)
    const r = await loadDraft('moqt-20')
    expect(r.ok).toBe(true)
    expect(macrotaskRan).toBe(false)
  })

  it('preloads nothing without a pin, and never rejects', async () => {
    // Preloading both chunks unpinned would spend the 7.5x saving (~10.6 KB gz
    // against 5.3) to close a window the ring already covers; an unpinned build
    // fetches one chunk at session time and buffers across the await. A fresh
    // module instance keeps the chunk cache cold, so "did a fetch happen" is
    // observable: a real dynamic import crosses the timer queue, a no-op cannot.
    vi.resetModules()
    const cold = await import('../../draft/loader.js')

    let macrotaskRan = false
    setTimeout(() => {
      macrotaskRan = true
    }, 0)
    await expect(cold.preloadDrafts()).resolves.toBeUndefined()
    await expect(cold.preloadDrafts([])).resolves.toBeUndefined()
    // A pin naming a draft this package has no chunk for. `6` is real MoQT and
    // is below `@moqtap/codec`'s floor of 07, which makes it the honest case:
    // a customer pinning a draft that exists in the world and not in this build.
    await expect(cold.preloadDrafts([6 as unknown as SupportedDraft])).resolves.toBeUndefined()
    expect(macrotaskRan).toBe(false)

    // The same check with a pin does fetch, which is what makes the assertion
    // above mean something.
    await expect(cold.preloadDrafts([20])).resolves.toBeUndefined()
    expect(macrotaskRan).toBe(true)
  })

  it('gives up on an import that never resolves, and still withholds the adapter', async () => {
    vi.resetModules()
    vi.doMock('../../drafts/draft19/index.js', () => new Promise(() => undefined))
    const mod = await import('../../draft/loader.js')

    const started = Date.now()
    const r = await mod.loadDraft('moqt-19', { timeoutMs: 20 })
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('timeout')
    expect(r.adapter).toBeUndefined()
    expect(Date.now() - started).toBeLessThan(DEFAULT_IMPORT_TIMEOUT_MS)
  })

  it('degrades when the chunk cannot be fetched at all', async () => {
    vi.resetModules()
    vi.doMock('../../drafts/draft19/index.js', () => {
      // What a CSP refusal or a 404 mid-deploy looks like from here.
      throw new Error('failed to fetch dynamically imported module')
    })
    const mod = await import('../../draft/loader.js')

    const r = await mod.loadDraft('moqt-19')
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('import-failed')
    expect(r.adapter).toBeUndefined()
  })

  it('retries a failed chunk on the next session rather than caching the failure', async () => {
    vi.resetModules()
    let attempts = 0
    vi.doMock('../../drafts/draft19/index.js', async () => {
      attempts++
      throw new Error('offline')
    })
    const mod = await import('../../draft/loader.js')

    expect((await mod.loadDraft('moqt-19')).reason).toBe('import-failed')
    expect((await mod.loadDraft('moqt-19')).reason).toBe('import-failed')
    expect(attempts).toBe(2)
  })

  it('refuses a chunk whose adapter does not agree with the negotiated protocol', async () => {
    // `PROTOCOL_STRINGS` and the adapter's own field are two copies of one wire
    // constant; drift between them means a session parsed by the wrong draft's
    // adapter.
    vi.resetModules()
    vi.doMock('../../drafts/draft19/index.js', () => ({
      draft: 19,
      adapter: {
        draft: 19,
        protocolString: 'moqt-20',
        varint: { read: () => undefined },
        decodeControl: () => ({ value: null, bytesRead: 0 }),
        readSubgroupHeader: () => undefined,
      },
    }))
    const mod = await import('../../draft/loader.js')

    const r = await mod.loadDraft('moqt-19')
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('import-failed')
    expect(r.adapter).toBeUndefined()
  })
})

describe('DRAFT_LOADERS — the 7.5x file', () => {
  it('holds exactly the supported drafts, frozen', () => {
    expect(Object.isFrozen(DRAFT_LOADERS)).toBe(true)
    // The map and `SUPPORTED_DRAFTS` are two lists of the same thing, and a
    // draft in one but not the other is either a chunk nothing can load or a
    // pin that resolves to nothing.
    expect(
      Object.keys(DRAFT_LOADERS)
        .map(Number)
        .sort((a, b) => a - b),
    ).toEqual([...SUPPORTED_DRAFTS].sort((a, b) => a - b))
  })

  it('uses static literal specifiers, never a template literal', () => {
    // A template literal here type-checks, passes every other test in this file
    // and pulls all fourteen drafts: 39.6 KB gz against 5.3 KB. The source
    // shape is the only thing that distinguishes them.
    for (const [draft, load] of Object.entries(DRAFT_LOADERS)) {
      const source = load.toString()
      // Zero-padded on disk — `draft07`, matching `@moqtap/codec`'s subpaths —
      // while the map's own keys are the bare numbers.
      const nn = Number(draft) < 10 ? `0${draft}` : draft
      expect(source).toContain(`draft${nn}`)
      expect(source).not.toContain('${')
      expect(source).not.toContain('`')
    }
  })

  it('never names the codec root or /session entry', async () => {
    // Both statically import all fourteen drafts. Only `src/drafts/draftNN/`
    // may name a codec entry, and only a per-draft one; the build scans for the
    // violation, and this is the runtime half of the same check.
    for (const load of Object.values(DRAFT_LOADERS)) {
      const source = load.toString()
      expect(source).not.toMatch(/['"`]@moqtap\/codec(\/session)?['"`]/)
    }
  })
})

describe('the loaded adapter walks real draft-20 wire bytes', () => {
  const subgroupObject = (objectId: bigint, payload: Uint8Array): ObjectPayload => ({
    type: 'object',
    byteOffset: 0,
    payloadByteOffset: 0,
    objectId,
    payloadLength: payload.byteLength,
    extensionData: new Uint8Array(0),
    payload,
  })

  const fetchObject = (
    serializationFlags: number,
    groupId: bigint,
    objectId: bigint,
    payload: Uint8Array,
  ): FetchObjectPayload => ({
    ...subgroupObject(objectId, payload),
    serializationFlags,
    groupId,
    subgroupId: 0n,
    publisherPriority: 128,
  })

  const draft20Adapter = async () => {
    const r = await loadDraft('moqt-20')
    if (r.adapter === undefined) throw new Error('draft-20 adapter did not load')
    return r.adapter
  }

  function must<T>(v: T | typeof NEED, what: string): T {
    if (v === NEED) throw new Error(`${what} returned NEED on a complete buffer`)
    return v
  }

  it('walks a subgroup stream across a status object', async () => {
    // The reason the walk is hand-rolled at all: `createSubgroupStreamDecoder`
    // reads Object Payload Length and then the payload with no
    // `payloadLength === 0 -> readVarInt status` branch, so one status object
    // desynchronises it and every byte after it is garbage. The stream below has
    // one in the middle, and the assertion that matters is the last `next`:
    // the walk lands exactly on the end of the encoded stream.
    const adapter = await draft20Adapter()
    const withStatus = { ...subgroupObject(1n, new Uint8Array(0)), status: 1n }
    const stream = encodeSubgroupStream({
      type: 'subgroup',
      // Bit 4 set (required), SUBGROUP_ID_MODE 0b10 (explicit field), priority
      // present, no per-object properties.
      headerType: 0x14,
      trackAlias: 7n,
      groupId: 3n,
      subgroupId: 2n,
      publisherPriority: 128,
      objects: [
        subgroupObject(0n, Uint8Array.of(1, 2, 3)),
        withStatus,
        subgroupObject(5n, Uint8Array.of(9, 9)),
      ],
    })

    expect(adapter.sniff(stream[0] as number)).toBe('subgroup')

    const header = must(adapter.readSubgroupHeader(stream, 0), 'readSubgroupHeader')
    expect(header.trackAlias).toBe(7n)
    expect(header.groupId).toBe(3n)
    expect(header.propertiesPresent).toBe(false)

    const cursor = { first: true, prevObjectId: 0n, prevGroupId: 0n }
    const first = must(
      adapter.readSubgroupObject(stream, header.next, header, cursor),
      'readSubgroupObject',
    )
    expect(first.objectId).toBe(0n)
    expect(first.payloadLength).toBe(3)
    expect(first.status).toBeUndefined()

    const status = must(
      adapter.readSubgroupObject(stream, first.next, header, cursor),
      'readSubgroupObject',
    )
    expect(status.objectId).toBe(1n)
    expect(status.payloadLength).toBe(0)
    expect(status.status).toBe(1n)

    const last = must(
      adapter.readSubgroupObject(stream, status.next, header, cursor),
      'readSubgroupObject',
    )
    expect(last.objectId).toBe(5n)
    expect(last.payloadLength).toBe(2)
    // Nothing left over and nothing overshot: the status object did not shift
    // the stream by a single byte.
    expect(last.next).toBe(stream.byteLength)

    // And the codec's own one-shot decoder — which does have the status branch —
    // agrees about every id.
    const reference = decodeSubgroupStream(stream)
    expect(reference.ok).toBe(true)
    if (!reference.ok) return
    expect(reference.value.objects.map((o) => o.objectId)).toEqual([0n, 1n, 5n])
  })

  it('walks a fetch stream through an End-of-Range marker', async () => {
    const adapter = await draft20Adapter()
    const stream = encodeFetchStream({
      type: 'fetch',
      // Not necessarily a FETCH's id: a fill fetch stream carries the id of the
      // SUBSCRIBE or REQUEST_UPDATE that asked for the fill.
      requestId: 42n,
      objects: [
        // Group ID Delta + Object ID Delta present; the first object must carry
        // both.
        fetchObject(0x0c, 3n, 0n, Uint8Array.of(1, 2, 3, 4)),
        // Object ID Delta only: the group is the prior object's.
        fetchObject(0x04, 3n, 1n, Uint8Array.of(5, 6)),
        // 0x8C — Non-Existent. draft-20 applies the ordinary delta arithmetic to
        // its Group ID and carries an Object Payload Length of 0; draft-19 does
        // neither, which is what `WalkDialect` exists for.
        fetchObject(0x8c, 4n, 0n, new Uint8Array(0)),
      ],
    })

    expect(adapter.sniff(stream[0] as number)).toBe('fetch')

    const header = must(adapter.readFetchHeader(stream, 0), 'readFetchHeader')
    expect(header.requestId).toBe(42n)

    const cursor = { first: true, prevObjectId: 0n, prevGroupId: 0n }
    const a = must(adapter.readFetchObject(stream, header.next, cursor), 'readFetchObject')
    expect([a.groupId, a.objectId, a.payloadLength]).toEqual([3n, 0n, 4])

    const b = must(adapter.readFetchObject(stream, a.next, cursor), 'readFetchObject')
    expect([b.groupId, b.objectId, b.payloadLength]).toEqual([3n, 1n, 2])

    const marker = must(adapter.readFetchObject(stream, b.next, cursor), 'readFetchObject')
    expect([marker.groupId, marker.objectId, marker.payloadLength]).toEqual([4n, 0n, 0])
    expect(marker.next).toBe(stream.byteLength)

    const reference = decodeFetchStream(stream)
    expect(reference.ok).toBe(true)
    if (!reference.ok) return
    expect(reference.value.objects.map((o) => o.groupId)).toEqual([3n, 3n, 4n])
  })

  it('reduces a datagram to counts without keeping the payload view', async () => {
    const adapter = await draft20Adapter()
    const payload = Uint8Array.of(1, 2, 3, 4, 5)
    const datagram = encodeDatagram({
      type: 'datagram',
      datagramType: 0x00,
      trackAlias: 9n,
      groupId: 1n,
      objectId: 2n,
      publisherPriority: 100,
      payloadLength: payload.byteLength,
      payload,
    })

    const counts = adapter.decodeDatagram(datagram)
    expect(counts).not.toBeNull()
    expect(counts?.trackAlias).toBe(9n)
    expect(counts?.groupId).toBe(1n)
    expect(counts?.objectId).toBe(2n)
    expect(counts?.payloadBytes).toBe(5)
    expect(counts?.headerBytes).toBe(datagram.byteLength - 5)
    // Counts only — nothing on the returned object is a view onto the input.
    expect(Object.values(counts ?? {}).some((v) => v instanceof Uint8Array)).toBe(false)
  })

  it('walks a draft-19 fetch stream by draft-19 rules, not draft-20 rules', async () => {
    // Two of the three places the adapters differ: draft-19 writes a fetch
    // object's Object ID and an End-of-Range marker's Group ID as ABSOLUTE
    // values, where draft-20 applies its §11.4.4.1 delta arithmetic to both.
    // Reading one draft's stream by the other's rules yields ids that are wrong
    // and plausible — never an error.
    const r = await loadDraft('moqt-19')
    if (r.adapter === undefined) throw new Error('draft-19 adapter did not load')
    const adapter = r.adapter

    const stream = encodeFetchStream19({
      type: 'fetch',
      requestId: 8n,
      objects: [
        fetchObject(0x0c, 3n, 7n, Uint8Array.of(1, 2, 3, 4)),
        // Object ID only, written absolute by draft-19. Read by draft-20's
        // rules this would come out as 7 + 9 = 16.
        fetchObject(0x04, 3n, 9n, Uint8Array.of(5, 6)),
        // Marker Group ID, written absolute by draft-19. Read by draft-20's
        // rules this would come out as 3 + 9 + 1 = 13.
        fetchObject(0x8c, 9n, 0n, new Uint8Array(0)),
      ],
    })

    const header = must(adapter.readFetchHeader(stream, 0), 'readFetchHeader')
    expect(header.requestId).toBe(8n)

    const cursor = { first: true, prevObjectId: 0n, prevGroupId: 0n }
    const a = must(adapter.readFetchObject(stream, header.next, cursor), 'readFetchObject')
    expect([a.groupId, a.objectId, a.payloadLength]).toEqual([3n, 7n, 4])

    const b = must(adapter.readFetchObject(stream, a.next, cursor), 'readFetchObject')
    expect([b.groupId, b.objectId, b.payloadLength]).toEqual([3n, 9n, 2])

    const marker = must(adapter.readFetchObject(stream, b.next, cursor), 'readFetchObject')
    expect([marker.groupId, marker.objectId, marker.payloadLength]).toEqual([9n, 0n, 0])
    expect(marker.next).toBe(stream.byteLength)
  })

  it('rejects draft-20’s Timed-Out marker on a draft-19 stream', async () => {
    // 0x20C is new in draft-20 and takes over the FILL_TIMEOUT outcome. On a
    // draft-19 stream it is not a known flags value, so the walk must decline
    // rather than invent an object.
    const r = await loadDraft('moqt-19')
    if (r.adapter === undefined) throw new Error('draft-19 adapter did not load')
    const bytes = Uint8Array.of(0x05, 0x08, 0x82, 0x0c, 0x00, 0x00, 0x00)
    const header = must(r.adapter.readFetchHeader(bytes, 0), 'readFetchHeader')
    const cursor = { first: true, prevObjectId: 0n, prevGroupId: 0n }
    expect(r.adapter.readFetchObject(bytes, header.next, cursor)).toBe(NEED)
  })

  it('counts a malformed datagram as a failure instead of throwing', async () => {
    const adapter = await draft20Adapter()
    expect(adapter.decodeDatagram(Uint8Array.of(0x00))).toBeNull()
    expect(adapter.decodeControl(Uint8Array.of(0xfe)).value).toBeNull()
  })
})

describe('degradedReasonOf', () => {
  it('maps four load failures onto the three values SetupRecord admits', () => {
    expect(degradedReasonOf('pin-mismatch')).toBe('draft-mismatch')
    expect(degradedReasonOf('unsupported-protocol')).toBe('unsupported-protocol')
    expect(degradedReasonOf('import-failed')).toBe('import-failed')
    // `timeout` has no SetupRecord value of its own, so it folds onto
    // `import-failed`.
    expect(degradedReasonOf('timeout')).toBe('import-failed')
  })
})
