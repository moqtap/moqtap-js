/**
 * How often a session uploads while detail is raised.
 *
 * Every upload is a request of its own, so at raised detail the number of
 * uploads matters more than their bytes. A minute of
 * a typical stream at `headers` — 30 fps video and 50 audio objects a second —
 * writes one `hdr` record per object, and those records compress twenty to
 * forty times over. Sealed by their raw size they would go out as a small body
 * every couple of seconds; sealed by what they cost on the wire they go out a
 * few times a minute, each body still well inside the body cap, and whatever is
 * buffered when the page goes still fits the beacon.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetDormantForTest, teardownDormant } from '../../api/dormant.js'
import { FORWARD_INTERVAL_MS } from '../../api/link.js'
import { initWorkerWith } from '../../api/worker.js'
import { BODY_PREAMBLE_BYTES, readPreamble } from '../../envelope/index.js'
import { BEACON_MAX_BYTES } from '../../flush/beacon.js'
import type { CollectorConfig, EnvelopeRecord } from '../../types.js'
import { subgroupBytes } from '../decode/vectors.js'
import { init, workerBuild } from '../support/init.js'
import { settle } from '../support/settle.js'
import { allRecords, of, type Post, recordingFetch } from '../support/uploads.js'
import { MockWebTransport } from '../transport/mocks.js'

const g = globalThis as unknown as Record<string, unknown>
let originalWT: unknown

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

const base = (over: Partial<CollectorConfig> = {}): CollectorConfig => ({
  apiKey: 'pk_test',
  endpoint: 'https://ingest.test/v1/ingest',
  sessionId: 'sess-fixed',
  ...over,
})

/** The largest body the tests let a seal produce. */
const MAX_BODY_BYTES = 48 * 1024

/** A merge of eight thresholds and the step that overruns it, the longest compression the packer runs. */
const LONGEST_GZIP = 8.5 * 32 * 1024 + 1024

/** The most `gzip` writes to the compressor in one task. */
const GZIP_PIECE = 32 * 1024

const VIDEO_FPS = 30
const AUDIO_PER_SEC = 50
const SECONDS = 60

/**
 * The page's clock and timers, moved by the test. Each timer that falls due
 * runs, then the real work it started (streams, gzip, the upload's fetch) is
 * let settle before the next. A second of the page's clock passes here in
 * milliseconds, and gzip takes real time: a compression still running when
 * the clock moves on would finish seconds late on the page's clock, which no
 * page sees, so the clock waits while `busy()` says one is.
 */
function virtualTime(busy: () => boolean) {
  let now = 0
  let nextId = 1
  let order = 0
  const timers = new Map<number, { due: number; order: number; fn: () => void }>()
  const due = (until: number): number | undefined => {
    let best: number | undefined
    for (const [id, t] of timers) {
      if (t.due > until) continue
      const b = best === undefined ? undefined : timers.get(best)
      if (b === undefined || t.due < b.due || (t.due === b.due && t.order < b.order)) best = id
    }
    return best
  }
  return {
    ports: {
      clock: { now: () => now, wall: () => 1_700_000_000_000 + now },
      setTimer: (fn: () => void, ms: number): unknown => {
        const id = nextId++
        timers.set(id, { due: now + Math.max(0, ms), order: order++, fn })
        return id
      },
      clearTimer: (h: unknown): void => {
        timers.delete(h as number)
      },
    },
    get now() {
      return now
    },
    async advanceTo(t: number): Promise<void> {
      for (;;) {
        await settle(8)
        const until = performance.now() + 5_000
        while (busy() && performance.now() < until) await settle(1, 1)
        const id = due(t)
        if (id === undefined) break
        const timer = timers.get(id) as { due: number; fn: () => void }
        timers.delete(id)
        now = Math.max(now, timer.due)
        timer.fn()
      }
      now = Math.max(now, t)
    },
  }
}

/** Intercepts `pagehide`; everything else still reaches the real global. */
function capturePagehide(): { fire: (persisted: boolean) => void; restore: () => void } {
  const gg = globalThis as unknown as Record<string, unknown>
  const prev = gg.addEventListener as
    | ((t: string, f: (e?: unknown) => void, ...rest: unknown[]) => void)
    | undefined
  let handler: ((e?: unknown) => void) | undefined
  gg.addEventListener = (t: string, f: (e?: unknown) => void, ...rest: unknown[]): void => {
    if (t === 'pagehide') handler = f
    else if (t === 'visibilitychange' || t === 'pageshow' || t === 'online') return
    else prev?.call(globalThis, t, f, ...rest)
  }
  return {
    fire: (persisted) => handler?.({ persisted }),
    restore: () => {
      gg.addEventListener = prev
    },
  }
}

