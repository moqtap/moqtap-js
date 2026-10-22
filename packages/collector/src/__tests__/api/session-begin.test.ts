/**
 * When a session exists: from the first `WebTransport` constructed in the page
 * or a linked worker, until its last connection has closed and none has been
 * attempted for {@link IDLE_END_MS}. A page that never constructs one records,
 * stores and sends nothing.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ensureDormantHook, resetDormantForTest, teardownDormant } from '../../api/dormant.js'
import { envelope, type LinkedMessage, linkMessage } from '../../api/link.js'
import { ProbeRuntime } from '../../api/probe.js'
import { IDLE_END_MS, type LinkEvent } from '../../api/session.js'
import { initWorkerWith } from '../../api/worker.js'
import { sha256Hex } from '../../envelope/index.js'
import {
  type Chunk,
  type ChunkBackend,
  ChunkStore,
  DIRECTIVE_HEADER,
  type LockManagerLike,
  MemoryBackend,
  RECV_HEADER,
  SEND_HEADER,
} from '../../flush/index.js'
import { installWebTransportHook } from '../../transport/index.js'
import type { CollectorConfig, EnvelopeRecord } from '../../types.js'
import { attempt, init, workerBuild } from '../support/init.js'
import { settle, until } from '../support/settle.js'
import { allRecords, of, recordingFetch } from '../support/uploads.js'
import { MockWebTransport } from '../transport/mocks.js'

const g = globalThis as unknown as Record<string, unknown>
const ENDPOINT = 'https://ingest.test/v1/ingest'
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
  endpoint: ENDPOINT,
  sessionId: 'sess-fixed',
  ...over,
})

const quiet = { persist: false, noLifecycleListeners: true, locks: null } as const

/** The page's lifecycle listeners, captured so a test can fire them. */
function lifecycle(): { fire(type: string, e?: unknown): void; restore(): void } {
  const prev = g.addEventListener
  const prevRemove = g.removeEventListener
  const handlers = new Map<string, (e: unknown) => void>()
  g.addEventListener = (t: string, f: (e: unknown) => void) => handlers.set(t, f)
  g.removeEventListener = (t: string, f: (e: unknown) => void) => {
    if (handlers.get(t) === f) handlers.delete(t)
  }
  return {
    fire: (type, e = {}) => handlers.get(type)?.(e),
    restore: () => {
      g.addEventListener = prev
      g.removeEventListener = prevRemove
    },
  }
}

/** Every timer the page sets, run by hand. */
function manualTimers() {
  const live = new Map<number, { fn: () => void; ms: number }>()
  let next = 1
  return {
    setTimer: (fn: () => void, ms: number): unknown => {
      const id = next++
      live.set(id, { fn, ms })
      return id
    },
    clearTimer: (h: unknown): void => {
      live.delete(h as number)
    },
    /** How many timers of `ms` are pending. */
    pending: (ms: number): number => [...live.values()].filter((t) => t.ms === ms).length,
    /** Run every pending timer of `ms`, as if that long had passed. */
    run(ms: number): void {
      for (const [id, t] of [...live]) {
        if (t.ms !== ms) continue
        live.delete(id)
        t.fn()
      }
    },
  }
}

/** A store backend that counts every write and read. */
function countingBackend(): { backend: ChunkBackend; ops: string[] } {
  const inner = new MemoryBackend()
  const ops: string[] = []
  const backend: ChunkBackend = {
    durable: inner.durable,
    loadIndex: () => inner.loadIndex(),
    put: (e, c) => {
      ops.push('put')
      return inner.put(e, c)
    },
    get: (k) => {
      ops.push('get')
      return inner.get(k)
    },
    remove: (k) => {
      ops.push('remove')
      return inner.remove(k)
    },
    close: () => inner.close(),
  }
  return { backend, ops }
}

/** A lock manager that records what was requested. */
function recordingLocks(): LockManagerLike & { asked: string[]; queried: number } {
  const asked: string[] = []
  const out = {
    asked,
    queried: 0,
    request(name: string, callback: (lock: unknown) => Promise<unknown> | unknown) {
      asked.push(name)
      return Promise.resolve(callback({ name }))
    },
    query: async () => {
      out.queried += 1
      return { held: [] }
    },
  }
  return out
}

