/**
 * The fast cadence an upload reply asks for, both ways: a watch (`flushMs`
 * 2 s until the mark ends) and a standing seal (`flushMs` 20 s, `until` 60 s ahead on
 * every reply), in the shapes ingest sends, taken at once, renewed by each
 * reply, and given up at `until`, never later than a seal already stated.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_UPLOAD } from '../../api/defaults.js'
import { resetDormantForTest, teardownDormant, useDormantClockForTest } from '../../api/dormant.js'
import { DIRECTIVE_HEADER, RECV_HEADER, SEND_HEADER } from '../../flush/index.js'
import type { CollectorConfig, Directive } from '../../types.js'
import { subgroupBytes } from '../decode/vectors.js'
import { compressing } from '../support/gzip-busy.js'
import { init } from '../support/init.js'
import { of, type Post, preambleOf, recordingFetch, recordsOf } from '../support/uploads.js'
import { virtualTime } from '../support/virtual-time.js'
import { MockWebTransport } from '../transport/mocks.js'

vi.mock('../../envelope/gzip.js', async (original) =>
  (await import('../support/gzip-busy.js')).meteredGzip(original),
)

const g = globalThis as unknown as Record<string, unknown>
let originalWT: unknown

beforeEach(() => {
  originalWT = g.WebTransport
  MockWebTransport.instances = []
  g.WebTransport = MockWebTransport
})

afterEach(() => {
  useDormantClockForTest(undefined)
  teardownDormant()
  resetDormantForTest()
  g.WebTransport = originalWT
})

const S = 1_000
const MINUTE = 60_000
const LAST_EARLY = Math.max(...DEFAULT_UPLOAD.earlyFlushesMs)

/** The server's wall clock at the page's mono 0. */
const SERVER_ZERO = 5_000_000_000_000

/** The watched seal, and how long a standing seal holds after each reply. */
const WATCH_MS = 2_000
const STANDING_TTL_MS = 60_000

/**
 * The directive ingest sends at page time `t`: while the watch mark (ending
 * at `watch(t)`) runs, the shorter of 2 s and the standing seal until the
 * mark ends; else the standing seal for 60 s.
 */
function collector(o: {
  watch?: (t: number) => number | null
  standingMs?: (t: number) => number | null
}) {
  return (t: number): Directive | null => {
    const standing = o.standingMs?.(t) ?? null
    const markEnd = o.watch?.(t) ?? null
    if (markEnd !== null && markEnd > t) {
      return { flushMs: Math.min(WATCH_MS, standing ?? WATCH_MS), until: SERVER_ZERO + markEnd }
    }
    if (standing !== null) return { flushMs: standing, until: SERVER_ZERO + t + STANDING_TTL_MS }
    return null
  }
}

/** A page with one connection open, every upload answered by `directive` at the page's time. */
async function openPage(
  directive: (t: number) => Directive | null,
  over: Partial<CollectorConfig> = {},
) {
  const vt = virtualTime(compressing)
  // Arrivals stamped on the page's clock.
  useDormantClockForTest(vt.ports.clock)
  const { posts, impl } = recordingFetch(() => {
    const d = directive(vt.now)
    return {
      [RECV_HEADER]: String(SERVER_ZERO + vt.now),
      [SEND_HEADER]: String(SERVER_ZERO + vt.now),
      ...(d !== null ? { [DIRECTIVE_HEADER]: JSON.stringify(d) } : {}),
    }
  })
  const c = init(
    { apiKey: 'pk_test', endpoint: 'https://ingest.test/v1/ingest', ...over },
    {
      persist: false,
      locks: null,
      fetchImpl: impl,
      noLifecycleListeners: true,
      timeOrigin: 0,
      ...vt.ports,
    },
  )
  await vt.advanceTo(0)
  const wt = new (g.WebTransport as new (u: string) => MockWebTransport)('https://relay.test/moq')
  await wt.open('moqt-20')
  await vt.advanceTo(0)
  const uni = wt.incomingUnidirectionalStreams.getReader()
  /** One subgroup stream of `n` objects, read to its end. */
  const deliver = async (group: number, n: number): Promise<void> => {
    const bytes = subgroupBytes({
      alias: 4n,
      group: BigInt(group),
      objects: Array.from({ length: n }, (_, i) => ({ id: BigInt(i), bytes: 64 })),
    })
    const src = wt.deliverUniStream([bytes])
    src.close()
    const reader = ((await uni.read()).value as ReadableStream<Uint8Array>).getReader()
    for (;;) if ((await reader.read()).done) break
  }
  return { vt, posts, c, wt, deliver }
}

