/**
 * How uploads time objects: `object` by default, `group` when the integrator
 * chooses it or ingest states it on the clock exchange or an upload's answer,
 * the lower of the two, one timing per body.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type ConfigProblem, resolveConfig } from '../../api/config.js'
import { resetDormantForTest, teardownDormant } from '../../api/dormant.js'
import { DIRECTIVE_HEADER, parseDirective } from '../../flush/index.js'
import type { BatchRecord, CollectorConfig, Directive } from '../../types.js'
import { subgroupBytes } from '../decode/vectors.js'
import { init } from '../support/init.js'
import { factsOf } from '../support/runs.js'
import { settle } from '../support/settle.js'
import { of, type Post, recordsOf } from '../support/uploads.js'
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
  ...over,
})

const quiet = { persist: false, noLifecycleListeners: true, locks: null } as const

/** Ingest answering the clock exchange and each upload with its own directive. */
function answering(clock: Directive | null, upload: (n: number) => Directive | null) {
  const posts: Post[] = []
  const reply = (status: number, d: Directive | null) =>
    ({
      ok: true,
      status,
      headers: {
        get: (n: string) =>
          n.toLowerCase() === DIRECTIVE_HEADER && d !== null ? JSON.stringify(d) : null,
      },
    }) as unknown as Response
  const impl = (async (url: string, init: RequestInit) => {
    if (String(url).includes('/v1/clock')) return reply(204, clock)
    const body =
      init.body instanceof Blob
        ? new Uint8Array(await init.body.arrayBuffer())
        : new Uint8Array(init.body as unknown as ArrayBufferLike as never)
    posts.push({ url, body })
    return reply(200, upload(posts.length - 1))
  }) as unknown as typeof fetch
  return { posts, impl }
}

/** A subgroup stream of `n` objects in `group`, read to its end. */
async function deliver(wt: MockWebTransport, group: bigint, n: number): Promise<void> {
  const uni = wt.incomingUnidirectionalStreams.getReader()
  const objects = Array.from({ length: n }, (_, i) => ({ id: BigInt(i), bytes: 10 }))
  wt.deliverUniStream([subgroupBytes({ alias: 4n, group, objects })]).close()
  const reader = ((await uni.read()).value as ReadableStream<Uint8Array>).getReader()
  for (;;) if ((await reader.read()).done) break
  uni.releaseLock()
  await settle(2)
}

async function open(): Promise<MockWebTransport> {
  const wt = new (g.WebTransport as new (u: string) => MockWebTransport)('https://relay.test/moq')
  await wt.open('moqt-20')
  await settle(5)
  return wt
}

/** Each body's timing and the dt count of each of its runs, the bodies with runs only. */
async function timings(posts: readonly Post[]): Promise<{ timing: string; dt: number[] }[]> {
  const out: { timing: string; dt: number[] }[] = []
  for (const p of posts) {
    const f = await factsOf(p.body)
    if (f.runs.length === 0) continue
    const batch = of(await recordsOf(p.body), 'batch')[0] as BatchRecord
    out.push({ timing: batch.timing ?? 'object', dt: f.runs.map((r) => r.dt.length) })
    expect(f.timing).toBe(out.at(-1)!.timing)
  }
  return out
}

describe('timing', () => {
  it('times each object by default', async () => {
    const { posts, impl } = answering(null, () => null)
    const c = init(base(), { ...quiet, fetchImpl: impl })
    await settle()
    await deliver(await open(), 1n, 3)
    await c.flush()
    await c.end()
    expect(await timings(posts)).toEqual([{ timing: 'object', dt: [2] }])
  })

  it('times per run once the clock exchange states group', async () => {
    const { posts, impl } = answering({ timing: 'group' }, () => ({ timing: 'group' }))
    const c = init(base(), { ...quiet, fetchImpl: impl })
    await settle()
    await deliver(await open(), 1n, 3)
    await c.flush()
    await c.end()
    expect(await timings(posts)).toEqual([{ timing: 'group', dt: [0] }])
  })

  it('takes group from an upload answer for later bodies, never object over the integrator', async () => {
    let lower = false
    const lowered = answering(null, () => (lower ? { timing: 'group' } : null))
    const c = init(base(), { ...quiet, fetchImpl: lowered.impl })
    await settle()
    const wt = await open()
    await deliver(wt, 1n, 3)
    await c.flush()
    lower = true
    c.annotate('answered at group')
    await c.flush()
    await deliver(wt, 2n, 3)
    await c.flush()
    await c.end()
    expect(await timings(lowered.posts)).toEqual([
      { timing: 'object', dt: [2] },
      { timing: 'group', dt: [0] },
    ])
  })

  it("keeps the integrator's group when ingest states object", async () => {
    const { posts, impl } = answering({ timing: 'object' }, () => ({ timing: 'object' }))
    const c = init(base({ upload: { timing: 'group' } }), { ...quiet, fetchImpl: impl })
    await settle()
    await deliver(await open(), 1n, 3)
    await c.flush()
    await c.end()
    expect(await timings(posts)).toEqual([{ timing: 'group', dt: [0] }])
  })
})

describe('reading timing', () => {
  it('reads object or group from the directive, nothing else', () => {
    expect(parseDirective('{"timing":"group"}')).toEqual({ timing: 'group' })
    expect(parseDirective('{"flushMs":2000,"timing":"object"}')).toEqual({
      flushMs: 2_000,
      timing: 'object',
    })
    expect(parseDirective('{"timing":"frame"}')).toBeUndefined()
  })

  it('reports an upload.timing that is neither, and uses object', () => {
    const problems: ConfigProblem[] = []
    const c = resolveConfig(base({ upload: { timing: 'frames' as never } }), {
      onProblem: (p) => problems.push(p),
    })
    expect(c.upload.timing).toBe('object')
    expect(problems).toEqual([{ key: 'upload.timing', code: 'MQ1116', got: '"frames"' }])
    expect(resolveConfig(base({ upload: { timing: 'group' } })).upload.timing).toBe('group')
  })
})
