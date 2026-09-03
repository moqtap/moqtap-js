import type { SessionPhase, SessionState, TransitionResult } from '@moqtap/codec/session'
import { describe, expect, it } from 'vitest'
import { readMoqtrace, readMoqtraceHeader, writeMoqtrace } from '../binary.js'
import type { TraceRecorder } from '../recorder.js'
import { createRecorder, MAX_ERROR_RAW_BYTES } from '../recorder.js'
import type { DetailLevel, TraceErrorEvent } from '../types.js'

/** Minimal message type for testing — no draft dependency. */
interface MockMessage {
  type: string
}

function createMockSession(initialPhase: SessionPhase = 'idle'): SessionState<MockMessage, string> {
  let phase: SessionPhase = initialPhase
  return {
    get phase() {
      return phase
    },
    get role() {
      return 'client' as const
    },
    get subscriptions() {
      return new Map()
    },
    get announces() {
      return new Map()
    },
    get legalOutgoing() {
      return new Set<string>()
    },
    get legalIncoming() {
      return new Set<string>()
    },
    receive(_msg: MockMessage): TransitionResult<string> {
      if (phase === 'idle') phase = 'setup'
      else if (phase === 'setup') phase = 'ready'
      return { ok: true, phase, sideEffects: [] }
    },
    validateOutgoing(_msg: MockMessage) {
      return { ok: true as const }
    },
    send(_msg: MockMessage): TransitionResult<string> {
      if (phase === 'idle') phase = 'setup'
      else if (phase === 'setup') phase = 'ready'
      return { ok: true, phase, sideEffects: [] }
    },
    reset() {
      phase = 'idle'
    },
  }
}

const serverSetup: MockMessage = { type: 'server_setup' }
const clientSetup: MockMessage = { type: 'client_setup' }

