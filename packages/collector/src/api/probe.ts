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
 * sends the offset between the two clocks in its answer to the hello, and the
 * probe's realm uses it as its origin.
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
import { TRIGGER_CAPTURE_LEVEL } from './escalation.js'
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
  readonly #base: Mono
  readonly #port: MessagePort
  readonly #hook: TransportHook
  readonly #drafts: DraftSet
  readonly #clock: ClockSource
  readonly #ports: ProbePorts
  readonly #onError: (err: unknown) => void
  readonly #buffer: FrameBuffer

  readonly #compresses: boolean
  readonly #compressMin: number
  readonly #deflate: (bytes: Uint8Array) => Promise<DeflateSegment>

  #ids: { sessionId: string; instanceId: string }
  #config: RealmConfig
  #realm: RealmObserver
  #level: DetailLevel
  #ready = false
  #stopped = false
  #lastPost: Mono
  #forwardHandle: unknown
  #intervalHandle: unknown
  /** Compressed over raw, from the forwards so far. */
  #ratio: number
  /** A forward is being compressed; the next waits for it, so forwards arrive in order. */
  #compressing = false
  #forwardAgain = false
  /** How long the last compression took: the next forward starts that much earlier. */
  #compressMs = 0

  constructor(
    linked: LinkedMessage,
    port: MessagePort,
    hook: TransportHook,
    drafts: DraftSet,
    ports: ProbePorts = {},
    tuning: ProbeTuning = {},
  ) {
    this.#base = linked.base
    this.#ids = { sessionId: linked.sessionId, instanceId: linked.instanceId }
    this.#config = linked.config
    this.#port = port
    this.#hook = hook
    this.#drafts = drafts
    this.#ports = ports
    this.#clock = ports.clock ?? platformClock
    this.#onError = (err: unknown): void => {
      try {
        ports.onInternalError?.(err)
      } catch {
        // An error handler that throws is where reporting stops.
      }
    }
    this.#level = linked.level
    this.#lastPost = this.#clock.now()
    const threshold = linked.config.upload.byteThreshold
    this.#deflate = tuning.deflate ?? deflateSegment
    this.#compresses = tuning.deflate !== undefined || gzipSupported()
    this.#compressMin = Math.max(1, tuning.compressMinBytes ?? threshold)
    this.#ratio = this.#compresses ? START_RATIO : 1
    this.#buffer = new FrameBuffer({
      maxPendingBytes: (this.#compresses ? RAW_CAP_THRESHOLDS : PLAIN_CAP_THRESHOLDS) * threshold,
      onInternalError: this.#onError,
    })
    this.#realm = this.#observer()
  }

  /** A realm observing this worker's transports into the buffer the forwards empty. */
  #observer(): RealmObserver {
    const buffer = this.#buffer
    const ratio = (): number => Math.max(GATE_MIN_RATIO, this.#ratio)
    return new RealmObserver({
      realm: 'worker',
      config: this.#config,
      hook: this.#hook,
      drafts: this.#drafts,
      originMono: this.#base,
      clock: this.#clock,
      host: {
        sink: {
          json: (r) => buffer.json(r),
          raw: (b) => buffer.raw(b),
          get pendingBytes(): number {
            return buffer.pendingBytes * ratio()
          },
        },
        level: () => this.#level,
        onTrigger: (e) => this.#trigger(e),
        onConnReady: () => {
          this.#ready = true
        },
        onConnClosed: () => this.#forward(),
        onOverrun: (at, signal) => {
          this.#call({ t: 'overrun', at: at - this.#base, signal })
          this.#forward()
        },
        onPressure: () => {},
        onBytes: () => {},
        onError: this.#onError,
      },
    })
  }

  get ids(): { sessionId: string; instanceId: string } {
    return { ...this.#ids }
  }

  start(): void {
    this.#port.onmessage = (e: MessageEvent) => this.#fromPage(e.data)
    this.#realm.start()
    const set = this.#ports.setTimer ?? ((fn: () => void, d: number) => setTimeout(fn, d))
    const forward = (): void => {
      if (this.#stopped) return
      this.#forward()
      // A compressed forward reaches the page when its compression ends, so
      // the next one starts that much early: what a terminated worker loses
      // stays within one interval.
      const ms = Math.max(FORWARD_INTERVAL_MS / 2, FORWARD_INTERVAL_MS - this.#compressMs)
      this.#forwardHandle = set(forward, ms)
    }
    this.#forwardHandle = set(forward, FORWARD_INTERVAL_MS)
    const interval = this.#config.metrics.intervalMs
    const tick = (): void => {
      if (this.#stopped) return
      try {
        this.#realm.tick(this.#clock.now())
      } catch (err) {
        this.#onError(err)
      }
      this.#intervalHandle = set(tick, interval)
    }
    this.#intervalHandle = set(tick, interval)
  }

  annotate(name: string, data: unknown, connectionId?: string): void {
    this.#call(
      connectionId === undefined
        ? { t: 'annotate', name: String(name), data }
        : { t: 'annotate', name: String(name), data, conn: String(connectionId) },
    )
  }

  observe(name: string, value: number, labels?: Record<string, string>): void {
    this.#call(
      labels === undefined ? { t: 'observe', name, value } : { t: 'observe', name, value, labels },
    )
  }

  escalate(level: DetailLevel, reason?: string): void {
    this.#call(reason === undefined ? { t: 'escalate', level } : { t: 'escalate', level, reason })
  }

  resolve(reason?: string): void {
    this.#call(reason === undefined ? { t: 'resolve' } : { t: 'resolve', reason })
  }

  /**
   * Hand the page what this probe has written, or say it is still here.
   *
   * The frames' buffers are transferred, not copied: the page's main thread
   * pays for a pointer and an append, or for a pointer and a seal when they
   * arrive compressed. One compression at a time: a forward asked for while
   * one runs follows it, so the page receives the frames in order.
   */
  #forward(): void {
    if (this.#stopped) return
    if (this.#compressing) {
      this.#forwardAgain = true
      return
    }
    const now = this.#clock.now()
    const hasFrames = this.#buffer.frameCount > 0
    if (!hasFrames && now - this.#lastPost < HEARTBEAT_MS) return
    const conns = this.#realm.snapshots(now)
    const dropped = this.#buffer.droppedRecords + this.#realm.droppedRecords
    const ready = this.#ready
    this.#lastPost = now
    if (!hasFrames) {
      this.#post({ t: 'fwd', n: 0, dropped, ready, conns }, [])
      return
    }
    const { frames, count } = this.#buffer.takeFrames()
    if (!this.#compresses || frames.byteLength < this.#compressMin) {
      const part = framesPart(frames, count)
      this.#post({ t: 'fwd', parts: [part], n: count, dropped, ready, conns }, [part.frames])
      return
    }
    this.#compressing = true
    void this.#compress(frames, count).then((parts) => {
      this.#compressMs = Math.max(0, this.#clock.now() - now)
      this.#compressing = false
      this.#buffer.recycle(frames)
      const transfer = parts.map((p) => ('deflate' in p ? p.deflate : p.frames))
      this.#post({ t: 'fwd', parts, n: count, dropped, ready, conns }, transfer)
      if (this.#forwardAgain) {
        this.#forwardAgain = false
        this.#forward()
      }
    })
  }

  /**
   * The frames in pieces of about {@link PIECE_TARGET_BYTES} compressed, in
   * order. A piece that compresses past {@link PIECE_MAX_BYTES} is split and
   * compressed again; one that cannot be split, or cannot be compressed, goes
   * as it is. Never rejects.
   */
  async #compress(frames: Uint8Array, count: number): Promise<ForwardPart[]> {
    const parts: ForwardPart[] = []
    let raw = 0
    let packed = 0
    const piece = async (bytes: Uint8Array, n: number): Promise<void> => {
      let segment: DeflateSegment | null = null
      try {
        segment = await this.#deflate(bytes)
      } catch (err) {
        this.#onError(err)
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
    const target = Math.max(1024, Math.floor(PIECE_TARGET_BYTES / this.#ratio))
    for (const span of splitFrames(frames, count, target)) await piece(span.bytes, span.count)
    if (raw > 0) {
      // Half the old estimate and half the new, so one odd forward moves it only so far.
      this.#ratio = Math.min(1, Math.max(1 / 1024, (this.#ratio + packed / raw) / 2))
    }
    return parts
  }

  #post(message: ForwardMessage, transfer: Transferable[]): void {
    if (this.#stopped) return
    try {
      this.#port.postMessage(envelope(message), transfer)
    } catch (err) {
      this.#onError(err)
    }
  }

  #trigger(e: TriggerEvent): void {
    // The page owns the capture window and may refuse it, at the ceiling. The
    // dump this trigger produces next is stamped at the level the window
    // opens at; the page's answer corrects the level for everything after.
    if (levelIndex(this.#level) < levelIndex(TRIGGER_CAPTURE_LEVEL)) {
      this.#level = TRIGGER_CAPTURE_LEVEL
    }
    this.#call({
      t: 'trigger',
      kind: e.kind,
      at: e.atMono - this.#base,
      ...(e.key !== undefined ? { key: e.key } : {}),
    })
  }

  #call(m: CallMessage): void {
    if (this.#stopped) return
    try {
      this.#port.postMessage(envelope(m))
    } catch (err) {
      this.#onError(err)
    }
  }

  #fromPage(data: unknown): void {
    const m = linkMessage(data) as PageMessage | null
    if (m === null) return
    try {
      if (m.t === 'level') this.#level = m.level
      else if (m.t === 'forward') this.#forward()
      else if (m.t === 'unlinked') this.#stop()
      else if (m.t === 'session') this.#follow(m)
      else if (m.t === 'context') {
        this.#config = {
          ...this.#config,
          context: { ...this.#config.context, contentId: m.contentId },
        }
        this.#realm.setContentId(m.contentId)
      }
    } catch (err) {
      this.#onError(err)
    }
  }

  /**
   * The page started a new session. What this probe holds goes out first, and
   * a fresh realm takes over the hook: the transports still open are announced
   * to it, so each reappears in the new session as a connection of its own,
   * as the page's own transports do.
   */
  #follow(m: Extract<PageMessage, { t: 'session' }>): void {
    if (this.#stopped) return
    this.#forward()
    this.#ids = { sessionId: m.sessionId, instanceId: m.instanceId }
    this.#level = m.level
    this.#ready = false
    this.#realm.detach()
    this.#realm.clear()
    this.#realm = this.#observer()
    this.#realm.start()
  }

  /** The page's instance ended: stop observing and restore this worker's global. */
  #stop(): void {
    if (this.#stopped) return
    this.#stopped = true
    this.#realm.detach()
    this.#realm.clear()
    const clear = this.#ports.clearTimer ?? ((h: unknown) => clearTimeout(h as never))
    if (this.#forwardHandle !== undefined) clear(this.#forwardHandle)
    if (this.#intervalHandle !== undefined) clear(this.#intervalHandle)
    this.#port.close()
    try {
      this.#hook.uninstall()
    } catch (err) {
      this.#onError(err)
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
