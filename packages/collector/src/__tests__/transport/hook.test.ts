/**
 * The WebTransport seam. Each defect the extraction fixes gets a test that
 * FAILS against the extension's version:
 *
 *  1. **`pipeTo` / `pipeThrough` / `tee` / `for await` bypassed the seam.** A
 *     patch on the stream instance's `getReader` is never consulted by any of
 *     those four — they acquire their reader through an internal spec operation
 *     — so a player written with `pipeTo` or `for await` reported a perfectly
 *     healthy session carrying no data at all. `pipeTo`'s *destination* is
 *     worse: nothing on a `WritableStream` is called when someone pipes into it,
 *     so there is nothing on the instance to patch. The first test below
 *     re-verifies that bypass against the platform itself, so the rest of the
 *     file is not resting on an inherited claim.
 *  2. **`uninstall` left every per-instance patch live**, so `abort()` — "the
 *     reason for stopping is that you no longer want the data to leave the
 *     device" — kept reporting on every session opened before the call.
 *  3. **No double-install guard**, so a second install captured the patched
 *     constructor as "the original" and one uninstall left the page wrapped
 *     forever.
 *  4. **Stream ids were per install, session ids were `Date.now()` + counter.**
 *     The session id feeds `sha256(sessionId:segmentSeq)` and ingest dedupes
 *     exactly, so a collision is a silently discarded session.
 *  5. **The datagram interceptor was installed only if the observer already
 *     wanted datagrams**, evaluated at construction — and the hook installs
 *     dormant, with no observer, so the check always failed.
 *
 * Deliberately NOT asserted: that the hook is fast. An assertion on wall-clock
 * time here would be a flaky test of the CI runner. What is asserted instead is
 * the property that makes the budget reachable — every emit is synchronous,
 * bounded, and happens before the page's own write reaches the transport.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { installWebTransportHook, type TransportHook } from '../../transport/index.js'
import type {
  DatagramChunk,
  InterceptedSession,
  Mono,
  StreamChunk,
  StreamOrigin,
  TransportObserver,
  WriterPressure,
} from '../../types.js'
import {
  asAsyncIterable,
  bytes,
  collectingWritable,
  connect,
  drain,
  MockWebTransport,
  mockGlobal,
  SETUP_PREFIX,
  settle,
} from './mocks.js'

/* ── recording observer ──────────────────────────────────────────────────── */

interface Recorder {
  readonly observer: TransportObserver
  readonly sessions: InterceptedSession[]
  readonly protocols: Array<{ sessionId: string; protocol: string }>
  readonly sessionCloses: Array<{ sessionId: string; reason: string; at: Mono }>
  readonly opens: Array<{
    sessionId: string
    streamId: number
    bidi: boolean
    origin: StreamOrigin
  }>
  readonly data: StreamChunk[]
  readonly streamCloses: Array<{ streamId: number; at: Mono }>
  readonly streamErrors: Array<{ streamId: number; error: unknown }>
  readonly datagrams: DatagramChunk[]
  readonly pressure: WriterPressure[]
  readonly sendStats: Array<{ streamId: number; bytesAcknowledged: number }>
}

function recorder(): Recorder {
  const r: Recorder = {
    sessions: [],
    protocols: [],
    sessionCloses: [],
    opens: [],
    data: [],
    streamCloses: [],
    streamErrors: [],
    datagrams: [],
    pressure: [],
    sendStats: [],
    observer: {
      onSessionOpen: (s) => r.sessions.push(s),
      onSessionProtocol: (sessionId, protocol) => r.protocols.push({ sessionId, protocol }),
      onSessionClose: (sessionId, reason, at) => r.sessionCloses.push({ sessionId, reason, at }),
      onStreamOpen: (sessionId, streamId, bidi, origin) =>
        r.opens.push({ sessionId, streamId, bidi, origin }),
      // `StreamChunk.data` is a borrowed view onto the page's own buffer and is
      // valid only for the duration of the call, so the recorder copies — the
      // same discipline every real consumer owes.
      onStreamData: (c) => r.data.push({ ...c, data: new Uint8Array(c.data) }),
      onStreamClose: (_sessionId, streamId, at) => r.streamCloses.push({ streamId, at }),
      onStreamError: (_sessionId, streamId, error) => r.streamErrors.push({ streamId, error }),
      onDatagram: (c) => r.datagrams.push({ ...c, data: new Uint8Array(c.data) }),
      onWriterPressure: (p) => r.pressure.push(p),
      onSendStats: (_sessionId, streamId, bytesAcknowledged) =>
        r.sendStats.push({ streamId, bytesAcknowledged }),
    },
  }
  return r
}

/** Every hook this file installs, torn down after each test. */
const live: TransportHook[] = []

function install(
  glob: { WebTransport?: unknown },
  observer: TransportObserver | null,
  options?: Parameters<typeof installWebTransportHook>[2],
): TransportHook {
  const hook = installWebTransportHook(glob, observer, options)
  live.push(hook)
  return hook
}

afterEach(() => {
  // The `pipeTo` guard patches the real `ReadableStream.prototype`, so a leaked
  // hook would follow the suite into the next file.
  while (live.length > 0) live.pop()?.uninstall()
})

const chunksOf = (r: Recorder): Uint8Array[] => r.data.map((c) => c.data)

/* ═══════════════════════════════════════════════════════════════════════════
 * The premise: what the extension's seam actually misses
 * ═══════════════════════════════════════════════════════════════════════════ */

