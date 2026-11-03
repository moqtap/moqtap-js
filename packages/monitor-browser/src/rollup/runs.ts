/**
 * The run recorder: every arriving object, unsampled, as runs.
 *
 * A flow is `(connection, stream, group)` for a stream, since a FETCH or fill
 * stream carries several groups, and `(connection, track, group)` for
 * datagrams. A stream run breaks when an object id is not above the previous
 * one on the stream, at FIN or RESET, and at a seal; a datagram run keeps ids
 * in arrival order and breaks only at a seal. A run never spans bodies: one
 * still open at a seal is taken with `end: open`, and the next run of the
 * same flow is marked `cont`, until the stream ends. A stream's end that no
 * run can carry, because its last run was taken already or it carried no
 * object, is a stream end of its own.
 *
 * Nothing here infers a group start, a loss or an order from ids.
 */

import type { MarkKind, RunEnd, StreamEndKind } from '../envelope/contract.js'
import {
  type BucketKey,
  bucketKeyString,
  type DeliveryPath,
  type MarkSample,
  type Mono,
  type ObjectSample,
  type StreamHeaderSample,
  type SupportedDraft,
} from '../types.js'

/** Flows a recorder holds open before it asks for an early seal. */
export const MAX_OPEN_FLOWS = 4096

/** One run as captured. Times are µs from the session anchor. */
export interface RecordedRun {
  /** The flow, for joining a worker's forwarded pieces: unique per emitter. */
  readonly flow: string
  readonly c: number
  readonly key: BucketKey
  readonly path: DeliveryPath
  readonly g: bigint
  /** The stream's subgroup; null for a datagram flow and on the fetch paths. */
  readonly sub: bigint | null
  /** The stream; -1 for a datagram. */
  readonly sid: number
  readonly o0: bigint
  /** Every id, when they are not `o0, o0 + 1, …`; null while they are. */
  ids: bigint[] | null
  n: number
  last: bigint
  /** Fetch paths: each object's subgroup. */
  readonly osub: (bigint | null)[] | null
  readonly times: number[]
  b: number
  tl: number
  cont: boolean
  readonly fo: boolean
  readonly foKnown: boolean
  eog: boolean
  end: RunEnd
  rc: bigint | null
}

/** One mark as received. */
export interface RecordedMark {
  readonly c: number
  readonly key: BucketKey
  readonly kind: MarkKind
  readonly g: bigint
  readonly o: bigint
  readonly g2?: bigint
  readonly o2?: bigint
  readonly n?: bigint
  readonly tUs: number
  readonly path: DeliveryPath
  /** -1 on the datagram path. */
  readonly sid: number
}

/** A stream's end that no run carries. */
export interface RecordedEnd {
  readonly c: number
  readonly key: BucketKey
  readonly path: DeliveryPath
  readonly sid: number
  readonly eog: boolean
  readonly end: StreamEndKind
  /** The group of the stream's last object, or its subgroup header's. */
  readonly g: bigint | null
  /** The stream's last object id in `g`. */
  readonly o: bigint | null
  readonly tUs: number
  readonly rc: bigint | null
}

export interface Taken {
  readonly runs: RecordedRun[]
  readonly marks: RecordedMark[]
  readonly ends: RecordedEnd[]
  /** Arrivals since the last take that no run could hold. */
  readonly dropped?: number
}

/** A stream end that closes a group, for the rollup's group span. */
export interface GroupEnd {
  readonly key: BucketKey
  readonly g: bigint
}

interface StreamFlow {
  readonly c: number
  readonly sid: number
  readonly key: BucketKey
  readonly path: DeliveryPath
  /** The subgroup header's group; null on a fetch stream. */
  headerG: bigint | null
  /** The stream has delivered an object. */
  seen: boolean
  /** The header's FIRST_OBJECT, which only the stream's first run starts at. */
  fo: boolean
  foKnown: boolean
  eog: boolean
  first: boolean
  run: RecordedRun | null
  /** The last id the stream delivered, across seals. */
  lastId: bigint
  lastGroup: bigint
  /** The stream's last run was taken open at a seal: the next one continues it. */
  sealedOpen: boolean
  /** That run, while no later one has started: the stream's end is its end. */
  taken: RecordedRun | null
}

