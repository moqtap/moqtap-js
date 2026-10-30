/**
 * The bucket keys and the pending-request map.
 *
 * Every message here is a **real decoded control message** — encoded by the
 * codec, framed, and decoded back through the draft-20 adapter — because the
 * whole of `TrackKeys` turns on field spelling: the codec's control messages
 * are snake_case while its data-stream types are camelCase, and a reader that
 * assumes one spelling reads `undefined` from half the wire and silently keys
 * everything into one bucket.
 */

import { decodeMessage as decode07, encodeMessage as encode07 } from '@moqtap/codec/draft07'
import { decodeMessage as decode11, encodeMessage as encode11 } from '@moqtap/codec/draft11'
import { decodeMessage as decode14, encodeMessage as encode14 } from '@moqtap/codec/draft14'
import { describe, expect, it } from 'vitest'
import { TrackKeys } from '../../decode/track-key.js'
import type { AnyMessage, BucketKey } from '../../types.js'
import {
  DRAFT20_ADAPTER,
  publishBytes,
  publishDoneBytes,
  subscribeBytes,
  subscribeOkBytes,
} from './vectors.js'

function msg(bytes: Uint8Array): AnyMessage {
  const decoded = DRAFT20_ADAPTER.decodeControl(bytes)
  if (decoded.value === null) throw new Error('vector did not decode')
  return decoded.value
}

describe('TrackKeys — bucket keys', () => {
  it('gives an alias seen only on the data plane a bucket at epoch 0', () => {
    // Objects legitimately precede the control message that establishes the
    // alias, and a collector armed mid-session never sees the binding at all.
    const keys = new TrackKeys()
    expect(keys.aliasKey('rx', 4n)).toEqual({ dir: 'rx', kind: 'alias', id: 4n, epoch: 0 })
  })

  it('keeps the two directions of a session in separate alias spaces', () => {
    const keys = new TrackKeys()
    const rx = keys.aliasKey('rx', 1n)
    const tx = keys.aliasKey('tx', 1n)
    expect(rx?.dir).toBe('rx')
    expect(tx?.dir).toBe('tx')
    expect(keys.bucketCount).toBe(2)
  })

  it('returns the same key object for the same alias', () => {
    // Called once per datagram, so a fresh object per call would be a
    // per-object allocation — the thing the O(1) budget exists to avoid.
    const keys = new TrackKeys()
    expect(keys.aliasKey('rx', 7n)).toBe(keys.aliasKey('rx', 7n))
  })

  it('binds an alias through the stream when the response carries no id', () => {
    // draft-20's SUBSCRIBE_OK is `{track_alias, parameters, track_properties}`:
    // no request id anywhere. The map is the only thing that ties it back.
    const keys = new TrackKeys()
    keys.applyControl(msg(subscribeBytes(0n)), 'tx', 5, 10)
    keys.applyControl(msg(subscribeOkBytes(9n)), 'rx', 5, 30)

    expect(keys.pendingFor(5)).toEqual({
      requestId: 0n,
      kind: 'subscribe',
      sentMono: 10,
      dir: 'tx',
    })
    expect(keys.aliasKey('rx', 9n)).toEqual({ dir: 'rx', kind: 'alias', id: 9n, epoch: 0 })
  })

  it('bumps the epoch when a closed alias is rebound to a different request', () => {
    // draft-20 permits sequential reuse "unless it is certain the prior
    // Subscription has been completely closed". Two tracks summed into one row
    // under one raw alias are unrecoverable at ingest.
    const keys = new TrackKeys()
    keys.applyControl(msg(publishBytes(0n, 5n)), 'rx', 1, 1)
    expect(keys.aliasKey('rx', 5n)?.epoch).toBe(0)

    keys.closeStream(1)
    keys.applyControl(msg(publishBytes(2n, 5n)), 'rx', 2, 2)
    expect(keys.aliasKey('rx', 5n)?.epoch).toBe(1)
    // One bucket out, one in: a rebind does not consume the cap.
    expect(keys.bucketCount).toBe(1)
  })

  it('accepts a closing control message as the end of a binding', () => {
    const keys = new TrackKeys()
    keys.applyControl(msg(publishBytes(0n, 5n)), 'rx', 1, 1)
    keys.applyControl(msg(publishDoneBytes()), 'rx', 1, 2)
    keys.applyControl(msg(publishBytes(2n, 5n)), 'rx', 3, 3)
    expect(keys.aliasKey('rx', 5n)?.epoch).toBe(1)
  })

  it('flags a concurrently shared alias instead of bumping the epoch', () => {
    // draft-20 §5.1: two subscriptions MAY share one alias and the publisher
    // "MUST send the Object once for each matching subscription". Those
    // duplicates are structural, not a fault, and ingest must not alert on them.
    const shared: BucketKey[] = []
    const keys = new TrackKeys({ onShared: (k) => shared.push(k) })
    keys.applyControl(msg(publishBytes(0n, 5n)), 'rx', 1, 1)
    keys.applyControl(msg(publishBytes(2n, 5n)), 'rx', 2, 2)

    const key = keys.aliasKey('rx', 5n)
    expect(key?.epoch).toBe(0)
    expect(keys.sharedFor(key as BucketKey)).toBe(true)
    expect(shared).toEqual([key])
  })

  it('reports a shared alias once, not once per binding message', () => {
    const shared: BucketKey[] = []
    const keys = new TrackKeys({ onShared: (k) => shared.push(k) })
    keys.applyControl(msg(publishBytes(0n, 5n)), 'rx', 1, 1)
    keys.applyControl(msg(publishBytes(2n, 5n)), 'rx', 2, 2)
    keys.applyControl(msg(publishBytes(4n, 5n)), 'rx', 3, 3)
    expect(shared).toHaveLength(1)
  })

  it('does not treat a re-assertion of the same request as a rebind', () => {
    const keys = new TrackKeys()
    keys.applyControl(msg(publishBytes(0n, 5n)), 'rx', 1, 1)
    keys.closeStream(1)
    keys.applyControl(msg(publishBytes(0n, 5n)), 'rx', 2, 2)
    expect(keys.aliasKey('rx', 5n)?.epoch).toBe(0)
  })

  it('keys a fetch bucket on its request id, with no epoch', () => {
    const keys = new TrackKeys()
    expect(keys.fetchKey('rx', 12n)).toEqual({ dir: 'rx', kind: 'fetch', id: 12n, epoch: 0 })
    expect(keys.fetchKey('rx', 12n)).toBe(keys.fetchKey('rx', 12n))
  })
})