describe('the bypass this module exists to fix', () => {
  it('pipeTo, pipeThrough, tee and for-await never call a patched getReader', async () => {
    // This is the extension's entire readable seam, reproduced in four lines,
    // measured against the platform's own streams. Every route below delivers
    // every chunk while calling it zero times — so a customer whose player
    // uses any of them reports a healthy session with no data at all.
    const patched = (): { rs: ReadableStream<Uint8Array>; calls: () => number } => {
      let calls = 0
      const rs = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(bytes(1))
          c.enqueue(bytes(2))
          c.close()
        },
      })
      const orig = rs.getReader.bind(rs)
      Object.defineProperty(rs, 'getReader', {
        configurable: true,
        writable: true,
        value: (...a: unknown[]) => {
          calls++
          return (orig as (...a: unknown[]) => ReadableStreamDefaultReader<Uint8Array>)(...a)
        },
      })
      return { rs, calls: () => calls }
    }

    const piped = patched()
    const sink = collectingWritable()
    await piped.rs.pipeTo(sink.stream)
    expect(sink.written).toHaveLength(2)
    expect(piped.calls()).toBe(0)

    const through = patched()
    const out = await drain(through.rs.pipeThrough(new TransformStream<Uint8Array, Uint8Array>()))
    expect(out).toHaveLength(2)
    expect(through.calls()).toBe(0)

    const teed = patched()
    const [a, b] = teed.rs.tee()
    await Promise.all([drain(a), drain(b)])
    expect(teed.calls()).toBe(0)

    const iterated = patched()
    const seen: Uint8Array[] = []
    for await (const c of asAsyncIterable(iterated.rs)) seen.push(c)
    expect(seen).toHaveLength(2)
    expect(iterated.calls()).toBe(0)
  })

  it('piping into a writable never calls its patched getWriter', async () => {
    // The destination half cannot be fixed on the instance at all: the pipe
    // acquires its writer through AcquireWritableStreamDefaultWriter(dest).
    const sink = collectingWritable()
    let calls = 0
    const orig = sink.stream.getWriter.bind(sink.stream)
    Object.defineProperty(sink.stream, 'getWriter', {
      configurable: true,
      writable: true,
      value: () => {
        calls++
        return orig()
      },
    })
    const src = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(bytes(1))
        c.close()
      },
    })
    await src.pipeTo(sink.stream)
    expect(sink.written).toHaveLength(1)
    expect(calls).toBe(0)
  })
})

/* ═══════════════════════════════════════════════════════════════════════════
 * Installation and uninstall
 * ═══════════════════════════════════════════════════════════════════════════ */

describe('installation', () => {
  it('replaces the constructor and reports itself installed', () => {
    const glob = mockGlobal()
    const original = glob.WebTransport
    const hook = install(glob, recorder().observer)
    expect(glob.WebTransport).not.toBe(original)
    expect(hook.installed).toBe(true)
  })

  it('keeps instanceof and the constructor name working', () => {
    const glob = mockGlobal()
    install(glob, recorder().observer)
    const wt = connect(glob)
    expect(wt).toBeInstanceOf(MockWebTransport)
    expect((glob.WebTransport as { name: string }).name).toBe('WebTransport')
  })

  it('is inert on a global without WebTransport (a worker with no support)', () => {
    const glob: { WebTransport?: unknown } = {}
    const hook = installWebTransportHook(glob, recorder().observer)
    expect(hook.installed).toBe(false)
    expect(() => hook.setObserver(null)).not.toThrow()
    expect(() => hook.uninstall()).not.toThrow()
    expect(glob.WebTransport).toBeUndefined()
  })

  it('a second install returns the first hook and never captures the patch as the original', () => {
    // Defect 3. Without the guard the second install stores the PATCHED
    // constructor as "original" and one uninstall leaves the page wrapped for
    // the life of the document.
    const glob = mockGlobal()
    const original = glob.WebTransport
    const first = recorder()
    const second = recorder()
    const h1 = install(glob, first.observer)
    const patched = glob.WebTransport
    const h2 = install(glob, second.observer)

    expect(h2).toBe(h1)
    expect(glob.WebTransport).toBe(patched)

    connect(glob)
    expect(second.sessions).toHaveLength(1)
    expect(first.sessions).toHaveLength(0)

    h2.uninstall()
    expect(glob.WebTransport).toBe(original)
  })

  it('restores the global and is idempotent', () => {
    const glob = mockGlobal()
    const original = glob.WebTransport
    const hook = install(glob, recorder().observer)
    hook.uninstall()
    expect(glob.WebTransport).toBe(original)
    expect(hook.installed).toBe(false)
    expect(() => hook.uninstall()).not.toThrow()
    expect(glob.WebTransport).toBe(original)
  })

  it('restores ReadableStream.prototype.pipeTo', () => {
    const before = ReadableStream.prototype.pipeTo
    const glob = mockGlobal()
    const hook = install(glob, recorder().observer)
    expect(ReadableStream.prototype.pipeTo).not.toBe(before)
    hook.uninstall()
    expect(ReadableStream.prototype.pipeTo).toBe(before)
  })

  it('leaves an unhooked pipe alone while the guard is installed', async () => {
    const glob = mockGlobal()
    const rec = recorder()
    install(glob, rec.observer)
    const sink = collectingWritable()
    await new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(bytes(7))
        c.close()
      },
    }).pipeTo(sink.stream)
    expect(sink.written).toEqual([bytes(7)])
    expect(rec.data).toHaveLength(0)
  })
})

describe('uninstall detaches per-instance patches (defect 2)', () => {
  it('stops reporting on a session opened before the call', async () => {
    const glob = mockGlobal()
    const rec = recorder()
    const hook = install(glob, rec.observer)
    const wt = connect(glob)
    const stream = await wt.createBidirectionalStream()
    const writer = stream.writable.getWriter()
    await writer.write(bytes(1))
    expect(rec.data).toHaveLength(1)

    hook.uninstall()
    await writer.write(bytes(2))

    // The extension restores only glob.WebTransport, so this second write
    // still reported — on a session the customer called abort() to silence.
    expect(rec.data).toHaveLength(1)
    // And the page is untouched either way.
    expect(stream.out.written).toEqual([bytes(1), bytes(2)])
  })

  it('removes the patched properties themselves, not just the observer', async () => {
    const glob = mockGlobal()
    const hook = install(glob, recorder().observer)
    const wt = connect(glob)
    const queue = wt.incomingUnidirectionalStreams
    const stream = await wt.createBidirectionalStream()
    expect(Object.hasOwn(queue, 'getReader')).toBe(true)
    expect(Object.hasOwn(stream.writable, 'getWriter')).toBe(true)

    hook.uninstall()

    // A patched method that stays behind is observable to the page by identity
    // and keeps a reference to the collector alive.
    expect(Object.hasOwn(queue, 'getReader')).toBe(false)
    expect(Object.hasOwn(stream.writable, 'getWriter')).toBe(false)
    expect(Object.hasOwn(wt, 'createBidirectionalStream')).toBe(false)
  })

  it('stops reporting on streams created after the call', async () => {
    const glob = mockGlobal()
    const rec = recorder()
    const hook = install(glob, rec.observer)
    const wt = connect(glob)
    hook.uninstall()
    const stream = await wt.createBidirectionalStream()
    await stream.writable.getWriter().write(bytes(9))
    expect(rec.data).toHaveLength(0)
    expect(stream.out.written).toEqual([bytes(9)])
  })
})

