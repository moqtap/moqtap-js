import { Encoder } from 'cbor-x'
import { describe, expect, it } from 'vitest'
import {
  createMoqtraceWriter,
  FORMAT_VERSION,
  readMoqtrace,
  readMoqtraceSegments,
  SUPPORTED_VERSIONS,
  TruncatedTraceError,
  writeMoqtrace,
  writeMoqtraceSegments,
} from '../binary.js'
import type { Trace, TraceEvent, TraceHeader } from '../types.js'
import { TRACE_ID_LENGTH } from '../types.js'

const codec = new Encoder({ useRecords: false, mapsAsObjects: true })

function makeHeader(overrides?: Partial<TraceHeader>): TraceHeader {
  return {
    protocol: 'moq-transport-19',
    perspective: 'client',
    detail: 'control',
    startTime: 1700000000000,
    ...overrides,
  }
}

function makeTrace(events: TraceEvent[], headerOverrides?: Partial<TraceHeader>): Trace {
  return { header: makeHeader(headerOverrides), events }
}

function annotation(seq: number, label: string): TraceEvent {
  return { type: 'annotation', seq, timestamp: seq * 100, label, data: null }
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const result = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.length
  }
  return result
}

describe('format version', () => {
  it('writes version 2', () => {
    expect(FORMAT_VERSION).toBe(2)
    const bytes = writeMoqtrace(makeTrace([]))
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    expect(view.getUint32(8, true)).toBe(2)
  })

  it('reads versions 1 and 2', () => {
    expect(SUPPORTED_VERSIONS).toContain(1)
    expect(SUPPORTED_VERSIONS).toContain(2)
  })

  it('still reads a version 1 file', () => {
    // Every capture taken before the bump has to stay openable; a version bump
    // that orphans the existing corpus buys nothing.
    const bytes = writeMoqtrace(makeTrace([annotation(0, 'from-before-the-bump')]))
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    view.setUint32(8, 1, true)

    const result = readMoqtrace(bytes)
    expect(result.header.protocol).toBe('moq-transport-19')
    expect(result.events).toHaveLength(1)
    expect(result.events[0]).toMatchObject({ type: 'annotation', label: 'from-before-the-bump' })
  })
})

describe('unknown values in the header', () => {
  it('keeps a perspective it does not know', () => {
    // New perspectives may be added without a version bump, and every event in
    // such a file still parses — so refusing it at the header would refuse a
    // trace this package can otherwise read in full.
    const bytes = writeMoqtrace(
      makeTrace([annotation(0, 'a')], {
        perspective: 'satellite-tap',
        detail: 'headers+timing',
      }),
    )
    const result = readMoqtrace(bytes)
    expect(result.header.perspective).toBe('satellite-tap')
    expect(result.header.detail).toBe('headers+timing')
    expect(result.events).toHaveLength(1)
  })

  it('round-trips the relay-tap perspective and its metadata', () => {
    const trace = makeTrace([], {
      perspective: 'relay-tap',
      segment: { sequence: 3, durationMs: 1000, streamId: 'stream-9', continues: true },
      sampling: {
        effectiveRate: 0.5,
        maxEventsPerSec: 1000,
        dropPolicy: 'tail',
        droppedTotal: 42,
        droppedSegment: 7,
        rule: 'namespace prefix=foo/bar',
        ruleLang: 'prefix',
        appliesTo: [3, 4],
      },
    })
    expect(readMoqtrace(writeMoqtrace(trace)).header).toEqual(trace.header)
  })
})

