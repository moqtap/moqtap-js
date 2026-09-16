import { MQ6001 } from '../codes.js'
import type {
  ClockAnchor,
  ClockSource,
  Direction,
  HookOptions,
  InterceptedSession,
  Mono,
  StreamChunk,
  StreamOrigin,
  TransportObserver,
  WebTransportOptionsInfo,
} from '../types.js'
import { toBytes } from './control-plane.js'
import { StreamRegistry } from './stream-registry.js'

/**
 * The WebTransport seam.
 *
 * Patching `getReader` and `getWriter` on the stream *instance* is not enough.
 * Five constraints shape everything below.
 *
 * ── 1. `pipeTo` / `pipeThrough` / `tee` / `for await` bypass an instance patch
 *
 * They acquire their reader through the internal
 * `AcquireReadableStreamDefaultReader` operation, which never consults the
 * instance property — and `pipeTo` acquires its *writer* through
 * `AcquireWritableStreamDefaultWriter(dest)`, which likewise never calls
 * `dest.getWriter`. A customer whose player does
 * `wt.incomingUnidirectionalStreams.pipeTo(...)` or `for await (const s of ...)`
 * would therefore report as a perfectly healthy session carrying **no data at
 * all**. So a second seam wraps the stream *object*, not only its accessor:
 *
 *  - every consuming method on an instrumented readable (`pipeTo`,
 *    `pipeThrough`, `tee`, `values`, `Symbol.asyncIterator`) is redirected
 *    through a **relay** — a pull-based pass-through `ReadableStream` with
 *    `highWaterMark: 0` that reads one chunk from the original only when the
 *    consumer asks for one. That is not a `tee()`: teeing doubles buffering and
 *    changes the backpressure the page observes, and a zero-water-mark relay
 *    changes neither. The platform's own `pipeTo` then does all the spec work —
 *    `preventClose`, `preventAbort`, `preventCancel`, `signal` — on the relay.
 *  - the destination half is unreachable from the destination object, because
 *    nothing on a `WritableStream` is called when someone pipes into it. It is
 *    caught with one patch of `ReadableStream.prototype.pipeTo` that checks the
 *    destination against a `WeakSet` of writables this hook observes and
 *    substitutes a relay for those only, passing every other pipe through
 *    untouched. That patch is removed by {@link TransportHook.uninstall}.
 *
 * ── 2. `uninstall` must detach every per-instance patch, not just the global
 *
 * A session opened before the call would otherwise keep its patched
 * `createBidirectionalStream`, `getReader` and `getWriter` and keep reporting —
 * and `abort()` exists precisely for "the reason for stopping is that you no
 * longer want the data to leave the device". So every patch records how to undo
 * itself, and `uninstall()` restores the global, removes the prototype guard,
 * detaches every patch on every open session and stream, and clears the observer
 * so a reader or writer already handed to the page reports nothing further. It
 * is idempotent.
 *
 * ── 3. Double install
 *
 * A second `installWebTransportHook` on the same global must not capture the
 * *patched* constructor as "original", since one uninstall would then leave the
 * page permanently wrapped. It returns the existing hook and re-points its
 * observer.
 *
 * ── 4. Stream ids are per session, session ids are `crypto.randomUUID()`
 *
 * The session id feeds `sha256(sessionId + ':' + segmentSeq)` and ingest dedupes
 * exactly, so a collision is a silently discarded and under-billed session.
 *
 * ── 5. Every interceptor is installed unconditionally
 *
 * Under the install-dormant rule the observer is null when the hook installs, so
 * a capability check at construction time — `if (onStream.onDatagram)` — always
 * fails and datagrams are lost for the life of the session even after a key
 * arrives. Installation is unconditional and gated at the moment of emit.
 *
 * ── Other properties worth naming
 *
 *  - `performance.now()` is stamped **at the seam**, synchronously, rather than
 *    `Date.now()` one message-hop later, so an inter-arrival histogram measures
 *    the network rather than a message queue.
 *  - `writer.ready` latency and `desiredSize` — the only backpressure
 *    signal a publish-only session has. Sampled only when `desiredSize <= 0`,
 *    i.e. once per backpressure episode, so an uncongested writer costs one
 *    property read per write and no promise.
 *  - `WebTransportSendStream.getStats().bytesAcknowledged`, probed at
 *    points that are already asynchronous — never on the write path.
 *  - `captureStacks` defaults to **false**: from draft-17 a bidi stream is
 *    per-request, so unconditional stack capture on bidi writes would run on
 *    the control plane's hot path for no diagnostic gain.
 *  - **Sessions open at `setObserver` time are replayed**, `onSessionOpen`
 *    first and then the negotiated protocol if `ready` has already resolved.
 *    The hook installs dormant and the key arrives later, so a session that opened
 *    before it is the ordinary case on a page that connects at load; without
 *    the replay the observer's first sight of that session is `onStreamData`
 *    for a `sessionId` it has no `ClockAnchor`, URL or protocol for — and the
 *    draft is picked from that protocol. Announcement is keyed on observer
 *    identity, so re-arming dormancy and setting the same observer again
 *    announces nothing twice.
 *  - **A cancelled reader ends its stream.** A player that switches tracks
 *    cancels and sends STOP_SENDING; it never reads to `done`, so without this
 *    the stream's per-stream state would be held to session end.
 *  - **A relay releases the underlying lock** when the stream ends or is
 *    cancelled. `cancel()` does not release a reader's lock, so without this a
 *    page that breaks out of `for await` and re-acquires a reader — which works
 *    natively — would throw only when the collector was present.
 *  - **Stream halves are tracked by name, not counted.** The same side can end
 *    twice (a cancelled reader still resolves its next read as `done`), and a
 *    counter would then close a bidirectional stream while the other side is
 *    still carrying control frames.
 *
 * ── The observer contract, restated because it is load-bearing
 *
 * Every `TransportObserver` method runs synchronously on the page's own data
 * path — `onStreamData` fires BEFORE the page's write reaches the transport. An
 * implementation must be a bounded enqueue and nothing else; the
 * non-interference guarantee is unmeetable by construction otherwise. Every call
 * is wrapped here, so a throwing observer lands in `HookOptions.onInternalError`
 * and never in the page's stack.
 */