/** A draft-14 control message, encoded and decoded back through the codec. */
function msg14(m: Parameters<typeof encode14>[0]): AnyMessage {
  const r = decode14(encode14(m))
  if (!r.ok) throw new Error('draft-14 vector did not decode')
  return r.value as unknown as AnyMessage
}

const sub14 = (requestId: bigint, alias: bigint) =>
  msg14({
    type: 'subscribe_ok',
    request_id: requestId,
    track_alias: alias,
    expires: 0n,
    group_order: 1,
    content_exists: 0n,
    parameters: {},
  } as Parameters<typeof encode14>[0])

/** A draft-07 control message, encoded and decoded back through the codec. */
function msg07(m: Parameters<typeof encode07>[0]): AnyMessage {
  const r = decode07(encode07(m))
  if (!r.ok) throw new Error('draft-07 vector did not decode')
  return r.value as unknown as AnyMessage
}

/** A draft-11 control message, encoded and decoded back through the codec. */
function msg11(m: Parameters<typeof encode11>[0]): AnyMessage {
  const r = decode11(encode11(m))
  if (!r.ok) throw new Error('draft-11 vector did not decode')
  return r.value as unknown as AnyMessage
}

const sub07 = (id: bigint, alias: bigint) =>
  msg07({
    type: 'subscribe',
    subscribe_id: id,
    track_alias: alias,
    track_namespace: ['moqtap', 'test'],
    track_name: 'video',
    subscriber_priority: 0,
    group_order: 0,
    filter_type: 1n,
    parameters: {},
  } as Parameters<typeof encode07>[0])

const sub11 = (id: bigint, alias: bigint) =>
  msg11({
    type: 'subscribe',
    request_id: id,
    track_alias: alias,
    track_namespace: ['moqtap', 'test'],
    track_name: 'video',
    subscriber_priority: 0,
    group_order: 0,
    forward: 1n,
    filter_type: 2n,
    parameters: {},
  } as Parameters<typeof encode11>[0])

