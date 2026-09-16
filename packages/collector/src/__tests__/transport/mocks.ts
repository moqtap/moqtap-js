/**
 * Test doubles for the transport seam.
 *
 * Everything here is built on the platform's own `ReadableStream` and
 * `WritableStream`, never a hand-written stand-in: `pipeTo`, `pipeThrough`,
 * `tee` and `for await` acquire their reader through an internal spec operation
 * that never consults the instance's `getReader`. A mock implementing `pipeTo`
 * by calling its own `getReader` would prove the exact opposite of the truth,
 * and the suite would pass while the shipped hook saw nothing. Against Node's
 * `node:stream/web`, each of the four called a patched instance `getReader`
 * **0 times** while delivering every chunk, and `pipeTo` into a destination
 * called that destination's patched `getWriter` 0 times. `hook.test.ts` re-runs
 * that check as a test, so the premise is re-verified on whatever platform the
 * suite runs on rather than inherited.
 *
 * `MockWebTransport` therefore fakes only what WebTransport adds on top of
 * streams: the constructor, `ready`/`closed`/`protocol`, the two
 * incoming-stream queues, `datagrams`, and the two stream-creation methods.
 */

export interface Deferred<T> {
  readonly promise: Promise<T>
  resolve(value: T): void
  reject(reason: unknown): void
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** A real `ReadableStream` the test pushes into by hand. */
export interface ManualSource<T> {
  readonly stream: ReadableStream<T>
  push(value: T): void
  close(): void
  error(reason: unknown): void
}

export function manualSource<T>(): ManualSource<T> {
  let controller!: ReadableStreamDefaultController<T>
  let closed = false
  const stream = new ReadableStream<T>(
    {
      start(c) {
        controller = c
      },
    },
    // Zero, so nothing is pulled until a consumer asks — the shape of a real
    // incoming-stream queue, and what makes backpressure assertions meaningful.
    { highWaterMark: 0 },
  )
  return {
    stream,
    push(value) {
      if (!closed) controller.enqueue(value)
    },
    close() {
      if (closed) return
      closed = true
      controller.close()
    },
    error(reason) {
      if (closed) return
      closed = true
      controller.error(reason)
    },
  }
}

/** A real `WritableStream` that records what reached its sink. */
export interface CollectingWritable {
  readonly stream: WritableStream<unknown>
  /** Chunks the sink actually received, in order. */
  readonly written: unknown[]
  readonly closed: () => boolean
  readonly aborted: () => unknown
  /** Resolve every write held back by `hold: true`. */
  release(): void
}

export function collectingWritable(
  opts: { highWaterMark?: number; hold?: boolean } = {},
): CollectingWritable {
  const written: unknown[] = []
  const pending: Array<() => void> = []
  let isClosed = false
  let abortReason: unknown
  const stream = new WritableStream<unknown>(
    {
      write(chunk) {
        written.push(chunk)
        if (!opts.hold) return
        return new Promise<void>((resolve) => {
          pending.push(resolve)
        })
      },
      close() {
        isClosed = true
      },
      abort(reason) {
        abortReason = reason
      },
    },
    { highWaterMark: opts.highWaterMark ?? 16 },
  )
  return {
    stream,
    written,
    closed: () => isClosed,
    aborted: () => abortReason,
    release() {
      while (pending.length > 0) pending.shift()?.()
    },
  }
}

export interface MockBidiStream {
  readonly readable: ReadableStream<Uint8Array>
  readonly writable: WritableStream<unknown>
  /** Push bytes the peer sent on this stream. */
  readonly inbound: ManualSource<Uint8Array>
  /** What the page wrote. */
  readonly out: CollectingWritable
}

export interface MockSendStream {
  readonly writable: WritableStream<unknown>
  readonly out: CollectingWritable
}

/** Bytes, spelled short. */
export const bytes = (...b: number[]): Uint8Array => Uint8Array.from(b)

/** A draft-17+ unidirectional control stream's first bytes: SETUP's `0x2F00`. */
export const SETUP_PREFIX = bytes(0xaf, 0x00)

/**
 * A WebTransport stand-in whose streams are the platform's own.
 *
 * `bytesAcknowledged` is exposed through `getStats()` on send streams, which is
 * Chromium-only in the wild and is why it is treated as a bonus dimension.
 */
export class MockWebTransport {
  static instances: MockWebTransport[] = []

  readonly url: string
  readonly ctorOptions: Record<string, unknown> | undefined
  protocol = ''
  readonly ready: Promise<void>
  readonly closed: Promise<{ closeCode: number; reason: string }>
  readonly datagrams: {
    readable: ReadableStream<Uint8Array>
    writable: WritableStream<unknown>
  }
  readonly incomingUnidirectionalStreams: ReadableStream<ReadableStream<Uint8Array>>
  readonly incomingBidirectionalStreams: ReadableStream<MockBidiStream>

  /** Test controls. */
  readonly incomingUni: ManualSource<ReadableStream<Uint8Array>>
  readonly incomingBidi: ManualSource<MockBidiStream>
  readonly datagramsIn: ManualSource<Uint8Array>
  readonly datagramsOut: CollectingWritable
  readonly createdBidi: MockBidiStream[] = []
  readonly createdUni: MockSendStream[] = []
  bytesAcknowledged = 0
  /** When set, every stream creation rejects with it. */
  rejectStreams: unknown

