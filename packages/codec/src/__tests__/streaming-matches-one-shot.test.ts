/**
 * The streaming decoders and the one-shot decoders must agree, byte for byte
 * and field for field, on the same input.
 *
 * Every draft ships two ways to read a subgroup stream: `decodeSubgroupStream`,
 * which takes the whole thing, and `createSubgroupStreamDecoder`, which takes it
 * in pieces. They were written at different times and nothing ever compared
 * them, so they drifted — the incremental path returned Properties as opaque
 * bytes where the one-shot parsed them into a map, dropped the header flags
 * entirely, computed the wrong Subgroup ID for one of the three subgroup modes,
 * and reported every Object as starting at byte zero. None of it corrupts the
 * payload, which is why it survived: a consumer that switched paths got objects
 * that looked right and carried a different shape.
 *
 * Rather than assert those four things, this file asserts the property that
 * makes them impossible: **same bytes in, same result out, whichever path you
 * take.** A fifth divergence introduced tomorrow fails here without anyone
 * having thought of it.
 *
 * The header types are swept rather than chosen. Each draft numbers its own
 * flags — draft-15's bit 1 is `end_of_group` where draft-16's is a Subgroup ID
 * mode, and Properties do not exist before draft-17 — so picking values by hand
 * would encode this author's reading of six specifications into the fixtures.
 * Instead every value the draft's own encoder will emit and its own one-shot
 * decoder will accept is tried, and the two paths must agree on all of them.
 * A draft that rejects a combination simply contributes fewer cases.
 */

import { describe, expect, it } from 'vitest'
import {
  createSubgroupStreamDecoder as create14,
  encodeSubgroupStream as enc14,
  decodeSubgroupStream as one14,
} from '../drafts/draft14/index.js'
import {
  createSubgroupStreamDecoder as create15,
  encodeSubgroupStream as enc15,
  decodeSubgroupStream as one15,
} from '../drafts/draft15/index.js'
import {
  createSubgroupStreamDecoder as create16,
  encodeSubgroupStream as enc16,
  decodeSubgroupStream as one16,
} from '../drafts/draft16/index.js'
import {
  createSubgroupStreamDecoder as create17,
  encodeSubgroupStream as enc17,
  decodeSubgroupStream as one17,
} from '../drafts/draft17/index.js'
import {
  createSubgroupStreamDecoder as create18,
  encodeSubgroupStream as enc18,
  decodeSubgroupStream as one18,
} from '../drafts/draft18/index.js'
import {
  createSubgroupStreamDecoder as create19,
  encodeSubgroupStream as enc19,
  decodeSubgroupStream as one19,
} from '../drafts/draft19/index.js'
import {
  createSubgroupStreamDecoder as create20,
  encodeSubgroupStream as enc20,
  decodeSubgroupStream as one20,
} from '../drafts/draft20/index.js'

// Each draft's SubgroupStream is a distinct nominal type with the same shape,
// and the whole point here is to run one body against all seven.
// biome-ignore lint/suspicious/noExplicitAny: see the note above
type AnyStream = any

interface Draft {
  readonly name: string
  readonly encode: (s: AnyStream) => Uint8Array
  readonly oneShot: (b: Uint8Array) => { ok: boolean; value?: AnyStream; error?: unknown }
  readonly create: () => TransformStream<Uint8Array, unknown>
}

const DRAFTS: readonly Draft[] = [
  { name: 'draft-14', encode: enc14, oneShot: one14, create: create14 },
  { name: 'draft-15', encode: enc15, oneShot: one15, create: create15 },
  { name: 'draft-16', encode: enc16, oneShot: one16, create: create16 },
  { name: 'draft-17', encode: enc17, oneShot: one17, create: create17 },
  { name: 'draft-18', encode: enc18, oneShot: one18, create: create18 },
  { name: 'draft-19', encode: enc19, oneShot: one19, create: create19 },
  { name: 'draft-20', encode: enc20, oneShot: one20, create: create20 },
]

