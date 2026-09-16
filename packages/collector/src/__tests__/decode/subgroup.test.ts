/**
 * The subgroup walk, against vectors the codec's own encoder produced.
 *
 * The first test is the reason this module hand-rolls: a status object in the
 * middle of a stream. `createSubgroupStreamDecoder` omits the
 * `payloadLength === 0 -> readVarInt status` branch, so everything after the
 * first status object is read one varint out of phase — silently, with
 * plausible numbers.
 */

import { decodeSubgroupStream } from '@moqtap/codec/draft20'
import { describe, expect, it } from 'vitest'
import { SubgroupCounter } from '../../decode/subgroup-counter.js'
import { TrackKeys } from '../../decode/track-key.js'
import { VI64_READER } from '../../draft/varint.js'
import type { ObjectSample } from '../../types.js'
import { chunks, filled, Recorder, type SubgroupSpec, subgroupBytes } from './vectors.js'

function count(bytes: Uint8Array, chunkSize = bytes.length, at = 100): Recorder {
  const sink = new Recorder()
  const c = new SubgroupCounter('rx', new TrackKeys(), sink, VI64_READER)
  for (const part of chunks(bytes, chunkSize)) c.push(part, at)
  c.end()
  return sink
}

function shape(objects: readonly ObjectSample[]) {
  return objects.map((o) => ({
    group: o.groupId,
    object: o.objectId,
    payload: o.payloadBytes,
    status: o.status,
  }))
}