  private readonly readyD = deferred<void>()
  private readonly closedD = deferred<{ closeCode: number; reason: string }>()

  constructor(url: string | URL, options?: Record<string, unknown>) {
    this.url = String(url)
    this.ctorOptions = options
    this.ready = this.readyD.promise
    this.closed = this.closedD.promise
    // Nothing here must reject before a test attaches a handler; the hook
    // attaches its own synchronously in the constructor, so this is safe.
    this.closed.catch(() => {})
    this.ready.catch(() => {})

    this.incomingUni = manualSource<ReadableStream<Uint8Array>>()
    this.incomingBidi = manualSource<MockBidiStream>()
    this.incomingUnidirectionalStreams = this.incomingUni.stream
    this.incomingBidirectionalStreams = this.incomingBidi.stream

    this.datagramsIn = manualSource<Uint8Array>()
    this.datagramsOut = collectingWritable()
    this.datagrams = {
      readable: this.datagramsIn.stream,
      writable: this.datagramsOut.stream,
    }

    MockWebTransport.instances.push(this)
  }

  /** Establish the session, optionally with the server's protocol pick. */
  open(protocol?: string): Promise<void> {
    if (protocol !== undefined) this.protocol = protocol
    this.readyD.resolve()
    return this.ready
  }

  failToOpen(reason: unknown): void {
    this.readyD.reject(reason)
  }

  closeSession(reason = '', closeCode = 0): void {
    this.closedD.resolve({ closeCode, reason })
  }

  errorSession(reason: unknown): void {
    this.closedD.reject(reason)
  }

  createBidirectionalStream(): Promise<MockBidiStream> {
    if (this.rejectStreams !== undefined) return Promise.reject(this.rejectStreams)
    const inbound = manualSource<Uint8Array>()
    const out = collectingWritable()
    const stream: MockBidiStream = {
      readable: inbound.stream,
      writable: out.stream,
      inbound,
      out,
    }
    this.createdBidi.push(stream)
    return Promise.resolve(stream)
  }

  createUnidirectionalStream(
    opts: { hold?: boolean; highWaterMark?: number } = {},
  ): Promise<WritableStream<unknown>> {
    if (this.rejectStreams !== undefined) return Promise.reject(this.rejectStreams)
    const out = collectingWritable(opts)
    // A real WebTransportSendStream carries getStats(); bytesAcknowledged is
    // the only per-object acknowledgement a browser offers.
    Object.defineProperty(out.stream, 'getStats', {
      configurable: true,
      value: () => Promise.resolve({ bytesAcknowledged: this.bytesAcknowledged }),
    })
    this.createdUni.push({ writable: out.stream, out })
    return Promise.resolve(out.stream)
  }

  /** A receive stream arriving from the peer, carrying `chunks`. */
  deliverUniStream(chunks: readonly Uint8Array[] = []): ManualSource<Uint8Array> {
    const src = manualSource<Uint8Array>()
    this.incomingUni.push(src.stream)
    for (const c of chunks) src.push(c)
    return src
  }

  deliverBidiStream(chunks: readonly Uint8Array[] = []): MockBidiStream {
    const inbound = manualSource<Uint8Array>()
    const out = collectingWritable()
    const stream: MockBidiStream = {
      readable: inbound.stream,
      writable: out.stream,
      inbound,
      out,
    }
    this.incomingBidi.push(stream)
    for (const c of chunks) inbound.push(c)
    return stream
  }
}

/** A global-alike carrying only what the hook is allowed to look at. */
export function mockGlobal(WT: unknown = MockWebTransport): { WebTransport?: unknown } {
  MockWebTransport.instances = []
  return { WebTransport: WT }
}

/** Construct through whatever the hook left on the global. */
export function connect(
  glob: { WebTransport?: unknown },
  url: string | URL = 'https://relay.test/moq',
  options?: Record<string, unknown>,
): MockWebTransport {
  const Ctor = glob.WebTransport as new (
    url: string | URL,
    options?: Record<string, unknown>,
  ) => MockWebTransport
  return new Ctor(url, options)
}

/**
 * A `ReadableStream` as the async iterable it actually is at runtime.
 *
 * The workspace compiles with `lib: ["ES2022", "DOM"]` and TypeScript declares
 * `ReadableStream[Symbol.asyncIterator]` only in `DOM.AsyncIterable`, so
 * `for await (… of stream)` is a type error here while working on every runtime
 * this package targets. The cast is the type system catching up, not a claim
 * about the platform.
 */
export const asAsyncIterable = <T>(rs: ReadableStream<T>): AsyncIterable<T> =>
  rs as unknown as AsyncIterable<T>

/** Drain a stream to completion through `getReader()`. */
export async function drain<T>(rs: ReadableStream<T>): Promise<T[]> {
  const out: T[] = []
  const reader = rs.getReader()
  for (;;) {
    const r = await reader.read()
    if (r.done) break
    out.push(r.value as T)
  }
  return out
}

/** Let queued microtasks and one macrotask turn. */
export async function settle(turns = 3): Promise<void> {
  for (let i = 0; i < turns; i++) await Promise.resolve()
  await new Promise<void>((r) => {
    setTimeout(r, 0)
  })
  for (let i = 0; i < turns; i++) await Promise.resolve()
}