/**
 * Three Objects, chosen so that every field the two paths could disagree about
 * is actually populated.
 *
 * The middle one is zero-length, which is the only way an Object Status reaches
 * the wire, and the Object after it is what proves the status varint was
 * consumed. `objectProperties` is set on two of them so that a draft with the
 * Properties flag has something to parse; drafts without it, and header types
 * without the flag, encode nothing and both paths agree on nothing — which is
 * still an agreement worth asserting.
 *
 * The Object IDs are not contiguous. Delta encoding is `previous + delta + 1`,
 * so a run of 0, 1, 2 hides an off-by-one in the delta arithmetic behind a
 * delta that is always zero.
 */
function fixtureObjects(): AnyStream[] {
  return [
    {
      type: 'object',
      byteOffset: 0,
      payloadByteOffset: 0,
      objectId: 3n,
      payloadLength: 4,
      payload: new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
      extensionData: new Uint8Array(0),
      objectProperties: { '0x2': 7n },
    },
    {
      type: 'object',
      byteOffset: 0,
      payloadByteOffset: 0,
      objectId: 9n,
      payloadLength: 0,
      status: 0n,
      payload: new Uint8Array(0),
      extensionData: new Uint8Array(0),
    },
    {
      type: 'object',
      byteOffset: 0,
      payloadByteOffset: 0,
      objectId: 40n,
      payloadLength: 2,
      payload: new Uint8Array([0xca, 0xfe]),
      extensionData: new Uint8Array(0),
      objectProperties: { '0x2': 1n, '0x4': 65535n },
    },
  ]
}

function fixtureStream(headerType: number): AnyStream {
  return {
    type: 'subgroup',
    headerType,
    trackAlias: 1n,
    groupId: 7n,
    // Deliberately not zero: a mode that derives the Subgroup ID from the first
    // Object must override this, and a mode that reads it off the wire must
    // preserve it. Zero would let both look correct.
    subgroupId: 5n,
    publisherPriority: 200,
    objects: fixtureObjects(),
  }
}

/**
 * Push `chunks` through a decoder and collect what comes out.
 *
 * The reader runs concurrently with the writes so a decoder that enqueues more
 * than the default queue holds cannot deadlock the writer, and an error on the
 * readable is returned rather than thrown, because the events collected before
 * it are the more useful half of the report.
 */
async function drain(
  decoder: TransformStream<Uint8Array, unknown>,
  chunks: readonly Uint8Array[],
): Promise<{ events: Record<string, unknown>[]; error: unknown }> {
  const events: Record<string, unknown>[] = []
  let error: unknown
  const reader = decoder.readable.getReader()
  const collect = (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        events.push(value as Record<string, unknown>)
      }
    } catch (e) {
      error = e
    }
  })()
  const writer = decoder.writable.getWriter()
  try {
    for (const chunk of chunks) await writer.write(chunk)
    await writer.close()
  } catch (e) {
    error ??= e
  }
  await collect
  return { events, error }
}

/**
 * Every header type this draft will both encode and decode, with the fixture
 * Objects attached.
 *
 * A draft rejects most of the 128 values — reserved bits, illegal flag
 * combinations — and those are simply not cases. What survives is the draft's
 * own answer to "what is a legal subgroup header", which is the only definition
 * this file should be using.
 */
function acceptedHeaderTypes(d: Draft): { headerType: number; bytes: Uint8Array }[] {
  const out: { headerType: number; bytes: Uint8Array }[] = []
  for (let headerType = 0; headerType < 0x80; headerType++) {
    let bytes: Uint8Array
    try {
      bytes = d.encode(fixtureStream(headerType))
    } catch {
      continue
    }
    if (d.oneShot(bytes).ok) out.push({ headerType, bytes })
  }
  return out
}

/** The fields both paths report about the stream as a whole. */
function headerFacts(e: Record<string, unknown>): Record<string, unknown> {
  return {
    trackAlias: e.trackAlias,
    groupId: e.groupId,
    subgroupId: e.subgroupId,
    publisherPriority: e.publisherPriority,
    headerType: e.headerType,
    endOfGroup: e.endOfGroup,
    firstObject: e.firstObject,
  }
}