describe('unknown event types', () => {
  const futureEvent = {
    n: 7,
    t: 1234,
    p: 'peer-a',
    e: 99,
    alpha: 1,
    beta: new Uint8Array([0xde, 0xad]),
  }

  function fileWithFutureEvent(): Uint8Array {
    const writer = createMoqtraceWriter(makeHeader())
    return concat([writer.preamble(), codec.encode(futureEvent)])
  }

  it('are preserved rather than rejected or relabelled', () => {
    const result = readMoqtrace(fileWithFutureEvent())
    expect(result.events).toHaveLength(1)
    expect(result.events[0]).toMatchObject({
      type: 'unknown',
      seq: 7,
      timestamp: 1234,
      peer: 'peer-a',
      eventType: 99,
    })
  })

  it('survive a read-modify-write round trip', () => {
    // A tool that reads a trace and writes it back must not turn the events it
    // did not understand into something else — that makes one reader's
    // ignorance permanent for every reader downstream of it.
    const once = readMoqtrace(fileWithFutureEvent())
    const twice = readMoqtrace(writeMoqtrace(once))

    expect(twice.events[0]).toEqual(once.events[0])
    const event = twice.events[0]
    if (event?.type !== 'unknown') throw new Error('expected an unknown event')
    expect(event.eventType).toBe(99)
    expect(event.fields.alpha).toBe(1)
    expect(new Uint8Array(event.fields.beta as Uint8Array)).toEqual(new Uint8Array([0xde, 0xad]))
  })

  it('keep their own event type on the wire', () => {
    const rewritten = writeMoqtrace(readMoqtrace(fileWithFutureEvent()))
    const view = new DataView(rewritten.buffer, rewritten.byteOffset, rewritten.byteLength)
    const headerLength = view.getUint32(12, true)
    const event = codec.decode(rewritten.subarray(16 + headerLength)) as Record<string, unknown>
    expect(event.e).toBe(99)
    expect(event.p).toBe('peer-a')
  })
})

describe('relay-tap events', () => {
  const traceId = new Uint8Array(TRACE_ID_LENGTH).fill(0xab)

  const events: TraceEvent[] = [
    {
      type: 'peer-connected',
      seq: 0,
      timestamp: 0,
      peer: 'peer-a',
      endpoint: 'https://relay.example.com/moq',
      transport: 'webtransport',
      role: 'subscriber',
      side: 'downstream',
    },
    {
      type: 'subscription-derivation',
      seq: 1,
      timestamp: 10,
      peer: 'peer-up',
      upstream: { peer: 'peer-up', requestId: 7n },
      downstream: [
        { peer: 'peer-a', requestId: 1n },
        { peer: 'peer-b', requestId: 4n },
      ],
      kind: 'shared',
      traceId,
      namespace: [new TextEncoder().encode('example.com'), new TextEncoder().encode('live')],
      trackName: new TextEncoder().encode('video'),
      tDownstreamReceived: 100,
      tUpstreamSent: 150,
      tUpstreamOkReceived: 4300,
      tDownstreamOkSent: 4350,
    },
    {
      type: 'peer-disconnected',
      seq: 2,
      timestamp: 20,
      peer: 'peer-a',
      errorCode: 0,
      reason: 'goaway',
    },
  ]

  it('round-trip', () => {
    const result = readMoqtrace(writeMoqtrace(makeTrace(events, { perspective: 'relay-tap' })))
    expect(result.events).toEqual(events)
  })

  it('round-trip with only the fields known at emission time', () => {
    // A source emits the derivation as soon as the downstream SUBSCRIBE lands,
    // before any of the later timestamps exist.
    const partial: TraceEvent = {
      type: 'subscription-derivation',
      seq: 0,
      timestamp: 0,
      peer: 'peer-up',
      upstream: { peer: 'peer-up', requestId: 7n },
      downstream: [{ peer: 'peer-a', requestId: 1n }],
      kind: 'created',
      tDownstreamReceived: 100,
    }
    expect(readMoqtrace(writeMoqtrace(makeTrace([partial]))).events[0]).toEqual(partial)
  })

  it('keep an unknown role, side and kind rather than failing', () => {
    const exotic: TraceEvent[] = [
      {
        type: 'peer-connected',
        seq: 0,
        timestamp: 0,
        peer: 'peer-a',
        role: 'archivist',
        side: 'sideways',
      },
      {
        type: 'subscription-derivation',
        seq: 1,
        timestamp: 1,
        peer: 'peer-up',
        upstream: { peer: 'peer-up', requestId: 1n },
        downstream: [],
        kind: 'reattached',
      },
    ]
    expect(readMoqtrace(writeMoqtrace(makeTrace(exotic))).events).toEqual(exotic)
  })

  it('write the trace id as sixteen raw bytes under traceId', () => {
    // Stitching a chain across operators only works if two implementations
    // produce identical bytes for it, so the wire form is the raw byte string
    // and nothing else — no hex, no base64, and not the key 'trace'.
    const bytes = writeMoqtrace(makeTrace([events[1] as TraceEvent]))
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const headerLength = view.getUint32(12, true)
    const event = codec.decode(bytes.subarray(16 + headerLength)) as Record<string, unknown>

    expect(event.traceId).toBeInstanceOf(Uint8Array)
    expect((event.traceId as Uint8Array).length).toBe(TRACE_ID_LENGTH)
    expect(event.trace).toBeUndefined()
  })

  it('refuse a trace id of the wrong length', () => {
    // Padding or truncating would let the event assert a chain identity it
    // never carried.
    const short: TraceEvent = {
      type: 'subscription-derivation',
      seq: 0,
      timestamp: 0,
      upstream: { peer: 'peer-up', requestId: 1n },
      downstream: [],
      kind: 'created',
      traceId: new Uint8Array([1, 2, 3]),
    }
    expect(() => writeMoqtrace(makeTrace([short]))).toThrow('traceId')
  })
})