const sessionsOf = (all: readonly EnvelopeRecord[]): string[] => [
  ...new Set(of(all, 'setup').map((s) => s.identity.sessionId)),
]

describe('a page that never constructs a WebTransport', () => {
  it('records, stores, beacons and uploads nothing, whatever it calls and however it ends', async () => {
    const { posts, impl } = recordingFetch()
    const { backend, ops } = countingBackend()
    const store = await ChunkStore.open('db', 1024 * 1024, { backend })
    const lock = recordingLocks()
    const beacons: string[] = []
    const life = lifecycle()
    const doc = g as { document?: { visibilityState: string } }
    try {
      const c = init(base(), {
        store,
        locks: lock,
        fetchImpl: impl,
        beacon: (url) => {
          beacons.push(url)
          return true
        },
      })
      await settle()
      c.setContext({ contentId: 'live/1', tags: { cdn: 'edge-1' } })
      c.annotate('nobody-is-watching')
      c.defineMetric('decodeMs', { unit: 'ms', agg: 'histogram' })
      c.observe('decodeMs', 4)
      c.escalate('headers', 'too early')
      c.resolve()
      await c.flush()
      doc.document = { visibilityState: 'hidden' }
      life.fire('visibilitychange')
      life.fire('pagehide', { persisted: true })
      life.fire('pageshow', { persisted: true })
      life.fire('pagehide', { persisted: false })
      await settle()
      await c.end()

      expect(posts).toEqual([])
      expect(beacons).toEqual([])
      expect(ops).toEqual([])
      expect(lock.asked).toEqual([])
      expect(c.connections()).toEqual([])
    } finally {
      life.restore()
      delete doc.document
    }
  })

  it('leaves an earlier page load’s backlog alone until a session begins', async () => {
    const store = await ChunkStore.open('db', 1024 * 1024, { backend: new MemoryBackend() })
    const left: Chunk = {
      sessionId: 'earlier',
      instanceId: 'dead',
      seq: 0,
      idempotencyKey: 'key-dead-0',
      createdWallMs: Date.now() - 10 * 60_000,
      bytes: new Uint8Array([0x4d, 0x51, 0x54, 0x43, 1, 0, 0, 0]),
      level: 'baseline',
      attempts: 0,
    }
    await store.put(left, { endpoint: ENDPOINT, keyHash: sha256Hex('pk_test') })
    const { posts, impl } = recordingFetch()
    const lock = recordingLocks()
    const c = init(base(), { ...quiet, locks: lock, store, fetchImpl: impl })
    await settle()
    expect(posts).toEqual([])
    expect(lock.queried).toBe(0)
    expect(store.has('key-dead-0')).toBe(true)

    attempt()
    await until(() => posts.some((p) => new URL(p.url).searchParams.get('ik') === 'key-dead-0'))
    expect(lock.asked).toEqual([`moqtap:${c.ids().instanceId}`])
    await c.discard()
  })
})

