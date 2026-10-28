/**
 * The page–worker link: the messages a page and the probes it links exchange.
 *
 * The handshake is two messages over the channel the customer named: the
 * worker's `hello` and the page's `linked`. `linked` carries a `MessagePort`,
 * and everything after it travels over that private channel, so the customer's
 * own `onmessage` handlers see two messages per worker and never the stream of
 * forwards.
 *
 * No credential crosses the link. A probe makes no network request; the page
 * uploads its records in the page's own stream.
 */

import type { BucketKey, DetailLevel, Mono, RollupRecord, TriggerKind } from '../types.js'
import type { ConnectionSnapshot, RealmConfig } from './realm.js'

/** Namespaces every link message, so a customer's own traffic is never mistaken for one. */
export const HANDSHAKE = '__moqtap_collector__'

/**
 * The link protocol version. A page answers only its own version, so a probe
 * from another release stays unlinked and the page reports the link as
 * `timeout` rather than mixing two record formats in one session.
 */
export const LINK_VERSION = 5

/**
 * How often a probe hands its records to the page, in ms. Fixed rather than
 * configured: it bounds what a terminated worker can lose, and nothing about a
 * deployment changes the right answer.
 */
export const FORWARD_INTERVAL_MS = 250

/** How often an idle probe says it is still there. */
export const HEARTBEAT_MS = 1_000

/**
 * Silence after which the page counts a linked worker as gone. Long, so a
 * worker busy in a long synchronous task is not declared gone; when it speaks
 * again, its connections simply continue.
 */
export const SILENCE_MS = 10_000

/** Everything the probe needs from its page, and nothing that lets it upload. */
export interface LinkedMessage {
  readonly t: 'linked'
  readonly sessionId: string
  readonly instanceId: string
  /**
   * Subtract from the worker's `performance.now()` to get a page
   * session-relative time: `page.timeOrigin + anchor.originMono -
   * worker.timeOrigin`. The page computes it from the worker's hello, so every
   * record the probe writes is already on the page's timeline.
   *
   * Absent while the page's session has not begun: the probe records nothing
   * and says `open` when this worker constructs a `WebTransport`.
   */
  readonly base?: Mono | undefined
  readonly level: DetailLevel
  /** Present while the page refuses every raise; see {@link PageMessage}'s `level`. */
  readonly capped?: true
  /** The outbox room this probe's flight dumps may take; see {@link PageMessage}'s `room`. */
  readonly room: number
  readonly config: RealmConfig
}

/** Whole frames, transferred as they are. The page appends them to its open body. */
export interface FramesPart {
  readonly frames: ArrayBuffer
  readonly byteLength: number
  /** How many frames. */
  readonly n: number
}

/**
 * Whole frames the probe compressed, transferred: the deflate data of one gzip
 * member, with its trailer's CRC-32 and length. The page seals them as the end
 * of a body of their own and never inflates them.
 */
export interface DeflatePart {
  readonly deflate: ArrayBuffer
  readonly byteLength: number
  readonly crc: number
  /** Uncompressed length. */
  readonly size: number
  /** How many frames. */
  readonly n: number
}

export type ForwardPart = FramesPart | DeflatePart

/** Probe → page, every forward interval with records or every heartbeat without. */
export interface ForwardMessage {
  readonly t: 'fwd'
  /** Counts this probe's forwards from 1, so the page can say which it has taken in. */
  readonly seq: number
  /** The frames in the order they were written. Absent on a heartbeat. */
  readonly parts?: readonly ForwardPart[]
  /** How many frames `parts` holds in all. */
  readonly n: number
  /** Records the probe dropped so far, cumulative. */
  readonly dropped: number
  /** A connection's draft is known: the page's first upload is worth making. */
  readonly ready: boolean
  /**
   * The rollup intervals the probe's connections closed since the last
   * forward, in order, apart from the frames. The page writes them, less what
   * it already wrote of one for a worker it counted gone. Absent when none.
   */
  readonly rollups?: readonly RollupRecord[]
  readonly conns: readonly ConnectionSnapshot[]
}

/** Probe → page: a verb the probe forwards rather than performs. */
export type CallMessage =
  | {
      readonly t: 'annotate'
      readonly name: string
      readonly data: unknown
      readonly conn?: string
    }
  | {
      readonly t: 'observe'
      readonly name: string
      readonly value: number
      readonly labels?: Record<string, string>
    }
  | { readonly t: 'escalate'; readonly level: DetailLevel; readonly reason?: string }
  | { readonly t: 'resolve'; readonly reason?: string }
  | {
      readonly t: 'trigger'
      readonly kind: TriggerKind
      /** Session-relative. */
      readonly at: Mono
      readonly key?: BucketKey
    }
  | { readonly t: 'overrun'; readonly at: Mono; readonly signal: string }
  /** This worker constructed a `WebTransport`: the page's session begins. */
  | { readonly t: 'open' }

export type ProbeMessage = ForwardMessage | CallMessage

/** Page → probe over the private channel. */
export type PageMessage =
  /**
   * The page's level. `capped` is present while the page refuses every raise,
   * under a hold or past the ceiling: a probe raises its own level on a trigger
   * before the page answers, and only while it is absent. Sent again after
   * every trigger a probe reports, so a probe that raised on a trigger the page
   * refused returns to the page's level.
   */
  | { readonly t: 'level'; readonly level: DetailLevel; readonly capped?: true }
  /**
   * Bytes of bodies the page's outbox can take for this probe's flight dumps
   * without pushing out a body it holds, as of every forward up to `upTo`.
   * Sent after each forward and whenever the outbox grows; a probe counts
   * what it forwarded after `upTo` against it.
   */
  | { readonly t: 'room'; readonly bytes: number; readonly upTo: number }
  /** Forward now: the page is about to seal. */
  | { readonly t: 'forward' }
  /** This instance has ended. The probe stops observing. */
  | { readonly t: 'unlinked' }
  /**
   * The page's session changed. With `base`, the probe records into it from
   * now on, its open connections included. Without, the session has not begun
   * and the probe records nothing until this worker constructs a
   * `WebTransport`, as after `linked` without one.
   */
  | {
      readonly t: 'session'
      readonly sessionId: string
      readonly instanceId: string
      readonly level: DetailLevel
      readonly capped?: true
      readonly base?: Mono | undefined
    }
  /** Context for connections opened from now on. */
  | { readonly t: 'context'; readonly contentId: string }

/** A message in the link's namespace, or `null`. */
export function linkMessage(data: unknown): (Record<string, unknown> & { t: string }) | null {
  if (typeof data !== 'object' || data === null) return null
  const d = data as Record<string, unknown>
  return d[HANDSHAKE] === LINK_VERSION && typeof d.t === 'string'
    ? (d as Record<string, unknown> & { t: string })
    : null
}

/** Wrap `m` in the link's namespace. */
export function envelope<T extends object>(m: T): T & { [HANDSHAKE]: number } {
  return { [HANDSHAKE]: LINK_VERSION, ...m }
}
