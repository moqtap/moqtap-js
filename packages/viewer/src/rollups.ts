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
  /** The window's start was already overwritten when it was dumped. */
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

  const flights: Flight[] = []
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
      const flight = flightDump(data, connection, at, offset === undefined ? undefined : us(offset))
      if (flight !== null) flights.push(flight)
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

/**
 * A flight dump's objects, and the stalls between them, on the trace's clock.
 * Without a rollup to set the clock by, the dump's own record time stands in
 * for its window's end, which is when the trigger fired.
 */
function flightDump(
  data: Rec,
  connection: string,
  at: number,
  base: number | undefined,
): Flight | null {
  const windowStart = finite(data.windowStart)
  const windowEnd = finite(data.windowEnd)
  const cols = record(data.cols)
  if (windowStart === null || windowEnd === null || cols === null) return null
  const offset = base ?? at - windowEnd * 1000
  const keys = Array.isArray(cols.key) ? cols.key : []
  const times = Array.isArray(cols.at) ? cols.at : []

  const byLane = new Map<string, number[]>()
  const objects: { lane: string; at: number }[] = []
  keys.forEach((key, i) => {
    const t = finite(times[i])
    const lane = typeof key === 'string' ? laneOfKeyString(connection, key) : null
    if (t === null || lane === null) return
    const placed = offset + t * 1000
    objects.push({ lane, at: placed })
    const list = byLane.get(lane) ?? []
    list.push(t)
    byLane.set(lane, list)
  })

  const stalls: { lane: string; from: number; to: number }[] = []
  for (const [lane, list] of byLane) {
    list.sort((a, b) => a - b)
    const gaps = list.slice(1).map((t, i) => t - list[i]!)
    if (gaps.length === 0) continue
    const sorted = [...gaps].sort((a, b) => a - b)
    const median = sorted[Math.floor(sorted.length / 2)]!
    const limit = Math.max(STALL_FLOOR_MS, median * STALL_MULTIPLE)
    gaps.forEach((gap, i) => {
      if (gap > limit) {
        stalls.push({ lane, from: offset + list[i]! * 1000, to: offset + list[i + 1]! * 1000 })
      }
    })
  }

  return {
    connection,
    trigger: typeof data.trigger === 'string' ? data.trigger : '',
    from: offset + windowStart * 1000,
    to: offset + windowEnd * 1000,
    truncated: data.truncated === true,
    objects,
    stalls,
  }
}
