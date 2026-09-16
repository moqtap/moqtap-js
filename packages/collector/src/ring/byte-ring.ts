/**
 * The memory-only byte ring.
 *
 * Raw wire bytes, **payloads included**, held in memory and nowhere else: the
 * ring holds the customer's end users' media, so persisting it would put that
 * media into origin storage on their device. Nothing here writes to IndexedDB,
 * serialises itself, or hands bytes to the flush buffer. The only exit is
 * {@link ByteRing.snapshot}, taken by the flight recorder on a trigger, and what
 * leaves it is derived records.
 *
 * One implementation, two configured instances: the dormant pre-key ring, which
 * has no config key of its own so its bound is {@link Limits.dormantRingBytes},
 * and the flight recorder at `'32MB'` by default. They differ only in configured
 * depth and lifetime.
 *
 * **Bounded in bytes, never in seconds**: how many seconds a depth buys depends
 * on object rate and bitrate, which this package does not control.
 *
 * The hot path allocates nothing. One object and one `Uint8Array` per chunk
 * would hand the page's own data path a per-write GC bill, so the storage is
 * allocated **once** — one byte buffer plus fixed-length typed arrays for the
 * metadata — and {@link ByteRing.pushParts} performs stores and one
 * `TypedArray.set` and nothing else.
 *
 * But not in the constructor: `CollectorRuntime` builds this ring
 * unconditionally, the default depth is `'32MB'` and the default
 * `flightRecorder.triggers` is `{}`, so allocating there costs a default install
 * 32 MiB plus 1.8 MiB of slot arrays it never writes a byte into — every `push`
 * site is behind an `armed` check. {@link ByteRing.reserve} claims the storage
 * instead: the runtime calls it at `init()` when a trigger is configured, so an
 * armed recorder pays at a controlled moment rather than on the first chunk,
 * which arrives on the page's own data path. {@link ByteRing.pushParts} calls it
 * lazily for the dormant ring, which is built at module-eval time and written to
 * only if a WebTransport session actually opens.
 *
 * Validation stays in the constructor. A bad `maxBytes` or `maxEntries` is a
 * configuration error and must throw at `init()`, on the caller's own stack,
 * rather than on the first chunk in the middle of a session.
 *
 * An entry is never split across the buffer's end: a chunk that does not fit in
 * the tail is written at offset 0 and the tail slack is abandoned until
 * eviction reclaims it. That keeps every entry contiguous, so a write is one
 * `set()` with no temporary subarray, and it costs at most one chunk's worth of
 * capacity per lap.
 */

import { MQ3001, MQ3002, MQ3003, MQ3004, MQ3005 } from '../codes.js'
import type { Direction, Mono } from '../types.js'

/**
 * How the ring is bounded.
 *
 * Both bounds are memory bounds. `maxBytes` covers the wire bytes; `maxEntries`
 * covers the per-entry metadata, which is fixed-size and preallocated, so
 * without it a stream of tiny datagrams would grow the metadata without limit
 * while `maxBytes` reported plenty of room.
 */
export interface RingOptions {
  /**
   * Byte depth. Resolve `'32MB'` with {@link parseByteDepth} before calling —
   * this is a number, so nothing on the hot path ever parses a config string.
   */
  readonly maxBytes: number
  /**
   * Entry slots. Defaults to `maxBytes / 512` clamped to [64, 65536] — an
   * assumed 512-byte mean chunk. At that assumption the metadata costs about
   * 8% of `maxBytes` **on top of** `maxBytes`; a caller who wants the total to
   * land on a number should set both.
   */
  readonly maxEntries?: number
}

/** One chunk as it went past the seam, with the metadata a re-parse needs. */
export interface RingEntry {
  /**
   * Assigned by the ring, strictly increasing for the life of the instance.
   * Never reused, not even after {@link ByteRing.clear}, so two snapshots taken
   * either side of a clear can never disagree about which chunk a seq names.
   */
  readonly seq: number
  readonly sessionId: string
  /** The collector's synthetic per-session id, not the QUIC stream id. */
  readonly streamId: number
  readonly dir: Direction
  readonly control: boolean
  readonly atMono: Mono
  /**
   * **A copy owned by the snapshot**, not a view onto the ring. The ring is
   * continuously overwritten while a trigger's re-parse is in flight, and a
   * view would let a later chunk silently rewrite bytes already handed out.
   */
  readonly data: Uint8Array
}

