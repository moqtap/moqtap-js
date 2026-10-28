/**
 * Manual control framing.
 *
 * The test that matters is the third one: an unknown Message Type between two
 * known ones. The codec's `createStreamDecoder` calls `controller.error()` on
 * `UNKNOWN_MESSAGE_TYPE`, which kills control
 * decoding for the whole session — and on a baseline session the control bytes
 * are the only thing ingest reparses to recover names, namespaces and statuses
 * One codepoint a peer is allowed to send would cost every name in
 * the session.
 */

import { describe, expect, it } from 'vitest'
import { ControlFramer, MAX_CONTROL_FRAME_BYTES } from '../../decode/control-framer.js'
import {
  chunks,
  concatBytes,
  DRAFT20_ADAPTER,
  encodeControl,
  publishBytes,
  Recorder,
  subscribeBytes,
  subscribeOkBytes,
  unknownControlFrame,
} from './vectors.js'

function frame(bytes: Uint8Array, chunkSize = bytes.length): Recorder {
  const sink = new Recorder()
  const f = new ControlFramer('rx', 7, DRAFT20_ADAPTER, sink)
  for (const part of chunks(bytes, chunkSize)) f.push(part, 42)
  return sink
}

const SETUP = encodeControl({ type: 'setup', options: { path: '/moqtap' } })

describe('ControlFramer', () => {
  it('cuts a byte stream into exact frames and decodes each', () => {
    const parts = [SETUP, subscribeBytes(0n), subscribeOkBytes(9n)]
    const sink = frame(concatBytes(...parts))

    expect(sink.control.map((c) => c.message?.type)).toEqual(['setup', 'subscribe', 'subscribe_ok'])
    // Byte-exact: ingest reparses these, so a frame that is off by one byte is a
    // frame ingest cannot read.
    expect(sink.control.map((c) => Array.from(c.bytes))).toEqual(parts.map((p) => Array.from(p)))
    expect(sink.reasons).toEqual([])
  })

  it('stamps the seam direction, the stream id and the arrival time', () => {
    const sink = frame(subscribeBytes(2n))
    expect(sink.control[0]?.dir).toBe('rx')
    expect(sink.control[0]?.streamId).toBe(7)
    expect(sink.control[0]?.at).toBe(42)
  })

  it('counts an unknown codepoint and keeps framing the stream', () => {
    const sink = frame(concatBytes(subscribeBytes(0n), unknownControlFrame(), subscribeOkBytes(1n)))

    expect(sink.control).toHaveLength(3)
    expect(sink.control[1]?.message).toBeNull()
    // The frame is still shipped raw, whole and in order, because ingest can
    // parse a codepoint this collector's codec has never heard of.
    expect(sink.control[1]?.bytes).toEqual(unknownControlFrame())
    // And the stream survives it, which `createStreamDecoder` does not.
    expect(sink.control[2]?.message?.type).toBe('subscribe_ok')
    expect(sink.reasons).toEqual(['unknown-message-type'])
  })

  it('is independent of how the transport chunks the stream', () => {
    const bytes = concatBytes(
      SETUP,
      subscribeBytes(0n),
      unknownControlFrame(),
      publishBytes(2n, 8n),
    )
    const whole = frame(bytes).control.map((c) => Array.from(c.bytes))
    expect(whole).toHaveLength(4)
    for (const size of [1, 2, 3, 5, 9, 17, 64]) {
      expect(
        frame(bytes, size).control.map((c) => Array.from(c.bytes)),
        `chunk size ${size}`,
      ).toEqual(whole)
    }
  })

  it('holds only an incomplete frame across a boundary, and nothing at one', () => {
    const bytes = concatBytes(subscribeBytes(0n), subscribeOkBytes(3n))
    const sink = new Recorder()
    const f = new ControlFramer('tx', 1, DRAFT20_ADAPTER, sink)
    let peak = 0
    for (const part of chunks(bytes, 3)) {
      f.push(part, 1)
      peak = Math.max(peak, f.bufferedBytes)
    }
    expect(sink.control).toHaveLength(2)
    expect(f.bufferedBytes).toBe(0)
    expect(peak).toBeLessThan(MAX_CONTROL_FRAME_BYTES)
    expect(peak).toBeLessThan(bytes.length)
  })

  it('does not report a truncated final frame as a failure', () => {
    const bytes = subscribeBytes(0n)
    const sink = new Recorder()
    const f = new ControlFramer('rx', 1, DRAFT20_ADAPTER, sink)
    f.push(bytes.subarray(0, bytes.length - 2), 1)
    f.end()
    expect(sink.control).toEqual([])
    expect(sink.reasons).toEqual([])
  })

  it('emits nothing after end()', () => {
    const sink = new Recorder()
    const f = new ControlFramer('rx', 1, DRAFT20_ADAPTER, sink)
    f.end()
    f.push(subscribeBytes(0n), 1)
    expect(sink.control).toEqual([])
  })

  it('frames a zero-length message body', () => {
    // A frame that is nothing but its own header — four bytes, Message Length 0
    // — is where an off-by-one in the framer shows up as a stalled stream.
    const empty = unknownControlFrame(new Uint8Array(0))
    expect(empty).toHaveLength(4)
    const sink = frame(concatBytes(empty, subscribeBytes(0n)))
    expect(sink.control).toHaveLength(2)
    expect(sink.control[0]?.bytes).toEqual(empty)
    expect(sink.control[1]?.message?.type).toBe('subscribe')
  })
})
