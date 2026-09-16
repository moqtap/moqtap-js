/**
 * The reference player.
 *
 * One MoQT client doing both jobs at once: subscribing to a track whose objects
 * arrive on a remote unidirectional stream, and publishing a track onto a local
 * one whose sink drains slower than the player produces, so `writer.ready`
 * genuinely blocks. It measures three page-observable latencies per object, plus
 * the counts and byte totals that make "no object was lost" an exact claim.
 *
 * ── Why the transport is a stand-in and the ingest server is not
 *
 * Node has no `WebTransport`, so the transport under the seam is built here, but
 * everything the seam actually touches is the platform's own — for the reason
 * `src/__tests__/transport/mocks.ts` states: `pipeTo`, `pipeThrough`, `tee` and
 * `for await` acquire their reader through an internal spec operation that never
 * consults a patched `getReader`, so a hand-written stand-in implementing
 * `pipeTo` via its own `getReader` would prove the opposite of the truth. Both
 * stream halves are real `ReadableStream`/`WritableStream` objects with real
 * queuing strategies, and the incoming-stream queue is consumed with `for await`.
 *
 * The ingest endpoint, the thing being faulted, is a **real** HTTP server
 * (`fault-server.ts`) reached through the real global `fetch`. The fault is
 * never simulated; only the transport is.
 *
 * ── The bytes are real draft-20
 *
 * Objects come from `@moqtap/codec/draft20`'s own `encodeSubgroupStream`, split
 * at object boundaries, so the collector's counting decoder does the work it
 * does in production rather than bailing out on garbage — the cost being
 * measured is largely that decoder's. Splitting encodes the stream with
 * `objects[0..i]` and slices what the previous encode did not contain:
 * quadratic, cached, and unable to drift from the codec's own framing the way a
 * hand-rolled header would.
 *
 * ── The three measurements
 *
 * - **`writeCallMs`** — how long the page's own `writer.write()` call takes to
 *   return: the collector's synchronous cost at the seam, in full. The hook's
 *   patched `write` runs `onChunk` *before* `origWrite`
 *   (`webtransport-hook.ts`), so every byte of ring copy, stream classification,
 *   header walk and rollup accounting is inside this number. Lowest-noise signal
 *   here, and the one a regression moves first.
 * - **`readyLatencyMs`** — how long `await writer.ready` blocked; the only
 *   backpressure signal a publish-only session has.
 * - **`arrivalLatencyMs`** — a received object's arrival minus the moment the
 *   peer actually handed it to the transport. Transit across the seam, and the
 *   collector sits inside it: the hook's relay runs `onStreamData` on the pull
 *   that fills the page's `read()`, so any work it does is in this number.
 *
 *   Measured against the **actual** push, never against a schedule: against a
 *   schedule it is dominated by the harness's own `setTimeout` error — on
 *   Windows the timer granularity is ~15.6 ms, so a 4 ms cadence is not a
 *   cadence and every arm's "lateness" grows without bound with no collector
 *   causing it. The cadence below is set above that granularity for the same
 *   reason.
 */

import type { ObjectPayload } from '@moqtap/codec/draft20'
import { encodeSubgroupStream } from '@moqtap/codec/draft20'

/* ── the wire ────────────────────────────────────────────────────────────── */

/**
 * SUBGROUP_HEADER Type Flags (draft-20 §11.4.2), chosen to be the plainest
 * legal shape: no Object Properties (bit 0x01 clear), Subgroup ID absent
 * (bits 0x06 = 0), explicit publisher priority (bit 0x20 clear). The 0x10 bit
 * is what `sniffStream` in `src/decode/dispatch.ts` keys on to call a stream a
 * subgroup at all.
 */
const SUBGROUP_HEADER_TYPE = 0x10

const wireCache = new Map<string, { header: Uint8Array; frames: Uint8Array[] }>()

function payloadOf(index: number, bytes: number): Uint8Array {
  const p = new Uint8Array(bytes)
  for (let i = 0; i < bytes; i += 1) p[i] = (i * 31 + index * 7) & 0xff
  return p
}