/** Bit 0 of a slot's flags. */
const FLAG_CONTROL = 1
/** Bit 1 of a slot's flags. `Direction` is two-valued, so one bit carries it. */
const FLAG_TX = 2

/** Assumed mean chunk size behind the default {@link RingOptions.maxEntries}. */
const DEFAULT_BYTES_PER_ENTRY = 512
const MIN_DEFAULT_ENTRIES = 64
const MAX_DEFAULT_ENTRIES = 65_536

/**
 * The stand-ins an unreserved ring holds.
 *
 * Shared and never written: every store site runs under `n < this.count`, and
 * `count` is zero until {@link ByteRing.reserve} has replaced these. Using empty
 * views rather than `null` keeps the read paths and the getters free of a
 * nullability check they would otherwise carry forever for one moment's benefit.
 */
const NO_BYTES = /*#__PURE__*/ new Uint8Array(0)
const NO_U32 = /*#__PURE__*/ new Uint32Array(0)
const NO_I32 = /*#__PURE__*/ new Int32Array(0)
const NO_F64 = /*#__PURE__*/ new Float64Array(0)

export class ByteRing {
  /** Configured byte depth. Informational; the ring enforces it itself. */
  readonly maxBytes: number
  /** Configured entry-slot count. Informational. */
  readonly maxEntries: number

  private buf: Uint8Array = NO_BYTES
  /** Per-slot byte offset into {@link buf}. */
  private slotOff: Uint32Array = NO_U32
  /** Per-slot byte length. */
  private slotLen: Uint32Array = NO_U32
  private slotStream: Int32Array = NO_I32
  /** `Mono` is fractional milliseconds, so f64 and not an integer array. */
  private slotAt: Float64Array = NO_F64
  /** f64 because seq outlives u32 on a long-lived session. */
  private slotSeq: Float64Array = NO_F64
  private slotFlags: Uint8Array = NO_BYTES
  /**
   * Session ids by slot. A reference store, not an allocation: the string
   * already exists, one per transport.
   */
  private slotSession: (string | undefined)[] = []
  /** Whether {@link reserve} has claimed the storage. */
  private reserved = false

  /** Slot index of the oldest live entry. */
  private head = 0
  private count = 0
  /** Byte offset one past the newest entry. */
  private writeOff = 0
  private liveBytes = 0
  private nextSeq = 0
  private evictedCount = 0
  private evictedByteCount = 0
  private refusedCount = 0
  private refusedByteCount = 0

  constructor(opts: RingOptions) {
    const maxBytes = Math.floor(opts.maxBytes)
    if (!Number.isFinite(maxBytes) || maxBytes < 1) {
      throw new RangeError(`${MQ3001}: ${opts.maxBytes}`)
    }
    const requested = opts.maxEntries
    let maxEntries: number
    if (requested === undefined) {
      maxEntries = Math.min(
        MAX_DEFAULT_ENTRIES,
        Math.max(MIN_DEFAULT_ENTRIES, Math.ceil(maxBytes / DEFAULT_BYTES_PER_ENTRY)),
      )
    } else {
      maxEntries = Math.floor(requested)
      if (!Number.isFinite(maxEntries) || maxEntries < 1) {
        throw new RangeError(`${MQ3002}: ${requested}`)
      }
    }

    // Bounds only. The storage is `reserve()`'s — see this file's header.
    this.maxBytes = maxBytes
    this.maxEntries = maxEntries
  }

