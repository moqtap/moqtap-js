/**
 * What a collector's rollups say about each track's delivery, on the trace's
 * clock.
 *
 * A collector trace carries each rollup as an Event 7 annotation labelled
 * `collector.rollup`. The times inside its data are the collector's monotonic
 * milliseconds from its own origin, not the trace's clock, so each segment's
 * offset between the two is read off its first rollup, whose record time is
 * its interval's end. A segment with no rollup borrows the offset of the last
 * one before it, which is the same page load whenever the segments are in
 * instance order.
 */

/** A histogram bucket index on the collector's duration ladder: `[2^i, 2^(i+1))` ms. */
export type Bucket = number

/** An annotation as `rollupDelivery` reads it. */
export interface RollupAnnotation {
  /** The trace segment it came in. */
  readonly segment: number
  /** Milliseconds from the session's start. */
  readonly atMs: number
  readonly label: string
  readonly data: unknown
  /** The connection the annotation names (`p`); absent or `''` for none. */
  readonly connection?: string | undefined
}

/** One track's delivery over the whole trace, on one connection, in one direction. */
export interface TrackDelivery {
  /** {@link deliveryKey} of the four fields below. */
  readonly key: string
  /** `''` when the rollup named no connection. */
  readonly connection: string
  /** `rx` received by the recorder, `tx` sent by it. */
  readonly direction: 'rx' | 'tx'
  /** `alias` for subgroup and datagram streams, `fetch` for a fetch's. */
  readonly kind: 'alias' | 'fetch'
  /** The track alias, or the fetch's request id, in decimal. */
  readonly id: string
  /** The first object, in milliseconds from the session's start. */
  readonly firstObjectMs?: number | undefined
  readonly objects: number
  readonly payloadBytes: number
  readonly groups: number
  readonly groupGaps: number
  /** Objects carrying a status rather than a payload: the publisher skipped them. */
  readonly skipped: number
  readonly stalls: number
  readonly longestStall: Bucket | null
  readonly cadenceP50: Bucket | null
  readonly cadenceP95: Bucket | null
  readonly arrivalP95: Bucket | null
  /** Send side only: time spent waiting for the transport to take more. */
  readonly blockedMs?: number | undefined
  /** Send side only, where the browser reports it: bytes the transport confirmed delivered. */
  readonly ackedBytes?: number | undefined
}

/** One rollup interval of one track. */
export interface DeliveryInterval {
  /** The track's {@link TrackDelivery.key}. */
  readonly key: string
  /** Milliseconds from the session's start. */
  readonly fromMs: number
  readonly toMs: number
  readonly objects: number
  readonly groupGaps: number
  readonly skipped: number
  readonly stalls: number
  readonly longestStall: Bucket | null
}

export interface RollupDelivery {
  /** In the order the rollups first report them. */
  readonly tracks: readonly TrackDelivery[]
  readonly intervals: readonly DeliveryInterval[]
  /**
   * Per segment, what to add to a collector monotonic time (ms) to place it
   * in milliseconds from the session's start. Absent for a segment before any
   * rollup.
   */
  readonly offsets: ReadonlyMap<number, number>
}

type Rec = Readonly<Record<string, unknown>>

