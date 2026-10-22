/**
 * What a session says about itself: its tags, the context `setContext()`
 * changes mid-session, and an actor id that never leaves the device raw when
 * `privacy.hashActorId` is on.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type ConfigProblem, MAX_TAGS, resolveConfig } from '../../api/config.js'
import { resetDormantForTest, teardownDormant } from '../../api/dormant.js'
import { MQ1114 } from '../../codes.js'
import { sha256Hex } from '../../envelope/index.js'
import type { CollectorConfig } from '../../types.js'
import { attempt, init } from '../support/init.js'
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

const quiet = { persist: false, noLifecycleListeners: true, locks: null } as const

/** Everything the page uploaded, as text, to look for a value anywhere in it. */
async function uploadedText(posts: readonly Post[]): Promise<string> {
  return JSON.stringify(await allRecords(posts))
}

describe('tags', () => {
  it('ride on the setup record', async () => {
    const { posts, impl } = recordingFetch()
    const c = init(base({ context: { tags: { experiment: 'abr-b', cdn: 'edge-2' } } }), {
      ...quiet,
      fetchImpl: impl,
    })
    await settle()
    attempt()
    await c.end()
    expect(of(await allRecords(posts), 'setup')[0]?.tags).toEqual({
      experiment: 'abr-b',
      cdn: 'edge-2',
    })
  })

  it('leave the setup record without any', async () => {
    const { posts, impl } = recordingFetch()
    const c = init(base(), { ...quiet, fetchImpl: impl })
    await settle()
    attempt()
    await c.end()
    expect(of(await allRecords(posts), 'setup')[0]).not.toHaveProperty('tags')
  })

  it('outside their bounds are reported and left out, never cut', () => {
    const problems: ConfigProblem[] = []
    const tags: Record<string, unknown> = {
      ok: 'yes',
      '': 'empty key',
      ['k'.repeat(33)]: 'long key',
      long: 'v'.repeat(129),
      empty: '',
      number: 7,
      broken: 'a\uD800',
      edge: 'v'.repeat(128),
    }
    const resolved = resolveConfig(base({ context: { tags: tags as Record<string, string> } }), {
      onProblem: (p) => problems.push(p),
    })
    expect(resolved.context.tags).toEqual({ ok: 'yes', edge: 'v'.repeat(128) })
    expect(problems.map((p) => [p.code, p.got])).toEqual([
      [MQ1114, ''],
      [MQ1114, 'k'.repeat(32)],
      [MQ1114, 'long'],
      [MQ1114, 'empty'],
      [MQ1114, 'number'],
      [MQ1114, 'broken'],
    ])
  })

  it('stop at sixteen', () => {
    const problems: ConfigProblem[] = []
    const tags: Record<string, string> = {}
    for (let i = 0; i < MAX_TAGS + 2; i++) tags[`t${i}`] = 'x'
    const resolved = resolveConfig(base({ context: { tags } }), {
      onProblem: (p) => problems.push(p),
    })
    expect(Object.keys(resolved.context.tags)).toHaveLength(MAX_TAGS)
    expect(problems.map((p) => p.got)).toEqual(['t16', 't17'])
  })

  it('keep a key named __proto__ as a tag', () => {
    const tags = JSON.parse('{"__proto__":"x"}') as Record<string, string>
    const resolved = resolveConfig(base({ context: { tags } }))
    expect(Object.hasOwn(resolved.context.tags, '__proto__')).toBe(true)
    expect(JSON.parse(JSON.stringify(resolved.context.tags))).toEqual(tags)
  })
})

