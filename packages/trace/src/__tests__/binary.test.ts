import { Encoder } from 'cbor-x'
import { describe, expect, it } from 'vitest'
import { createMoqtraceWriter, readMoqtrace, readMoqtraceHeader, writeMoqtrace } from '../binary.js'
import type { ControlMessageEvent, Trace, TraceEvent, TraceHeader } from '../types.js'
import { controlMessageFields } from '../types.js'

function makeHeader(overrides?: Partial<TraceHeader>): TraceHeader {
  return {
    protocol: 'moq-transport-14',
    perspective: 'client',
    detail: 'control',
    startTime: 1700000000000,
    ...overrides,
  }
}

function makeTrace(events: TraceEvent[], headerOverrides?: Partial<TraceHeader>): Trace {
  return {
    header: makeHeader(headerOverrides),
    events,
  }
}

/** Write then read back — the core round-trip helper. */
function roundTrip(events: TraceEvent[], headerOverrides?: Partial<TraceHeader>): Trace {
  return readMoqtrace(writeMoqtrace(makeTrace(events, headerOverrides)))
}

describe('binary .moqtrace format', () => {
  describe('preamble validation', () => {
    it('rejects files shorter than 16 bytes', () => {
      expect(() => readMoqtrace(new Uint8Array(10))).toThrow('too short')
    })

    it('rejects files with wrong magic bytes', () => {
      const bytes = new Uint8Array(20)
      bytes.set([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07], 0)
      expect(() => readMoqtrace(bytes)).toThrow('magic')
    })

    it('rejects unsupported version', () => {
      const bytes = writeMoqtrace(makeTrace([]))
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      view.setUint32(8, 99, true)
      expect(() => readMoqtrace(bytes)).toThrow('version')
    })

    it('rejects truncated header', () => {
      const bytes = writeMoqtrace(makeTrace([]))
      const truncated = bytes.slice(0, 17)
      const view = new DataView(truncated.buffer, truncated.byteOffset, truncated.byteLength)
      view.setUint32(12, 9999, true)
      expect(() => readMoqtrace(truncated)).toThrow('truncated')
    })

    it('starts with MOQTRACE magic bytes', () => {
      const bytes = writeMoqtrace(makeTrace([]))
      const magic = new TextDecoder().decode(bytes.slice(0, 8))
      expect(magic).toBe('MOQTRACE')
    })
  })

  describe('header round-trip', () => {
    it('preserves required fields', () => {
      const { header } = roundTrip([])
      expect(header.protocol).toBe('moq-transport-14')
      expect(header.perspective).toBe('client')
      expect(header.detail).toBe('control')
      expect(header.startTime).toBe(1700000000000)
    })

    it('preserves optional fields', () => {
      const { header } = roundTrip([], {
        endTime: 1700000060000,
        transport: 'webtransport',
        source: 'moqtap-devtools/0.1.0',
        endpoint: 'https://relay.example.com/moq',
        sessionId: 'abc-123',
        custom: { debug: true, version: 42 },
      })
      expect(header.endTime).toBe(1700000060000)
      expect(header.transport).toBe('webtransport')
      expect(header.source).toBe('moqtap-devtools/0.1.0')
      expect(header.endpoint).toBe('https://relay.example.com/moq')
      expect(header.sessionId).toBe('abc-123')
      expect(header.custom).toEqual({ debug: true, version: 42 })
    })

    it('readMoqtraceHeader returns only the header', () => {
      const bytes = writeMoqtrace(
        makeTrace([
          {
            type: 'annotation',
            seq: 0,
            timestamp: 100,
            label: 'test',
            data: null,
          },
        ]),
      )
      const header = readMoqtraceHeader(bytes)
      expect(header.protocol).toBe('moq-transport-14')
      expect(header.perspective).toBe('client')
    })

    it('omits undefined optional fields', () => {
      const { header } = roundTrip([])
      expect(header.endTime).toBeUndefined()
      expect(header.transport).toBeUndefined()
      expect(header.source).toBeUndefined()
    })
  })

  describe('empty trace', () => {
    it('round-trips a trace with no events', () => {
      const { events } = roundTrip([])
      expect(events).toEqual([])
    })
  })

  describe('event round-trips', () => {
    it('control message event', () => {
      const { events } = roundTrip([
        {
          type: 'control',
          seq: 0,
          timestamp: 1000,
          direction: 1,
          messageType: 0x03,
          message: { type: 'subscribe', trackName: 'video' },
        },
      ])
      expect(events).toHaveLength(1)
      const e = events[0]!
      expect(e.type).toBe('control')
      if (e.type === 'control') {
        expect(e.seq).toBe(0)
        expect(e.timestamp).toBe(1000)
        expect(e.direction).toBe(1)
        expect(e.messageType).toBe(0x03)
        expect(e.message).toEqual({ type: 'subscribe', trackName: 'video' })
        expect(e.raw).toBeUndefined()
      }
    })

    it('control message with a stream id', () => {
      // Draft-17 put every request on its own bidirectional stream and dropped
      // request ids from responses, so a reader can only tie a response back to
      // its request through the stream it arrived on.
      const { events } = roundTrip([
        {
          type: 'control',
          seq: 0,
          timestamp: 1000,
          direction: 1,
          messageType: 0x03,
          message: { type: 'subscribe_ok', track_alias: 7 },
          streamId: 12n,
        },
      ])
      const e = events[0]!
      expect(e.type).toBe('control')
      if (e.type === 'control') {
        expect(e.streamId).toBe(12n)
      }
    })

    it('control message without a stream id omits the key', () => {
      // A recorder with no stream context must not be made to invent one, and a
      // reader has to tell "unknown" apart from stream 0.
      const { events } = roundTrip([
        {
          type: 'control',
          seq: 0,
          timestamp: 1000,
          direction: 0,
          messageType: 0x03,
          message: { type: 'subscribe' },
        },
      ])
      const e = events[0]!
      if (e.type === 'control') {
        expect(e.streamId).toBeUndefined()
      }
    })

    it('control message with raw bytes', () => {
      const raw = new Uint8Array([0x03, 0x00, 0x0a, 0xff])
      const { events } = roundTrip([
        {
          type: 'control',
          seq: 0,
          timestamp: 500,
          direction: 0,
          messageType: 0x03,
          message: { type: 'subscribe' },
          raw,
        },
      ])
      const e = events[0]!
      if (e.type === 'control') {
        expect(e.raw).toBeInstanceOf(Uint8Array)
        expect(Array.from(e.raw!)).toEqual([0x03, 0x00, 0x0a, 0xff])
      }
    })

    it('stream-opened event', () => {
      const { events } = roundTrip([
        {
          type: 'stream-opened',
          seq: 1,
          timestamp: 2000,
          streamId: 42n,
          direction: 1,
          streamType: 0,
        },
      ])
      const e = events[0]!
      expect(e.type).toBe('stream-opened')
      if (e.type === 'stream-opened') {
        expect(e.streamId).toBe(42n)
        expect(e.direction).toBe(1)
        expect(e.streamType).toBe(0)
      }
    })

    it('stream-closed event', () => {
      const { events } = roundTrip([
        {
          type: 'stream-closed',
          seq: 2,
          timestamp: 3000,
          streamId: 42n,
          errorCode: 0,
        },
      ])
      const e = events[0]!
      expect(e.type).toBe('stream-closed')
      if (e.type === 'stream-closed') {
        expect(e.streamId).toBe(42n)
        expect(e.errorCode).toBe(0)
      }
    })

    it('object-header event with bigint fields', () => {
      const { events } = roundTrip([
        {
          type: 'object-header',
          seq: 3,
          timestamp: 4000,
          streamId: 100n,
          groupId: 5n,
          objectId: 99n,
          publisherPriority: 128,
          objectStatus: 0,
        },
      ])
      const e = events[0]!
      expect(e.type).toBe('object-header')
      if (e.type === 'object-header') {
        expect(e.streamId).toBe(100n)
        expect(e.groupId).toBe(5n)
        expect(e.objectId).toBe(99n)
        expect(e.publisherPriority).toBe(128)
        expect(e.objectStatus).toBe(0)
      }
    })

    it('object-payload event with payload bytes', () => {
      const payload = new Uint8Array([0xde, 0xad, 0xbe, 0xef])
      const { events } = roundTrip([
        {
          type: 'object-payload',
          seq: 4,
          timestamp: 5000,
          streamId: 100n,
          groupId: 5n,
          objectId: 99n,
          size: 4,
          payload,
        },
      ])
      const e = events[0]!
      expect(e.type).toBe('object-payload')
      if (e.type === 'object-payload') {
        expect(e.size).toBe(4)
        expect(e.payload).toBeInstanceOf(Uint8Array)
        expect(Array.from(e.payload!)).toEqual([0xde, 0xad, 0xbe, 0xef])
      }
    })

    it('object-payload event without payload', () => {
      const { events } = roundTrip([
        {
          type: 'object-payload',
          seq: 4,
          timestamp: 5000,
          streamId: 100n,
          groupId: 5n,
          objectId: 99n,
          size: 1024,
        },
      ])
      const e = events[0]!
      if (e.type === 'object-payload') {
        expect(e.size).toBe(1024)
        expect(e.payload).toBeUndefined()
      }
    })

    it('state-change event', () => {
      const { events } = roundTrip([
        {
          type: 'state-change',
          seq: 5,
          timestamp: 6000,
          from: 'idle',
          to: 'setup',
        },
      ])
      const e = events[0]!
      expect(e.type).toBe('state-change')
      if (e.type === 'state-change') {
        expect(e.from).toBe('idle')
        expect(e.to).toBe('setup')
      }
    })

    it('error event', () => {
      const { events } = roundTrip([
        {
          type: 'error',
          seq: 6,
          timestamp: 7000,
          errorCode: 1,
          reason: 'Protocol violation',
        },
      ])
      const e = events[0]!
      expect(e.type).toBe('error')
      if (e.type === 'error') {
        expect(e.errorCode).toBe(1)
        expect(e.reason).toBe('Protocol violation')
      }
    })

    it('annotation event', () => {
      const { events } = roundTrip([
        {
          type: 'annotation',
          seq: 7,
          timestamp: 8000,
          label: 'user-note',
          data: { key: 'value', nested: [1, 2, 3] },
        },
      ])
      const e = events[0]!
      expect(e.type).toBe('annotation')
      if (e.type === 'annotation') {
        expect(e.label).toBe('user-note')
        expect(e.data).toEqual({ key: 'value', nested: [1, 2, 3] })
      }
    })

    it('annotation with null data round-trips correctly', () => {
      const { events } = roundTrip([
        {
          type: 'annotation',
          seq: 0,
          timestamp: 0,
          label: 'marker',
          data: null,
        },
      ])
      const e = events[0]!
      if (e.type === 'annotation') {
        expect(e.data).toBeNull()
      }
    })

    it('large bigint values survive round-trip', () => {
      const { events } = roundTrip([
        {
          type: 'stream-opened',
          seq: 0,
          timestamp: 0,
          streamId: 0xffffffffffffffffn,
          direction: 0,
          streamType: 2,
        },
      ])
      const e = events[0]!
      if (e.type === 'stream-opened') {
        expect(e.streamId).toBe(0xffffffffffffffffn)
      }
    })
  })

  describe('multiple events', () => {
    it('preserves event order and sequence numbers', () => {
      const { events } = roundTrip([
        {
          type: 'state-change',
          seq: 0,
          timestamp: 100,
          from: 'idle',
          to: 'setup',
        },
        {
          type: 'control',
          seq: 1,
          timestamp: 200,
          direction: 0,
          messageType: 0x20,
          message: { type: 'client_setup' },
        },
        {
          type: 'control',
          seq: 2,
          timestamp: 300,
          direction: 1,
          messageType: 0x21,
          message: { type: 'server_setup' },
        },
        {
          type: 'state-change',
          seq: 3,
          timestamp: 400,
          from: 'setup',
          to: 'ready',
        },
        {
          type: 'annotation',
          seq: 4,
          timestamp: 500,
          label: 'done',
          data: null,
        },
      ])
      expect(events).toHaveLength(5)
      expect(events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4])
      expect(events.map((e) => e.timestamp)).toEqual([100, 200, 300, 400, 500])
      expect(events.map((e) => e.type)).toEqual([
        'state-change',
        'control',
        'control',
        'state-change',
        'annotation',
      ])
    })
  })

  describe('streaming writer', () => {
    it('produces same output as one-shot write', () => {
      const events: TraceEvent[] = [
        {
          type: 'state-change',
          seq: 0,
          timestamp: 0,
          from: 'idle',
          to: 'setup',
        },
        {
          type: 'control',
          seq: 1,
          timestamp: 100,
          direction: 0,
          messageType: 0x20,
          message: {},
        },
        {
          type: 'annotation',
          seq: 2,
          timestamp: 200,
          label: 'test',
          data: null,
        },
      ]
      const trace = makeTrace(events)

      const oneShot = writeMoqtrace(trace)

      const writer = createMoqtraceWriter(trace.header)
      const chunks: Uint8Array[] = [writer.preamble()]
      for (const event of events) {
        chunks.push(writer.writeEvent(event))
      }
      const totalLen = chunks.reduce((sum, c) => sum + c.length, 0)
      const streamed = new Uint8Array(totalLen)
      let offset = 0
      for (const chunk of chunks) {
        streamed.set(chunk, offset)
        offset += chunk.length
      }

      expect(Array.from(streamed)).toEqual(Array.from(oneShot))
    })

    it('streaming output is readable by readMoqtrace', () => {
      const header = makeHeader({ transport: 'webtransport' })
      const writer = createMoqtraceWriter(header)
      const events: TraceEvent[] = [
        {
          type: 'stream-opened',
          seq: 0,
          timestamp: 0,
          streamId: 1n,
          direction: 0,
          streamType: 0,
        },
        {
          type: 'object-header',
          seq: 1,
          timestamp: 50,
          streamId: 1n,
          groupId: 0n,
          objectId: 0n,
          publisherPriority: 128,
          objectStatus: 0,
        },
      ]

      const chunks = [writer.preamble(), ...events.map((e) => writer.writeEvent(e))]
      const totalLen = chunks.reduce((sum, c) => sum + c.length, 0)
      const bytes = new Uint8Array(totalLen)
      let offset = 0
      for (const chunk of chunks) {
        bytes.set(chunk, offset)
        offset += chunk.length
      }

      const result = readMoqtrace(bytes)
      expect(result.header.transport).toBe('webtransport')
      expect(result.events).toHaveLength(2)
      expect(result.events[0]?.type).toBe('stream-opened')
      expect(result.events[1]?.type).toBe('object-header')
    })
  })

  describe('unknown event types', () => {
    // The test that stood here wrote a real annotation and asserted it read
    // back as an annotation, under the name 'unknown event types are
    // preserved as annotations'. It measured nothing about unknown events —
    // and the behaviour it named was itself the defect, because relabelling
    // rewrites the event type on the next write. Real coverage is in
    // format-v2.test.ts under 'unknown event types'.
    it('a known event type is not mistaken for an unknown one', () => {
      const result = roundTrip([
        { type: 'annotation', seq: 0, timestamp: 100, label: 'before', data: null },
      ])
      expect(result.events).toHaveLength(1)
      expect(result.events[0]?.type).toBe('annotation')
    })
  })
})