/**
 * One subgroup stream's header plus one byte range per object.
 *
 * Encoded through the codec and split by difference, so the split points are
 * the codec's own object boundaries by construction.
 */
export function subgroupWire(
  count: number,
  payloadBytes: number,
  trackAlias: bigint,
): { header: Uint8Array; frames: Uint8Array[] } {
  const key = `${count}:${payloadBytes}:${trackAlias}`
  const hit = wireCache.get(key)
  if (hit !== undefined) return hit

  const objects: ObjectPayload[] = []
  const encode = (): Uint8Array =>
    encodeSubgroupStream({
      type: 'subgroup',
      headerType: SUBGROUP_HEADER_TYPE,
      trackAlias,
      groupId: 0n,
      subgroupId: 0n,
      publisherPriority: 128,
      objects,
    })

  const header = encode()
  let prev = header
  const frames: Uint8Array[] = []
  for (let i = 0; i < count; i += 1) {
    objects.push({
      type: 'object',
      byteOffset: 0,
      payloadByteOffset: 0,
      objectId: BigInt(i),
      payloadLength: payloadBytes,
      extensionData: new Uint8Array(0),
      payload: payloadOf(i, payloadBytes),
    })
    const next = encode()
    frames.push(next.slice(prev.byteLength))
    prev = next
  }

  const built = { header, frames }
  wireCache.set(key, built)
  return built
}

/* ── the transport stand-in ──────────────────────────────────────────────── */

/** The peer half, reachable off the instance the page is handed. */
export interface PeerControls {
  /** Establish the session and announce the server's protocol pick. */
  open(protocol: string): void
  /** Hand the page an incoming unidirectional stream and a controller for it. */
  deliverStream(): { push(b: Uint8Array): void; close(): void }
  /** Bytes the page's publish stream actually reached the sink with. */
  readonly sunkBytes: number
  readonly sunkChunks: number
  closeSession(): void
}

export interface FakeTransportOptions {
  /** Milliseconds the publish sink takes to accept one chunk. Real backpressure. */
  readonly drainMs: number
}

