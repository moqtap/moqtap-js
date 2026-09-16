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

/**
 * Count one datagram.
 *
 * The bucket-cap refusal is reported only when the refusal is **new** — the
 * resolver counts distinct refused ids, so comparing its counter across the call
 * turns "this datagram was refused" into "an id was refused for the first time".
 * Without that, one refused alias at 200 datagrams a second would write 200
 * parse failures a second into a field that is supposed to say how many buckets
 * were refused.
 */
export function countDatagram(
  dir: Direction,
  bytes: Uint8Array,
  atMono: Mono,
  keys: TrackKeyResolver,
  sink: CountingSink,
  a: DraftAdapter,
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

  const sample: ObjectSample =
    counts.status === undefined
      ? {
          key,
          groupId: counts.groupId,
          objectId: counts.objectId,
          headerBytes: counts.headerBytes,
          payloadBytes: counts.payloadBytes,
          at: atMono,
        }
      : {
          key,
          groupId: counts.groupId,
          objectId: counts.objectId,
          headerBytes: counts.headerBytes,
          payloadBytes: counts.payloadBytes,
          status: counts.status,
          at: atMono,
        }
  sink.onObject(sample)
}
