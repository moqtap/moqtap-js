/**
 * The buffer that holds a realm's control plane until a session attaches.
 *
 * Three properties, each of which a session's first seconds depend on:
 *
 *  1. **What is replayed is a prefix.** A control framer fed a stream with a
 *     hole in it reads garbage from the hole on, so once a chunk is refused
 *     every later control chunk of that connection is refused too, and the
 *     halves it cut are named for the session to skip.
 *  2. **The bounds hold**, per connection and per realm, and every refused
 *     chunk is counted.
 *  3. **Object data is counted, never held**, and its halves are named so the
 *     session does not decode a stream from its middle.
 */

import { describe, expect, it } from 'vitest'
import {
  EARLY_CONTROL_CONNECTION_BYTES,
  EARLY_CONTROL_REALM_BYTES,
  EarlyBuffer,
} from '../../api/early.js'
import type { StreamChunk } from '../../types.js'

const KB = 1024

function chunk(
  sessionId: string,
  streamId: number,
  size: number,
  over: Partial<StreamChunk> = {},
): StreamChunk {
  return {
    sessionId,
    streamId,
    direction: 'rx',
    bidi: true,
    control: true,
    data: new Uint8Array(size).fill(streamId & 0xff),
    at: 0,
    ...over,
  }
}

describe('the held control plane', () => {
  it('holds a copy, not the page’s view', () => {
    const b = new EarlyBuffer()
    const c = chunk('s1', 0, 4)
    b.onStream(c)
    c.data.fill(0xff)
    const held = b.take().get('s1')
    expect(held?.control.map((h) => [...h.data])).toEqual([[0, 0, 0, 0]])
  })

  it('stops a connection at its bound and counts every refused chunk', () => {
    const b = new EarlyBuffer()
    const per = 16 * KB
    for (let i = 0; i < 6; i += 1) b.onStream(chunk('s1', 0, per))
    // A later stream of the same connection is refused too: the replay is a
    // prefix of the whole control plane, not of each stream.
    b.onStream(chunk('s1', 4, 8))
    expect(b.controlBytes).toBe(EARLY_CONTROL_CONNECTION_BYTES)

    const held = b.take().get('s1')
    expect(held?.control).toHaveLength(EARLY_CONTROL_CONNECTION_BYTES / per)
    expect(held?.dropped).toBe(3)
    expect([...(held?.skip ?? [])].sort()).toEqual(['0/rx', '4/rx'])
  })

  it('stops every connection at the realm’s bound', () => {
    const b = new EarlyBuffer()
    const conns = EARLY_CONTROL_REALM_BYTES / EARLY_CONTROL_CONNECTION_BYTES + 1
    for (let i = 0; i < conns; i += 1) {
      for (let j = 0; j < 4; j += 1) b.onStream(chunk(`s${i}`, 0, 16 * KB))
    }
    expect(b.controlBytes).toBe(EARLY_CONTROL_REALM_BYTES)
    const taken = b.take()
    expect(taken.get(`s${conns - 1}`)).toMatchObject({ control: [], dropped: 4 })
    expect(taken.get('s0')?.dropped).toBe(0)
  })

  it('frees a connection’s bytes when it closes before any session saw it', () => {
    const b = new EarlyBuffer()
    b.onStream(chunk('s1', 0, 1000))
    b.onStream(chunk('s2', 0, 500))
    b.forget('s1')
    expect(b.controlBytes).toBe(500)
    expect([...b.take().keys()]).toEqual(['s2'])
  })

  it('holds nothing once released, or once taken', () => {
    const released = new EarlyBuffer()
    released.onStream(chunk('s1', 0, 100))
    released.release()
    expect(released.controlBytes).toBe(0)
    released.onStream(chunk('s1', 0, 100))
    expect(released.controlBytes).toBe(0)
    expect(released.take().size).toBe(0)

    const taken = new EarlyBuffer()
    taken.onStream(chunk('s1', 0, 100))
    expect(taken.take().size).toBe(1)
    taken.onStream(chunk('s1', 0, 100))
    expect(taken.take().size).toBe(0)
  })
})

describe('object data before the session', () => {
  it('is counted and its halves named, never held', () => {
    const b = new EarlyBuffer()
    b.onStream(chunk('s1', 3, 1200, { control: false, bidi: false }))
    b.onStream(chunk('s1', 3, 800, { control: false, bidi: false }))
    b.onDatagram('s1', 90)
    expect(b.controlBytes).toBe(0)
    const held = b.take().get('s1')
    expect(held).toMatchObject({ control: [], dropped: 0, dataChunks: 3, dataBytes: 2090 })
    expect([...(held?.skip ?? [])]).toEqual(['3/rx'])
  })

  it('needs no skipping once its stream has ended', () => {
    const b = new EarlyBuffer()
    b.onStream(chunk('s1', 3, 10, { control: false, bidi: false }))
    b.onStream(chunk('s1', 5, 10, { control: false, bidi: false }))
    b.onStreamClose('s1', 3)
    expect([...(b.take().get('s1')?.skip ?? [])]).toEqual(['5/rx'])
  })
})
