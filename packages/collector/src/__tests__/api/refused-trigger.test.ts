/**
 * A linked worker's trigger the page refuses. The page owns the capture
 * window, so the worker's level always ends where the page decided: a worker
 * told the page is capped does not raise, and one that raised ahead of a
 * refusal is brought back down by the page's answer.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildOf } from '../../api/compose.js'
import { resetDormantForTest, teardownDormant } from '../../api/dormant.js'
import { initWith } from '../../api/init.js'
import { envelope, FORWARD_INTERVAL_MS, linkMessage } from '../../api/link.js'
import { initWorkerWith } from '../../api/worker.js'
import { escalation } from '../../features/escalation.js'
import { flightRecorder } from '../../features/flight-recorder.js'
import { workers } from '../../features/workers.js'
import {
  ChunkStore,
  DIRECTIVE_HEADER,
  MemoryBackend,
  RECV_HEADER,
  SEND_HEADER,
} from '../../flush/index.js'
import type { CollectorConfig } from '../../types.js'
import { subgroupBytes } from '../decode/vectors.js'
import { attempt, init, workerBuild } from '../support/init.js'
import { settle, until } from '../support/settle.js'
import { allRecords, of, recordingFetch } from '../support/uploads.js'
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

/** A page that records only what its workers forward, so the worker's hook is the one in this realm. */
const pageBuild = buildOf({ features: [workers, escalation, flightRecorder] })

const quiet = { persist: false, noLifecycleListeners: true, locks: null } as const

const SERVER_NOW = 5_000_000_000_000

/** Every upload answered with a hold for the next hour. */
function holding() {
  return recordingFetch(() => ({
    [RECV_HEADER]: String(SERVER_NOW),
    [SEND_HEADER]: String(SERVER_NOW),
    [DIRECTIVE_HEADER]: JSON.stringify({ hold: { until: SERVER_NOW + 3_600_000 } }),
  }))
}

const config = (errors: unknown[]): CollectorConfig => ({
  apiKey: 'pk_test',
  endpoint: 'https://ingest.test/v1/ingest',
  sessionId: 'sess-fixed',
  flightRecorder: { triggers: { stall: { afterMs: 30 } } },
  onInternalError: (e) => errors.push(e),
})

