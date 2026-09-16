/**
 * The bucket keys — the whole of the client's track state, and nothing else.
 *
 * The key is **the number already on the wire**: `trackAlias` for a subgroup
 * stream or a datagram, `requestId` for a fetch stream, tagged with the seam's
 * direction and with an alias *epoch*. No track name, namespace, status, reason
 * phrase or lifecycle timestamp is read here or kept anywhere on the device;
 * ingest joins those from the raw control bytes the baseline already ships.
 *
 * The epoch exists because alias uniqueness is weak: draft-20 forbids only
 * *simultaneous* reuse — "The same Track Alias MUST NOT be used by a publisher
 * to refer to two different Tracks simultaneously in the same session" — and
 * explicitly permits sequential rebinding once the prior subscription "has been
 * completely closed" (`.draft20-work/draft-20.clean.txt`). Two tracks summed
 * into one interval row under one raw alias are unrecoverable at ingest, and the
 * same mixing poisons the per-track median.
 *
 * Not `TrackRegistry`: it keys on requestId and stores `trackAlias` as a mutable
 * *field* (`extension/src/codec/track-info.ts`) with no alias→requestId reverse
 * index, so it does not answer the question a subgroup stream asks —
 * `SubgroupStreamHeader` carries `trackAlias` and nothing else
 * (`drafts/draft20/types.ts`), so there is no request id on the stream to key on
 * either. It also decodes namespace tuples, track names and reason phrases into
 * strings on the control path.
 *
 * A *rebind* — the alias binds to a different request after the previous one
 * ended — bumps the epoch, which opens a new bucket and closes the old one
 * cleanly. A *concurrent* bind — a second live request binds an alias that is
 * still bound — sets {@link TrackKeys.sharedFor} instead, because draft-20 §5.1
 * requires the publisher to "send the Object once for each matching
 * subscription, even when those subscriptions share the same Track Alias".
 * Telling those apart needs one bit of liveness per binding, which this class
 * already has from the control plane and from the stream's own close.
 * Disambiguating a *shared* alias properly would need each subscription's
 * LOCATION_FILTER evaluated against every object header on the device, so the
 * flag instead says the duplicates are structural rather than a fault.
 *
 * Also owns the `streamId → pending request` map. From draft-17 each request
 * gets its own bidirectional stream and **responses carry no request id** —
 * draft-20's SUBSCRIBE_OK is `{track_alias, parameters, track_properties}`
 * (`drafts/draft20/types.ts`) — so the stream is the only thing tying a response
 * to its request, and without this map *no* exchange latency is computable on
 * any draft this package supports.
 */

import { exchangeKindOf, requestIdOf, trackAliasOf } from '../draft/protocol.js'
import type {
  AnyMessage,
  BucketKey,
  BucketKind,
  Direction,
  ExchangeKind,
  Mono,
  PendingRequest,
  TrackKeyResolver,
} from '../types.js'

/**
 * The bucket cap's default; `Limits.maxBuckets` is where the api module
 * overrides it.
 *
 * 1,024 live buckets is far above any real session — a busy player runs tens —
 * and far below what a flapping relay or a fuzzing peer can invent. Past it,
 * {@link TrackKeys.aliasKey} returns `null` and the refusal is **counted**
 * ({@link TrackKeys.bucketsRefused}), never silently merged into another
 * track's row.
 */
export const DEFAULT_MAX_BUCKETS = 1024

/**
 * Floor on how many distinct refused ids {@link TrackKeys.bucketsRefused} can
 * tell apart, independent of the bucket cap. See that getter for why the count
 * degrades rather than either lying or growing without bound.
 */
const MIN_REFUSAL_SLOTS = 256

/** Message types that end the request their stream carries. */
const CLOSING_TYPES: ReadonlySet<string> = new Set([
  // draft-19/20.
  'publish_done',
  'request_error',
  // Earlier spellings, kept because the accessors are draft-agnostic and the
  // set costs nothing. A draft that never sends them simply never matches.
  'subscribe_done',
  'subscribe_error',
  'fetch_error',
  'publish_error',
  'unsubscribe',
  'fetch_cancel',
])