describe.each(DRAFTS)('$name: streaming agrees with one-shot', (d) => {
  const cases = acceptedHeaderTypes(d)

  it('accepts a workable number of header types at all', () => {
    // If a refactor made the encoder throw on everything, every case below
    // would vanish and this file would pass while testing nothing.
    expect(cases.length).toBeGreaterThanOrEqual(4)
  })

  it('agrees on every Object, for every header type the draft accepts', async () => {
    const disagreed: string[] = []
    for (const { headerType, bytes } of cases) {
      const one = d.oneShot(bytes)
      const streamed = await drain(d.create(), [bytes])
      const objects = streamed.events.filter((e) => e.type === 'object')
      try {
        expect(streamed.error).toBeUndefined()
        expect(objects).toEqual(one.value?.objects)
      } catch {
        disagreed.push(`0x${headerType.toString(16).padStart(2, '0')}`)
      }
    }
    // Reported as a set rather than one at a time: which header types diverge
    // is the diagnosis, and failing on the first hides the pattern.
    expect(disagreed, `header types where the two paths disagree: ${disagreed.join(', ')}`).toEqual(
      [],
    )
  })

  it('agrees on the stream header, for every header type the draft accepts', async () => {
    const disagreed: string[] = []
    for (const { headerType, bytes } of cases) {
      const one = d.oneShot(bytes)
      const streamed = await drain(d.create(), [bytes])
      const header = streamed.events.find((e) => String(e.type).endsWith('_header'))
      try {
        expect(header).toBeDefined()
        expect(headerFacts(header as Record<string, unknown>)).toEqual(
          headerFacts(one.value as Record<string, unknown>),
        )
      } catch {
        disagreed.push(`0x${headerType.toString(16).padStart(2, '0')}`)
      }
    }
    expect(disagreed, `header types where the headers disagree: ${disagreed.join(', ')}`).toEqual(
      [],
    )
  })

  it('agrees when the bytes arrive one at a time', async () => {
    // The whole reason the streaming path exists. Splitting maximally is also
    // the only way to catch a decoder that reads a field it has not buffered.
    const disagreed: string[] = []
    for (const { headerType, bytes } of cases) {
      const one = d.oneShot(bytes)
      const single = Array.from(bytes, (b) => new Uint8Array([b]))
      const streamed = await drain(d.create(), single)
      const objects = streamed.events.filter((e) => e.type === 'object')
      try {
        expect(streamed.error).toBeUndefined()
        expect(objects).toEqual(one.value?.objects)
      } catch {
        disagreed.push(`0x${headerType.toString(16).padStart(2, '0')}`)
      }
    }
    expect(
      disagreed,
      `header types that fail when fed byte by byte: ${disagreed.join(', ')}`,
    ).toEqual([])
  })
})

/**
 * The same property for fetch streams.
 *
 * A fetch stream carries its shape per Object rather than in one header: the
 * Serialization Flags decide which of Group ID, Object ID, Subgroup ID,
 * Priority and Properties are on the wire for that Object, so the sweep here
 * runs over the flags instead of over a header type. Values at or above 0x80
 * are the End of Range markers, which have their own field list, and they are
 * swept too by the same "encode it, and if the draft's own decoder accepts it,
 * both paths must agree" rule.
 */

import {
  createFetchStreamDecoder as fcreate14,
  encodeFetchStream as fenc14,
  decodeFetchStream as fone14,
} from '../drafts/draft14/index.js'
import {
  createFetchStreamDecoder as fcreate15,
  encodeFetchStream as fenc15,
  decodeFetchStream as fone15,
} from '../drafts/draft15/index.js'
import {
  createFetchStreamDecoder as fcreate16,
  encodeFetchStream as fenc16,
  decodeFetchStream as fone16,
} from '../drafts/draft16/index.js'
import {
  createFetchStreamDecoder as fcreate17,
  encodeFetchStream as fenc17,
  decodeFetchStream as fone17,
} from '../drafts/draft17/index.js'
import {
  createFetchStreamDecoder as fcreate18,
  encodeFetchStream as fenc18,
  decodeFetchStream as fone18,
} from '../drafts/draft18/index.js'
import {
  createFetchStreamDecoder as fcreate19,
  encodeFetchStream as fenc19,
  decodeFetchStream as fone19,
} from '../drafts/draft19/index.js'
import {
  createFetchStreamDecoder as fcreate20,
  encodeFetchStream as fenc20,
  decodeFetchStream as fone20,
} from '../drafts/draft20/index.js'

