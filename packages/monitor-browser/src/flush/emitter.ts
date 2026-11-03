/**
 * The emitter: one page load, from `init()` on, across session rotations.
 *
 * Everything the backend keys dedup and loss by lives here, so a new session
 * cannot split it: the instance claim, the body sequence, the record sequence
 * `rseq`, the chain of sealed intervals, the connection ordinals and the
 * clock. Sessions come and go; the emitter's numbers only ever count up.
 */

import {
  type BodyConn,
  type BodyTrack,
  type MarkInput,
  type RunInput,
  type StreamEndInput,
  writeMarkRecord,
  writeRunRecord,
  writeStreamEndRecord,
} from '../envelope/contract.js'
import { FrameWriter } from '../envelope/frame-writer.js'
import {
  type RecordedEnd,
  type RecordedMark,
  type RecordedRun,
  runIds,
  type Taken,
} from '../rollup/runs.js'
import { type BucketKey, bucketKeyString, bucketKeyWire, type SupportedDraft } from '../types.js'
import { ClockSync } from './clock-sync.js'

/** Entries one `run`, `mark` or `stream-end` record holds at most. */
const MAX_RECORD_ENTRIES = 65_536

/** Tracks and connections one viewer body lists at most. */
export const MAX_BODY_TRACKS = 1_024
export const MAX_BODY_CONNS = 64

/** Per-connection counters a body's `tail` lists at most, newest first. */
const MAX_TAIL_CONNS = 256

/** Closed connections kept for a later run or mark to name, oldest dropped first. */
const MAX_CLOSED_CONNS = 256

interface Conn {
  /** Once known, the connection's for its life. */
  draft: SupportedDraft | null
  readonly relay: string
  open: boolean
  /** Closed, with records naming it possibly still buffered: every body lists it. */
  listed: boolean
}

export class Emitter {
  readonly instanceId: string
  readonly clock: ClockSync
  private _seq = 0
  private _rseq = 0
  private _through: number
  private readonly _conns = new Map<number, Conn>()
  private readonly _totals = new Map<number, [number, number]>()
  private _droppedObjects = 0
  private _droppedRecords = 0
  /** Track ids, one per wire key while a buffered record names it, then free for another. */
  private readonly _tracks = new Map<string, number>()
  private readonly _trackKeys: (BodyTrack['key'] | undefined)[] = []
  private readonly _trackStrs: string[] = []
  /** Buffered records naming each id. */
  private readonly _trackRefs: number[] = []
  private readonly _freeTracks: number[] = []
  /** Each key object's string: the decoders hand the same frozen key for every object of a track. */
  private readonly _keyStrings = new WeakMap<BucketKey, string>()
  private _conn = 0
  /** Ordinals of the hooked sessions still open, kept across the page's sessions. */
  private readonly _connIds = new Map<string, number>()

  constructor(instanceId: string, startUs: number, clock: ClockSync = new ClockSync()) {
    this.instanceId = instanceId
    this._through = Math.floor(startUs)
    this.clock = clock
  }

  /** The next body's number. Bodies so far are `0 … nextSeq - 1`. */
  get nextSeq(): number {
    return this._seq
  }

  takeSeq(): number {
    return this._seq++
  }

  /**
   * The id of `key`'s track, added to `into`: the same while any buffered
   * record names it, and free for another key once none does.
   */
  trackId(key: BucketKey, into: Set<number>): number {
    let s = this._keyStrings.get(key)
    if (s === undefined) {
      s = bucketKeyString(key)
      this._keyStrings.set(key, s)
    }
    let id = this._tracks.get(s)
    if (id === undefined) {
      id = this._freeTracks.pop() ?? this._trackKeys.length
      this._tracks.set(s, id)
      this._trackKeys[id] = bucketKeyWire(key)
      this._trackStrs[id] = s
      this._trackRefs[id] = 0
    }
    into.add(id)
    return id
  }

  /** A buffered record names `ids`. */
  retainTracks(ids: ReadonlySet<number>): void {
    for (const id of ids) this._trackRefs[id] = (this._trackRefs[id] ?? 0) + 1
  }

  /** A record naming `ids` left the buffer, sealed. */
  releaseTracks(ids: ReadonlySet<number>): void {
    for (const id of ids) {
      const n = (this._trackRefs[id] ?? 0) - 1
      this._trackRefs[id] = n
      if (n > 0) continue
      this._tracks.delete(this._trackStrs[id] as string)
      this._trackKeys[id] = undefined
      this._freeTracks.push(id)
    }
  }

  /** Track ids in use: the distinct tracks buffered records name. */
  get trackCount(): number {
    return this._tracks.size
  }

  /** Whether `key` has an id now. */
  hasTrack(key: BucketKey): boolean {
    return this._tracks.has(bucketKeyString(key))
  }

