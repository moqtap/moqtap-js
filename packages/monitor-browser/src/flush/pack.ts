import {
  type DeflateSegment,
  deflateSegment,
  joinSegments,
  splitFrames,
} from '../envelope/index.js'
import { openSegment } from '../envelope/open-segment.js'
import type { FlushQueue, PackedFrames } from './queue.js'
import type { TimerSource } from './schedule.js'

/**
 * The open frame stream, kept gzipped as it grows, so a buffer can be weighed
 * by what it costs on the wire and still leave the page at once.
 *
 * Raised detail writes a header per object, and those records compress twenty
 * to forty times over. Every body is a request of its own whatever its size,
 * so a body is sealed once what it holds comes to the threshold gzipped, not
 * raw.
 *
 * The stream is gzipped in runs: a step's worth at a time, as it arrives, and
 * every {@link PackerOptions.merge} bytes of step runs once more as one, since
 * a run compressed on its own starts with no history and a step is short.
 * Each run is opened (`openSegment`), so runs join end to end into one gzip
 * member with no byte compressed again: a body is its runs, joined the moment
 * they weigh the target, and a seal that cannot wait, at `pagehide`, joins
 * every run and stores the short rest behind them uncompressed.
 *
 * So one compression takes at most a merge and a step, and a byte is
 * compressed twice at most, in a step and in a merge, but for one case: a
 * merge under way when a seal takes some of the runs it covers is dropped,
 * and the runs the seal left are merged again later. Any other pack whose
 * frames a seal took is dropped and not redone, as the seal took them all.
 */

/** Compressed over raw, before any pack has finished. */
const START_RATIO = 1
/**
 * The least the buffer's weight takes the ratio to be. It keeps a buffer that
 * compresses unusually well from weighing so little that the pressure gate,
 * which works on weight, never sheds before the raw cap refuses.
 */
export const PACK_MIN_RATIO = 1 / 16

/** A run's level: gzipped as a step, or as several steps merged. */
const STEP = 0
const MERGED = 1

/** Frames of the open stream, `from` bytes into it, gzipped on their own and opened. */
interface Run extends PackedFrames {
  readonly from: number
  readonly level: number
}

/** A compression: `bytes` from `from`, to replace `replace` runs from there. */
interface Job {
  readonly from: number
  readonly bytes: number
  readonly count: number
  readonly replace: number
  readonly level: number
}

export interface PackerOptions {
  readonly queue: FlushQueue
  /** Raw bytes the part not yet gzipped may reach before it is gzipped as a run. */
  readonly step: number
  /** Raw bytes of step runs gzipped again as one. */
  readonly merge: number
  /** Gzipped bytes a body is sealed at. */
  readonly target: number
  /** Raw bytes a body is sealed at, whatever it weighs. */
  readonly maxRaw: number
  readonly timers: TimerSource
  /** The runs in front make a body: the caller seals them with {@link Packer.take}. */
  readonly onBody: () => void
  /** Compression failed. Nothing is packed after this. */
  readonly onFailed: (err: unknown) => void
  /** Whether compression can run here at all. Default: it can. */
  readonly enabled?: boolean
  /** The compressor. Default `CompressionStream`, through {@link deflateSegment}. */
  readonly deflate?: (bytes: Uint8Array) => Promise<DeflateSegment>
}

/** Runs taken to be sealed, and whether the frames after them go in the same body. */
export interface TakenRuns extends PackedFrames {
  readonly rest: boolean
}

export class Packer {
  private readonly _o: PackerOptions
  private readonly _deflate: (bytes: Uint8Array) => Promise<DeflateSegment>
  private _failed: boolean
  private _runs: Run[] = []
  /** The queue's `takes` the runs describe it at. */
  private _takes = 0
  /** Where the queue's front is in the stream, so runs and packs keep their place across a take. */
  private _base = 0
  /** Bumped whenever the runs are forgotten, so a pack that finishes after is dropped. */
  private _gen = 0
  private _running = false
  /** Bumped by {@link clear}, so a pack that finishes after it is ignored. */
  private _epoch = 0
  private _handle: unknown
  private _ratio = START_RATIO

  constructor(o: PackerOptions) {
    this._o = o
    this._deflate = o.deflate ?? deflateSegment
    this._failed = o.enabled === false
  }

  /** Compression is unavailable or has failed. */
  get failed(): boolean {
    return this._failed
  }

  /** What the buffered frames come to gzipped, as far as the runs so far tell. */
  weigh(): number {
    let raw = 0
    let packed = 0
    for (const r of this._live()) {
      raw += r.bytes
      packed += r.segment.deflate.byteLength
    }
    return packed + (this._o.queue.pendingBytes - raw) * Math.max(PACK_MIN_RATIO, this._ratio)
  }

  /** Bytes were buffered: gzip what is due, once the caller's turn is over. */
  note(): void {
    if (this._failed || this._running || this._handle !== undefined) return
    if (this._job(false) === null) return
    // On a timer, never inside the caller, for the reason the schedule's byte
    // seal gives: a run cut between a record and its raw frame would split the
    // pair across two bodies.
    this._handle = this._o.timers.setTimer(() => {
      this._handle = undefined
      this._run()
    }, 0)
  }

  /** Raw bytes the runs cover. */
  get packedBytes(): number {
    let raw = 0
    for (const r of this._live()) raw += r.bytes
    return raw
  }

