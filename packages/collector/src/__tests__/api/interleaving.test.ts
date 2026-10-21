/**
 * The page and its probes under random interleavings of everything that can
 * happen to a page in the field: workers terminated, or dying without a word;
 * the page frozen into the back/forward cache and restored, hidden and shown;
 * the network dropping; the browser refusing the unload beacon; a new session
 * started mid-playback. Each run ends the way a page ends, and is followed by
 * the next page load on the origin, which sends whatever was left behind.
 *
 * Whatever the interleaving, what ingest receives must keep three properties:
 *
 *  - **one key per body**: a key always names the same frames, however many
 *    times and by whichever path the body arrived, and is the SHA-256 of
 *    `sessionId:instanceId:seq`;
 *  - **contiguous seqs per instance**: every instance's bodies are `0 … n`,
 *    the last marked `final` and named by the instance's `end` record, with
 *    nothing declared lost;
 *  - **no loss beyond the forward interval**: every record the page wrote
 *    arrives, and so does every record a probe wrote, except those written
 *    within one forward interval of that probe's worker dying or of the page
 *    ending the instance it reported into.
 *
 * Time is virtual. Every timer of the page and of each probe runs on one
 * scheduled clock, so a run covers minutes of a page's life in a fraction of a
 * second and a failing seed replays exactly. Each worker is a realm of its own:
 * its own patched `WebTransport`, its own probe, its own timers, all of which
 * stop at once when it dies. A message it posted before dying still arrives,
 * which is what a browser does.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetDormantForTest, teardownDormant } from '../../api/dormant.js'
import { envelope, FORWARD_INTERVAL_MS, type LinkedMessage, linkMessage } from '../../api/link.js'
import { ProbeRuntime } from '../../api/probe.js'
import type { LinkEvent, MessageTarget } from '../../api/session.js'
import { draftSet } from '../../draft/index.js'
import { ALL_ADAPTERS } from '../../drafts/all.js'
import { BODY_PREAMBLE_BYTES, readFrames, readPreamble, sha256Hex } from '../../envelope/index.js'
import {
  type ChunkBackend,
  ChunkStore,
  type LockManagerLike,
  MemoryBackend,
} from '../../flush/index.js'
import { installWebTransportHook } from '../../transport/index.js'
import type { BatchRecord, ClockSource, EndRecord, EnvelopeRecord } from '../../types.js'
import { subscribeBytes } from '../decode/vectors.js'
import { init } from '../support/init.js'
import { MockWebTransport } from '../transport/mocks.js'

const g = globalThis as unknown as Record<string, unknown>
const SESSION = 'sess-interleave'
const ENDPOINT = 'https://ingest.test/v1/ingest'
const WALL_ORIGIN = 1_700_000_000_000
const drafts = draftSet(ALL_ADAPTERS)

/* ── the harness ────────────────────────────────────────────────────────── */

/** Deterministic, so a failing seed replays exactly. */
function prng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Let promises, message ports and stream reads run, without moving virtual time. */
async function turns(n = 6): Promise<void> {
  for (let i = 0; i < n; i += 1) await new Promise((r) => setImmediate(r))
}

interface Timer {
  readonly at: number
  readonly fn: () => void
}

/** One clock and one timer queue for the page and every probe. */
class VirtualTime {
  now = 0
  readonly #timers = new Map<number, Timer>()
  #next = 1

  readonly clock: ClockSource = { now: () => this.now, wall: () => WALL_ORIGIN + this.now }

  readonly set = (fn: () => void, ms: number): number => {
    const id = this.#next++
    this.#timers.set(id, { at: this.now + Math.max(0, ms), fn })
    return id
  }

  readonly clear = (h: unknown): void => {
    this.#timers.delete(h as number)
  }

  /** Fire every timer due within `ms`, in order, letting each one's work run. */
  async advance(ms: number): Promise<void> {
    const until = this.now + ms
    for (let fired = 0; fired < 10_000; fired += 1) {
      let due: [number, Timer] | undefined
      for (const e of this.#timers) {
        if (e[1].at > until) continue
        if (due === undefined || e[1].at < due[1].at) due = e
      }
      if (due === undefined) break
      this.#timers.delete(due[0])
      this.now = Math.max(this.now, due[1].at)
      due[1].fn()
      await turns(3)
    }
    this.now = until
    await turns()
  }

  /** Move the clock without running anything: a frozen page runs no timers. */
  jump(ms: number): void {
    this.now += ms
  }
}