/**
 * Counts what the page hands `CompressionStream`: in all, the most any one
 * stream is given, and the most in one write, which is the longest task
 * compression adds to the page; and the streams whose output is not yet all
 * read.
 */
function meterGzip(): {
  total: number
  largest: number
  piece: number
  open: number
  restore: () => void
} {
  const Real = g.CompressionStream as typeof CompressionStream
  const m = {
    total: 0,
    largest: 0,
    piece: 0,
    open: 0,
    restore: (): void => {
      g.CompressionStream = Real
    },
  }
  g.CompressionStream = function Metered(format: CompressionFormat) {
    const real = new Real(format)
    let n = 0
    const tap = new TransformStream<BufferSource, BufferSource>({
      transform(chunk, c) {
        n += chunk.byteLength
        m.total += chunk.byteLength
        m.piece = Math.max(m.piece, chunk.byteLength)
        c.enqueue(chunk)
      },
      flush() {
        m.largest = Math.max(m.largest, n)
      },
    })
    void tap.readable.pipeTo(real.writable).catch(() => {})
    m.open += 1
    const out = new TransformStream<Uint8Array, Uint8Array>({
      flush() {
        m.open -= 1
      },
    })
    return { readable: real.readable.pipeThrough(out), writable: tap.writable }
  }
  return m
}

/** The frame bytes a body carries, ungzipped. */
async function rawSize(body: Uint8Array): Promise<number> {
  const frames = body.subarray(BODY_PREAMBLE_BYTES)
  if (!(readPreamble(body) as { gzipped: boolean }).gzipped) return frames.byteLength
  const ds = new DecompressionStream('gzip')
  const out = new Response(new Blob([frames as unknown as BlobPart]).stream().pipeThrough(ds))
  return (await out.arrayBuffer()).byteLength
}

interface Run {
  /** Uploads made while the objects were recorded, before the session ended. */
  readonly during: readonly Post[]
  /** Every body that left the page, uploaded or beaconed. */
  readonly bodies: readonly Uint8Array[]
  readonly beaconed: readonly Uint8Array[]
  readonly records: readonly EnvelopeRecord[]
  /** Records uploaded by the moment `resolve()` had returned and its zero-delay seal run. */
  readonly resolved: readonly EnvelopeRecord[]
  /** Bytes given to `CompressionStream`, in all, at most in one stream, and at most in one write. */
  readonly gzipped: { readonly total: number; readonly largest: number; readonly piece: number }
}

interface RecordOptions {
  readonly realm?: 'page' | 'worker'
  /**
   * Seconds of objects delivered at once after the steady ones, with no timer
   * let run, so detail drops back with all of them still buffered.
   */
  readonly burst?: number
  /** Video objects a second. Default {@link VIDEO_FPS}. */
  readonly video?: number
  /** Audio objects a second. Default {@link AUDIO_PER_SEC}. */
  readonly audio?: number
}

/**
 * One connection receiving `seconds` of video and audio at `headers`, a
 * second's objects at a time, in the page or in a worker it links. Then detail
 * drops back with `resolve()`, and the session ends through `end()`, or the
 * page goes through `pagehide`.
 */