export interface TransportHook {
  readonly installed: boolean
  /**
   * Dormant -> live without reinstalling. `null` re-arms dormancy: the
   * patches stay, and nothing is emitted until an observer is set again.
   */
  setObserver(observer: TransportObserver | null): void
  /**
   * Restores the global AND detaches every per-instance patch on open sessions.
   * Idempotent.
   */
  uninstall(): void
}

/* ── minimal structural types for the objects we patch ───────────────────── */

interface ReaderLike {
  read(...args: unknown[]): Promise<{ done: boolean; value?: unknown }>
  cancel?(reason?: unknown): Promise<unknown>
  releaseLock?(): void
}

interface WriterLike {
  write(chunk?: unknown): Promise<unknown>
  close(): Promise<unknown>
  abort?(reason?: unknown): Promise<unknown>
  releaseLock?(): void
  readonly ready?: Promise<unknown>
  readonly desiredSize?: number | null
}

interface RelayController {
  enqueue(chunk: unknown): void
  close(): void
  error(reason?: unknown): void
}

interface RelayReadable {
  pipeTo(dest: unknown, options?: unknown): Promise<void>
  pipeThrough(pair: unknown, options?: unknown): unknown
  tee(): unknown
  values?(options?: unknown): AsyncIterableIterator<unknown>
}

type ReadableCtor = new (
  source: {
    pull?(c: RelayController): unknown
    cancel?(reason?: unknown): unknown
  },
  strategy?: { highWaterMark?: number },
) => RelayReadable

type WritableCtor = new (
  sink: {
    write?(chunk: unknown): unknown
    close?(): unknown
    abort?(reason?: unknown): unknown
  },
  strategy?: { highWaterMark?: number },
) => object

type Detach = () => void
type Register = (d: Detach) => void

/* ── options extraction (ported unchanged apart from its result type) ────── */

/**
 * Pull the parseable fields out of the caller's `WebTransportOptions`.
 *
 * Every read touches a page-controlled object, so the whole thing is wrapped: a
 * throwing getter must not escape the patched constructor and break the page's
 * connection. Only primitives and string arrays are copied out.
 *
 * `serverCertificateHashes` is **counted, never carried** — it is the one field
 * in the options bag with any chance of being sensitive.
 */
export function extractSessionOptions(options: unknown): WebTransportOptionsInfo | undefined {
  try {
    if (!options || typeof options !== 'object') return undefined
    const o = options as Record<string, unknown>
    const info: {
      protocols?: string[]
      congestionControl?: string
      allowPooling?: boolean
      requireUnreliable?: boolean
      serverCertificateHashes?: number
    } = {}

    if (Array.isArray(o.protocols)) {
      const protocols = o.protocols.filter((p): p is string => typeof p === 'string')
      if (protocols.length > 0) info.protocols = protocols
    }
    if (typeof o.congestionControl === 'string') info.congestionControl = o.congestionControl
    if (typeof o.allowPooling === 'boolean') info.allowPooling = o.allowPooling
    if (typeof o.requireUnreliable === 'boolean') info.requireUnreliable = o.requireUnreliable
    if (Array.isArray(o.serverCertificateHashes)) {
      info.serverCertificateHashes = o.serverCertificateHashes.length
    }

    return Object.keys(info).length > 0 ? info : undefined
  } catch {
    return undefined
  }
}

/**
 * The application protocol the server picked, read off the session once it is
 * established.
 *
 * This is the other half of the negotiation whose client side arrives as
 * `options.protocols` (`WT-Available-Protocols`). For MoQT the answer is
 * `moqt-NN`, and from draft-15 the version appears nowhere on the wire, so this
 * string is the only draft identifier a session actually carries.
 *
 * Empty until the session is established, so it is only worth reading from the
 * `ready` continuation. Undefined on browsers that never implemented protocol
 * negotiation. A throwing getter on a page-controlled object must not escape.
 */
export function readNegotiatedProtocol(instance: unknown): string | undefined {
  try {
    if (!instance || typeof instance !== 'object') return undefined
    const p = (instance as Record<string, unknown>).protocol
    return typeof p === 'string' && p.length > 0 ? p : undefined
  } catch {
    return undefined
  }
}

import { joinChain } from './patch-chain.js'

/* ── module state ────────────────────────────────────────────────────────── */

/** One hook per global. The double-install guard (defect 3). */
const installedHooks = new WeakMap<object, TransportHook>()

const INERT_HOOK: TransportHook = {
  installed: false,
  setObserver() {},
  uninstall() {},
}

/* ── install ─────────────────────────────────────────────────────────────── */

/**
 * Patch `target.WebTransport` and report everything that crosses the seam.
 *
 * `observer` may be `null`: the hook is installed at module-eval time and
 * transmits nothing until a key arrives, so dormancy is the *normal* starting
 * state and every interceptor is installed regardless.
 *
 * Never throws for a global without `WebTransport` (a worker with no support);
 * returns an inert hook whose `installed` is false.
 */