/** A non-Normal status as a mark kind, by the connection's draft. */
export function statusKind(code: bigint, draft: SupportedDraft): MarkKind {
  switch (code) {
    case 1n:
      return draft <= 15 ? 'dne' : 'status_unknown'
    case 3n:
      return 'eog'
    case 4n:
      return draft <= 10 ? 'eotg' : 'eot'
    case 5n:
      return draft === 7 ? 'eosg' : draft <= 10 ? 'eot' : 'status_unknown'
    default:
      return 'status_unknown'
  }
}

/** A FETCH End-of-Range marker as a mark kind, by the connection's draft. */
export function rangeKind(flags: number, draft: SupportedDraft): MarkKind | undefined {
  switch (flags) {
    case 0x8c:
      return draft >= 16 ? 'rng_nx' : undefined
    case 0x10c:
      return draft >= 16 ? 'rng_unk' : undefined
    case 0x20c:
      return draft >= 20 ? 'rng_to' : undefined
    case 0x40c:
      return draft >= 23 ? 'rng_gone' : undefined
    default:
      return undefined
  }
}

/** The largest Object ID. */
const MAX_U64 = 0xffff_ffff_ffff_ffffn

export class RunRecorder {
  private readonly streams = new Map<number, Map<number, StreamFlow>>()
  private readonly datagrams = new Map<BucketKey, Map<bigint, RecordedRun>>()
  /** Datagram flows whose run was taken at a seal, oldest first. */
  private readonly sealedDatagrams = new Set<string>()
  private open = 0
  private done: RecordedRun[] = []
  /** This interval's runs by flow, for joining a worker's pieces. */
  private byFlow = new Map<string, RecordedRun>()
  private marks: RecordedMark[] = []
  private ends: RecordedEnd[] = []
  private readonly totals = new Map<number, { objects: number; bytes: number }>()
  /** Arrivals no run could hold: objects of an unseen request's stream whose group is not known. */
  droppedObjects = 0

  constructor(
    /** The session anchor's monotonic origin, ms. */
    private readonly origin: Mono,
    /** Called once when the open flows reach {@link MAX_OPEN_FLOWS}. */
    public onFull?: () => void,
  ) {}

  /** Flows with a run open now. */
  get openFlows(): number {
    return this.open
  }

  /** Cumulative objects and payload bytes per connection ordinal. */
  counters(): readonly (readonly [c: number, objects: number, bytes: number])[] {
    const out: [number, number, number][] = []
    for (const [c, t] of this.totals) out.push([c, t.objects, t.bytes])
    return out
  }

  /** A data stream's header, before any object on it. */
  onStreamHeader(c: number, h: StreamHeaderSample): void {
    if (h.key.dir !== 'rx') return
    const f = this.flow(c, h.streamId, h.key, h.path)
    f.headerG = h.groupId
    f.eog = h.eog
  }

  /** One Normal object. Status objects go to {@link onMark}. */
  onObject(c: number, s: ObjectSample): void {
    if (s.key.dir !== 'rx' || s.status !== undefined) return
    const t = (s.at - this.origin) * 1000
    let total = this.totals.get(c)
    if (total === undefined) {
      total = { objects: 0, bytes: 0 }
      this.totals.set(c, total)
    }
    total.objects += 1
    total.bytes += s.payloadBytes
    if (s.streamId === undefined) this.datagram(c, s, t)
    else this.stream(c, s.streamId, s, t)
  }

  /** More of the open run's last payload arrived on the stream. */
  onPayload(c: number, sid: number, at: Mono): void {
    const run = this.streams.get(c)?.get(sid)?.run
    if (run != null) run.tl = (at - this.origin) * 1000
  }