async function record(
  seconds: number,
  ending: 'end' | 'pagehide',
  { realm = 'page', burst = 0, video = VIDEO_FPS, audio = AUDIO_PER_SEC }: RecordOptions = {},
): Promise<Run> {
  const gz = meterGzip()
  const vt = virtualTime(() => gz.open > 0)
  const { posts, impl } = recordingFetch()
  const beaconed: Uint8Array[] = []
  const blobs: Blob[] = []
  const life = ending === 'pagehide' ? capturePagehide() : undefined
  try {
    const c = init(base(), {
      persist: false,
      locks: null,
      fetchImpl: impl,
      ...(ending === 'pagehide'
        ? {
            beacon: (_url: string, blob: Blob) => {
              blobs.push(blob)
              return true
            },
          }
        : { noLifecycleListeners: true }),
      timeOrigin: 0,
      ...vt.ports,
    })
    await vt.advanceTo(0)
    if (realm === 'worker') {
      const channel = new MessageChannel()
      c.linkWorker(channel.port1)
      await vt.advanceTo(0)
      const probe = initWorkerWith(workerBuild, channel.port2, { timeOrigin: 0, ...vt.ports })
      expect(await probe.linked).toBe(true)
    }
    const wt = new (g.WebTransport as new (u: string) => MockWebTransport)('https://relay.test/moq')
    await wt.open('moqt-20')
    // A worker's connection is ready for the page with its next forward, and
    // the page seals at once: that seal comes before detail is raised, as the
    // page's own does.
    await vt.advanceTo(realm === 'worker' ? FORWARD_INTERVAL_MS : 0)
    const uni = wt.incomingUnidirectionalStreams.getReader()
    const deliver = async (bytes: Uint8Array): Promise<void> => {
      const src = wt.deliverUniStream([bytes])
      src.close()
      const arrived = await uni.read()
      const reader = (arrived.value as ReadableStream<Uint8Array>).getReader()
      for (;;) if ((await reader.read()).done) break
    }

    c.escalate('headers')
    await vt.advanceTo(vt.now)
    const from = posts.length
    const start = vt.now
    const second = async (s: number): Promise<void> => {
      await deliver(
        subgroupBytes({
          alias: 4n,
          group: BigInt(s),
          objects: Array.from({ length: video }, (_, i) => ({ id: BigInt(i), bytes: 64 })),
        }),
      )
      await deliver(
        subgroupBytes({
          alias: 5n,
          group: BigInt(s),
          objects: Array.from({ length: audio }, (_, i) => ({ id: BigInt(i), bytes: 16 })),
        }),
      )
    }
    for (let s = 0; s < seconds; s++) {
      await second(s)
      await vt.advanceTo(start + (s + 1) * 1000)
    }
    for (let s = seconds; s < seconds + burst; s++) await second(s)
    // A worker's last objects reach the page with its next forward.
    if (realm === 'worker') await vt.advanceTo(vt.now + FORWARD_INTERVAL_MS)
    const during = posts.slice(from)

    let resolved: EnvelopeRecord[] = []
    if (life !== undefined) life.fire(false)
    else {
      c.resolve()
      await vt.advanceTo(vt.now)
      resolved = await allRecords(posts)
      await c.end()
    }
    await vt.advanceTo(vt.now)
    for (const b of blobs) beaconed.push(new Uint8Array(await b.arrayBuffer()))
    if (life !== undefined) await c.discard()

    const bodies = [...posts.map((p) => p.body), ...beaconed]
    const records: EnvelopeRecord[] = [...(await allRecords(posts))]
    for (const b of beaconed) records.push(...(await allRecords([{ url: '', body: b }])))
    return {
      during,
      bodies,
      beaconed,
      records,
      resolved,
      gzipped: { total: gz.total, largest: gz.largest, piece: gz.piece },
    }
  } finally {
    gz.restore()
    life?.restore()
  }
}