  /**
   * The runs in front that make a body, joined and removed from here, or
   * `null` when there is none that still holds. When they are every run and
   * no more than `restMax` bytes follow them, `rest` says those go in the body
   * too. The caller seals them, which removes their frames from the queue.
   */
  take(restMax = -1): TakenRuns | null {
    const runs = this._live()
    if (runs.length === 0) return null
    const { target, maxRaw } = this._o
    let n = 0
    let bytes = 0
    let count = 0
    let w = 0
    let all = 0
    for (const r of runs) all += r.bytes
    for (const r of runs) {
      const size = r.segment.deflate.byteLength
      if (n > 0 && (w + size > target || bytes + r.bytes > maxRaw)) break
      n += 1
      bytes += r.bytes
      count += r.count
      w += size
    }
    const rest = n === runs.length && this._o.queue.pendingBytes - all <= restMax
    const taken = runs.splice(0, n)
    this._takes += 1
    this._base += bytes
    if (rest) this._forget()
    const segment =
      taken.length === 1 ? (taken[0] as Run).segment : joinSegments(taken.map((r) => r.segment))
    return { segment, bytes, count, rest }
  }

  /** Forget the runs and any pack under way. */
  clear(): void {
    this._forget()
    this._epoch += 1
    this._running = false
    if (this._handle !== undefined) {
      this._o.timers.clearTimer(this._handle)
      this._handle = undefined
    }
  }

  private _forget(): void {
    this._gen += 1
    this._runs = []
    this._base = 0
  }

  /** The runs, while they still describe the queue's front. */
  private _live(): Run[] {
    const takes = this._o.queue.takes
    if (this._takes !== takes) {
      this._forget()
      this._takes = takes
    }
    return this._runs
  }

  /** The runs weigh a body. */
  private _full(): boolean {
    let raw = 0
    let packed = 0
    for (const r of this._live()) {
      raw += r.bytes
      packed += r.segment.deflate.byteLength
    }
    return this._runs.length > 0 && (packed >= this._o.target || raw >= this._o.maxRaw)
  }

  /** The next pack, or `null`; without `cut`, a step's frames are not found, only its being due. */
  private _job(cut = true): Job | null {
    const q = this._o.queue
    const runs = this._live()
    const step = this._o.step
    let raw = 0
    let count = 0
    for (const r of runs) {
      raw += r.bytes
      count += r.count
    }
    const from = this._base + raw
    if (q.pendingBytes - raw >= step) {
      if (!cut) return { from, bytes: 0, count: 0, replace: 0, level: STEP }
      const span = splitFrames(q.peek().subarray(raw), q.frameCount - count, step, 1)[0]
      if (span === undefined) return null
      return { from, bytes: span.bytes.byteLength, count: span.count, replace: 0, level: STEP }
    }
    // The step runs at the end, the first of them that come to a merge's worth.
    let at = runs.length
    while (at > 0 && (runs[at - 1] as Run).level === STEP) at -= 1
    let n = 0
    let bytes = 0
    let frames = 0
    for (let i = at; i < runs.length && bytes < this._o.merge; i += 1) {
      const r = runs[i] as Run
      n += 1
      bytes += r.bytes
      frames += r.count
    }
    if (n < 2 || bytes < this._o.merge) return null
    const first = runs[at] as Run
    return { from: first.from, bytes, count: frames, replace: n, level: MERGED }
  }

  private _run(): void {
    const q = this._o.queue
    if (this._failed || this._running) return
    const job = this._job()
    if (job === null) return
    const gen = this._gen
    const epoch = this._epoch
    this._running = true
    const at = job.from - this._base
    // A copy: the compressor reads it asynchronously, and the queue moves its
    // frames when a seal removes the front.
    this._deflate(q.peek().slice(at, at + job.bytes)).then(
      (gzipped) => {
        if (epoch !== this._epoch) return
        this._running = false
        this._live()
        if (gen !== this._gen) {
          this.note()
          return
        }
        let segment: DeflateSegment
        try {
          segment = openSegment(gzipped)
        } catch (err) {
          this._fail(err)
          return
        }
        if (this._place(job, segment)) {
          // Half the old estimate and half the new, so one odd pack moves it only so far.
          const ratio = segment.deflate.byteLength / Math.max(1, job.bytes)
          this._ratio = Math.min(1, (this._ratio + ratio) / 2)
          while (this._full()) {
            const before = this._runs.length
            this._o.onBody()
            if (this._live().length >= before) break
          }
        }
        this.note()
      },
      (err: unknown) => {
        if (epoch !== this._epoch) return
        this._running = false
        this._fail(err)
      },
    )
  }

  /** The pack, into the runs, unless a seal since took any of its frames. */
  private _place(job: Job, segment: DeflateSegment): boolean {
    const runs = this._live()
    let i = 0
    let end = this._base
    while (i < runs.length && (runs[i] as Run).from < job.from) {
      end = (runs[i] as Run).from + (runs[i] as Run).bytes
      i += 1
    }
    if (job.replace === 0 ? i !== runs.length || end !== job.from : i + job.replace > runs.length) {
      return false
    }
    if (job.replace > 0) {
      const last = runs[i + job.replace - 1] as Run
      if ((runs[i] as Run).from !== job.from || last.from + last.bytes !== job.from + job.bytes) {
        return false
      }
    }
    const { from, bytes, count, level } = job
    runs.splice(i, job.replace, { from, bytes, count, level, segment })
    return true
  }

  private _fail(err: unknown): void {
    this._failed = true
    this._runs = []
    this._o.onFailed(err)
  }
}