  /**
   * The stream ended: its open run takes the end, and the flow is forgotten.
   * With no open run the end is recorded alone. A stream that failed (`gone`)
   * ends neither in FIN nor in a reset code. Returns the group the end
   * closes, for the rollup.
   */
  onStreamEnd(
    c: number,
    sid: number,
    end: 'fin' | 'reset' | 'gone',
    code: number | undefined,
    at: Mono,
  ): GroupEnd | undefined {
    const flows = this.streams.get(c)
    const f = flows?.get(sid)
    if (f === undefined) return undefined
    const run = f.run
    if (run !== null) {
      endRun(run, f, end, code)
      this.close(run)
      this.open -= 1
    } else if (end !== 'gone' && (f.taken !== null || !f.seen)) {
      const t = f.taken
      this.ends.push({
        c,
        key: f.key,
        path: f.path,
        sid,
        eog: end === 'fin' && f.eog && f.path === 'sub_stream',
        end,
        g: t !== null ? t.g : f.headerG,
        o: t !== null ? t.last : null,
        tUs: (at - this.origin) * 1000,
        rc: end === 'reset' ? BigInt(code ?? 0) : null,
      })
    }
    flows!.delete(sid)
    if (flows!.size === 0) this.streams.delete(c)
    if (end !== 'fin' || !f.eog || f.path !== 'sub_stream') return undefined
    const g = f.seen ? f.lastGroup : f.headerG
    return g === null ? undefined : { key: f.key, g }
  }

  /** The connection is gone: every stream of it ends where it stood. */
  onConnClose(c: number): void {
    const flows = this.streams.get(c)
    if (flows !== undefined) {
      for (const f of flows.values()) {
        if (f.run !== null) {
          this.close(f.run)
          this.open -= 1
        }
      }
      this.streams.delete(c)
    }
    for (const [key, groups] of this.datagrams) {
      for (const [g, run] of groups) {
        if (run.c !== c) continue
        this.close(run)
        this.open -= 1
        groups.delete(g)
      }
      if (groups.size === 0) this.datagrams.delete(key)
    }
  }

  /**
   * A status object, a FETCH range marker, a gap property, or a FETCH End of
   * Group or End of Track, on a connection of `draft`.
   */
  onMark(c: number, draft: SupportedDraft, m: MarkSample | ObjectSample): void {
    if (m.key.dir !== 'rx' || m.path === null) return
    const tUs = (m.at - this.origin) * 1000
    const sid = m.streamId ?? -1
    const base = { c, key: m.key, g: m.groupId, o: m.objectId, tUs, path: m.path, sid }
    if (!('what' in m)) {
      if (m.status === undefined) return
      const kind = statusKind(m.status, draft)
      this.marks.push(
        kind === 'status_unknown' ? { ...base, kind, n: m.status } : { ...base, kind },
      )
      return
    }
    const w = m.what
    if ('status' in w) {
      const kind = statusKind(w.status, draft)
      this.marks.push(
        kind === 'status_unknown' ? { ...base, kind, n: w.status } : { ...base, kind },
      )
    } else if ('range' in w) {
      const kind = rangeKind(w.range, draft)
      const n = w.first ? 1n : 0n
      if (kind !== undefined) this.marks.push({ ...base, kind, g2: w.g2, o2: w.o2, n })
    } else if ('end' in w) {
      // The run holding {G, O} ends the group. End of Track also says no
      // Location past {G, O} exists, which is End of Track at {G, O + 1}.
      this.endGroup(c, sid, m.groupId, m.objectId, tUs)
      if (w.end === 'track' && m.objectId < MAX_U64) {
        this.marks.push({ ...base, kind: 'eot', o: m.objectId + 1n })
      }
    } else {
      this.marks.push({ ...base, kind: w.gap === 'group' ? 'pgg' : 'pog', n: w.n })
    }
  }