/** One alias binding. Six fields, and not one of them is a string from the wire. */
interface AliasBinding {
  epoch: number
  /** The request that bound it, when one was observed. */
  requestId: bigint | undefined
  /** The bidi stream that request was made on, or -1 for an implicit binding. */
  streamId: number
  /** False once the binding's request ended: the next different id rebinds. */
  live: boolean
  shared: boolean
  /** `null` when the bucket cap refused this key. Never re-tried. */
  key: BucketKey | null
}

/** An exchange latency, resolved through the stream map. */
export interface ExchangeLatency {
  readonly kind: ExchangeKind
  readonly latencyMs: number
}

export interface TrackKeysOptions {
  readonly maxBuckets?: number
  /**
   * Called when an alias is found to be bound by two live requests at once.
   *
   * `CountingSink` has no channel for it and `ObjectSample` carries no `shared`
   * field, so without this callback the decoder's epoch map cannot reach
   * `RollupTrackWire.shared`.
   */
  readonly onShared?: (key: BucketKey) => void
}

export class TrackKeys implements TrackKeyResolver {
  private readonly max: number
  private readonly aliasTx = new Map<bigint, AliasBinding>()
  private readonly aliasRx = new Map<bigint, AliasBinding>()
  private readonly fetchTx = new Map<bigint, BucketKey>()
  private readonly fetchRx = new Map<bigint, BucketKey>()
  /** Keyed by stream id alone: both directions of a bidi stream share it. */
  private readonly pending = new Map<number, { req: PendingRequest; answered: boolean }>()
  /** Reverse index so a stream close retires its bindings in O(1). */
  private readonly byStream = new Map<number, AliasBinding[]>()
  /** Distinct refused ids, bounded by {@link max}. See {@link bucketsRefused}. */
  private readonly refusedIds = new Set<string>()
  private readonly refusalCap: number
  private live = 0
  private refused = 0
  private setupSeen: { dir: Direction; at: Mono } | undefined
  private setupPaired = false

  /** See {@link TrackKeysOptions.onShared}. Settable so the dispatcher can bridge. */
  onShared: ((key: BucketKey) => void) | undefined

  constructor(opts?: TrackKeysOptions) {
    const max = opts?.maxBuckets
    this.max = max !== undefined && max > 0 ? max : DEFAULT_MAX_BUCKETS
    // The refusal set has its own floor: with a small cap it would otherwise be
    // full the moment the first refusal landed, and every later refusal of the
    // same id would be counted again.
    this.refusalCap = Math.max(this.max, MIN_REFUSAL_SLOTS)
    this.onShared = opts?.onShared
  }

  /* ── what the counting decoder asks for ───────────────────────────────── */

  /**
   * The bucket for a subgroup stream or a datagram.
   *
   * O(1) and allocation-free on the hot path: the map is keyed by the `bigint`
   * alias itself, and the {@link BucketKey} is created once per binding and
   * handed back by reference. A datagram-heavy session calls this once per
   * datagram, so a string key here would be a per-object allocation.
   */
  aliasKey(dir: Direction, alias: bigint): BucketKey | null {
    const m = dir === 'tx' ? this.aliasTx : this.aliasRx
    const found = m.get(alias)
    if (found !== undefined) return found.key
    const created = this.openAlias(m, dir, alias, undefined, -1)
    return created === undefined ? null : created.key
  }

  /**
   * The bucket for a fetch stream.
   *
   * No epoch: `FetchStreamHeader` is `{type, requestId}` and nothing else
   * (`drafts/draft20/types.ts`), and request ids are never reused within a
   * session (draft-20 §10.1: a "duplicate Request ID … MUST close the session
   * with INVALID_REQUEST_ID"), so the id is natively stable. A fill fetch stream
   * names the SUBSCRIBE or REQUEST_UPDATE that asked for the fill; ingest chains
   * that back to a track through the control records.
   */
  fetchKey(dir: Direction, requestId: bigint): BucketKey | null {
    const m = dir === 'tx' ? this.fetchTx : this.fetchRx
    const found = m.get(requestId)
    if (found !== undefined) return found
    if (this.live >= this.max) return this.refuse(dir, 'fetch', requestId)
    const key: BucketKey = Object.freeze({
      dir,
      kind: 'fetch' as BucketKind,
      id: requestId,
      epoch: 0,
    })
    m.set(requestId, key)
    this.live++
    return key
  }