describe('upload rate while detail is raised', () => {
  it('uploads a minute of headers in a few large bodies, losing none', async () => {
    const run = await record(SECONDS, 'end')

    expect(run.during.length).toBeLessThanOrEqual(6)
    for (const b of run.bodies) expect(b.byteLength).toBeLessThan(MAX_BODY_BYTES)
    expect(of(run.records, 'hdr')).toHaveLength(SECONDS * (VIDEO_FPS + AUDIO_PER_SEC))
  }, 60_000)

  // Ten times the objects is a few more uploads, not ten times as many, in
  // the page and in a worker it links alike. Whatever the rate, the page
  // gzips at most twice what it uploads, no one compression is longer than a
  // merge and a step, and no one task of it longer than the piece gzip writes.
  const rates = [
    { video: VIDEO_FPS, audio: AUDIO_PER_SEC, most: 6 },
    { video: 150, audio: 250, most: 6 },
    { video: 300, audio: 500, most: 8 },
  ] as const
  for (const { video, audio, most } of rates) {
    it(`uploads ${video} + ${audio} objects a second as rarely from a worker as from the page`, async () => {
      const page = await record(SECONDS, 'end', { video, audio })
      const worker = await record(SECONDS, 'end', { realm: 'worker', video, audio })

      expect(page.during.length).toBeLessThanOrEqual(most)
      expect(worker.during.length).toBeLessThanOrEqual(page.during.length + 1)
      for (const run of [page, worker]) {
        let raw = 0
        for (const b of run.bodies) {
          expect(b.byteLength).toBeLessThan(MAX_BODY_BYTES)
          raw += await rawSize(b)
        }
        expect(of(run.records, 'hdr')).toHaveLength(SECONDS * (video + audio))
        expect(run.gzipped.total / raw).toBeLessThanOrEqual(2)
        expect(run.gzipped.largest).toBeLessThanOrEqual(LONGEST_GZIP)
        expect(run.gzipped.piece).toBeLessThanOrEqual(GZIP_PIECE)
      }
    }, 60_000)
  }

  it('beacons what is buffered when the page goes, every body within the beacon cap', async () => {
    const run = await record(SECONDS, 'pagehide')

    expect(run.during.length).toBeLessThanOrEqual(6)
    expect(run.beaconed.length).toBeGreaterThan(0)
    for (const b of run.beaconed) expect(b.byteLength).toBeLessThanOrEqual(BEACON_MAX_BYTES)
    expect(of(run.records, 'hdr')).toHaveLength(SECONDS * (VIDEO_FPS + AUDIO_PER_SEC))
    expect(of(run.records, 'end')).toHaveLength(1)
  }, 60_000)

  it('sends the headers buffered at once when detail drops back', async () => {
    const run = await record(10, 'end')

    expect(of(run.resolved, 'hdr')).toHaveLength(10 * (VIDEO_FPS + AUDIO_PER_SEC))
    expect(run.during.length).toBeLessThanOrEqual(2)
  }, 60_000)

  // Over the 256 KB a buffer holds at baseline when the level falls: 20 s of
  // headers, or 5 s and then 20 s delivered at once, before any seal or pack
  // could run. What the page goes with ungzipped goes in bodies the beacon
  // takes.
  const drops = [
    { ending: 'end', steady: 20, burst: 0 },
    { ending: 'pagehide', steady: 20, burst: 0 },
    { ending: 'end', steady: 5, burst: 20 },
    { ending: 'pagehide', steady: 5, burst: 20 },
  ] as const
  for (const { ending, steady, burst } of drops) {
    it(`keeps every record when detail drops back (${ending}, ${steady} s + ${burst} s)`, async () => {
      const run = await record(steady, ending, { burst })

      const changes = of(run.records, 'escalation').map((r) => `${r.from}->${r.to}`)
      expect(changes).toEqual(['baseline->headers', 'headers->baseline'])
      expect(Math.max(...of(run.records, 'batch').map((b) => b.dropped))).toBe(0)
      expect(of(run.records, 'hdr')).toHaveLength((steady + burst) * (VIDEO_FPS + AUDIO_PER_SEC))
      for (const b of run.beaconed) expect(b.byteLength).toBeLessThanOrEqual(BEACON_MAX_BYTES)
    }, 60_000)
  }

  // Everything a pagehide sends shares the beacon's 64 KB, whenever it comes:
  // the runs not yet a body, under the threshold gzipped, and the step not
  // yet gzipped, stored behind them in one body, beside the end record's.
  const unloads = [
    { video: 150, audio: 250 },
    { video: 300, audio: 500 },
  ] as const
  for (const { video, audio } of unloads) {
    it(`beacons at most 64 KB in all, at ${video} + ${audio} objects a second, whenever the page goes`, async () => {
      for (const seconds of [3, 7, 10, 16, 22, 28, 34, 39]) {
        const run = await record(seconds, 'pagehide', { video, audio })

        const total = run.beaconed.reduce((n, b) => n + b.byteLength, 0)
        expect(total, `${seconds} s`).toBeLessThanOrEqual(BEACON_MAX_BYTES)
        const posted = run.bodies.slice(0, run.bodies.length - run.beaconed.length)
        const uploaded = new Set(
          of(await allRecords(posted.map((body) => ({ url: '', body }))), 'batch').map(
            (b) => b.seq,
          ),
        )
        let sealed = 0
        for (const b of run.beaconed) {
          const [batch] = of(await allRecords([{ url: '', body: b }]), 'batch')
          if (!uploaded.has(batch?.seq ?? -1)) sealed += 1
        }
        expect(sealed, `${seconds} s`).toBeLessThanOrEqual(2)
        expect(of(run.records, 'hdr'), `${seconds} s`).toHaveLength(seconds * (video + audio))
        expect(of(run.records, 'end')).toHaveLength(1)
      }
    }, 120_000)
  }
})
