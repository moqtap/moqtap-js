/**
 * `rq` and `ga` through the real hook: a page subscribes, the relay answers
 * and delivers a subgroup, and the uploaded rollup names the request and the
 * group's first arrival at every detail level.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetDormantForTest, teardownDormant } from '../../api/dormant.js'
import { BODY_PREAMBLE_BYTES, readFrames, readPreamble } from '../../envelope/index.js'
import type { CollectorConfig, EnvelopeRecord, RollupTrackWire } from '../../types.js'
import { subgroupBytes, subscribeBytes, subscribeOkBytes } from '../decode/vectors.js'
import { init } from '../support/init.js'
import { settle } from '../support/settle.js'
import { MockWebTransport } from '../transport/mocks.js'

const g = globalThis as unknown as Record<string, unknown>
let originalWT: unknown

function recordingFetch(): { posts: Uint8Array[]; impl: typeof fetch } {
  const posts: Uint8Array[] = []
  const impl = (async (_url: string, init: RequestInit) => {
    posts.push(new Uint8Array(init.body as unknown as ArrayBufferLike as never))
    return { ok: true, status: 200, headers: { get: () => null } } as unknown as Response
  }) as unknown as typeof fetch
  return { posts, impl }
}

async function recordsOf(body: Uint8Array): Promise<EnvelopeRecord[]> {
  const pre = readPreamble(body)
  let frames = body.subarray(BODY_PREAMBLE_BYTES)
  if ((pre as { gzipped: boolean }).gzipped) {
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

async function rxRows(posts: readonly Uint8Array[], alias: string): Promise<RollupTrackWire[]> {
  const all: EnvelopeRecord[] = []
  for (const p of posts) all.push(...(await recordsOf(p)))
  return all
    .filter((r): r is EnvelopeRecord & { tracks: RollupTrackWire[] } => r.t === 'rollup')
    .flatMap((r) => r.tracks)
    .filter((t) => t.key.d === 'rx' && t.key.v === alias)
}

const base = (over: Partial<CollectorConfig> = {}): CollectorConfig => ({
  apiKey: 'pk_test',
  endpoint: 'https://ingest.test/v1/ingest',
  sessionId: 'sess-fixed',
  // Ten groups a track fit in a 1 s interval before any is sampled out.
  metrics: { intervalMs: 1000 },
  ...over,
})

beforeEach(() => {
  originalWT = g.WebTransport
  MockWebTransport.instances = []
  g.WebTransport = MockWebTransport
})

afterEach(() => {
  teardownDormant()
  resetDormantForTest()
  g.WebTransport = originalWT
})

describe('group arrivals, through the hook', () => {
  for (const detail of ['baseline', 'headers'] as const) {
    it(`names the SUBSCRIBE and reports each group's first arrival at ${detail}`, async () => {
      const { posts, impl } = recordingFetch()
      const c = init(base({ detail }), {
        persist: false,
        noLifecycleListeners: true,
        fetchImpl: impl,
      })
      await settle()

      const wt = new (g.WebTransport as new (u: string) => MockWebTransport)(
        'https://relay.test/moq',
      )
      await wt.open('moqt-20')
      await settle(5)

      const bidi = await wt.createBidirectionalStream()
      const writer = (bidi.writable as WritableStream<Uint8Array>).getWriter()
      await writer.write(subscribeBytes(6n))
      bidi.inbound.push(subscribeOkBytes(4n))
      const control = bidi.readable.getReader()
      await control.read()
      await settle(5)

      wt.deliverUniStream([
        subgroupBytes({
          alias: 4n,
          group: 2n,
          objects: [
            { id: 1n, bytes: 8 },
            { id: 2n, bytes: 8 },
          ],
        }),
      ]).close()
      wt.deliverUniStream([
        subgroupBytes({ alias: 4n, group: 3n, objects: [{ id: 0n, bytes: 8 }] }),
      ]).close()
      const incoming = wt.incomingUnidirectionalStreams.getReader()
      for (let i = 0; i < 2; i++) {
        const s = (await incoming.read()).value as ReadableStream<Uint8Array>
        const r = s.getReader()
        while (!(await r.read()).done) {}
      }
      await settle(5)
      await c.end()
      await settle()

      const rows = await rxRows(posts, '4')
      expect(rows.length).toBeGreaterThan(0)
      for (const row of rows) expect(row.rq).toEqual({ d: 'tx', v: '6' })
      const ga = rows.flatMap((r) => (r.ga === undefined ? [] : [r.ga]))
      expect(ga).toHaveLength(1)
      expect(ga[0]).toMatchObject({ g: '2', ob: [[0, '1']] })
      expect(ga[0]!.at).toHaveLength(2)
    })
  }
})