  /**
   * Everything since the last take: every open run closed `open` (a stream)
   * or `na` (datagrams), and every mark. Stream state stays, so the next run
   * of a flow continues the one taken.
   *
   * With `hold`, a take that seals no body, a stream run still open stays
   * open, joined pieces included, so its end is still its own.
   */
  take(hold = false): Taken {
    let open = 0
    for (const flows of this.streams.values()) {
      for (const f of flows.values()) {
        if (f.run === null) continue
        if (hold) {
          open += 1
          continue
        }
        this.close(f.run)
        f.taken = f.run
        f.run = null
        f.sealedOpen = true
      }
    }
    for (const groups of this.datagrams.values()) {
      for (const run of groups.values()) {
        this.close(run)
        this.sealedDatagrams.delete(run.flow)
        this.sealedDatagrams.add(run.flow)
      }
    }
    let excess = this.sealedDatagrams.size - MAX_OPEN_FLOWS
    for (const flow of this.sealedDatagrams) {
      if (excess-- <= 0) break
      this.sealedDatagrams.delete(flow)
    }
    this.datagrams.clear()
    this.open = open
    const kept = hold ? this.done.filter((r) => r.end === 'open') : []
    const runs = hold ? this.done.filter((r) => r.end !== 'open') : this.done
    const out = { runs, marks: this.marks, ends: this.ends }
    this.done = kept
    this.marks = []
    this.ends = []
    this.byFlow = new Map(kept.map((r) => [r.flow, r]))
    return out
  }

  /**
   * A worker's forwarded runs, marks and stream ends, appended to this
   * interval's. A piece that continues a run of this interval is joined to
   * it, and so is an end whose run is still here, so a worker's run spans its
   * forwards and is sealed once.
   */
  absorb(t: Taken): void {
    for (const r of t.runs) {
      const prior = r.cont ? this.byFlow.get(r.flow) : undefined
      if (prior !== undefined && (prior.end === 'open' || prior.end === 'na')) {
        join(prior, r)
        continue
      }
      this.done.push(r)
      this.byFlow.set(r.flow, r)
    }
    for (const m of t.marks) this.marks.push(m)
    for (const e of t.ends) {
      const prior = e.g === null ? undefined : this.byFlow.get(`${e.c}:${e.sid}:${e.g}`)
      if (prior !== undefined && prior.end === 'open' && prior.last === e.o) {
        if (e.end !== 'none') {
          prior.end = e.end
          prior.rc = e.rc
        }
        if (e.eog) prior.eog = true
        continue
      }
      this.ends.push(e)
    }
  }

  /** The stream's run whose last object is {g, o} ends its group. */
  private endGroup(c: number, sid: number, g: bigint, o: bigint, tUs: number): void {
    const f = this.streams.get(c)?.get(sid)
    if (f === undefined) return
    const run = f.run
    if (run !== null) {
      if (run.g === g && run.last === o) run.eog = true
      return
    }
    // Its run was taken already: the end goes alone.
    const t = f.taken
    if (t === null || t.g !== g || t.last !== o) return
    this.ends.push({
      c,
      key: f.key,
      path: f.path,
      sid,
      eog: true,
      end: 'none',
      g,
      o,
      tUs,
      rc: null,
    })
  }

  private flow(c: number, sid: number, key: BucketKey, path: DeliveryPath): StreamFlow {
    let flows = this.streams.get(c)
    if (flows === undefined) {
      flows = new Map()
      this.streams.set(c, flows)
    }
    let f = flows.get(sid)
    if (f === undefined) {
      f = {
        c,
        sid,
        key,
        path,
        headerG: null,
        seen: false,
        fo: false,
        foKnown: false,
        eog: false,
        first: true,
        run: null,
        lastId: 0n,
        lastGroup: 0n,
        sealedOpen: false,
        taken: null,
      }
      flows.set(sid, f)
    }
    return f
  }

  private close(run: RecordedRun): void {
    this.done.push(run)
    this.byFlow.set(run.flow, run)
  }

