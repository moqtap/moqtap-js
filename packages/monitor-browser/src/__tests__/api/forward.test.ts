/**
 * What a probe hands its page: its frames as they are, once and in order, its
 * runs and marks with times on the page's clock, and its closed rollups.
 * A run still open at a forward is continued by the next forward's.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveConfig } from '../../api/config.js'
import { resetDormantForTest, teardownDormant } from '../../api/dormant.js'
import {
  envelope,
  type ForwardMessage,
  type ForwardPart,
  type LinkedMessage,
  linkMessage,
} from '../../api/link.js'
import { ProbeRuntime } from '../../api/probe.js'
import { readFrames } from '../../envelope/index.js'
import { RunRecorder } from '../../rollup/runs.js'
import { installWebTransportHook } from '../../transport/index.js'
import type { ClockSource, DetailLevel, EnvelopeRecord } from '../../types.js'
import { subgroupBytes } from '../decode/vectors.js'
import { workerBuild } from '../support/init.js'
import { settle } from '../support/settle.js'
import { MockWebTransport } from '../transport/mocks.js'

interface Harness {
  readonly forwards: ForwardMessage[]
  readonly errors: unknown[]
  /** Deliver `objects` objects of group `group` on the probe's transport. */
  send(group: number, objects: number): Promise<void>
  /** As {@link send}, leaving the stream open; the result ends it with FIN. */
  sendOpen(group: number, objects: number): Promise<() => Promise<void>>
  forward(): void
  /** The page's detail level, as the page announces it. */
  level(level: DetailLevel): void
  /** The page's next session began, its clock where this one's was. */
  session(): void
  /** Close the rollup interval, as the probe's metrics timer does. */
  tick(): void
  stop(): void
}

async function harness(
  level: DetailLevel = 'headers+sizes',
  clock?: ClockSource,
): Promise<Harness> {
  const forwards: ForwardMessage[] = []
  const errors: unknown[] = []
  let onmessage: ((e: MessageEvent) => void) | undefined
  const port = {
    postMessage: (m: unknown) => {
      const f = linkMessage(m)
      if (f?.t === 'fwd') forwards.push(f as unknown as ForwardMessage)
    },
    set onmessage(f: (e: MessageEvent) => void) {
      onmessage = f
    },
    close: () => {},
  } as unknown as MessagePort
  const { metrics, flightRecorder, limits, privacy, upload, context } = resolveConfig({
    apiKey: 'pk_test',
    endpoint: 'https://ingest.test/v1/ingest',
  })
  const linked: LinkedMessage = {
    t: 'linked',
    sessionId: 'sess',
    instanceId: 'inst',
    base: 0,
    mono: 0,
    connBase: 1 << 20,
    level,
    room: 8 * 1024 * 1024,
    config: { metrics, flightRecorder, limits, privacy, upload, context },
  }
  const realm: { WebTransport?: unknown } = { WebTransport: MockWebTransport }
  const hook = installWebTransportHook(realm, null)
  // The probe's own timers never fire here: the test runs each one it needs.
  const timers: { fn: () => void; ms: number }[] = []
  const probe = new ProbeRuntime(linked, port, hook, workerBuild, {
    ...(clock !== undefined ? { clock } : {}),
    setTimer: (fn, ms) => timers.push({ fn, ms }),
    clearTimer: () => {},
    onInternalError: (e) => errors.push(e),
  })
  probe.start()
  const wt = new (realm.WebTransport as new (u: string) => MockWebTransport)('https://relay.test/w')
  await wt.open('moqt-20')
  await settle(5)
  const uni = wt.incomingUnidirectionalStreams.getReader()
  return {
    forwards,
    errors,
    async send(group, n) {
      const objects = Array.from({ length: n }, (_, i) => ({ id: BigInt(i), bytes: 1 }))
      const src = wt.deliverUniStream([subgroupBytes({ alias: 4n, group: BigInt(group), objects })])
      src.close()
      const arrived = await uni.read()
      const reader = (arrived.value as ReadableStream<Uint8Array>).getReader()
      for (;;) if ((await reader.read()).done) break
      await settle(2)
    },
    async sendOpen(group, n) {
      const objects = Array.from({ length: n }, (_, i) => ({ id: BigInt(i), bytes: 1 }))
      const src = wt.deliverUniStream([subgroupBytes({ alias: 4n, group: BigInt(group), objects })])
      const arrived = await uni.read()
      const reader = (arrived.value as ReadableStream<Uint8Array>).getReader()
      await reader.read()
      await settle(2)
      return async () => {
        src.close()
        for (;;) if ((await reader.read()).done) break
        await settle(2)
      }
    },
    forward: () => onmessage?.({ data: envelope({ t: 'forward' }) } as MessageEvent),
    level: (level) => onmessage?.({ data: envelope({ t: 'level', level }) } as MessageEvent),
    session: () =>
      onmessage?.({
        data: envelope({ t: 'session', sessionId: 'sess-2', instanceId: 'inst', level, base: 0 }),
      } as MessageEvent),
    tick: () => timers.find((t) => t.ms === metrics.intervalMs)?.fn(),
    stop: () => onmessage?.({ data: envelope({ t: 'unlinked' }) } as MessageEvent),
  }
}