describe('a worker trigger under a hold', () => {
  it('leaves the worker at baseline, writing no per-object headers', async () => {
    const errors: unknown[] = []
    const { posts, impl } = holding()
    const channel = new MessageChannel()
    const c = initWith(pageBuild, config(errors), { ...quiet, fetchImpl: impl })
    c.linkWorker(channel.port1)
    await settle(5)
    const probe = initWorkerWith(workerBuild, channel.port2, { timeOrigin: 0 })
    expect(await probe.linked).toBe(true)

    const wt = attempt('https://relay.test/w')
    await wt.open('moqt-20')
    await until(() => c.connections().some((x) => x.realm === 'worker'), 2_000)
    // The answer carries the hold; the page tells the worker it is capped.
    c.annotate('x')
    await c.flush()
    await settle(10)

    const uni = wt.incomingUnidirectionalStreams.getReader()
    const send = async (group: number): Promise<void> => {
      const objects = [{ id: 0n, bytes: 1 }]
      const src = wt.deliverUniStream([subgroupBytes({ alias: 4n, group: BigInt(group), objects })])
      src.close()
      const reader = ((await uni.read()).value as ReadableStream<Uint8Array>).getReader()
      for (;;) if ((await reader.read()).done) break
      await settle(2)
    }
    // A steady track, one object every few milliseconds: a stall needs an
    // established cadence shorter than its threshold.
    for (let group = 1; group <= 25; group++) {
      await send(group)
      await new Promise((r) => setTimeout(r, 5))
    }
    // A gap past the stall threshold: the next object fires the trigger.
    await new Promise((r) => setTimeout(r, 80))
    await send(26)
    await settle(10)
    await send(27)
    // The probe's next forward, which carries everything since the trigger.
    await new Promise((r) => setTimeout(r, FORWARD_INTERVAL_MS + 50))
    await c.end()

    const all = await allRecords(posts)
    expect(of(all, 'flight').length, 'the trigger fired').toBeGreaterThan(0)
    expect(of(all, 'flight').map((f) => f.lvl)).toEqual(of(all, 'flight').map(() => 'baseline'))
    expect(of(all, 'hdr')).toEqual([])
    expect(of(all, 'escalation')).toEqual([])
    channel.port1.close()
    channel.port2.close()
  })

  it('is answered with the page’s level, so a worker that raised ahead of it comes back down', async () => {
    const errors: unknown[] = []
    const { impl } = holding()
    const channel = new MessageChannel()
    const c = initWith(pageBuild, config(errors), { ...quiet, fetchImpl: impl })
    c.linkWorker(channel.port1)
    const heard: Record<string, unknown>[] = []
    const linked = new Promise<MessagePort>((resolve) => {
      channel.port2.onmessage = (e: MessageEvent) => {
        if (linkMessage(e.data)?.t === 'linked' && e.ports[0] !== undefined) resolve(e.ports[0])
      }
    })
    channel.port2.postMessage(envelope({ t: 'hello', timeOrigin: 0 }))
    const port = await linked
    port.onmessage = (e: MessageEvent) => {
      const m = linkMessage(e.data)
      if (m !== null) heard.push(m)
    }
    port.postMessage(envelope({ t: 'open' }))
    await settle(10)
    c.annotate('x')
    await c.flush()
    await settle(10)

    heard.length = 0
    port.postMessage(envelope({ t: 'trigger', kind: 'stall', at: 1 }))
    await until(() => heard.some((m) => m.t === 'level'))
    expect(heard.filter((m) => m.t === 'level')).toEqual([
      expect.objectContaining({ t: 'level', level: 'baseline', capped: true }),
    ])
    await c.end()
    port.close()
    channel.port1.close()
    channel.port2.close()
  })
})

describe('a hold heard by an earlier page load', () => {
  it('holds the next one from its start, before its own first answer', async () => {
    const backend = new MemoryBackend()
    const first = holding()
    const errors: unknown[] = []
    const one = init(config(errors), {
      ...quiet,
      store: await ChunkStore.open('db', 1 << 20, { backend }),
      fetchImpl: first.impl,
    })
    attempt()
    await settle(5)
    one.annotate('x')
    await one.flush()
    expect(first.posts.length).toBeGreaterThan(0)
    await one.end()

    // The next page load: its uploads are never answered.
    const second = recordingFetch()
    const two = init(config(errors), {
      ...quiet,
      store: await ChunkStore.open('db', 1 << 20, { backend }),
      fetchImpl: second.impl,
    })
    attempt()
    await settle(5)
    two.escalate('headers', 'held')
    await two.end()
    expect(of(await allRecords(second.posts), 'escalation')).toEqual([])
  })
})

describe('a hold heard by an earlier session in the page', () => {
  it('holds the next one from its start, with no store to keep it in', async () => {
    let answering = true
    const { posts, impl } = recordingFetch(() =>
      answering
        ? {
            [RECV_HEADER]: String(SERVER_NOW),
            [SEND_HEADER]: String(SERVER_NOW),
            [DIRECTIVE_HEADER]: JSON.stringify({ hold: { until: SERVER_NOW + 3_600_000 } }),
          }
        : {},
    )
    const errors: unknown[] = []
    const c = init(config(errors), { ...quiet, fetchImpl: impl })
    attempt()
    await settle(5)
    c.annotate('x')
    await c.flush()
    expect(posts.length).toBeGreaterThan(0)

    // The next session's uploads say nothing of the hold.
    answering = false
    c.newSession()
    c.escalate('headers', 'held')
    await c.end()
    expect(of(await allRecords(posts), 'escalation')).toEqual([])
  })
})