/* ═══════════════════════════════════════════════════════════════════════════
 * Session capture
 * ═══════════════════════════════════════════════════════════════════════════ */

describe('session capture', () => {
  it('reports the URL as a string so the record stays structured-cloneable', () => {
    const glob = mockGlobal()
    const rec = recorder()
    install(glob, rec.observer)
    connect(glob, new URL('https://relay.example.com/moq'))
    expect(rec.sessions).toHaveLength(1)
    expect(rec.sessions[0]!.url).toBe('https://relay.example.com/moq')
    // A URL instance would throw DataCloneError and the session would never be
    // reported at all.
    expect(() => structuredClone({ ...rec.sessions[0] })).not.toThrow()
  })

  it('anchors both clocks at session start', () => {
    const glob = mockGlobal()
    const rec = recorder()
    let mono = 1234.5
    install(glob, rec.observer, {
      clock: { now: () => mono, wall: () => 1_700_000_000_000 },
    })
    connect(glob)
    expect(rec.sessions[0]!.anchor).toEqual({
      originMono: 1234.5,
      originWall: 1_700_000_000_000,
    })
    mono = 2000
    connect(glob)
    expect(rec.sessions[1]!.anchor.originMono).toBe(2000)
  })

  it('mints distinct session ids and takes an override (defect 4)', () => {
    const glob = mockGlobal()
    const rec = recorder()
    install(glob, rec.observer)
    connect(glob)
    connect(glob)
    expect(rec.sessions[0]!.id).not.toBe(rec.sessions[1]!.id)
    // `wt-${Date.now()}-${counter}` collides across two tabs in the same
    // millisecond, and the id feeds sha256(sessionId:segmentSeq).
    expect(rec.sessions[0]!.id).not.toMatch(/^wt-\d+-\d+$/)

    const glob2 = mockGlobal()
    const rec2 = recorder()
    let n = 0
    install(glob2, rec2.observer, { sessionId: () => `fixed-${++n}` })
    connect(glob2)
    expect(rec2.sessions[0]!.id).toBe('fixed-1')
  })

  it('falls back when the supplied session-id minter throws', () => {
    const glob = mockGlobal()
    const rec = recorder()
    const onInternalError = vi.fn()
    install(glob, rec.observer, {
      sessionId: () => {
        throw new Error('no entropy')
      },
      onInternalError,
    })
    connect(glob)
    expect(rec.sessions).toHaveLength(1)
    expect(rec.sessions[0]!.id.length).toBeGreaterThan(0)
    expect(onInternalError).toHaveBeenCalled()
  })

  it('keeps the offered protocols and counts the certificate hashes', () => {
    const glob = mockGlobal()
    const rec = recorder()
    install(glob, rec.observer)
    connect(glob, 'https://relay.test/moq', {
      protocols: ['moqt-19', 'moqt-20'],
      congestionControl: 'throughput',
      allowPooling: false,
      requireUnreliable: true,
      serverCertificateHashes: [{ algorithm: 'sha-256', value: new Uint8Array(32).fill(7) }],
    })
    expect(rec.sessions[0]!.options).toEqual({
      protocols: ['moqt-19', 'moqt-20'],
      congestionControl: 'throughput',
      allowPooling: false,
      requireUnreliable: true,
      // Counted, never carried: the one field in the bag with any chance of
      // being sensitive.
      serverCertificateHashes: 1,
    })
  })

  it('survives a throwing getter on the options bag', () => {
    const glob = mockGlobal()
    const rec = recorder()
    install(glob, rec.observer)
    const hostile = Object.defineProperty({}, 'protocols', {
      get() {
        throw new Error('nope')
      },
    }) as Record<string, unknown>
    expect(() => connect(glob, 'https://relay.test/moq', hostile)).not.toThrow()
    expect(rec.sessions).toHaveLength(1)
    expect(rec.sessions[0]!.options).toBeUndefined()
  })

  it('reports no options when the caller passed none', () => {
    const glob = mockGlobal()
    const rec = recorder()
    install(glob, rec.observer)
    connect(glob)
    expect(rec.sessions[0]!.options).toBeUndefined()
  })
})

describe('negotiated protocol', () => {
  it('reports the server’s pick only once ready has resolved', async () => {
    const glob = mockGlobal()
    const rec = recorder()
    install(glob, rec.observer)
    const wt = connect(glob, 'https://relay.test/moq', { protocols: ['moqt-20'] })
    // Before ready the attribute is the empty string; reporting that would say
    // the server picked nothing.
    expect(rec.protocols).toHaveLength(0)
    await wt.open('moqt-20')
    await settle()
    expect(rec.protocols).toEqual([{ sessionId: rec.sessions[0]!.id, protocol: 'moqt-20' }])
  })

  it('reports nothing on a browser without protocol negotiation', async () => {
    const glob = mockGlobal()
    const rec = recorder()
    install(glob, rec.observer)
    const wt = connect(glob)
    await wt.open()
    await settle()
    expect(rec.protocols).toHaveLength(0)
  })

  it('reports nothing for a session that never opened', async () => {
    const glob = mockGlobal()
    const rec = recorder()
    install(glob, rec.observer)
    const wt = connect(glob)
    wt.protocol = 'moqt-20'
    wt.failToOpen(new Error('connection failed'))
    await settle()
    expect(rec.protocols).toHaveLength(0)
  })
})

describe('session close', () => {
  it('reports a clean close with the peer’s reason', async () => {
    const glob = mockGlobal()
    const rec = recorder()
    install(glob, rec.observer, { clock: { now: () => 42, wall: () => 0 } })
    const wt = connect(glob)
    wt.closeSession('going away')
    await settle()
    expect(rec.sessionCloses).toEqual([
      { sessionId: rec.sessions[0]!.id, reason: 'going away', at: 42 },
    ])
  })

  it('falls back to the close code when there is no reason', async () => {
    const glob = mockGlobal()
    const rec = recorder()
    install(glob, rec.observer)
    const wt = connect(glob)
    wt.closeSession('', 7)
    await settle()
    expect(rec.sessionCloses[0]!.reason).toBe('code 7')
  })

  it('reports a failure to establish, once', async () => {
    const glob = mockGlobal()
    const rec = recorder()
    install(glob, rec.observer)
    const wt = connect(glob)
    wt.failToOpen(new Error('unreachable'))
    wt.errorSession(new Error('unreachable'))
    await settle()
    expect(rec.sessionCloses).toHaveLength(1)
    expect(rec.sessionCloses[0]!.reason).toContain('unreachable')
  })
})

