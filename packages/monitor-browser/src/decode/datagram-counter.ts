/**
 * The counting decoder for datagrams.
 *
 * The one place the counting decoder does **not** hand-roll. A datagram arrives
 * whole — there is no framing, no continuation and no payload length field, the
 * payload being "everything left in the datagram" — so the codec's one-shot
 * `decodeDatagram` is already the right shape and is used through
 * {@link DraftAdapter.decodeDatagram}. What the adapter must not do is let the
 * result's `payload` **view** escape: it is a view onto the page's own buffer,
 * and retaining it silently rewrites already-counted history when the page
 * writes through the same `ArrayBuffer` on its next frame.
 *
 * There is no per-stream state to hold and none is held: one datagram in, one
 * {@link ObjectSample} out, discarded.

 */

import type {
  CountingSink,
  Direction,
  DraftAdapter,
  Mono,
  ObjectSample,
  TrackKeyResolver,
} from '../types.js'
import { readGaps } from './gaps.js'

/**
 * Count one datagram.
 *
 * The bucket-cap refusal is reported only when the refusal is **new** — the
 * resolver counts distinct refused ids, so comparing its counter across the call
 * turns "this datagram was refused" into "an id was refused for the first time".
 * Without that, one refused alias at 200 datagrams a second would write 200
 * parse failures a second into a field that is supposed to say how many buckets
 * were refused.
 *
 * `fields` receives the datagram's priority before the sink hears of it, for
 * `StreamDispatcher.fieldsOf`.
 */
export function countDatagram(
  dir: Direction,
  bytes: Uint8Array,
  atMono: Mono,
  keys: TrackKeyResolver,
  sink: CountingSink,
  a: DraftAdapter,
  fields?: { priority: number },
): void {
  const counts = a.decodeDatagram(bytes)
  if (counts === null) {
    sink.onParseFailure(null, 'malformed-datagram')
    return
  }

  const refusedBefore = keys.bucketsRefused
  const key = keys.aliasKey(dir, counts.trackAlias)
  if (key === null) {
    if (keys.bucketsRefused !== refusedBefore) sink.onParseFailure(null, 'bucket-cap')
    return
  }

  if (fields !== undefined) fields.priority = counts.priority
  const sample: ObjectSample = {
    key,
    groupId: counts.groupId,
    objectId: counts.objectId,
    headerBytes: counts.headerBytes,
    payloadBytes: counts.payloadBytes,
    at: atMono,
    path: 'datagram',
    sub: null,
    fo: false,
    foKnown: false,
    eog: counts.endOfGroup === true,
  }
  // A zero-length datagram with status 0x0 is a Normal object with no payload.
  if (counts.status !== undefined && counts.status !== 0n) {
    ;(sample as { status?: bigint }).status = counts.status
  }
  sink.onObject(sample)
  if (counts.props !== undefined && sink.onMark !== undefined) {
    const g = readGaps(a.varint, counts.props, 0, counts.props.byteLength, a.draft)
    if (g === null) return
    const base = {
      key,
      groupId: counts.groupId,
      objectId: counts.objectId,
      path: 'datagram' as const,
      at: atMono,
    }
    if (g.group !== undefined) sink.onMark({ ...base, what: { gap: 'group', n: g.group } })
    if (g.object !== undefined) sink.onMark({ ...base, what: { gap: 'object', n: g.object } })
  }
}