/** A record the run wrote, and when. */
interface Written {
  readonly marker: string
  readonly at: number
  /** The probe that wrote it; `undefined` for the page. */
  readonly probe?: Probe
}

interface Probe {
  readonly id: number
  readonly worker: MessageTarget & { terminate(): void }
  /** When the worker died, in virtual ms. */
  diedAt: number | undefined
  /** When the instance this probe reported into ended without it, in virtual ms. */
  orphanedAt: number | undefined
  transport: MockWebTransport | undefined
  queue: ReadableStreamDefaultReader<unknown> | undefined
  runtime: ProbeRuntime | undefined
  readonly ports: MessagePort[]
  kill(): void
}

interface Arrival {
  readonly key: string
  readonly records: EnvelopeRecord[]
  readonly raw: string
}

async function decode(body: Uint8Array): Promise<{ records: EnvelopeRecord[]; raw: string }> {
  const pre = readPreamble(body)
  expect(pre).not.toBeNull()
  let frames = body.subarray(BODY_PREAMBLE_BYTES)
  if ((pre as { gzipped: boolean }).gzipped) {
    const ds = new DecompressionStream('gzip')
    const out = new Response(new Blob([frames as unknown as BlobPart]).stream().pipeThrough(ds))
    frames = new Uint8Array(await out.arrayBuffer())
  }
  const text = new TextDecoder()
  const records: EnvelopeRecord[] = []
  let raw = ''
  for (const f of readFrames(frames)) {
    if (f.raw) raw += `${String.fromCharCode(...f.payload)}\n`
    else records.push(JSON.parse(text.decode(f.payload)) as EnvelopeRecord)
  }
  return { records, raw }
}

/** A lock manager whose locks are held until their callback settles, as the platform's are. */
function locks(): LockManagerLike {
  const held = new Set<string>()
  return {
    request(name: string, callback: (lock: unknown) => Promise<unknown> | unknown) {
      held.add(name)
      return Promise.resolve(callback({ name })).finally(() => held.delete(name))
    },
    query: async () => ({ held: [...held].map((name) => ({ name })) }),
  }
}

/** The page's lifecycle listeners, captured so the run can fire them. */
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

const pad = (n: number, w: number): string => String(n).padStart(w, '0')

/** Read one inbound control stream to its end, as a player would. */
async function deliver(
  wt: MockWebTransport,
  queue: ReadableStreamDefaultReader<unknown>,
  bytes: Uint8Array,
): Promise<void> {
  const stream = wt.deliverBidiStream([bytes])
  stream.inbound.close()
  const arrived = await queue.read()
  const reader = (arrived.value as { readable: ReadableStream<Uint8Array> }).readable.getReader()
  for (;;) if ((await reader.read()).done) break
}

/* ── one run ────────────────────────────────────────────────────────────── */

interface RunResult {
  readonly arrivals: Arrival[]
  /** How many of `arrivals` the page delivered itself, before it ended. */
  readonly inSession: number
  readonly written: Written[]
  readonly storedAfter: number
  readonly ops: string[]
}

