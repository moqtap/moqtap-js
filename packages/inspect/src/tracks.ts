/**
 * The track registry: joining a data stream's track alias to the namespace
 * and name the control plane gave it.
 *
 * Data streams name their track with a numeric alias and nothing else, so
 * labelling one means joining that alias to the namespace and name carried by
 * control messages. Where the two halves of that join live moved twice in the
 * draft series:
 *
 *   drafts 07–11  SUBSCRIBE carries namespace, name and alias together
 *   drafts 12+    the publisher assigns the alias, so it arrives separately in
 *                 SUBSCRIBE_OK, or all at once in PUBLISH, which a publisher
 *                 sends to offer a track it already holds
 *   drafts 17+    responses carry no request id at all: each request has its
 *                 own bidirectional stream and that stream is the correlation
 *                 (draft-21 §6.3), so the join key becomes the stream the
 *                 response arrived on
 *
 * PUBLISH_NAMESPACE never takes part. It announces a namespace and nothing
 * else (no track name, no alias), so a publisher that has only announced has
 * no nameable track yet; the name appears when a SUBSCRIBE for one of its
 * tracks is answered, or when it sends PUBLISH.
 *
 * FETCH is the exception to the alias rule: a fetch has no track alias, and
 * its data stream carries the request id in its header instead. Fetches are
 * registered under the same key as everything else, so the join works the
 * same; the stream looks itself up by request id.
 *
 * Messages are identified by name, in either case (`SUBSCRIBE_OK` or the
 * codec's `subscribe_ok`), because names kept their meaning while wire IDs
 * moved between drafts. Field names are the codec's snake_case; the camelCase
 * spellings are read too, for traces from other tools.
 */

import { bytesAsText } from './display.js'

/** Status of a track's request, in the order it progresses. */
export type TrackStatus = 'pending' | 'active' | 'error' | 'done'

/**
 * The request that put a track in the registry. It decides how the track's
 * data streams find their way back to it: a subscription or publication by
 * track alias, a fetch by request id.
 */
export type TrackVia = 'subscribe' | 'publish' | 'fetch'

/** What the registry knows about one track. */
export interface TrackFields {
  /** Request id (subscribe id before draft-11) that identifies the request. */
  subscribeId: string
  /** Alias the data streams use for this track, once the draft reveals it. */
  trackAlias?: string | undefined
  trackNamespace: string[]
  trackName: string
  /** Direction of the message that opened the track (`tx`: the recorder sent it). */
  direction: 'tx' | 'rx'
  via: TrackVia
  status: TrackStatus
  errorReason?: string | undefined
  subscribedAt?: number | undefined
  subscribeOkAt?: number | undefined
  subscribeErrorAt?: number | undefined
  subscribeDoneAt?: number | undefined
}

/** What a control message says about a track, stripped of draft differences. */
export type TrackEvent =
  | {
      kind: 'open'
      requestId?: string | undefined
      via: TrackVia
      trackNamespace: string[]
      trackName: string
      trackAlias?: string | undefined
      /**
       * Request whose track a joining FETCH is fetching. Such a fetch names no
       * track itself: it continues an existing subscription's track.
       */
      joiningRequestId?: string | undefined
    }
  | { kind: 'accept'; requestId?: string | undefined; trackAlias?: string | undefined }
  | { kind: 'reject'; requestId?: string | undefined; reason: string }
  | { kind: 'close'; requestId?: string | undefined }

/** First defined value among several spellings of one field. */
function pick(msg: Record<string, unknown>, names: readonly string[]): unknown {
  for (const name of names) {
    const value = msg[name]
    if (value != null) return value
  }
  return undefined
}

/** A name part as text: a byte string that is not printable reads as hex. */
function text(value: unknown): string {
  if (value instanceof Uint8Array) {
    return (
      bytesAsText(value) ??
      `0x${Array.from(value, (b) => b.toString(16).padStart(2, '0')).join('')}`
    )
  }
  return String(value)
}

