/**
 * The send-side metrics, through the real hook rather than the rollup's own API.
 *
 * `pub.ackedBytes` has an ordering hazard no unit test of the rollup can see:
 * `writer.close()` calls `onDone` — `CollectorRuntime.onStreamClose` —
 * synchronously and only then probes `getStats()`, whose promise resolves a
 * microtask later. So the final, and for a one-subgroup stream the only,
 * `bytesAcknowledged` reading arrives after the dispatcher has dropped the
 * decoder that knew which track the stream carried.
 *
 * A version that resolved the track when the reading arrived would report
 * nothing at all while every unit test of the rollup kept passing, so this file
 * drives a real `WebTransport` mock through the hook and gets the close
 * ordering the browser actually produces.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetDormantForTest, teardownDormant } from '../../api/dormant.js'
import { init } from '../../api/init.js'
import { BODY_PREAMBLE_BYTES, readFrames, readPreamble } from '../../envelope/index.js'
import type { CollectorConfig, EnvelopeRecord, RollupTrackWire } from '../../types.js'
import { subgroupBytes } from '../decode/vectors.js'
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

/**
 * Let init()'s async setup, the schedule's zero-delay timers and the pump run.
 *
 * Bare `settle()` is a duration with a turn floor, not a turn count alone. These
 * tests pin `metrics.intervalMs` and assert on records that exist only once a
 * rollup interval has elapsed, and turns do not measure time: `setTimeout(r, 0)`
 * costs ~15 ms on Windows against ~1 ms on Linux, so forty turns are ~600 ms on
 * one and ~60 ms on the other. Turn-based, these passed on Windows and failed in
 * CI reporting an absent rollup — which reads as the collector having recorded
 * nothing, rather than as the interval never having come round.
 *
 * `settle(n)` keeps the pure turn count for the places that only need the session
 * to attach before the next step.
 */
const SETTLE_MS = 300

const settle = async (times?: number): Promise<void> => {
  const turns = times ?? 40
  const until = times === undefined ? Date.now() + SETTLE_MS : 0
  for (let i = 0; i < turns || Date.now() < until; i += 1) {
    await Promise.resolve()
    await new Promise((r) => setTimeout(r, 0))
  }
}