const deferred = <T>(): {
  promise: Promise<T>
  resolve: (v: T) => void
  reject: (e: unknown) => void
} => {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const delay = (ms: number): Promise<void> =>
  new Promise((r) => {
    setTimeout(r, ms)
  })

/**
 * A `WebTransport` stand-in whose stream objects are the platform's own.
 *
 * Only what the seam looks at is faked: the constructor, `ready`, `closed`,
 * `protocol`, the two incoming-stream queues, `datagrams`, and the two
 * stream-creation methods.
 */
class FakeWebTransport {
  readonly url: string
  protocol = ''
  readonly ready: Promise<void>
  readonly closed: Promise<{ closeCode: number; reason: string }>
  readonly datagrams: {
    readable: ReadableStream<Uint8Array>
    writable: WritableStream<unknown>
  }
  readonly incomingUnidirectionalStreams: ReadableStream<ReadableStream<Uint8Array>>
  readonly incomingBidirectionalStreams: ReadableStream<unknown>
  /** The peer half. Named unmistakably so it can never be read as page API. */
  readonly moqtapPeer: PeerControls

  readonly #drainMs: number
  #sunkBytes = 0
  #sunkChunks = 0

  constructor(url: string | URL, _options?: Record<string, unknown>) {
    this.url = String(url)
    const drainMs = FakeWebTransport.drainMs
    this.#drainMs = drainMs

    const readyD = deferred<void>()
    const closedD = deferred<{ closeCode: number; reason: string }>()
    this.ready = readyD.promise
    this.closed = closedD.promise
    this.ready.catch(() => {})
    this.closed.catch(() => {})

    let uniController!: ReadableStreamDefaultController<ReadableStream<Uint8Array>>
    this.incomingUnidirectionalStreams = new ReadableStream<ReadableStream<Uint8Array>>(
      {
        start(c) {
          uniController = c
        },
      },
      { highWaterMark: 0 },
    )
    this.incomingBidirectionalStreams = new ReadableStream({ start() {} }, { highWaterMark: 0 })
    this.datagrams = {
      readable: new ReadableStream<Uint8Array>({ start() {} }, { highWaterMark: 0 }),
      writable: new WritableStream({ write() {} }),
    }

    const self = this
    this.moqtapPeer = {
      open(protocol: string): void {
        self.protocol = protocol
        readyD.resolve()
      },
      deliverStream(): { push(b: Uint8Array): void; close(): void } {
        let inner!: ReadableStreamDefaultController<Uint8Array>
        const stream = new ReadableStream<Uint8Array>(
          {
            start(c) {
              inner = c
            },
          },
          { highWaterMark: 0 },
        )
        uniController.enqueue(stream)
        let done = false
        return {
          push(b) {
            if (!done) inner.enqueue(b)
          },
          close() {
            if (done) return
            done = true
            inner.close()
          },
        }
      },
      get sunkBytes(): number {
        return self.#sunkBytes
      },
      get sunkChunks(): number {
        return self.#sunkChunks
      },
      closeSession(): void {
        closedD.resolve({ closeCode: 0, reason: '' })
      },
    }
  }

  /**
   * The publish stream.
   *
   * `highWaterMark: 1` with a sink that takes `drainMs` to accept a chunk is
   * what makes `writer.ready` a real measurement: the page runs one object
   * ahead of the wire and blocks for the rest, which is the ordinary state of a
   * publisher on a congested uplink and the state the `desiredSize <= 0`
   * sampling exists for.
   */
  createUnidirectionalStream(): Promise<WritableStream<unknown>> {
    const drainMs = this.#drainMs
    const stream = new WritableStream<unknown>(
      {
        write: (chunk: unknown): Promise<void> => {
          const b = chunk as { byteLength?: number }
          this.#sunkChunks += 1
          this.#sunkBytes += typeof b?.byteLength === 'number' ? b.byteLength : 0
          return delay(drainMs)
        },
      },
      { highWaterMark: 1 },
    )
    return Promise.resolve(stream)
  }

  createBidirectionalStream(): Promise<never> {
    return Promise.reject(new Error('reference player opens no bidirectional streams'))
  }

  close(): void {
    this.moqtapPeer.closeSession()
  }

  /**
   * Sink pacing, read once per construction.
   *
   * A static rather than a constructor argument because the page never
   * constructs this class directly: it constructs whatever the hook left on
   * `globalThis.WebTransport`, with the page's own arguments and no others.
   * Anything the harness wants to configure has to arrive out of band, and
   * {@link installFakeWebTransport} is the only writer.
   */
  static drainMs = 4
}

/**
 * Put the stand-in on the global so the collector's hook patches it.
 *
 * Must run **before** `init()`, because `ensureDormantHook()` binds to whatever
 * `globalThis.WebTransport` is at install time, and Node's global has none — an
 * install with nothing to patch returns the inert hook and the whole arm would
 * measure a collector that was never attached.
 */
export function installFakeWebTransport(o: FakeTransportOptions): () => void {
  const g = globalThis as unknown as Record<string, unknown>
  const previous = g.WebTransport
  const had = 'WebTransport' in g
  FakeWebTransport.drainMs = o.drainMs
  g.WebTransport = FakeWebTransport
  return () => {
    if (had) g.WebTransport = previous
    else delete g.WebTransport
  }
}

/* ── the player ──────────────────────────────────────────────────────────── */

export interface PlayerOptions {
  readonly url?: string
  /** The server's protocol pick. `moqt-20` selects the draft-20 chunk. */
  readonly protocol?: string
  /** Objects per direction. The caller discards its own warm-up prefix. */
  readonly objects: number
  /** Milliseconds between the peer's scheduled object emissions. */
  readonly cadenceMs: number
  /** Milliseconds the publish sink takes per object. Sets the publish rate. */
  readonly drainMs: number
  readonly payloadBytes?: number
  /**
   * Milliseconds of synchronous work to burn on the page's own data path, per
   * object, in both directions.
   *
   * **Calibration only.** It does not model the collector; it is a known
   * interference of known size, so the suite can show that the tolerances it
   * asserts are tight enough to catch one. A harness that cannot be made to
   * fail is not evidence.
   */
  readonly stallMs?: number
}

export interface PlayerMetrics {
  /** Objects the page handed to `writer.write()`. */
  readonly objectsSent: number
  /**
   * Chunks that reached the transport's sink, header included.
   *
   * Not the same claim as {@link PlayerMetrics.objectsSent}: `write()` is not
   * awaited, so "sent" means handed over. This is what actually arrived, and it
   * is the one that would move if the collector ever dropped or reordered a
   * write on the publish path.
   */
  readonly chunksSunk: number
  readonly objectsReceived: number
  /** Bytes the peer handed to the transport, and bytes the page got back. */
  readonly bytesPushed: number
  readonly bytesReceived: number
  /** ms `await writer.ready` blocked, one per published object. */
  readonly readyLatencyMs: number[]
  /** ms the page's `writer.write()` call took to return, one per published object. */
  readonly writeCallMs: number[]
  /** ms between an object's scheduled emission and the page receiving it. */
  readonly arrivalLatencyMs: number[]
  readonly wallMs: number
}

const now = (): number => performance.now()

/** Burn `ms` of wall time on this thread of control. Calibration only. */
function burn(ms: number): void {
  if (ms <= 0) return
  const until = now() + ms
  while (now() < until) {
    // Deliberately a spin: a stall the page pays is synchronous by definition,
    // and awaiting a timer here would measure the event loop instead.
  }
}

/**
 * A `ReadableStream` as the async iterable it is at runtime.
 *
 * The workspace compiles with `lib: ["ES2022", "DOM"]`, which declares
 * `Symbol.asyncIterator` on `ReadableStream` only under `DOM.AsyncIterable`.
 * The cast is the type system catching up with the platform, not a claim about
 * it — `src/__tests__/transport/hook.test.ts` proves the runtime behaviour.
 */
const asAsyncIterable = <T>(rs: ReadableStream<T>): AsyncIterable<T> =>
  rs as unknown as AsyncIterable<T>

/**
 * Run one arm: subscribe, publish, and return what the page observed.
 *
 * Resolves when both directions have finished their `objects` count. Never
 * throws for a collector problem — the collector is not supposed to be able to
 * produce one, and a harness that swallowed it would be measuring the wrong
 * thing, so anything thrown here is a genuine failure of the run.
 */
export async function runReferencePlayer(o: PlayerOptions): Promise<PlayerMetrics> {
  const payloadBytes = o.payloadBytes ?? 200
  const stallMs = o.stallMs ?? 0
  const g = globalThis as unknown as {
    WebTransport: new (url: string, options?: Record<string, unknown>) => FakeWebTransport
  }

  const started = now()
  const wt = new g.WebTransport(o.url ?? 'https://relay.invalid/moq', {
    protocols: ['moqt-20', 'moqt-19'],
  })
  const peer = wt.moqtapPeer
  peer.open(o.protocol ?? 'moqt-20')
  await wt.ready

  const rx = subgroupWire(o.objects, payloadBytes, 7n)
  const tx = subgroupWire(o.objects, payloadBytes, 9n)

  const arrivalLatencyMs: number[] = []
  const readyLatencyMs: number[] = []
  const writeCallMs: number[] = []
  let bytesReceived = 0
  let bytesPushed = 0
  let objectsReceived = 0

  /* ── subscribe ─────────────────────────────────────────────────────────── */

  // The moment the peer actually handed each object to the transport. Transit
  // is measured from here rather than from the schedule the peer was aiming
  // for, so the harness's own timer error stays out of the collector's number.
  const pushedAt: number[] = []
  const rxStart = now()
  const dueAt = (i: number): number => rxStart + (i + 1) * o.cadenceMs

  const consumed = (async (): Promise<void> => {
    for await (const stream of asAsyncIterable(wt.incomingUnidirectionalStreams)) {
      const reader = stream.getReader()
      // The first chunk on a subgroup stream is its header, not an object.
      let chunks = 0
      for (;;) {
        const r = await reader.read()
        if (r.done) break
        const at = now()
        bytesReceived += (r.value as Uint8Array).byteLength
        chunks += 1
        if (chunks > 1) {
          arrivalLatencyMs.push(at - (pushedAt[objectsReceived] ?? at))
          objectsReceived += 1
          // Stands in for a consumer that is slow for its own reasons: it holds
          // off the next `read()`, so anything the peer has already sent waits,
          // and the wait lands in the next object's transit time.
          burn(stallMs)
          if (objectsReceived >= o.objects) return
        }
      }
      return
    }
  })()

  const feed = peer.deliverStream()
  feed.push(rx.header)
  bytesPushed += rx.header.byteLength
  const emit = (i: number): void => {
    // The consumer stops reading the moment it has its sample, so the tail of
    // the schedule can outlive the stream it is feeding. Pushing into a
    // cancelled controller throws, and that throw is the harness's, not the
    // collector's, so it is swallowed here rather than reported as a fault.
    try {
      if (i >= o.objects) {
        feed.close()
        return
      }
      const frame = rx.frames[i]
      if (frame !== undefined) {
        pushedAt[i] = now()
        bytesPushed += frame.byteLength
        feed.push(frame)
      }
    } catch {
      return
    }
    const next = dueAt(i + 1) - now()
    setTimeout(() => emit(i + 1), next > 0 ? next : 0)
  }
  setTimeout(() => emit(0), o.cadenceMs)

  /* ── publish ───────────────────────────────────────────────────────────── */

  const published = (async (): Promise<number> => {
    const writable = await wt.createUnidirectionalStream()
    const writer = writable.getWriter()
    let sent = 0

    const write = (b: Uint8Array): void => {
      const t = now()
      // Inside the measured window, because that is where the collector's cost
      // is: the hook's patched `write` runs `onChunk` and only then delegates
      // to the original, so everything it does happens between these two
      // `now()` calls. A stall injected anywhere else would not model it.
      burn(stallMs)
      // Not awaited: a publisher that awaited every `write()` would be pacing
      // itself on the sink and `ready` would never mean anything. This is the
      // shape a real MoQT publisher has, and it is why the call's own duration
      // is the interesting number.
      void (writer.write(b) as Promise<void>).catch(() => {})
      writeCallMs.push(now() - t)
    }

    await writer.ready
    write(tx.header)

    for (let i = 0; i < o.objects; i += 1) {
      const t0 = now()
      await writer.ready
      readyLatencyMs.push(now() - t0)
      const frame = tx.frames[i]
      if (frame !== undefined) write(frame)
      sent += 1
    }
    try {
      await writer.close()
    } catch {
      // A sink that rejects on close is not the page's problem and not this
      // measurement's either.
    }
    return sent
  })()

  const [objectsSent] = await Promise.all([published, consumed])

  return {
    objectsSent,
    chunksSunk: peer.sunkChunks,
    objectsReceived,
    bytesPushed,
    bytesReceived,
    readyLatencyMs,
    writeCallMs,
    arrivalLatencyMs,
    wallMs: now() - started,
  }
}

/* ── statistics ──────────────────────────────────────────────────────────── */

export interface Summary {
  readonly n: number
  readonly p50: number
  readonly p95: number
  readonly max: number
  readonly mean: number
}

/**
 * Nearest-rank percentiles over a copy of the samples.
 *
 * Nearest-rank rather than interpolated because an interpolated p95 of 200
 * samples invents a value between two real observations, and every number this
 * harness reports should be one the run actually produced.
 */
export function summarise(samples: readonly number[], warmup = 0): Summary {
  const kept = samples.slice(warmup)
  if (kept.length === 0) return { n: 0, p50: 0, p95: 0, max: 0, mean: 0 }
  const sorted = [...kept].sort((a, b) => a - b)
  const at = (q: number): number => {
    const rank = Math.max(1, Math.ceil(q * sorted.length))
    return sorted[Math.min(sorted.length, rank) - 1] as number
  }
  let sum = 0
  for (const v of kept) sum += v
  return {
    n: kept.length,
    p50: at(0.5),
    p95: at(0.95),
    max: sorted[sorted.length - 1] as number,
    mean: sum / kept.length,
  }
}

export const round = (n: number): number => Math.round(n * 1000) / 1000
