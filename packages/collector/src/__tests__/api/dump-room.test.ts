/**
 * A flight dump and the page's outbox it is sealed into, from the page's own
 * realm and from a linked worker's.
 *
 * Each slice of a dump becomes a body of its own, sealed at once. During an
 * outage the outbox already holds bodies nothing has answered yet, and a dump
 * larger than the room left beside them must give way itself: an older body
 * pushed out to make room for it would be data lost to a recording.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildOf } from '../../api/compose.js'
import { resolveConfig } from '../../api/config.js'
import { resetDormantForTest, teardownDormant } from '../../api/dormant.js'
import type { FlightRecorderFeature, RealmRecorder } from '../../api/features.js'
import { initWith } from '../../api/init.js'
import { envelope, type LinkedMessage, linkMessage } from '../../api/link.js'
import { ProbeRuntime } from '../../api/probe.js'
import { RealmObserver } from '../../api/realm.js'
import type { LinkEvent, MessageTarget } from '../../api/session.js'
import { ALL_DRAFTS } from '../../drafts/all.js'
import { draft20 } from '../../drafts/draft20/decoder.js'
import { ALL_FEATURES } from '../../features/all.js'
import { flightRecorder } from '../../features/flight-recorder.js'
import { type Chunk, ChunkStore, MemoryBackend } from '../../flush/index.js'
import { installWebTransportHook } from '../../transport/index.js'
import type { BatchRecord, EnvelopeRecord, FlightRecord } from '../../types.js'
import { publishBytes, subgroupBytes } from '../decode/vectors.js'
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

describe('a flight dump larger than the outbox has room for', () => {
  it('drops its own oldest slices, never a body the outbox already held', async () => {
    let recorder: RealmRecorder | undefined
    const capturing: FlightRecorderFeature = {
      ...flightRecorder,
      create(d, ring) {
        recorder = flightRecorder.create(d, ring)
        return recorder
      },
    }
    const build = buildOf({
      drafts: ALL_DRAFTS,
      features: ALL_FEATURES.map((f) => (f.feature === 'flightRecorder' ? capturing : f)),
    })

    // An outage: nothing is answered until the test says so.
    let release = (): void => {}
    const outage = new Promise<void>((r) => {
      release = r
    })
    const { posts, impl: answer } = recordingFetch()
    const impl = (async (url: string, init: RequestInit) => {
      await outage
      return answer(url, init)
    }) as unknown as typeof fetch

    const errors: unknown[] = []
    const c = initWith(
      build,
      {
        apiKey: 'pk_test',
        endpoint: 'https://ingest.test/v1/ingest',
        sessionId: 'sess-fixed',
        // The smallest outbox there is: eight bodies' worth.
        storage: { quotaBytes: 0 },
        // Armed, so the ring fills; the test fires the dump itself.
        flightRecorder: { triggers: { stall: { afterMs: 600_000 } } },
        onInternalError: (e) => errors.push(e),
      },
      { ...quiet, fetchImpl: impl },
    )
    const wt = attempt('https://relay.test/w')
    await wt.open('moqt-20')
    await settle(5)

    // Bodies sealed during the outage, waiting in the outbox.
    for (let i = 0; i < 3; i++) {
      c.annotate(`held-${i}`)
      void c.flush()
      await settle(2)
    }

    // Enough objects for a dump of every slice a dump may have.
    const uni = wt.incomingUnidirectionalStreams.getReader()
    const objects = Array.from({ length: 24_000 }, (_, i) => ({ id: BigInt(i), bytes: 1 }))
    wt.deliverUniStream([subgroupBytes({ alias: 4n, group: 0n, objects })]).close()
    const reader = ((await uni.read()).value as ReadableStream<Uint8Array>).getReader()
    for (;;) if ((await reader.read()).done) break
    await settle(5)

    recorder?.fire({ kind: 'stall', atMono: performance.now() + 1, detail: 'test' })
    await settle(5)

    release()
    await c.end()
    await until(() => posts.length > 0)

    const all = await allRecords(posts)
    const notes = all.filter((r) => r.t === 'note').map((r) => (r as { name: string }).name)
    expect(notes).toEqual(['held-0', 'held-1', 'held-2'])
    const batches = of(all, 'batch') as BatchRecord[]
    expect(batches.flatMap((b) => b.lost ?? [])).toEqual([])

    // What is kept is the end of the dump, the moments before the trigger.
    expectTail(all)
    expect(errors).toEqual([])
  })
})

describe('a flight dump larger than the store has room for', () => {
  it('drops its own oldest slices, never a copy another page stored', async () => {
    let recorder: RealmRecorder | undefined
    const capturing: FlightRecorderFeature = {
      ...flightRecorder,
      create(d, ring) {
        recorder = flightRecorder.create(d, ring)
        return recorder
      },
    }
    const build = buildOf({
      drafts: ALL_DRAFTS,
      features: ALL_FEATURES.map((f) => (f.feature === 'flightRecorder' ? capturing : f)),
    })

    // Another tab's bodies, still unsent, fill all but 52 KB of the store:
    // room for one slice's body, and less than the dump's bodies come to.
    const quota = 15 * 64 * 1024 + 52 * 1024
    const store = await ChunkStore.open('db', quota, { backend: new MemoryBackend() })
    const theirs: string[] = []
    for (let seq = 0; seq < 15; seq++) {
      const chunk: Chunk = {
        sessionId: 'sess-other',
        instanceId: 'inst-other',
        seq,
        idempotencyKey: `other-${seq}`,
        createdWallMs: Date.now(),
        bytes: new Uint8Array(64 * 1024),
        level: 'baseline',
        attempts: 0,
      }
      expect(await store.put(chunk, { endpoint: 'https://ingest.test/v1/ingest', keyHash: 'k' }))
      theirs.push(chunk.idempotencyKey)
    }

    let release = (): void => {}
    const outage = new Promise<void>((r) => {
      release = r
    })
    const { posts, impl: answer } = recordingFetch()
    const impl = (async (url: string, init: RequestInit) => {
      await outage
      return answer(url, init)
    }) as unknown as typeof fetch

    const errors: unknown[] = []
    const c = initWith(
      build,
      {
        apiKey: 'pk_test',
        endpoint: 'https://ingest.test/v1/ingest',
        sessionId: 'sess-fixed',
        storage: { quotaBytes: quota },
        flightRecorder: { triggers: { stall: { afterMs: 600_000 } } },
        onInternalError: (e) => errors.push(e),
      },
      { ...quiet, persist: true, store, fetchImpl: impl },
    )
    const wt = attempt('https://relay.test/w')
    await wt.open('moqt-20')
    await settle(5)

    const uni = wt.incomingUnidirectionalStreams.getReader()
    const objects = Array.from({ length: 24_000 }, (_, i) => ({ id: BigInt(i), bytes: 1 }))
    wt.deliverUniStream([subgroupBytes({ alias: 4n, group: 0n, objects })]).close()
    const reader = ((await uni.read()).value as ReadableStream<Uint8Array>).getReader()
    for (;;) if ((await reader.read()).done) break
    await settle(5)

    recorder?.fire({ kind: 'stall', atMono: performance.now() + 1, detail: 'test' })
    await settle(40, 20)

    expect(store.evictedFifo).toBe(0)
    expect(theirs.filter((k) => !store.has(k))).toEqual([])

    release()
    await c.end()
    await until(() => posts.length > 0)
    expectTail(await allRecords(posts))
    expect(errors).toEqual([])
  })
})

/** The kept slices of the one dump in `all`: fewer than it had, its last ones, each marked. */
function expectTail(all: readonly EnvelopeRecord[]): void {
  const slices = of(all, 'flight') as FlightRecord[]
  expect(slices.length).toBeGreaterThan(0)
  const parts = (slices[0] as FlightRecord).parts as number
  expect(slices.length).toBeLessThan(parts)
  expect(slices.map((s) => s.part)).toEqual(
    Array.from({ length: slices.length }, (_, i) => parts - slices.length + i),
  )
  expect(slices.every((s) => s.truncated)).toBe(true)
}