describe('TrackKeys — which buckets are still open', () => {
  it('binds a subscriber-chosen alias to the objects it labels, through draft-11', () => {
    // Through draft-11 the subscriber sends the alias in SUBSCRIBE and the
    // objects come back the other way, on the one shared control stream.
    for (const [sub, unsub] of [
      [sub07, (id: bigint) => msg07({ type: 'unsubscribe', subscribe_id: id })],
      [sub11, (id: bigint) => msg11({ type: 'unsubscribe', request_id: id })],
    ] as const) {
      const keys = new TrackKeys()
      keys.applyControl(sub(1n, 5n), 'tx', 0, 1)
      keys.applyControl(sub(2n, 6n), 'tx', 0, 2)
      const old = keys.aliasKey('rx', 5n) as BucketKey
      const kept = keys.aliasKey('rx', 6n) as BucketKey
      expect(keys.liveness(old)).toBe('open')
      expect(keys.bucketCount).toBe(2)

      keys.applyControl(unsub(1n), 'tx', 0, 3)
      expect(keys.liveness(old)).toBe('ended')
      expect(keys.liveness(kept)).toBe('open')

      // The alias is the subscriber's to reuse, and the reuse is a new track.
      keys.applyControl(sub(3n, 5n), 'tx', 0, 4)
      const next = keys.aliasKey('rx', 5n) as BucketKey
      expect(next.epoch).toBe(1)
      expect(keys.liveness(next)).toBe('open')
    }
  })

  it('binds a SUBSCRIBE seen arriving to the objects sent back, through draft-11', () => {
    const keys = new TrackKeys()
    keys.applyControl(sub07(1n, 5n), 'rx', 0, 1)
    const k = keys.aliasKey('tx', 5n) as BucketKey
    expect(keys.liveness(k)).toBe('open')
    keys.applyControl(msg07({ type: 'unsubscribe', subscribe_id: 1n }), 'rx', 0, 2)
    expect(keys.liveness(k)).toBe('ended')
  })

  it('ends only the request an UNSUBSCRIBE names, on the one shared control stream', () => {
    // Before draft-17 every request rides control stream 0. An ABR switch
    // unsubscribes the old rendition and leaves the new one, and audio, open.
    const keys = new TrackKeys()
    keys.applyControl(sub14(0n, 1n), 'rx', 0, 1)
    keys.applyControl(sub14(2n, 2n), 'rx', 0, 2)
    const old = keys.aliasKey('rx', 1n) as BucketKey
    const kept = keys.aliasKey('rx', 2n) as BucketKey
    expect(keys.liveness(old)).toBe('open')

    keys.applyControl(msg14({ type: 'unsubscribe', request_id: 0n }), 'tx', 0, 3)
    expect(keys.liveness(old)).toBe('ended')
    expect(keys.liveness(kept)).toBe('open')
  })

  it('ends a binding at a draft-20 PUBLISH_DONE on its own stream', () => {
    const keys = new TrackKeys()
    keys.applyControl(msg(publishBytes(0n, 5n)), 'rx', 1, 1)
    const k = keys.aliasKey('rx', 5n) as BucketKey
    expect(keys.liveness(k)).toBe('open')
    keys.applyControl(msg(publishDoneBytes()), 'rx', 1, 2)
    expect(keys.liveness(k)).toBe('ended')
  })

  it('ends the old epoch at a rebind, and a fetch when its stream is released', () => {
    const keys = new TrackKeys()
    keys.applyControl(msg(publishBytes(0n, 5n)), 'rx', 1, 1)
    const first = keys.aliasKey('rx', 5n) as BucketKey
    keys.closeStream(1)
    keys.applyControl(msg(publishBytes(2n, 5n)), 'rx', 2, 2)
    expect(keys.liveness(first)).toBe('ended')
    expect(keys.liveness(keys.aliasKey('rx', 5n) as BucketKey)).toBe('open')

    const f = keys.fetchKey('rx', 12n) as BucketKey
    expect(keys.liveness(f)).toBe('open')
    keys.releaseFetch('rx', 12n)
    expect(keys.liveness(f)).toBe('ended')
  })

  it('calls an alias with no request observed behind it unbound until one binds it', () => {
    // A collector armed mid-session sees neither the request nor its end.
    const keys = new TrackKeys()
    const k = keys.aliasKey('rx', 4n) as BucketKey
    expect(keys.liveness(k)).toBe('unbound')
    keys.applyControl(msg(publishBytes(0n, 4n)), 'rx', 1, 1)
    expect(keys.liveness(k)).toBe('open')
  })
})

