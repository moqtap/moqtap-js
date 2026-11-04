/**
 * A viewer session is one page across every WebTransport it opens: a new
 * connection per video to the same relay and path, one connection reused
 * across videos, one connection per stream on its own path, other relays,
 * and the same namespace on several relays and paths, in turn or at once.
 * Every body keeps the page's one session and instance, every connection
 * keeps its own ordinal and relay, and no connection's objects are lost or
 * merged into another's.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetDormantForTest, teardownDormant } from '../../api/dormant.js'
import type { CollectorConfig } from '../../types.js'
import { subgroupBytes } from '../decode/vectors.js'
import { init } from '../support/init.js'
import { allFacts } from '../support/runs.js'
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

// No supplied session id: the page mints one, and must keep it.
const config: CollectorConfig = { apiKey: 'pk_test', endpoint: 'https://ingest.test/v1/ingest' }
const quiet = { persist: false, noLifecycleListeners: true, locks: null } as const

type Ctor = new (url: string, o?: Record<string, unknown>) => MockWebTransport

interface Conn {
  readonly wt: MockWebTransport
  readonly uni: ReadableStreamDefaultReader<ReadableStream<Uint8Array>>
}

async function open(url: string): Promise<Conn> {
  const wt = new (g.WebTransport as Ctor)(url)
  await wt.open('moqt-20')
  await settle(5)
  return { wt, uni: wt.incomingUnidirectionalStreams.getReader() }
}

/** One subgroup stream of `alias`'s group `group`, two objects, read to its FIN. */
async function group(c: Conn, alias: bigint, group: bigint): Promise<void> {
  const bytes = subgroupBytes({
    alias,
    group,
    objects: [
      { id: 0n, bytes: 10 },
      { id: 1n, bytes: 10 },
    ],
  })
  const src = c.wt.deliverUniStream([bytes])
  const arrived = await c.uni.read()
  const reader = (arrived.value as ReadableStream<Uint8Array>).getReader()
  await reader.read()
  src.close()
  await reader.read()
  await settle(2)
}

async function close(c: Conn): Promise<void> {
  c.wt.close({ closeCode: 0, reason: 'next video' })
  await settle(5)
}

/** The page's sessions and instances, each connection's relay, and every run's (c, g). */
async function seen(posts: readonly Post[]) {
  const batches = of(await allRecords(posts), 'batch')
  const relays = new Map<number, string>()
  for (const b of batches) for (const c of b.conn) relays.set(c.c, c.relay)
  const { runs } = await allFacts(posts.map((p) => p.body))
  return {
    sessions: new Set(batches.map((b) => b.sessionId)),
    instances: new Set(batches.map((b) => b.instanceId)),
    relays: [...relays].sort(([a], [b]) => a - b),
    runs: runs.map((r) => [r.c, r.key, r.g, r.ids.length]).sort(),
  }
}

const twoObjects = (c: number, alias: bigint, g: bigint) => [c, `rx:alias:${alias}:0`, g, 2]

describe('one session across every connection the page opens', () => {
  it('a new WebTransport per video, to the same relay and path', async () => {
    const { posts, impl } = recordingFetch()
    const m = init(config, { ...quiet, fetchImpl: impl })
    await settle()
    for (let video = 0; video < 3; video++) {
      const c = await open('https://relay.test/moq')
      await group(c, 4n, BigInt(video))
      await m.flush()
      await close(c)
    }
    const id = m.ids()
    await m.end()
    const s = await seen(posts)
    expect(s.sessions).toEqual(new Set([id.sessionId]))
    expect(s.instances.size).toBe(1)
    expect(s.relays).toEqual([
      [0, 'https://relay.test/moq'],
      [1, 'https://relay.test/moq'],
      [2, 'https://relay.test/moq'],
    ])
    expect(s.runs).toEqual(
      [twoObjects(0, 4n, 0n), twoObjects(1, 4n, 1n), twoObjects(2, 4n, 2n)].sort(),
    )
  })

  it('one connection reused across videos', async () => {
    const { posts, impl } = recordingFetch()
    const m = init(config, { ...quiet, fetchImpl: impl })
    await settle()
    const c = await open('https://relay.test/moq')
    for (let video = 0; video < 3; video++) {
      await group(c, BigInt(4 + video), 0n)
      await m.flush()
    }
    await close(c)
    const id = m.ids()
    await m.end()
    const s = await seen(posts)
    expect(s.sessions).toEqual(new Set([id.sessionId]))
    expect(s.instances.size).toBe(1)
    expect(s.relays).toEqual([[0, 'https://relay.test/moq']])
    expect(s.runs).toEqual(
      [twoObjects(0, 4n, 0n), twoObjects(0, 5n, 0n), twoObjects(0, 6n, 0n)].sort(),
    )
  })

  it('one connection per stream, each on its own path, at once', async () => {
    const { posts, impl } = recordingFetch()
    const m = init(config, { ...quiet, fetchImpl: impl })
    await settle()
    const video = await open('https://relay.test/moq/video')
    const audio = await open('https://relay.test/moq/audio')
    await group(video, 4n, 0n)
    await group(audio, 4n, 0n)
    await group(video, 4n, 1n)
    await group(audio, 4n, 1n)
    await close(video)
    await close(audio)
    const id = m.ids()
    await m.end()
    const s = await seen(posts)
    expect(s.sessions).toEqual(new Set([id.sessionId]))
    expect(s.instances.size).toBe(1)
    expect(s.relays).toEqual([
      [0, 'https://relay.test/moq/video'],
      [1, 'https://relay.test/moq/audio'],
    ])
    expect(s.runs).toEqual(
      [
        twoObjects(0, 4n, 0n),
        twoObjects(0, 4n, 1n),
        twoObjects(1, 4n, 0n),
        twoObjects(1, 4n, 1n),
      ].sort(),
    )
  })

  for (const atOnce of [false, true]) {
    it(`different relays, and one namespace on several relays and paths, ${atOnce ? 'at once' : 'in turn'}`, async () => {
      const { posts, impl } = recordingFetch()
      const m = init(config, { ...quiet, fetchImpl: impl })
      await settle()
      const urls = [
        'https://relay-a.test/moq',
        'https://relay-b.test:4443/moq',
        'https://relay-a.test/edge/moq',
        'moqt://relay-c.test/live',
      ]
      if (atOnce) {
        const conns: Conn[] = []
        for (const u of urls) conns.push(await open(u))
        // The same alias on each: the relays' own numbering of one namespace's track.
        for (const c of conns) await group(c, 4n, 7n)
        for (const c of conns) await close(c)
      } else {
        for (const u of urls) {
          const c = await open(u)
          await group(c, 4n, 7n)
          await m.flush()
          await close(c)
        }
      }
      const id = m.ids()
      await m.end()
      const s = await seen(posts)
      expect(s.sessions).toEqual(new Set([id.sessionId]))
      expect(s.instances.size).toBe(1)
      expect(s.relays).toEqual(urls.map((u, i) => [i, u]))
      expect(s.runs).toEqual(urls.map((_, i) => twoObjects(i, 4n, 7n)).sort())
    })
  }
})