describe("a linked worker's flight dump larger than the outbox has room for", () => {
  it('drops its own oldest slices, never a body the page already held', async () => {
    let release = (): void => {}
    const outage = new Promise<void>((r) => {
      release = r
    })
    const { posts, impl: answer } = recordingFetch()
    const impl = (async (url: string, init: RequestInit) => {
      await outage
      return answer(url, init)
    }) as unknown as typeof fetch

    const errors: unknown[] = []
    const c = initWith(
      buildOf({ drafts: ALL_DRAFTS, features: ALL_FEATURES }),
      {
        apiKey: 'pk_test',
        endpoint: 'https://ingest.test/v1/ingest',
        sessionId: 'sess-fixed',
        storage: { quotaBytes: 0 },
        flightRecorder: { triggers: { stall: { afterMs: 600_000 } } },
        onInternalError: (e) => errors.push(e),
      },
      { ...quiet, fetchImpl: impl },
    )
    attempt()
    await settle(5)

    // The worker's side of the handshake, played by the test: its hello in,
    // and the page's answer with the port the probe forwards over.
    let hello: ((e: LinkEvent) => void) | undefined
    let answered: { message: unknown; port: MessagePort } | undefined
    const target = {
      postMessage: (message: unknown, transfer?: Transferable[]) => {
        answered = { message, port: transfer?.[0] as MessagePort }
      },
      addEventListener: (_type: string, f: (e: LinkEvent) => void) => {
        hello = f
      },
    } as unknown as MessageTarget
    c.linkWorker(target)
    await settle(5)
    hello?.({ data: envelope({ t: 'hello', timeOrigin: performance.timeOrigin }) } as LinkEvent)
    expect(answered).toBeDefined()
    const linked = linkMessage(answered?.message) as unknown as LinkedMessage

    let recorder: RealmRecorder | undefined
    const realm: { WebTransport?: unknown } = { WebTransport: MockWebTransport }
    const probe = new ProbeRuntime(
      linked,
      answered?.port as MessagePort,
      installWebTransportHook(realm, null),
      {
        drafts: workerBuild.drafts,
        recorder: {
          ...flightRecorder,
          create(d, ring) {
            recorder = flightRecorder.create(d, ring)
            return recorder
          },
        },
      },
      // The page's flushes drive the forwards.
      { setTimer: () => 0, clearTimer: () => {}, onInternalError: (e) => errors.push(e) },
    )
    probe.start()

    const wt = new (realm.WebTransport as new (u: string) => MockWebTransport)(
      'https://relay.test/w',
    )
    await wt.open('moqt-20')
    await settle(5)
    const uni = wt.incomingUnidirectionalStreams.getReader()
    const objects = Array.from({ length: 24_000 }, (_, i) => ({ id: BigInt(i), bytes: 1 }))
    wt.deliverUniStream([subgroupBytes({ alias: 4n, group: 0n, objects })]).close()
    const reader = ((await uni.read()).value as ReadableStream<Uint8Array>).getReader()
    for (;;) if ((await reader.read()).done) break
    await settle(5)

    for (let i = 0; i < 3; i++) {
      c.annotate(`held-${i}`)
      void c.flush()
      await settle(20)
    }

    recorder?.fire({ kind: 'stall', atMono: performance.now() + 1, detail: 'test' })
    await settle(40, 20)
    void c.flush()
    await settle(40, 20)

    release()
    await c.end()
    await until(() => posts.length > 0)

    const all = await allRecords(posts)
    const notes = all.filter((r) => r.t === 'note').map((r) => (r as { name: string }).name)
    expect(notes).toEqual(['held-0', 'held-1', 'held-2'])
    const batches = of(all, 'batch') as BatchRecord[]
    expect(batches.flatMap((b) => b.lost ?? [])).toEqual([])
    expectTail(all)
    expect(errors).toEqual([])
  })
})