async function seals(posts: readonly Post[]) {
  const out = []
  for (const p of posts) {
    const { seal } = preambleOf(p.body)
    out.push({ ...seal, at: seal.through_us / 1000, records: await recordsOf(p.body) })
  }
  return out
}

type Seal = Awaited<ReturnType<typeof seals>>[number]

/**
 * One chain of bodies, each sealed no later than the seal the one before it
 * stated (a directive may seal sooner), none stating a seal past its interval
 * in force. `exact`: each at that seal, as when the schedule alone seals.
 */
function expectChain(all: readonly Seal[], exact = false): void {
  for (let i = 0; i < all.length; i++) {
    const s = all[i] as Seal
    expect((s.next_us as number) - s.through_us).toBeLessThanOrEqual(s.ms * 1000)
    if (i === 0) continue
    const prev = all[i - 1] as Seal
    expect(s.seq).toBe(prev.seq + 1)
    expect(s.from_us).toBe(prev.through_us)
    if (exact) expect(s.through_us).toBe(prev.next_us)
    else expect(s.through_us).toBeLessThanOrEqual(prev.next_us as number)
  }
}

const range = (from: number, to: number, step: number): number[] => {
  const out: number[] = []
  for (let t = from; t <= to; t += step) out.push(t)
  return out
}

describe('watched: flushMs 2 s until the mark ends', () => {
  it('takes 2 s at the reply that asks for it, renews on each reply, and falls back at until', async () => {
    // A watch from 100 s, its mark renewed to 10 s ahead until 130 s.
    const answer = collector({
      watch: (t) => (t >= 100 * S && t < 130 * S ? t + 10 * S : null),
    })
    const { vt, posts, c } = await openPage(answer)
    await vt.advanceTo(300 * S)
    const all = await seals(posts)
    expectChain(all)
    // 105 s is the first reply inside the watch: the next seal is 2 s on, not
    // the 165 s that body stated. The last renewal, at 129 s, holds to 139 s.
    expect(all.map((s) => s.at)).toEqual([
      0,
      LAST_EARLY,
      LAST_EARLY + MINUTE,
      ...range(107 * S, 139 * S, WATCH_MS),
      139 * S + MINUTE,
      139 * S + 2 * MINUTE,
    ])
    expect(all.filter((s) => s.at > 105 * S && s.at < 139 * S).map((s) => s.ms)).toEqual(
      range(107 * S, 137 * S, WATCH_MS).map(() => WATCH_MS),
    )
    expect(all.filter((s) => s.at >= 139 * S).map((s) => s.ms)).toEqual([MINUTE, MINUTE, MINUTE])
    for (const s of all.slice(1)) expect(s.records.map((r) => r.t)).toEqual(['batch'])
    await c.end()
  }, 60_000)

  it('falls back when the mark ends, though each reply names the same end', async () => {
    // One mark, 0 s to 20 s, as ingest reads it: every reply states its end.
    const answer = collector({ watch: (t) => (t < 20 * S ? 20 * S : null) })
    const { vt, posts, c } = await openPage(answer)
    await vt.advanceTo(200 * S)
    const all = await seals(posts)
    expectChain(all)
    expect(all.map((s) => [s.at, s.ms])).toEqual([
      [0, MINUTE],
      ...range(2 * S, 20 * S, WATCH_MS).map((t) => [t, WATCH_MS]),
      // The 20 s body stated 22 s; from there the early seal, then the interval.
      [22 * S, MINUTE],
      [LAST_EARLY, MINUTE],
      [22 * S + MINUTE, MINUTE],
      [22 * S + 2 * MINUTE, MINUTE],
    ])
    await c.end()
  }, 60_000)

  it('stays fast across a watch reopened before the last one lapsed', async () => {
    const answer = collector({
      watch: (t) => (t < 10 * S ? 10 * S : t < 30 * S ? 30 * S : null),
    })
    const { vt, posts, c } = await openPage(answer)
    await vt.advanceTo(40 * S)
    const all = await seals(posts)
    expectChain(all)
    expect(all.map((s) => s.at)).toEqual(range(0, 32 * S, WATCH_MS))
    expect(all.at(-1)?.ms).toBe(MINUTE)
    await c.end()
  }, 60_000)
})