/* ═══════════════════════════════════════════════════════════════════════════
 * Stream data, direction, and the control flag
 * ═══════════════════════════════════════════════════════════════════════════ */

describe('stream data', () => {
  it('tags writes on a locally opened bidi stream tx/bidi/control', async () => {
    const glob = mockGlobal()
    const rec = recorder()
    install(glob, rec.observer)
    const wt = connect(glob)
    const stream = await wt.createBidirectionalStream()
    await stream.writable.getWriter().write(bytes(0x20, 0x01))

    expect(rec.data).toHaveLength(1)
    const c = rec.data[0]!
    expect(c.direction).toBe('tx')
    expect(c.bidi).toBe(true)
    expect(c.control).toBe(true)
    expect(c.data).toEqual(bytes(0x20, 0x01))
    expect(c.sessionId).toBe(rec.sessions[0]!.id)
    expect(c.stack).toBeUndefined()
  })

  it('tags reads on a locally opened bidi stream rx/bidi/control', async () => {
    const glob = mockGlobal()
    const rec = recorder()
    install(glob, rec.observer)
    const wt = connect(glob)
    const stream = await wt.createBidirectionalStream()
    stream.inbound.push(bytes(0x21, 0x00))
    await stream.readable.getReader().read()

    expect(rec.data).toHaveLength(1)
    expect(rec.data[0]!.direction).toBe('rx')
    expect(rec.data[0]!.control).toBe(true)
  })

  it('tags a locally opened uni stream as bulk, and gives both halves one id', async () => {
    const glob = mockGlobal()
    const rec = recorder()
    install(glob, rec.observer)
    const wt = connect(glob)
    const send = await wt.createUnidirectionalStream()
    await send.getWriter().write(bytes(0x10, 0x02, 0x00))

    expect(rec.data).toHaveLength(1)
    expect(rec.data[0]!.bidi).toBe(false)
    expect(rec.data[0]!.control).toBe(false)
    expect(rec.opens).toEqual([
      { sessionId: rec.sessions[0]!.id, streamId: 0, bidi: false, origin: 'local' },
    ])
  })

  it('files a draft-17+ uni SETUP stream as control, in both directions', async () => {
    // The headline. `bidi` is false on both of these and a boolean-only test
    // would file the entire control plane as bulk media.
    const glob = mockGlobal()
    const rec = recorder()
    install(glob, rec.observer)
    const wt = connect(glob)

    const send = await wt.createUnidirectionalStream()
    await send.getWriter().write(SETUP_PREFIX)

    const src = wt.deliverUniStream()
    const queueReader = wt.incomingUnidirectionalStreams.getReader()
    const arrived = await queueReader.read()
    src.push(bytes(0xaf, 0x00, 0x02, 0x03))
    await (arrived.value as ReadableStream<Uint8Array>).getReader().read()

    expect(rec.data).toHaveLength(2)
    expect(rec.data.map((c) => [c.direction, c.bidi, c.control])).toEqual([
      ['tx', false, true],
      ['rx', false, true],
    ])
  })

  it('classifies stickily from the first bytes only', async () => {
    const glob = mockGlobal()
    const rec = recorder()
    install(glob, rec.observer)
    const wt = connect(glob)
    const send = await wt.createUnidirectionalStream()
    const writer = send.getWriter()
    await writer.write(bytes(0x10, 0x02))
    // `af 00` in mid-stream is object payload, not a SETUP.
    await writer.write(bytes(0xaf, 0x00))
    expect(rec.data.map((c) => c.control)).toEqual([false, false])
  })

  it('numbers streams per session, not per install (defect 4)', async () => {
    const glob = mockGlobal()
    const rec = recorder()
    install(glob, rec.observer)
    const first = connect(glob)
    await first.createUnidirectionalStream()
    await first.createUnidirectionalStream()
    const second = connect(glob)
    await second.createUnidirectionalStream()

    const idsOf = (sessionId: string) =>
      rec.opens.filter((o) => o.sessionId === sessionId).map((o) => o.streamId)
    expect(idsOf(rec.sessions[0]!.id)).toEqual([0, 1])
    // The extension shares one counter across every session on the page, so
    // this would be [2].
    expect(idsOf(rec.sessions[1]!.id)).toEqual([0])
  })

  it('reports incoming bidi streams from the peer with origin remote', async () => {
    const glob = mockGlobal()
    const rec = recorder()
    install(glob, rec.observer)
    const wt = connect(glob)
    const stream = wt.deliverBidiStream([bytes(0x02)])
    const arrived = await wt.incomingBidirectionalStreams.getReader().read()
    expect(arrived.done).toBe(false)
    await stream.readable.getReader().read()
    await stream.writable.getWriter().write(bytes(0x03))

    expect(rec.opens).toEqual([
      { sessionId: rec.sessions[0]!.id, streamId: 0, bidi: true, origin: 'remote' },
    ])
    expect(rec.data.map((c) => c.direction)).toEqual(['rx', 'tx'])
    expect(rec.data.every((c) => c.control)).toBe(true)
  })

  it('stamps the seam’s own clock before the write reaches the transport', async () => {
    const glob = mockGlobal()
    const rec = recorder()
    let mono = 100
    install(glob, rec.observer, { clock: { now: () => mono, wall: () => 0 } })
    const wt = connect(glob)
    const send = await wt.createUnidirectionalStream({ hold: true })
    const held = wt.createdUni[0]!.out
    const writer = send.getWriter()

    mono = 175.25
    const write = writer.write(bytes(0x10))
    // Synchronously, before the sink has seen anything: the extension stamps
    // Date.now() one message-hop later, which measures its own queue.
    expect(rec.data).toHaveLength(1)
    expect(rec.data[0]!.at).toBe(175.25)
    held.release()
    await write
    expect(held.written).toEqual([bytes(0x10)])
  })

  it('passes a failed stream creation through unchanged', async () => {
    const glob = mockGlobal()
    const rec = recorder()
    install(glob, rec.observer)
    const wt = connect(glob)
    wt.rejectStreams = new Error('session is closing')

    await expect(wt.createUnidirectionalStream()).rejects.toThrow('session is closing')
    await expect(wt.createBidirectionalStream()).rejects.toThrow('session is closing')
    expect(rec.opens).toHaveLength(0)

    // And the session keeps working afterwards.
    wt.rejectStreams = undefined
    const send = await wt.createUnidirectionalStream()
    await send.getWriter().write(bytes(0x10))
    expect(rec.data).toHaveLength(1)
  })

  it('ignores chunks that are not bytes', async () => {
    const glob = mockGlobal()
    const rec = recorder()
    install(glob, rec.observer)
    const wt = connect(glob)
    const send = await wt.createUnidirectionalStream()
    await send.getWriter().write('not bytes' as unknown as Uint8Array)
    expect(rec.data).toHaveLength(0)
    expect(wt.createdUni[0]!.out.written).toEqual(['not bytes'])
  })
})

