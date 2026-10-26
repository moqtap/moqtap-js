/**
 * A build carries the drafts and features its entry names and behaves as
 * that build: a call needing a feature it lacks is reported once and ignored,
 * and a page that imports no draft leaves its own `WebTransport` alone while
 * its linked workers record.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildOf, workerBuildOf } from '../../api/compose.js'
import { resetDormantForTest, teardownDormant } from '../../api/dormant.js'
import { type InitOptions, initWith } from '../../api/init.js'
import { initWorkerWith } from '../../api/worker.js'
import { MQ1006 } from '../../codes.js'
import { draft20 } from '../../drafts/draft20/decoder.js'
import { escalation } from '../../features/escalation.js'
import { workers } from '../../features/workers.js'
import type { CollectorConfig } from '../../types.js'
import { attempt, workerBuild } from '../support/init.js'
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

const quiet = { persist: false, noLifecycleListeners: true, locks: null } as const

function config(errors: string[], over: Partial<CollectorConfig> = {}): CollectorConfig {
  return {
    apiKey: 'pk_test',
    endpoint: 'https://ingest.test/v1/ingest',
    sessionId: 'sess-fixed',
    onInternalError: (e) => errors.push(String((e as Error).message)),
    ...over,
  }
}

const missing = (errors: readonly string[], feature: string): number =>
  errors.filter((m) => m.startsWith(MQ1006) && m.endsWith(feature)).length

describe('a thin build', () => {
  const thin = buildOf({ drafts: [draft20] })
  const init = (c: CollectorConfig, o: InitOptions = {}) => initWith(thin, c, { ...quiet, ...o })

  it('reports each call that needs a missing feature, once, and records the session', async () => {
    const errors: string[] = []
    const { posts, impl } = recordingFetch()
    const c = init(config(errors), { fetchImpl: impl })
    const wt = attempt()
    await wt.open('moqt-20')
    await until(() => c.connections().length > 0, 2_000)

    c.linkWorker(new MessageChannel().port1)
    c.linkWorker(new MessageChannel().port1)
    c.escalate('headers')
    c.escalate('headers')
    c.defineMetric('rebuffer', { unit: 'count', agg: 'sum' })
    c.observe('rebuffer', 1)
    await settle(5)
    expect(missing(errors, 'workers')).toBe(1)
    expect(missing(errors, 'escalation')).toBe(1)
    expect(missing(errors, 'customMetrics')).toBe(1)

    await c.end()
    const all = await allRecords(posts)
    expect(Object.assign({}, ...of(all, 'conn-open'))).toMatchObject({ realm: 'page', draft: 20 })
    expect(of(all, 'escalation')).toEqual([])
    expect(of(all, 'link')).toEqual([])
    expect(of(all, 'end')).toHaveLength(1)
  })

  it('reports options that need a missing feature', () => {
    const errors: string[] = []
    init(
      config(errors, {
        detail: 'headers',
        flightRecorder: { triggers: { stall: { afterMs: 2_000 } } },
      }),
    )
    expect(missing(errors, 'escalation')).toBe(1)
    expect(missing(errors, 'flightRecorder')).toBe(1)
  })
})

describe('triggers in a page with no recorder of its own', () => {
  it('does not ask for the recorder when linked workers run the triggers', () => {
    const errors: string[] = []
    const page = buildOf({ features: [workers, escalation] })
    initWith(
      page,
      config(errors, { flightRecorder: { triggers: { stall: { afterMs: 500 } } } }),
      quiet,
    )
    expect(missing(errors, 'flightRecorder')).toBe(0)
    expect(missing(errors, 'escalation')).toBe(0)
  })

  it('asks for the recorder once a worker without one links', async () => {
    const errors: string[] = []
    const page = buildOf({ features: [workers, escalation] })
    const channel = new MessageChannel()
    const c = initWith(
      page,
      config(errors, { flightRecorder: { triggers: { stall: { afterMs: 500 } } } }),
      quiet,
    )
    c.linkWorker(channel.port1)
    await settle(5)
    const probe = initWorkerWith(workerBuildOf({ drafts: [draft20] }), channel.port2, {
      timeOrigin: 0,
    })
    expect(await probe.linked).toBe(true)
    await settle(5)
    expect(missing(errors, 'flightRecorder')).toBe(1)
    await c.end()
    channel.port1.close()
    channel.port2.close()
  })

  it('does not ask for the recorder when the linked worker has one', async () => {
    const errors: string[] = []
    const page = buildOf({ features: [workers, escalation] })
    const channel = new MessageChannel()
    const c = initWith(
      page,
      config(errors, { flightRecorder: { triggers: { stall: { afterMs: 500 } } } }),
      quiet,
    )
    c.linkWorker(channel.port1)
    await settle(5)
    const probe = initWorkerWith(workerBuild, channel.port2, { timeOrigin: 0 })
    expect(await probe.linked).toBe(true)
    await settle(5)
    expect(missing(errors, 'flightRecorder')).toBe(0)
    await c.end()
    channel.port1.close()
    channel.port2.close()
  })

  it('asks for the recorder once a WebTransport opens in a page that has none', async () => {
    const errors: string[] = []
    const page = buildOf({ drafts: [draft20], features: [workers, escalation] })
    const { impl } = recordingFetch()
    const c = initWith(
      page,
      config(errors, { flightRecorder: { triggers: { stall: { afterMs: 500 } } } }),
      { ...quiet, fetchImpl: impl },
    )
    expect(missing(errors, 'flightRecorder')).toBe(0)
    const wt = attempt()
    await wt.open('moqt-20')
    await until(() => c.connections().length > 0, 2_000)
    await settle(5)
    expect(missing(errors, 'flightRecorder')).toBe(1)
    await c.end()
  })
})

describe('a page that imports no draft', () => {
  const linked = buildOf({ features: [workers] })

  it('leaves its own WebTransport alone', async () => {
    const errors: string[] = []
    const { posts, impl } = recordingFetch()
    const c = initWith(linked, config(errors), { ...quiet, fetchImpl: impl })
    expect(g.WebTransport).toBe(MockWebTransport)
    const wt = attempt()
    await wt.open('moqt-20')
    await settle(5)
    expect(c.connections()).toEqual([])
    expect(c.connectionIdOf(wt as unknown as WebTransport)).toBeUndefined()
    await c.end()
    expect(posts).toEqual([])
  })

  it('records what its linked worker forwards, from the worker’s first WebTransport', async () => {
    const errors: string[] = []
    const { posts, impl } = recordingFetch()
    const channel = new MessageChannel()
    const c = initWith(linked, config(errors), { ...quiet, fetchImpl: impl })
    c.linkWorker(channel.port1)
    await settle(5)
    // The worker half, in this realm: the hook it installs is the worker's.
    const probe = initWorkerWith(workerBuild, channel.port2, { timeOrigin: 0 })
    expect(await probe.linked).toBe(true)
    await settle(5)
    expect(posts).toEqual([])

    const wt = attempt()
    await wt.open('moqt-20')
    await until(() => c.connections().some((x) => x.realm === 'worker'), 2_000)
    await c.end()

    const all = await allRecords(posts)
    expect(of(all, 'setup')).toHaveLength(1)
    expect(Object.assign({}, ...of(all, 'conn-open'))).toMatchObject({ realm: 'worker', draft: 20 })
    expect(of(all, 'link')).toEqual([expect.objectContaining({ link: 'w1', ev: 'linked' })])
    expect(of(all, 'end')).toHaveLength(1)
    expect(errors).toEqual([])
    channel.port1.close()
    channel.port2.close()
  })
})