  /** The `trk` entries of the tracks `ids` names, ascending. */
  bodyTracks(ids: ReadonlySet<number>): BodyTrack[] {
    return [...ids]
      .sort((a, b) => a - b)
      .map((id) => ({ id, key: this._trackKeys[id] as BodyTrack['key'] }))
  }

  /** The ordinal of the hooked session `id`: a new one at its first sight. */
  connOf(id: string): number {
    let c = this._connIds.get(id)
    if (c === undefined) {
      c = this._conn++
      this._connIds.set(id, c)
    }
    return c
  }

  /** The hooked session `id` closed. */
  connDone(id: string): void {
    this._connIds.delete(id)
  }

  /** The next record's rseq, and the one after from then on. */
  takeRseq(): number {
    return this._rseq++
  }

  /** The last rseq handed out, or `undefined` before the first. */
  get lastRseq(): number | undefined {
    return this._rseq === 0 ? undefined : this._rseq - 1
  }

  /** The last body's `through_us`: the next body's `from_us`. */
  get throughUs(): number {
    return this._through
  }

  /** A body sealed the interval up to `throughUs`. */
  sealThrough(throughUs: number): void {
    this._through = Math.max(this._through, throughUs)
  }

  /**
   * A connection opened, or its draft became known: bodies list it from now
   * until after it closes. A known draft stays the connection's.
   */
  noteConn(c: number, draft: SupportedDraft | null, relay: string): void {
    const known = this._conns.get(c)
    if (known?.open) {
      known.draft ??= draft
      return
    }
    this._conns.delete(c)
    this._conns.set(c, { draft: known?.draft ?? draft, relay, open: true, listed: false })
  }

  noteConnClosed(c: number): void {
    const known = this._conns.get(c)
    if (known === undefined || !known.open) return
    known.open = false
    known.listed = true
  }

  /**
   * A queue sealed everything it buffered: no buffered record names a closed
   * connection, so bodies list it again only when a run or mark does.
   */
  sweepClosed(): void {
    let closed = 0
    for (const k of this._conns.values()) {
      k.listed = false
      if (!k.open) closed += 1
    }
    for (const [c, k] of this._conns) {
      if (closed <= MAX_CLOSED_CONNS) break
      if (k.open) continue
      this._conns.delete(c)
      closed -= 1
    }
  }

  /** Records an ended session dropped before encoding, for `tail.pre_drop.records`. */
  noteDroppedRecords(n: number): void {
    this._droppedRecords += n
  }

  get droppedRecords(): number {
    return this._droppedRecords
  }

  /** Arrivals no run could hold, counted in `tail.pre_drop.objects`. */
  noteDroppedObjects(n: number): void {
    this._droppedObjects += n
  }

  get droppedObjects(): number {
    return this._droppedObjects
  }

  /** Objects and payload bytes per connection, cumulative over the emitter. */
  noteTotals(runs: readonly RecordedRun[]): void {
    for (const r of runs) {
      const t = this._totals.get(r.c)
      if (t === undefined) this._totals.set(r.c, [r.n, r.b])
      else {
        t[0] += r.n
        t[1] += r.b
      }
    }
  }

  tailConns(): [number, number, number][] {
    const out: [number, number, number][] = []
    for (const [c, t] of this._totals) out.push([c, t[0], t[1]])
    return out.slice(-MAX_TAIL_CONNS)
  }

  /**
   * The connections a body lists: every one `referenced` names, then every
   * open one and every closed one until a seal leaves nothing buffered, up to
   * {@link MAX_BODY_CONNS}.
   */
  bodyConns(referenced: ReadonlySet<number>): BodyConn[] {
    const out: BodyConn[] = []
    let room = MAX_BODY_CONNS - referenced.size
    for (const [c, k] of this._conns) {
      const named = referenced.has(c)
      if (!named && (!(k.open || k.listed) || room <= 0)) continue
      if (!named) room -= 1
      out.push(k.draft === null ? { c, relay: k.relay } : { c, draft: k.draft, relay: k.relay })
    }
    return out.sort((a, b) => a.c - b.c)
  }
}

/**
 * The base every `run` and `mark` record is encoded against, and every body's
 * `clk.base_us`: the emitter's mono origin, the page's `performance.now()`
 * zero. One base for every body lets a record be written whenever it is
 * taken and sealed in whichever body it lands in, packed with the rest.
 */
export const RECORD_BASE_US = 0

/** The tracks and connections one record names. */
export interface RecordRefs {
  readonly ti: ReadonlySet<number>
  readonly c: ReadonlySet<number>
}

/** One `run`, `mark` or `stream-end` record ready to buffer: its frames, rseq and references. */
export interface EncodedFacts {
  readonly frames: Uint8Array
  readonly count: number
  readonly records: readonly { readonly rseq: number; readonly refs: RecordRefs }[]
}

type Entry = RecordedRun | RecordedMark | RecordedEnd