describe('stack capture', () => {
  it('captures no stack by default, even on the control plane', async () => {
    // From draft-17 a bidi stream is per-request, so the extension's
    // unconditional capture runs on the control plane's hot path.
    const glob = mockGlobal()
    const rec = recorder()
    install(glob, rec.observer)
    const wt = connect(glob)
    const stream = await wt.createBidirectionalStream()
    await stream.writable.getWriter().write(bytes(0x20))
    expect(rec.data[0]!.stack).toBeUndefined()
  })

  it('captures a stack on bidi writes only when asked', async () => {
    const glob = mockGlobal()
    const rec = recorder()
    install(glob, rec.observer, { captureStacks: true })
    const wt = connect(glob)
    const stream = await wt.createBidirectionalStream()
    await stream.writable.getWriter().write(bytes(0x20))
    const send = await wt.createUnidirectionalStream()
    await send.getWriter().write(bytes(0x10))

    expect(typeof rec.data[0]!.stack).toBe('string')
    expect(rec.data[1]!.stack).toBeUndefined()
  })
})

/* ═══════════════════════════════════════════════════════════════════════════
 * The second seam: every route that bypasses getReader (defect 1)
 * ═══════════════════════════════════════════════════════════════════════════ */

describe('pipeTo / pipeThrough / tee / for-await are observed (defect 1)', () => {
  it('observes a receive stream consumed with pipeTo', async () => {
    const glob = mockGlobal()
    const rec = recorder()
    install(glob, rec.observer)
    const wt = connect(glob)
    const src = wt.deliverUniStream([bytes(0x10, 0x02), bytes(0x03)])
    src.close()
    const arrived = await wt.incomingUnidirectionalStreams.getReader().read()

    const sink = collectingWritable()
    await (arrived.value as ReadableStream<Uint8Array>).pipeTo(sink.stream)

    expect(chunksOf(rec)).toEqual([bytes(0x10, 0x02), bytes(0x03)])
    // Transparent: the page's own consumer still sees every chunk, unchanged.
    expect(sink.written).toEqual([bytes(0x10, 0x02), bytes(0x03)])
    expect(rec.streamCloses).toHaveLength(1)
  })

  it('observes a whole session consumed the way a real player writes it', async () => {
    // for-await over the incoming queue, pipeTo per receive stream. Under the
    // extension's seam this session reports as healthy and carries no data.
    const glob = mockGlobal()
    const rec = recorder()
    install(glob, rec.observer)
    const wt = connect(glob)

    const seen: Uint8Array[] = []
    const consume = (async () => {
      for await (const recv of asAsyncIterable(wt.incomingUnidirectionalStreams)) {
        await recv.pipeTo(
          new WritableStream<Uint8Array>({
            write(c) {
              seen.push(c)
            },
          }),
        )
      }
    })()

    const a = wt.deliverUniStream([SETUP_PREFIX])
    a.close()
    await settle()
    const b = wt.deliverUniStream([bytes(0x10, 0x02)])
    b.close()
    await settle()
    wt.incomingUni.close()
    await consume

    expect(seen).toEqual([SETUP_PREFIX, bytes(0x10, 0x02)])
    expect(chunksOf(rec)).toEqual([SETUP_PREFIX, bytes(0x10, 0x02)])
    expect(rec.data.map((c) => c.control)).toEqual([true, false])
    expect(rec.opens.map((o) => o.streamId)).toEqual([0, 1])
  })

  it('observes a receive stream consumed with pipeThrough', async () => {
    const glob = mockGlobal()
    const rec = recorder()
    install(glob, rec.observer)
    const wt = connect(glob)
    const src = wt.deliverUniStream([bytes(0x10, 0x02)])
    src.close()
    const arrived = await wt.incomingUnidirectionalStreams.getReader().read()

    const out = await drain(
      (arrived.value as ReadableStream<Uint8Array>).pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>(),
      ),
    )
    expect(out).toEqual([bytes(0x10, 0x02)])
    expect(chunksOf(rec)).toEqual([bytes(0x10, 0x02)])
  })

  it('observes a teed receive stream exactly once per chunk', async () => {
    const glob = mockGlobal()
    const rec = recorder()
    install(glob, rec.observer)
    const wt = connect(glob)
    const src = wt.deliverUniStream([bytes(0x10), bytes(0x11)])
    src.close()
    const arrived = await wt.incomingUnidirectionalStreams.getReader().read()

    const [left, right] = (arrived.value as ReadableStream<Uint8Array>).tee()
    const [a, b] = await Promise.all([drain(left), drain(right)])
    expect(a).toEqual([bytes(0x10), bytes(0x11)])
    expect(b).toEqual([bytes(0x10), bytes(0x11)])
    // Counted once, not once per branch: double counting would inflate every
    // byte total.
    expect(chunksOf(rec)).toEqual([bytes(0x10), bytes(0x11)])
  })

  it('observes a pipe invoked through the prototype, sidestepping the instance', async () => {
    const glob = mockGlobal()
    const rec = recorder()
    install(glob, rec.observer)
    const wt = connect(glob)
    const src = wt.deliverUniStream([bytes(0x10)])
    src.close()
    const arrived = await wt.incomingUnidirectionalStreams.getReader().read()

    const sink = collectingWritable()
    await ReadableStream.prototype.pipeTo.call(
      arrived.value as ReadableStream<Uint8Array>,
      sink.stream,
    )
    expect(chunksOf(rec)).toEqual([bytes(0x10)])
    expect(sink.written).toEqual([bytes(0x10)])
  })

  it('observes bytes piped INTO a send stream, which no instance patch can see', async () => {
    const glob = mockGlobal()
    const rec = recorder()
    install(glob, rec.observer)
    const wt = connect(glob)
    const send = await wt.createUnidirectionalStream()

    await new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(bytes(0x10, 0x02))
        c.enqueue(bytes(0x03))
        c.close()
      },
    }).pipeTo(send)

    expect(chunksOf(rec)).toEqual([bytes(0x10, 0x02), bytes(0x03)])
    expect(rec.data.every((c) => c.direction === 'tx')).toBe(true)
    expect(wt.createdUni[0]!.out.written).toEqual([bytes(0x10, 0x02), bytes(0x03)])
    // The pipe closed the stream, so the seam saw the stream end.
    expect(rec.streamCloses.map((c) => c.streamId)).toEqual([0])
  })

  it('gives a send stream back when the pipe never starts', async () => {
    // The destination substitution acquires a writer before the pipe runs. A
    // pipe that cannot start — here because the page had already locked its
    // own source — must not leave the page's send stream locked by us.
    const glob = mockGlobal()
    const rec = recorder()
    install(glob, rec.observer)
    const wt = connect(glob)
    const send = await wt.createUnidirectionalStream()

    const source = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(bytes(0x10))
        c.close()
      },
    })
    source.getReader()
    await expect(source.pipeTo(send)).rejects.toThrow(TypeError)

    const writer = send.getWriter()
    await writer.write(bytes(0x11))
    expect(chunksOf(rec)).toEqual([bytes(0x11)])
  })

  it('does not double count a stream piped from the peer straight back out', async () => {
    const glob = mockGlobal()
    const rec = recorder()
    install(glob, rec.observer)
    const wt = connect(glob)
    const send = await wt.createUnidirectionalStream()
    const src = wt.deliverUniStream([bytes(0x10)])
    src.close()
    const arrived = await wt.incomingUnidirectionalStreams.getReader().read()

    await (arrived.value as ReadableStream<Uint8Array>).pipeTo(send)

    // Once on the way in, once on the way out — and no more.
    expect(rec.data.map((c) => c.direction)).toEqual(['rx', 'tx'])
    expect(wt.createdUni[0]!.out.written).toEqual([bytes(0x10)])
  })

  it('propagates cancellation to the peer’s stream', async () => {
    const glob = mockGlobal()
    const rec = recorder()
    install(glob, rec.observer)
    const wt = connect(glob)
    wt.deliverUniStream([bytes(0x10), bytes(0x11)])
    const arrived = await wt.incomingUnidirectionalStreams.getReader().read()

    const seen: Uint8Array[] = []
    for await (const c of asAsyncIterable(arrived.value as ReadableStream<Uint8Array>)) {
      seen.push(c)
      break
    }
    // A `break` must cancel the underlying stream rather than leave the relay
    // holding it open forever.
    expect(seen).toEqual([bytes(0x10)])
    expect((arrived.value as ReadableStream<Uint8Array>).locked).toBe(false)
    expect(chunksOf(rec)).toEqual([bytes(0x10)])
  })
})