async function run(seed: number, steps: number): Promise<RunResult> {
  const rand = prng(seed)
  const pick = (n: number): number => Math.floor(rand() * n)
  const vt = new VirtualTime()
  const life = lifecycle()
  const doc = g as { document?: { visibilityState: string } }
  const ops: string[] = []
  const written: Written[] = []
  const pending: Promise<void>[] = []
  const arrivals: Arrival[] = []
  let offline = false
  let beaconRefused = false
  /** The page has unloaded: nothing it starts from here on happens. */
  let gone = false

  const receive = (url: string, bytes: Promise<Uint8Array>): void => {
    pending.push(
      bytes.then(async (body) => {
        const key = new URL(url).searchParams.get('ik') ?? ''
        arrivals.push({ key, ...(await decode(body)) })
      }),
    )
  }
  const fetchImpl = (async (url: string, req: RequestInit) => {
    if (offline || gone) throw new TypeError('network down')
    const body = req.body
    receive(
      url,
      body instanceof Blob
        ? body.arrayBuffer().then((b) => new Uint8Array(b))
        : Promise.resolve(new Uint8Array(body as unknown as ArrayBufferLike as never)),
    )
    return { ok: true, status: 202, headers: { get: () => null } } as unknown as Response
  }) as unknown as typeof fetch
  const beacon = (url: string, blob: Blob): boolean => {
    if (beaconRefused || offline) return false
    receive(
      url,
      blob.arrayBuffer().then((b) => new Uint8Array(b)),
    )
    return true
  }

  const backend = new MemoryBackend()
  // What an unloaded page writes after its last synchronous moment never
  // reaches storage: the tail's copies must be made inside `pagehide` itself.
  const pageBackend: ChunkBackend = Object.create(backend)
  pageBackend.put = (entry, chunk) => (gone ? new Promise(() => {}) : backend.put(entry, chunk))
  pageBackend.remove = (key) => (gone ? new Promise(() => {}) : backend.remove(key))
  const lockManager = locks()
  const ports = {
    fetchImpl,
    beacon,
    locks: lockManager,
    clock: vt.clock,
    setTimer: vt.set,
    clearTimer: vt.clear,
    timeOrigin: 0,
  }
  const config = {
    apiKey: 'pk_test',
    endpoint: ENDPOINT,
    sessionId: SESSION,
    upload: { intervalMs: 4_000, earlyFlushesMs: [], maxAttempts: 1, byteThreshold: 4_096 },
  }

  doc.document = { visibilityState: 'visible' }
  const page = init(config, {
    ...ports,
    store: await ChunkStore.open('db', 1024 * 1024, { backend: pageBackend }),
  })
  await turns()

  const probes: Probe[] = []
  let marker = 0
  let pageTransport: MockWebTransport | undefined
  let pageQueue: ReadableStreamDefaultReader<unknown> | undefined

  const spawn = async (): Promise<void> => {
    const id = probes.length + 1
    const listeners: ((e: LinkEvent) => void)[] = []
    let dead = false
    const timers = new Set<number>()
    const probe: Probe = {
      id,
      diedAt: undefined,
      orphanedAt: undefined,
      transport: undefined,
      queue: undefined,
      runtime: undefined,
      ports: [],
      worker: {
        // Page → worker: only the handshake answer comes this way.
        postMessage: (message: unknown, transfer?: Transferable[]) => {
          if (dead) return
          const m = linkMessage(message)
          const channel = transfer?.[0] as MessagePort | undefined
          if (m?.t !== 'linked' || channel === undefined) return
          probe.ports.push(channel)
          probe.runtime = new ProbeRuntime(
            m as unknown as LinkedMessage,
            mute(channel),
            installWebTransportHook(realm, null, { clock: vt.clock }),
            drafts,
            {
              clock: vt.clock,
              setTimer: (fn, ms) => {
                if (dead) return 0
                const h = vt.set(() => {
                  timers.delete(h)
                  if (!dead) fn()
                }, ms)
                timers.add(h)
                return h
              },
              clearTimer: (h) => {
                timers.delete(h as number)
                vt.clear(h)
              },
            },
          )
          probe.runtime.start()
        },
        addEventListener: (_t, f) => {
          listeners.push(f)
        },
        terminate: () => probe.kill(),
      },
      kill: () => {
        if (dead) return
        dead = true
        probe.diedAt = vt.now
        for (const h of timers) vt.clear(h)
        timers.clear()
      },
    }
    /** The worker's side of the private channel: silent and deaf once it is dead. */
    const mute = (port: MessagePort): MessagePort =>
      ({
        postMessage: (m: unknown, t?: Transferable[]) => {
          if (!dead) port.postMessage(m, t ?? [])
        },
        set onmessage(f: (e: MessageEvent) => void) {
          port.onmessage = (e) => {
            if (!dead) f(e)
          }
        },
        close: () => port.close(),
      }) as unknown as MessagePort
    const realm: { WebTransport?: unknown } = { WebTransport: MockWebTransport }
    probes.push(probe)
    page.linkWorker(probe.worker)
    for (const f of listeners) f({ data: envelope({ t: 'hello', timeOrigin: 0 }) })
    await turns()
    const wt = new (realm.WebTransport as new (u: string) => MockWebTransport)(
      `https://relay.test/w${id}`,
    )
    await wt.open('moqt-20')
    probe.transport = wt
    probe.queue = wt.incomingBidirectionalStreams.getReader()
    await turns()
  }

  const live = (): Probe[] => probes.filter((p) => p.diedAt === undefined)
  const someLive = (): Probe | undefined => {
    const l = live()
    return l.length === 0 ? undefined : l[pick(l.length)]
  }

  type Op = readonly [weight: number, name: string, act: () => Promise<void> | void]
  const table: readonly Op[] = [
    [5, 'advance', () => vt.advance(50 + pick(1_500))],
    [
      2,
      'page-note',
      () => {
        const m = `page-note-${pad(++marker, 4)}`
        page.annotate(m)
        written.push({ marker: m, at: vt.now })
      },
    ],
    [
      2,
      'page-ctrl',
      async () => {
        if (pageTransport === undefined) {
          pageTransport = new (g.WebTransport as new (u: string) => MockWebTransport)(
            'https://relay.test/page',
          )
          await pageTransport.open('moqt-20')
          pageQueue = pageTransport.incomingBidirectionalStreams.getReader()
          await turns()
        }
        const m = `trk-pg-${pad(++marker, 4)}`
        await deliver(pageTransport, pageQueue as never, subscribeBytes(BigInt(marker * 2), m))
        written.push({ marker: m, at: vt.now })
      },
    ],
    [1, 'spawn', () => (live().length < 3 ? spawn() : undefined)],
    [
      5,
      'probe-ctrl',
      async () => {
        const p = someLive()
        if (p?.transport === undefined || p.queue === undefined) return
        const m = `trk-p${pad(p.id, 2)}-${pad(++marker, 4)}`
        await deliver(p.transport, p.queue, subscribeBytes(BigInt(marker * 2), m))
        written.push({ marker: m, at: vt.now, probe: p })
      },
    ],
    [
      1,
      'probe-note',
      () => {
        const p = someLive()
        if (p?.runtime === undefined) return
        const m = `probe-note-${pad(++marker, 4)}`
        p.runtime.annotate(m, undefined)
        written.push({ marker: m, at: vt.now, probe: p })
      },
    ],
    [
      1,
      'probe-close',
      async () => {
        const p = someLive()
        if (p?.transport === undefined) return
        p.transport.closeSession('done', 0)
        p.transport = undefined
        await turns()
      },
    ],
    [1, 'terminate', () => someLive()?.worker.terminate()],
    // Dies without the wrapped `terminate()`: `Worker.prototype.terminate.call(w)`,
    // or a crash. Only the silence check notices.
    [0.5, 'vanish', () => someLive()?.kill()],
    [
      0.7,
      'freeze',
      async () => {
        life.fire('pagehide', { persisted: true })
        await turns()
        vt.jump(500 + pick(4_000))
        life.fire('pageshow', { persisted: true })
        await turns()
      },
    ],
    [
      0.7,
      'hide',
      async () => {
        const hidden = doc.document?.visibilityState === 'hidden'
        doc.document = { visibilityState: hidden ? 'visible' : 'hidden' }
        life.fire('visibilitychange')
        await turns()
      },
    ],
    [
      1,
      'network',
      async () => {
        offline = !offline
        if (!offline) life.fire('online')
        await turns()
      },
    ],
    [
      0.5,
      'beacon',
      () => {
        beaconRefused = !beaconRefused
      },
    ],
    [0.5, 'flush', () => void page.flush()],
    [
      0.3,
      'new-session',
      async () => {
        page.newSession()
        await turns()
      },
    ],
  ]
  const total = table.reduce((s, [w]) => s + w, 0)
  const step = async (): Promise<void> => {
    let r = rand() * total
    for (const [w, name, act] of table) {
      r -= w
      if (r > 0) continue
      ops.push(name)
      await act()
      return
    }
  }

  try {
    await spawn()
    for (let i = 0; i < steps; i += 1) await step()

    // The network comes back while the page is still open: everything sealed
    // so far is delivered by this page, with no help from the next one.
    offline = false
    beaconRefused = false
    life.fire('online')
    await vt.advance(5_000)
    await Promise.all(pending)
    const inSession = arrivals.length

    // The page ends, one of the ways a page ends.
    const ending = pick(3)
    ops.push(['end', 'unload', 'end-offline'][ending] as string)
    const endedAt = vt.now
    for (const p of live()) p.orphanedAt = endedAt
    if (ending === 0) {
      offline = false
      await page.end()
    } else if (ending === 2) {
      offline = true
      await page.end()
    } else {
      offline = rand() < 0.5
      beaconRefused = rand() < 0.5
      life.fire('pagehide', { persisted: false })
      gone = true
    }
    for (const p of live()) p.kill()
    await turns(20)

    // The next page load on the origin: online, and sweeping what was left.
    offline = false
    beaconRefused = false
    gone = false
    doc.document = { visibilityState: 'visible' }
    const store = await ChunkStore.open('db', 1024 * 1024, { backend })
    const next = init(config, { ...ports, store })
    await turns(20)
    await vt.advance(1_000)
    await next.end()
    await turns(20)
    await Promise.all(pending)
    return { arrivals, inSession, written, storedAfter: store.chunks, ops }
  } finally {
    for (const p of probes) for (const port of p.ports) port.close()
    life.restore()
    delete doc.document
  }
}

