/**
 * Draft-agnostic readers for decoded control messages.
 *
 * The codec keeps one message model per draft, because the drafts genuinely
 * disagree: a track alias travels in SUBSCRIBE through draft-11 and in
 * SUBSCRIBE_OK from draft-12; a request was a `subscribe_id` through draft-10
 * and a `request_id` after it; a joining FETCH points at a
 * `joining_subscribe_id` through draft-13 and a `joining_request_id` after it.
 * Faithfulness to each draft is the point of the codec.
 *
 * What consumers usually want is the answer, not the archaeology — and every
 * one of them that has asked has written the same field-spelling ladder by
 * hand. These accessors are that ladder, written once.
 *
 * Each returns `undefined` when the message does not carry the field, which
 * includes the cases where the draft has not assigned it yet: `trackAliasOf`
 * on a draft-14 SUBSCRIBE is `undefined` because the publisher has not chosen
 * the alias until SUBSCRIBE_OK.
 *
 * Both snake_case (what this codec emits) and camelCase spellings are read, so
 * these also work on messages recovered from qlog-style traces written by
 * other tools.
 */

/** Any decoded control message, from any draft. */
export type AnyMessage = Readonly<Record<string, unknown>>

/** A track's full identity: the namespace tuple plus the name within it. */
export interface TrackIdentity {
  readonly namespace: string[]
  readonly name: string
}

/** First defined value among several spellings of one field. */
function pick(msg: AnyMessage, names: readonly string[]): unknown {
  for (const name of names) {
    const value = msg[name]
    if (value != null) return value
  }
  return undefined
}

function bigintOf(value: unknown): bigint | undefined {
  if (value == null) return undefined
  if (typeof value === 'bigint') return value
  if (typeof value === 'number' || typeof value === 'string') {
    try {
      return BigInt(value)
    } catch {
      return undefined
    }
  }
  return undefined
}

/**
 * The request this message belongs to.
 *
 * Named `subscribe_id` through draft-10 and `request_id` from draft-11, when
 * the id space widened to cover every request type rather than subscriptions
 * alone.
 *
 * Returns `undefined` for draft-17+ responses, which carry no id at all: each
 * request there has its own bidirectional stream, and that stream — not a
 * field — is what ties a response to its request.
 */
export function requestIdOf(msg: AnyMessage): bigint | undefined {
  return bigintOf(pick(msg, ['request_id', 'requestId', 'subscribe_id', 'subscribeId']))
}

/**
 * The track alias this message assigns or refers to, if any.
 *
 * Which message carries it moved: SUBSCRIBE through draft-11, then SUBSCRIBE_OK
 * from draft-12, when assigning the alias became the publisher's job. PUBLISH
 * carries it alongside the track name in every draft that has PUBLISH.
 */
export function trackAliasOf(msg: AnyMessage): bigint | undefined {
  return bigintOf(pick(msg, ['track_alias', 'trackAlias']))
}

/**
 * The track this message names, or `undefined` if it names none.
 *
 * Covers SUBSCRIBE, PUBLISH, TRACK_STATUS and a standalone FETCH — whose track
 * sits under `standalone` in most drafts and flat in draft-07, which predates
 * joining fetch. A joining FETCH names no track of its own; use
 * {@link joiningRequestIdOf} to find the request whose track it continues.
 *
 * PUBLISH_NAMESPACE and its relatives are namespace-only and yield
 * `undefined`: a namespace is not a track.
 */
export function trackOf(msg: AnyMessage): TrackIdentity | undefined {
  const source = (pick(msg, ['standalone']) ?? msg) as AnyMessage
  const name = pick(source, ['track_name', 'trackName'])
  if (typeof name !== 'string') return undefined
  const namespace = pick(source, ['track_namespace', 'trackNamespace'])
  return {
    namespace: Array.isArray(namespace) ? namespace.map(String) : [],
    name,
  }
}

/**
 * For a joining FETCH, the request whose track it continues.
 *
 * Spelled `joining_subscribe_id` through draft-13 and `joining_request_id`
 * after it, nested under `joining` in every draft that has one.
 */
export function joiningRequestIdOf(msg: AnyMessage): bigint | undefined {
  const source = (pick(msg, ['joining']) ?? msg) as AnyMessage
  return bigintOf(
    pick(source, [
      'joining_request_id',
      'joiningRequestId',
      'joining_subscribe_id',
      'joiningSubscribeId',
    ]),
  )
}
