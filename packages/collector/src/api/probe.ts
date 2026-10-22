/**
 * The worker's half of a link: observe this worker's transports and hand
 * everything to the page.
 *
 * A probe numbers, seals, stores and uploads nothing, and has no end of its
 * own. Every {@link FORWARD_INTERVAL_MS} it transfers the frames it has written
 * to the page, with a snapshot of each open connection's rollup interval, so a
 * worker terminated without warning loses at most that interval's per-object
 * records and none of its counters. The page appends the frames to its own
 * stream without parsing them.
 *
 * A forward of at least `upload.byteThreshold` is gzipped here first, in
 * pieces small enough to be a body each, so at high object rates the page
 * seals, stores and uploads without compressing anything on its main thread.
 * The droppable gate then weighs this probe's buffer by what it will cost
 * once compressed, not by its raw size.
 *
 * Every timestamp is written on the page's timeline from the start: the page
 * sends the offset between the two clocks with each session it records the
 * worker into, and the probe's realm uses it as its origin. Until the page's
 * session begins there is none, and the probe records nothing; the worker's
 * first `WebTransport` is what it tells the page instead.
 */

import type { DraftSet } from '../draft/index.js'
import {
  type DeflateSegment,
  deflateSegment,
  gzipSupported,
  splitFrames,
} from '../envelope/index.js'
import { FrameBuffer } from '../flush/frame-buffer.js'
import type { TriggerEvent } from '../recorder/index.js'
import type { TransportHook } from '../transport/index.js'
import type { ClockSource, DetailLevel, Mono } from '../types.js'
import { levelIndex } from './defaults.js'
import { armDormant, type DormantState, dormantPending } from './dormant.js'
import { TRIGGER_CAPTURE_LEVEL } from './escalation.js'
import type { FlightRecorderFeature } from './features.js'
import {
  type CallMessage,
  envelope,
  FORWARD_INTERVAL_MS,
  type ForwardMessage,
  type ForwardPart,
  type FramesPart,
  HEARTBEAT_MS,
  type LinkedMessage,
  linkMessage,
  type PageMessage,
} from './link.js'
import { type RealmConfig, RealmObserver } from './realm.js'

/** What a worker's build carries: its drafts, and the flight recorder when it has one. */
export interface WorkerBuild {
  readonly drafts: DraftSet
  readonly recorder?: FlightRecorderFeature | undefined
}

export interface ProbePorts {
  readonly clock?: ClockSource
  readonly setTimer?: (fn: () => void, ms: number) => unknown
  readonly clearTimer?: (h: unknown) => void
  readonly onInternalError?: (err: unknown) => void
}

/** Knobs the suite turns; nothing in a deployment does. */
export interface ProbeTuning {
  /** Forwards of at least this many bytes are compressed here. Default `upload.byteThreshold`. */
  readonly compressMinBytes?: number
  /** The compressor. Default `CompressionStream`, through {@link deflateSegment}. */
  readonly deflate?: (bytes: Uint8Array) => Promise<DeflateSegment>
}

const platformClock: ClockSource = { now: () => performance.now(), wall: () => Date.now() }

/**
 * Compressed bytes one piece aims at, and the most it may come to.
 *
 * Each piece becomes a body of its own, which has to fit `sendBeacon`'s 64 KiB
 * at `pagehide` with the page's few frames of its own in front, and ingest's
 * body cap well before that.
 */
const PIECE_TARGET_BYTES = 32 * 1024
const PIECE_MAX_BYTES = 48 * 1024

/** Compressed over raw, before any forward has been compressed. */
const START_RATIO = 1 / 4
/**
 * The least the droppable gate takes the ratio to be. It keeps the gate's
 * limit under the raw buffer's cap, so the gate always sheds droppable records
 * before the cap refuses one that must not be lost.
 */
const GATE_MIN_RATIO = 1 / 16

/** Raw bytes a probe may hold, in `upload.byteThreshold`s, when it compresses. */
const RAW_CAP_THRESHOLDS = 128
/** And when it cannot: the page refuses a forward larger than its own buffer. */
const PLAIN_CAP_THRESHOLDS = 8