describe('TraceRecorder', () => {
  it('records control messages on receive', () => {
    let tick = 0
    const recorder = createRecorder({
      detail: 'control',
      protocol: 'moq-transport-14',
      perspective: 'client',
      clock: () => tick++,
    })
    const wrapped = recorder.wrapSession(createMockSession())
    wrapped.receive(serverSetup)

    const trace = recorder.finalize()
    const controlEvents = trace.events.filter((e) => e.type === 'control')
    expect(controlEvents).toHaveLength(1)
    const e = controlEvents[0]!
    if (e.type === 'control') {
      expect(e.direction).toBe(1) // rx
    }
  })

  it('records control messages on send', () => {
    let tick = 0
    const recorder = createRecorder({
      detail: 'control',
      protocol: 'moq-transport-14',
      perspective: 'client',
      clock: () => tick++,
    })
    const wrapped = recorder.wrapSession(createMockSession())
    wrapped.send(clientSetup)

    const trace = recorder.finalize()
    const controlEvents = trace.events.filter((e) => e.type === 'control')
    expect(controlEvents).toHaveLength(1)
    const e = controlEvents[0]!
    if (e.type === 'control') {
      expect(e.direction).toBe(0) // tx
    }
  })

  it('records state-change events on phase transition', () => {
    let tick = 0
    const recorder = createRecorder({
      detail: 'control',
      protocol: 'moq-transport-14',
      perspective: 'client',
      clock: () => tick++,
    })
    const wrapped = recorder.wrapSession(createMockSession('idle'))
    wrapped.receive(serverSetup) // idle → setup

    const trace = recorder.finalize()
    const stateChanges = trace.events.filter((e) => e.type === 'state-change')
    expect(stateChanges).toHaveLength(1)
    const e = stateChanges[0]!
    if (e.type === 'state-change') {
      expect(e.from).toBe('idle')
      expect(e.to).toBe('setup')
    }
  })

  it('assigns monotonically increasing sequence numbers', () => {
    let tick = 0
    const recorder = createRecorder({
      detail: 'control',
      protocol: 'moq-transport-14',
      perspective: 'client',
      clock: () => tick++,
    })
    const wrapped = recorder.wrapSession(createMockSession())

    wrapped.send(clientSetup)
    wrapped.receive(serverSetup)
    recorder.annotate('test', null)

    const trace = recorder.finalize()
    const seqs = trace.events.map((e) => e.seq)
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]!).toBeGreaterThan(seqs[i - 1]!)
    }
  })

  it('detail level filters stream events at control level', () => {
    const recorder = createRecorder({
      detail: 'control',
      protocol: 'moq-transport-14',
      perspective: 'client',
      clock: () => 0,
    })

    recorder.recordStreamOpened(1n, 0, 0)
    recorder.recordStreamClosed(1n, 0)
    recorder.recordObjectHeader(1n, 0n, 0n, 128, 0)
    recorder.recordObjectPayload(1n, 0n, 0n, 100)

    const trace = recorder.finalize()
    expect(trace.events).toHaveLength(0)
  })

  it('detail level includes stream events at headers level', () => {
    const recorder = createRecorder({
      detail: 'headers',
      protocol: 'moq-transport-14',
      perspective: 'client',
      clock: () => 0,
    })

    recorder.recordStreamOpened(1n, 0, 0)
    recorder.recordObjectHeader(1n, 0n, 0n, 128, 0)
    recorder.recordStreamClosed(1n, 0)

    const trace = recorder.finalize()
    expect(trace.events).toHaveLength(3)
    expect(trace.events.map((e) => e.type)).toEqual([
      'stream-opened',
      'object-header',
      'stream-closed',
    ])
  })

  it('detail level filters payload events below headers+sizes', () => {
    const recorder = createRecorder({
      detail: 'headers',
      protocol: 'moq-transport-14',
      perspective: 'client',
      clock: () => 0,
    })

    recorder.recordObjectPayload(1n, 0n, 0n, 100, new Uint8Array([1, 2, 3]))

    const trace = recorder.finalize()
    expect(trace.events).toHaveLength(0)
  })

  it('headers+sizes includes payload size but not bytes', () => {
    const recorder = createRecorder({
      detail: 'headers+sizes',
      protocol: 'moq-transport-14',
      perspective: 'client',
      clock: () => 0,
    })

    recorder.recordObjectPayload(1n, 0n, 0n, 100, new Uint8Array([1, 2, 3]))

    const trace = recorder.finalize()
    expect(trace.events).toHaveLength(1)
    const e = trace.events[0]!
    if (e.type === 'object-payload') {
      expect(e.size).toBe(100)
      expect(e.payload).toBeUndefined()
    }
  })

  it('headers+data includes payload bytes', () => {
    const recorder = createRecorder({
      detail: 'headers+data',
      protocol: 'moq-transport-14',
      perspective: 'client',
      clock: () => 0,
    })

    const payload = new Uint8Array([0xde, 0xad])
    recorder.recordObjectPayload(1n, 0n, 0n, 2, payload)

    const trace = recorder.finalize()
    expect(trace.events).toHaveLength(1)
    const e = trace.events[0]!
    if (e.type === 'object-payload') {
      expect(e.payload).toEqual(payload)
    }
  })

  it('error events are always recorded', () => {
    const recorder = createRecorder({
      detail: 'control',
      protocol: 'moq-transport-14',
      perspective: 'client',
      clock: () => 0,
    })

    recorder.recordError(1, 'Protocol violation')

    const trace = recorder.finalize()
    expect(trace.events).toHaveLength(1)
    const e = trace.events[0]!
    if (e.type === 'error') {
      expect(e.errorCode).toBe(1)
      expect(e.reason).toBe('Protocol violation')
    }
  })

  it('annotation events are always recorded', () => {
    const recorder = createRecorder({
      detail: 'control',
      protocol: 'moq-transport-14',
      perspective: 'client',
      clock: () => 0,
    })

    recorder.annotate('my-label', { key: 'value' })

    const trace = recorder.finalize()
    expect(trace.events).toHaveLength(1)
    const e = trace.events[0]!
    if (e.type === 'annotation') {
      expect(e.label).toBe('my-label')
      expect(e.data).toEqual({ key: 'value' })
    }
  })

  it('respects maxEvents circular buffer', () => {
    const recorder = createRecorder({
      detail: 'control',
      protocol: 'moq-transport-14',
      perspective: 'client',
      maxEvents: 3,
      clock: () => 0,
    })

    recorder.annotate('a', null)
    recorder.annotate('b', null)
    recorder.annotate('c', null)
    recorder.annotate('d', null)
    recorder.annotate('e', null)

    const trace = recorder.finalize()
    expect(trace.events).toHaveLength(3)
    const labels = trace.events.map((e) => (e.type === 'annotation' ? e.label : ''))
    expect(labels).toEqual(['c', 'd', 'e'])
  })

  it('stops recording after finalize', () => {
    const recorder = createRecorder({
      detail: 'control',
      protocol: 'moq-transport-14',
      perspective: 'client',
      clock: () => 0,
    })

    recorder.annotate('before', null)
    const trace = recorder.finalize()

    expect(recorder.recording).toBe(false)
    recorder.annotate('after', null)
    expect(trace.events).toHaveLength(1)
  })

  it('record() inserts arbitrary events directly', () => {
    const recorder = createRecorder({
      detail: 'control',
      protocol: 'moq-transport-14',
      perspective: 'observer',
      clock: () => 0,
    })

    recorder.record({
      type: 'control',
      seq: 99,
      timestamp: 12345,
      direction: 1,
      messageType: 0x03,
      message: { type: 'subscribe' },
    })

    const trace = recorder.finalize()
    expect(trace.events).toHaveLength(1)
    expect(trace.events[0]?.seq).toBe(99)
    expect(trace.events[0]?.timestamp).toBe(12345)
  })

  it('finalize produces correct header metadata', () => {
    const recorder = createRecorder({
      detail: 'headers',
      protocol: 'moq-transport-07',
      perspective: 'server',
      transport: 'webtransport',
      source: 'test-suite/1.0',
      endpoint: 'https://example.com/moq',
      sessionId: 'sess-001',
      clock: () => 0,
    })

    const trace = recorder.finalize()
    expect(trace.header.protocol).toBe('moq-transport-07')
    expect(trace.header.perspective).toBe('server')
    expect(trace.header.detail).toBe('headers')
    expect(trace.header.transport).toBe('webtransport')
    expect(trace.header.source).toBe('test-suite/1.0')
    expect(trace.header.endpoint).toBe('https://example.com/moq')
    expect(trace.header.sessionId).toBe('sess-001')
    expect(trace.header.startTime).toBeGreaterThan(0)
    expect(trace.header.endTime).toBeGreaterThanOrEqual(trace.header.startTime)
  })

  it('carries extra header keys through to the finalized header', () => {
    // A recorder with something to say the format has no key for can say it,
    // under the `x-` prefix the format reserves for private use — and a header
    // this package builds then has the same shape as one it reads back.
    const recorder = createRecorder({
      detail: 'control',
      protocol: 'moq-transport-14',
      perspective: 'client',
      extra: { 'x-capture-host': 'lab-3' },
      clock: () => 0,
    })
    const { header } = recorder.finalize()
    expect(header.extra).toEqual({ 'x-capture-host': 'lab-3' })
    expect(readMoqtraceHeader(writeMoqtrace({ header, events: [] })).extra).toEqual({
      'x-capture-host': 'lab-3',
    })
  })

  it('leaves the header store absent when the recorder was given none', () => {
    const recorder = createRecorder({
      detail: 'control',
      protocol: 'moq-transport-14',
      perspective: 'client',
      clock: () => 0,
    })
    expect(recorder.finalize().header.extra).toBeUndefined()
  })
})

