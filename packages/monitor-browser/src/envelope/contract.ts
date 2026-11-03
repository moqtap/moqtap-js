/**
 * The v2 viewer body: the uncompressed preamble frame `{v: 2, i, em, seal}`
 * after the 8-byte header, then the batch record and the fact records, each
 * a JSON frame, gzipped or not. A `run` or `mark` record is one JSON
 * descriptor followed by one raw frame of LEB128 columns:
 *
 *     run   fl c ti g path [sk [sub]] [sid] o0 n [oid…] [osub…] t0 dt… b [rc] tl
 *     mark  kind c ti g o [g2 o2] [n] t path [sid]
 *
 * Within a record, `g` is a `z` delta from the same track's previous run (the
 * first from 0), `sid` a `z` delta from the previous stream run's (the first
 * from 0), and `t0`/`t` a `t` delta from the previous entry's (the first from
 * the body's `clk.base_us`). Every time is device mono µs, floored.
 */

import type { BatchRecord, EnvelopeRecord } from '../types.js'
import { FrameWriter } from './frame-writer.js'
import { LebWriter } from './leb.js'

export const CONTRACT_BODY_VERSION = 2

export const DELIVERY_PATHS = ['sub_stream', 'datagram', 'fetch', 'fetch_joining', 'fill'] as const
export type DeliveryPath = (typeof DELIVERY_PATHS)[number]

export const RUN_ENDS = ['open', 'fin', 'reset', 'na'] as const
export type RunEnd = (typeof RUN_ENDS)[number]

export const MARK_KINDS = [
  'eog',
  'eot',
  'eotg',
  'eosg',
  'dne',
  'rng_nx',
  'rng_unk',
  'rng_to',
  'pgg',
  'pog',
  'status_unknown',
] as const
export type MarkKind = (typeof MARK_KINDS)[number]

const FL_CONT = 0x01
const FL_XID = 0x02
const FL_FO = 0x04
const FL_FO_KNOWN = 0x08
const FL_EOG = 0x10
const FL_END_SHIFT = 5

/** Time quantum of `dt` and `tl`, µs. */
export const DT_QUANTUM_US = 100

const INT32_MIN = -(2 ** 31)
const INT32_MAX = 2 ** 31 - 1

/** One viewer run as captured: ids and times as they arrived. */
export interface RunInput {
  /** Continues the previous run of this flow in encode order. */
  readonly cont?: boolean
  /** FIRST_OBJECT was set on the subgroup header. */
  readonly fo?: boolean
  /** A subgroup stream on draft 18 or later, where FIRST_OBJECT exists. */
  readonly foKnown?: boolean
  /** The run ends the group: EOG header bit and FIN, or the datagram flag. */
  readonly eog?: boolean
  /** Default: `na` for a datagram, `open` for a stream. */
  readonly end?: RunEnd
  readonly c: number
  readonly ti: number
  readonly g: bigint
  readonly path: DeliveryPath
  /** The stream's subgroup; null for a datagram flow. Unused on the fetch paths. */
  readonly sub?: bigint | null
  /** The QUIC stream id; absent for a datagram. */
  readonly sid?: bigint
  /** Every object id, in arrival order. */
  readonly ids: readonly bigint[]
  /** Fetch paths: each object's subgroup, null when datagram-flagged. */
  readonly osub?: readonly (bigint | null)[]
  /** Each object's time, device mono µs. */
  readonly timesUs: readonly number[]
  /** Payload bytes of the run. */
  readonly b: number
  /** The reset code, when `end` is `reset`. */
  readonly rc?: bigint
  /** The last payload byte's time, device mono µs. Default: the last object's. */
  readonly tlUs?: number
}

export interface MarkInput {
  readonly kind: MarkKind
  readonly c: number
  readonly ti: number
  readonly g: bigint
  readonly o: bigint
  /** FETCH range end: `rng_*` only. */
  readonly g2?: bigint
  readonly o2?: bigint
  /** `pgg`/`pog` the gap; `status_unknown` the raw status code. */
  readonly n?: bigint
  readonly tUs: number
  readonly path: DeliveryPath
  /** Absent on the datagram path. */
  readonly sid?: bigint
}