/** The records in a forward's parts, in order, reading the stand-in compressor's output as it is. */
function records(parts: readonly ForwardPart[]): EnvelopeRecord[] {
  const out: EnvelopeRecord[] = []
  const decoder = new TextDecoder()
  for (const p of parts) {
    const bytes = new Uint8Array(p.frames, 0, p.byteLength)
    for (const f of readFrames(bytes)) {
      if (!f.raw) out.push(JSON.parse(decoder.decode(f.payload)) as EnvelopeRecord)
    }
  }
  return out
}

const hdrGroups = (all: readonly EnvelopeRecord[]): string[] =>
  all.flatMap((r) => (r.t === 'hdr' ? [r.group] : []))

beforeEach(() => {
  MockWebTransport.instances = []
})

afterEach(() => {
  teardownDormant()
  resetDormantForTest()
})

describe('a probe’s frames', () => {
  it('forwards frames as they are, in parts the page takes at baseline, every one in order', async () => {
    const h = await harness()
    for (let group = 0; group < 8; group += 1) await h.send(group, 100)
    h.forward()
    await settle(20)
    h.stop()

    expect(h.forwards).toHaveLength(1)
    const parts = h.forwards[0]?.parts ?? []
    for (const p of parts) expect(p.byteLength).toBeLessThanOrEqual(8 * 32 * 1024)
    expect(parts.reduce((n, p) => n + p.n, 0)).toBe(h.forwards[0]?.n)
    const groups = hdrGroups(records(parts))
    expect(groups).toHaveLength(800)
    expect(groups).toEqual([...groups].sort((a, b) => Number(a) - Number(b)))
  })
})

describe('a probe’s runs', () => {
  it('forwards each group as a run, on its own connection ordinal, with every object', async () => {
    const h = await harness('baseline')
    await h.send(0, 5)
    await h.send(1, 3)
    h.forward()
    await settle(5)
    h.stop()

    const runs = h.forwards.flatMap((f) => f.runs?.runs ?? [])
    expect(runs.map((r) => [r.g, r.n, r.end])).toEqual([
      [0n, 5, 'fin'],
      [1n, 3, 'fin'],
    ])
    expect(runs.every((r) => r.c === 1 << 20 && r.path === 'sub_stream')).toBe(true)
    expect(runs.every((r) => !r.cont)).toBe(true)
  })

  it('forwards a FIN after the forward that took its run, which the page joins to it', async () => {
    const h = await harness('baseline')
    const fin = await h.sendOpen(0, 3)
    h.forward()
    await fin()
    h.forward()
    await settle(5)
    h.stop()

    const pieces = h.forwards.flatMap((f) => (f.runs === undefined ? [] : [f.runs]))
    expect(pieces.map((t) => t.runs.map((r) => [r.n, r.end]))).toEqual([[[3, 'open']], [[0, 'fin']]])
    const page = new RunRecorder(0)
    for (const t of pieces) page.absorb(t)
    expect(page.take().runs.map((r) => [r.g, r.n, r.end])).toEqual([[0n, 3, 'fin']])
  })

  it('keeps a connection’s ordinal when the page’s next session begins', async () => {
    const h = await harness('baseline')
    await h.send(0, 1)
    h.forward()
    h.session()
    await settle(5)
    await h.send(1, 1)
    h.forward()
    await settle(5)
    h.stop()

    const runs = h.forwards.flatMap((f) => f.runs?.runs ?? [])
    expect(runs.map((r) => [r.g, r.c])).toEqual([
      [0n, 1 << 20],
      [1n, 1 << 20],
    ])
  })

  it('names its connections with their ordinals beside the runs', async () => {
    const h = await harness('baseline')
    await h.send(0, 1)
    h.forward()
    await settle(5)
    h.stop()
    expect(h.forwards[0]?.conns.map((s) => [s.conn.c, s.conn.draft])).toEqual([[1 << 20, 20]])
  })
})

describe('a probe’s clock', () => {
  it('forwards what it captured before a break at once, marked, and what came after later', async () => {
    let skew = 0
    const clock: ClockSource = {
      now: () => performance.now(),
      wall: () => performance.now() + skew,
    }
    const h = await harness('baseline', clock)
    await h.send(0, 2)
    // Suspended: the monotonic clock stood still while wall time went on.
    skew = 60_000
    await h.send(1, 2)
    h.forward()
    await settle(5)
    h.stop()

    const marked = h.forwards.filter((f) => f.brk === true)
    expect(marked).toHaveLength(1)
    expect(marked[0]?.runs?.runs.map((r) => r.g)).toEqual([0n])
    const after = h.forwards.slice(h.forwards.indexOf(marked[0]!) + 1)
    expect(after.flatMap((f) => f.runs?.runs.map((r) => r.g) ?? [])).toEqual([1n])
  })
})

describe('a probe’s rollups', () => {
  it('hands the page each closed interval beside the frames rather than in them', async () => {
    const h = await harness()
    await h.send(0, 3)
    h.tick()
    h.forward()
    await settle(5)
    h.stop()

    const [f] = h.forwards
    expect(records(f?.parts ?? []).filter((r) => r.t === 'rollup')).toEqual([])
    expect(f?.rollups?.map((r) => r.tracks.map((t) => t.key.d))).toEqual([['rx']])
    expect(f?.conns[0]).not.toHaveProperty('rollup')
  })
})