const base = (over: Partial<CollectorConfig> = {}): CollectorConfig => ({
  apiKey: 'pk_test',
  endpoint: 'https://ingest.test/v1/ingest',
  sessionId: 'sess-fixed',
  drafts: [20],
  metrics: { intervalMs: 100 },
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

/** Every send-side row for one track alias, across every rollup uploaded. */
async function txRows(posts: readonly Uint8Array[], alias: string): Promise<RollupTrackWire[]> {
  const all: EnvelopeRecord[] = []
  for (const p of posts) all.push(...(await recordsOf(p)))
  return all
    .filter((r): r is EnvelopeRecord & { tracks: RollupTrackWire[] } => r.t === 'rollup')
    .flatMap((r) => r.tracks)
    .filter((t) => t.key.d === 'tx' && t.key.v === alias)
}

/**
 * A field summed over every interval the track appeared in.
 *
 * These are per-interval sums, so a session that ticks more than once splits
 * them across rows — reading the first row reads one interval, not the session.
 * `undefined` where no row carried the field at all.
 */
function total(
  rows: readonly RollupTrackWire[],
  f: 'ackedBytes' | 'blockedMs',
): number | undefined {
  const present = rows.filter((r) => r[f] !== undefined)
  return present.length === 0 ? undefined : present.reduce((n, r) => n + (r[f] as number), 0)
}

describe('pub.ackedBytes, through the hook', () => {
  it('attributes the reading that arrives after the stream has closed', async () => {
    const { posts, impl } = recordingFetch()
    const c = init(base(), { persist: false, noLifecycleListeners: true, fetchImpl: impl })
    await settle()

    const wt = new (g.WebTransport as new (u: string) => MockWebTransport)('https://relay.test/moq')
    await wt.open('moqt-20')
    await settle(5)

    wt.bytesAcknowledged = 4096
    const send = await wt.createUnidirectionalStream()
    const writer = (send as WritableStream<unknown>).getWriter()
    // A whole subgroup in one write: header names track alias 4, so the
    // dispatcher can resolve the track — while the stream is still open.
    await writer.write(subgroupBytes({ alias: 4n, group: 0n, objects: [{ id: 0n, bytes: 8 }] }))
    // The hazard. onStreamClose runs synchronously inside this call; the
    // getStats() promise settles after it.
    await writer.close()
    await settle()
    await c.stop()
    await settle()

    const rows = await txRows(posts, '4')
    expect(rows.length).toBeGreaterThan(0)
    expect(total(rows, 'ackedBytes')).toBe(4096)
  })

  it('reports nothing rather than something wrong on a browser without getStats', async () => {
    // Absence of the field is not distinguishable from "nothing was
    // acknowledged" and must never be alerted on, so the non-Chromium path has
    // to leave the row clean rather than emit a zero.
    const { posts, impl } = recordingFetch()
    const c = init(base(), { persist: false, noLifecycleListeners: true, fetchImpl: impl })
    await settle()

    const wt = new (g.WebTransport as new (u: string) => MockWebTransport)('https://relay.test/moq')
    await wt.open('moqt-20')
    await settle(5)

    const send = await wt.createUnidirectionalStream()
    // Every other engine: no getStats on the send stream at all.
    Reflect.deleteProperty(send as object, 'getStats')
    const writer = (send as WritableStream<unknown>).getWriter()
    await writer.write(subgroupBytes({ alias: 4n, group: 0n, objects: [{ id: 0n, bytes: 8 }] }))
    await writer.close()
    await settle()
    await c.stop()
    await settle()

    const rows = await txRows(posts, '4')
    expect(rows.length).toBeGreaterThan(0)
    expect(total(rows, 'ackedBytes')).toBeUndefined()
  })

  it('differences the two readings of a stream probed twice', async () => {
    // The stat is cumulative for the life of the stream, so a stream probed
    // once under backpressure and again at close must contribute the final
    // total, not the sum of the two readings.
    const { posts, impl } = recordingFetch()
    const c = init(base(), { persist: false, noLifecycleListeners: true, fetchImpl: impl })
    await settle()

    const wt = new (g.WebTransport as new (u: string) => MockWebTransport)('https://relay.test/moq')
    await wt.open('moqt-20')
    await settle(5)

    wt.bytesAcknowledged = 1_000
    const send = await wt.createUnidirectionalStream({ hold: true, highWaterMark: 1 })
    const held = wt.createdUni[0]?.out
    const writer = (send as WritableStream<unknown>).getWriter()
    // First write is never backpressured — desiredSize is still positive.
    const first = writer.write(
      subgroupBytes({ alias: 4n, group: 0n, objects: [{ id: 0n, bytes: 8 }] }),
    )
    const second = writer.write(new Uint8Array([0x00]))
    held?.release()
    await settle()
    held?.release()
    await Promise.all([first, second])
    await settle()

    wt.bytesAcknowledged = 3_000
    await writer.close()
    await settle()
    await c.stop()
    await settle()

    const rows = await txRows(posts, '4')
    // 1,000 then 3,000 cumulative is 3,000 acknowledged, not 4,000.
    expect(total(rows, 'ackedBytes')).toBe(3_000)
    // And the pressure episode landed on the same track rather than only in
    // the session-wide histogram.
    expect(total(rows, 'blockedMs')).toBeGreaterThan(0)
  })

  it('attributes a stream first probed before its header named a track', async () => {
    // Why `onStreamClose` resolves a key it may already have: backpressure can
    // resolve while only part of the subgroup header has been written, so the
    // first reading arrives with no track to credit. The track is filled in at
    // the close, the last moment anything still knows it.
    const { posts, impl } = recordingFetch()
    const c = init(base(), { persist: false, noLifecycleListeners: true, fetchImpl: impl })
    await settle()

    const wt = new (g.WebTransport as new (u: string) => MockWebTransport)('https://relay.test/moq')
    await wt.open('moqt-20')
    await settle(5)

    wt.bytesAcknowledged = 500
    const send = await wt.createUnidirectionalStream({ hold: true, highWaterMark: 1 })
    const held = wt.createdUni[0]?.out
    const writer = (send as WritableStream<unknown>).getWriter()

    const header = subgroupBytes({ alias: 4n, group: 0n, objects: [{ id: 0n, bytes: 8 }] })
    // Two bytes is not a subgroup header, so no alias has been read yet.
    const a = writer.write(header.subarray(0, 1))
    const b = writer.write(header.subarray(1, 2))
    held?.release()
    await settle()
    held?.release()
    await Promise.all([a, b])
    await settle()

    // Only now does the track become resolvable.
    const rest = writer.write(header.subarray(2))
    held?.release()
    await rest
    await settle()

    wt.bytesAcknowledged = 900
    await writer.close()
    await settle()
    await c.stop()
    await settle()

    const rows = await txRows(posts, '4')
    expect(rows.length).toBeGreaterThan(0)
    // 500 was unattributable when it arrived; 400 more followed. Both belong to
    // the track, and the first must not be lost just because it arrived early.
    expect(total(rows, 'ackedBytes')).toBe(900)
  })

  it('adds nothing for a repeated identical reading', async () => {
    // Two probes with no acknowledgement in between is a zero delta. Adding it
    // would be harmless arithmetic but it would also mark the track active for
    // an interval in which nothing happened.
    const { posts, impl } = recordingFetch()
    const c = init(base(), { persist: false, noLifecycleListeners: true, fetchImpl: impl })
    await settle()

    const wt = new (g.WebTransport as new (u: string) => MockWebTransport)('https://relay.test/moq')
    await wt.open('moqt-20')
    await settle(5)

    wt.bytesAcknowledged = 2_048
    const send = await wt.createUnidirectionalStream({ hold: true, highWaterMark: 1 })
    const held = wt.createdUni[0]?.out
    const writer = (send as WritableStream<unknown>).getWriter()
    const first = writer.write(
      subgroupBytes({ alias: 4n, group: 0n, objects: [{ id: 0n, bytes: 8 }] }),
    )
    const second = writer.write(new Uint8Array([0x00]))
    held?.release()
    await settle()
    held?.release()
    await Promise.all([first, second])
    await settle()

    // Unchanged: the peer acknowledged nothing further before the close probe.
    await writer.close()
    await settle()
    await c.stop()
    await settle()

    const rows = await txRows(posts, '4')
    expect(total(rows, 'ackedBytes')).toBe(2_048)
  })
})