export class ProbeRuntime {
  /** The page's clock base; `undefined` while the page's session has not begun. */
  private _base: Mono | undefined
  /** What holds this worker's transports while no session records them; `undefined` is the dormant hook's own. */
  private _dormant: DormantState | undefined
  private readonly _port: MessagePort
  private readonly _hook: TransportHook
  private readonly _build: WorkerBuild
  private readonly _clock: ClockSource
  private readonly _ports: ProbePorts
  private readonly _onError: (err: unknown) => void
  private readonly _buffer: FrameBuffer

  private readonly _compresses: boolean
  private readonly _compressMin: number
  private readonly _deflate: (bytes: Uint8Array) => Promise<DeflateSegment>

  private _ids: { sessionId: string; instanceId: string }
  private _config: RealmConfig
  private _realm: RealmObserver | null = null
  private _level: DetailLevel
  private _ready = false
  private _stopped = false
  private _lastPost: Mono
  private _forwardHandle: unknown
  private _intervalHandle: unknown
  /** Compressed over raw, from the forwards so far. */
  private _ratio: number
  /** A forward is being compressed; the next waits for it, so forwards arrive in order. */
  private _compressing = false
  private _forwardAgain = false
  /** How long the last compression took: the next forward starts that much earlier. */
  private _compressMs = 0

  constructor(
    linked: LinkedMessage,
    port: MessagePort,
    hook: TransportHook,
    build: WorkerBuild,
    ports: ProbePorts = {},
    tuning: ProbeTuning = {},
  ) {
    this._base = linked.base
    this._ids = { sessionId: linked.sessionId, instanceId: linked.instanceId }
    this._config = linked.config
    this._port = port
    this._hook = hook
    this._build = build
    this._ports = ports
    this._clock = ports.clock ?? platformClock
    this._onError = (err: unknown): void => {
      try {
        ports.onInternalError?.(err)
      } catch {
        // An error handler that throws is where reporting stops.
      }
    }
    this._level = linked.level
    this._lastPost = this._clock.now()
    const threshold = linked.config.upload.byteThreshold
    this._deflate = tuning.deflate ?? deflateSegment
    this._compresses = tuning.deflate !== undefined || gzipSupported()
    this._compressMin = Math.max(1, tuning.compressMinBytes ?? threshold)
    this._ratio = this._compresses ? START_RATIO : 1
    this._buffer = new FrameBuffer({
      maxPendingBytes: (this._compresses ? RAW_CAP_THRESHOLDS : PLAIN_CAP_THRESHOLDS) * threshold,
      onInternalError: this._onError,
    })
  }

  /**
   * Start a realm observing this worker's transports into the buffer the
   * forwards empty, on the page's clock `base`.
   */
  private _record(base: Mono): void {
    this._base = base
    const buffer = this._buffer
    const ratio = (): number => Math.max(GATE_MIN_RATIO, this._ratio)
    const realm = new RealmObserver({
      realm: 'worker',
      config: this._config,
      hook: this._hook,
      drafts: this._build.drafts,
      recorder: this._build.recorder,
      originMono: base,
      clock: this._clock,
      host: {
        sink: {
          json: (r) => buffer.json(r),
          raw: (b) => buffer.raw(b),
          get pendingBytes(): number {
            return buffer.pendingBytes * ratio()
          },
        },
        level: () => this._level,
        onTrigger: (e) => this._trigger(e),
        onConnReady: () => {
          this._ready = true
        },
        onConnClosed: () => this._forward(),
        onOverrun: (at, signal) => {
          this._call({ t: 'overrun', at: at - base, signal })
          this._forward()
        },
        onPressure: () => {},
        onBytes: () => {},
        onError: this._onError,
      },
    })
    this._realm = realm
    const from = this._dormant
    this._dormant = undefined
    realm.start(from)
  }

  /**
   * Record nothing, and tell the page when this worker constructs a
   * `WebTransport`: that begins the page's session, which answers with the
   * clock base. A construction made before the link is already waiting in the
   * dormant hook, so the page hears of it at once.
   */
  private _arm(first: boolean): void {
    this._base = undefined
    const open = (): void => this._call({ t: 'open' })
    if (first && dormantPending()) open()
    else this._dormant = armDormant(this._hook, open)
  }

  get ids(): { sessionId: string; instanceId: string } {
    return { ...this._ids }
  }