function record(data: unknown): Rec | null {
  return data !== null && typeof data === 'object' && !Array.isArray(data) ? (data as Rec) : null
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function count(value: unknown): number {
  const n = finite(value)
  return n === null || n < 0 ? 0 : n
}

/** A track's key: the connection, then the collector's bucket key without its epoch. */
export function deliveryKey(
  connection: string,
  direction: string,
  kind: string,
  id: string,
): string {
  return `${connection}|${direction}:${kind}:${id}`
}

/** The bucket holding quantile `q` of a histogram's counts, or `null` when it is empty. */
export function quantileBucket(counts: readonly (number | undefined)[], q: number): Bucket | null {
  const total = counts.reduce<number>((sum, c) => sum + (c ?? 0), 0)
  if (total === 0) return null
  const target = Math.max(1, Math.ceil(q * total))
  let seen = 0
  for (let i = 0; i < counts.length; i += 1) {
    seen += counts[i] ?? 0
    if (seen >= target) return i
  }
  return counts.length - 1
}

/** The highest bucket with a count, or `null` when there is none. */
export function highestBucket(counts: readonly (number | undefined)[]): Bucket | null {
  for (let i = counts.length - 1; i >= 0; i -= 1) if ((counts[i] ?? 0) > 0) return i
  return null
}

interface Histogram {
  n: number
  counts: number[]
}

function emptyHistogram(): Histogram {
  return { n: 0, counts: [] }
}

/** Add a sparse wire histogram (`i` bucket indexes, `c` their counts, `n` the total). */
function addHistogram(into: Histogram, wire: unknown): void {
  const h = record(wire)
  if (h === null || !Array.isArray(h.i) || !Array.isArray(h.c)) return
  into.n += count(h.n)
  h.i.forEach((index, k) => {
    const i = finite(index)
    const c = finite((h.c as unknown[])[k])
    if (i === null || c === null || i < 0 || i > 64) return
    into.counts[i] = (into.counts[i] ?? 0) + c
  })
}

interface Builder {
  connection: string
  direction: 'rx' | 'tx'
  kind: 'alias' | 'fetch'
  id: string
  firstObjectMs?: number
  objects: number
  payloadBytes: number
  groups: number
  groupGaps: number
  skipped: number
  stall: Histogram
  cadence: Histogram
  arrival: Histogram
  blockedMs?: number
  ackedBytes?: number
}

const ROLLUP = 'collector.rollup'

/**
 * Each segment's offset from collector time to the session's clock, in the
 * order the annotations come: a segment's own first rollup, else the last
 * offset before it.
 */
function rollupOffsets(annotations: readonly RollupAnnotation[]): Map<number, number> {
  const own = new Map<number, number>()
  for (const { segment, atMs, label, data } of annotations) {
    if (label !== ROLLUP || own.has(segment)) continue
    const end = finite(record(data)?.endMono)
    if (end !== null) own.set(segment, atMs - end)
  }
  const offsets = new Map<number, number>()
  let last: number | undefined
  for (const { segment } of annotations) {
    if (offsets.has(segment)) continue
    const offset = own.get(segment) ?? last
    if (offset === undefined) continue
    offsets.set(segment, offset)
    last = offset
  }
  return offsets
}

/**
 * Each track's delivery, summed over every `collector.rollup` in
 * `annotations`, and each rollup interval of each track. `annotations` are in
 * trace order; other labels are passed over.
 */
export function rollupDelivery(annotations: readonly RollupAnnotation[]): RollupDelivery {
  const offsets = rollupOffsets(annotations)
  const builders = new Map<string, Builder>()
  const intervals: DeliveryInterval[] = []

  for (const { segment, label, data: raw, connection = '' } of annotations) {
    if (label !== ROLLUP) continue
    const data = record(raw)
    const offset = offsets.get(segment)
    if (data === null || offset === undefined) continue
    const start = finite(data.startMono)
    const end = finite(data.endMono)
    if (start === null || end === null || !Array.isArray(data.tracks)) continue

    for (const item of data.tracks) {
      const wire = record(item)
      const k = record(wire?.key)
      if (wire === null || k === null) continue
      const direction = k.d === 'tx' ? 'tx' : k.d === 'rx' ? 'rx' : null
      const kind = k.k === 'fetch' ? 'fetch' : k.k === 'alias' ? 'alias' : null
      const id = typeof k.v === 'string' ? k.v : null
      if (direction === null || kind === null || id === null) continue

      const key = deliveryKey(connection, direction, kind, id)
      let b = builders.get(key)
      if (b === undefined) {
        b = {
          connection,
          direction,
          kind,
          id,
          objects: 0,
          payloadBytes: 0,
          groups: 0,
          groupGaps: 0,
          skipped: 0,
          stall: emptyHistogram(),
          cadence: emptyHistogram(),
          arrival: emptyHistogram(),
        }
        builders.set(key, b)
      }
      const objects = count(wire.objects)
      const firstSeen = finite(wire.firstSeen)
      if (objects > 0 && firstSeen !== null) {
        const first = offset + firstSeen
        if (b.firstObjectMs === undefined || first < b.firstObjectMs) b.firstObjectMs = first
      }
      b.objects += objects
      b.payloadBytes += count(wire.payloadBytes)
      b.groups += count(wire.groups)
      b.groupGaps += count(wire.groupGaps)
      b.skipped += count(wire.statusObjects)
      if (wire.blockedMs !== undefined) b.blockedMs = (b.blockedMs ?? 0) + count(wire.blockedMs)
      if (wire.ackedBytes !== undefined) b.ackedBytes = (b.ackedBytes ?? 0) + count(wire.ackedBytes)
      const hist = record(wire.hist) ?? {}
      const stall = emptyHistogram()
      addHistogram(stall, hist.stallMs)
      addHistogram(b.stall, hist.stallMs)
      addHistogram(b.cadence, hist.groupCadenceMs)
      addHistogram(b.arrival, hist.interArrivalMs)

      intervals.push({
        key,
        fromMs: offset + start,
        toMs: offset + end,
        objects,
        groupGaps: count(wire.groupGaps),
        skipped: count(wire.statusObjects),
        stalls: stall.n,
        longestStall: highestBucket(stall.counts),
      })
    }
  }

  const tracks = [...builders.entries()].map(
    ([key, b]): TrackDelivery => ({
      key,
      connection: b.connection,
      direction: b.direction,
      kind: b.kind,
      id: b.id,
      ...(b.firstObjectMs === undefined ? {} : { firstObjectMs: b.firstObjectMs }),
      objects: b.objects,
      payloadBytes: b.payloadBytes,
      groups: b.groups,
      groupGaps: b.groupGaps,
      skipped: b.skipped,
      stalls: b.stall.n,
      longestStall: highestBucket(b.stall.counts),
      cadenceP50: quantileBucket(b.cadence.counts, 0.5),
      cadenceP95: quantileBucket(b.cadence.counts, 0.95),
      arrivalP95: quantileBucket(b.arrival.counts, 0.95),
      ...(b.blockedMs === undefined ? {} : { blockedMs: b.blockedMs }),
      ...(b.ackedBytes === undefined ? {} : { ackedBytes: b.ackedBytes }),
    }),
  )
  return { tracks, intervals, offsets }
}
