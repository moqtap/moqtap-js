/**
 * The `run`, `mark` and `stream-end` records of an uploaded body, decoded the
 * way ingest decodes them: an independent reader for the suite, so a test can
 * say how many objects arrived without trusting the writer it checks.
 */

import { DELIVERY_PATHS, MARK_KINDS, RUN_ENDS, STREAM_END_KINDS } from '../../envelope/contract.js'
import { BODY_PREAMBLE_BYTES, readFrames, readPreamble } from '../../envelope/index.js'
import { afterPreamble } from './uploads.js'

export interface DecodedRun {
  readonly cont: boolean
  readonly fo: boolean
  readonly foKnown: boolean
  readonly eog: boolean
  readonly end: (typeof RUN_ENDS)[number]
  readonly c: number
  readonly ti: number
  readonly g: bigint
  readonly path: (typeof DELIVERY_PATHS)[number]
  readonly sub: bigint | null
  readonly sid: bigint | null
  readonly ids: bigint[]
  readonly osub: (bigint | null)[] | null
  readonly t0Us: number
  readonly dt: number[]
  readonly b: number
  readonly rc: bigint | null
  readonly tl: number
}

export interface DecodedMark {
  readonly kind: (typeof MARK_KINDS)[number]
  readonly c: number
  readonly ti: number
  readonly g: bigint
  readonly o: bigint
  readonly g2: bigint | null
  readonly o2: bigint | null
  readonly n: bigint | null
  readonly tUs: number
  readonly path: (typeof DELIVERY_PATHS)[number]
  readonly sid: bigint | null
}

export interface DecodedEnd {
  readonly eog: boolean
  readonly end: (typeof STREAM_END_KINDS)[number]
  readonly c: number
  readonly ti: number
  readonly path: (typeof DELIVERY_PATHS)[number]
  readonly sid: bigint
  readonly g: bigint | null
  readonly o: bigint | null
  readonly tUs: number
  readonly rc: bigint | null
}

class Reader {
  private at = 0
  constructor(private readonly b: Uint8Array) {}
  get done(): boolean {
    return this.at === this.b.length
  }
  byte(): number {
    const v = this.b[this.at++]
    if (v === undefined) throw new RangeError('truncated')
    return v
  }
  big(): bigint {
    let v = 0n
    let shift = 0n
    for (;;) {
      const x = this.byte()
      v |= BigInt(x & 0x7f) << shift
      if ((x & 0x80) === 0) return v
      shift += 7n
    }
  }
  u(): number {
    return Number(this.big())
  }
  /** Zigzag. */
  t(): number {
    const v = this.big()
    return Number((v & 1n) === 0n ? v >> 1n : -((v + 1n) >> 1n))
  }
  z(from: bigint): bigint {
    const v = this.big()
    const d = (v & 1n) === 0n ? v >> 1n : -((v + 1n) >> 1n)
    return (from + d) & ((1n << 64n) - 1n)
  }
}

const isFetch = (p: string) =>
  p === 'fetch' || p === 'fetch_joining' || p === 'fill' || p === 'fetch_unseen'

export function decodeRuns(raw: Uint8Array, n: number, baseUs: number): DecodedRun[] {
  const rd = new Reader(raw)
  const lastG = new Map<number, bigint>()
  let lastSid = 0n
  let lastT0 = baseUs
  const out: DecodedRun[] = []
  for (let j = 0; j < n; j++) {
    const fl = rd.byte()
    const c = rd.u()
    const ti = rd.u()
    const g = rd.z(lastG.get(ti) ?? 0n)
    lastG.set(ti, g)
    const path = DELIVERY_PATHS[rd.u()]!
    let sub: bigint | null = null
    if (!isFetch(path)) {
      if (rd.u() === 1) sub = rd.big()
    }
    let sid: bigint | null = null
    if (path !== 'datagram') {
      sid = rd.z(lastSid)
      lastSid = sid
    }
    const o0 = rd.big()
    const count = rd.u()
    const ids = [o0]
    for (let i = 1; i < count; i++) {
      const prev = ids[i - 1]!
      if ((fl & 0x02) === 0) ids.push(prev + 1n)
      else ids.push(path === 'datagram' ? rd.z(prev) : prev + rd.big() + 1n)
    }
    let osub: (bigint | null)[] | null = null
    if (isFetch(path)) {
      osub = []
      for (let i = 0; i < count; i++) osub.push(rd.u() === 1 ? rd.big() : null)
    }
    const t0Us = lastT0 + rd.t()
    lastT0 = t0Us
    const dt: number[] = []
    for (let i = 1; i < count; i++) dt.push(rd.t())
    const b = rd.u()
    const end = RUN_ENDS[(fl >> 5) & 3]!
    const rc = end === 'reset' ? rd.big() : null
    const tl = rd.t()
    out.push({
      cont: (fl & 0x01) !== 0,
      fo: (fl & 0x04) !== 0,
      foKnown: (fl & 0x08) !== 0,
      eog: (fl & 0x10) !== 0,
      end,
      c,
      ti,
      g,
      path,
      sub,
      sid,
      ids,
      osub,
      t0Us,
      dt,
      b,
      rc,
      tl,
    })
  }
  if (!rd.done) throw new RangeError('bytes after the runs')
  return out
}

