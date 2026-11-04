/**
 * Drafts 18-23: every fetch decode path reads the corpus's fetch vectors in
 * their Group Order, and agrees with `decodeFetchStream`: the same Objects
 * where it decodes, an error where it does not.
 */

import { describe, expect, it } from 'vitest'
import type { FetchGroupOrder } from '../core/group-order.js'
import { createDraft18Codec } from '../drafts/draft18/codec.js'
import { createDraft19Codec } from '../drafts/draft19/codec.js'
import { createDraft20Codec } from '../drafts/draft20/codec.js'
import { createDraft21Codec } from '../drafts/draft21/codec.js'
import { createDraft22Codec } from '../drafts/draft22/codec.js'
import { createDraft23Codec } from '../drafts/draft23/codec.js'
import { fetchGroupOrder, hexToBytes, loadVectorDir, type TestVector } from './helpers.js'

interface FetchCodec {
  decodeFetchStream(
    bytes: Uint8Array,
    groupOrder?: FetchGroupOrder,
  ): { ok: boolean; value?: { objects: unknown[] } }
  decodeDataStream(
    streamType: 'fetch',
    bytes: Uint8Array,
    groupOrder?: FetchGroupOrder,
  ): { ok: boolean; value?: unknown }
  createFetchStreamDecoder(groupOrder?: FetchGroupOrder): TransformStream<Uint8Array, unknown>
  createDataStreamDecoder(groupOrder?: FetchGroupOrder): TransformStream<Uint8Array, unknown>
}

const DRAFTS: readonly [string, FetchCodec][] = [
  ['18', createDraft18Codec()],
  ['19', createDraft19Codec()],
  ['20', createDraft20Codec()],
  ['21', createDraft21Codec()],
  ['22', createDraft22Codec()],
  ['23', createDraft23Codec()],
]

const DESCENDING_IDS = ['fetch-stream-descending', 'fetch-group-within-a-communicated-gap']

function fetchVectors(draft: string): TestVector[] {
  const file = loadVectorDir(`transport/draft${draft}/codec/data-streams`).find(
    (f) => f.file === 'fetch-header.json',
  )
  if (file === undefined) throw new Error(`draft-${draft}: no fetch vector file`)
  return file.data.vectors
}

/** The Objects a streaming decoder emits for `chunks`, or the error it raised. */
async function drain(
  decoder: TransformStream<Uint8Array, unknown>,
  chunks: readonly Uint8Array[],
): Promise<{ objects: unknown[]; error: unknown }> {
  const objects: unknown[] = []
  let error: unknown
  const reader = decoder.readable.getReader()
  const collect = (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if ((value as { type: string }).type === 'object') objects.push(value)
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
  return { objects, error }
}

function expectAgreement(
  streamed: { objects: unknown[]; error: unknown },
  one: { ok: boolean; value?: { objects: unknown[] } },
): void {
  if (one.ok) {
    expect(streamed.error).toBeUndefined()
    expect(streamed.objects).toEqual(one.value?.objects)
  } else {
    expect(streamed.error).toBeDefined()
  }
}

/** The whole stream, then every two-chunk split, then one byte at a time. */
function feeds(bytes: Uint8Array): Uint8Array[][] {
  const out: Uint8Array[][] = [[bytes]]
  for (let i = 1; i < bytes.length; i++) out.push([bytes.subarray(0, i), bytes.subarray(i)])
  out.push(Array.from(bytes, (b) => new Uint8Array([b])))
  return out
}

describe.each(DRAFTS)('draft-%s fetch decode paths take the Group Order', (draft, codec) => {
  const vectors = fetchVectors(draft)

  it('carries both Descending vectors', () => {
    const descending = vectors.filter((v) => fetchGroupOrder(v) === 2n).map((v) => v.id)
    expect(descending.sort()).toEqual([...DESCENDING_IDS].sort())
  })

  for (const vector of vectors) {
    const order = fetchGroupOrder(vector)
    const bytes = hexToBytes(vector.hex)

    describe(`[${vector.id}] Group Order ${order}`, () => {
      const one = codec.decodeFetchStream(bytes, order)

      it('decodeDataStream agrees with decodeFetchStream', () => {
        expect(codec.decodeDataStream('fetch', bytes, order)).toEqual(one)
      })

      it('createFetchStreamDecoder agrees, at every split', async () => {
        for (const chunks of feeds(bytes)) {
          expectAgreement(await drain(codec.createFetchStreamDecoder(order), chunks), one)
        }
      })

      it('createDataStreamDecoder agrees, at every split', async () => {
        for (const chunks of feeds(bytes)) {
          expectAgreement(await drain(codec.createDataStreamDecoder(order), chunks), one)
        }
      })

      if (order === 2n) {
        it('reads differently when the order is left at its default', async () => {
          const ascending = codec.decodeFetchStream(bytes)
          expect(ascending).not.toEqual(one)
          expect(codec.decodeDataStream('fetch', bytes)).toEqual(ascending)
          const streamed = await drain(codec.createFetchStreamDecoder(), [bytes])
          expect(streamed.objects).not.toEqual(one.value?.objects)
        })
      }
    })
  }
})