describe('unrecognised keys on a recognised event type', () => {
  const opened: TraceEvent = {
    type: 'stream-opened',
    seq: 0,
    timestamp: 100,
    streamId: 4n,
    direction: 1,
    streamType: 0,
  }

  it('are kept rather than dropped', () => {
    // "Unknown keys MUST be ignored" is a rule about reading past them. A
    // reader that drops one turns any read-modify-write into a file that
    // looks like it never carried the key — and the tools that rewrite a
    // trace are exactly the ones it passes through on its way to someone
    // else.
    const result = roundTrip([{ ...opened, extra: { ta: 7, sg: 2 } }])
    expect(result.events[0]?.extra).toEqual({ ta: 7, sg: 2 })
  })

  it('are absent, not empty, when the event carried none', () => {
    // An empty object would make `extra != null` true everywhere and turn a
    // "this file had unknown keys" check into a "this file was read by this
    // version" check.
    expect(roundTrip([opened]).events[0]?.extra).toBeUndefined()
  })

  it('never displace a key the event type owns', () => {
    // A CBOR map with a duplicate key is malformed. The field is what a
    // reader produced, so the field wins and the colliding entry is dropped.
    const result = roundTrip([{ ...opened, extra: { sid: 999, ta: 7 } }])
    const event = result.events[0]
    expect(event?.type).toBe('stream-opened')
    if (event?.type !== 'stream-opened') throw new Error('unreachable')
    expect(event.streamId).toBe(4n)
    expect(event.extra).toEqual({ ta: 7 })
  })

  it('are not collected on an event type no reader knows', () => {
    // `UnknownEvent.fields` already holds every non-common key. Collecting
    // them into `extra` as well writes each one twice.
    const result = roundTrip([
      { type: 'unknown', seq: 0, timestamp: 0, eventType: 99, fields: { note: 'hi', count: 3 } },
    ])
    const event = result.events[0]
    expect(event?.type).toBe('unknown')
    if (event?.type !== 'unknown') throw new Error('unreachable')
    expect(event.fields).toEqual({ note: 'hi', count: 3 })
    expect(event.extra).toBeUndefined()
  })
})