export function installWebTransportHook(
  target: { WebTransport?: unknown },
  observer: TransportObserver | null,
  options: HookOptions = {},
): TransportHook {
  const glob = target as unknown as Record<string, unknown>

  const existing = installedHooks.get(target as object)
  if (existing) {
    // A second install must not capture the patched constructor as the
    // original. Re-point the live hook instead.
    existing.setObserver(observer)
    return existing
  }

  const Original = glob.WebTransport
  if (typeof Original !== 'function') return INERT_HOOK

  type Ctor = new (url: string | URL, options?: Record<string, unknown>) => Record<string, unknown>

  /**
   * What we delegate to. **`let`, not `const`**: if a moqtap patch below us
   * leaves the chain it hands us its own delegate and we splice it out, which
   * is only possible if the constructor reads this variable rather than a value
   * captured at install time. See `patch-chain.ts`.
   */
  let OriginalCtor = Original as Ctor

  const clock: ClockSource = options.clock ?? defaultClock()
  const mintSessionId = options.sessionId ?? defaultSessionId
  const captureStacks = options.captureStacks === true
  const onInternalError = options.onInternalError

  let current: TransportObserver | null = observer
  let live = true

  const sessions = new Set<SessionState>()
  const observedWritables = new WeakSet<object>()
  const observedReadables = new WeakMap<object, () => RelayReadable>()

  const ReadableCtor = pickCtor<ReadableCtor>(glob, 'ReadableStream')
  const WritableCtor = pickCtor<WritableCtor>(glob, 'WritableStream')

  function fail(err: unknown): void {
    if (!onInternalError) return
    try {
      onInternalError(err)
    } catch {
      // An onInternalError that throws is the end of the road. Swallow: the
      // alternative is a throw on the page's own data path.
    }
  }

  /** Every observer call goes through here. A throw never reaches the page. */
  function deliver(fn: (o: TransportObserver) => void): void {
    const o = current
    if (!o) return
    try {
      fn(o)
    } catch (err) {
      fail(err)
    }
  }

  /**
   * Tell the current observer about a session, once per observer.
   *
   * The hook installs dormant and a key may arrive at any time, so a
   * session that opened before it — the *common* case on a page that connects
   * at load — would otherwise deliver `onStreamData` for a `sessionId` the
   * observer had never seen opened, with no `ClockAnchor` to relativise it
   * against and no URL. The record is replayed instead, followed by the
   * negotiated protocol if `ready` has already resolved, because the draft
   * selection depends on it and it is announced exactly once.
   *
   * Keyed on observer identity, so re-arming dormancy and setting the same
   * observer again does not announce a session twice.
   */
  function announce(state: SessionState): void {
    const o = current
    if (!o || state.closed || state.announced === o) return
    state.announced = o
    deliver((obs) => obs.onSessionOpen(state.session))
    if (state.protocol !== undefined) {
      const protocol = state.protocol
      deliver((obs) => obs.onSessionProtocol?.(state.id, protocol))
    }
  }

  /* ── per-session state ─────────────────────────────────────────────────── */

  /** Which side of a stream ended. A bidirectional stream has both. */
  type Half = 'read' | 'write'

  interface StreamState {
    readonly id: number
    readonly bidi: boolean
    /**
     * Halves already finished, **by name rather than by count**. A count is not
     * enough: a page that cancels its reader and then reads once more, or
     * aborts a writer it has already closed, ends the same half twice — and a
     * counter would then report a bidirectional stream closed while the other
     * side is still carrying control frames.
     */
    readonly done: Set<Half>
    closed: boolean
    detachers: Detach[]
  }

  interface SessionState {
    readonly id: string
    readonly registry: StreamRegistry
    readonly detachers: Set<Detach>
    readonly streams: Map<number, StreamState>
    /** The record `onSessionOpen` was given, kept for the dormancy replay. */
    readonly session: InterceptedSession
    /** The server's pick, once `ready` has resolved. */
    protocol: string | undefined
    /** The observer this session has already been announced to. */
    announced: TransportObserver | null
    closed: boolean
  }

  function detachAll(state: SessionState): void {
    for (const d of state.detachers) runDetach(d)
    state.detachers.clear()
    for (const s of state.streams.values()) {
      for (const d of s.detachers) runDetach(d)
      s.detachers = []
    }
  }

  function runDetach(d: Detach): void {
    try {
      d()
    } catch (err) {
      fail(err)
    }
  }

  /* ── the patched constructor ───────────────────────────────────────────── */

  function PatchedWebTransport(
    this: unknown,
    url: string | URL,
    ctorOptions?: Record<string, unknown>,
  ): Record<string, unknown> {
    // Delegate first, with the caller's own arguments, so a failure to
    // construct fails exactly as it would have without us.
    const instance = new OriginalCtor(url, ctorOptions)
    try {
      attach(instance, url, ctorOptions)
    } catch (err) {
      fail(err)
    }
    return instance
  }

  // Preserve the prototype chain and the name so `instanceof` and stack traces
  // survive.
  PatchedWebTransport.prototype = (Original as { prototype: unknown }).prototype
  try {
    Object.defineProperty(PatchedWebTransport, 'name', { value: 'WebTransport' })
  } catch (err) {
    fail(err)
  }

  glob.WebTransport = PatchedWebTransport

  const chain = joinChain(target as object, {
    id: 'collector',
    patched: PatchedWebTransport,
    original: OriginalCtor,
    repoint(next: unknown): void {
      OriginalCtor = next as Ctor
    },
  })

  const restorePipeGuard = installPipeGuard()

  /* ── attaching one session ─────────────────────────────────────────────── */

  function attach(
    instance: Record<string, unknown>,
    url: string | URL,
    ctorOptions: Record<string, unknown> | undefined,
  ): void {
    const sessionId = safeSessionId()
    // Both clocks at session start. `originMono` is on the same
    // `performance.now()` timeline as every `at` this hook stamps, so ingest
    // relativises a session by subtracting it exactly once — see the note on
    // Mono in the module docs of `types.ts`.
    const anchor: ClockAnchor = { originMono: clock.now(), originWall: clock.wall() }

    // The spec allows a URL object here and several MoQ libraries pass one. It
    // must be stringified: URL is not structured-cloneable, so a hook that
    // carries it makes any postMessage of the session record throw
    // DataCloneError and the session is never reported at all.
    const info = extractSessionOptions(ctorOptions)
    const session: InterceptedSession = info
      ? { id: sessionId, url: String(url), anchor, options: info }
      : { id: sessionId, url: String(url), anchor }

    const state: SessionState = {
      id: sessionId,
      registry: new StreamRegistry(sessionId),
      detachers: new Set(),
      streams: new Map(),
      session,
      protocol: undefined,
      announced: null,
      closed: false,
    }
    sessions.add(state)

    const addSession: Register = (d) => {
      state.detachers.add(d)
    }

    announce(state)

    patchMethod(
      instance,
      'createBidirectionalStream',
      addSession,
      (orig) =>
        (...args: unknown[]) => {
          const streamId = allocate(state, true, 'local')
          const result = orig(...args)
          if (!isThenable(result)) return result
          return result.then(
            (stream: unknown) => {
              try {
                attachBidiStream(state, stream, streamId, 'local')
              } catch (err) {
                fail(err)
              }
              return stream
            },
            // A stream that never opened still consumed an id, and the registry
            // classified it. Release it — a page retrying against a dying
            // session would otherwise grow the map without bound.
            (err: unknown) => {
              state.registry.close(streamId)
              throw err
            },
          )
        },
    )

    patchMethod(
      instance,
      'createUnidirectionalStream',
      addSession,
      (orig) =>
        (...args: unknown[]) => {
          const streamId = allocate(state, false, 'local')
          const result = orig(...args)
          if (!isThenable(result)) return result
          return result.then(
            (writable: unknown) => {
              try {
                openStream(state, streamId, false, 'local')
                instrumentWritable(
                  state,
                  writable,
                  streamId,
                  false,
                  addStreamRegister(state, streamId),
                )
              } catch (err) {
                fail(err)
              }
              return writable
            },
            (err: unknown) => {
              state.registry.close(streamId)
              throw err
            },
          )
        },
    )

    tapIncomingStreams(state, instance.incomingBidirectionalStreams, true, addSession)
    tapIncomingStreams(state, instance.incomingUnidirectionalStreams, false, addSession)

    // Unconditional: the observer is null at install, so a capability check
    // here would permanently disable datagrams.
    instrumentDatagrams(state, instance.datagrams, addSession)

    watchLifecycle(state, instance)
  }

  function allocate(state: SessionState, bidi: boolean, origin: StreamOrigin): number {
    // Allocated synchronously, before the create promise settles, so ids follow
    // the order the page asked for streams in rather than the order the
    // transport happened to resolve them.
    return state.registry.next(bidi, origin)
  }

  function openStream(
    state: SessionState,
    streamId: number,
    bidi: boolean,
    origin: StreamOrigin,
  ): StreamState {
    let s = state.streams.get(streamId)
    if (!s) {
      s = {
        id: streamId,
        bidi,
        done: new Set<Half>(),
        closed: false,
        detachers: [],
      }
      state.streams.set(streamId, s)
    }
    deliver((o) => o.onStreamOpen?.(state.id, streamId, bidi, origin))
    return s
  }

  function addStreamRegister(state: SessionState, streamId: number): Register {
    return (d) => {
      const s = state.streams.get(streamId)
      if (s) s.detachers.push(d)
      else state.detachers.add(d)
    }
  }

  /**
   * One half of a stream finished.
   *
   * `onStreamClose` fires only when **every** half is done — immediately for a
   * unidirectional stream, and after both sides for a bidirectional one. Firing
   * on the first half would tell the decoder a draft-17+ request stream is over
   * while control frames are still arriving on the other side, which is silent
   * data loss; the cost of the conservative rule is that a bidi stream whose
   * writer the page never closes reports no close until the session ends, and a
   * session's per-stream state is bounded by its open streams either way.
   *
   * `half` is recorded by name, so the same side ending twice — a cancelled
   * reader that is then read to `done`, a writer aborted after close — counts
   * once.
   */
  function halfDone(state: SessionState, streamId: number, at: Mono, half: Half): void {
    const s = state.streams.get(streamId)
    if (!s || s.closed || s.done.has(half)) return
    s.done.add(half)
    if (s.bidi && s.done.size < 2) return
    s.closed = true
    deliver((o) => o.onStreamClose(state.id, streamId, at))
    for (const d of s.detachers) runDetach(d)
    s.detachers = []
    state.streams.delete(streamId)
    state.registry.close(streamId)
  }

  /* ── stream instrumentation ────────────────────────────────────────────── */

  function attachBidiStream(
    state: SessionState,
    stream: unknown,
    streamId: number,
    origin: StreamOrigin,
  ): void {
    if (!stream || typeof stream !== 'object') return
    openStream(state, streamId, true, origin)
    const add = addStreamRegister(state, streamId)
    const s = stream as Record<string, unknown>
    instrumentReadable(state, s.readable, streamId, true, add)
    instrumentWritable(state, s.writable, streamId, true, add)
  }

  /** Bytes arriving on a stream. `rx` for a readable, `tx` for a writable. */
  function emitStreamData(
    state: SessionState,
    streamId: number,
    bidi: boolean,
    direction: Direction,
    value: unknown,
    at: Mono,
    stack: string | undefined,
  ): void {
    const data = toBytes(value)
    if (!data) return
    // Control-plane classification lives here: sticky, first-chunk-only, and
    // never `bidi` alone. Run it
    // even while dormant so the sticky decision is still made from the stream's
    // FIRST bytes rather than from wherever the observer happened to arrive.
    const control = state.registry.classify(streamId, bidi, data)
    if (!current) return
    const chunk: StreamChunk =
      stack === undefined
        ? { sessionId: state.id, streamId, direction, bidi, control, data, at }
        : { sessionId: state.id, streamId, direction, bidi, control, data, at, stack }
    deliver((o) => o.onStreamData(chunk))
  }

  function instrumentReadable(
    state: SessionState,
    readable: unknown,
    streamId: number,
    bidi: boolean,
    add: Register,
  ): void {
    instrumentReadableWith(
      readable,
      add,
      (value, at) => emitStreamData(state, streamId, bidi, 'rx', value, at, undefined),
      (at) => halfDone(state, streamId, at, 'read'),
      (err) => {
        deliver((o) => o.onStreamError(state.id, streamId, err))
        halfDone(state, streamId, clock.now(), 'read')
      },
    )
  }

  /**
   * The readable seam.
   *
   * Two layers, because one is not enough:
   *   1. `getReader` — the direct path. Reader options are forwarded, so a BYOB
   *      reader still works and its reads are still observed.
   *   2. `pipeTo` / `pipeThrough` / `tee` / `values` / `Symbol.asyncIterator` —
   *      every path that acquires a reader internally and never touches (1).
   *      Each is redirected through a relay built on the *original* accessor,
   *      so a chunk is observed exactly once whichever route the page takes.
   */
  function instrumentReadableWith(
    readable: unknown,
    add: Register,
    onValue: (value: unknown, at: Mono) => void,
    onDone: (at: Mono) => void,
    onError: (err: unknown) => void,
  ): void {
    if (!readable || typeof readable !== 'object') return
    const rs = readable as Record<PropertyKey, unknown>
    if (typeof rs.getReader !== 'function') return

    const origGetReader = (rs.getReader as (...a: unknown[]) => unknown).bind(readable)

    patchValue(rs, 'getReader', add, (...args: unknown[]) => {
      const reader = origGetReader(...args)
      try {
        return instrumentReader(reader, onValue, onDone, onError)
      } catch (err) {
        fail(err)
        return reader
      }
    })

    if (!ReadableCtor) return

    const makeRelay = (): RelayReadable => {
      // Acquire through the ORIGINAL accessor: the relay observes chunks
      // itself, and routing it through the patched one would count every
      // piped byte twice.
      const reader = origGetReader() as ReaderLike
      // Set the moment the underlying stream is finished with, so a read that
      // settles after a cancel neither reports a second close nor touches a
      // controller the platform has already torn down.
      let finished = false

      /**
       * Give the page its stream back.
       *
       * The relay holds a reader for as long as it lives, and `cancel()` does
       * not release a reader's lock. Without this, `for await (…) { break }`
       * would leave the underlying stream locked forever — so a page that
       * stopped iterating and re-acquired a reader, which works natively, would
       * throw only when the collector was present. That is a behaviour change,
       * not an observation.
       */
      const release = (): void => {
        try {
          reader.releaseLock?.()
        } catch (err) {
          // Only reachable with reads still outstanding, which cancel resolves
          // first. Nothing to do but not throw into the page.
          fail(err)
        }
      }

      return new ReadableCtor(
        {
          pull: (controller) =>
            reader.read().then(
              (result) => {
                if (finished) return
                if (result.done) {
                  finished = true
                  onDone(clock.now())
                  release()
                  controller.close()
                  return
                }
                try {
                  onValue(result.value, clock.now())
                } catch (err) {
                  fail(err)
                }
                controller.enqueue(result.value)
              },
              (err: unknown) => {
                if (finished) return
                finished = true
                onError(err)
                release()
                throw err
              },
            ),
          cancel: (reason) => {
            // The consumer walked away: the stream is over as far as the
            // collector is concerned, and saying so is what lets the decoder
            // drop its per-stream state instead of holding it to session end.
            if (finished) return undefined
            finished = true
            const cancelled = reader.cancel?.(reason)
            onDone(clock.now())
            release()
            return cancelled
          },
        },
        // Zero, so the relay pulls one chunk only when the consumer asks for
        // one. This is what makes it a pass-through rather than a tee: no
        // second buffer, and the page sees the backpressure it would have seen.
        { highWaterMark: 0 },
      )
    }

    observedReadables.set(readable, makeRelay)
    add(() => {
      observedReadables.delete(readable)
    })

    if (typeof rs.pipeTo === 'function') {
      patchValue(rs, 'pipeTo', add, (dest: unknown, opts?: unknown) => {
        try {
          return makeRelay().pipeTo(dest, opts)
        } catch (err) {
          fail(err)
          return Promise.reject(err)
        }
      })
    }
    if (typeof rs.pipeThrough === 'function') {
      const origPipeThrough = (rs.pipeThrough as (...a: unknown[]) => unknown).bind(readable)
      patchValue(rs, 'pipeThrough', add, (pair: unknown, opts?: unknown) => {
        try {
          return makeRelay().pipeThrough(pair, opts)
        } catch (err) {
          fail(err)
          return origPipeThrough(pair, opts)
        }
      })
    }
    if (typeof rs.tee === 'function') {
      const origTee = (rs.tee as () => unknown).bind(readable)
      patchValue(rs, 'tee', add, () => {
        try {
          return makeRelay().tee()
        } catch (err) {
          fail(err)
          return origTee()
        }
      })
    }
    // Only when the platform already has it. Adding an async iterator where the
    // browser has none would make `for await` start working under observation
    // and throw without it — a behaviour change, not an observation.
    const iterate = (opts?: unknown): AsyncIterableIterator<unknown> => {
      const relay = makeRelay()
      const values = relay.values
      if (typeof values !== 'function') throw new TypeError(MQ6001)
      return values.call(relay, opts)
    }
    if (typeof rs.values === 'function') patchValue(rs, 'values', add, iterate)
    if (typeof rs[Symbol.asyncIterator] === 'function') {
      patchValue(rs, Symbol.asyncIterator, add, iterate)
    }
  }

  function instrumentReader(
    reader: unknown,
    onValue: (value: unknown, at: Mono) => void,
    onDone: (at: Mono) => void,
    onError: (err: unknown) => void,
  ): unknown {
    if (!reader || typeof reader !== 'object') return reader
    const r = reader as Record<string, unknown>
    if (typeof r.read !== 'function') return reader
    const origRead = (
      r.read as (...a: unknown[]) => Promise<{ done: boolean; value?: unknown }>
    ).bind(reader)
    // The reader is created per `getReader()` call and handed straight to the
    // caller, so it needs no detacher: it dies with the caller, and after
    // uninstall the observer is null and every emit is a no-op.
    r.read = (...args: unknown[]) =>
      origRead(...args).then(
        (result) => {
          try {
            if (result.done) onDone(clock.now())
            else onValue(result.value, clock.now())
          } catch (err) {
            fail(err)
          }
          return result
        },
        (err: unknown) => {
          try {
            onError(err)
          } catch (e) {
            fail(e)
          }
          throw err
        },
      )
    // A page that cancels its reader is done with the stream — it sends
    // STOP_SENDING and never reads to `done`, so without this the stream's
    // per-stream state would be held until the session ended.
    if (typeof r.cancel === 'function') {
      const origCancel = (r.cancel as (reason?: unknown) => Promise<unknown>).bind(reader)
      r.cancel = (reason?: unknown) => {
        try {
          onDone(clock.now())
        } catch (err) {
          fail(err)
        }
        return origCancel(reason)
      }
    }
    return reader
  }

  function instrumentWritable(
    state: SessionState,
    writable: unknown,
    streamId: number,
    bidi: boolean,
    add: Register,
  ): void {
    if (!writable || typeof writable !== 'object') return
    const ws = writable as Record<string, unknown>
    if (typeof ws.getWriter !== 'function') return

    const origGetWriter = (ws.getWriter as (...a: unknown[]) => unknown).bind(writable)

    patchValue(ws, 'getWriter', add, (...args: unknown[]) => {
      const writer = origGetWriter(...args)
      try {
        return instrumentWriter(
          writer,
          writable,
          (value, at, stack) => emitStreamData(state, streamId, bidi, 'tx', value, at, stack),
          (at) => halfDone(state, streamId, at, 'write'),
          { sessionId: state.id, streamId, bidi },
        )
      } catch (err) {
        fail(err)
        return writer
      }
    })

    // The destination half of `someReadable.pipeTo(thisWritable)` is invisible
    // from here — see the prototype guard.
    observedWritables.add(writable)
    add(() => {
      observedWritables.delete(writable)
    })
  }

  function instrumentWriter(
    writer: unknown,
    sendStream: unknown,
    onChunk: (value: unknown, at: Mono, stack: string | undefined) => void,
    onDone: (at: Mono) => void,
    who: { sessionId: string; streamId: number; bidi: boolean },
  ): unknown {
    if (!writer || typeof writer !== 'object') return writer
    const w = writer as Record<string, unknown> & WriterLike
    if (typeof w.write !== 'function') return writer

    const origWrite = (w.write as (chunk?: unknown) => Promise<unknown>).bind(writer)
    let sampling = false

    w.write = (chunk?: unknown) => {
      try {
        // BEFORE the write reaches the transport, as the extension does at
        // :417: the seam's timestamp is the moment the page handed the bytes
        // over, not the moment the transport accepted them.
        const stack = captureStacks && who.bidi ? new Error().stack : undefined
        onChunk(chunk, clock.now(), stack)
        samplePressure()
      } catch (err) {
        fail(err)
      }
      return origWrite(chunk)
    }

    if (typeof w.close === 'function') {
      const origClose = (w.close as () => Promise<unknown>).bind(writer)
      w.close = () => {
        try {
          onDone(clock.now())
          probeSendStats(sendStream, who)
        } catch (err) {
          fail(err)
        }
        return origClose()
      }
    }
    if (typeof w.abort === 'function') {
      const origAbort = (w.abort as (reason?: unknown) => Promise<unknown>).bind(writer)
      w.abort = (reason?: unknown) => {
        try {
          onDone(clock.now())
        } catch (err) {
          fail(err)
        }
        return origAbort(reason)
      }
    }

    /**
     * `writer.ready` latency and queue depth, "the producer-side quality
     * signal, and it has no subscriber-side analogue".
     *
     * Sampled only while backpressured. Attaching a continuation to
     * `writer.ready` on every write would allocate a microtask per object on
     * the publish path for a number that is zero whenever it matters least;
     * `desiredSize <= 0` is one property read and is exactly the condition
     * under which the number is interesting.
     */
    function samplePressure(): void {
      if (sampling) return
      const size = readDesiredSize(w)
      if (size === null || size > 0) return
      const ready = w.ready
      if (!isThenable(ready)) return
      sampling = true
      const t0 = clock.now()
      ready.then(
        () => {
          sampling = false
          const at = clock.now()
          deliver((o) =>
            o.onWriterPressure?.({
              sessionId: who.sessionId,
              streamId: who.streamId,
              readyLatencyMs: at - t0,
              desiredSize: readDesiredSize(w),
              at,
            }),
          )
          probeSendStats(sendStream, who)
        },
        () => {
          sampling = false
        },
      )
    }

    return writer
  }

  /**
   * `WebTransportSendStream.getStats().bytesAcknowledged` — combined
   * with object headers it is a genuine time-to-acknowledge per object, and
   * nothing else in a browser offers one. Chromium-only, so it is feature
   * detected and treated as a bonus dimension, never as a foundation.
   *
   * Called only from points that are already asynchronous — a resolved
   * backpressure episode, and `writer.close()` — never from the write path.
   */
  function probeSendStats(sendStream: unknown, who: { streamId: number; sessionId: string }): void {
    if (!current?.onSendStats) return
    if (!sendStream || typeof sendStream !== 'object') return
    const getStats = (sendStream as Record<string, unknown>).getStats
    if (typeof getStats !== 'function') return
    try {
      const p = (getStats as () => unknown).call(sendStream)
      if (!isThenable(p)) return
      p.then(
        (stats: unknown) => {
          const raw =
            stats && typeof stats === 'object'
              ? (stats as Record<string, unknown>).bytesAcknowledged
              : undefined
          const acked =
            typeof raw === 'bigint' ? Number(raw) : typeof raw === 'number' ? raw : undefined
          if (acked === undefined) return
          deliver((o) => o.onSendStats?.(who.sessionId, who.streamId, acked, clock.now()))
        },
        () => {},
      )
    } catch (err) {
      fail(err)
    }
  }

  /* ── incoming stream queues ────────────────────────────────────────────── */

  function tapIncomingStreams(
    state: SessionState,
    queue: unknown,
    bidi: boolean,
    add: Register,
  ): void {
    instrumentReadableWith(
      queue,
      add,
      (value) => {
        if (!value) return
        try {
          const streamId = allocate(state, bidi, 'remote')
          if (bidi) {
            attachBidiStream(state, value, streamId, 'remote')
          } else {
            // A unidirectional stream arrives as a bare ReadableStream.
            openStream(state, streamId, false, 'remote')
            instrumentReadable(state, value, streamId, false, addStreamRegister(state, streamId))
          }
        } catch (err) {
          fail(err)
        }
      },
      () => {},
      (err) => fail(err),
    )
  }

  /* ── datagrams ─────────────────────────────────────────────────────────── */

  function instrumentDatagrams(state: SessionState, datagrams: unknown, add: Register): void {
    if (!datagrams || typeof datagrams !== 'object') return
    const dg = datagrams as Record<string, unknown>

    const emit = (direction: Direction, value: unknown, at: Mono): void => {
      if (!current?.onDatagram) return
      const data = toBytes(value)
      if (!data) return
      deliver((o) => o.onDatagram?.({ sessionId: state.id, direction, data, at }))
    }

    instrumentReadableWith(
      dg.readable,
      add,
      (value, at) => emit('rx', value, at),
      () => {},
      (err) => fail(err),
    )

    const writable = dg.writable
    if (writable && typeof writable === 'object') {
      const ws = writable as Record<string, unknown>
      if (typeof ws.getWriter === 'function') {
        const origGetWriter = (ws.getWriter as (...a: unknown[]) => unknown).bind(writable)
        patchValue(ws, 'getWriter', add, (...args: unknown[]) => {
          const writer = origGetWriter(...args)
          try {
            // Datagrams have no stream id, so no writer pressure and no send
            // stats: `WriterPressure` is keyed by `streamId` and a datagram
            // writer has none.
            return instrumentWriter(
              writer,
              undefined,
              (value, at) => emit('tx', value, at),
              () => {},
              { sessionId: state.id, streamId: -1, bidi: false },
            )
          } catch (err) {
            fail(err)
            return writer
          }
        })
        observedWritables.add(writable)
        add(() => {
          observedWritables.delete(writable)
        })
      }
    }
  }

  /* ── session lifecycle ─────────────────────────────────────────────────── */

  function watchLifecycle(state: SessionState, instance: Record<string, unknown>): void {
    const ready = instance.ready
    const closed = instance.closed

    // The negotiated protocol is the empty string until the session is
    // established, so the read has to wait for `ready`.
    if (isThenable(ready)) {
      ready.then(
        () => {
          const protocol = readNegotiatedProtocol(instance)
          if (!protocol) return
          // Remembered as well as reported: a key may arrive after the
          // session is established, and the pick is announced exactly once.
          state.protocol = protocol
          if (state.announced) deliver((o) => o.onSessionProtocol?.(state.id, protocol))
        },
        () => {},
      )
      ready.then(undefined, (err: unknown) => reportClose(state, String(err)))
    }

    if (isThenable(closed)) {
      closed.then(
        (infoValue: unknown) => {
          const info = infoValue as { closeCode?: number; reason?: string } | undefined
          const reason =
            info && typeof info === 'object'
              ? info.reason || `code ${info.closeCode ?? 0}`
              : 'closed'
          reportClose(state, reason)
        },
        (err: unknown) => reportClose(state, String(err)),
      )
    }
  }

  function reportClose(state: SessionState, reason: string): void {
    if (state.closed) return
    state.closed = true
    deliver((o) => o.onSessionClose(state.id, reason, clock.now()))
    // The transport is gone; releasing the patches releases our references to
    // the page's objects with it.
    detachAll(state)
    sessions.delete(state)
  }

  /* ── the `pipeTo` destination guard ────────────────────────────────────── */

  /**
   * `someReadable.pipeTo(wt.writable)` acquires its writer through
   * `AcquireWritableStreamDefaultWriter(dest)`, an internal operation. Nothing
   * on `dest` is called, so there is nothing on `dest` to patch — this is the
   * one case that cannot be fixed on the instance.
   *
   * One patch of `ReadableStream.prototype.pipeTo` closes it. Every pipe whose
   * destination this hook does not observe is passed straight through to the
   * original, so the blast radius on the page is a `WeakSet` lookup. The same
   * patch also catches an observed *source* invoked as
   * `ReadableStream.prototype.pipeTo.call(rs, …)`, which sidesteps the instance
   * patch. Removed by `uninstall()`.
   */
  function installPipeGuard(): Detach | undefined {
    if (!ReadableCtor || !WritableCtor) return undefined
    const proto = (ReadableCtor as unknown as { prototype?: Record<string, unknown> }).prototype
    if (!proto || typeof proto.pipeTo !== 'function') return undefined
    const orig = proto.pipeTo as (this: unknown, dest: unknown, options?: unknown) => Promise<void>

    const patched = function (this: unknown, dest: unknown, options?: unknown): Promise<void> {
      let source: unknown = this
      let target: unknown = dest
      let releaseTarget: (() => void) | undefined
      try {
        // Destination first: substituting it can fail (an already-locked
        // writable), and failing before the source relay has locked `this`
        // leaves the fallback path indistinguishable from no hook at all.
        if (dest && typeof dest === 'object' && observedWritables.has(dest as object)) {
          const wrapped = relayWritable(dest)
          if (wrapped) {
            target = wrapped.stream
            releaseTarget = wrapped.release
          }
        }
        if (this && typeof this === 'object') {
          const relay = observedReadables.get(this as object)
          if (relay) source = relay()
        }
      } catch (err) {
        fail(err)
        // Hand back anything already taken, so the fallback is a pipe the page
        // could have made itself.
        releaseTarget?.()
        source = this
        target = dest
        releaseTarget = undefined
      }
      const piped = orig.call(source, target, options)
      if (!releaseTarget) return piped
      // A pipe that never started — a source the page had already locked, say —
      // must not keep the destination's writer. `pipeTo` reports that as a
      // rejection rather than a throw, so it is caught here and not above.
      const release = releaseTarget
      return piped.then(
        (v) => v,
        (err: unknown) => {
          release()
          throw err
        },
      )
    }

    proto.pipeTo = patched
    return () => {
      if (proto.pipeTo === patched) proto.pipeTo = orig
    }
  }

  /**
   * A relay destination. It writes through the observed writable's own
   * (patched) `getWriter`, so the chunk is counted exactly once — in
   * `instrumentWriter`, on the same code path a direct `getWriter()` user
   * takes.
   */
  function relayWritable(
    dest: unknown,
  ): { readonly stream: object; readonly release: () => void } | undefined {
    if (!WritableCtor) return undefined
    const getWriter = (dest as Record<string, unknown>).getWriter
    if (typeof getWriter !== 'function') return undefined
    const writer = (getWriter as (...a: unknown[]) => unknown).call(dest) as WriterLike
    const stream = new WritableCtor(
      {
        write: (chunk) => writer.write(chunk),
        close: () => writer.close(),
        abort: (reason) => writer.abort?.(reason),
      },
      { highWaterMark: 1 },
    )
    // Acquiring the writer locks the page's writable. If the pipe is abandoned
    // before it starts — the source turned out to be locked, say — the lock
    // must go back, or the page's own stream is unusable from then on.
    return {
      stream,
      release: () => {
        try {
          writer.releaseLock?.()
        } catch (err) {
          fail(err)
        }
      },
    }
  }

  /* ── patch bookkeeping ─────────────────────────────────────────────────── */

  /**
   * Replace `obj[key]`, remembering enough to put it back exactly.
   *
   * "Exactly" matters: on a real `ReadableStream` the method lives on the
   * prototype, so the patch adds an *own* property and undoing it means
   * `delete`, not assignment — assigning the original back would leave a
   * shadowing own property that is indistinguishable from the prototype's
   * method until someone compares identities. The detacher also refuses to
   * touch a property something else has replaced since.
   */
  function patchValue(
    obj: object,
    key: PropertyKey,
    add: Register,
    replacement: (...args: never[]) => unknown,
  ): void {
    const rec = obj as Record<PropertyKey, unknown>
    const hadOwn = Object.hasOwn(obj, key)
    const original = rec[key]
    try {
      rec[key] = replacement
    } catch (err) {
      // Frozen or a setter-less accessor: leave the page alone.
      fail(err)
      return
    }
    if (rec[key] !== replacement) return
    add(() => {
      if (rec[key] !== replacement) return
      if (hadOwn) rec[key] = original
      else {
        try {
          delete rec[key]
        } catch {
          rec[key] = original
        }
      }
    })
  }

  function patchMethod(
    obj: Record<string, unknown>,
    key: string,
    add: Register,
    make: (orig: (...args: unknown[]) => unknown) => (...args: unknown[]) => unknown,
  ): void {
    const orig = obj[key]
    if (typeof orig !== 'function') return
    const bound = (orig as (...args: unknown[]) => unknown).bind(obj)
    patchValue(obj, key, add, make(bound) as (...args: never[]) => unknown)
  }

  function safeSessionId(): string {
    try {
      const id = mintSessionId()
      if (typeof id === 'string' && id.length > 0) return id
    } catch (err) {
      fail(err)
    }
    return defaultSessionId()
  }

  /* ── the hook handle ───────────────────────────────────────────────────── */

  const hook: TransportHook = {
    get installed() {
      return live
    },
    setObserver(next: TransportObserver | null): void {
      if (!live) return
      current = next
      // The hook installs dormant and a key may arrive at any time, so
      // sessions that opened before it must be replayed — otherwise the first
      // thing the new observer sees is stream data for a session it has no
      // anchor, URL or protocol for.
      if (!next) return
      for (const state of sessions) announce(state)
    },
    uninstall(): void {
      if (!live) return
      live = false
      // Cleared first: a reader or writer already handed to the page keeps its
      // patched method, and this is what makes it inert.
      current = null
      // Leave the chain first: if a moqtap patch is above us it takes our
      // delegate and the global keeps naming *it*, which is correct. Only when
      // nothing above us claims it do we touch the global -- and even then only
      // if we are still the outermost patch, since a non-participant may have
      // landed on top and restoring past it would discard their work.
      const handover = chain.release()
      if (handover !== null && glob.WebTransport === PatchedWebTransport) {
        glob.WebTransport = handover.restore
      }
      if (restorePipeGuard) runDetach(restorePipeGuard)
      for (const state of sessions) {
        state.closed = true
        detachAll(state)
      }
      sessions.clear()
      installedHooks.delete(target as object)
    },
  }

  installedHooks.set(target as object, hook)
  return hook
}