  /**
   * Claim the storage now: `maxBytes` for the wire bytes plus the fixed-size
   * metadata arrays.
   *
   * Idempotent. Call it at the moment the ring is known to be wanted — the
   * runtime calls it at `init()` when a flight-recorder trigger is configured —
   * so the allocation happens there rather than on the first chunk, which
   * arrives on the page's own data path. A ring that is never reserved and never
   * written costs nothing but this object, which is the default install: triggers
   * ship off, so nothing ever pushes.
   */
  reserve(): void {
    if (this.reserved) return
    this.reserved = true
    this.buf = new Uint8Array(this.maxBytes)
    this.slotOff = new Uint32Array(this.maxEntries)
    this.slotLen = new Uint32Array(this.maxEntries)
    this.slotStream = new Int32Array(this.maxEntries)
    this.slotAt = new Float64Array(this.maxEntries)
    this.slotSeq = new Float64Array(this.maxEntries)
    this.slotFlags = new Uint8Array(this.maxEntries)
    this.slotSession = new Array<string | undefined>(this.maxEntries)
  }

  /**
   * Whether the storage has been claimed.
   *
   * For the tests that hold this class to not allocating what it will not use;
   * nothing on the data path reads it.
   */
  get isReserved(): boolean {
    return this.reserved
  }

  /**
   * Record one chunk, evicting from the front until it fits.
   *
   * The chunk is **copied**; `e.data` is borrowed for the duration of the call
   * and must not be retained by anyone (`StreamChunk.data` is a view onto the
   * page's own buffer, and the page may write through it on its next frame).
   * The entry object itself is read and dropped.
   *
   * A chunk larger than the whole ring is refused rather than truncated — a
   * truncated chunk re-parses into plausible garbage — and counted in both
   * {@link evicted} and {@link refused}.
   *
   * **A refusal punches a hole in the middle of that stream's byte sequence,
   * and eviction never does.** Eviction is FIFO across the whole ring, so a
   * stream's survivors are always a contiguous *suffix* of its chunks: a
   * re-parse starts late and knows it. A refused chunk instead leaves the
   * chunks either side of it adjacent in {@link snapshotStream}, and
   * concatenating them desynchronises the header walk into plausible objects
   * that were never sent. {@link refused} is how a consumer knows not to trust
   * a replay; it does not say *which* stream lost the chunk.
   */
  push(e: Omit<RingEntry, 'seq'>): void {
    this.pushParts(e.sessionId, e.streamId, e.dir, e.control, e.atMono, e.data)
  }

  /**
   * {@link push} without the entry object.
   *
   * Identical semantics. This is the form for the transport seam, where the
   * callback runs synchronously on the page's data path and the entry literal
   * would be the one allocation left on it.
   */
  pushParts(
    sessionId: string,
    streamId: number,
    dir: Direction,
    control: boolean,
    atMono: Mono,
    data: Uint8Array,
  ): void {
    // Before the size check, not after: an unreserved ring has a zero-length
    // buffer, and testing against that would refuse every chunk ever offered and
    // report the ring as hopelessly undersized rather than as unclaimed.
    if (!this.reserved) this.reserve()

    const len = data.length
    if (len > this.buf.length) {
      // Never storable at this depth. Counted as lost rather than truncated.
      this.evictedCount++
      this.evictedByteCount += len
      this.refusedCount++
      this.refusedByteCount += len
      return
    }

    let at = this.count === this.maxEntries ? -1 : this.offsetFor(len)
    while (at < 0) {
      this.evictOldest()
      at = this.count === this.maxEntries ? -1 : this.offsetFor(len)
    }

    let slot = this.head + this.count
    if (slot >= this.maxEntries) slot -= this.maxEntries

    this.slotOff[slot] = at
    this.slotLen[slot] = len
    this.slotStream[slot] = streamId
    this.slotAt[slot] = atMono
    this.slotSeq[slot] = this.nextSeq
    this.slotFlags[slot] = (control ? FLAG_CONTROL : 0) | (dir === 'tx' ? FLAG_TX : 0)
    this.slotSession[slot] = sessionId
    if (len > 0) this.buf.set(data, at)

    this.writeOff = at + len
    this.count++
    this.liveBytes += len
    this.nextSeq++
  }