describe('the "msg" field of a control event', () => {
  const codec = new Encoder({ useRecords: false, mapsAsObjects: true })

  // What every `capture-*` case in the conformance corpus carries in "msg":
  // the CLI that wrote those files rendered the decoded message with Rust's
  // `Debug` rather than emitting a map, and they still have to open.
  const DEBUG_TEXT = 'Draft16(ClientSetup(ClientSetup { parameters: [] }))'

  /**
   * A one-event file built from a hand-written CBOR event map.
   *
   * The shapes that matter here — an absent `"msg"`, a text one — are exactly
   * the ones this package's encoder will not produce, so a round trip through
   * `writeMoqtrace` cannot set them up.
   */
  function fileWithEventMap(event: Record<string, unknown>): Uint8Array {
    const preamble = createMoqtraceWriter(makeHeader()).preamble()
    const eventBytes = codec.encode(event)
    const file = new Uint8Array(preamble.length + eventBytes.length)
    file.set(preamble, 0)
    file.set(eventBytes, preamble.length)
    return file
  }

  /** The single event map a one-event file carries, as it sits on the wire. */
  function eventMapIn(file: Uint8Array): Record<string, unknown> {
    const view = new DataView(file.buffer, file.byteOffset, file.byteLength)
    const headerLength = view.getUint32(12, true)
    return codec.decode(file.subarray(16 + headerLength)) as Record<string, unknown>
  }

  function controlEvent(message: unknown): TraceEvent {
    return { type: 'control', seq: 0, timestamp: 1000, direction: 0, messageType: 0x03, message }
  }

  /** The one control event of a trace, or a failure naming what came instead. */
  function onlyControlEvent(trace: Trace): ControlMessageEvent {
    expect(trace.events).toHaveLength(1)
    const event = trace.events[0]
    if (event?.type !== 'control') throw new Error(`expected a control event, got ${event?.type}`)
    return event
  }

  it('reads an event carrying no "msg" key as an empty map rather than dropping it', () => {
    // Event 0 is one of the types sampling MUST NOT drop, so a reader that
    // treated the absence as a malformed event would discard exactly the
    // events the format promises will always be there.
    const trace = readMoqtrace(fileWithEventMap({ n: 0, t: 1000, e: 0, d: 1, mt: 0x03 }))
    const event = onlyControlEvent(trace)
    expect(event.message).toEqual({})
    expect(event.messageType).toBe(0x03)
  })

  it('hands back the text of a pre-spec "msg" instead of rejecting the event', () => {
    const trace = readMoqtrace(
      fileWithEventMap({ n: 0, t: 1000, e: 0, d: 0, mt: 0x20, msg: DEBUG_TEXT }),
    )
    expect(onlyControlEvent(trace).message).toBe(DEBUG_TEXT)
  })

  it('writes a text "msg" back as the same text after a read-modify-write', () => {
    // A trace reaches its reader through filters, redaction passes and
    // re-downloads. Any of them replacing the only decode these recordings
    // have with an empty map would destroy it for everyone downstream.
    const original = fileWithEventMap({ n: 0, t: 1000, e: 0, d: 0, mt: 0x20, msg: DEBUG_TEXT })
    const rewritten = writeMoqtrace(readMoqtrace(original))

    expect(eventMapIn(rewritten).msg).toBe(DEBUG_TEXT)
    expect(onlyControlEvent(readMoqtrace(rewritten)).message).toBe(DEBUG_TEXT)
  })

  it('keeps a "msg" that is neither a map nor a string exactly as it read it', () => {
    // Verbatim means the shape the writer chose, not the one shape we have
    // happened to see. `null` is a value on the wire — promoting it to `{}`
    // is the same silent content change as dropping a key — and absence is
    // the only thing that becomes an empty map.
    const withNull = readMoqtrace(fileWithEventMap({ n: 0, t: 1, e: 0, d: 0, mt: 3, msg: null }))
    expect(onlyControlEvent(withNull).message).toBeNull()
    expect(eventMapIn(writeMoqtrace(withNull)).msg).toBeNull()

    const withList = readMoqtrace(fileWithEventMap({ n: 0, t: 1, e: 0, d: 0, mt: 3, msg: [1, 2] }))
    expect(onlyControlEvent(withList).message).toEqual([1, 2])
  })

  it('writes the key with an empty map when it decoded no fields', () => {
    const map = eventMapIn(writeMoqtrace(makeTrace([controlEvent({})])))
    expect(Object.hasOwn(map, 'msg')).toBe(true)
    expect(map.msg).toEqual({})
  })

  it('writes an empty map for an event that reached the encoder with no message', () => {
    // `message` is required by the type, but the type is not there at
    // runtime: a JS caller, an event revived from JSON, or code built against
    // an older shape all arrive with the field missing. Passing that straight
    // through encodes CBOR `undefined` — a simple value, not a map — which is
    // the one thing the format tells a writer not to put here.
    const event = {
      type: 'control',
      seq: 0,
      timestamp: 1,
      direction: 0,
      messageType: 0x03,
    } as unknown as TraceEvent

    const map = eventMapIn(writeMoqtrace(makeTrace([event])))
    expect(Object.hasOwn(map, 'msg')).toBe(true)
    expect(map.msg).toEqual({})
  })

  it('leaves snake_case field names alone on the wire and on the way back', () => {
    // snake_case is what the drafts and the shared codec vectors use, and it
    // is the whole reason a reader can address `request_id` without knowing
    // which implementation wrote the file. Anything that camelCased the keys
    // in passing would rename every field in the corpus.
    const fields = { request_id: 7, track_alias: 9, group_order: 1 }
    const written = writeMoqtrace(makeTrace([controlEvent(fields)]))

    expect(Object.keys(eventMapIn(written).msg as Record<string, unknown>)).toEqual([
      'request_id',
      'track_alias',
      'group_order',
    ])
    expect(onlyControlEvent(readMoqtrace(written)).message).toEqual(fields)
  })

  it('does not let a field be read off "msg" without narrowing first', () => {
    // The compile-time half of the same rule, enforced by `tsc --build`.
    // While `message` was typed `Record<string, unknown>` this line compiled
    // and read `undefined` on every corpus capture, with nothing to point at.
    const event = onlyControlEvent(
      readMoqtrace(fileWithEventMap({ n: 0, t: 1, e: 0, d: 0, mt: 0x20, msg: DEBUG_TEXT })),
    )
    // @ts-expect-error - `message` is `unknown`, and the corpus proves it can
    // be a string, so reading a key off it has to be a compile error.
    const requestId: unknown = event.message.request_id
    expect(requestId).toBeUndefined()
  })

  it('offers the decoded fields only when "msg" really is a map', () => {
    expect(controlMessageFields({ request_id: 7 })).toEqual({ request_id: 7 })
    expect(controlMessageFields(DEBUG_TEXT)).toBeUndefined()
    expect(controlMessageFields(null)).toBeUndefined()
    expect(controlMessageFields([1, 2])).toBeUndefined()
    // A CBOR byte string decodes to a Uint8Array, which `typeof` calls an
    // object: the case a narrowing check written by hand at the call site
    // gets wrong, and the reason this one is worth exporting.
    expect(controlMessageFields(new Uint8Array([1, 2]))).toBeUndefined()
  })
})