/* ── free functions ──────────────────────────────────────────────────────── */

function pickCtor<T>(glob: Record<string, unknown>, name: string): T | undefined {
  const fromTarget = glob[name]
  if (typeof fromTarget === 'function') return fromTarget as T
  const fromGlobal = (globalThis as unknown as Record<string, unknown>)[name]
  if (typeof fromGlobal === 'function') return fromGlobal as T
  return undefined
}

function isThenable(v: unknown): v is Promise<unknown> {
  return (
    !!v &&
    (typeof v === 'object' || typeof v === 'function') &&
    typeof (v as { then?: unknown }).then === 'function'
  )
}

/** `desiredSize` is a getter and throws on an errored stream. */
function readDesiredSize(w: WriterLike): number | null {
  try {
    const n = w.desiredSize
    return typeof n === 'number' ? n : null
  } catch {
    return null
  }
}

/**
 * `performance.now()` for {@link Mono}, `Date.now()` for wall time.
 *
 * `performance.now()` is the whole point: it is monotonic, it is not corrected
 * by NTP, and it has sub-millisecond resolution. `Date.now()` on the data path
 * would make every inter-arrival histogram vulnerable to a clock step.
 */
function defaultClock(): ClockSource {
  const perf = (globalThis as unknown as { performance?: { now?: () => number } }).performance
  const now = typeof perf?.now === 'function' ? () => perf.now?.() ?? Date.now() : () => Date.now()
  return { now, wall: () => Date.now() }
}