describe('segmented traces', () => {
  function segmentHeader(sequence: number): TraceHeader {
    return makeHeader({
      startTime: 1700000000000 + sequence * 1000,
      segment: {
        sequence,
        durationMs: 1000,
        streamId: 'stream-1',
        continues: sequence > 0,
      },
    })
  }

  function segmented(segmentCount: number, eventsEach: number): Uint8Array {
    return writeMoqtraceSegments(
      Array.from({ length: segmentCount }, (_, segment) => ({
        header: segmentHeader(segment),
        // Sequence numbers restart per segment, which is exactly what makes a
        // reader that ignores boundaries rebuild a broken timeline.
        events: Array.from({ length: eventsEach }, (_, n) => annotation(n, `seg${segment}-ev${n}`)),
      })),
    )
  }

  it('are read back as separate segments', () => {
    const segments = readMoqtraceSegments(segmented(3, 2))
    expect(segments.map((s) => s.header.segment?.sequence)).toEqual([0, 1, 2])
    expect(segments.every((s) => s.events.length === 2)).toBe(true)
  })

  it('flatten in order for a reader that does not care about boundaries', () => {
    const trace = readMoqtrace(segmented(3, 2))
    expect(trace.header.segment?.sequence).toBe(0)
    expect(trace.events.map((e) => (e.type === 'annotation' ? e.label : e.type))).toEqual([
      'seg0-ev0',
      'seg0-ev1',
      'seg1-ev0',
      'seg1-ev1',
      'seg2-ev0',
      'seg2-ev1',
    ])
  })

  it('each carry a full preamble, so a reader can start at any of them', () => {
    const bytes = segmented(2, 1)
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const firstSegmentLength = 16 + view.getUint32(12, true)
    // Skip the first segment's preamble and its single event.
    const secondStart = bytes.indexOf(0x4d, firstSegmentLength)

    const tail = readMoqtrace(bytes.subarray(secondStart))
    expect(tail.header.segment?.sequence).toBe(1)
    expect(tail.events).toHaveLength(1)
  })

  it('a non-segmented file reads as exactly one segment with no segment field', () => {
    const segments = readMoqtraceSegments(writeMoqtrace(makeTrace([annotation(0, 'only')])))
    expect(segments).toHaveLength(1)
    expect(segments[0]?.header.segment).toBeUndefined()
  })

  it('refuse to write a segment whose header has no segment metadata', () => {
    // Without it a reader takes each segment for a complete file and rebuilds
    // a timeline that jumps backwards at every boundary.
    expect(() => writeMoqtraceSegments([{ header: makeHeader(), events: [] }])).toThrow('segment')
    expect(() => createMoqtraceWriter(segmentHeader(0)).startSegment(makeHeader())).toThrow(
      'segment',
    )
  })

  it('do not split on magic bytes that merely appear inside a payload', () => {
    // The eight bytes are ordinary data when they land inside a captured
    // payload. A reader that scanned for them without regard to item
    // boundaries would cut a trace that was never segmented, and everything
    // after the cut would be attributed to a segment that does not exist.
    const magicInPayload: TraceEvent = {
      type: 'object-payload',
      seq: 0,
      timestamp: 0,
      streamId: 4n,
      groupId: 1n,
      objectId: 0n,
      size: 8,
      payload: new TextEncoder().encode('MOQTRACE'),
    }
    const bytes = writeMoqtrace(makeTrace([magicInPayload, annotation(1, 'after')]))

    // The whole eight-byte sequence really is in there — otherwise this test
    // proves nothing, and a weaker check ('does it contain an M?') would let
    // it pass over a file that never held the magic at all.
    const magic = new TextEncoder().encode('MOQTRACE')
    const occurrences: number[] = []
    for (let i = 1; i + magic.length <= bytes.length; i++) {
      if (magic.every((byte, k) => bytes[i + k] === byte)) occurrences.push(i)
    }
    expect(occurrences, 'the payload should embed the magic bytes').toHaveLength(1)

    const segments = readMoqtraceSegments(bytes)
    expect(segments).toHaveLength(1)
    expect(segments[0]?.events).toHaveLength(2)
  })
})

