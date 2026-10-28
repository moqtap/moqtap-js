/**
 * Control-plane detection and per-session stream ids.
 *
 * The rule is `bidi === true || opensUniControlStream(firstChunk)`, and every
 * way of getting it wrong is **silent** — none throws, and all produce a session
 * that looks healthy:
 *
 *  - Testing `bidi` alone misfiles the ENTIRE control plane as bulk media on
 *    every draft this package supports, because from draft-17 the control
 *    plane is a *pair of unidirectional streams*.
 *  - Writing the prefix as `6f 00` (what an RFC 9000 varint would produce for
 *    SETUP's `0x2F00`) matches nothing and misfiles the control plane the same
 *    way; the extension ships exactly that in an untested second copy of the
 *    constant (`extension/src/detect/uni-control-prefix.ts`).
 *  - Rejecting `Uint8Array` — which the extension's `opensUniControlStream`
 *    does, `if (!(data instanceof ArrayBuffer)) return false` — misfiles it
 *    again, because the seam hands out `Uint8Array`.
 *  - Deciding from a first chunk shorter than the prefix freezes a wrong
 *    answer for the life of the stream.
 */

import { describe, expect, it } from 'vitest'
import {
  isControlPlane,
  opensUniControlStream,
  StreamRegistry,
  UNI_CONTROL_STREAM_PREFIX,
} from '../../transport/index.js'
import { bytes, SETUP_PREFIX } from './mocks.js'

describe('UNI_CONTROL_STREAM_PREFIX', () => {
  it('is MoQT varint af 00, not RFC 9000 6f 00', () => {
    // SETUP is type 0x2F00. Draft-17 §1.4.1 replaced the RFC 9000 integer with
    // MoQT's leading-ones varint, so the two bytes are af 00. Reading it the
    // other way round yields a plausible number rather than an error.
    expect([...UNI_CONTROL_STREAM_PREFIX]).toEqual([0xaf, 0x00])
    expect(UNI_CONTROL_STREAM_PREFIX[0]).not.toBe(0x6f)
  })
})

describe('opensUniControlStream', () => {
  it('accepts a Uint8Array — the form the seam actually produces', () => {
    // The extension's version starts `if (!(data instanceof ArrayBuffer))
    // return false` while its hook emits Uint8Array, so wiring the two
    // together filed every draft-17+ control stream as bulk media.
    expect(opensUniControlStream(bytes(0xaf, 0x00, 0x01))).toBe(true)
  })

  it('accepts an ArrayBuffer', () => {
    expect(opensUniControlStream(Uint8Array.from([0xaf, 0x00]).buffer)).toBe(true)
  })

  it('reads a view at its own byteOffset, not the start of its buffer', () => {
    // A chunk delivered by a stream is routinely a view into a larger buffer.
    // Reading from offset 0 would answer for somebody else's bytes.
    const backing = bytes(0x11, 0x22, 0xaf, 0x00)
    expect(opensUniControlStream(backing.subarray(2))).toBe(true)
    expect(opensUniControlStream(backing.subarray(0, 2))).toBe(false)
  })

  it('accepts any ArrayBufferView, not only Uint8Array', () => {
    const view = new DataView(Uint8Array.from([0xaf, 0x00]).buffer)
    expect(opensUniControlStream(view as unknown as Uint8Array)).toBe(true)
  })

  it('rejects the RFC 9000 spelling of the same message type', () => {
    expect(opensUniControlStream(bytes(0x6f, 0x00))).toBe(false)
  })

  it('rejects a first chunk shorter than the prefix', () => {
    expect(opensUniControlStream(bytes(0xaf))).toBe(false)
    expect(opensUniControlStream(bytes())).toBe(false)
  })

  it('answers false for anything that is not bytes at all', () => {
    // Every argument here came from page-controlled code.
    expect(opensUniControlStream(null as unknown as Uint8Array)).toBe(false)
    expect(opensUniControlStream('af00' as unknown as Uint8Array)).toBe(false)
    expect(opensUniControlStream({ 0: 0xaf, 1: 0x00 } as unknown as Uint8Array)).toBe(false)
  })

  it('rejects a subgroup header that merely starts with 0xaf', () => {
    expect(opensUniControlStream(bytes(0xaf, 0x01))).toBe(false)
  })
})