  /**
   * Read a decoded control message.
   *
   * **Reads three things and nothing else**: the request id, the track alias and
   * the message's own `type`. Reading a name or a namespace here would put it
   * one field access from the wire and defeat the whole point of the raw key.
   */
  applyControl(msg: AnyMessage, dir: Direction, streamId: number, at: Mono): void {
    const rid = requestIdOf(msg)
    const kind = exchangeKindOf(msg)

    // Only *requests* carry an id (draft-20 §10.1: "Only request messages
    // include a Request ID; response messages do not, since they are sent on
    // the same bidirectional stream as the request"), so this only ever records
    // the outgoing half of an exchange. A later request on the same stream —
    // REQUEST_UPDATE, which correlates by its bidi stream — replaces the
    // slot only once the previous one has been answered, so an in-flight
    // latency is never overwritten by a follow-up.
    if (rid !== undefined && kind !== undefined) {
      const slot = this.pending.get(streamId)
      if (slot === undefined || slot.answered) {
        this.pending.set(streamId, {
          req: { requestId: rid, kind, sentMono: at, dir },
          answered: false,
        })
      }
    }

    const alias = trackAliasOf(msg)
    if (alias !== undefined) {
      // SUBSCRIBE_OK carries the alias and no id at all, so the binding's
      // request comes from the stream — which is precisely what the map is
      // for, reused here for free.
      this.bind(dir, alias, rid ?? this.pending.get(streamId)?.req.requestId, streamId)
    }

    const type = msg.type
    if (typeof type === 'string' && CLOSING_TYPES.has(type)) this.retire(streamId)
  }

  pendingFor(streamId: number): PendingRequest | undefined {
    return this.pending.get(streamId)?.req
  }

  /**
   * A frame carrying no request id arrived on `streamId`: the response half of
   * the exchange, or the peer's SETUP.
   *
   * Returns the latency to report, or `undefined` when this frame is not a
   * response — another outgoing message, a second response, or a clock that ran
   * backwards. `dir` is what distinguishes a response from a further request on
   * the same bidi stream.
   */
  noteResponse(
    streamId: number,
    dir: Direction,
    kind: ExchangeKind | undefined,
    at: Mono,
  ): ExchangeLatency | undefined {
    if (kind === 'setup') return this.noteSetup(dir, at)
    const slot = this.pending.get(streamId)
    if (slot === undefined || slot.answered || slot.req.dir === dir) return undefined
    slot.answered = true
    const ms = at - slot.req.sentMono
    return ms >= 0 ? { kind: slot.req.kind, latencyMs: ms } : undefined
  }

  /**
   * The stream is gone: drop its pending request and retire the bindings it made.
   *
   * Called on a real transport close, so it is the honest liveness signal behind
   * the rebind-versus-shared distinction: after this, the next *different*
   * request id on this alias bumps the epoch instead of flagging a shared alias.
   */
  closeStream(streamId: number): void {
    this.pending.delete(streamId)
    this.retire(streamId)
  }

  /**
   * The fetch stream that opened this bucket is finished; free its cap slot.
   *
   * Fetch buckets are the one kind that accumulates without bound: a request id
   * is used once per session (draft-20 §10.1), so a long-running session would
   * reach the cap and start refusing *live* tracks. Releasing is safe because the
   * key is a pure function of `(dir, id)` with no epoch — a second fill fetch
   * stream naming the same request id gets a byte-identical key back.
   */
  releaseFetch(dir: Direction, requestId: bigint): void {
    const m = dir === 'tx' ? this.fetchTx : this.fetchRx
    if (m.delete(requestId)) this.live--
  }

  /** Two live requests bound this bucket's alias at once (draft-20 §5.1). */
  sharedFor(key: BucketKey): boolean {
    if (key.kind !== 'alias') return false
    const b = (key.dir === 'tx' ? this.aliasTx : this.aliasRx).get(key.id)
    return b !== undefined && b.epoch === key.epoch && b.shared
  }

  /**
   * Distinct ids refused by the bucket cap. Counted on `TerminalRecord`.
   *
   * Distinct while the bounded refusal set has room, and refusal *events* past
   * that, where the number only means "a great many" — an unbounded set of
   * refused ids would be the memory leak the cap exists to prevent.
   */
  get bucketsRefused(): number {
    return this.refused
  }