  private stream(c: number, sid: number, s: ObjectSample, t: number): void {
    const f = this.flow(c, sid, s.key, s.path)
    if (!f.seen) {
      f.seen = true
      f.fo = s.fo
      f.foKnown = s.foKnown
      f.eog = s.eog
    }
    let run = f.run
    if (run !== null && (run.g !== s.groupId || s.objectId <= run.last)) {
      this.close(run)
      f.run = null
      run = null
      this.open -= 1
      f.sealedOpen = false
    }
    if (run === null) {
      const cont = f.sealedOpen && !f.first && f.lastGroup === s.groupId && s.objectId > f.lastId
      f.sealedOpen = false
      f.taken = null
      const fetch = s.path !== 'sub_stream'
      run = {
        flow: `${c}:${sid}:${s.groupId}`,
        c,
        key: s.key,
        path: s.path,
        g: s.groupId,
        sub: fetch ? null : s.sub,
        sid,
        o0: s.objectId,
        ids: null,
        n: 1,
        last: s.objectId,
        osub: fetch ? [s.sub] : null,
        times: [t],
        b: s.payloadBytes,
        tl: t,
        cont,
        fo: f.first && f.fo,
        foKnown: f.foKnown,
        eog: false,
        end: 'open',
        rc: null,
      }
      f.first = false
      f.run = run
      this.grow()
    } else {
      append(run, s.objectId, t, s.payloadBytes)
      run.osub?.push(s.sub)
    }
    f.lastId = s.objectId
    f.lastGroup = s.groupId
  }

  private datagram(c: number, s: ObjectSample, t: number): void {
    let groups = this.datagrams.get(s.key)
    if (groups === undefined) {
      groups = new Map()
      this.datagrams.set(s.key, groups)
    }
    let run = groups.get(s.groupId)
    if (run === undefined) {
      const flow = `${c}:d:${bucketKeyString(s.key)}:${s.groupId}`
      run = {
        flow,
        c,
        key: s.key,
        path: 'datagram',
        g: s.groupId,
        sub: null,
        sid: -1,
        o0: s.objectId,
        ids: null,
        n: 1,
        last: s.objectId,
        osub: null,
        times: [t],
        b: s.payloadBytes,
        tl: t,
        cont: this.sealedDatagrams.has(flow),
        fo: false,
        foKnown: false,
        eog: s.eog,
        end: 'na',
        rc: null,
      }
      groups.set(s.groupId, run)
      this.grow()
    } else {
      append(run, s.objectId, t, s.payloadBytes)
      if (s.eog) run.eog = true
    }
  }

  private grow(): void {
    this.open += 1
    if (this.open === MAX_OPEN_FLOWS) this.onFull?.()
  }
}

function append(run: RecordedRun, id: bigint, t: number, bytes: number): void {
  if (run.ids === null && id !== run.last + 1n) {
    run.ids = []
    for (let i = 0; i < run.n; i++) run.ids.push(run.o0 + BigInt(i))
  }
  run.ids?.push(id)
  run.n += 1
  run.last = id
  run.times.push(t)
  run.b += bytes
  run.tl = t
}

/** The stream ended in `end`, `run` its last run. A stream that failed (`gone`) has no end. */
function endRun(
  run: RecordedRun,
  f: StreamFlow,
  end: 'fin' | 'reset' | 'gone',
  code?: number,
): void {
  if (end !== 'gone') run.end = end
  if (end === 'fin' && f.eog && run.path === 'sub_stream') run.eog = true
  if (end === 'reset') run.rc = BigInt(code ?? 0)
}

/** `next` continues `prior`: one run. */
function join(prior: RecordedRun, next: RecordedRun): void {
  if (next.n === 0) {
    prior.eog ||= next.eog
    prior.end = next.end
    prior.rc = next.rc
    return
  }
  if (prior.ids === null && (next.ids !== null || next.o0 !== prior.last + 1n)) {
    prior.ids = []
    for (let i = 0; i < prior.n; i++) prior.ids.push(prior.o0 + BigInt(i))
  }
  if (prior.ids !== null) {
    if (next.ids !== null) for (const id of next.ids) prior.ids.push(id)
    else for (let i = 0; i < next.n; i++) prior.ids.push(next.o0 + BigInt(i))
  }
  prior.n += next.n
  prior.last = next.last
  if (prior.osub !== null && next.osub !== null) for (const s of next.osub) prior.osub.push(s)
  for (const t of next.times) prior.times.push(t)
  prior.b += next.b
  prior.tl = next.tl
  prior.eog ||= next.eog
  prior.end = next.end
  prior.rc = next.rc
}

/** A run's ids, in order. */
export function runIds(r: RecordedRun): bigint[] {
  if (r.ids !== null) return r.ids
  const out: bigint[] = []
  for (let i = 0; i < r.n; i++) out.push(r.o0 + BigInt(i))
  return out
}