/* ═══════════════════════════════════════════════════════════════════════════
 * Dormancy and the datagram interceptor (defect 5)
 * ═══════════════════════════════════════════════════════════════════════════ */

describe('dormancy', () => {
  it('installs with no observer and emits nothing until one arrives', async () => {
    const glob = mockGlobal()
    const rec = recorder()
    const hook = install(glob, null)
    const wt = connect(glob)
    const send = await wt.createUnidirectionalStream()
    const writer = send.getWriter()
    await writer.write(bytes(0x10))
    expect(rec.data).toHaveLength(0)

    hook.setObserver(rec.observer)
    // The writer was handed to the page while dormant and still reports.
    await writer.write(bytes(0x11))
    expect(chunksOf(rec)).toEqual([bytes(0x11)])
  })

  it('re-arms when the observer is cleared', async () => {
    const glob = mockGlobal()
    const rec = recorder()
    const hook = install(glob, rec.observer)
    const wt = connect(glob)
    const send = await wt.createUnidirectionalStream()
    const writer = send.getWriter()
    await writer.write(bytes(0x10))
    hook.setObserver(null)
    await writer.write(bytes(0x11))
    expect(chunksOf(rec)).toEqual([bytes(0x10)])
    expect(hook.installed).toBe(true)
  })

  it('replays a session that opened before the key arrived', async () => {
    // The hook installs at module-eval time and the key can arrive at any point
    // after it, so "the session opened while dormant" is the ordinary case on
    // a page that connects at load. Without the replay the first thing the new
    // observer sees is stream data for a session it has no anchor, URL or
    // negotiated protocol for — and the draft is selected from that protocol.
    const glob = mockGlobal()
    const rec = recorder()
    const hook = install(glob, null, {
      clock: { now: () => 55, wall: () => 99 },
    })
    const wt = connect(glob, 'https://relay.test/moq', { protocols: ['moqt-20'] })
    await wt.open('moqt-20')
    await settle()
    expect(rec.sessions).toHaveLength(0)

    hook.setObserver(rec.observer)

    expect(rec.sessions).toHaveLength(1)
    expect(rec.sessions[0]!.url).toBe('https://relay.test/moq')
    expect(rec.sessions[0]!.anchor).toEqual({ originMono: 55, originWall: 99 })
    expect(rec.protocols).toEqual([{ sessionId: rec.sessions[0]!.id, protocol: 'moqt-20' }])
  })

  it('announces a session once per observer, however often it is set', async () => {
    const glob = mockGlobal()
    const rec = recorder()
    const hook = install(glob, null)
    connect(glob)
    hook.setObserver(rec.observer)
    hook.setObserver(rec.observer)
    hook.setObserver(null)
    hook.setObserver(rec.observer)
    expect(rec.sessions).toHaveLength(1)

    // A different observer is a different audience and gets its own copy.
    const second = recorder()
    hook.setObserver(second.observer)
    expect(second.sessions).toHaveLength(1)
  })

  it('does not replay a session that has already closed', async () => {
    const glob = mockGlobal()
    const rec = recorder()
    const hook = install(glob, null)
    const wt = connect(glob)
    wt.closeSession('bye')
    await settle()
    hook.setObserver(rec.observer)
    expect(rec.sessions).toHaveLength(0)
    expect(rec.sessionCloses).toHaveLength(0)
  })

  it('classifies the control plane from the first chunk even while dormant', async () => {
    // the decision is sticky and only the FIRST chunk may make it. A hook
    // that skipped classification while dormant would file every stream that
    // started before the key arrived as bulk, for its whole life.
    const glob = mockGlobal()
    const rec = recorder()
    const hook = install(glob, null)
    const wt = connect(glob)
    const src = wt.deliverUniStream()
    const arrived = await wt.incomingUnidirectionalStreams.getReader().read()
    const reader = (arrived.value as ReadableStream<Uint8Array>).getReader()

    src.push(SETUP_PREFIX)
    await reader.read()

    hook.setObserver(rec.observer)
    src.push(bytes(0x01, 0x02))
    await reader.read()

    expect(rec.data).toHaveLength(1)
    expect(rec.data[0]!.control).toBe(true)
  })
})