describe('what a recorder puts on an error event', () => {
  function recorderAt(detail: DetailLevel): TraceRecorder {
    return createRecorder({
      detail,
      protocol: 'moq-transport-14',
      perspective: 'client',
      clock: () => 0,
    })
  }

  /** Every event the recorder kept, each of which must be an error event. */
  function errorEvents(recorder: TraceRecorder): TraceErrorEvent[] {
    const events = recorder.finalize().events
    const errors = events.filter((event): event is TraceErrorEvent => event.type === 'error')
    expect(errors).toHaveLength(events.length)
    return errors
  }

  /** The one error event a recorder kept, or a failure. */
  function onlyError(recorder: TraceRecorder): TraceErrorEvent {
    const errors = errorEvents(recorder)
    expect(errors).toHaveLength(1)
    const first = errors[0]
    if (first == null) throw new Error('the recorder kept no error event')
    return first
  }

  const bytes = new Uint8Array([0x02, 0x0b, 0xff])

  it('records the stream and the kind at control level, the lowest there is', () => {
    // Both sit at `control`+, alongside the code and the reason: neither is a
    // size and neither is payload-bearing.
    const recorder = recorderAt('control')
    recorder.recordError(4, 'did not parse', { streamId: 12n, errorKind: 'decode' })
    const event = onlyError(recorder)
    expect(event.streamId).toBe(12n)
    expect(event.errorKind).toBe('decode')
  })

  it('records neither the length nor the bytes at control level', () => {
    // `"rawlen"` is a size and this format gates sizes deliberately. The
    // stream an error names may be a data stream, so at `control` the length
    // would be a fact about media volume in a trace whose declared level
    // excludes exactly that.
    const recorder = recorderAt('control')
    recorder.recordError(4, 'did not parse', { streamId: 12n, raw: bytes })
    const event = onlyError(recorder)
    expect(event.rawLength).toBeUndefined()
    expect(event.raw).toBeUndefined()
  })

  it('records the length from headers+sizes up, without the bytes', () => {
    // The whole point of the key being a level below the bytes: how large a
    // malformed message was often separates a truncated message from a
    // mistyped one, and it carries no content.
    const recorder = recorderAt('headers+sizes')
    recorder.recordError(4, 'did not parse', { raw: bytes })
    const event = onlyError(recorder)
    expect(event.rawLength).toBe(3)
    expect(event.raw).toBeUndefined()
  })

  it('still withholds the bytes at headers+data', () => {
    // `"raw"` is at `full` alone, not merely above the size level: an error
    // naming a data stream has subgroup framing and object payload behind it.
    const recorder = recorderAt('headers+data')
    recorder.recordError(4, 'did not parse', { raw: bytes })
    const event = onlyError(recorder)
    expect(event.rawLength).toBe(3)
    expect(event.raw).toBeUndefined()
  })

  it('records the bytes at full', () => {
    const recorder = recorderAt('full')
    recorder.recordError(4, 'did not parse', { raw: bytes })
    const event = onlyError(recorder)
    expect(event.raw).toEqual(bytes)
    expect(event.rawLength).toBe(3)
  })

  it('caps the bytes at 4096 and reports the length it was handed', () => {
    // The cap is a MUST and a fixed number because an error event is
    // non-droppable: every other high-volume field in this format is bounded
    // by sampling, so if this one is not bounded here it is not bounded at
    // all. `rawLength` is what tells the reader the record is partial.
    const recorder = recorderAt('full')
    const long = new Uint8Array(5000).fill(0xab)
    recorder.recordError(4, 'fuzzed', { raw: long })
    const event = onlyError(recorder)
    expect(MAX_ERROR_RAW_BYTES).toBe(4096)
    expect(event.raw?.length).toBe(4096)
    expect(event.rawLength).toBe(5000)
    expect(event.raw?.every((byte) => byte === 0xab)).toBe(true)
  })

  it('omits the length when the caller says it does not know', () => {
    // A caller that pre-truncated and cannot know what it did not read must
    // not have a length guessed for it. `rawLength === raw.length` is this
    // format's signal for *not truncated*, so defaulting it here would assert
    // a complete capture in the one case where nobody knows whether the input
    // was complete. Absent, a reader treats a `raw` of exactly the cap as
    // possibly truncated, which is true.
    const recorder = recorderAt('full')
    recorder.recordError(4, 'gave up reading', {
      raw: new Uint8Array(MAX_ERROR_RAW_BYTES).fill(0x11),
      rawLength: null,
    })
    const event = onlyError(recorder)
    expect(event.raw?.length).toBe(MAX_ERROR_RAW_BYTES)
    expect(event.rawLength).toBeUndefined()
    // Absent on the wire too, not present as CBOR null — the format treats a
    // written null as a value a writer chose, which is the opposite of what
    // this caller said.
    const reread = readMoqtrace(writeMoqtrace(recorder.finalize()))
    const onWire = reread.events.find((e) => e.type === 'error') as TraceErrorEvent
    expect('rawLength' in onWire).toBe(false)
  })

  it('keeps a raw of exactly the cap whole', () => {
    // The boundary, and the one length the cap makes ambiguous: a reader
    // meeting 4096 bytes with no `"rawlen"` beside them must treat the
    // capture as possibly truncated, so the recorder writes the length here
    // even though nothing was cut.
    const recorder = recorderAt('full')
    const exact = new Uint8Array(MAX_ERROR_RAW_BYTES).fill(0x01)
    recorder.recordError(4, 'fuzzed', { raw: exact })
    const event = onlyError(recorder)
    expect(event.raw?.length).toBe(4096)
    expect(event.rawLength).toBe(4096)
  })

  it('reports a length the caller states rather than the bytes it handed over', () => {
    // For a caller that hit a cap of its own upstream: without this the
    // recorder would report the truncated length as the whole of it, which is
    // the one thing `"rawlen"` exists to prevent.
    const recorder = recorderAt('full')
    recorder.recordError(4, 'fuzzed', { raw: bytes, rawLength: 70000 })
    const event = onlyError(recorder)
    expect(event.rawLength).toBe(70000)
    expect(event.raw?.length).toBe(3)
  })

  it('records the bytes once per stream, and the later errors in full without them', () => {
    // The latch is on the field, not on the event. Suppressing the event would
    // discard the causal record precisely when a peer is misbehaving
    // repeatedly, which is when it matters most; what grows without bound is
    // the bytes, so that is what is bounded.
    const recorder = recorderAt('full')
    recorder.recordError(4, 'first', { streamId: 12n, raw: bytes })
    recorder.recordError(4, 'second', { streamId: 12n, raw: bytes })
    const [first, second] = errorEvents(recorder)
    expect(first?.reason).toBe('first')
    expect(first?.raw).toEqual(bytes)
    expect(second?.reason).toBe('second')
    expect(second?.raw).toBeUndefined()
    // Still says how much there was, which costs nothing and is the diagnostic
    // that survives the latch.
    expect(second?.rawLength).toBe(3)
  })

  it('gives each stream its own slot', () => {
    const recorder = recorderAt('full')
    recorder.recordError(4, 'on 12', { streamId: 12n, raw: bytes })
    recorder.recordError(4, 'on 16', { streamId: 16n, raw: bytes })
    const [first, second] = errorEvents(recorder)
    expect(first?.raw).toEqual(bytes)
    expect(second?.raw).toEqual(bytes)
  })

  it('treats every error naming no stream as one flow', () => {
    // "Per stream where the error names one, per peer where it does not" —
    // and this recorder writes no peer identifier, so there is one such flow.
    // The error that does name a stream is a different flow and keeps its own
    // bytes.
    const recorder = recorderAt('full')
    recorder.recordError(4, 'first', { raw: bytes })
    recorder.recordError(4, 'second', { raw: bytes })
    recorder.recordError(4, 'on a stream', { streamId: 12n, raw: bytes })
    const [first, second, onStream] = errorEvents(recorder)
    expect(first?.raw).toEqual(bytes)
    expect(second?.raw).toBeUndefined()
    expect(onStream?.raw).toEqual(bytes)
  })

  it('leaves every one of the four keys off an error recorded with no details', () => {
    const recorder = recorderAt('full')
    recorder.recordError(1, 'Protocol violation')
    const event = onlyError(recorder)
    expect(event.streamId).toBeUndefined()
    expect(event.errorKind).toBeUndefined()
    expect(event.rawLength).toBeUndefined()
    expect(event.raw).toBeUndefined()
  })

  it('neither caps nor gates an error handed to record(), and the writer keeps it whole', () => {
    // `record` inserts an event a caller may well have read out of a file
    // rather than built from bytes it just observed. The cap is addressed to
    // the recorder deciding what to say about traffic it saw; applying it here
    // — or in `writeMoqtrace` — would truncate someone else's evidence on a
    // rewrite. This is the test that would go red if the cap were moved into
    // the write path.
    const recorder = recorderAt('control')
    const long = new Uint8Array(5000).fill(0xab)
    recorder.record({
      type: 'error',
      seq: 0,
      timestamp: 0,
      errorCode: 4,
      reason: 'read out of a file',
      raw: long,
      rawLength: 5000,
    })
    const event = onlyError(recorder)
    expect(event.raw?.length).toBe(5000)

    const written = readMoqtrace(
      writeMoqtrace({ header: recorder.finalize().header, events: [event] }),
    )
    const reread = written.events[0]
    if (reread?.type !== 'error') throw new Error('expected an error event')
    expect(reread.raw?.length).toBe(5000)
    expect(reread.raw?.every((byte) => byte === 0xab)).toBe(true)
  })
})
