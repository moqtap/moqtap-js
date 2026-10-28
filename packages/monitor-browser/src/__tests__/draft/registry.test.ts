/**
 * Draft resolution against the decoders an entry was built with, and the
 * adapters themselves against real wire bytes. Every refusal withholds the
 * adapter: two drafts read the same bytes as plausible wrong numbers.
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
import { describe, expect, it } from 'vitest'
import { SUPPORTED_DRAFTS } from '../../draft/protocol.js'
import { degradedReasonOf, draftSet, resolveDraft } from '../../draft/registry.js'
import { ALL_ADAPTERS } from '../../drafts/all.js'
import { adapter as draft14 } from '../../drafts/draft14/index.js'
import { type DraftAdapter, NEED, newCursor } from '../../types.js'

/** A real draft-20 control frame: type 0x10, uint16 length, payload. */
const GOAWAY = encodeMessage({
  type: 'goaway',
  new_session_uri: 'https://relay.example/',
  timeout: 5n,
})

const ALL = draftSet(ALL_ADAPTERS)

function adapterFor(protocol: string): DraftAdapter {
  const r = resolveDraft(ALL, protocol)
  if (!r.ok) throw new Error(`no adapter for ${protocol}`)
  return r.adapter
}

describe('resolveDraft', () => {
  it('resolves a negotiated protocol to an adapter that parses that draft', () => {
    const r = resolveDraft(ALL, 'moqt-20')
    expect(r.ok && r.draft).toBe(20)
    const adapter = adapterFor('moqt-20')
    expect(adapter.protocolString).toBe('moqt-20')
    const decoded = adapter.decodeControl(GOAWAY)
    expect(decoded.value?.type).toBe('goaway')
    expect(decoded.bytesRead).toBe(GOAWAY.byteLength)
  })

  it('resolves a pre-15 session by the version SETUP named', () => {
    const r = resolveDraft(ALL, '', 14)
    expect(r.ok && r.adapter).toBe(draft14)
  })

  it('refuses a protocol it does not recognise', () => {
    for (const p of ['', 'h3', 'moqt-14', 'moq-00', 'MOQT-20', 'moqt-20 ', 'moqt-2']) {
      expect(resolveDraft(ALL, p)).toEqual({ ok: false, reason: 'unsupported-protocol' })
    }
  })

  it('refuses a known draft the entry was not built with', () => {
    const only14 = draftSet([draft14])
    expect(resolveDraft(only14, 'moqt-20')).toEqual({ ok: false, reason: 'not-included' })
    expect(resolveDraft(only14, '', 13)).toEqual({ ok: false, reason: 'not-included' })
  })

  it('holds one adapter per supported draft in the root entry', () => {
    expect([...ALL.keys()].sort((a, b) => a - b)).toEqual(
      [...SUPPORTED_DRAFTS].sort((a, b) => a - b),
    )
  })
})

describe('the resolved adapter walks real draft-20 wire bytes', () => {
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

  const draft20Adapter = async () => adapterFor('moqt-20')

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

    const cursor = newCursor()
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

    const cursor = newCursor()
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
    const adapter = adapterFor('moqt-19')

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

    const cursor = newCursor()
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
    const adapter = adapterFor('moqt-19')
    const bytes = Uint8Array.of(0x05, 0x08, 0x82, 0x0c, 0x00, 0x00, 0x00)
    const header = must(adapter.readFetchHeader(bytes, 0), 'readFetchHeader')
    const cursor = newCursor()
    expect(adapter.readFetchObject(bytes, header.next, cursor)).toBe(NEED)
  })

  it('counts a malformed datagram as a failure instead of throwing', async () => {
    const adapter = await draft20Adapter()
    expect(adapter.decodeDatagram(Uint8Array.of(0x00))).toBeNull()
    expect(adapter.decodeControl(Uint8Array.of(0xfe)).value).toBeNull()
  })
})

describe('degradedReasonOf', () => {
  it('maps each refusal onto the value SetupRecord admits', () => {
    expect(degradedReasonOf('not-included')).toBe('draft-mismatch')
    expect(degradedReasonOf('unsupported-protocol')).toBe('unsupported-protocol')
  })
})