  start(): void {
    this._port.onmessage = (e: MessageEvent) => this._fromPage(e.data)
    const base = this._base
    if (base === undefined) this._arm(true)
    else this._record(base)
    const set = this._ports.setTimer ?? ((fn: () => void, d: number) => setTimeout(fn, d))
    const forward = (): void => {
      if (this._stopped) return
      this._forward()
      // A compressed forward reaches the page when its compression ends, so
      // the next one starts that much early: what a terminated worker loses
      // stays within one interval.
      const ms = Math.max(FORWARD_INTERVAL_MS / 2, FORWARD_INTERVAL_MS - this._compressMs)
      this._forwardHandle = set(forward, ms)
    }
    this._forwardHandle = set(forward, FORWARD_INTERVAL_MS)
    const interval = this._config.metrics.intervalMs
    const tick = (): void => {
      if (this._stopped) return
      try {
        this._realm?.tick(this._clock.now())
      } catch (err) {
        this._onError(err)
      }
      this._intervalHandle = set(tick, interval)
    }
    this._intervalHandle = set(tick, interval)
  }

  annotate(name: string, data: unknown, connectionId?: string): void {
    this._call(
      connectionId === undefined
        ? { t: 'annotate', name: String(name), data }
        : { t: 'annotate', name: String(name), data, conn: String(connectionId) },
    )
  }

  observe(name: string, value: number, labels?: Record<string, string>): void {
    this._call(
      labels === undefined ? { t: 'observe', name, value } : { t: 'observe', name, value, labels },
    )
  }

  escalate(level: DetailLevel, reason?: string): void {
    this._call(reason === undefined ? { t: 'escalate', level } : { t: 'escalate', level, reason })
  }

  resolve(reason?: string): void {
    this._call(reason === undefined ? { t: 'resolve' } : { t: 'resolve', reason })
  }

  /**
   * Hand the page what this probe has written, or say it is still here.
   *
   * The frames' buffers are transferred, not copied: the page's main thread
   * pays for a pointer and an append, or for a pointer and a seal when they
   * arrive compressed. One compression at a time: a forward asked for while
   * one runs follows it, so the page receives the frames in order.
   */
  private _forward(): void {
    const realm = this._realm
    if (this._stopped || realm === null) return
    if (this._compressing) {
      this._forwardAgain = true
      return
    }
    const now = this._clock.now()
    const hasFrames = this._buffer.frameCount > 0
    if (!hasFrames && now - this._lastPost < HEARTBEAT_MS) return
    const conns = realm.snapshots(now)
    const dropped = this._buffer.droppedRecords + realm.droppedRecords
    const ready = this._ready
    this._lastPost = now
    if (!hasFrames) {
      this._post({ t: 'fwd', n: 0, dropped, ready, conns }, [])
      return
    }
    const { frames, count } = this._buffer.takeFrames()
    if (!this._compresses || frames.byteLength < this._compressMin) {
      const part = framesPart(frames, count)
      this._post({ t: 'fwd', parts: [part], n: count, dropped, ready, conns }, [part.frames])
      return
    }
    this._compressing = true
    void this._compress(frames, count).then((parts) => {
      this._compressMs = Math.max(0, this._clock.now() - now)
      this._compressing = false
      this._buffer.recycle(frames)
      const transfer = parts.map((p) => ('deflate' in p ? p.deflate : p.frames))
      this._post({ t: 'fwd', parts, n: count, dropped, ready, conns }, transfer)
      if (this._forwardAgain) {
        this._forwardAgain = false
        this._forward()
      }
    })
  }