describe('the first WebTransport begins the session', () => {
  it('in the page, with clock zero at its construction and the ids ids() gave before', async () => {
    const { posts, impl } = recordingFetch()
    const c = init(base({ sessionId: undefined as never }), { ...quiet, fetchImpl: impl })
    await settle()
    const before = c.ids()
    expect(posts).toEqual([])

    const from = performance.now()
    attempt()
    const to = performance.now()
    expect(c.ids()).toEqual(before)
    await c.end()

    const all = await allRecords(posts)
    const [setup] = of(all, 'setup')
    expect(setup?.identity).toEqual(before)
    expect(setup?.idSource).toBe('minted')
    expect(setup?.anchor.originMono).toBeGreaterThanOrEqual(from)
    expect(setup?.anchor.originMono).toBeLessThanOrEqual(to)
    expect(setup).not.toHaveProperty('startTs')
    const [open] = of(all, 'conn-open')
    expect(Math.abs(open?.ts ?? Number.NaN)).toBeLessThan(50)
    for (const b of of(all, 'batch')) {
      expect([b.sessionId, b.instanceId]).toEqual([before.sessionId, before.instanceId])
    }
  })

  it('holds the context set before it, and sends it with setup', async () => {
    const { posts, impl } = recordingFetch()
    const c = init(base({ context: { tags: { experiment: 'a' } } }), {
      ...quiet,
      fetchImpl: impl,
    })
    await settle()
    c.setContext({ contentId: 'live/7', actorId: 'viewer-2', tags: { cdn: 'edge-3' } })
    attempt()
    await c.end()

    const all = await allRecords(posts)
    expect(of(all, 'setup')[0]).toMatchObject({
      identity: { sessionId: 'sess-fixed', contentId: 'live/7', actorId: 'viewer-2' },
      tags: { experiment: 'a', cdn: 'edge-3' },
    })
    expect(of(all, 'context')).toEqual([])
    expect(of(all, 'conn-open')[0]?.contentId).toBe('live/7')
  })

  it('records no page life, annotation, metric sample or escalation from before it; definitions carry', async () => {
    const { posts, impl } = recordingFetch()
    const life = lifecycle()
    const doc = g as { document?: { visibilityState: string } }
    try {
      const c = init(base(), { persist: false, locks: null, fetchImpl: impl })
      await settle()
      c.defineMetric('decodeMs', { unit: 'ms', agg: 'histogram' })
      c.observe('decodeMs', 1)
      c.annotate('before')
      c.escalate('headers', 'before')
      doc.document = { visibilityState: 'hidden' }
      life.fire('visibilitychange')
      doc.document = { visibilityState: 'visible' }
      life.fire('visibilitychange')

      attempt()
      c.observe('decodeMs', 2)
      c.annotate('after')
      await c.end()

      const all = await allRecords(posts)
      expect(of(all, 'note').map((n) => n.name)).toEqual(['after'])
      expect(of(all, 'life')).toEqual([])
      expect(of(all, 'escalation')).toEqual([])
      expect(all.every((r) => r.lvl === 'baseline')).toBe(true)
      const samples = of(all, 'rollup').flatMap((r) => r.custom ?? [])
      expect(samples.map((m) => [m.name, m.hist?.n])).toEqual([['decodeMs', 1]])
    } finally {
      life.restore()
      delete doc.document
    }
  })

  it('reports a connection that failed: the attempt is the session', async () => {
    const { posts, impl } = recordingFetch()
    const c = init(base(), { ...quiet, fetchImpl: impl })
    await settle()
    const wt = attempt()
    wt.failToOpen(new Error('no route'))
    await until(async () => of(await allRecords(posts), 'conn-close').length > 0)
    await c.end()

    const all = await allRecords(posts)
    const [open] = of(all, 'conn-open')
    expect(open).not.toHaveProperty('readyTs')
    expect(of(all, 'conn-close')).toEqual([
      expect.objectContaining({ conn: open?.conn, cause: 'failed' }),
    ])
  })

  it('reports a connection that failed before init(), and begins with it', async () => {
    const { posts, impl } = recordingFetch()
    // Installed as importing the package installs it.
    ensureDormantHook()
    const wt = attempt()
    wt.failToOpen(new Error('no route'))
    await settle(5)
    const c = init(base(), { ...quiet, fetchImpl: impl })
    await settle()
    await c.end()

    const all = await allRecords(posts)
    expect(of(all, 'setup')).toHaveLength(1)
    expect(of(all, 'conn-close')).toEqual([expect.objectContaining({ cause: 'failed' })])
  })

  it('in a linked worker: its construction, forwarded to the page, begins the page’s session', async () => {
    const { posts, impl } = recordingFetch()
    const channel = new MessageChannel()
    const c = init(base(), { ...quiet, fetchImpl: impl })
    c.linkWorker(channel.port1)
    await settle(5)
    // The worker half, in this realm: it claims the hook the page installed,
    // which makes the transports below the worker's.
    const probe = initWorkerWith(workerBuild, channel.port2, { timeOrigin: 0 })
    expect(await probe.linked).toBe(true)
    expect(probe.ids()).toEqual({ sessionId: c.ids().sessionId, instanceId: c.ids().instanceId })
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
    channel.port1.close()
    channel.port2.close()
  })

  it('in a worker that connected before the page linked it, once linked', async () => {
    const { posts, impl } = recordingFetch()
    // The worker is a realm of its own, with its own patched WebTransport.
    const realm: { WebTransport?: unknown } = { WebTransport: MockWebTransport }
    const hook = installWebTransportHook(realm, null)
    const wt = new (realm.WebTransport as new (u: string) => MockWebTransport)(
      'https://relay.test/worker',
    )
    await wt.open('moqt-20')
    await settle(5)

    const c = init(base(), { ...quiet, fetchImpl: impl })
    await settle()
    let listener: ((e: LinkEvent) => void) | undefined
    const ports: MessagePort[] = []
    c.linkWorker({
      postMessage: (m: unknown, transfer?: Transferable[]) => {
        const port = transfer?.[0] as MessagePort | undefined
        if (linkMessage(m)?.t !== 'linked' || port === undefined) return
        ports.push(port)
        new ProbeRuntime(m as unknown as LinkedMessage, port, hook, workerBuild).start()
      },
      addEventListener: (_t, f) => {
        listener = f
      },
    })
    listener?.({ data: envelope({ t: 'hello', timeOrigin: 0 }) })
    await until(() => c.connections().some((x) => x.realm === 'worker'), 2_000)
    await c.end()

    const all = await allRecords(posts)
    expect(Object.assign({}, ...of(all, 'conn-open'))).toMatchObject({ realm: 'worker', draft: 20 })
    for (const p of ports) p.close()
    hook.uninstall()
  })
})