describe('truncation', () => {
  it('is reported with the offset, and keeps what decoded', () => {
    // A truncated trace is still evidence, and the events before the cut are
    // exactly as valid as they were.
    const full = writeMoqtrace(makeTrace([annotation(0, 'kept'), annotation(1, 'cut-in-half')]))
    const truncated = full.subarray(0, full.length - 4)

    try {
      readMoqtrace(truncated)
      expect.unreachable('a truncated file must not read as a complete one')
    } catch (error) {
      expect(error).toBeInstanceOf(TruncatedTraceError)
      const truncation = error as TruncatedTraceError
      expect(truncation.offset).toBeLessThan(truncated.length)
      expect(truncation.trace?.events).toHaveLength(1)
      expect(truncation.trace?.events[0]).toMatchObject({ label: 'kept' })
    }
  })

  it('does not fire on a complete file', () => {
    // The distinction is only worth anything if a clean end of file stays
    // clean — an over-eager check would call every trace damaged.
    const bytes = writeMoqtrace(makeTrace([annotation(0, 'a'), annotation(1, 'b')]))
    expect(readMoqtrace(bytes).events).toHaveLength(2)
  })

  it('recovers at the next segment when asked', () => {
    // One damaged segment costs that segment, not the rest of the capture.
    const good = writeMoqtraceSegments(
      [0, 1, 2].map((sequence) => ({
        header: makeHeader({ segment: { sequence } }),
        events: [annotation(0, `seg${sequence}`)],
      })),
    )

    const damaged = new Uint8Array(good)
    const view = new DataView(damaged.buffer, damaged.byteOffset, damaged.byteLength)
    const firstEvent = 16 + view.getUint32(12, true)
    damaged[firstEvent] = 0x7f // an indefinite text string that never terminates
    damaged.fill(0x61, firstEvent + 1, firstEvent + 4)

    expect(() => readMoqtrace(damaged)).toThrow()

    const recovered = readMoqtraceSegments(damaged, { recover: true })
    const labels = recovered.flatMap((segment) =>
      segment.events.map((e) => (e.type === 'annotation' ? e.label : e.type)),
    )
    expect(labels).toEqual(['seg1', 'seg2'])
  })
})