describe('setContext()', () => {
  it('writes a context record with what the call set, from that moment', async () => {
    const { posts, impl } = recordingFetch()
    const c = init(base({ context: { tags: { experiment: 'a' } } }), {
      ...quiet,
      fetchImpl: impl,
    })
    await settle()
    attempt()
    c.annotate('before')
    c.setContext({ contentId: 'live/2', actorId: 'viewer-4', tags: { cdn: 'edge-1' } })
    c.setContext({ tags: { experiment: 'b' } })
    await c.end()

    const all = await allRecords(posts)
    const context = of(all, 'context')
    expect(context).toEqual([
      {
        t: 'context',
        ts: expect.any(Number),
        lvl: 'baseline',
        contentId: 'live/2',
        actorId: 'viewer-4',
        tags: { cdn: 'edge-1' },
      },
      { t: 'context', ts: expect.any(Number), lvl: 'baseline', tags: { experiment: 'b' } },
    ])
    // After the setup record, which the instance's first body opens with.
    const order = all.map((r) => r.t)
    expect(order.indexOf('context')).toBeGreaterThan(order.indexOf('setup'))
  })

  it('writes nothing when it changes nothing', async () => {
    const { posts, impl } = recordingFetch()
    const errors: unknown[] = []
    const c = init(base({ onInternalError: (e) => errors.push(e) }), {
      ...quiet,
      fetchImpl: impl,
    })
    await settle()
    attempt()
    c.annotate('something to send')
    c.setContext({})
    c.setContext({ tags: { '': 'bad' } })
    await c.end()
    expect(of(await allRecords(posts), 'context')).toEqual([])
    expect(errors.map(String)).toEqual([`Error: ${MQ1114}: context.tags `])
  })

  it('carries the session’s tags into the next session', async () => {
    const { posts, impl } = recordingFetch()
    const c = init(base({ context: { tags: { experiment: 'a' } } }), {
      ...quiet,
      fetchImpl: impl,
    })
    await settle()
    attempt()
    c.setContext({ tags: { cdn: 'edge-1' } })
    c.newSession({ contentId: 'vod/2' })
    c.annotate('second')
    await c.end()
    const setups = of(await allRecords(posts), 'setup')
    expect(setups).toHaveLength(2)
    expect(setups[1]?.tags).toEqual({ experiment: 'a', cdn: 'edge-1' })
  })
})

describe('privacy.hashActorId', () => {
  const hashed = (id: string) => sha256Hex(`pk_test:${id}`).slice(0, 32)

  it('sends the hash and never the raw id, and ids() reports the hash', async () => {
    const { posts, impl } = recordingFetch()
    const c = init(
      base({ context: { actorId: 'alice@example.com' }, privacy: { hashActorId: true } }),
      { ...quiet, fetchImpl: impl },
    )
    expect(c.ids().actorId).toBe(hashed('alice@example.com'))
    expect(c.ids().actorId).toMatch(/^[0-9a-f]{32}$/)
    await settle()
    attempt()
    c.annotate('before the change')
    c.setContext({ actorId: 'bob@example.com' })
    expect(c.ids().actorId).toBe(hashed('bob@example.com'))
    await c.end()

    const all = await allRecords(posts)
    expect(of(all, 'setup')[0]?.identity.actorId).toBe(hashed('alice@example.com'))
    expect(of(all, 'context')[0]?.actorId).toBe(hashed('bob@example.com'))
    expect(await uploadedText(posts)).not.toContain('example.com')
  })

  it('hashes a setContext() made before the collector has started', async () => {
    const { posts, impl } = recordingFetch()
    const c = init(base({ privacy: { hashActorId: true } }), { ...quiet, fetchImpl: impl })
    c.setContext({ actorId: 'carol' })
    expect(c.ids().actorId).toBe(hashed('carol'))
    await settle()
    attempt()
    c.newSession()
    expect(c.ids().actorId).toBe(hashed('carol'))
    await c.end()
    expect(await uploadedText(posts)).not.toContain('carol')
  })

  it('is off by default: the id is sent as given', async () => {
    const { posts, impl } = recordingFetch()
    const c = init(base({ context: { actorId: 'dave' } }), { ...quiet, fetchImpl: impl })
    expect(c.ids().actorId).toBe('dave')
    await settle()
    attempt()
    await c.end()
    expect(of(await allRecords(posts), 'setup')[0]?.identity.actorId).toBe('dave')
  })

  it('is reported and left off when it is not a boolean', () => {
    const problems: ConfigProblem[] = []
    const resolved = resolveConfig(
      base({ context: { actorId: 'erin' }, privacy: { hashActorId: 'yes' as never } }),
      { onProblem: (p) => problems.push(p) },
    )
    expect(resolved.context.actorId).toBe('erin')
    expect(problems).toEqual([expect.objectContaining({ key: 'privacy.hashActorId' })])
  })
})
