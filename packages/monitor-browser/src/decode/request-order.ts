/**
 * The one control fact data decoding needs: what a FETCH_HEADER's Request ID
 * names, and in which group order its stream runs.
 *
 * A fetch stream answers a FETCH (standalone, or joining in drafts 08-19) or,
 * from draft-20, the SUBSCRIBE or REQUEST_UPDATE that asked for a fill. From
 * draft-18 its Group ID Deltas count in the stream's group order, taken from
 * the first present of: FILL_PARAMETERS in the REQUEST_UPDATE or SUBSCRIBE that
 * started the fill; GROUP_ORDER in SUBSCRIBE, SUBSCRIBE_TRACKS or FETCH;
 * DEFAULT_PUBLISHER_GROUP_ORDER in SUBSCRIBE_OK or PUBLISH; the default,
 * Ascending.
 *
 * Reads message types, request ids, the fetch type and group order values.
 * Nothing else.
 */

import type { AnyMessage, DeliveryPath, Direction } from '../types.js'

const ASCENDING = 1
const DESCENDING = 2

interface Request {
  readonly path: DeliveryPath
  /** Group order from the request itself; 0 when it states none. */
  readonly own: number
  /** The subscription a REQUEST_UPDATE belongs to. */
  readonly parent: Request | undefined
  /** DEFAULT_PUBLISHER_GROUP_ORDER from the answer, or Ascending once an answer stated none. */
  answered: number
}

/** Requests remembered per connection, oldest forgotten first. */
const MAX_REQUESTS = 1024

/** A group order value: 1 Ascending, 2 Descending, 0 for none or any other value. */
function orderOf(v: unknown): number {
  const n = typeof v === 'bigint' ? Number(v) : typeof v === 'number' ? v : 0
  return n === ASCENDING || n === DESCENDING ? n : 0
}

function field(o: unknown, name: string): unknown {
  return o !== null && typeof o === 'object' ? (o as Record<string, unknown>)[name] : undefined
}

export class RequestOrder {
  /** By sender direction, then Request ID. */
  private readonly tx = new Map<bigint, Request>()
  private readonly rx = new Map<bigint, Request>()
  /** The first request each bidi stream carried: from draft-17 a request owns its stream. */
  private readonly byStream = new Map<number, Request>()

  /**
   * One decoded control message sent in `dir` on `streamId`. `requestId` is
   * the message's own id; `streamRequest` the request already pending on the
   * stream, for an answer that carries none.
   */
  apply(
    msg: AnyMessage,
    dir: Direction,
    streamId: number,
    requestId: bigint | undefined,
    streamRequest: bigint | undefined,
  ): void {
    const type = msg.type
    const params = msg.parameters
    switch (type) {
      case 'subscribe':
      case 'subscribe_tracks': {
        if (requestId === undefined) return
        const fill = field(params, 'fill_parameters')
        const own =
          orderOf(field(fill, 'group_order')) ||
          orderOf(field(params, 'group_order')) ||
          orderOf(msg.group_order)
        this.add(dir, requestId, streamId, { path: 'fill', own, parent: undefined, answered: 0 })
        return
      }
      case 'request_update': {
        if (requestId === undefined) return
        const parent = this.byStream.get(streamId)
        const own = orderOf(field(field(params, 'fill_parameters'), 'group_order'))
        this.add(dir, requestId, -1, { path: 'fill', own, parent, answered: 0 })
        return
      }
      case 'fetch': {
        if (requestId === undefined) return
        const ft = msg.fetch_type
        const joining = ft === 2n || ft === 3n || ft === 2 || ft === 3
        const own = orderOf(field(params, 'group_order')) || orderOf(msg.group_order)
        this.add(dir, requestId, streamId, {
          path: joining ? 'fetch_joining' : 'fetch',
          own: own || ASCENDING,
          parent: undefined,
          answered: ASCENDING,
        })
        return
      }
      case 'subscribe_ok': {
        const id = requestId ?? streamRequest
        if (id === undefined) return
        const r = (dir === 'tx' ? this.rx : this.tx).get(id)
        if (r === undefined) return
        r.answered =
          orderOf(field(msg.track_properties, 'default_publisher_group_order')) ||
          orderOf(msg.group_order) ||
          ASCENDING
        return
      }
      case 'publish': {
        if (requestId === undefined) return
        this.add(dir, requestId, streamId, {
          path: 'fill',
          own: 0,
          parent: undefined,
          answered:
            orderOf(field(msg.track_properties, 'default_publisher_group_order')) || ASCENDING,
        })
        return
      }
    }
  }

  /** The path a fetch stream received in `streamDir` naming `requestId` delivers on. */
  path(streamDir: Direction, requestId: bigint): DeliveryPath | null {
    return this.sent(streamDir, requestId)?.path ?? null
  }

  /** Whether that stream's groups descend, or `null` while the order is not settled. */
  descending(streamDir: Direction, requestId: bigint): boolean | null {
    const r = this.sent(streamDir, requestId)
    if (r === undefined) return null
    const order = r.own || (r.parent === undefined ? 0 : r.parent.own) || r.answered
    const settled = order || (r.parent === undefined ? 0 : r.parent.answered)
    return settled === 0 ? null : settled === DESCENDING
  }

  private sent(streamDir: Direction, requestId: bigint): Request | undefined {
    return (streamDir === 'rx' ? this.tx : this.rx).get(requestId)
  }

  private add(dir: Direction, id: bigint, streamId: number, r: Request): void {
    const m = dir === 'tx' ? this.tx : this.rx
    if (m.size >= MAX_REQUESTS) {
      const oldest = m.keys().next()
      if (!oldest.done) m.delete(oldest.value)
    }
    m.set(id, r)
    if (streamId >= 0 && !this.byStream.has(streamId)) {
      if (this.byStream.size >= MAX_REQUESTS) {
        const oldest = this.byStream.keys().next()
        if (!oldest.done) this.byStream.delete(oldest.value)
      }
      this.byStream.set(streamId, r)
    }
  }
}
