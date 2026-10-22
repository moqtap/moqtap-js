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

import type { BucketKey, DetailLevel, Mono, TriggerKind } from '../types.js'
import type { ConnectionSnapshot, RealmConfig } from './realm.js'

/** Namespaces every link message, so a customer's own traffic is never mistaken for one. */
export const HANDSHAKE = '__moqtap_collector__'

/**
 * The link protocol version. A page answers only its own version, so a probe
 * from another release stays unlinked and the page reports the link as
 * `timeout` rather than mixing two record formats in one session.
 */
export const LINK_VERSION = 3

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
   */
  readonly base: Mono
  readonly level: DetailLevel
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
  /** The frames in the order they were written. Absent on a heartbeat. */
  readonly parts?: readonly ForwardPart[]
  /** How many frames `parts` holds in all. */
  readonly n: number
  /** Records the probe dropped so far, cumulative. */
  readonly dropped: number
  /** A connection's draft is known: the page's first upload is worth making. */
  readonly ready: boolean
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

export type ProbeMessage = ForwardMessage | CallMessage

/** Page → probe over the private channel. */
export type PageMessage =
  | { readonly t: 'level'; readonly level: DetailLevel }
  /** Forward now: the page is about to seal. */
  | { readonly t: 'forward' }
  /** This instance has ended. The probe stops observing. */
  | { readonly t: 'unlinked' }
  /**
   * The page started a new session. The probe reports into it from now on,
   * its open connections included. The clock base is unchanged: a page keeps
   * one timeline across its sessions.
   */
  | {
      readonly t: 'session'
      readonly sessionId: string
      readonly instanceId: string
      readonly level: DetailLevel
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