const FETCH_DRAFTS: readonly Draft[] = [
  { name: 'draft-14', encode: fenc14, oneShot: fone14, create: fcreate14 },
  { name: 'draft-15', encode: fenc15, oneShot: fone15, create: fcreate15 },
  { name: 'draft-16', encode: fenc16, oneShot: fone16, create: fcreate16 },
  { name: 'draft-17', encode: fenc17, oneShot: fone17, create: fcreate17 },
  { name: 'draft-18', encode: fenc18, oneShot: fone18, create: fcreate18 },
  { name: 'draft-19', encode: fenc19, oneShot: fone19, create: fcreate19 },
  { name: 'draft-20', encode: fenc20, oneShot: fone20, create: fcreate20 },
]

function fetchFixture(flags: number): AnyStream {
  const obj = (objectId: bigint, groupId: bigint, payload: Uint8Array): AnyStream => ({
    type: 'object',
    byteOffset: 0,
    payloadByteOffset: 0,
    serializationFlags: flags,
    groupId,
    subgroupId: 2n,
    publisherPriority: 200,
    objectId,
    payloadLength: payload.length,
    payload,
    extensionData: new Uint8Array(0),
    objectProperties: { '0x2': 7n },
  })
  return {
    type: 'fetch',
    requestId: 11n,
    objects: [
      obj(3n, 1n, new Uint8Array([0xde, 0xad])),
      obj(9n, 4n, new Uint8Array(0)),
      obj(40n, 6n, new Uint8Array([0xca, 0xfe])),
    ],
  }
}

/** Every Serialization Flags value this draft will encode and then accept. */
function acceptedFlags(d: Draft): { flags: number; bytes: Uint8Array }[] {
  const out: { flags: number; bytes: Uint8Array }[] = []
  const candidates = [...Array.from({ length: 0x80 }, (_, i) => i), 0x8c, 0x10c, 0x20c]
  for (const flags of candidates) {
    let bytes: Uint8Array
    try {
      bytes = d.encode(fetchFixture(flags))
    } catch {
      continue
    }
    if (d.oneShot(bytes).ok) out.push({ flags, bytes })
  }
  return out
}

describe.each(FETCH_DRAFTS)('$name fetch: streaming agrees with one-shot', (d) => {
  const cases = acceptedFlags(d)

  it('accepts a workable number of flag combinations at all', () => {
    expect(cases.length).toBeGreaterThanOrEqual(4)
  })

  it('agrees on every Object, for every flag combination the draft accepts', async () => {
    const disagreed: string[] = []
    for (const { flags, bytes } of cases) {
      const one = d.oneShot(bytes)
      const streamed = await drain(d.create(), [bytes])
      const objects = streamed.events.filter((e) => e.type === 'object')
      try {
        expect(streamed.error).toBeUndefined()
        expect(objects).toEqual(one.value?.objects)
      } catch {
        disagreed.push(`0x${flags.toString(16)}`)
      }
    }
    expect(
      disagreed,
      `flag combinations where the two paths disagree: ${disagreed.join(', ')}`,
    ).toEqual([])
  })

  it('agrees when the bytes arrive one at a time', async () => {
    const disagreed: string[] = []
    for (const { flags, bytes } of cases) {
      const one = d.oneShot(bytes)
      const single = Array.from(bytes, (b) => new Uint8Array([b]))
      const streamed = await drain(d.create(), single)
      const objects = streamed.events.filter((e) => e.type === 'object')
      try {
        expect(streamed.error).toBeUndefined()
        expect(objects).toEqual(one.value?.objects)
      } catch {
        disagreed.push(`0x${flags.toString(16)}`)
      }
    }
    expect(disagreed, `flag combinations that fail byte by byte: ${disagreed.join(', ')}`).toEqual(
      [],
    )
  })
})
