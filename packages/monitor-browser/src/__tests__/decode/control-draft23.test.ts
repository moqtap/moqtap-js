/**
 * Draft-23 control framing: a vi64 Message Length, and a frame bound set by
 * the receiver's MAX_CONTROL_MESSAGE_SIZE rather than by a 16-bit field.
 */

import { encodeMessage } from '@moqtap/codec/draft23'
import { describe, expect, it } from 'vitest'
import { ControlFramer } from '../../decode/control-framer.js'
import { StreamDispatcher } from '../../decode/dispatch.js'
import { DRAFT22_ADAPTER } from '../../drafts/draft22/index.js'
import { DRAFT23_ADAPTER } from '../../drafts/draft23/index.js'
import type { StreamChunk } from '../../types.js'
import { AscendingKeys, chunks, concatBytes, Recorder } from './vectors.js'

const setup = (max?: bigint): Uint8Array =>
  encodeMessage({
    type: 'setup',
    options: max === undefined ? { path: '/moq' } : { path: '/moq', max_control_message_size: max },
  } as Parameters<typeof encodeMessage>[0])

/** A frame of an unassigned type `0x3e` with a `body`-byte body and a three-byte vi64 Length. */
function bigFrame(body: number): Uint8Array {
  const out = new Uint8Array(4 + body)
  out[0] = 0x3e
  out[1] = 0xc0 | (body >> 16)
  out[2] = (body >> 8) & 0xff
  out[3] = body & 0xff
  return out
}

function feed(d: StreamDispatcher, streamId: number, dir: 'tx' | 'rx', bytes: Uint8Array): void {
  for (const part of chunks(bytes, 4096)) {
    const c: StreamChunk = {
      sessionId: 's',
      streamId,
      direction: dir,
      bidi: false,
      control: true,
      data: part,
      at: 1,
    }
    d.onStreamData(c)
  }
}

describe('draft-23 control framing', () => {
  it('frames a vi64 Message Length, where draft-22 reads two bytes', () => {
    // REQUEST_OK with no parameters: `07 01 00` in draft-23, `07 00 01 00` in draft-22.
    const bytes = concatBytes(setup(), new Uint8Array([0x07, 0x01, 0x00]))
    const sink = new Recorder()
    const f = new ControlFramer('rx', 1, DRAFT23_ADAPTER, sink, true, { maxBodyBytes: 65535 })
    for (const part of chunks(bytes, 1)) f.push(part, 1)
    expect(sink.control.map((c) => c.message?.type)).toEqual(['setup', 'request_ok'])
    expect(sink.control[1]?.bytes).toEqual(new Uint8Array([0x07, 0x01, 0x00]))

    const old = new Recorder()
    const g = new ControlFramer('rx', 1, DRAFT22_ADAPTER, old)
    g.push(new Uint8Array([0x07, 0x01, 0x00]), 1)
    expect(old.control).toEqual([])
  })

  it('buffers no more than the default limit before any SETUP raises it', () => {
    const sink = new Recorder()
    const d = new StreamDispatcher(DRAFT23_ADAPTER, new AscendingKeys(), sink)
    feed(d, 2, 'rx', bigFrame(100_000))
    expect(sink.reasons).toEqual(['malformed-control'])
  })

  it('takes a frame up to what the receiving endpoint advertised', () => {
    const sink = new Recorder()
    const d = new StreamDispatcher(DRAFT23_ADAPTER, new AscendingKeys(), sink)
    // This endpoint's SETUP bounds what it receives, not what it sends.
    feed(d, 1, 'tx', setup(1_048_576n))
    feed(d, 3, 'tx', bigFrame(100_000))
    expect(sink.reasons).toEqual(['malformed-control'])
    feed(d, 2, 'rx', bigFrame(100_000))
    expect(sink.control.filter((c) => c.dir === 'rx').map((c) => c.bytes.length)).toEqual([100_004])
  })

  it('refuses a frame on its declared length, before holding its body', () => {
    const sink = new Recorder()
    const f = new ControlFramer('rx', 2, DRAFT23_ADAPTER, sink, true, { maxBodyBytes: 65535 })
    f.push(bigFrame(100_000).subarray(0, 4), 1)
    expect(sink.reasons).toEqual(['malformed-control'])
    expect(f.bufferedBytes).toBe(0)
  })

  it('leaves frames handed on from a carry unchanged by later chunks', () => {
    const frames = [setup(), bigFrame(70_000), new Uint8Array([0x07, 0x01, 0x00]), bigFrame(3)]
    const kept: Uint8Array[] = []
    const sink = new Recorder()
    sink.onControlFrame = (e) => {
      kept.push(e.bytes)
    }
    const f = new ControlFramer('rx', 2, DRAFT23_ADAPTER, sink, false, { maxBodyBytes: 1 << 20 })
    for (const part of chunks(concatBytes(...frames), 4093)) f.push(part.slice(), 1)
    expect(kept).toEqual(frames)
    expect(f.bufferedBytes).toBe(0)
  })
})