export function decodeMarks(raw: Uint8Array, n: number, baseUs: number): DecodedMark[] {
  const rd = new Reader(raw)
  let lastT = baseUs
  const out: DecodedMark[] = []
  for (let j = 0; j < n; j++) {
    const kind = MARK_KINDS[rd.u()]!
    const c = rd.u()
    const ti = rd.u()
    const g = rd.big()
    const o = rd.big()
    const range =
      kind === 'rng_nx' || kind === 'rng_unk' || kind === 'rng_to' || kind === 'rng_gone'
    const g2 = range ? rd.big() : null
    const o2 = range ? rd.big() : null
    const hasN = range || kind === 'pgg' || kind === 'pog' || kind === 'status_unknown'
    const nn = hasN ? rd.big() : null
    const tUs = lastT + rd.t()
    lastT = tUs
    const path = DELIVERY_PATHS[rd.u()]!
    const sid = path === 'datagram' ? null : rd.big()
    out.push({ kind, c, ti, g, o, g2, o2, n: nn, tUs, path, sid })
  }
  if (!rd.done) throw new RangeError('bytes after the marks')
  return out
}

export function decodeEnds(raw: Uint8Array, n: number, baseUs: number): DecodedEnd[] {
  const rd = new Reader(raw)
  let lastT = baseUs
  const out: DecodedEnd[] = []
  for (let j = 0; j < n; j++) {
    const fl = rd.byte()
    const end = STREAM_END_KINDS[(fl >> 3) & 3]!
    const c = rd.u()
    const ti = rd.u()
    const path = DELIVERY_PATHS[rd.u()]!
    const sid = rd.big()
    const g = (fl & 0x02) !== 0 ? rd.big() : null
    const o = (fl & 0x04) !== 0 ? rd.big() : null
    const tUs = lastT + rd.t()
    lastT = tUs
    const rc = end === 'reset' ? rd.big() : null
    out.push({ eog: (fl & 0x01) !== 0, end, c, ti, path, sid, g, o, tUs, rc })
  }
  if (!rd.done) throw new RangeError('bytes after the stream ends')
  return out
}

export interface BodyFacts {
  readonly trk: readonly { id: number; key: { d: string; k: string; v: string; e: number } }[]
  readonly runs: DecodedRun[]
  readonly marks: DecodedMark[]
  readonly ends: DecodedEnd[]
}

async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream('gzip')
  const out = new Response(new Blob([bytes as unknown as BlobPart]).stream().pipeThrough(ds))
  return new Uint8Array(await out.arrayBuffer())
}

/** The runs and marks of one v2 body, and the tracks they index. */
export async function factsOf(body: Uint8Array): Promise<BodyFacts> {
  const pre = readPreamble(body)
  if (pre === null || body.length < BODY_PREAMBLE_BYTES) throw new Error('not a body')
  let frames = afterPreamble(body)
  if (pre.gzipped) frames = await inflate(frames)
  const decoder = new TextDecoder()
  const list = [...readFrames(frames)]
  const batch = JSON.parse(decoder.decode(list[0]!.payload)) as {
    clk: { base_us: number }
    trk: BodyFacts['trk']
  }
  const runs: DecodedRun[] = []
  const marks: DecodedMark[] = []
  const ends: DecodedEnd[] = []
  for (let i = 1; i < list.length; i++) {
    const f = list[i]!
    if (f.raw) continue
    const r = JSON.parse(decoder.decode(f.payload)) as { t: string; n: number }
    const raw = list[i + 1]
    if (r.t === 'run') runs.push(...decodeRuns(raw!.payload, r.n, batch.clk.base_us))
    if (r.t === 'mark') marks.push(...decodeMarks(raw!.payload, r.n, batch.clk.base_us))
    if (r.t === 'stream-end') ends.push(...decodeEnds(raw!.payload, r.n, batch.clk.base_us))
  }
  return { trk: batch.trk, runs, marks, ends }
}

/** Every run and mark in every body, with each run's track key resolved. */
export async function allFacts(bodies: readonly Uint8Array[]): Promise<{
  runs: (DecodedRun & { key: string })[]
  marks: (DecodedMark & { key: string })[]
  ends: (DecodedEnd & { key: string })[]
}> {
  const runs: (DecodedRun & { key: string })[] = []
  const marks: (DecodedMark & { key: string })[] = []
  const ends: (DecodedEnd & { key: string })[] = []
  for (const body of bodies) {
    const f = await factsOf(body)
    const keyOf = (ti: number) => {
      const k = f.trk.find((t) => t.id === ti)!.key
      return `${k.d}:${k.k}:${k.v}:${k.e}`
    }
    for (const r of f.runs) runs.push({ ...r, key: keyOf(r.ti) })
    for (const m of f.marks) marks.push({ ...m, key: keyOf(m.ti) })
    for (const e of f.ends) ends.push({ ...e, key: keyOf(e.ti) })
  }
  return { runs, marks, ends }
}