const isRange = (k: MarkKind) => k === 'rng_nx' || k === 'rng_unk' || k === 'rng_to'
const hasN = (k: MarkKind) => k === 'pgg' || k === 'pog' || k === 'status_unknown'
export const isFetchPath = (p: DeliveryPath) =>
  p === 'fetch' || p === 'fetch_joining' || p === 'fill'

function quantum(us: number, t0: number): number {
  const q = Math.floor((us - t0) / DT_QUANTUM_US)
  if (q < INT32_MIN || q > INT32_MAX) throw new RangeError(`offset ${q} past Int32`)
  return q
}

export function encodeRuns(baseUs: number, runs: readonly RunInput[]): Uint8Array {
  const w = new LebWriter(runs.length * 24)
  const lastG = new Map<number, bigint>()
  let lastSid = 0n
  let lastT0 = Math.floor(baseUs)
  for (const r of runs) {
    const n = r.ids.length
    if (n < 1 || r.timesUs.length !== n) throw new RangeError('a run needs ids and times')
    const datagram = r.path === 'datagram'
    let xid = false
    for (let i = 1; i < n; i++) if (r.ids[i] !== (r.ids[i - 1] as bigint) + 1n) xid = true
    const end = r.end ?? (datagram ? 'na' : 'open')
    w.byte(
      (r.cont ? FL_CONT : 0) |
        (xid ? FL_XID : 0) |
        (r.fo ? FL_FO : 0) |
        (r.foKnown ? FL_FO_KNOWN : 0) |
        (r.eog ? FL_EOG : 0) |
        (RUN_ENDS.indexOf(end) << FL_END_SHIFT),
    )
    w.u(r.c)
    w.u(r.ti)
    w.z(r.g, lastG.get(r.ti) ?? 0n)
    lastG.set(r.ti, r.g)
    w.u(DELIVERY_PATHS.indexOf(r.path))
    if (!isFetchPath(r.path)) {
      if (r.sub === null || r.sub === undefined) w.u(0)
      else {
        w.u(1)
        w.u(r.sub)
      }
    }
    if (!datagram) {
      if (r.sid === undefined) throw new RangeError('a stream run needs its stream id')
      w.z(r.sid, lastSid)
      lastSid = r.sid
    }
    w.u(r.ids[0] as bigint)
    w.u(n)
    if (xid) {
      for (let i = 1; i < n; i++) {
        const id = r.ids[i] as bigint
        const prev = r.ids[i - 1] as bigint
        if (datagram) w.z(id, prev)
        else {
          if (id <= prev) throw new RangeError('stream ids must ascend in a run')
          w.u(id - prev - 1n)
        }
      }
    }
    if (isFetchPath(r.path)) {
      if (r.osub === undefined || r.osub.length !== n) {
        throw new RangeError('a fetch run needs a subgroup per object')
      }
      for (const s of r.osub) {
        if (s === null) w.u(0)
        else {
          w.u(1)
          w.u(s)
        }
      }
    }
    const t0 = Math.floor(r.timesUs[0] as number)
    w.t(t0 - lastT0)
    lastT0 = t0
    let q = 0
    for (let i = 1; i < n; i++) {
      const qi = quantum(Math.floor(r.timesUs[i] as number), t0)
      w.t(qi - q)
      q = qi
    }
    w.u(r.b)
    if (end === 'reset') w.u(r.rc ?? 0n)
    w.t(quantum(Math.floor(r.tlUs ?? (r.timesUs[n - 1] as number)), t0))
  }
  return w.bytes()
}