describe('datagrams (defect 5)', () => {
  it('intercepts datagrams even though the observer was null at install', async () => {
    // The extension guards the whole datagram interceptor behind
    // `if (onStream.onDatagram)` evaluated at construction time, and the hook
    // installs dormant — so on the real product path datagrams were lost for
    // the life of the session even after a key arrived.
    const glob = mockGlobal()
    const rec = recorder()
    const hook = install(glob, null)
    const wt = connect(glob)
    const reader = wt.datagrams.readable.getReader()
    const writer = wt.datagrams.writable.getWriter()

    hook.setObserver(rec.observer)
    wt.datagramsIn.push(bytes(0x40, 0x01))
    await reader.read()
    await writer.write(bytes(0x41, 0x02))

    expect(rec.datagrams.map((d) => [d.direction, [...d.data]])).toEqual([
      ['rx', [0x40, 0x01]],
      ['tx', [0x41, 0x02]],
    ])
    expect(rec.datagrams[0]!.sessionId).toBe(rec.sessions[0]!.id)
    // Datagrams are not streams: nothing is filed under a stream id.
    expect(rec.data).toHaveLength(0)
  })

  it('observes datagrams consumed with for-await', async () => {
    const glob = mockGlobal()
    const rec = recorder()
    install(glob, rec.observer)
    const wt = connect(glob)
    const seen: Uint8Array[] = []
    const consume = (async () => {
      for await (const d of asAsyncIterable(wt.datagrams.readable)) {
        seen.push(d)
        if (seen.length === 2) break
      }
    })()
    wt.datagramsIn.push(bytes(1))
    wt.datagramsIn.push(bytes(2))
    await consume
    expect(seen).toHaveLength(2)
    expect(rec.datagrams.map((d) => [...d.data])).toEqual([[1], [2]])
  })

  it('observes datagrams piped into the writable side', async () => {
    const glob = mockGlobal()
    const rec = recorder()
    install(glob, rec.observer)
    const wt = connect(glob)
    await new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(bytes(0x40))
        c.close()
      },
    }).pipeTo(wt.datagrams.writable)
    expect(rec.datagrams.map((d) => [d.direction, [...d.data]])).toEqual([['tx', [0x40]]])
    expect(wt.datagramsOut.written).toEqual([bytes(0x40)])
  })
})

/* ═══════════════════════════════════════════════════════════════════════════
 * Non-interference and errors
 * ═══════════════════════════════════════════════════════════════════════════ */