/** The entries `[from, to)` of one record: none names more tracks or connections than a body lists. */
function cut(list: readonly Entry[], from: number): number {
  const end = Math.min(list.length, from + MAX_RECORD_ENTRIES)
  // Distinct key objects bound the distinct tracks from above, so counting
  // them settles the common case without building a key string per entry.
  const objs = new Set<BucketKey>()
  const few = new Set<number>()
  let j = from
  for (; j < end; j++) {
    const x = list[j] as Entry
    objs.add(x.key)
    few.add(x.c)
    if (objs.size > MAX_BODY_TRACKS || few.size > MAX_BODY_CONNS) break
  }
  if (j === end) return end
  const keys = new Set<string>()
  const conns = new Set<number>()
  let i = from
  for (; i < list.length && i - from < MAX_RECORD_ENTRIES; i++) {
    const x = list[i] as Entry
    const k = bucketKeyString(x.key)
    const newKey = !keys.has(k)
    const newConn = !conns.has(x.c)
    if ((newKey && keys.size === MAX_BODY_TRACKS) || (newConn && conns.size === MAX_BODY_CONNS)) {
      break
    }
    if (newKey) keys.add(k)
    if (newConn) conns.add(x.c)
  }
  return i
}

/**
 * Encode `t` one record at a time, taking an rseq per record, and hand each
 * to `put`. `room` says whether the open body can list a record naming these
 * tracks and connections; when it cannot, `full` seals it first.
 */
export function encodeFacts(
  e: Emitter,
  t: Taken,
  put: (f: EncodedFacts) => void,
  room: (
    part: readonly { readonly key: BucketKey }[],
    conns: ReadonlySet<number>,
  ) => boolean = () => true,
  full: () => void = () => {},
): void {
  const each = <T extends Entry>(
    list: readonly T[],
    write: (
      w: FrameWriter,
      rseq: number,
      part: readonly T[],
      ti: Set<number>,
      c: Set<number>,
    ) => void,
  ): void => {
    for (let i = 0; i < list.length; ) {
      const to = cut(list, i)
      const part = list.slice(i, to)
      i = to
      const conns = new Set<number>()
      for (const x of part) conns.add(x.c)
      if (!room(part, conns)) full()
      const w = new FrameWriter({ initialBytes: 256 })
      const ti = new Set<number>()
      const c = new Set<number>()
      const rseq = e.takeRseq()
      write(w, rseq, part, ti, c)
      const count = w.frameCount
      put({ frames: w.take(), count, records: [{ rseq, refs: { ti, c } }] })
    }
  }
  each(t.runs, (w, rseq, part, ti, c) =>
    writeRunRecord(
      w,
      rseq,
      RECORD_BASE_US,
      part.map((r) => runInput(r, e.trackId(r.key, ti), c)),
    ),
  )
  each(t.marks, (w, rseq, part, ti, c) =>
    writeMarkRecord(
      w,
      rseq,
      RECORD_BASE_US,
      part.map((m) => markInput(m, e.trackId(m.key, ti), c)),
    ),
  )
  each(t.ends, (w, rseq, part, ti, c) =>
    writeStreamEndRecord(
      w,
      rseq,
      RECORD_BASE_US,
      part.map((x) => endInput(x, e.trackId(x.key, ti), c)),
    ),
  )
}

function runInput(r: RecordedRun, ti: number, conns: Set<number>): RunInput {
  conns.add(r.c)
  const stream = r.path !== 'datagram'
  return {
    c: r.c,
    ti,
    g: r.g,
    path: r.path,
    sub: r.sub,
    ...(stream ? { sid: BigInt(r.sid) } : {}),
    ids: runIds(r),
    ...(r.osub !== null ? { osub: r.osub } : {}),
    timesUs: r.times,
    tlUs: r.tl,
    b: r.b,
    cont: r.cont,
    fo: r.fo,
    foKnown: r.foKnown,
    eog: r.eog,
    end: r.end,
    ...(r.rc !== null ? { rc: r.rc } : {}),
  }
}

function endInput(x: RecordedEnd, ti: number, conns: Set<number>): StreamEndInput {
  conns.add(x.c)
  return {
    eog: x.eog,
    end: x.end,
    c: x.c,
    ti,
    path: x.path,
    sid: BigInt(x.sid),
    ...(x.g !== null ? { g: x.g } : {}),
    ...(x.o !== null ? { o: x.o } : {}),
    tUs: x.tUs,
    ...(x.rc !== null ? { rc: x.rc } : {}),
  }
}

function markInput(m: RecordedMark, ti: number, conns: Set<number>): MarkInput {
  conns.add(m.c)
  return {
    kind: m.kind,
    c: m.c,
    ti,
    g: m.g,
    o: m.o,
    ...(m.g2 !== undefined ? { g2: m.g2 } : {}),
    ...(m.o2 !== undefined ? { o2: m.o2 } : {}),
    ...(m.n !== undefined ? { n: m.n } : {}),
    tUs: m.tUs,
    path: m.path,
    ...(m.sid >= 0 ? { sid: BigInt(m.sid) } : {}),
  }
}