  /**
   * Every live entry, oldest first.
   *
   * **Does not empty the ring.** A trigger re-parses the window; it does not
   * consume it, and a second trigger a moment later must see the same history.
   *
   * Cold path by construction — it runs only when a trigger has already fired —
   * and it copies, so its cost is proportional to {@link bytes}.
   */
  snapshot(): RingEntry[] {
    const out: RingEntry[] = new Array(this.count)
    for (let n = 0; n < this.count; n++) {
      out[n] = this.entryAt(this.slotOfNth(n))
    }
    return out
  }

  /**
   * The live entries whose arrival time falls in `[fromMono, toMono]`, oldest
   * first.
   *
   * {@link snapshot} copies every byte the ring holds; at the default depth
   * that is a 32 MB copy on the main thread, taken at the moment a trigger
   * fires — on the customer's own data path. A trigger re-parses a *window*, so
   * this copies only that window.
   *
   * Arrival times are `performance.now()` stamped at the seam in push order, so
   * entries are ordered by `atMono` and the scan stops at the first entry past
   * `toMono`.
   */
  snapshotWindow(fromMono: Mono, toMono: Mono): RingEntry[] {
    const out: RingEntry[] = []
    for (let n = 0; n < this.count; n++) {
      const slot = this.slotOfNth(n)
      const at = this.slotAt[slot]!
      if (at > toMono) break
      if (at >= fromMono) out.push(this.entryAt(slot))
    }
    return out
  }

  /** The live entries for one stream, in arrival order. */
  snapshotStream(streamId: number): RingEntry[] {
    const out: RingEntry[] = []
    for (let n = 0; n < this.count; n++) {
      const slot = this.slotOfNth(n)
      if (this.slotStream[slot] === streamId) out.push(this.entryAt(slot))
    }
    return out
  }

  /**
   * Drop everything held. Called on `stop()` and `abort()`, and when the
   * dormant pre-key ring is retired.
   *
   * Discarded entries are **not** counted in {@link evicted}: that counter
   * reports bytes lost to overwrite pressure, which the terminal record uses
   * to say how much of the session it could not keep. A deliberate teardown is
   * not that, and counting it there would make every clean session look lossy.
   * The counters and the seq sequence therefore survive a clear, so the
   * terminal record may be built either side of it.
   *
   * The backing buffer is **not** zeroed. Nothing can read a cleared entry back
   * through this class — a slot exposes only its own `[off, off + len)` — and
   * `clear()` is called from `stop()` and `abort()`, `abort()` on the
   * `pagehide` path where the tail beacon is racing the page's death; a
   * 32 MB memset there is latency spent on bytes that are already unreachable
   * and about to be collected.
   */
  clear(): void {
    for (let n = 0; n < this.count; n++) this.slotSession[this.slotOfNth(n)] = undefined
    this.head = 0
    this.count = 0
    this.writeOff = 0
    this.liveBytes = 0
  }

  /** Live wire bytes held. Excludes end-of-buffer slack, which is capacity, not content. */
  get bytes(): number {
    return this.liveBytes
  }

  get entries(): number {
    return this.count
  }

  /** Entries lost to overwrite pressure, including chunks refused as oversize. */
  get evicted(): number {
    return this.evictedCount
  }

  get evictedBytes(): number {
    return this.evictedByteCount
  }

  /**
   * The subset of {@link evicted} that was refused for being larger than the
   * whole ring, rather than overwritten.
   *
   * Reported separately because the two losses are not equivalent to a
   * re-parse: an eviction truncates a stream's history from the front, which a
   * replay can see and bound, while a refusal leaves a **hole in the middle**
   * that a replay cannot see at all. Non-zero here means no stream's bytes may
   * be assumed contiguous, and it also means the configured depth is too small
   * for the traffic — a chunk bigger than the entire ring.
   */
  get refused(): number {
    return this.refusedCount
  }

  get refusedBytes(): number {
    return this.refusedByteCount
  }