describe('isControlPlane', () => {
  it('is not `bidi` alone: a draft-17+ uni SETUP stream is control', () => {
    // The whole reason this function exists. A boolean-only test returns false
    // here and the entire control plane is counted as bulk.
    expect(isControlPlane(false, SETUP_PREFIX)).toBe(true)
  })

  it('treats every bidirectional stream as control', () => {
    // Drafts 07-16 put the control plane on a bidi stream outright; 17+ open
    // one bidi stream per request, which is still control traffic.
    expect(isControlPlane(true, bytes(0x10, 0x00))).toBe(true)
    expect(isControlPlane(true, bytes())).toBe(true)
  })

  it('treats a unidirectional data stream as bulk', () => {
    // 0x10 is a subgroup header type in draft-20.
    expect(isControlPlane(false, bytes(0x10, 0x02, 0x00))).toBe(false)
  })
})

describe('StreamRegistry — ids', () => {
  it('numbers streams per session, from zero', () => {
    // The extension allocates one counter per INSTALL (`webtransport-hook.ts`),
    // so a session's ids depend on how many streams every other session on the
    // page opened first — while `StreamChunk.streamId` is documented as
    // meaningful within one session and the pending-request map is per session.
    const a = new StreamRegistry('s1')
    const b = new StreamRegistry('s2')
    expect(a.next(true, 'local')).toBe(0)
    expect(a.next(false, 'local')).toBe(1)
    expect(b.next(false, 'remote')).toBe(0)
    expect(a.next(false, 'remote')).toBe(2)
  })

  it('classifies a bidirectional stream at allocation, with no bytes', () => {
    const r = new StreamRegistry('s1')
    const id = r.next(true, 'local')
    expect(r.isControl(id)).toBe(true)
  })

  it('leaves a unidirectional stream unclassified until bytes arrive', () => {
    const r = new StreamRegistry('s1')
    const id = r.next(false, 'remote')
    expect(r.isControl(id)).toBe(false)
  })
})

describe('StreamRegistry — sticky classification', () => {
  it('classifies a uni stream from its first bytes', () => {
    const r = new StreamRegistry('s1')
    const id = r.next(false, 'remote')
    expect(r.classify(id, false, bytes(0xaf, 0x00, 0x02))).toBe(true)
    expect(r.isControl(id)).toBe(true)
  })

  it('keeps the first answer when a later chunk starts af 00', () => {
    // `af 00` in the middle of a stream is object payload, not a SETUP.
    const r = new StreamRegistry('s1')
    const id = r.next(false, 'remote')
    expect(r.classify(id, false, bytes(0x10, 0x02))).toBe(false)
    expect(r.classify(id, false, bytes(0xaf, 0x00))).toBe(false)
    expect(r.isControl(id)).toBe(false)
  })

  it('keeps a control answer when later chunks look like anything else', () => {
    const r = new StreamRegistry('s1')
    const id = r.next(false, 'remote')
    expect(r.classify(id, false, SETUP_PREFIX)).toBe(true)
    expect(r.classify(id, false, bytes(0x10, 0x02))).toBe(true)
  })

  it('waits for two bytes rather than freezing a guess on a one-byte chunk', () => {
    // Nothing guarantees the first chunk is longer than one byte. Deciding
    // from `af` alone would file the control plane as bulk for the whole
    // stream, and stickily.
    const r = new StreamRegistry('s1')
    const id = r.next(false, 'remote')
    expect(r.classify(id, false, bytes(0xaf))).toBe(false)
    expect(r.classify(id, false, bytes(0x00))).toBe(true)
    expect(r.isControl(id)).toBe(true)
  })

  it('accumulates across an empty chunk', () => {
    const r = new StreamRegistry('s1')
    const id = r.next(false, 'remote')
    expect(r.classify(id, false, bytes(0xaf))).toBe(false)
    expect(r.classify(id, false, bytes())).toBe(false)
    expect(r.classify(id, false, bytes(0x00, 0x2f))).toBe(true)
  })

  it('classifies a bidi stream as control even on a first chunk that is not SETUP', () => {
    const r = new StreamRegistry('s1')
    const id = 7
    expect(r.classify(id, true, bytes(0x10, 0x02))).toBe(true)
  })

  it('forgets a closed stream and never reuses its id', () => {
    const r = new StreamRegistry('s1')
    const id = r.next(false, 'remote')
    r.classify(id, false, SETUP_PREFIX)
    expect(r.tracked).toBe(1)
    r.close(id)
    expect(r.tracked).toBe(0)
    expect(r.isControl(id)).toBe(false)
    expect(r.next(false, 'remote')).toBe(1)
  })

  it('answers false for a stream it has never seen', () => {
    const r = new StreamRegistry('s1')
    expect(r.isControl(99)).toBe(false)
  })
})