export function encodeMarks(baseUs: number, marks: readonly MarkInput[]): Uint8Array {
  const w = new LebWriter(marks.length * 12)
  let lastT = Math.floor(baseUs)
  for (const m of marks) {
    w.u(MARK_KINDS.indexOf(m.kind))
    w.u(m.c)
    w.u(m.ti)
    w.u(m.g)
    w.u(m.o)
    if (isRange(m.kind)) {
      w.u(m.g2 ?? 0n)
      w.u(m.o2 ?? 0n)
    }
    if (hasN(m.kind)) w.u(m.n ?? 0n)
    const t = Math.floor(m.tUs)
    w.t(t - lastT)
    lastT = t
    w.u(DELIVERY_PATHS.indexOf(m.path))
    if (m.path !== 'datagram') w.u(m.sid ?? 0n)
  }
  return w.bytes()
}

/** `run` and `mark` records: a descriptor with its rseq, then its raw columns. */
export function writeRunRecord(
  w: FrameWriter,
  rseq: number,
  baseUs: number,
  runs: readonly RunInput[],
): void {
  const raw = encodeRuns(baseUs, runs)
  w.json({ t: 'run', v: 2, n: runs.length, rseq } as unknown as EnvelopeRecord)
  w.raw(raw)
}

export function writeMarkRecord(
  w: FrameWriter,
  rseq: number,
  baseUs: number,
  marks: readonly MarkInput[],
): void {
  const raw = encodeMarks(baseUs, marks)
  w.json({ t: 'mark', v: 1, n: marks.length, rseq } as unknown as EnvelopeRecord)
  w.raw(raw)
}

/** Records `[first, first + n)` of the emitter's rseq. */
export type RseqRange = readonly [first: number, n: number]

export interface SealInterval {
  /** The emitter's body sequence, contiguous from 0. */
  readonly seq: number
  /** Device mono µs: the previous body's `throughUs`, exactly. */
  readonly fromUs: number
  readonly throughUs: number
  /** The seal interval in force, ms. */
  readonly ms: number
}

export interface ContractPreamble {
  /** The instance claim, as sent in `?i=`. */
  readonly i: string
  readonly em: readonly RseqRange[]
  readonly seal: SealInterval
}

/**
 * `em` from a body's rseqs: ascending ranges, adjacent ones merged. `rseqs`
 * may come in any order but holds each value once.
 */
export function rseqRanges(rseqs: readonly number[]): RseqRange[] {
  const sorted = [...rseqs].sort((a, b) => a - b)
  const out: [number, number][] = []
  for (const r of sorted) {
    const last = out[out.length - 1]
    if (last !== undefined && last[0] + last[1] === r) last[1] += 1
    else out.push([r, 1])
  }
  return out
}

/** Append the ranges `[first, first + n)` to `em`, merging an adjacent one. */
export function addRange(em: [number, number][], first: number, n: number): void {
  if (n < 1) return
  const last = em[em.length - 1]
  if (last !== undefined && last[0] + last[1] === first) last[1] += n
  else em.push([first, n])
}

/** The preamble frame: length prefix and JSON, never compressed. */
export function preambleFrame(p: ContractPreamble): Uint8Array {
  const w = new FrameWriter({ initialBytes: 256 })
  w.json({
    v: 2,
    i: p.i,
    em: p.em.map((r) => [r[0], r[1]]),
    seal: {
      seq: p.seal.seq,
      from_us: p.seal.fromUs,
      through_us: p.seal.throughUs,
      ms: p.seal.ms,
    },
  } as unknown as EnvelopeRecord)
  return w.take()
}

/** Bytes of the preamble frame at `at` in a v2 body, or -1 when there is none. */
export function preambleFrameLength(body: Uint8Array, at: number): number {
  if (body.byteLength < at + 4) return -1
  const view = new DataView(body.buffer, body.byteOffset + at, 4)
  const prefix = view.getUint32(0, false)
  if ((prefix & 0x8000_0000) !== 0) return -1
  const n = 4 + prefix
  return body.byteLength < at + n ? -1 : n
}

/** The body's clock: mono base and epoch, and this body's exchange sample when the epoch has one. */
export interface BodyClock {
  readonly baseUs: number
  readonly epoch: number
  readonly resUs: number
  readonly sample?: {
    readonly oUs: number
    readonly rUs: number
    readonly atUs: number
    readonly pop?: string
  }
}

