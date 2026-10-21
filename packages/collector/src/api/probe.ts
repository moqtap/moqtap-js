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
 * Every timestamp is written on the page's timeline from the start: the page
 * sends the offset between the two clocks in its answer to the hello, and the
 * probe's realm uses it as its origin.
 */

import type { DraftSet } from '../draft/index.js'
import { FlushQueue } from '../flush/index.js'
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

const platformClock: ClockSource = { now: () => performance.now(), wall: () => Date.now() }

export class ProbeRuntime {
  readonly #base: Mono
  readonly #port: MessagePort
  readonly #hook: TransportHook
  readonly #drafts: DraftSet
  readonly #clock: ClockSource
  readonly #ports: ProbePorts
  readonly #onError: (err: unknown) => void
  readonly #buffer: FlushQueue

  #ids: { sessionId: string; instanceId: string }
  #config: RealmConfig
  #realm: RealmObserver
  #level: DetailLevel
  #ready = false
  #stopped = false
  #lastPost: Mono
  #forwardHandle: unknown
  #intervalHandle: unknown

  constructor(
    linked: LinkedMessage,
    port: MessagePort,
    hook: TransportHook,
    drafts: DraftSet,
    ports: ProbePorts = {},
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
    this.#buffer = new FlushQueue({
      sessionId: linked.sessionId,
      instanceId: linked.instanceId,
      maxPendingBytes: 8 * linked.config.upload.byteThreshold,
      onInternalError: this.#onError,
    })
    this.#realm = this.#observer()
  }

  /** A realm observing this worker's transports into the buffer the forwards empty. */
  #observer(): RealmObserver {
    return new RealmObserver({
      realm: 'worker',
      config: this.#config,
      hook: this.#hook,
      drafts: this.#drafts,
      originMono: this.#base,
      clock: this.#clock,
      host: {
        sink: this.#buffer,
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
      this.#forwardHandle = set(forward, FORWARD_INTERVAL_MS)
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
   * The frames' buffer is transferred, not copied: the page's main thread
   * pays for a pointer and an append.
   */
  #forward(): void {
    if (this.#stopped) return
    const now = this.#clock.now()
    const hasFrames = this.#buffer.frameCount > 0
    if (!hasFrames && now - this.#lastPost < HEARTBEAT_MS) return
    const conns = this.#realm.snapshots(now)
    const dropped = this.#buffer.droppedRecords + this.#realm.droppedRecords
    let message: ForwardMessage
    let transfer: Transferable[] = []
    if (hasFrames) {
      const { frames, count } = this.#buffer.takeFrames()
      const buffer = frames.buffer as ArrayBuffer
      message = {
        t: 'fwd',
        frames: buffer,
        byteLength: frames.byteLength,
        n: count,
        dropped,
        ready: this.#ready,
        conns,
      }
      transfer = [buffer]
    } else {
      message = { t: 'fwd', n: 0, dropped, ready: this.#ready, conns }
    }
    this.#lastPost = now
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