describe('SubgroupCounter', () => {
  it('counts every object on a stream that carries a status object', () => {
    const spec: SubgroupSpec = {
      alias: 7n,
      group: 3n,
      objects: [
        { id: 0n, bytes: 10 },
        { id: 1n, bytes: 20 },
        // The object that desynchronises `createSubgroupStreamDecoder`: a zero
        // Object Payload Length puts an Object Status varint where the payload
        // would be.
        { id: 2n, bytes: 0, status: 3n },
        { id: 3n, bytes: 30 },
        { id: 9n, bytes: 5 },
      ],
    }
    const sink = count(subgroupBytes(spec))

    expect(shape(sink.objects)).toEqual([
      { group: 3n, object: 0n, payload: 10, status: undefined },
      { group: 3n, object: 1n, payload: 20, status: undefined },
      { group: 3n, object: 2n, payload: 0, status: 3n },
      { group: 3n, object: 3n, payload: 30, status: undefined },
      { group: 3n, object: 9n, payload: 5, status: undefined },
    ])
    expect(sink.reasons).toEqual([])
  })

  it('agrees with the codec one-shot decoder on ids and payload lengths', () => {
    const bytes = subgroupBytes({
      alias: 1n,
      group: 0n,
      objects: [
        { id: 0n, bytes: 4 },
        { id: 5n, bytes: 0, status: 1n },
        { id: 6n, bytes: 7 },
        { id: 40n, bytes: 0, status: 4n },
      ],
    })
    const oneShot = decodeSubgroupStream(bytes)
    expect(oneShot.ok).toBe(true)
    if (!oneShot.ok) return

    const sink = count(bytes)
    expect(sink.objects.map((o) => o.objectId)).toEqual(
      oneShot.value.objects.map((o) => o.objectId),
    )
    expect(sink.objects.map((o) => o.payloadBytes)).toEqual(
      oneShot.value.objects.map((o) => o.payloadLength),
    )
  })

  it('accounts for every byte on the stream exactly once', () => {
    const bytes = subgroupBytes({
      alias: 9n,
      group: 2n,
      headerType: 0x12, // SUBGROUP_ID_MODE 0b01: the id is the first object's.
      objects: [
        { id: 4n, bytes: 100 },
        { id: 5n, bytes: 0, status: 2n },
        { id: 6n, bytes: 1 },
      ],
    })
    const sink = count(bytes)
    // The stream header's own bytes are folded into the first object, so nothing
    // on the wire goes unattributed and bitrate stays honest.
    expect(sink.totalHeaderBytes + sink.totalPayloadBytes).toBe(bytes.length)
  })

  it('is independent of how the transport chunks the stream', () => {
    const bytes = subgroupBytes({
      alias: 12n,
      group: 1n,
      headerType: 0x11, // PROPERTIES on every object.
      objects: [
        { id: 0n, bytes: 3, props: { prior_object_id_gap: 2n } },
        { id: 1n, bytes: 0, status: 1n },
        { id: 2n, bytes: 300 },
        { id: 3n, bytes: 17, props: { prior_group_id_gap: 1n } },
      ],
    })
    const whole = shape(count(bytes).objects)
    expect(whole).toHaveLength(4)
    for (const size of [1, 2, 3, 5, 7, 11, 64, 257]) {
      expect(shape(count(bytes, size).objects), `chunk size ${size}`).toEqual(whole)
    }
  })

  it('skips payload bytes by arithmetic and never buffers them', () => {
    const bytes = subgroupBytes({ alias: 2n, group: 0n, objects: [{ id: 0n, bytes: 200_000 }] })
    const sink = new Recorder()
    const c = new SubgroupCounter('rx', new TrackKeys(), sink, VI64_READER)
    let peak = 0
    for (const part of chunks(bytes, 4096)) {
      c.push(part, 1)
      peak = Math.max(peak, c.bufferedBytes)
    }
    expect(sink.objects).toHaveLength(1)
    expect(sink.objects[0]?.payloadBytes).toBe(200_000)
    // O(1) per stream: a 200 KB object costs a byte counter, not 200 KB.
    expect(peak).toBeLessThan(64)
  })

  it('keys the bucket on the raw alias, tagged with the seam direction', () => {
    const bytes = subgroupBytes({ alias: 42n, group: 0n, objects: [{ id: 0n, bytes: 1 }] })
    const sink = new Recorder()
    const keys = new TrackKeys()
    const c = new SubgroupCounter('tx', keys, sink, VI64_READER)
    c.push(bytes, 1)
    expect(sink.objects[0]?.key).toEqual({ dir: 'tx', kind: 'alias', id: 42n, epoch: 0 })
  })

  it('abandons a stream whose Type Flags are invalid, and counts it once', () => {
    // Bit 4 clear: draft-20 §11.4.2 "Bit 4 MUST be 1 for SUBGROUP_HEADER".
    const sink = count(new Uint8Array([0x00, 0x01, 0x02, 0x00, 0x00]))
    expect(sink.reasons).toEqual(['subgroup-desync'])
    expect(sink.objects).toEqual([])
  })

  it('abandons a stream using the reserved SUBGROUP_ID_MODE 0b11', () => {
    const sink = count(new Uint8Array([0x16, 0x01, 0x02, 0x03, 0x00, 0x00]))
    expect(sink.reasons).toEqual(['subgroup-desync'])
  })

  it('reports nothing further once a stream has desynchronised', () => {
    const sink = new Recorder()
    const c = new SubgroupCounter('rx', new TrackKeys(), sink, VI64_READER)
    c.push(new Uint8Array([0x00, 0x01]), 1)
    c.push(subgroupBytes({ alias: 1n, group: 1n, objects: [{ id: 0n, bytes: 2 }] }), 2)
    expect(sink.objects).toEqual([])
    expect(sink.reasons).toEqual(['subgroup-desync'])
  })

  it('does not report a truncated stream as a parse failure', () => {
    // A reset or a STOP_SENDING truncates a well-formed stream; counting that as
    // a decode fault puts a normal event in the field that finds real ones.
    const bytes = subgroupBytes({ alias: 3n, group: 0n, objects: [{ id: 0n, bytes: 40 }] })
    const sink = new Recorder()
    const c = new SubgroupCounter('rx', new TrackKeys(), sink, VI64_READER)
    c.push(bytes.subarray(0, 6), 1)
    c.end()
    expect(sink.reasons).toEqual([])
  })

  it('treats an over-large declared Properties Length as desync, never as a buffer', () => {
    // Type Flags 0x11 (PROPERTIES), alias 1, group 1, priority, then object id
    // delta 0 and a Properties Length of 2^30 — a length no header can have.
    const head = new Uint8Array([0x11, 0x01, 0x01, 0x80])
    const propsLen = new Uint8Array([0xf0, 0x40, 0x00, 0x00, 0x00]) // vi64 0x40000000
    const bytes = new Uint8Array(head.length + 1 + propsLen.length)
    bytes.set(head, 0)
    bytes[head.length] = 0x00 // Object ID Delta = 0
    bytes.set(propsLen, head.length + 1)

    const sink = new Recorder()
    const c = new SubgroupCounter('rx', new TrackKeys(), sink, VI64_READER)
    c.push(bytes, 1)
    c.push(filled(4096), 2)
    expect(sink.reasons).toEqual(['subgroup-desync'])
    expect(c.bufferedBytes).toBe(0)
  })
})
