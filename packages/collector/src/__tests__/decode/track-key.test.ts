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