describe('TrackKeys — the bucket cap', () => {
  it('refuses past the cap and counts the refusals rather than merging', () => {
    const keys = new TrackKeys({ maxBuckets: 3 })
    expect(keys.aliasKey('rx', 1n)).not.toBeNull()
    expect(keys.aliasKey('rx', 2n)).not.toBeNull()
    expect(keys.fetchKey('rx', 3n)).not.toBeNull()
    expect(keys.aliasKey('rx', 4n)).toBeNull()
    expect(keys.fetchKey('rx', 5n)).toBeNull()
    expect(keys.bucketCount).toBe(3)
    expect(keys.bucketsRefused).toBe(2)
  })

  it('counts a repeatedly refused id once', () => {
    const keys = new TrackKeys({ maxBuckets: 1 })
    keys.aliasKey('rx', 1n)
    for (let i = 0; i < 50; i++) expect(keys.aliasKey('rx', 2n)).toBeNull()
    expect(keys.bucketsRefused).toBe(1)
  })

  it('keeps admitting the buckets it already opened', () => {
    const keys = new TrackKeys({ maxBuckets: 1 })
    const key = keys.aliasKey('rx', 1n)
    keys.aliasKey('rx', 99n)
    expect(keys.aliasKey('rx', 1n)).toBe(key)
  })
})

describe('TrackKeys — exchange latency', () => {
  it('measures a request against the response on the same stream', () => {
    const keys = new TrackKeys()
    keys.applyControl(msg(subscribeBytes(0n)), 'tx', 5, 10)
    expect(keys.noteResponse(5, 'rx', 'subscribe', 34)).toEqual({
      kind: 'subscribe',
      latencyMs: 24,
    })
  })

  it('answers one request once', () => {
    const keys = new TrackKeys()
    keys.applyControl(msg(subscribeBytes(0n)), 'tx', 5, 10)
    expect(keys.noteResponse(5, 'rx', 'subscribe', 34)).toBeDefined()
    expect(keys.noteResponse(5, 'rx', 'subscribe', 90)).toBeUndefined()
  })

  it('does not mistake a second outgoing message for a response', () => {
    const keys = new TrackKeys()
    keys.applyControl(msg(subscribeBytes(0n)), 'tx', 5, 10)
    expect(keys.noteResponse(5, 'tx', 'subscribe', 12)).toBeUndefined()
  })

  it('pairs the two SETUPs, which are on different streams entirely', () => {
    // From draft-17 the control plane is a *pair of unidirectional streams*
    //, so the two SETUPs share no stream id and the map cannot pair
    // them.
    const keys = new TrackKeys()
    expect(keys.noteResponse(1, 'tx', 'setup', 5)).toBeUndefined()
    expect(keys.noteResponse(2, 'rx', 'setup', 20)).toEqual({ kind: 'setup', latencyMs: 15 })
    expect(keys.noteResponse(3, 'rx', 'setup', 40)).toBeUndefined()
  })

  it('reports nothing for a stream it never saw a request on', () => {
    const keys = new TrackKeys()
    expect(keys.noteResponse(9, 'rx', 'subscribe', 100)).toBeUndefined()
  })

  it('drops the pending request when its stream closes', () => {
    const keys = new TrackKeys()
    keys.applyControl(msg(subscribeBytes(0n)), 'tx', 5, 10)
    keys.closeStream(5)
    expect(keys.pendingFor(5)).toBeUndefined()
    expect(keys.pendingCount).toBe(0)
  })

  it('reads nothing but ids, aliases and the message type', () => {
    // the actual guarantee, asserted rather than asserted about: the sink
    // sees no name, namespace, status or reason phrase because nothing in this
    // class ever asks for one.
    const keys = new TrackKeys()
    keys.applyControl(msg(publishBytes(0n, 5n, 'a-track-name')), 'rx', 1, 1)
    const key = keys.aliasKey('rx', 5n) as BucketKey
    expect(Object.keys(key).sort()).toEqual(['dir', 'epoch', 'id', 'kind'])
    expect(Object.values(key).join('|')).not.toContain('a-track-name')
  })
})