/* ── the properties ─────────────────────────────────────────────────────── */

function check(seed: number, r: RunResult): void {
  const why = `seed ${seed}: ${r.ops.join(' ')}`

  // One key per body, and the key is the body's identity.
  const byKey = new Map<string, Arrival>()
  for (const a of r.arrivals) {
    const batch = a.records[0] as BatchRecord
    expect(batch.t, why).toBe('batch')
    expect(a.key, why).toBe(batch.idempotencyKey)
    expect(batch.idempotencyKey, why).toBe(
      sha256Hex(`${batch.sessionId}:${batch.instanceId}:${batch.seq}`),
    )
    const first = byKey.get(a.key)
    if (first === undefined) byKey.set(a.key, a)
    else expect(a.records, `${why}: two bodies under ${a.key}`).toEqual(first.records)
  }
  const bodies = [...byKey.values()]

  // Contiguous seqs per instance, ending in the body the end record names.
  const instances = new Map<string, BatchRecord[]>()
  for (const b of bodies) {
    const batch = b.records[0] as BatchRecord
    instances.set(batch.instanceId, [...(instances.get(batch.instanceId) ?? []), batch])
  }
  expect(instances.size, why).toBeGreaterThanOrEqual(2)
  for (const [instance, batches] of instances) {
    const seqs = batches.map((b) => b.seq).sort((a, b) => a - b)
    expect(seqs, `${why}: instance ${instance}`).toEqual(seqs.map((_, i) => i))
    const last = seqs.length - 1
    expect(
      batches.filter((b) => b.final === true).map((b) => b.seq),
      `${why}: instance ${instance}`,
    ).toEqual([last])
    for (const b of batches) {
      expect(b.lost ?? [], why).toEqual([])
      expect(b.dropped, why).toBe(0)
    }
    const ends = bodies
      .filter((b) => (b.records[0] as BatchRecord).instanceId === instance)
      .flatMap((b) => b.records.filter((x): x is EndRecord => x.t === 'end'))
    expect(
      ends.map((e) => e.finalSeq),
      `${why}: instance ${instance}`,
    ).toEqual([last])
  }

  // A page that is back online leaves no hole: what it delivered by itself is
  // every instance's bodies from 0, without a gap.
  const delivered = new Map<string, Set<number>>()
  for (const a of r.arrivals.slice(0, r.inSession)) {
    const batch = a.records[0] as BatchRecord
    delivered.set(batch.instanceId, (delivered.get(batch.instanceId) ?? new Set()).add(batch.seq))
  }
  for (const [instance, seqs] of delivered) {
    const sorted = [...seqs].sort((a, b) => a - b)
    expect(sorted, `${why}: instance ${instance}, delivered in session`).toEqual(
      sorted.map((_, i) => i),
    )
  }

  // No loss beyond the forward interval.
  const notes = new Set(
    bodies.flatMap((b) => b.records.filter((x) => x.t === 'note').map((x) => x.name)),
  )
  const raw = bodies.map((b) => b.raw).join('')
  for (const w of r.written) {
    const arrived = w.marker.startsWith('trk-') ? raw.includes(w.marker) : notes.has(w.marker)
    if (arrived) continue
    const cut = Math.min(w.probe?.diedAt ?? Infinity, w.probe?.orphanedAt ?? Infinity)
    expect(
      w.probe !== undefined && w.at >= cut - FORWARD_INTERVAL_MS,
      `${why}: ${w.marker}, written at ${w.at}, never arrived`,
    ).toBe(true)
  }

  // And nothing is left behind on the device.
  expect(r.storedAfter, why).toBe(0)
}

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

describe('the page and its probes, interleaved at random', () => {
  const SEEDS = Array.from({ length: 40 }, (_, i) => 0x5eed + i * 7919)

  it.each(SEEDS)('keeps every property for seed %i', async (seed) => {
    const r = await run(seed, 40)
    check(seed, r)
  }, 30_000)
})