describe('standing: flushMs 20 s, until 60 s ahead on every reply', () => {
  it('holds 20 s while replies renew it, and falls back 60 s after the last one', async () => {
    // A standing 20 s seal until 300 s, then none.
    const answer = collector({ standingMs: (t) => (t < 300 * S ? 20 * S : null) })
    const { vt, posts, c } = await openPage(answer)
    await vt.advanceTo(600 * S)
    const all = await seals(posts)
    expectChain(all)
    // The reply at 0 s keeps the 45 s early seal that body stated, and seals at 20 s first.
    expect(all.slice(0, 4).map((s) => s.at)).toEqual([0, 20 * S, 40 * S, LAST_EARLY])
    // The last renewal came at 280 s, so 20 s seals hold to 340 s, then 60 s.
    expect(all.slice(4).map((s) => [s.at, s.ms])).toEqual([
      ...range(60 * S, 320 * S, 20 * S).map((t) => [t, 20 * S]),
      ...range(340 * S, 580 * S, MINUTE).map((t) => [t, MINUTE]),
    ])
    await c.end()
  }, 60_000)

  it('goes from the standing seal to a watch and back, and keeps the seal each body stated', async () => {
    // A standing seal throughout; a watch from 60 s, its mark ending at 90 s.
    const answer = collector({
      standingMs: () => 20 * S,
      watch: (t) => (t >= 60 * S && t < 90 * S ? 90 * S : null),
    })
    const { vt, posts, c } = await openPage(answer)
    await vt.advanceTo(200 * S)
    const all = await seals(posts)
    expectChain(all)
    // The 60 s reply asks for the watch: every 2 s from 62 s to the mark's end.
    expect(all.map((s) => s.at).filter((t) => t >= 60 * S && t <= 90 * S)).toEqual(
      range(60 * S, 90 * S, WATCH_MS),
    )
    // The 90 s body stated 92 s; the standing 20 s from there.
    expect(all.filter((s) => s.at > 90 * S).map((s) => [s.at, s.ms])).toEqual(
      range(92 * S, 192 * S, 20 * S).map((t) => [t, 20 * S]),
    )
    await c.end()
  }, 60_000)
})

describe('min(configured, directed)', () => {
  it('keeps a configured interval shorter than the standing seal', async () => {
    const answer = collector({ standingMs: () => 20 * S })
    const { vt, posts, c } = await openPage(answer, {
      upload: { intervalMs: 10 * S, earlyFlushesMs: [] },
    })
    await vt.advanceTo(100 * S)
    const all = await seals(posts)
    expectChain(all)
    expect(all.map((s) => [s.at, s.ms])).toEqual(range(0, 100 * S, 10 * S).map((t) => [t, 10 * S]))
    await c.end()
  }, 60_000)

  it('takes a watch shorter than the configured interval, then the configured one', async () => {
    const answer = collector({ watch: (t) => (t < 10 * S ? 10 * S : null) })
    const { vt, posts, c } = await openPage(answer, {
      upload: { intervalMs: 15 * S, earlyFlushesMs: [] },
    })
    await vt.advanceTo(60 * S)
    const all = await seals(posts)
    expectChain(all)
    expect(all.map((s) => [s.at, s.ms])).toEqual([
      [0, 15 * S],
      ...range(2 * S, 10 * S, WATCH_MS).map((t) => [t, WATCH_MS]),
      ...range(12 * S, 57 * S, 15 * S).map((t) => [t, 15 * S]),
    ])
    await c.end()
  }, 60_000)
})