describe('the session ends when its connections have', () => {
  /** A page with one connection that opened and closed, its timers in the test's hands. */
  async function closedOnce(over: Partial<CollectorConfig> = {}) {
    const fetch = recordingFetch()
    const timers = manualTimers()
    const c = init(base(over), { ...quiet, fetchImpl: fetch.impl, ...timers })
    await settle()
    const wt = attempt()
    await wt.open('moqt-20')
    await settle(5)
    return { c, timers, wt, ...fetch }
  }

  it(`ends ${IDLE_END_MS / 1000} s after the last connection closes, and the next construction begins a new session`, async () => {
    const { c, timers, wt, posts } = await closedOnce({ context: { tags: { experiment: 'a' } } })
    c.setContext({ contentId: 'live/1', actorId: 'viewer-1', tags: { cdn: 'edge-1' } })
    const first = c.ids()
    wt.closeSession('done')
    await settle(5)
    expect(timers.pending(IDLE_END_MS)).toBe(1)

    timers.run(IDLE_END_MS)
    await until(async () => of(await allRecords(posts), 'end').length === 1)
    const [end] = of(await allRecords(posts), 'end')
    expect(end?.reason).toBe('idle')

    // Waiting again: new ids at once, the context so far, and nothing sent.
    const second = c.ids()
    expect(second.sessionId).not.toBe(first.sessionId)
    expect(second.instanceId).not.toBe(first.instanceId)
    expect(second).toMatchObject({ contentId: 'live/1', actorId: 'viewer-1' })
    const sent = posts.length
    c.annotate('between')
    await c.flush()
    expect(posts).toHaveLength(sent)

    attempt()
    await c.end()
    const all = await allRecords(posts)
    expect(sessionsOf(all)).toEqual([first.sessionId, second.sessionId])
    const setups = of(all, 'setup')
    expect(setups[1]).toMatchObject({
      identity: second,
      idSource: 'minted',
      tags: { experiment: 'a', cdn: 'edge-1' },
    })
    expect(setups[1]?.anchor.originMono).toBeGreaterThan(setups[0]?.anchor.originMono ?? 0)
    expect(of(all, 'note').map((n) => n.name)).toEqual([])
    expect(of(all, 'end').map((e) => e.reason)).toEqual(['idle', 'app'])
  })

  it('stays one session when a connection is attempted within the wait', async () => {
    const { c, timers, wt, posts } = await closedOnce()
    wt.closeSession('done')
    await settle(5)
    const again = attempt()
    await again.open('moqt-20')
    await settle(5)
    timers.run(IDLE_END_MS)
    await settle(5)
    again.closeSession('done again')
    await settle(5)
    await c.end()

    const all = await allRecords(posts)
    expect(sessionsOf(all)).toHaveLength(1)
    expect(of(all, 'conn-open').map((o) => o.conn)).toHaveLength(4)
    expect(new Set(of(all, 'conn-close').map((x) => x.conn)).size).toBe(2)
    expect(of(all, 'end').map((e) => e.reason)).toEqual(['app'])
  })

  it('closes a capture window open at the end; the next session starts at the configured level', async () => {
    const { c, timers, wt, posts } = await closedOnce()
    c.escalate('headers', 'stall')
    wt.closeSession('done')
    await settle(5)
    timers.run(IDLE_END_MS)
    await until(async () => of(await allRecords(posts), 'end').length === 1)

    attempt()
    await c.end()
    const all = await allRecords(posts)
    const [, second] = sessionsOf(all)
    expect(
      of(all, 'escalation').map((e) => [e.from, e.to, e.by.kind]),
      'opened, then closed with the session',
    ).toEqual([
      ['baseline', 'headers', 'manual'],
      ['headers', 'baseline', 'manual'],
    ])
    const secondSetup = of(all, 'setup').find((s) => s.identity.sessionId === second)
    expect(secondSetup?.lvl).toBe('baseline')
  })
})