function id(msg: Record<string, unknown>): string | undefined {
  // subscribe_id through draft-10; request_id from draft-11, when the id space
  // was widened to cover every request type.
  const value = pick(msg, ['request_id', 'requestId', 'subscribe_id', 'subscribeId'])
  return value != null ? String(value) : undefined
}

function alias(msg: Record<string, unknown>): string | undefined {
  const value = pick(msg, ['track_alias', 'trackAlias'])
  return value != null ? String(value) : undefined
}

function namespace(msg: Record<string, unknown>): string[] {
  const value = pick(msg, ['track_namespace', 'trackNamespace'])
  return Array.isArray(value) ? value.map(text) : []
}

function name(msg: Record<string, unknown>): string {
  const value = pick(msg, ['track_name', 'trackName'])
  return value != null ? text(value) : ''
}

function reason(msg: Record<string, unknown>): string {
  const value = pick(msg, ['reason_phrase', 'reasonPhrase'])
  return value != null ? text(value) : ''
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/**
 * Read a control message as a track event, or `null` if it says nothing
 * about a track. `kind` is the message's name in either case.
 *
 * The generic REQUEST_OK and REQUEST_ERROR of draft-17 and later answer any
 * request, not just track ones. They are read anyway and land harmlessly: a
 * response to a PUBLISH_NAMESPACE resolves to no track and is dropped.
 */
export function trackEventFrom(kind: string, msg: Record<string, unknown>): TrackEvent | null {
  switch (kind.toLowerCase()) {
    case 'subscribe':
    case 'publish':
      return {
        kind: 'open',
        requestId: id(msg),
        via: kind.toLowerCase() === 'publish' ? 'publish' : 'subscribe',
        trackNamespace: namespace(msg),
        trackName: name(msg),
        trackAlias: alias(msg),
      }

    case 'fetch': {
      // A standalone fetch names its track; a joining fetch points at the
      // subscription whose track it continues. Most drafts nest the two in
      // `standalone` and `joining` structures, draft-14 keeps them flat, so
      // read through the nesting when it is there.
      const standalone = record(msg.standalone) ?? msg
      const joining = record(msg.joining) ?? msg
      const joiningId = pick(joining, [
        'joining_request_id',
        'joiningRequestId',
        'joining_subscribe_id',
        'joiningSubscribeId',
      ])
      return {
        kind: 'open',
        requestId: id(msg),
        via: 'fetch',
        trackNamespace: namespace(standalone),
        trackName: name(standalone),
        ...(joiningId != null ? { joiningRequestId: String(joiningId) } : {}),
      }
    }

    case 'subscribe_ok':
    case 'publish_ok':
    case 'fetch_ok':
    case 'request_ok':
      return { kind: 'accept', requestId: id(msg), trackAlias: alias(msg) }

    case 'subscribe_error':
    case 'publish_error':
    case 'fetch_error':
    case 'request_error':
      return { kind: 'reject', requestId: id(msg), reason: reason(msg) }

    case 'subscribe_done':
    case 'publish_done':
    case 'unsubscribe':
    case 'fetch_cancel':
      return { kind: 'close', requestId: id(msg) }

    default:
      return null
  }
}

/** Where a control message came from, as far as the join is concerned. */
export interface TrackMessageContext {
  direction: 'tx' | 'rx'
  /**
   * Stream the message travelled on. Required to follow a draft-17+ request,
   * whose responses identify themselves only by their stream.
   */
  streamId?: number | bigint | string | undefined
  timestamp?: number | undefined
}

/**
 * A session's tracks, kept up to date from its control messages.
 *
 * Generic over the stored record so a caller can keep display fields beside
 * {@link TrackFields}. The map passed in is updated in place, so the caller
 * reads the tracks straight from it.
 */
export class TrackRegistry<T extends TrackFields> {
  /**
   * Request id owning each request stream, so draft-17+ responses can be
   * matched to the request that opened their stream.
   */
  private readonly requestIdByStream = new Map<string, string>()

  constructor(
    private readonly tracks: Map<string, T>,
    private readonly create: (fields: TrackFields) => T,
  ) {}

  /**
   * Apply one decoded control message, named `kind` in either case. Returns
   * the track it affected, or `null` if it was not about a track that can be
   * identified.
   */
  apply(kind: string, msg: Record<string, unknown>, ctx: TrackMessageContext): T | null {
    const event = trackEventFrom(kind, msg)
    if (!event) return null

    const stream = ctx.streamId == null ? undefined : String(ctx.streamId)
    const key = this.keyFor(event, stream)
    if (key == null) return null

    switch (event.kind) {
      case 'open': {
        const named = this.nameFor(event)
        const track = this.create({
          subscribeId: key,
          trackAlias: event.trackAlias,
          trackNamespace: named.trackNamespace,
          trackName: named.trackName,
          direction: ctx.direction,
          via: event.via,
          status: 'pending',
          subscribedAt: ctx.timestamp,
        })
        this.tracks.set(key, track)
        return track
      }

      case 'accept': {
        const track = this.tracks.get(key)
        if (!track) return null
        // From draft-12 this is where the subscription learns which data
        // streams are its own, so it is the half of the join that matters.
        if (event.trackAlias != null) track.trackAlias = event.trackAlias
        track.status = 'active'
        track.subscribeOkAt = ctx.timestamp
        return track
      }

      case 'reject': {
        const track = this.tracks.get(key)
        if (!track) return null
        track.status = 'error'
        track.errorReason = event.reason
        track.subscribeErrorAt = ctx.timestamp
        return track
      }

      case 'close': {
        const track = this.tracks.get(key)
        if (!track) return null
        track.status = 'done'
        track.subscribeDoneAt = ctx.timestamp
        return track
      }
    }
  }

  /** The track whose data streams carry `alias`, the latest to claim it. */
  byAlias(alias: string): T | undefined {
    let found: T | undefined
    for (const track of this.tracks.values()) {
      if (track.via !== 'fetch' && track.trackAlias === alias) found = track
    }
    return found
  }

  /**
   * The namespace and name to file an opening request under.
   *
   * A joining FETCH carries neither: it continues the track of an existing
   * subscription, named by that subscription's request. Borrowing the name
   * from it is what keeps a joining fetch's streams from showing up nameless.
   */
  private nameFor(event: Extract<TrackEvent, { kind: 'open' }>): {
    trackNamespace: string[]
    trackName: string
  } {
    if (event.trackName || event.trackNamespace.length) return event
    const parent = event.joiningRequestId ? this.tracks.get(event.joiningRequestId) : undefined
    if (!parent) return event
    return { trackNamespace: parent.trackNamespace, trackName: parent.trackName }
  }

  /**
   * The key a message's track is filed under: its own request id when it has
   * one, otherwise the id of the request that opened its stream.
   */
  private keyFor(event: TrackEvent, stream: string | undefined): string | null {
    if (event.requestId != null) {
      if (event.kind === 'open' && stream != null) {
        this.requestIdByStream.set(stream, event.requestId)
      }
      return event.requestId
    }
    if (stream == null) return null
    return this.requestIdByStream.get(stream) ?? null
  }
}

/**
 * A track as people write it: the namespace tuple joined by `/`, then the
 * name after ` / `, so `live/ch4 / video/1080p`. A name alone when there is
 * no namespace; an empty string when there is neither.
 */
export function trackDisplayName(track: Pick<TrackFields, 'trackNamespace' | 'trackName'>): string {
  const ns = track.trackNamespace.join('/')
  if (ns.length === 0) return track.trackName
  return track.trackName.length === 0 ? ns : `${ns} / ${track.trackName}`
}