describe('a flight dump of one slice', () => {
  it('is written however little room the outbox has left, as any record is', () => {
    const config = resolveConfig({
      apiKey: 'pk_test',
      endpoint: 'https://ingest.test/v1/ingest',
      sessionId: 'sess-small',
      flightRecorder: { triggers: { stall: { afterMs: 500 } } },
    })
    const records: EnvelopeRecord[] = []
    const build = buildOf({ drafts: [draft20], features: [flightRecorder] })
    const realm = new RealmObserver({
      realm: 'page',
      config,
      hook: { installed: true, setObserver() {}, uninstall() {} },
      drafts: build.drafts,
      recorder: build.features.flightRecorder,
      originMono: 0,
      clock: { now: () => 0, wall: () => 1_700_000_000_000 },
      host: {
        sink: { json: (r) => records.push(r), raw() {}, pendingBytes: 0 },
        level: () => 'baseline',
        onTrigger() {},
        onConnReady() {},
        onConnClosed() {},
        onOverrun() {},
        onPressure() {},
        onBytes() {},
        flush() {},
        // Less than a body: the outbox is all but full.
        dumpRoom: () => 2048,
        onError: (err) => {
          throw err
        },
      },
    })
    realm.start()
    const id = 's1'
    realm.onSessionOpen({
      id,
      url: 'https://relay.test/moq',
      anchor: { originMono: 0, originWall: 1_700_000_000_000 },
    })
    realm.onSessionProtocol(id, 'moqt-20', 0)
    realm.onStreamData({
      sessionId: id,
      streamId: 1,
      direction: 'rx',
      bidi: true,
      control: true,
      at: 0,
      data: publishBytes(0n, 1n),
    })
    for (let at = 0, stream = 2; at <= 2_000; at += 40, stream++) {
      realm.onStreamData({
        sessionId: id,
        streamId: stream,
        direction: 'rx',
        bidi: false,
        control: false,
        at,
        data: subgroupBytes({ alias: 1n, group: BigInt(at), objects: [{ id: 0n, bytes: 8 }] }),
      })
      realm.onStreamClose(id, stream)
    }
    realm.tick(2_600)

    const dumps = of(records, 'flight') as FlightRecord[]
    expect(dumps).toHaveLength(1)
    expect(dumps[0]?.parts).toBeUndefined()
    expect(dumps[0]?.truncated).toBe(false)
  })
})