/** One connection a body references: its per-emitter ordinal, negotiated draft and relay origin. */
export interface BodyConn {
  readonly c: number
  readonly draft: number
  readonly relay: string
}

/** One track a body references: its index in the body and the wire key. */
export interface BodyTrack {
  readonly id: number
  readonly key: {
    readonly d: 'tx' | 'rx'
    readonly k: 'alias' | 'fetch'
    readonly v: string
    readonly e: number
  }
}

export interface BodyTail {
  /** The emitter's last allocated rseq; absent before its first. */
  readonly lastRseq?: number
  readonly preDrop: { readonly records: number; readonly objects: number }
  /** Cumulative objects and payload bytes per connection ordinal. */
  readonly conn: readonly (readonly [c: number, objects: number, bytes: number])[]
}

export interface BatchV2 {
  readonly sessionId: string
  readonly instanceId: string
  readonly seq: number
  readonly idempotencyKey: string
  readonly final: boolean
  readonly lvl: string
  readonly clk: BodyClock
  readonly tail: BodyTail
  readonly conn: readonly BodyConn[]
  readonly trk: readonly BodyTrack[]
}

/** The batch record's JSON, fields in the order the reference writer puts them. */
export function batchJson(b: BatchV2): BatchRecord {
  const s = b.clk.sample
  return {
    t: 'batch',
    v: 2,
    sessionId: b.sessionId,
    instanceId: b.instanceId,
    seq: b.seq,
    idempotencyKey: b.idempotencyKey,
    final: b.final,
    lvl: b.lvl as BatchRecord['lvl'],
    clk: {
      base_us: b.clk.baseUs,
      epoch: b.clk.epoch,
      res_us: b.clk.resUs,
      ...(s === undefined
        ? {}
        : {
            o_us: s.oUs,
            r_us: s.rUs,
            at_us: s.atUs,
            ...(s.pop === undefined ? {} : { pop: s.pop }),
          }),
    },
    tail: {
      ...(b.tail.lastRseq === undefined ? {} : { last_rseq: b.tail.lastRseq }),
      pre_drop: { records: b.tail.preDrop.records, objects: b.tail.preDrop.objects },
      conn: b.tail.conn.map((e) => [e[0], e[1], e[2]]),
    },
    conn: b.conn.map((c) => ({ c: c.c, draft: c.draft, relay: c.relay })),
    trk: b.trk.map((t) => ({ id: t.id, key: { d: t.key.d, k: t.key.k, v: t.key.v, e: t.key.e } })),
  }
}

const RSEQ_PREFIX = new TextEncoder().encode(',"rseq":')

/**
 * A JSON frame's payload with `"rseq": n` added as its last field. The
 * payload is a JSON object with at least one field, as every record is.
 */
export function withRseq(payload: Uint8Array, rseq: number): Uint8Array {
  const digits = new TextEncoder().encode(String(rseq))
  const out = new Uint8Array(payload.byteLength + RSEQ_PREFIX.byteLength + digits.byteLength)
  out.set(payload.subarray(0, payload.byteLength - 1), 0)
  let at = payload.byteLength - 1
  out.set(RSEQ_PREFIX, at)
  at += RSEQ_PREFIX.byteLength
  out.set(digits, at)
  at += digits.byteLength
  out[at] = 0x7d
  return out
}

/** A whole v2 body: the header, the preamble frame, then `payload` as given. */
export function contractBody(
  preamble: Uint8Array,
  payload: Uint8Array,
  gzipped: boolean,
): Uint8Array {
  const out = new Uint8Array(8 + preamble.byteLength + payload.byteLength)
  out.set([0x4d, 0x51, 0x54, 0x43, CONTRACT_BODY_VERSION, gzipped ? 1 : 0, 0, 0], 0)
  out.set(preamble, 8)
  out.set(payload, 8 + preamble.byteLength)
  return out
}
