/**
 * Tests for the draft-agnostic accessors.
 *
 * Every case runs against real codec output — a shared test vector decoded by
 * that draft's own codec — rather than a hand-written object. The whole point
 * of these accessors is that they cover the field spellings the drafts
 * actually use, so a fixture written from the same beliefs as the accessor
 * would prove nothing. Each test also asserts it exercised more than one
 * draft, since a filter that silently matched nothing would pass vacuously.
 */

import { describe, expect, it } from 'vitest'
import { joiningRequestIdOf, requestIdOf, trackAliasOf, trackOf } from '../core/accessors.js'
import type { Draft } from '../core/types.js'
import { createCodec } from '../index.js'
import { hexToBytes, loadVectorDir } from './helpers.js'

const ALL_DRAFTS: Draft[] = [
  '07',
  '08',
  '09',
  '10',
  '11',
  '12',
  '13',
  '14',
  '15',
  '16',
  '17',
  '18',
  '19',
]

interface Decoded {
  draft: Draft
  vectorId: string
  msg: Record<string, unknown>
  expected: Record<string, unknown>
}

/**
 * Decode every non-error vector in one message file, for one draft, with that
 * draft's codec. Drafts that do not define the message are skipped by their
 * vector directory simply not having the file.
 */
function decodeVectors(draft: Draft, file: string): Decoded[] {
  const entries = loadVectorDir(`transport/draft${draft}/codec/messages`).filter(
    (e) => e.file === file,
  )
  const out: Decoded[] = []
  for (const entry of entries) {
    for (const vector of entry.data.vectors) {
      if (vector.error || !vector.decoded) continue
      const codec = createCodec({ draft })
      const result = codec.decodeMessage(hexToBytes(vector.hex))
      if (!result.ok) continue
      out.push({
        draft,
        vectorId: vector.id,
        msg: result.value as unknown as Record<string, unknown>,
        expected: vector.decoded,
      })
    }
  }
  return out
}

function acrossDrafts(file: string, keep: (d: Decoded) => boolean = () => true): Decoded[] {
  return ALL_DRAFTS.flatMap((draft) => decodeVectors(draft, file)).filter(keep)
}

/** Whatever the vector calls the request id — the name changed at draft-11. */
function expectedRequestId(expected: Record<string, unknown>): string | undefined {
  const value = expected.request_id ?? expected.subscribe_id
  return value != null ? String(value) : undefined
}

describe('requestIdOf', () => {
  it('reads the request id from SUBSCRIBE in every draft', () => {
    // subscribe_id through draft-10, request_id from draft-11.
    const cases = acrossDrafts('subscribe.json')
    expect(new Set(cases.map((c) => c.draft)).size).toBe(ALL_DRAFTS.length)

    for (const { draft, vectorId, msg, expected } of cases) {
      const want = expectedRequestId(expected)
      expect(String(requestIdOf(msg)), `draft-${draft} ${vectorId}`).toBe(want)
    }
  })

  it('is undefined for a draft-17+ response, which carries no id', () => {
    // Those responses are matched to their request by the stream they arrive
    // on, so there is nothing here to read.
    const idless = acrossDrafts('subscribe-ok.json').filter(
      (c) => expectedRequestId(c.expected) == null,
    )
    expect(idless.length).toBeGreaterThan(0)

    for (const { draft, msg } of idless) {
      expect(requestIdOf(msg), `draft-${draft}`).toBeUndefined()
    }
  })
})

describe('trackAliasOf', () => {
  it('finds the alias wherever the draft puts it', () => {
    // SUBSCRIBE carries it through draft-11; from draft-12 the publisher
    // assigns it and it arrives in SUBSCRIBE_OK instead.
    const cases = [...acrossDrafts('subscribe.json'), ...acrossDrafts('subscribe-ok.json')]
    const carrying = cases.filter((c) => c.expected.track_alias != null)
    expect(new Set(carrying.map((c) => c.draft)).size).toBe(ALL_DRAFTS.length)

    for (const { draft, vectorId, msg, expected } of carrying) {
      expect(String(trackAliasOf(msg)), `draft-${draft} ${vectorId}`).toBe(
        String(expected.track_alias),
      )
    }
  })

  it('is undefined before the draft has assigned one', () => {
    // A draft-14 SUBSCRIBE has no alias yet — the publisher answers with it.
    const pending = acrossDrafts('subscribe.json').filter((c) => c.expected.track_alias == null)
    expect(pending.length).toBeGreaterThan(0)

    for (const { draft, msg } of pending) {
      expect(trackAliasOf(msg), `draft-${draft}`).toBeUndefined()
    }
  })
})

describe('trackOf', () => {
  it('reads the track named by SUBSCRIBE in every draft', () => {
    const cases = acrossDrafts('subscribe.json')
    expect(new Set(cases.map((c) => c.draft)).size).toBe(ALL_DRAFTS.length)

    for (const { draft, vectorId, msg, expected } of cases) {
      expect(trackOf(msg), `draft-${draft} ${vectorId}`).toEqual({
        namespace: expected.track_namespace,
        name: expected.track_name,
      })
    }
  })

  it('reaches into a standalone FETCH, nested or flat', () => {
    // Nested under `standalone` from draft-08; flat in draft-07, which has no
    // joining fetch to distinguish it from.
    const standalone = acrossDrafts('fetch.json', (c) => c.expected.track_name != null)
    expect(new Set(standalone.map((c) => c.draft)).size).toBe(ALL_DRAFTS.length)

    for (const { draft, vectorId, msg, expected } of standalone) {
      expect(trackOf(msg), `draft-${draft} ${vectorId}`).toEqual({
        namespace: expected.track_namespace,
        name: expected.track_name,
      })
    }
  })

  it('names no track for a joining FETCH or a namespace announcement', () => {
    // A joining fetch continues someone else's track; PUBLISH_NAMESPACE and
    // ANNOUNCE carry a namespace, which is not a track.
    const joining = acrossDrafts('fetch.json', (c) => c.expected.track_name == null)
    expect(joining.length).toBeGreaterThan(0)
    for (const { draft, vectorId, msg } of joining) {
      expect(trackOf(msg), `draft-${draft} ${vectorId}`).toBeUndefined()
    }

    const namespaces = [...acrossDrafts('publish-namespace.json'), ...acrossDrafts('announce.json')]
    expect(namespaces.length).toBeGreaterThan(0)
    for (const { draft, vectorId, msg } of namespaces) {
      expect(trackOf(msg), `draft-${draft} ${vectorId}`).toBeUndefined()
    }
  })
})

describe('joiningRequestIdOf', () => {
  it('finds the joined request under either spelling', () => {
    // joining_subscribe_id through draft-13, joining_request_id after it.
    const joining = acrossDrafts(
      'fetch.json',
      (c) => c.expected.joining_request_id != null || c.expected.joining_subscribe_id != null,
    )
    expect(new Set(joining.map((c) => c.draft)).size).toBeGreaterThan(1)

    for (const { draft, vectorId, msg, expected } of joining) {
      const want = String(expected.joining_request_id ?? expected.joining_subscribe_id)
      expect(String(joiningRequestIdOf(msg)), `draft-${draft} ${vectorId}`).toBe(want)
    }
  })

  it('is undefined for a standalone FETCH', () => {
    const standalone = acrossDrafts('fetch.json', (c) => c.expected.track_name != null)
    expect(standalone.length).toBeGreaterThan(0)

    for (const { draft, vectorId, msg } of standalone) {
      expect(joiningRequestIdOf(msg), `draft-${draft} ${vectorId}`).toBeUndefined()
    }
  })
})