  /**
   * Where a `len`-byte entry may be written contiguously, or `-1` when the
   * caller must evict first.
   *
   * The live region runs from the oldest entry's offset to {@link writeOff},
   * wrapping at most once. `writeOff === oldest offset` with entries present
   * means full — there is no free-space reading of it that is safe, so it is
   * always treated as full and one eviction resolves the ambiguity.
   */
  private offsetFor(len: number): number {
    // A zero-length write needs no bytes, so it must never evict for space.
    // Without this the `writeOff === oldest offset` full case below discards a
    // live entry to make room for nothing — and an empty `write()` is legal and
    // does reach the seam.
    if (len === 0) return this.writeOff
    if (this.count === 0) return 0
    const start = this.slotOff[this.head]!
    const w = this.writeOff
    if (w < start) return start - w >= len ? w : -1
    if (w > start) {
      if (this.buf.length - w >= len) return w
      // Wrap rather than split: abandon the tail slack, write at the front.
      return start >= len ? 0 : -1
    }
    return -1
  }

  private evictOldest(): void {
    const h = this.head
    const len = this.slotLen[h]!
    this.evictedCount++
    this.evictedByteCount += len
    this.liveBytes -= len
    this.slotSession[h] = undefined
    this.head = h + 1 >= this.maxEntries ? 0 : h + 1
    this.count--
    if (this.count === 0) this.writeOff = 0
  }

  private slotOfNth(n: number): number {
    const slot = this.head + n
    return slot >= this.maxEntries ? slot - this.maxEntries : slot
  }

  private entryAt(slot: number): RingEntry {
    const off = this.slotOff[slot]!
    const len = this.slotLen[slot]!
    const flags = this.slotFlags[slot]!
    return {
      seq: this.slotSeq[slot]!,
      sessionId: this.slotSession[slot] ?? '',
      streamId: this.slotStream[slot]!,
      dir: (flags & FLAG_TX) !== 0 ? 'tx' : 'rx',
      control: (flags & FLAG_CONTROL) !== 0,
      atMono: this.slotAt[slot]!,
      data: this.buf.slice(off, off + len),
    }
  }
}

/**
 * Binary multipliers. `MB` is 1024², not 10⁶: `'32MB'` is 33,554,432 bytes, and
 * a memory budget that meant 10⁶ would under-allocate by 5% against every other
 * number in this package.
 */
const UNITS: Readonly<Record<string, number>> = {
  b: 1,
  k: 1024,
  kb: 1024,
  kib: 1024,
  m: 1024 * 1024,
  mb: 1024 * 1024,
  mib: 1024 * 1024,
  g: 1024 * 1024 * 1024,
  gb: 1024 * 1024 * 1024,
  gib: 1024 * 1024 * 1024,
}

const DEPTH_RE = /^\s*(\d+(?:\.\d+)?)\s*([a-z]*)\s*$/i

/**
 * Resolve {@link FlightRecorderConfig.depth} — `'32MB'` or a byte count — to
 * bytes.
 *
 * **Throws on anything it cannot read.** Silently substituting a default would
 * leave the recorder sized at something other than what the customer wrote,
 * discovered during the incident they armed it for. A depth is read once, at
 * `init()`, on the caller's own stack; nothing on the data path calls this.
 */
export function parseByteDepth(v: string | number): number {
  if (typeof v === 'number') {
    const n = Math.floor(v)
    if (!Number.isFinite(n) || n < 1) {
      throw new RangeError(`${MQ3003}: ${v}`)
    }
    return n
  }
  const m = DEPTH_RE.exec(v)
  if (!m) throw new TypeError(`${MQ3004}: ${JSON.stringify(v)}`)
  const unit = (m[2] ?? '').toLowerCase()
  const mult = unit === '' ? 1 : UNITS[unit]
  if (mult === undefined) throw new TypeError(`${MQ3005}: ${JSON.stringify(m[2] ?? '')}`)
  const bytes = Math.floor(Number(m[1]) * mult)
  if (!Number.isFinite(bytes) || bytes < 1) {
    throw new RangeError(`${MQ3003}: ${JSON.stringify(v)}`)
  }
  return bytes
}