  /** Live buckets. Never exceeds the cap; feeds the overrun accounting. */
  get bucketCount(): number {
    return this.live
  }

  /** Streams with an outstanding request. Bounded by open bidi streams. */
  get pendingCount(): number {
    return this.pending.size
  }

  /* ── internals ────────────────────────────────────────────────────────── */

  private noteSetup(dir: Direction, at: Mono): ExchangeLatency | undefined {
    // The two control streams are a *pair of unidirectional streams* from
    // draft-17 (draft-20 §3.3), so the two SETUPs never share a stream id and
    // the pending-request map cannot pair them. They are paired by direction instead.
    const seen = this.setupSeen
    if (seen === undefined) {
      this.setupSeen = { dir, at }
      return undefined
    }
    if (this.setupPaired || seen.dir === dir) return undefined
    this.setupPaired = true
    const ms = at - seen.at
    return ms >= 0 ? { kind: 'setup', latencyMs: ms } : undefined
  }

  private bind(dir: Direction, alias: bigint, requestId: bigint | undefined, streamId: number) {
    const m = dir === 'tx' ? this.aliasTx : this.aliasRx
    const b = m.get(alias)
    if (b === undefined) {
      this.openAlias(m, dir, alias, requestId, streamId)
      return
    }
    this.index(streamId, b)
    if (requestId === undefined || b.requestId === requestId) {
      // A re-assertion of the same binding — a SUBSCRIBE_OK following its
      // SUBSCRIBE, a REQUEST_UPDATE on the same subscription. Not a rebind.
      b.live = true
      if (b.streamId < 0) b.streamId = streamId
      return
    }
    if (b.requestId === undefined) {
      b.requestId = requestId
      b.streamId = streamId
      b.live = true
      return
    }
    if (b.live) {
      // Two live requests, one alias. Structural duplicates follow, not a fault.
      if (!b.shared) {
        b.shared = true
        if (b.key !== null) this.onShared?.(b.key)
      }
      return
    }
    // Sequential rebinding, which draft-20 permits once the prior subscription
    // has closed. One bucket out, one in: the epoch bump does not consume cap.
    b.epoch++
    b.requestId = requestId
    b.streamId = streamId
    b.live = true
    b.shared = false
    b.key =
      b.key === null
        ? null
        : Object.freeze({ dir, kind: 'alias' as BucketKind, id: alias, epoch: b.epoch })
  }

  /** Returns `undefined` when the bucket cap refused the alias. */
  private openAlias(
    m: Map<bigint, AliasBinding>,
    dir: Direction,
    alias: bigint,
    requestId: bigint | undefined,
    streamId: number,
  ): AliasBinding | undefined {
    if (this.live >= this.max) {
      this.refuse(dir, 'alias', alias)
      return undefined
    }
    const b: AliasBinding = {
      epoch: 0,
      requestId,
      streamId,
      // An alias first seen on the data plane is bound by nobody we observed —
      // objects legitimately precede the control message that establishes the
      // alias (draft-20 §11.4.2 tells a receiver it MAY buffer for exactly
      // that), and a collector armed mid-session never sees the binding at all.
      // `live: false` there means the first control binding fills it in rather
      // than opening a second epoch over the objects already counted.
      live: requestId !== undefined,
      shared: false,
      key: Object.freeze({ dir, kind: 'alias' as BucketKind, id: alias, epoch: 0 }),
    }
    m.set(alias, b)
    this.live++
    this.index(streamId, b)
    return b
  }

  private index(streamId: number, b: AliasBinding): void {
    if (streamId < 0) return
    const list = this.byStream.get(streamId)
    if (list === undefined) this.byStream.set(streamId, [b])
    else if (!list.includes(b)) list.push(b)
  }

  private retire(streamId: number): void {
    const list = this.byStream.get(streamId)
    if (list === undefined) return
    for (const b of list) {
      if (b.streamId === streamId) b.live = false
    }
    this.byStream.delete(streamId)
  }

  private refuse(dir: Direction, kind: BucketKind, id: bigint): null {
    if (this.refusedIds.size >= this.refusalCap) {
      this.refused++
      return null
    }
    const tag = `${dir}:${kind}:${id}`
    if (!this.refusedIds.has(tag)) {
      this.refusedIds.add(tag)
      this.refused++
    }
    return null
  }
}