describe('what ingest asked of a session', () => {
  it('ends with it: the next session seals on the usual schedule, at the configured level', async () => {
    const serverNow = 5_000_000_000_000
    let first = ''
    const { posts, impl } = recordingFetch((n) => {
      const url = posts[n]?.url ?? ''
      return {
        [RECV_HEADER]: String(serverNow),
        [SEND_HEADER]: String(serverNow),
        ...(first !== '' && url.includes(`i=${first}`)
          ? {
              [DIRECTIVE_HEADER]: JSON.stringify({
                flushMs: 2_000,
                until: serverNow + 60_000,
                elevate: { level: 'headers', until: serverNow + 60_000, reason: 'watching' },
              }),
            }
          : {}),
      }
    })
    const timers = manualTimers()
    const c = init(base(), { ...quiet, fetchImpl: impl, ...timers })
    await settle()
    const wt = attempt()
    first = c.ids().instanceId
    await wt.open('moqt-20')
    await c.flush()
    expect(timers.pending(2_000)).toBe(1)
    wt.closeSession('done')
    await settle(5)
    timers.run(IDLE_END_MS)
    await until(async () => of(await allRecords(posts), 'end').length === 1)
    expect(timers.pending(2_000)).toBe(0)

    attempt()
    await c.flush()
    expect(timers.pending(2_000)).toBe(0)
    await c.end()
    const all = await allRecords(posts)
    const [, second] = sessionsOf(all)
    const secondSetup = of(all, 'setup').find((x) => x.identity.sessionId === second)
    expect(secondSetup?.lvl).toBe('baseline')
    expect(of(all, 'escalation').map((e) => [e.to, e.by.kind])).toEqual([
      ['headers', 'remote'],
      ['baseline', 'manual'],
    ])
  })
})

describe('newSession()', () => {
  it('with no connection open, ends the session, and the next construction begins the new one', async () => {
    const { posts, impl } = recordingFetch()
    const c = init(base(), { ...quiet, fetchImpl: impl })
    await settle()
    const wt = attempt()
    wt.closeSession('done')
    await settle(5)
    const next = c.newSession({ contentId: 'vod/2' })
    await until(async () => of(await allRecords(posts), 'end').length === 1)
    expect(of(await allRecords(posts), 'end')[0]?.reason).toBe('new-session')
    const sent = posts.length
    await settle()
    expect(posts).toHaveLength(sent)

    attempt()
    await c.end()
    const all = await allRecords(posts)
    expect(of(all, 'setup').map((s) => s.identity)).toEqual([
      expect.objectContaining({ sessionId: 'sess-fixed' }),
      next,
    ])
    expect(of(all, 'setup')[1]).not.toHaveProperty('startTs')
  })

  it('before any connection, only changes the ids the first construction begins', async () => {
    const { posts, impl } = recordingFetch()
    const c = init(base(), { ...quiet, fetchImpl: impl })
    await settle()
    const next = c.newSession({ sessionId: 'playback-2', contentId: 'vod/2' })
    expect(c.ids()).toEqual(next)
    await settle()
    expect(posts).toEqual([])

    attempt()
    await c.end()
    const all = await allRecords(posts)
    expect(of(all, 'setup')).toEqual([
      expect.objectContaining({ identity: next, idSource: 'supplied' }),
    ])
    expect(of(all, 'end').map((e) => e.reason)).toEqual(['app'])
  })
})