describe('the byte threshold', () => {
  it('seals early and restarts the interval, unwatched', async () => {
    const { vt, posts, c, deliver } = await openPage(() => null, {
      upload: { byteThreshold: 1_024, earlyFlushesMs: [] },
    })
    await vt.advanceTo(10 * S)
    for (let k = 0; k < 20; k++) {
      await deliver(k, 30)
      await vt.advanceTo(10 * S + (k + 1) * 100)
    }
    const quiet = vt.now
    await vt.advanceTo(quiet + 3 * MINUTE)
    const all = await seals(posts)
    expectChain(all, false)
    // Sealed by bytes, inside the first interval.
    expect(all.filter((s) => s.at > 0 && s.at < MINUTE).length).toBeGreaterThan(1)
    // The last byte seal restarted the interval: it states 60 s on, and the
    // schedule seals every 60 s from there.
    const byBytes = all.filter((s) => s.at <= quiet).length
    const last = all[byBytes - 1] as Seal
    expect(((last.next_us as number) - last.through_us) / 1000).toBe(MINUTE)
    expect(all.slice(byBytes).map((s) => s.at)).toEqual([1, 2, 3].map((k) => last.at + k * MINUTE))
    expectChain(all.slice(byBytes - 1), true)
    await c.end()
  }, 60_000)

  it('seals early while watched and keeps the 2 s cadence from that seal', async () => {
    const answer = collector({ watch: (t) => (t < 30 * S ? 30 * S : null) })
    const { vt, posts, c, deliver } = await openPage(answer, {
      upload: { byteThreshold: 1_024, earlyFlushesMs: [] },
    })
    await vt.advanceTo(5 * S)
    for (let k = 0; k < 20; k++) {
      await deliver(k, 30)
      await vt.advanceTo(5 * S + (k + 1) * 40)
    }
    const quiet = vt.now
    await vt.advanceTo(29 * S)
    // Picked by seal time, not by how many bodies were posted at a step: a
    // body still gzipping when the clock moves on posts after the step.
    const all = await seals(posts)
    expectChain(all, false)
    const before = all.findIndex((s) => s.at >= 5 * S)
    const byBytes = all.filter((s) => s.at <= quiet).length
    const early = all.slice(before, byBytes)
    expect(early.length).toBeGreaterThan(0)
    for (const s of early) expect(s.at % WATCH_MS).not.toBe(0)
    // From the last byte seal, every 2 s again.
    const last = all[byBytes - 1] as Seal
    expect(all.slice(byBytes).map((s) => s.at)).toEqual(range(last.at + WATCH_MS, 29 * S, WATCH_MS))
    expectChain(all.slice(byBytes - 1), true)
    await c.end()
  }, 60_000)
})

describe('raised detail under a watch', () => {
  it('keeps the watched cadence while a capture window raises detail and after it ends', async () => {
    const watch = collector({ watch: (x) => (x < 30 * S ? 30 * S : null) })
    const answer = (t: number): Directive | null => {
      const d = watch(t)
      return t < 10 * S
        ? { ...d, elevate: { level: 'headers', until: SERVER_ZERO + 10 * S, reason: 'w' } }
        : d
    }
    const { vt, posts, c } = await openPage(answer)
    await vt.advanceTo(30 * S)
    const all = await seals(posts)
    expectChain(all, false)
    const at = all.map((s) => s.at)
    for (let i = 1; i < at.length; i++) {
      expect((at[i] as number) - (at[i - 1] as number)).toBeLessThanOrEqual(WATCH_MS)
    }
    expect(at.at(-1)).toBe(30 * S)
    // Raised by the first reply, and back to baseline at the window's end.
    const levels = of(
      all.flatMap((s) => s.records),
      'escalation',
    )
    expect(levels.length).toBeGreaterThanOrEqual(2)
    await c.end()
  }, 60_000)
})