/**
 * The default session id.
 *
 * `crypto.randomUUID()` (see `HookOptions.sessionId` in `types.ts`), because the
 * id feeds `sha256(sessionId + ':' + segmentSeq)` and ingest dedupes exactly: a
 * collision is a silently discarded and under-billed session. A timestamp-plus-
 * counter id collides across two tabs opened in the same millisecond.
 *
 * `randomUUID` is unavailable on insecure origins in some browsers, so there
 * are two fallbacks — a v4 built from `getRandomValues`, and, only when there
 * is no `crypto` at all, `Math.random`. The last one is genuinely weaker and
 * there is nothing better available; it is why `BatchRecord.keyFallback`
 * exists at the other end of the pipeline.
 */
function defaultSessionId(): string {
  const c = (globalThis as unknown as { crypto?: Crypto }).crypto
  try {
    if (typeof c?.randomUUID === 'function') return c.randomUUID()
    if (typeof c?.getRandomValues === 'function') {
      const b = c.getRandomValues(new Uint8Array(16))
      b[6] = ((b[6] ?? 0) & 0x0f) | 0x40
      b[8] = ((b[8] ?? 0) & 0x3f) | 0x80
      const hex: string[] = []
      for (let i = 0; i < 16; i++) hex.push((b[i] ?? 0).toString(16).padStart(2, '0'))
      return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex
        .slice(6, 8)
        .join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10, 16).join('')}`
    }
  } catch {
    // fall through
  }
  const r = () => Math.random().toString(16).slice(2).padStart(13, '0')
  return `${r()}${r()}`
}