describe('TrackKeys — the request behind a bucket', () => {
  it('links a subscription to the SUBSCRIBE that asked for it, through the stream', () => {
    // draft-20's SUBSCRIBE_OK carries no request id: the stream ties it back.
    const keys = new TrackKeys()
    keys.applyControl(msg(subscribeBytes(6n)), 'tx', 5, 10)
    keys.applyControl(msg(subscribeOkBytes(9n)), 'rx', 5, 30)
    expect(keys.requestFor(keys.aliasKey('rx', 9n) as BucketKey)).toEqual({ d: 'tx', v: '6' })
  })

  it('links a subscriber-chosen alias to its SUBSCRIBE, through draft-11', () => {
    const keys = new TrackKeys()
    keys.applyControl(sub11(3n, 2n), 'tx', 0, 1)
    expect(keys.requestFor(keys.aliasKey('rx', 2n) as BucketKey)).toEqual({ d: 'tx', v: '3' })
  })

  it('links a published track to the PUBLISH, sent by the side the objects come from', () => {
    const keys = new TrackKeys()
    keys.applyControl(msg(publishBytes(4n, 5n)), 'rx', 1, 1)
    expect(keys.requestFor(keys.aliasKey('rx', 5n) as BucketKey)).toEqual({ d: 'rx', v: '4' })
    keys.applyControl(msg(publishBytes(8n, 6n)), 'tx', 3, 1)
    expect(keys.requestFor(keys.aliasKey('tx', 6n) as BucketKey)).toEqual({ d: 'tx', v: '8' })
  })

  it('links a send track to the peer that subscribed to it', () => {
    const keys = new TrackKeys()
    keys.applyControl(msg(subscribeBytes(2n)), 'rx', 7, 1)
    keys.applyControl(msg(subscribeOkBytes(3n)), 'tx', 7, 2)
    expect(keys.requestFor(keys.aliasKey('tx', 3n) as BucketKey)).toEqual({ d: 'rx', v: '2' })
  })

  it('links a fetch bucket to the request its stream names', () => {
    const keys = new TrackKeys()
    expect(keys.requestFor(keys.fetchKey('rx', 12n) as BucketKey)).toEqual({ d: 'tx', v: '12' })
  })

  it('has no link for an alias no observed request bound, until one binds it', () => {
    const keys = new TrackKeys()
    const key = keys.aliasKey('rx', 5n) as BucketKey
    expect(keys.requestFor(key)).toBeUndefined()
    keys.applyControl(msg(publishBytes(4n, 5n)), 'rx', 1, 1)
    expect(keys.aliasKey('rx', 5n)).toBe(key)
    expect(keys.requestFor(key)).toEqual({ d: 'rx', v: '4' })
  })

  it('keeps the old bucket on its own request across a rebind', () => {
    const keys = new TrackKeys()
    keys.applyControl(msg(publishBytes(0n, 5n)), 'rx', 1, 1)
    const first = keys.aliasKey('rx', 5n) as BucketKey
    keys.closeStream(1)
    keys.applyControl(msg(publishBytes(2n, 5n)), 'rx', 2, 2)
    const second = keys.aliasKey('rx', 5n) as BucketKey
    expect(keys.requestFor(first)).toEqual({ d: 'rx', v: '0' })
    expect(keys.requestFor(second)).toEqual({ d: 'rx', v: '2' })
  })

  it('has no link for an alias two live requests share', () => {
    const keys = new TrackKeys()
    keys.applyControl(msg(publishBytes(0n, 5n)), 'rx', 1, 1)
    keys.applyControl(msg(publishBytes(2n, 5n)), 'rx', 2, 2)
    expect(keys.requestFor(keys.aliasKey('rx', 5n) as BucketKey)).toBeUndefined()
  })
})