  /**
   * The frames in pieces of about {@link PIECE_TARGET_BYTES} compressed, in
   * order. A piece that compresses past {@link PIECE_MAX_BYTES} is split and
   * compressed again; one that cannot be split, or cannot be compressed, goes
   * as it is. Never rejects.
   */
  private async _compress(frames: Uint8Array, count: number): Promise<ForwardPart[]> {
    const parts: ForwardPart[] = []
    let raw = 0
    let packed = 0
    const piece = async (bytes: Uint8Array, n: number): Promise<void> => {
      let segment: DeflateSegment | null = null
      try {
        segment = await this._deflate(bytes)
      } catch (err) {
        this._onError(err)
      }
      if (segment !== null && segment.deflate.byteLength <= PIECE_MAX_BYTES) {
        raw += bytes.byteLength
        packed += segment.deflate.byteLength
        const deflate = new Uint8Array(segment.deflate).buffer as ArrayBuffer
        parts.push({
          deflate,
          byteLength: deflate.byteLength,
          crc: segment.crc,
          size: segment.size,
          n,
        })
        return
      }
      const halves = segment === null ? [] : splitFrames(bytes, n, Math.ceil(bytes.byteLength / 2))
      if (halves.length > 1) {
        for (const h of halves) await piece(h.bytes, h.count)
        return
      }
      parts.push(framesPart(bytes.slice(), n))
    }
    const target = Math.max(1024, Math.floor(PIECE_TARGET_BYTES / this._ratio))
    for (const span of splitFrames(frames, count, target)) await piece(span.bytes, span.count)
    if (raw > 0) {
      // Half the old estimate and half the new, so one odd forward moves it only so far.
      this._ratio = Math.min(1, Math.max(1 / 1024, (this._ratio + packed / raw) / 2))
    }
    return parts
  }

  private _post(message: ForwardMessage, transfer: Transferable[]): void {
    if (this._stopped) return
    try {
      this._port.postMessage(envelope(message), transfer)
    } catch (err) {
      this._onError(err)
    }
  }

  private _trigger(e: TriggerEvent): void {
    // The page owns the capture window and may refuse it, at the ceiling. The
    // dump this trigger produces next is stamped at the level the window
    // opens at; the page's answer corrects the level for everything after.
    if (levelIndex(this._level) < levelIndex(TRIGGER_CAPTURE_LEVEL)) {
      this._level = TRIGGER_CAPTURE_LEVEL
    }
    this._call({
      t: 'trigger',
      kind: e.kind,
      at: e.atMono - (this._base ?? 0),
      ...(e.key !== undefined ? { key: e.key } : {}),
    })
  }

  private _call(m: CallMessage): void {
    if (this._stopped) return
    try {
      this._port.postMessage(envelope(m))
    } catch (err) {
      this._onError(err)
    }
  }

  private _fromPage(data: unknown): void {
    const m = linkMessage(data) as PageMessage | null
    if (m === null) return
    try {
      if (m.t === 'level') this._level = m.level
      else if (m.t === 'forward') this._forward()
      else if (m.t === 'unlinked') this._stop()
      else if (m.t === 'session') this._follow(m)
      else if (m.t === 'context') {
        this._config = {
          ...this._config,
          context: { ...this._config.context, contentId: m.contentId },
        }
        this._realm?.setContentId(m.contentId)
      }
    } catch (err) {
      this._onError(err)
    }
  }

  /**
   * The page's session changed. What this probe holds goes out first. With a
   * clock base, a fresh realm takes over the hook: the transports still open
   * are announced to it, so each reappears in the new session as a connection
   * of its own, as the page's own transports do. Without, the probe waits for
   * this worker's next `WebTransport`.
   */
  private _follow(m: Extract<PageMessage, { t: 'session' }>): void {
    if (this._stopped) return
    this._forward()
    this._ids = { sessionId: m.sessionId, instanceId: m.instanceId }
    this._level = m.level
    this._ready = false
    const realm = this._realm
    if (realm === null && m.base === undefined) return
    this._realm = null
    realm?.detach()
    realm?.clear()
    if (m.base === undefined) this._arm(false)
    else this._record(m.base)
  }

  /** The page's instance ended: stop observing and restore this worker's global. */
  private _stop(): void {
    if (this._stopped) return
    this._stopped = true
    this._realm?.detach()
    this._realm?.clear()
    const clear = this._ports.clearTimer ?? ((h: unknown) => clearTimeout(h as never))
    if (this._forwardHandle !== undefined) clear(this._forwardHandle)
    if (this._intervalHandle !== undefined) clear(this._intervalHandle)
    this._port.close()
    try {
      this._hook.uninstall()
    } catch (err) {
      this._onError(err)
    }
  }
}

/**
 * Frames as they are. Their whole buffer is transferred, so `frames` must be
 * the only view onto it that anything still reads.
 */
function framesPart(frames: Uint8Array, n: number): FramesPart {
  const owned = frames.byteOffset === 0 ? frames : frames.slice()
  return { frames: owned.buffer as ArrayBuffer, byteLength: owned.byteLength, n }
}
