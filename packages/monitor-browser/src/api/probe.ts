/**
 * The worker's half of a link: observe this worker's transports and hand
 * everything to the page.
 *
 * A probe numbers, seals, stores and uploads nothing, and has no end of its
 * own. Every {@link FORWARD_INTERVAL_MS} it transfers the frames it has written
 * and the runs and marks its realm recorded to the page, so a worker
 * terminated without warning loses at most that interval. The page numbers
 * the frames as it appends them, joins each run to the one it continues, and
 * seals them in its own bodies, once.
 *
 * Every timestamp is written on the page's timeline from the start: the page
 * sends the offset between the two clocks with each session it records the
 * worker into, and the probe's realm uses it as its origin. Until the page's
 * session begins there is none, and the probe records nothing; the worker's
 * first `WebTransport` is what it tells the page instead.
 */

import type { DraftSet } from '../draft/index.js'
import { splitFrames } from '../envelope/index.js'
import { BreakCheck } from '../flush/clock-sync.js'
import { FrameBuffer } from '../flush/frame-buffer.js'
import type { TriggerEvent } from '../recorder/index.js'
import type { TransportHook } from '../transport/index.js'
import type { ClockSource, DetailLevel, Mono, RollupRecord } from '../types.js'
import { levelIndex } from './defaults.js'
import { armDormant, type DormantState, dormantPending } from './dormant.js'
import { TRIGGER_CAPTURE_LEVEL } from './escalation.js'
import type { FlightRecorderFeature } from './features.js'
import {
  type CallMessage,
  envelope,
  FORWARD_INTERVAL_MS,
  type ForwardMessage,
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

const platformClock: ClockSource = { now: () => performance.now(), wall: () => Date.now() }

/** Forwards a probe keeps count of separately while the page has not taken them in. */
const MAX_UNHEARD = 64

/** A forward the page had not taken in when it last gave the room, and what it will take of it. */
interface Unheard {
  readonly seq: number
  readonly bytes: number
}

/**
 * Raw bytes a probe may hold, in `upload.byteThreshold`s: enough for a
 * forward's worth of raised detail, which the page packs.
 */
const RAW_CAP_THRESHOLDS = 128

/** The most one part of a forward carries: what the page's buffer takes at baseline. */
const PART_THRESHOLDS = 8

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
  /** Rollup intervals closed since the last forward, in order. They travel beside the frames. */
  private _rollups: RollupRecord[] = []

  /** The most frames one part of a forward carries: what the page's buffer takes at baseline. */
  private readonly _plainMax: number
  /** Subtract from this worker's clock to read the page's `performance.now()`. */
  private readonly _mono: Mono
  /** The next connection ordinal, in this probe's own range: it lasts across the page's sessions. */
  private _nextConn: number
  /** Ordinals of this worker's hooked sessions still open. */
  private readonly _connIds = new Map<string, number>()

  private _ids: { sessionId: string; instanceId: string }
  private _config: RealmConfig
  private _realm: RealmObserver | null = null
  private _level: DetailLevel
  /** The page refuses every raise now; a trigger leaves `_level` as it is. */
  private _capped: boolean
  private _ready = false
  private _stopped = false
  private _lastPost: Mono
  private _forwardHandle: unknown
  private _intervalHandle: unknown
  /** The outbox room the page last gave this probe's flight dumps. */
  private _room: number
  /** The last forward's `seq`. */
  private _seq = 0
  private _unheard: Unheard[] = []
  /** Checks this worker's captured times for a clock break; its epoch is the page's. */
  private readonly _breaks = new BreakCheck()
  /** A break was seen and the page not told yet. */
  private _brk = false

  constructor(
    linked: LinkedMessage,
    port: MessagePort,
    hook: TransportHook,
    build: WorkerBuild,
    ports: ProbePorts = {},
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
    this._capped = linked.capped === true
    this._room = linked.room
    this._lastPost = this._clock.now()
    const threshold = linked.config.upload.byteThreshold
    this._plainMax = PART_THRESHOLDS * threshold
    this._mono = linked.mono
    this._nextConn = linked.connBase
    this._buffer = new FrameBuffer({
      maxPendingBytes: RAW_CAP_THRESHOLDS * threshold,
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
    const realm = new RealmObserver({
      realm: 'worker',
      config: this._config,
      hook: this._hook,
      drafts: this._build.drafts,
      recorder: this._build.recorder,
      originMono: base,
      monoBase: this._mono,
      ordinal: (id) => {
        let c = this._connIds.get(id)
        if (c === undefined) {
          c = this._nextConn++
          this._connIds.set(id, c)
        }
        return c
      },
      ordinalDone: (id) => this._connIds.delete(id),
      clock: this._clock,
      host: {
        sink: {
          // A closed interval goes to the page as a record beside the frames.
          json: (r) => {
            if (r.t === 'rollup') this._rollups.push(r)
            else buffer.json(r)
          },
          raw: (b) => buffer.raw(b),
          get pendingBytes(): number {
            return buffer.pendingBytes
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
        clockCheck: () => this._clockCheck(),
        flush: () => this._forward(),
        dumpRoom: () => this._dumpRoom(),
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

  /**
   * What a flight dump may take of the page's outbox: the room the page last
   * gave, less what this probe has sent or holds that the page had not taken
   * in by then. The page admits a dump's slices as it does every other body,
   * pushing older ones out past its cap, so the dump has to fit before it is
   * written.
   */
  private _dumpRoom(): number {
    let owed = this._buffer.pendingBytes
    for (const u of this._unheard) owed += u.bytes
    return Math.max(0, this._room - owed)
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
      this._forwardHandle = set(forward, FORWARD_INTERVAL_MS)
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

  /** What was captured before a break goes to the page now, marked so it seals it. */
  private _clockCheck(): void {
    if (!this._breaks.check(this._clock.wall(), this._clock.now())) return
    this._brk = true
    this._forward()
  }

  /**
   * Hand the page what this probe has written and recorded, or say it is
   * still here. The frames' buffers are transferred, not copied: the page's
   * main thread pays for a pointer and an append.
   */
  private _forward(): void {
    const realm = this._realm
    if (this._stopped || realm === null) return
    const now = this._clock.now()
    const taken = realm.takeRuns()
    const hasRuns =
      taken.runs.length > 0 ||
      taken.marks.length > 0 ||
      taken.ends.length > 0 ||
      taken.dropped > 0 ||
      taken.bw !== undefined ||
      taken.runEnds !== undefined
    const hasFrames = this._buffer.frameCount > 0
    const closed = this._rollups
    const brk = this._brk
    if (
      !brk &&
      !hasFrames &&
      !hasRuns &&
      closed.length === 0 &&
      now - this._lastPost < HEARTBEAT_MS
    ) {
      return
    }
    const conns = realm.snapshots()
    const dropped = this._buffer.droppedRecords + realm.droppedRecords
    const ready = this._ready
    const rollups = closed.length > 0 ? { rollups: closed } : {}
    const runs = hasRuns ? { runs: taken } : {}
    const broke = brk ? { brk: true as const } : {}
    this._rollups = []
    this._lastPost = now
    this._brk = false
    if (!hasFrames) {
      this._post({ t: 'fwd', n: 0, dropped, ready, ...rollups, ...runs, conns, ...broke }, [])
      return
    }
    const { frames, count } = this._buffer.takeFrames()
    const parts =
      frames.byteLength <= this._plainMax
        ? [framesPart(frames, count)]
        : splitFrames(frames, count, this._plainMax / 2).map((p) =>
            framesPart(p.bytes.slice(), p.count),
          )
    this._post(
      { t: 'fwd', parts, n: count, dropped, ready, ...rollups, ...runs, conns, ...broke },
      parts.map((p) => p.frames),
    )
  }

  private _post(message: Omit<ForwardMessage, 'seq'>, transfer: Transferable[]): void {
    if (this._stopped) return
    const seq = ++this._seq
    // A compressed part is a body of its own; frames join the page's buffer.
    let bytes = 0
    for (const p of message.parts ?? []) bytes += p.byteLength
    if (bytes > 0) {
      this._unheard.push({ seq, bytes })
      // A page that stops answering leaves this to grow; two merged under the
      // later `seq` are owed until both are taken in.
      if (this._unheard.length > MAX_UNHEARD) {
        const [a, b] = this._unheard.splice(0, 2) as [Unheard, Unheard]
        this._unheard.unshift({ seq: b.seq, bytes: a.bytes + b.bytes })
      }
    }
    try {
      this._port.postMessage(envelope({ ...message, seq }), transfer)
    } catch (err) {
      this._onError(err)
    }
  }

  private _trigger(e: TriggerEvent): void {
    // The page owns the capture window. The dump this trigger produces next is
    // stamped at the level the window opens at, so the probe raises before the
    // page answers, unless the page has said it refuses every raise. The
    // page's answer sets the level for everything after, whichever it decided.
    if (!this._capped && levelIndex(this._level) < levelIndex(TRIGGER_CAPTURE_LEVEL)) {
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
      if (m.t === 'level') {
        this._level = m.level
        this._capped = m.capped === true
      } else if (m.t === 'room') {
        this._room = m.bytes
        this._unheard = this._unheard.filter((u) => u.seq > m.upTo)
      } else if (m.t === 'forward') this._forward()
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
   * The page's session began: this probe, waiting until now, records into it
   * from the clock base on, a `WebTransport` already constructed included.
   */
  private _follow(m: Extract<PageMessage, { t: 'session' }>): void {
    if (this._stopped || this._realm !== null || m.base === undefined) return
    this._ids = { sessionId: m.sessionId, instanceId: m.instanceId }
    this._level = m.level
    this._capped = m.capped === true
    this._ready = false
    this._record(m.base)
  }

  /** The page's instance ended: stop observing and restore this worker's global. */
  private _stop(): void {
    if (this._stopped) return
    this._stopped = true
    this._realm?.detach()
    this._realm?.clear()
    this._rollups = []
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
