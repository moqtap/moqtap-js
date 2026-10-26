/**
 * What a collector's own records say about delivery, placed on the trace's
 * clock: its 10 s rollup intervals per track, the object-level flight dumps,
 * the windows in which it raised its detail, and the player's annotations.
 *
 * A collector trace carries these as Event 7 annotations (`collector.rollup`,
 * `collector.flight`, `collector.escalation`, and the customer's own labels).
 * Their times inside the data are the collector's monotonic milliseconds from
 * its session origin, not the trace's clock; `rollupDelivery` from
 * `@moqtap/inspect` sums the rollups and places each segment on the trace's
 * clock, and the flight dumps here use the same offsets.
 *
 * The connection is the event's (`p`), which the trace takes from the
 * record's own. Framework-free, like `analysis.ts`: this runs in the worker.
 */

import { type Bucket, deliveryKey, rollupDelivery } from '@moqtap/inspect'
import type { AnnotationEvent } from '@moqtap/trace'

export type { Bucket }

/** One track's delivery as the rollups report it, on one connection and in one direction. */
export interface DeliveryStats {
  /** `rx` received by the recorder, `tx` sent by it. */
  readonly direction: 'rx' | 'tx'
  /** `alias` for subgroup and datagram streams, `fetch` for a fetch's. */
  readonly kind: 'alias' | 'fetch'
  /** The track alias, or the fetch's request id, in decimal. */
  readonly id: string
  /** The first object, in microseconds from the session's start. */
  readonly firstObjectAt?: number | undefined
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

/** One rollup interval of one track: a cell on its lane. */
export interface Cell {
  readonly lane: string
  /** Microseconds from the session's start. */
  readonly from: number
  readonly to: number
  readonly objects: number
  readonly groupGaps: number
  readonly skipped: number
  readonly stalls: number
  readonly longestStall: Bucket | null
}

/** Object-level detail from one flight dump, inside its own window. */
export interface Flight {
  readonly connection: string
  readonly trigger: string
  readonly from: number
  readonly to: number
  /**
   * The dump does not hold every object its trigger asked for: the ring had
   * overwritten the start, the collector left the oldest out to keep the dump
   * within its budget, or a slice of the dump never arrived.
   */
  readonly truncated: boolean
  readonly objects: readonly { readonly lane: string; readonly at: number }[]
  /** Gaps between arrivals long enough to count as stalls, exactly placed. */
  readonly stalls: readonly { readonly lane: string; readonly from: number; readonly to: number }[]
}

/** A stretch of the session recorded above the baseline detail level. */
export interface Band {
  readonly from: number
  /** `null` while still raised when the trace ends. */
  readonly to: number | null
  readonly level: string
  /** What raised it: a trigger's name, `escalate()`, or `null` when not said. */
  readonly cause: string | null
}

/** An annotation the player made through `annotate()`. */
export interface PlayerEvent {
  readonly at: number
  readonly label: string
  readonly connection?: string | undefined
  /** Its data as JSON, cut short; absent when it carried none or it was redacted. */
  readonly data?: string | undefined
}

/** One lane of the timeline: a track on a connection, in one direction. */
export interface Lane {
  readonly key: string
  readonly connection: string
  readonly stats: DeliveryStats
}

export interface Delivery {
  readonly lanes: readonly Lane[]
  readonly cells: readonly Cell[]
  readonly flights: readonly Flight[]
  readonly bands: readonly Band[]
  readonly playerEvents: readonly PlayerEvent[]
}

/** An annotation placed on the trace's clock, with the segment it came in. */
export interface PlacedAnnotation {
  readonly segment: number
  readonly at: number
  readonly event: AnnotationEvent
}

const LEVELS = ['baseline', 'headers', 'headers+sizes', 'headers+data']

/**
 * The collector's stall rule, used to place stalls exactly inside a flight
 * dump: a gap longer than three times the track's median inter-arrival time,
 * and never under 100 ms. The rollups count stalls by the same rule, so the
 * two views agree.
 */
const STALL_MULTIPLE = 3
const STALL_FLOOR_MS = 100

const PLAYER_DATA_LIMIT = 200

type Rec = Readonly<Record<string, unknown>>

function record(data: unknown): Rec | null {
  return data !== null && typeof data === 'object' && !Array.isArray(data) ? (data as Rec) : null
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** A lane's key: the connection, then the bucket key without its epoch. */
export const laneKey = deliveryKey

/** `rx:alias:9:0` (the collector's bucket key string) as a lane key on `connection`. */
function laneOfKeyString(connection: string, key: string): string | null {
  const parts = key.split(':')
  if (parts.length < 3) return null
  return laneKey(connection, parts[0]!, parts[1]!, parts[2]!)
}

/** Milliseconds on the session clock as the viewer's microseconds. */
const us = (ms: number): number => ms * 1000

/**
 * The delivery a collector trace records. `annotations` are in trace order;
 * `connectionOf` names each one's connection (`''` for none).
 */
export function delivery(
  annotations: readonly PlacedAnnotation[],
  connectionOf: (event: AnnotationEvent) => string,
): Delivery {
  const rolled = rollupDelivery(
    annotations.map(({ segment, at, event }) => ({
      segment,
      atMs: at / 1000,
      label: event.label,
      data: event.data,
      connection: connectionOf(event),
    })),
  )

  const lanes: Lane[] = rolled.tracks.map(({ key, connection, firstObjectMs, ...stats }) => ({
    key,
    connection,
    stats: {
      ...stats,
      ...(firstObjectMs === undefined ? {} : { firstObjectAt: us(firstObjectMs) }),
    },
  }))
  const cells: Cell[] = rolled.intervals.map(({ key, fromMs, toMs, ...rest }) => ({
    lane: key,
    from: us(fromMs),
    to: us(toMs),
    ...rest,
  }))

  const dumps = new Map<string, { connection: string; pieces: FlightPiece[] }>()
  const bands: {
    from: number
    to: number | null
    level: string
    cause: string | null
    floor: number
  }[] = []
  const playerEvents: PlayerEvent[] = []

  for (const { segment, at, event } of annotations) {
    const data = record(event.data)
    const connection = connectionOf(event)
    const offset = rolled.offsets.get(segment)

    if (event.label === 'collector.flight' && data !== null) {
      const piece = { data, at, base: offset === undefined ? undefined : us(offset) }
      const id = dumpId(data, at, connection, dumps.size)
      const dump = dumps.get(id)
      if (dump === undefined) dumps.set(id, { connection, pieces: [piece] })
      else dump.pieces.push(piece)
    } else if (event.label === 'collector.escalation' && data !== null) {
      escalation(data, at)
    } else if (!event.label.startsWith('collector.') && !event.label.startsWith('insight.')) {
      const json = event.data === null || event.data === undefined ? '' : JSON.stringify(event.data)
      playerEvents.push({
        at,
        label: event.label,
        ...(connection === '' ? {} : { connection }),
        ...(json === undefined || json.length === 0
          ? {}
          : {
              data: json.length > PLAYER_DATA_LIMIT ? `${json.slice(0, PLAYER_DATA_LIMIT)}…` : json,
            }),
      })
    }
  }

  function escalation(data: Rec, at: number) {
    const from = LEVELS.indexOf(String(data.from))
    const to = LEVELS.indexOf(String(data.to))
    if (from < 0 || to < 0) return
    const open = bands.at(-1)
    const raised = open !== undefined && open.to === null ? open : undefined
    if (to > from) {
      if (raised === undefined) {
        bands.push({ from: at, to: null, level: LEVELS[to]!, cause: causeOf(data.by), floor: from })
      } else if (to > LEVELS.indexOf(raised.level)) {
        raised.level = LEVELS[to]!
      }
    } else if (raised !== undefined && to <= raised.floor) {
      raised.to = at
    }
  }

  const flights: Flight[] = []
  for (const { connection, pieces } of dumps.values()) {
    const flight = flightDump(pieces, connection)
    if (flight !== null) flights.push(flight)
  }

  return {
    lanes,
    cells,
    flights,
    bands: bands.map(({ floor: _floor, ...band }) => band),
    playerEvents,
  }
}

function causeOf(by: unknown): string | null {
  const cause = record(by)
  if (cause === null) return null
  if (cause.kind === 'trigger' && typeof cause.trigger === 'string') {
    return cause.trigger === 'trackSwitch' ? 'track switch' : cause.trigger
  }
  if (cause.kind === 'manual') return 'escalate()'
  return null
}

/** One `collector.flight` record: a whole dump, or one slice of one. */
interface FlightPiece {
  readonly data: Rec
  readonly at: number
  readonly base: number | undefined
}

/**
 * Which dump a record belongs to. The slices of one dump share its
 * connection, dump number, end, trigger and slice count; the trace keeps no
 * `ts` in a record's data, so a slice without a dump number falls back on its
 * event time. A record without a slice count is a dump of its own, `n` apart
 * from every other.
 */
function dumpId(data: Rec, at: number, connection: string, n: number): string {
  const parts = finite(data.parts)
  if (parts === null || parts < 2 || finite(data.part) === null) {
    return JSON.stringify(['whole', connection, n])
  }
  return JSON.stringify([
    'sliced',
    connection,
    finite(data.dump) ?? `at:${at}`,
    finite(data.dumpEnd),
    String(data.trigger),
    parts,
  ])
}

/**
 * A flight dump's objects, and the stalls between them, on the trace's clock.
 * Without a rollup to set the clock by, the dump's own record time stands in
 * for the end of its whole window, which is when the trigger fired: a sliced
 * dump's `dumpEnd`, or a whole one's `windowEnd`. Only the last slice's own
 * `windowEnd` is that end, so a sliced dump that says neither and lost its
 * last slice has nothing to place it by and is left out.
 *
 * A dump sent in slices is put back together first, in slice order: a lane's
 * median and its gaps are the whole dump's, so a stall across the edge of two
 * slices is found, and the window runs from the first slice's start to the
 * last one's end. Across a slice that never arrived there is no telling a
 * stall from the missing objects, so no gap across it counts as one.
 */
function flightDump(pieces: readonly FlightPiece[], connection: string): Flight | null {
  const byPart = new Map<number, FlightPiece>()
  for (const piece of pieces) {
    const part = finite(piece.data.part) ?? 0
    if (!byPart.has(part)) byPart.set(part, piece)
  }
  const ordered = [...byPart].sort(([a], [b]) => a - b)
  const first = ordered[0]
  const last = ordered.at(-1)
  if (first === undefined || last === undefined) return null
  const parts = finite(first[1].data.parts)
  const sliced = parts !== null && parts >= 2
  const hasLast = !sliced || last[0] === parts - 1
  const windowStart = finite(first[1].data.windowStart)
  const lastEnd = finite(last[1].data.windowEnd)
  const end =
    (sliced ? ordered.map(([, p]) => finite(p.data.dumpEnd)).find((e) => e !== null) : null) ??
    (hasLast ? lastEnd : null)
  if (windowStart === null || lastEnd === null) return null
  const base = ordered.find(([, p]) => p.base !== undefined)?.[1].base
  const offset = base ?? (end === null ? null : last[1].at - end * 1000)
  if (offset === null) return null
  const windowEnd = end ?? lastEnd

  let truncated = sliced && (first[0] !== 0 || !hasLast)
  const byLane = new Map<string, { t: number; run: number }[]>()
  const objects: { lane: string; at: number }[] = []
  let run = 0
  let previous = first[0]
  for (const [part, { data }] of ordered) {
    // Slices that follow one another without a hole are one run.
    if (part > previous + 1) {
      run += 1
      truncated = true
    }
    previous = part
    if (data.truncated === true) truncated = true
    const cols = record(data.cols)
    if (cols === null) continue
    const keys = Array.isArray(cols.key) ? cols.key : []
    const times = Array.isArray(cols.at) ? cols.at : []
    keys.forEach((key, i) => {
      const t = finite(times[i])
      const lane = typeof key === 'string' ? laneOfKeyString(connection, key) : null
      if (t === null || lane === null) return
      objects.push({ lane, at: offset + t * 1000 })
      const list = byLane.get(lane) ?? []
      list.push({ t, run })
      byLane.set(lane, list)
    })
  }

  const stalls: { lane: string; from: number; to: number }[] = []
  for (const [lane, list] of byLane) {
    list.sort((a, b) => a.t - b.t)
    const gaps: { from: number; to: number }[] = []
    for (let i = 1; i < list.length; i++) {
      const a = list[i - 1]!
      const b = list[i]!
      if (a.run === b.run) gaps.push({ from: a.t, to: b.t })
    }
    if (gaps.length === 0) continue
    const sorted = gaps.map((g) => g.to - g.from).sort((a, b) => a - b)
    const median = sorted[Math.floor(sorted.length / 2)]!
    const limit = Math.max(STALL_FLOOR_MS, median * STALL_MULTIPLE)
    for (const { from, to } of gaps) {
      if (to - from > limit)
        stalls.push({ lane, from: offset + from * 1000, to: offset + to * 1000 })
    }
  }

  return {
    connection,
    trigger: typeof first[1].data.trigger === 'string' ? first[1].data.trigger : '',
    from: offset + windowStart * 1000,
    to: offset + windowEnd * 1000,
    truncated,
    objects,
    stalls,
  }
}
