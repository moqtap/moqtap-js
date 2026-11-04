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
 * The answer to the runtime's clock exchange, `POST /v1/clock`, so a fetch
 * standing in for ingest can leave it out of the uploads it records.
 * `undefined` for every other request.
 */
export function clockProbe(url: unknown): Promise<Response> | undefined {
  if (!String(url).includes('/v1/clock')) return undefined
  return Promise.resolve({
    ok: true,
    status: 204,
    headers: { get: () => null },
  } as unknown as Response)
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
    const clock = clockProbe(url)
    if (clock !== undefined) return clock
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

/** A body's bytes after its header and, in a v2 body, its uncompressed preamble frame. */
export function afterPreamble(body: Uint8Array): Uint8Array {
  if (body[4] !== 2) return body.subarray(BODY_PREAMBLE_BYTES)
  const n = new DataView(body.buffer, body.byteOffset + BODY_PREAMBLE_BYTES, 4).getUint32(0, false)
  return body.subarray(BODY_PREAMBLE_BYTES + 4 + n)
}

/** A v2 body's preamble, `{v, i, em, seal}`. */
export function preambleOf(body: Uint8Array): {
  v: number
  i: string
  em: [number, number][]
  seal: { seq: number; from_us: number; through_us: number; ms: number }
} {
  const n = new DataView(body.buffer, body.byteOffset + BODY_PREAMBLE_BYTES, 4).getUint32(0, false)
  const at = body.byteOffset + BODY_PREAMBLE_BYTES + 4
  return JSON.parse(new TextDecoder().decode(new Uint8Array(body.buffer, at, n)))
}

/** Every frame in one uploaded body, ungzipped if its preamble says so. */
export async function framesOf(body: Uint8Array): Promise<{ raw: boolean; payload: Uint8Array }[]> {
  const pre = readPreamble(body) as { gzipped: boolean }
  let frames = afterPreamble(body)
  if (pre.gzipped) {
    const ds = new DecompressionStream('gzip')
    const out = new Response(new Blob([frames as unknown as BlobPart]).stream().pipeThrough(ds))
    frames = new Uint8Array(await out.arrayBuffer())
  }
  return [...readFrames(frames)]
}

/** Every JSON record in one uploaded body. */
export async function recordsOf(body: Uint8Array): Promise<EnvelopeRecord[]> {
  const decoder = new TextDecoder()
  const out: EnvelopeRecord[] = []
  for (const f of await framesOf(body)) {
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
