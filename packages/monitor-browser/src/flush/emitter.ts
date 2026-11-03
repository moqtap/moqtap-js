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
  writeMarkRecord,
  writeRunRecord,
} from '../envelope/contract.js'
import { FrameWriter } from '../envelope/frame-writer.js'
import { type RecordedMark, type RecordedRun, runIds, type Taken } from '../rollup/runs.js'
import { type BucketKey, bucketKeyString, bucketKeyWire, type SupportedDraft } from '../types.js'
import { ClockSync } from './clock-sync.js'

/** Entries one `run` or `mark` record holds at most. */
const MAX_RECORD_ENTRIES = 65_536

/** Per-connection counters a body's `tail` lists at most, newest first. */
const MAX_TAIL_CONNS = 256

/** Closed connections kept for a later run or mark to name, oldest dropped first. */
const MAX_CLOSED_CONNS = 256

interface Conn {
  readonly draft: SupportedDraft
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
    const s = bucketKeyString(key)
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

  /** A connection's draft is known: bodies list it from now until after it closes. */
  noteConn(c: number, draft: SupportedDraft, relay: string): void {
    const known = this._conns.get(c)
    if (known?.open) return
    this._conns.delete(c)
    this._conns.set(c, { draft, relay, open: true, listed: false })
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
   * The connections a body lists: every open one, every closed one until a
   * seal leaves nothing buffered, and every one `referenced` names.
   */
  bodyConns(referenced: ReadonlySet<number>): BodyConn[] {
    const out: BodyConn[] = []
    for (const [c, k] of this._conns) {
      if (k.open || k.listed || referenced.has(c)) {
        out.push({ c, draft: k.draft, relay: k.relay })
      }
    }
    return out
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

/** `run` and `mark` records ready to buffer: their frames, and per record its rseq and references. */
export interface EncodedFacts {
  readonly frames: Uint8Array
  readonly count: number
  readonly records: readonly { readonly rseq: number; readonly refs: RecordRefs }[]
}

/** Encode `t`, taking an rseq per record. Empty when `t` holds nothing. */
export function encodeFacts(e: Emitter, t: Taken): EncodedFacts {
  const w = new FrameWriter({ initialBytes: 256 })
  const records: { rseq: number; refs: RecordRefs }[] = []
  for (let i = 0; i < t.runs.length; i += MAX_RECORD_ENTRIES) {
    const ti = new Set<number>()
    const c = new Set<number>()
    const runs = t.runs
      .slice(i, i + MAX_RECORD_ENTRIES)
      .map((r): RunInput => runInput(r, e.trackId(r.key, ti), c))
    const rseq = e.takeRseq()
    writeRunRecord(w, rseq, RECORD_BASE_US, runs)
    records.push({ rseq, refs: { ti, c } })
  }
  for (let i = 0; i < t.marks.length; i += MAX_RECORD_ENTRIES) {
    const ti = new Set<number>()
    const c = new Set<number>()
    const marks = t.marks
      .slice(i, i + MAX_RECORD_ENTRIES)
      .map((m): MarkInput => markInput(m, e.trackId(m.key, ti), c))
    const rseq = e.takeRseq()
    writeMarkRecord(w, rseq, RECORD_BASE_US, marks)
    records.push({ rseq, refs: { ti, c } })
  }
  const count = w.frameCount
  return { frames: w.take(), count, records }
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
