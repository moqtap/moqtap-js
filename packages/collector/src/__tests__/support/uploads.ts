/**
 * What left the page: a `fetch` that records every upload, and the records in
 * the bodies it recorded, decoded as ingest decodes them.
 */

import { BODY_PREAMBLE_BYTES, readFrames, readPreamble } from '../../envelope/index.js'
import type { EnvelopeRecord } from '../../types.js'

export interface Post {
  readonly url: string
  readonly body: Uint8Array
}

/**
 * A `fetch` that records every upload and answers 200, with the response
 * headers `headers()` returns for each one.
 */
export function recordingFetch(headers: (n: number) => Record<string, string> = () => ({})): {
  posts: Post[]
  impl: typeof fetch
} {
  const posts: Post[] = []
  const impl = (async (url: string, init: RequestInit) => {
    const body =
      init.body instanceof Blob
        ? new Uint8Array(await init.body.arrayBuffer())
        : new Uint8Array(init.body as unknown as ArrayBufferLike as never)
    posts.push({ url, body })
    const h = new Map(
      Object.entries(headers(posts.length - 1)).map(([k, v]) => [k.toLowerCase(), v]),
    )
    return {
      ok: true,
      status: 200,
      headers: { get: (name: string) => h.get(name.toLowerCase()) ?? null },
    } as unknown as Response
  }) as unknown as typeof fetch
  return { posts, impl }
}

/** Every JSON record in one uploaded body, ungzipped if its preamble says so. */
export async function recordsOf(body: Uint8Array): Promise<EnvelopeRecord[]> {
  const pre = readPreamble(body) as { gzipped: boolean }
  let frames = body.subarray(BODY_PREAMBLE_BYTES)
  if (pre.gzipped) {
    const ds = new DecompressionStream('gzip')
    const out = new Response(new Blob([frames as unknown as BlobPart]).stream().pipeThrough(ds))
    frames = new Uint8Array(await out.arrayBuffer())
  }
  const decoder = new TextDecoder()
  const out: EnvelopeRecord[] = []
  for (const f of readFrames(frames)) {
    if (!f.raw) out.push(JSON.parse(decoder.decode(f.payload)) as EnvelopeRecord)
  }
  return out
}

/** Every JSON record in every uploaded body, in upload order. */
export async function allRecords(posts: readonly Post[]): Promise<EnvelopeRecord[]> {
  const all: EnvelopeRecord[] = []
  for (const p of posts) all.push(...(await recordsOf(p.body)))
  return all
}

export const of = <T extends EnvelopeRecord['t']>(all: readonly EnvelopeRecord[], t: T) =>
  all.filter((r) => r.t === t) as Extract<EnvelopeRecord, { t: T }>[]