describe('non-interference', () => {
  it('never lets an observer throw into the page', async () => {
    const glob = mockGlobal()
    const onInternalError = vi.fn()
    const hostile: TransportObserver = {
      onSessionOpen() {
        throw new Error('observer exploded')
      },
      onSessionClose() {},
      onStreamData() {
        throw new Error('observer exploded')
      },
      onStreamClose() {},
      onStreamError() {},
    }
    install(glob, hostile, { onInternalError })

    const wt = connect(glob)
    const send = await wt.createUnidirectionalStream()
    await expect(send.getWriter().write(bytes(0x10))).resolves.toBeUndefined()
    expect(wt.createdUni[0]!.out.written).toEqual([bytes(0x10)])
    expect(onInternalError).toHaveBeenCalledTimes(2)
  })

  it('survives an onInternalError that throws', async () => {
    const glob = mockGlobal()
    const hostile: TransportObserver = {
      onSessionOpen() {},
      onSessionClose() {},
      onStreamData() {
        throw new Error('observer exploded')
      },
      onStreamClose() {},
      onStreamError() {},
    }
    install(glob, hostile, {
      onInternalError() {
        throw new Error('reporter exploded too')
      },
    })
    const wt = connect(glob)
    const send = await wt.createUnidirectionalStream()
    await expect(send.getWriter().write(bytes(0x10))).resolves.toBeUndefined()
  })

  it('reports a read error and closes the stream', async () => {
    const glob = mockGlobal()
    const rec = recorder()
    install(glob, rec.observer)
    const wt = connect(glob)
    const src = wt.deliverUniStream()
    const arrived = await wt.incomingUnidirectionalStreams.getReader().read()
    const reader = (arrived.value as ReadableStream<Uint8Array>).getReader()

    const pending = reader.read()
    src.error(new Error('stream reset'))
    await expect(pending).rejects.toThrow('stream reset')

    expect(rec.streamErrors).toHaveLength(1)
    expect(String(rec.streamErrors[0]!.error)).toContain('stream reset')
    expect(rec.streamCloses.map((c) => c.streamId)).toEqual([0])
  })

  it('leaves the page’s chunk object identical, never a copy', async () => {
    const glob = mockGlobal()
    const rec = recorder()
    install(glob, rec.observer)
    const wt = connect(glob)
    const send = await wt.createUnidirectionalStream()
    const chunk = bytes(0x10, 0x02)
    await send.getWriter().write(chunk)
    // The seam borrows; it must not clone on the page's data path, and it must
    // not hand the transport anything but exactly what the page wrote.
    expect(wt.createdUni[0]!.out.written[0]).toBe(chunk)
  })

  it('reports one close per stream, after both halves of a bidi stream end', async () => {
    // Firing on the first half would tell the decoder a draft-17+ request
    // stream is over while control frames are still arriving on the other side.
    const glob = mockGlobal()
    const rec = recorder()
    install(glob, rec.observer)
    const wt = connect(glob)
    const stream = await wt.createBidirectionalStream()
    const writer = stream.writable.getWriter()
    const reader = stream.readable.getReader()

    await writer.close()
    expect(rec.streamCloses).toHaveLength(0)

    stream.inbound.close()
    const end = await reader.read()
    expect(end.done).toBe(true)
    expect(rec.streamCloses.map((c) => c.streamId)).toEqual([0])
  })

  it('reports an aborted send stream and lets the abort through', async () => {
    const glob = mockGlobal()
    const rec = recorder()
    install(glob, rec.observer)
    const wt = connect(glob)
    const send = await wt.createUnidirectionalStream()
    const writer = send.getWriter()
    await writer.write(bytes(0x10))
    await writer.abort('gave up')

    expect(rec.streamCloses.map((c) => c.streamId)).toEqual([0])
    expect(wt.createdUni[0]!.out.aborted()).toBe('gave up')
  })

  it('reports a stream the page cancelled rather than read to the end', async () => {
    // A player that switches tracks cancels the reader and sends STOP_SENDING;
    // it never reads to `done`. Without this the decoder would hold that
    // stream's state until the session ended.
    const glob = mockGlobal()
    const rec = recorder()
    install(glob, rec.observer)
    const wt = connect(glob)
    wt.deliverUniStream([bytes(0x10)])
    const arrived = await wt.incomingUnidirectionalStreams.getReader().read()
    const recv = arrived.value as ReadableStream<Uint8Array>
    const reader = recv.getReader()
    await reader.read()
    await reader.cancel('switching tracks')
    expect(rec.streamCloses.map((c) => c.streamId)).toEqual([0])
  })

  it('counts each half of a bidi stream once, however many times it ends', async () => {
    // A cancelled reader still resolves its next read as `done`, so the read
    // half ends twice. A counter would close the stream on that alone, while
    // the other side is still carrying control frames.
    const glob = mockGlobal()
    const rec = recorder()
    install(glob, rec.observer)
    const wt = connect(glob)
    const stream = await wt.createBidirectionalStream()
    const reader = stream.readable.getReader()

    await reader.cancel('done reading')
    const after = await reader.read()
    expect(after.done).toBe(true)
    expect(rec.streamCloses).toHaveLength(0)

    await stream.writable.getWriter().close()
    expect(rec.streamCloses.map((c) => c.streamId)).toEqual([0])
  })

  it('gives the page its stream back when a for-await loop breaks', async () => {
    // `cancel()` does not release a reader's lock, and the relay holds one for
    // as long as it lives. A page that breaks out of a loop and re-acquires a
    // reader — which works natively — must not start throwing because the
    // collector is present.
    const glob = mockGlobal()
    const rec = recorder()
    install(glob, rec.observer)
    const wt = connect(glob)
    wt.deliverUniStream([bytes(0x10), bytes(0x11)])
    const arrived = await wt.incomingUnidirectionalStreams.getReader().read()
    const recv = arrived.value as ReadableStream<Uint8Array>

    const seen: Uint8Array[] = []
    for await (const c of asAsyncIterable(recv)) {
      seen.push(c)
      break
    }

    expect(seen).toEqual([bytes(0x10)])
    expect(recv.locked).toBe(false)
    expect(chunksOf(rec)).toEqual([bytes(0x10)])
    expect(rec.streamCloses.map((c) => c.streamId)).toEqual([0])
  })

  it('reports an error on a relayed stream and unlocks it', async () => {
    const glob = mockGlobal()
    const rec = recorder()
    install(glob, rec.observer)
    const wt = connect(glob)
    const src = wt.deliverUniStream([bytes(0x10)])
    const arrived = await wt.incomingUnidirectionalStreams.getReader().read()
    const recv = arrived.value as ReadableStream<Uint8Array>

    const piped = recv.pipeTo(collectingWritable().stream)
    src.error(new Error('stream reset'))
    await expect(piped).rejects.toThrow('stream reset')

    expect(rec.streamErrors).toHaveLength(1)
    expect(recv.locked).toBe(false)
  })

  it('gives the page its stream back when a pipe finishes', async () => {
    const glob = mockGlobal()
    const rec = recorder()
    install(glob, rec.observer)
    const wt = connect(glob)
    const src = wt.deliverUniStream([bytes(0x10)])
    src.close()
    const arrived = await wt.incomingUnidirectionalStreams.getReader().read()
    const recv = arrived.value as ReadableStream<Uint8Array>
    await recv.pipeTo(collectingWritable().stream)
    expect(recv.locked).toBe(false)
  })

  it('reports the close of a uni receive stream as soon as it ends', async () => {
    const glob = mockGlobal()
    const rec = recorder()
    install(glob, rec.observer)
    const wt = connect(glob)
    const src = wt.deliverUniStream([bytes(0x10)])
    const arrived = await wt.incomingUnidirectionalStreams.getReader().read()
    const reader = (arrived.value as ReadableStream<Uint8Array>).getReader()
    await reader.read()
    src.close()
    await reader.read()
    expect(rec.streamCloses.map((c) => c.streamId)).toEqual([0])
  })
})

/* ═══════════════════════════════════════════════════════════════════════════
 * The send-side signals
 * ═══════════════════════════════════════════════════════════════════════════ */

describe('writer pressure', () => {
  it('samples writer.ready only while the writer is backpressured', async () => {
    const glob = mockGlobal()
    const rec = recorder()
    let mono = 0
    install(glob, rec.observer, {
      clock: {
        now: () => {
          mono += 1
          return mono
        },
        wall: () => 0,
      },
    })
    const wt = connect(glob)
    const send = await wt.createUnidirectionalStream({ hold: true, highWaterMark: 1 })
    const held = wt.createdUni[0]!.out
    const writer = send.getWriter()

    // The first write is not backpressured — desiredSize is still positive, so
    // no promise is allocated. An uncongested publisher pays one property read.
    const first = writer.write(bytes(1))
    expect(rec.pressure).toHaveLength(0)

    const second = writer.write(bytes(2))
    held.release()
    await settle()
    held.release()
    await Promise.all([first, second])
    await settle()

    expect(rec.pressure).toHaveLength(1)
    const p = rec.pressure[0]!
    expect(p.sessionId).toBe(rec.sessions[0]!.id)
    expect(p.streamId).toBe(0)
    expect(p.readyLatencyMs).toBeGreaterThan(0)
  })

  it('probes getStats().bytesAcknowledged when the stream closes', async () => {
    const glob = mockGlobal()
    const rec = recorder()
    install(glob, rec.observer)
    const wt = connect(glob)
    wt.bytesAcknowledged = 4096
    const send = await wt.createUnidirectionalStream()
    const writer = send.getWriter()
    await writer.write(bytes(0x10))
    await writer.close()
    await settle()

    expect(rec.sendStats).toEqual([{ streamId: 0, bytesAcknowledged: 4096 }])
  })

  it('says nothing about send stats on a browser without getStats', async () => {
    const glob = mockGlobal()
    const rec = recorder()
    install(glob, rec.observer)
    const wt = connect(glob)
    const stream = await wt.createBidirectionalStream()
    await stream.writable.getWriter().close()
    await settle()
    expect(rec.sendStats).toHaveLength(0)
  })
})
