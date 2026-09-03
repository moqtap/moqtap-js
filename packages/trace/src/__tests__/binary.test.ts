import { Encoder, Tag } from 'cbor-x'
import { describe, expect, it } from 'vitest'
import type { RecoveredRegion } from '../binary.js'
import {
  cborToEvent,
  cborToHeader,
  createMoqtraceWriter,
  MalformedHeaderError,
  readMoqtrace,
  readMoqtraceHeader,
  readMoqtraceSegments,
  writeMoqtrace,
} from '../binary.js'
import { MAX_ERROR_RAW_BYTES } from '../recorder.js'
import type {
  ControlMessageEvent,
  ObjectPayloadEvent,
  PeerConnectedEvent,
  SamplingInfo,
  StreamOpenedEvent,
  SubscriptionDerivationEvent,
  Trace,
  TraceErrorEvent,
  TraceEvent,
  TraceHeader,
} from '../types.js'
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

const codec = new Encoder({ useRecords: false, mapsAsObjects: true })

/**
 * A one-event file built from a hand-written CBOR event map.
 *
 * Two kinds of shape need this. The ones this package's encoder will not
 * produce — an absent `"msg"`, a text one — cannot be set up by a round trip
 * through `writeMoqtrace` at all. And the ones another writer produces, such
 * as an identifier in the narrowest CBOR integer that holds it rather than in
 * eight bytes, come back through our own encoder looking like ours rather than
 * theirs, which is exactly the difference a reader's type conversion turns on.
 */
function fileWithEventMap(event: Record<string, unknown>): Uint8Array {
  return fileWithEventMaps(event)
}

/** The same, for the several-event file a "does one bad event cost the rest" test needs. */
function fileWithEventMaps(...events: Record<string, unknown>[]): Uint8Array {
  const preamble = createMoqtraceWriter(makeHeader()).preamble()
  const chunks = events.map((event) => codec.encode(event))
  const file = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, preamble.length))
  file.set(preamble, 0)
  let offset = preamble.length
  for (const chunk of chunks) {
    file.set(chunk, offset)
    offset += chunk.length
  }
  return file
}

/** The single event map a one-event file carries, as it sits on the wire. */
function eventMapIn(file: Uint8Array): Record<string, unknown> {
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength)
  const headerLength = view.getUint32(12, true)
  return codec.decode(file.subarray(16 + headerLength)) as Record<string, unknown>
}

/**
 * How many entries the CBOR map starting at `at` *declares*, read off the map
 * header rather than counted from the decoded object.
 *
 * Decoding cannot see a duplicate key — cbor-x collapses one into a single
 * property, and so would a `Map` — so the declared count is the only place a
 * map that wrote `"ta"` twice differs from a well-formed one. A CBOR map with
 * a duplicate key is malformed, and no reader is obliged to make sense of it.
 */
function declaredMapEntriesAt(file: Uint8Array, at: number): number {
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength)
  const head = file[at]
  if (head == null || head < 0xa0 || head > 0xba) {
    // 0xbf, an indefinite-length map, would land here: it declares no count at
    // all, and nothing this package writes takes that form.
    throw new Error(`expected a definite-length CBOR map, got initial byte ${head}`)
  }
  if (head <= 0xb7) return head - 0xa0
  if (head === 0xb8) return view.getUint8(at + 1)
  // cbor-x writes an object's entry count in two bytes whatever its size, so
  // this is the branch that runs in practice.
  return head === 0xb9 ? view.getUint16(at + 1, false) : view.getUint32(at + 1, false)
}

/** The same, for the single event map of a one-event file. */
function declaredEventMapEntries(file: Uint8Array): number {
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength)
  return declaredMapEntriesAt(file, 16 + view.getUint32(12, true))
}

/** The same, for the header map, which always begins at byte 16. */
function declaredHeaderMapEntries(file: Uint8Array): number {
  return declaredMapEntriesAt(file, 16)
}

/** The header map of a file, as it sits on the wire. */
function headerMapIn(file: Uint8Array): Record<string, unknown> {
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength)
  return codec.decode(file.subarray(16, 16 + view.getUint32(12, true))) as Record<string, unknown>
}

/**
 * The header map's keys in the order they were written.
 *
 * cbor-x decodes a map into an object whose property order is the wire order,
 * so this is what a store written before its map's own keys would disturb —
 * and the only thing that would, since a CBOR map is unordered and everything
 * else about the file would look the same.
 */
function headerKeysInOrder(file: Uint8Array): string[] {
  return Object.keys(headerMapIn(file))
}

/**
 * Whether a file carries `key` as a CBOR text string, read off the bytes.
 *
 * Decoding cannot answer this for every key: cbor-x rewrites `"__proto__"` to
 * `"__proto_"` on the way out of its decoder, so a file that really carries
 * the first is indistinguishable, after a decode, from one that carries the
 * second. The bytes are the only place the two differ, and the only place the
 * Rust reader's view of the file can be checked from here.
 *
 * Definite-length text of fewer than 24 bytes only — every key in this format
 * and every key these tests write is one.
 */
function carriesTextKey(file: Uint8Array, key: string): boolean {
  const text = new TextEncoder().encode(key)
  if (text.length >= 24) throw new Error(`${key} is too long for a one-byte CBOR text head`)
  const needle = new Uint8Array([0x60 + text.length, ...text])
  outer: for (let at = 0; at + needle.length <= file.length; at++) {
    for (let i = 0; i < needle.length; i++) if (file[at + i] !== needle[i]) continue outer
    return true
  }
  return false
}

/**
 * A file whose header is a hand-written CBOR map, carrying one annotation
 * event so a reader that returns no events is visibly not the same as one that
 * refused the header.
 *
 * Needed for the same reason {@link fileWithEventMap} is: none of the header
 * shapes these tests are about — an absent `"protocol"`, a `"segment"` that is
 * not a map, a fractional `"endTime"` — can be set up by a round trip through
 * `writeMoqtrace`, which will not produce any of them.
 */
function fileWithHeaderMap(header: Record<string, unknown>): Uint8Array {
  const headerCbor = codec.encode(header)
  const event = codec.encode({ n: 0, t: 0, e: 7, label: 'only', data: null })
  const file = new Uint8Array(16 + headerCbor.length + event.length)
  file.set(new TextEncoder().encode('MOQTRACE'), 0)
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength)
  view.setUint32(8, 2, true)
  view.setUint32(12, headerCbor.length, true)
  file.set(headerCbor, 16)
  file.set(event, 16 + headerCbor.length)
  return file
}

/** The four keys every header must carry, as they sit in a CBOR map. */
const REQUIRED_HEADER_MAP: Record<string, unknown> = {
  protocol: 'moq-transport-14',
  perspective: 'client',
  detail: 'control',
  startTime: 1700000000000,
}

/** Read a header out of a hand-written CBOR map. */
function readHeaderMap(header: Record<string, unknown>): TraceHeader {
  return readMoqtraceHeader(fileWithHeaderMap(header))
}

/** Read a hand-written header, then write the whole trace back out. */
function rewriteHeaderMap(header: Record<string, unknown>): Record<string, unknown> {
  return headerMapIn(writeMoqtrace(readMoqtrace(fileWithHeaderMap(header))))
}

/**
 * The initial byte of whatever a file wrote for `"effectiveRate"`.
 *
 * Read off the bytes rather than off a decoded value because cbor-x collapses
 * a CBOR float carrying `1.0` onto the JS number `1`, which is precisely the
 * difference the two implementations had: one wrote a float64 there and the
 * other an integer, for the same trace. `0x00`-`0x1b` is a CBOR unsigned
 * integer; `0xf9`, `0xfa` and `0xfb` are the three float widths.
 */
function rateInitialByte(file: Uint8Array): number {
  const key = new Uint8Array([0x6d, ...new TextEncoder().encode('effectiveRate')])
  outer: for (let at = 0; at + key.length < file.length; at++) {
    for (let i = 0; i < key.length; i++) if (file[at + i] !== key[i]) continue outer
    return file[at + key.length] as number
  }
  throw new Error('the file wrote no "effectiveRate"')
}

/** A file this package wrote, whose header carries `sampling`. */
function fileWithSampling(sampling: SamplingInfo): Uint8Array {
  return writeMoqtrace(makeTrace([], { sampling }))
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

  // `x-` keys: the range SPEC.md reserves for private use and promises never to
  // define, which is the whole requirement for a test about keys the format
  // does not know. These used `ta` and `sg` until those became real Event 1
  // keys and turned the tests red, then `zz` and `note`, which are merely
  // unclaimed — a key the format might plausibly want later has the same
  // failure ahead of it.

  it('are kept rather than dropped', () => {
    // "Unknown keys MUST be ignored" is a rule about reading past them. A
    // reader that drops one turns any read-modify-write into a file that
    // looks like it never carried the key — and the tools that rewrite a
    // trace are exactly the ones it passes through on its way to someone
    // else.
    const result = roundTrip([{ ...opened, extra: { 'x-zz': 7, 'x-note': 'hi' } }])
    expect(result.events[0]?.extra).toEqual({ 'x-zz': 7, 'x-note': 'hi' })
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
    const result = roundTrip([{ ...opened, extra: { sid: 999, 'x-zz': 7 } }])
    const event = result.events[0]
    expect(event?.type).toBe('stream-opened')
    if (event?.type !== 'stream-opened') throw new Error('unreachable')
    expect(event.streamId).toBe(4n)
    expect(event.extra).toEqual({ 'x-zz': 7 })
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

describe('the stream-header identifiers on a stream-opened event', () => {
  const opened: StreamOpenedEvent = {
    type: 'stream-opened',
    seq: 0,
    timestamp: 100,
    streamId: 4n,
    direction: 1,
    streamType: 0,
  }

  /** The one stream-opened event of a trace, or a failure naming what came instead. */
  function onlyStreamOpened(trace: Trace): StreamOpenedEvent {
    expect(trace.events).toHaveLength(1)
    const event = trace.events[0]
    if (event?.type !== 'stream-opened') {
      throw new Error(`expected a stream-opened event, got ${event?.type}`)
    }
    return event
  }

  // Each of the four asserts the type as well as the value, because a plain
  // equality against a small literal passes for a `number` too — and `number`
  // is what an implementer gets by following this event's own `st` and `d`.
  // The type is the thing under test; the value only proves nothing dropped it
  // on the way.

  it('reads a track alias back as a bigint', () => {
    const event = onlyStreamOpened(roundTrip([{ ...opened, trackAlias: 7n }]))
    expect(event.trackAlias).toBe(7n)
    expect(typeof event.trackAlias).toBe('bigint')
  })

  it('reads a subgroup id back as a bigint', () => {
    const event = onlyStreamOpened(roundTrip([{ ...opened, streamType: 0, subgroupId: 2n }]))
    expect(event.subgroupId).toBe(2n)
    expect(typeof event.subgroupId).toBe('bigint')
  })

  it('reads a fetch request id back as a bigint', () => {
    const event = onlyStreamOpened(roundTrip([{ ...opened, streamType: 2, fetchRequestId: 9n }]))
    expect(event.fetchRequestId).toBe(9n)
    expect(typeof event.fetchRequestId).toBe('bigint')
  })

  it('reads a group id back as a bigint, comparable with an object header', () => {
    // The comparison the type exists for. As a `number` this reads
    // `42 === 42n` and answers `false`, silently, for two fields naming the
    // same group — and both events are in every `headers` recording.
    const trace = roundTrip([
      { ...opened, streamType: 1, groupId: 42n },
      {
        type: 'object-header',
        seq: 1,
        timestamp: 200,
        streamId: 4n,
        groupId: 42n,
        objectId: 0n,
        publisherPriority: 128,
        objectStatus: 0,
      },
    ])
    const [stream, header] = trace.events
    if (stream?.type !== 'stream-opened' || header?.type !== 'object-header') {
      throw new Error('expected a stream-opened event followed by an object-header one')
    }
    expect(typeof stream.groupId).toBe('bigint')
    expect(stream.groupId === header.groupId).toBe(true)
  })

  it('converts a narrow integer from another writer to a bigint too', () => {
    // ciborium writes an identifier in the fewest bytes that hold it, so a
    // file from `moqtap-trace` carries these as CBOR integers that cbor-x
    // hands back as JS numbers. The conversion is the reader's job; nothing
    // upstream will have done it.
    const event = onlyStreamOpened(
      readMoqtrace(
        fileWithEventMap({ n: 0, t: 100, e: 1, sid: 4, d: 1, st: 2, ta: 7, fri: 9, g: 3 }),
      ),
    )
    expect(event.trackAlias).toBe(7n)
    expect(event.fetchRequestId).toBe(9n)
    expect(event.groupId).toBe(3n)
    for (const value of [event.trackAlias, event.fetchRequestId, event.groupId]) {
      expect(typeof value).toBe('bigint')
    }
  })

  it('round-trips an event carrying none of them', () => {
    // Every one is optional, and a recording made before they existed has
    // none. Absent has to stay absent rather than become a zero, which would
    // claim the stream carried track alias 0.
    expect(onlyStreamOpened(roundTrip([opened]))).toEqual(opened)
    const map = eventMapIn(writeMoqtrace(makeTrace([opened])))
    for (const key of ['ta', 'sg', 'fri', 'g']) {
      expect(Object.hasOwn(map, key)).toBe(false)
    }
  })

  it('never collects one of them into `extra`', () => {
    // The bug this test is here for: a key read into a named field but left
    // out of `VARIANT_KEYS` lands in `extra` as well, and writing the event
    // back then emits it from both places. Only the genuinely unrecognised key
    // belongs there.
    const event = onlyStreamOpened(
      readMoqtrace(
        fileWithEventMap({
          n: 0,
          t: 100,
          e: 1,
          sid: 4,
          d: 1,
          st: 0,
          ta: 7,
          sg: 2,
          fri: 9,
          g: 3,
          'x-zz': 'from the future',
        }),
      ),
    )
    expect(event.extra).toEqual({ 'x-zz': 'from the future' })
  })

  it('keeps a key that is out of scope for the stream type rather than rejecting the event', () => {
    // A writer must not put a subgroup id on a fetch stream. A reader that met
    // one and rejected the event would throw away the stream id, direction and
    // fetch request id that were fine, over one field it can simply disregard.
    const event = onlyStreamOpened(
      readMoqtrace(fileWithEventMap({ n: 0, t: 100, e: 1, sid: 4, d: 1, st: 2, sg: 2, fri: 9 })),
    )
    expect(event.streamType).toBe(2)
    expect(event.fetchRequestId).toBe(9n)
    expect(event.subgroupId).toBe(2n)
    expect(event.extra).toBeUndefined()
  })

  it('writes each key exactly once', () => {
    const file = writeMoqtrace(
      makeTrace([
        {
          ...opened,
          streamType: 0,
          trackAlias: 7n,
          subgroupId: 2n,
          fetchRequestId: 9n,
          groupId: 3n,
          extra: { 'x-zz': 'from the future' },
        },
      ]),
    )

    // Sorted, because the assertion is about which keys were written and how
    // many times, not the order the encoder chose to put them in.
    expect(Object.keys(eventMapIn(file)).sort()).toEqual(
      ['n', 't', 'e', 'sid', 'd', 'st', 'ta', 'sg', 'fri', 'g', 'x-zz'].sort(),
    )
    // The decoded object cannot show a repeat; the map header can.
    expect(declaredEventMapEntries(file)).toBe(11)
  })
})

describe('a defined key whose value has an unusable type', () => {
  // SPEC.md, "Versioning and Compatibility": such a key "goes to the
  // unrecognised-key store, is ignored for meaning, and is written back
  // unchanged, exactly as a key the reader had never heard of would be. A
  // reader that knows more about a key must not therefore preserve it less."
  //
  // Which is exactly what adding "ta", "sg", "fri" and "g" to Event 1 broke.
  // Before those keys existed every value below survived in `extra`; after,
  // most of them threw out of `BigInt` and took the whole file with them, and
  // the two that did not were coerced into identifiers the file never carried.
  // The rule is here rather than beside Event 1 because it is not about Event
  // 1: the cases further down are a text field, a byte string and a
  // fixed-length one, on three other event types.

  const openedMap = { n: 0, t: 100, e: 1, sid: 4, d: 1, st: 0 }

  /** The single event of a one-event file built from a hand-written CBOR map. */
  function readOne(map: Record<string, unknown>): TraceEvent {
    const trace = readMoqtrace(fileWithEventMap(map))
    expect(trace.events).toHaveLength(1)
    const event = trace.events[0]
    if (event == null) throw new Error('unreachable')
    return event
  }

  // Every shape a `"ta"` can take that is not an unsigned integer. `null` is
  // in the list because CBOR null is a value a writer chose to put on the
  // wire, not an absence; a negative integer because these keys are wire
  // identifiers, which have no negative form.
  const unusable: [shape: string, value: unknown][] = [
    ['text', 'hello'],
    ['the text "4"', '4'],
    ['a float', 1.5],
    ['`true`', true],
    ['an array', [1, 2]],
    ['a map', { a: 1 }],
    ['CBOR null', null],
    ['a negative integer', -1],
  ]

  it.each(unusable)('keeps a "ta" of %s in `extra`, verbatim and across a rewrite', (_, value) => {
    const event = readOne({ ...openedMap, ta: value })
    if (event.type !== 'stream-opened') throw new Error(`got a ${event.type} event`)

    // Not in the field, not invented, not gone.
    expect(event.trackAlias).toBeUndefined()
    expect(event.extra).toEqual({ ta: value })
    // The rest of the event decoded, which is the point of not throwing.
    expect(event.streamId).toBe(4n)

    // Read, modify, write: what a redaction pass, a filter or a re-segmentation
    // does to a file on its way to someone else.
    const rewritten = writeMoqtrace(makeTrace([event]))
    expect(readMoqtrace(rewritten).events).toEqual([event])
    expect(eventMapIn(rewritten).ta).toEqual(value)
  })

  it('does not cost the file the events around it', () => {
    // The regression this suite exists for. A three-event file whose middle
    // event carried `ta: "oops"` returned nothing at all and threw a
    // SyntaxError out of `BigInt` — not a TruncatedTraceError, not any error
    // this package defines, so a caller handling its error types did not catch
    // it either. The Rust reader returned all three events.
    const file = fileWithEventMaps(
      { ...openedMap, n: 0 },
      { ...openedMap, n: 1, ta: 'oops' },
      { ...openedMap, n: 2 },
    )
    const trace = readMoqtrace(file)
    expect(trace.events.map((event) => event.seq)).toEqual([0, 1, 2])
    expect(trace.events[1]?.extra).toEqual({ ta: 'oops' })
  })

  it('does not read `true` as track alias 1', () => {
    // `BigInt(true)` is `1n`, so a try/catch around the conversion would have
    // let this through — which is why the check is a type test. An identifier
    // the file never carried is worse than a missing one: nothing downstream
    // can tell it apart from a real alias.
    const event = readOne({ ...openedMap, ta: true })
    if (event.type !== 'stream-opened') throw new Error(`got a ${event.type} event`)
    expect(event.trackAlias).toBeUndefined()
    expect(event.extra).toEqual({ ta: true })
  })

  it('does not read the text "4" as track alias 4', () => {
    // `BigInt('4')` is `4n`. ciborium hands the Rust reader a string here and
    // it does not coerce, so a file carrying this would mean two different
    // things to the two implementations of one format.
    const event = readOne({ ...openedMap, ta: '4' })
    if (event.type !== 'stream-opened') throw new Error(`got a ${event.type} event`)
    expect(event.trackAlias).toBeUndefined()
    expect(event.extra).toEqual({ ta: '4' })
  })

  it('leaves no key in both its own field and `extra`', () => {
    // A key held in both places is written from both, and a CBOR map with a
    // duplicate key is malformed. The usable keys go to their fields, the
    // unusable one and the unknown one go to `extra`, and each is written once.
    const event = readOne({ ...openedMap, ta: 7, sg: 'nope', fri: 9, 'x-note': 'hi' })
    if (event.type !== 'stream-opened') throw new Error(`got a ${event.type} event`)
    expect(event.trackAlias).toBe(7n)
    expect(event.fetchRequestId).toBe(9n)
    expect(event.subgroupId).toBeUndefined()
    expect(event.extra).toEqual({ sg: 'nope', 'x-note': 'hi' })

    const file = writeMoqtrace(makeTrace([event]))
    expect(Object.keys(eventMapIn(file)).sort()).toEqual(
      ['n', 't', 'e', 'sid', 'd', 'st', 'ta', 'fri', 'sg', 'x-note'].sort(),
    )
    // The decoded object cannot show a repeat; the map header can.
    expect(declaredEventMapEntries(file)).toBe(10)
  })

  it('still fails the event when the key is a required one', () => {
    // The bound the rule states. There is no stream-opened event to construct
    // without `"sid"`, so an unusable one is a malformed event exactly as an
    // absent one is — and the reader says which key it was rather than
    // surfacing whatever `BigInt` threw.
    expect(() => readOne({ ...openedMap, sid: 'nope' })).toThrow(
      '"sid" must be an unsigned integer',
    )
  })

  it('applies to a text key on another event type', () => {
    // Nothing here is a property of those four keys or of Event 1. `"endpoint"`
    // on Event 8 is optional text; a value that is not text is unrecognised in
    // exactly the same way. Cast rather than converted, it used to reach the
    // field as a `number` wearing the type `string`, which no compiler catches.
    const event = readOne({ n: 0, t: 0, e: 8, endpoint: 42, transport: 'quic' })
    if (event.type !== 'peer-connected') throw new Error(`got a ${event.type} event`)
    const connected: PeerConnectedEvent = event
    expect(connected.endpoint).toBeUndefined()
    expect(connected.transport).toBe('quic')
    expect(connected.extra).toEqual({ endpoint: 42 })
    expect(readMoqtrace(writeMoqtrace(makeTrace([event]))).events).toEqual([event])
  })

  it('applies to a byte-string key on another event type', () => {
    // `"pl"` used to go through `new Uint8Array(value)`, which answers an
    // empty array for a string rather than throwing: the event kept a payload
    // field that said the object was empty, and the text was gone.
    const event = readOne({ n: 0, t: 0, e: 4, sid: 1, g: 0, o: 0, sz: 3, pl: 'not bytes' })
    if (event.type !== 'object-payload') throw new Error(`got a ${event.type} event`)
    const payload: ObjectPayloadEvent = event
    expect(payload.payload).toBeUndefined()
    expect(payload.size).toBe(3)
    expect(payload.extra).toEqual({ pl: 'not bytes' })
  })

  it('applies to a byte string of the wrong length', () => {
    // A trace id is sixteen bytes or it is not a trace id, and padding or
    // truncating one would let the event assert a chain identity it never
    // carried. The writer still refuses to produce one; the reader keeps the
    // bytes it was given, because `"traceId"` is optional and the rest of the
    // event — which is what says one subscription derives from another — is
    // fine.
    const short = new Uint8Array([1, 2, 3])
    const event = readOne({
      n: 0,
      t: 0,
      e: 10,
      u: ['peer-up', 1],
      d: [],
      kind: 'created',
      traceId: short,
    })
    if (event.type !== 'subscription-derivation') throw new Error(`got a ${event.type} event`)
    const derivation: SubscriptionDerivationEvent = event
    expect(derivation.traceId).toBeUndefined()
    expect(derivation.upstream).toEqual({ peer: 'peer-up', requestId: 1n })
    expect(new Uint8Array(derivation.extra?.traceId as Uint8Array)).toEqual(short)
  })
})

describe('the stream, the kind and the bytes behind an error event', () => {
  const failed: TraceErrorEvent = {
    type: 'error',
    seq: 0,
    timestamp: 100,
    errorCode: 4,
    reason: 'SUBSCRIBE_OK did not parse',
  }

  /** The one error event of a trace, or a failure naming what came instead. */
  function onlyError(trace: Trace): TraceErrorEvent {
    expect(trace.events).toHaveLength(1)
    const event = trace.events[0]
    if (event?.type !== 'error') throw new Error(`expected an error event, got ${event?.type}`)
    return event
  }

  /** The event map of a one-event file whose only event is an error. */
  function errorMap(fields: Record<string, unknown>): Record<string, unknown> {
    return { n: 0, t: 100, e: 6, ec: 4, reason: 'SUBSCRIBE_OK did not parse', ...fields }
  }

  const bytes = new Uint8Array([0x02, 0x0b, 0xff, 0x00])

  it('reads a stream id back as a bigint', () => {
    // The same wire identifier Event 0 carries, and held the same way: as a
    // `number` it stops being exact at 2^53, so this reader and the Rust one
    // would disagree about large stream ids silently and only there.
    const event = onlyError(roundTrip([{ ...failed, streamId: 12n }]))
    expect(event.streamId).toBe(12n)
    expect(typeof event.streamId).toBe('bigint')
  })

  it('distinguishes an absent stream id from stream 0', () => {
    // Absent means there was no stream, or that the recorder knew of none —
    // exactly as on Event 0. Read as `0`, it would attribute the error to a
    // real stream, and stream 0 is the client-initiated bidirectional one the
    // session control plane sits on through draft-16.
    expect(onlyError(roundTrip([failed])).streamId).toBeUndefined()
    expect(Object.hasOwn(eventMapIn(writeMoqtrace(makeTrace([failed]))), 'sid')).toBe(false)
    expect(onlyError(roundTrip([{ ...failed, streamId: 0n }])).streamId).toBe(0n)
  })

  it('reads back each of the three error kinds this revision names', () => {
    for (const kind of ['protocol', 'transport', 'decode'] as const) {
      expect(onlyError(roundTrip([{ ...failed, errorKind: kind }])).errorKind).toBe(kind)
    }
  })

  it('keeps an error kind this version has never heard of', () => {
    // An open vocabulary: values may be added without a version bump, so a
    // reader that refused one would refuse a file it can otherwise read in
    // full — the contract `"perspective"` already has.
    const event = onlyError(roundTrip([{ ...failed, errorKind: 'x-vendor-overload' }]))
    expect(event.errorKind).toBe('x-vendor-overload')
    // In its field, not in the store: it is a value the field can hold.
    expect(event.extra).toBeUndefined()
  })

  it('round-trips a length and the bytes it describes', () => {
    const event = onlyError(roundTrip([{ ...failed, rawLength: 9, raw: bytes }]))
    expect(event.rawLength).toBe(9)
    expect(event.raw).toEqual(bytes)
    // A length larger than the bytes is the definition of a truncated
    // capture, and it has to survive as such rather than being reconciled.
    expect(event.rawLength).toBeGreaterThan(event.raw?.length ?? 0)
  })

  it("reads the four keys out of another writer's narrow integers", () => {
    // ciborium writes an identifier in the fewest bytes that hold it, so a
    // file from `moqtap-trace` carries `"sid"` and `"rawlen"` as CBOR
    // integers that cbor-x hands back as JS numbers.
    const event = onlyError(
      readMoqtrace(fileWithEventMap(errorMap({ sid: 12, ek: 'decode', rawlen: 9, raw: bytes }))),
    )
    expect(event.streamId).toBe(12n)
    expect(typeof event.streamId).toBe('bigint')
    expect(event.errorKind).toBe('decode')
    expect(event.rawLength).toBe(9)
    expect(event.raw).toEqual(bytes)
  })

  it('round-trips an event carrying none of them', () => {
    // All four are optional, and every error event recorded before they
    // existed has none. Absent has to stay absent rather than become a zero,
    // an empty byte string or an empty kind.
    expect(onlyError(roundTrip([failed]))).toEqual(failed)
    const map = eventMapIn(writeMoqtrace(makeTrace([failed])))
    for (const key of ['sid', 'ek', 'rawlen', 'raw']) {
      expect(Object.hasOwn(map, key)).toBe(false)
    }
  })

  it('writes each key exactly once, and collects none of them into `extra`', () => {
    // The bug this is here for: a key read into a named field but still
    // counted unrecognised lands in `extra` as well, and writing the event
    // back then emits it twice. Only the genuinely unknown key belongs there.
    const file = writeMoqtrace(
      makeTrace([
        {
          ...failed,
          streamId: 12n,
          errorKind: 'protocol',
          rawLength: 9,
          raw: bytes,
          extra: { 'x-zz': 'from the future' },
        },
      ]),
    )

    // Sorted, because the assertion is about which keys were written and how
    // many times, not the order the encoder chose to put them in.
    expect(Object.keys(eventMapIn(file)).sort()).toEqual(
      ['n', 't', 'e', 'ec', 'reason', 'sid', 'ek', 'rawlen', 'raw', 'x-zz'].sort(),
    )
    // The decoded object cannot show a repeat; the map header can.
    expect(declaredEventMapEntries(file)).toBe(10)
    expect(onlyError(readMoqtrace(file)).extra).toEqual({ 'x-zz': 'from the future' })
  })

  // Every one of the four is optional, so an unusable value costs the key and
  // never the event: the error code and the reason are what the event is for,
  // and they decoded fine. SPEC.md, "Versioning and Compatibility": a defined
  // key whose value has an unusable type "goes to the unrecognised-key store,
  // is ignored for meaning, and is written back unchanged".
  const unusable: [
    key: string,
    value: unknown,
    field: 'streamId' | 'errorKind' | 'rawLength' | 'raw',
  ][] = [
    ['sid', 'nope', 'streamId'],
    ['sid', -1, 'streamId'],
    ['ek', 42, 'errorKind'],
    ['rawlen', 1.5, 'rawLength'],
    ['rawlen', -1, 'rawLength'],
    ['raw', 'not bytes', 'raw'],
  ]

  it.each(
    unusable,
  )('keeps a "%s" carrying %o in `extra`, verbatim and across a rewrite', (key, value, field) => {
    const event = onlyError(readMoqtrace(fileWithEventMap(errorMap({ [key]: value }))))

    // Not in the field, not coerced into one, not gone.
    expect(event[field]).toBeUndefined()
    expect(event.extra).toEqual({ [key]: value })
    // The rest of the event decoded, which is the point of not throwing.
    expect(event.errorCode).toBe(4)
    expect(event.reason).toBe('SUBSCRIBE_OK did not parse')

    // Read, modify, write: what a redaction pass, a filter or a
    // re-segmentation does to a file on its way to someone else.
    const rewritten = writeMoqtrace(makeTrace([event]))
    expect(readMoqtrace(rewritten).events).toEqual([event])
    expect(eventMapIn(rewritten)[key]).toEqual(value)
  })

  it('writes and reads back a "raw" longer than the recorder cap', () => {
    // The gate on the cap staying out of the serializer. A cap in
    // `writeMoqtrace` cannot tell an event a recorder just built from observed
    // bytes from one that arrived by being read, so it would truncate evidence
    // on every rewrite — and no test of the recorder's own truncation can
    // detect that, because both layers would cut and the assertion would only
    // see the result. This one fails the moment the cap migrates.
    const long = new Uint8Array(MAX_ERROR_RAW_BYTES + 1000)
    for (let i = 0; i < long.length; i++) long[i] = i % 251

    const file = writeMoqtrace(
      makeTrace([{ ...failed, streamId: 12n, rawLength: long.length, raw: long }]),
    )
    // Off the wire, before any decode of ours: what the file actually carries.
    expect((eventMapIn(file).raw as Uint8Array).length).toBe(5096)

    const event = onlyError(readMoqtrace(file))
    expect(event.raw?.length).toBe(5096)
    expect(event.rawLength).toBe(5096)
    expect(Array.from(event.raw ?? [])).toEqual(Array.from(long))
  })

  it('reads a "raw" longer than the recorder cap, and rewrites it unshortened', () => {
    // The 4096-byte cap binds a recorder, and nothing else. A reader meeting a
    // longer value MUST NOT reject the event and a rewrite MUST NOT shorten
    // it: re-truncating someone else's file destroys evidence in order to make
    // it conform to a rule that was never addressed to the tool doing the
    // truncating. This is the case the reader-outranks-the-writer rule exists
    // for, and a serializer that enforced the cap would fail it silently.
    const long = new Uint8Array(5000)
    for (let i = 0; i < long.length; i++) long[i] = i % 251
    const file = fileWithEventMap(errorMap({ sid: 12, rawlen: 5000, raw: long }))

    const event = onlyError(readMoqtrace(file))
    expect(event.raw?.length).toBe(5000)
    expect(event.rawLength).toBe(5000)
    // Bytes past the cap, spot-checked against the literal the file carries
    // rather than against anything this test encoded.
    expect(event.raw?.[4096]).toBe(4096 % 251)
    expect(event.raw?.[4999]).toBe(4999 % 251)

    // Off the wire of the rewritten file, so the assertion is about what the
    // file says and not about what a decode of our own encode gives back.
    const rewritten = writeMoqtrace(makeTrace([event]))
    const written = eventMapIn(rewritten).raw as Uint8Array
    expect(written.length).toBe(5000)
    expect(Array.from(written)).toEqual(Array.from(long))
  })
})

describe('the "msg" field of a control event', () => {
  // What every `capture-*` case in the conformance corpus carries in "msg":
  // the CLI that wrote those files rendered the decoded message with Rust's
  // `Debug` rather than emitting a map, and they still have to open.
  const DEBUG_TEXT = 'Draft16(ClientSetup(ClientSetup { parameters: [] }))'

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

describe('unrecognised keys in the header', () => {
  // SPEC.md, "Unrecognised keys in the header": three maps in the header have
  // keys the format names — the header map itself, `"segment"` and
  // `"sampling"` — and each MUST carry its own store, written back into the map
  // it came from. Both reference implementations read a header, dropped every
  // key they did not know, and wrote out a file that looked as though it had
  // never carried them.
  //
  // `x-` keys throughout: the range the format reserves for private use and
  // promises never to define, so a fixture built from one keeps testing what it
  // was written to test.

  it('keeps an unknown top-level key rather than dropping it', () => {
    const map = { ...REQUIRED_HEADER_MAP, 'x-note': 'hello' }
    expect(readHeaderMap(map).extra).toEqual({ 'x-note': 'hello' })
    expect(rewriteHeaderMap(map)['x-note']).toBe('hello')
  })

  it('is absent, not empty, when the header carried none', () => {
    // An empty object would make `extra != null` true for every file and turn
    // a "this header had unknown keys" check into a "this header was read by
    // this version" check.
    expect(readHeaderMap(REQUIRED_HEADER_MAP).extra).toBeUndefined()
    expect(roundTrip([]).header.extra).toBeUndefined()
  })

  it('keeps an unknown key inside "segment" inside "segment"', () => {
    const map = { ...REQUIRED_HEADER_MAP, segment: { sequence: 0, 'x-rot': 'size' } }
    const header = readHeaderMap(map)
    expect(header.segment).toEqual({ sequence: 0, extra: { 'x-rot': 'size' } })
    expect(header.extra).toBeUndefined()
    expect(rewriteHeaderMap(map).segment).toEqual({ sequence: 0, 'x-rot': 'size' })
  })

  it('keeps an unknown key inside "sampling" inside "sampling"', () => {
    const map = { ...REQUIRED_HEADER_MAP, sampling: { effectiveRate: 0.5, 'x-q': [1, 2] } }
    const header = readHeaderMap(map)
    expect(header.sampling).toEqual({ effectiveRate: 0.5, extra: { 'x-q': [1, 2] } })
    expect(header.extra).toBeUndefined()
    expect(rewriteHeaderMap(map).sampling).toEqual({ effectiveRate: 0.5, 'x-q': [1, 2] })
  })

  it('never moves a key from one map to another', () => {
    // Why there are three stores and not one. A private key on `"segment"` and
    // a key of the same name at the top level are different keys; re-emitting
    // either in the other's map changes what the file says, and one store for
    // the whole header could not tell them apart.
    const map = {
      ...REQUIRED_HEADER_MAP,
      'x-note': 'top',
      segment: { sequence: 0, 'x-note': 'segment' },
      sampling: { 'x-note': 'sampling' },
    }
    const header = readHeaderMap(map)
    expect(header.extra).toEqual({ 'x-note': 'top' })
    expect(header.segment?.extra).toEqual({ 'x-note': 'segment' })
    expect(header.sampling?.extra).toEqual({ 'x-note': 'sampling' })

    const written = rewriteHeaderMap(map)
    expect(written['x-note']).toBe('top')
    expect((written.segment as Record<string, unknown>)['x-note']).toBe('segment')
    expect((written.sampling as Record<string, unknown>)['x-note']).toBe('sampling')
  })

  it('preserves a nested value structurally, not as a shallow copy', () => {
    const deep = { a: [1, { b: 'inner' }], c: null }
    const map = { ...REQUIRED_HEADER_MAP, 'x-deep': deep }
    expect(readHeaderMap(map).extra).toEqual({ 'x-deep': deep })
    expect(rewriteHeaderMap(map)['x-deep']).toEqual(deep)
  })

  it('writes the header store after the header map own keys', () => {
    // "The store is written last, and never twice." CBOR maps are unordered so
    // nothing depends on this for correctness, but a file whose own keys had
    // been pushed behind a store would not diff against one written without
    // it, and the position is the only thing that changed.
    const file = writeMoqtrace(
      makeTrace([], { transport: 'webtransport', extra: { 'x-note': 'hi' } }),
    )
    expect(headerKeysInOrder(file)).toEqual([
      'protocol',
      'perspective',
      'detail',
      'startTime',
      'transport',
      'x-note',
    ])
  })

  it('writes an inner map store after that map own keys', () => {
    const file = writeMoqtrace(
      makeTrace([], {
        segment: { sequence: 2, streamId: 'stream-9', extra: { 'x-rot': 'size' } },
      }),
    )
    const segment = headerMapIn(file).segment as Record<string, unknown>
    expect(Object.keys(segment)).toEqual(['sequence', 'streamId', 'x-rot'])
  })

  it('never writes a key the header map already wrote', () => {
    // A reader never produces such an entry — a key it recognised and used is
    // by definition not unrecognised — but a caller assembling a header by
    // hand can. The field wins and the store entry is dropped, which is how
    // event serialization already resolves the collision.
    const file = writeMoqtrace(
      makeTrace([], {
        transport: 'webtransport',
        extra: { transport: 'raw-quic', 'x-note': 'hi' },
      }),
    )
    expect(headerMapIn(file).transport).toBe('webtransport')
    expect(readMoqtraceHeader(file).transport).toBe('webtransport')
    // The decoded map cannot show a repeat; the map header can.
    expect(declaredHeaderMapEntries(file)).toBe(6)
    expect(headerKeysInOrder(file)).toEqual([
      'protocol',
      'perspective',
      'detail',
      'startTime',
      'transport',
      'x-note',
    ])
  })

  it('never writes a key an inner map already wrote', () => {
    const file = writeMoqtrace(
      makeTrace([], { segment: { sequence: 2, extra: { sequence: 99, 'x-rot': 'size' } } }),
    )
    const segment = headerMapIn(file).segment as Record<string, unknown>
    expect(segment).toEqual({ sequence: 2, 'x-rot': 'size' })
    expect(readMoqtraceHeader(file).segment?.sequence).toBe(2)
  })

  it('survives a read, a modification and a write', () => {
    // The shape every rule here exists for: a redaction pass, a filter, a
    // re-segmentation, a download with annotations applied.
    //
    // Written against expected literals, not against `edited.header`. Comparing
    // a decode of our own encode with the object we encoded is true of a reader
    // that keeps no stores at all: both sides are storeless and both sides
    // agree, so the assertion passed with the whole mechanism deleted. The keys
    // and values below are what the file must still carry, and are not
    // derivable from what this package did with them.
    const original = readMoqtrace(
      fileWithHeaderMap({
        ...REQUIRED_HEADER_MAP,
        'x-note': 'hello',
        segment: { sequence: 0, 'x-rot': 'size' },
        sampling: { droppedTotal: 3, 'x-q': [1] },
      }),
    )
    const edited: Trace = {
      header: { ...original.header, endpoint: 'https://relay.example.com/moq' },
      events: [],
    }
    const file = writeMoqtrace(edited)

    // On the wire, the store entries are back in the maps they came from,
    // beside the keys this version does know. `startTime` reads back as a
    // bigint here and not in the header below: an epoch millisecond is past
    // 32 bits, so it goes out as a CBOR integer rather than a float — the
    // encoding the format makes normative — and the raw decode shows that.
    expect(headerMapIn(file)).toEqual({
      protocol: 'moq-transport-14',
      perspective: 'client',
      detail: 'control',
      startTime: 1700000000000n,
      endpoint: 'https://relay.example.com/moq',
      segment: { sequence: 0, 'x-rot': 'size' },
      sampling: { droppedTotal: 3, 'x-q': [1] },
      'x-note': 'hello',
    })

    // And read back out of it, they are where a caller finds them.
    expect(readMoqtrace(file).header).toEqual({
      protocol: 'moq-transport-14',
      perspective: 'client',
      detail: 'control',
      startTime: 1700000000000,
      endpoint: 'https://relay.example.com/moq',
      segment: { sequence: 0, extra: { 'x-rot': 'size' } },
      sampling: { droppedTotal: 3, extra: { 'x-q': [1] } },
      extra: { 'x-note': 'hello' },
    })
  })

  it('gives "custom" no store of its own', () => {
    // Every key in `"custom"` belongs to whoever wrote the trace, so there is
    // no such thing as an unrecognised key there. It is a passthrough, handed
    // back key for key and value for value.
    const custom = { payloadMasked: true, 'anything-at-all': [1, 2, 3] }
    const map = { ...REQUIRED_HEADER_MAP, custom }
    const header = readHeaderMap(map)
    expect(header.custom).toEqual(custom)
    expect(header.extra).toBeUndefined()
    expect(rewriteHeaderMap(map).custom).toEqual(custom)
  })
})

describe('a store entry named "__proto__"', () => {
  // The one key name in JavaScript that `target[key] = value` does not create.
  // It reaches the accessor `Object.prototype` defines and sets the object's
  // prototype instead, so `Object.hasOwn` reads false, `Object.entries` does
  // not list it, and the entry never reaches the file. A caller arrives at it
  // without trying: `JSON.parse` makes it a real own property, JSON having no
  // such rule, so a store parsed out of a sidecar file or a config lost the
  // key silently — on the one code path whose whole purpose is preservation.
  //
  // SPEC.md, "Shapes a CBOR library may normalise before you see them": the
  // writer rule is the half an implementation can meet, so it is the half held
  // to here. The read half is below this package; it is pinned at the bottom
  // of this block rather than fixed.

  /** A store with a real own `__proto__`, built the way a caller reaches one. */
  function parsedStore(): Record<string, unknown> {
    return JSON.parse('{"__proto__":"x","x-ok":1}') as Record<string, unknown>
  }

  const opened: TraceEvent = {
    type: 'stream-opened',
    seq: 0,
    timestamp: 100,
    streamId: 4n,
    direction: 1,
    streamType: 0,
  }

  it('is an own property before this package is handed it', () => {
    // Without this the rest of the block proves nothing: a store that had
    // already lost the key would be written faithfully and still show nothing.
    const store = parsedStore()
    expect(Object.hasOwn(store, '__proto__')).toBe(true)
    expect(Object.keys(store)).toEqual(['__proto__', 'x-ok'])
  })

  it('is written from the header store', () => {
    const file = writeMoqtrace(makeTrace([], { extra: parsedStore() }))
    expect(carriesTextKey(file, '__proto__')).toBe(true)
    // Six: the four required keys and both store entries. A dropped
    // `__proto__` leaves five and is otherwise invisible.
    expect(declaredHeaderMapEntries(file)).toBe(6)
    expect(headerMapIn(file)['x-ok']).toBe(1)
  })

  it('is written from the "segment" store', () => {
    const file = writeMoqtrace(makeTrace([], { segment: { sequence: 1, extra: parsedStore() } }))
    expect(carriesTextKey(file, '__proto__')).toBe(true)
  })

  it('is written from the "sampling" store', () => {
    const file = writeMoqtrace(makeTrace([], { sampling: { extra: parsedStore() } }))
    expect(carriesTextKey(file, '__proto__')).toBe(true)
  })

  it('is written from an event store', () => {
    const file = writeMoqtrace(makeTrace([{ ...opened, extra: parsedStore() }]))
    expect(carriesTextKey(file, '__proto__')).toBe(true)
    expect(declaredEventMapEntries(file)).toBe(8)
  })

  it("is written from an unknown event's fields", () => {
    const file = writeMoqtrace(
      makeTrace([{ type: 'unknown', seq: 0, timestamp: 0, eventType: 99, fields: parsedStore() }]),
    )
    expect(carriesTextKey(file, '__proto__')).toBe(true)
  })

  it('goes into the header store when the decoded map really carries one', () => {
    // Reached through `cborToHeader`, which takes a decoded map from whatever
    // produced it rather than from this package's own decoder. Ours never
    // hands it a `__proto__`, having renamed the key first — but a caller
    // decoding with another CBOR library, or assembling the map by hand, does,
    // and the store must keep what it was given. Asserted key by key: an
    // expected object literal written `{ __proto__: 'x' }` sets a prototype
    // instead of declaring a key, and would compare against nothing.
    const map = {
      ...REQUIRED_HEADER_MAP,
      ...(JSON.parse('{"__proto__":"x"}') as Record<string, unknown>),
    }
    const extra = cborToHeader(map).extra ?? {}
    expect(Object.keys(extra)).toEqual(['__proto__'])
    // Read through the descriptor, which is what tells an own data property
    // apart from the accessor every object inherits under the same name.
    expect(Object.getOwnPropertyDescriptor(extra, '__proto__')?.value).toBe('x')
  })

  it("goes into an unknown event's fields when the decoded map really carries one", () => {
    const event = cborToEvent({
      n: 0,
      t: 0,
      e: 99,
      ...(JSON.parse('{"__proto__":"x"}') as Record<string, unknown>),
    })
    if (event.type !== 'unknown') throw new Error(`got a ${event.type} event`)
    expect(Object.keys(event.fields)).toEqual(['__proto__'])
    expect(Object.getOwnPropertyDescriptor(event.fields, '__proto__')?.value).toBe('x')
  })

  it('does not become the written map own prototype', () => {
    // What the bug actually did. The assignment succeeded, so nothing threw
    // and nothing logged; it set the prototype of the map being encoded, and
    // the encoder then wrote a map one key short.
    const file = writeMoqtrace(makeTrace([], { extra: parsedStore() }))
    expect(Object.getPrototypeOf(headerMapIn(file))).toBe(Object.prototype)
  })

  it('comes back renamed, which is the decoder and not this package', () => {
    // Pinned, not endorsed. cbor-x rewrites the text key `"__proto__"` to
    // `"__proto_"` inside its own decoder, before any code in this package
    // runs, and no option turns it off short of decoding every map as a `Map`.
    // The file above is right — the Rust reader is handed `"__proto__"` — and
    // it is reading that file *here* that loses the name. SPEC.md, part 3 of
    // the normalisation section: below the implementation, so not
    // non-conformant, and not silent either.
    //
    // If this assertion ever fails, cbor-x has fixed it, and the note on the
    // codec in `binary.ts` and the CHANGELOG entry beside it are now wrong.
    const file = writeMoqtrace(makeTrace([], { extra: parsedStore() }))
    expect(readMoqtraceHeader(file).extra).toEqual({ __proto_: 'x', 'x-ok': 1 })
  })

  it('collides with a real "__proto_" on the way back in, losing a value', () => {
    // The same rename in the shape that costs a value rather than a name: two
    // distinct text keys in the file become one entry, and the Rust reader
    // keeps both. Spread rather than an object literal, because `__proto__:`
    // written in a literal is the prototype-setting form and would build a
    // fixture with only one key in it.
    const map = {
      ...REQUIRED_HEADER_MAP,
      ...(JSON.parse('{"__proto__":"A","__proto_":"B"}') as Record<string, unknown>),
    }
    expect(readHeaderMap(map).extra).toEqual({ __proto_: 'B' })
  })
})

describe('a required header integer this package could not read back', () => {
  // `startTime` and `segment.sequence` are the header's two required unsigned
  // integers, and they are `number` fields, so TypeScript admits `-5` and
  // `1.5` into both. The reader refuses either with `MalformedHeaderError`,
  // which meant the writer emitted files it could not open: written, exit 0,
  // and the fault surfacing wherever someone later tried to read them, if
  // anyone did. Rust cannot reach the state at all — its field is a `u64`.

  it('refuses a negative startTime rather than writing it', () => {
    expect(() => writeMoqtrace(makeTrace([], { startTime: -5 }))).toThrow(MalformedHeaderError)
    expect(() => writeMoqtrace(makeTrace([], { startTime: -5 }))).toThrow(
      'Malformed header: "startTime" must be an unsigned integer',
    )
  })

  it('refuses a fractional startTime rather than writing it', () => {
    expect(() => writeMoqtrace(makeTrace([], { startTime: 1700000000000.5 }))).toThrow(
      MalformedHeaderError,
    )
  })

  it('refuses a startTime past the safe integer range', () => {
    // Where the reader stops too, and for the same reason: the value the file
    // would carry is not the value the caller passed.
    expect(() => writeMoqtrace(makeTrace([], { startTime: Number.MAX_SAFE_INTEGER + 2 }))).toThrow(
      MalformedHeaderError,
    )
  })

  it('refuses a negative or fractional segment.sequence', () => {
    expect(() => writeMoqtrace(makeTrace([], { segment: { sequence: -1 } }))).toThrow(
      'Malformed header: "segment.sequence" must be an unsigned integer',
    )
    expect(() => writeMoqtrace(makeTrace([], { segment: { sequence: 1.5 } }))).toThrow(
      MalformedHeaderError,
    )
  })

  it('refuses it from the streaming writer too', () => {
    expect(() => createMoqtraceWriter(makeHeader({ startTime: -5 }))).toThrow(MalformedHeaderError)
  })

  it('still rewrites a file whose store carries such a value', () => {
    // The check is on the field, never on a store. A file carrying a
    // fractional `"endTime"` or a negative `"durationMs"` reads with the value
    // in the store of the map it came from — the reader's stated contract for
    // an optional key — and a rewrite of that file must not be refused over
    // it. A reader's obligations outrank a writer's, and the store is where
    // they are discharged.
    const map = {
      ...REQUIRED_HEADER_MAP,
      endTime: 1.5,
      segment: { sequence: 0, durationMs: -1 },
    }
    const written = rewriteHeaderMap(map)
    expect(written.endTime).toBe(1.5)
    expect((written.segment as Record<string, unknown>).durationMs).toBe(-1)
  })

  it('does not refuse an optional integer the reader routes to a store', () => {
    // A negative `"endTime"` in the *field* still writes. It reads back into
    // the header's store rather than failing the file, so the value survives
    // and so does the file: only the two required keys turn a bad value into a
    // trace this package cannot open, and only those two are refused.
    const file = writeMoqtrace(makeTrace([], { endTime: -5 }))
    expect(readMoqtraceHeader(file).endTime).toBeUndefined()
    expect(readMoqtraceHeader(file).extra).toEqual({ endTime: -5 })
  })
})

describe('a defined header key whose value has an unusable type', () => {
  // SPEC.md: "A key this document *does* define, carrying a value the reader
  // cannot use, goes to that same store. Knowing more about a key must not
  // mean preserving it less. `"transport": 42` is not a transport; it is also
  // not nothing."
  //
  // Every case below used to reach a field through an `as` cast or a
  // `Number(...)`, so the value arrived wearing a type the runtime did not
  // keep — or, for `appliesTo`, arrived as a `NaN` the file never carried and
  // the writer then put back on disk.

  const unusableForText: [shape: string, value: unknown][] = [
    ['a number', 42],
    ['`true`', true],
    ['an array', ['webtransport']],
    ['a map', { name: 'webtransport' }],
    ['CBOR null', null],
  ]

  it.each(unusableForText)('keeps a "transport" of %s in the header store', (_, value) => {
    const map = { ...REQUIRED_HEADER_MAP, transport: value }
    const header = readHeaderMap(map)
    expect(header.transport).toBeUndefined()
    expect(header.extra).toEqual({ transport: value })
    // Written back from the store, into the slot the field did not fill.
    expect(rewriteHeaderMap(map).transport).toEqual(value)
  })

  it('reads an integral float "endTime" as an integer', () => {
    // Files carrying the float form exist and readers MUST accept them; this
    // rule does not take that back.
    const header = readHeaderMap({ ...REQUIRED_HEADER_MAP, endTime: 1700000060000.0 })
    expect(header.endTime).toBe(1700000060000)
    expect(header.extra).toBeUndefined()
  })

  it('keeps a fractional "endTime" in the header store', () => {
    const map = { ...REQUIRED_HEADER_MAP, endTime: 1700000060000.5 }
    const header = readHeaderMap(map)
    expect(header.endTime).toBeUndefined()
    expect(header.extra).toEqual({ endTime: 1700000060000.5 })
    expect(rewriteHeaderMap(map).endTime).toBe(1700000060000.5)
  })

  it('keeps an "endTime" past the safe integer range rather than rounding it', () => {
    // The one silent-rounding hazard on the read side, and the reason
    // `asUintNumber` bounds at `Number.MAX_SAFE_INTEGER` instead of calling
    // `Number` on whatever `asUint` returned. `Number(9007199254740993n)` is
    // 9007199254740992: a timestamp one millisecond from the one the file
    // gave, produced without a word, and written back to disk in place of it.
    // SPEC.md asks for no rounding of a value the reader cannot represent, so
    // the digits stay in the store, where they are still exact.
    const map = { ...REQUIRED_HEADER_MAP, endTime: 9007199254740993n } // 2**53 + 1
    const header = readHeaderMap(map)
    expect(header.endTime).toBeUndefined()
    expect(header.extra).toEqual({ endTime: 9007199254740993n })
    expect(rewriteHeaderMap(map).endTime).toBe(9007199254740993n)
  })

  it('keeps a wrong-typed key inside "segment" in that map own store', () => {
    const map = { ...REQUIRED_HEADER_MAP, segment: { sequence: 0, streamId: 42 } }
    const header = readHeaderMap(map)
    expect(header.segment?.streamId).toBeUndefined()
    expect(header.segment?.extra).toEqual({ streamId: 42 })
    expect(rewriteHeaderMap(map).segment).toEqual({ sequence: 0, streamId: 42 })
  })

  it('reads a trace whose "segment" is not a map as non-segmented', () => {
    // "A `"segment"` or `"sampling"` that is not a map MUST NOT fail the file.
    // It goes to the store like any other unusable optional value, and the
    // reader proceeds as though the key were absent." A reader that rejected
    // the file would turn one unreadable metadata value into the loss of every
    // event behind it.
    const map = { ...REQUIRED_HEADER_MAP, segment: 5 }
    const trace = readMoqtrace(fileWithHeaderMap(map))
    expect(trace.header.segment).toBeUndefined()
    expect(trace.header.extra).toEqual({ segment: 5 })
    expect(trace.events).toHaveLength(1)
    expect(rewriteHeaderMap(map).segment).toBe(5)
  })

  it('reads a trace whose "sampling" is not a map as unsampled', () => {
    const trace = readMoqtrace(fileWithHeaderMap({ ...REQUIRED_HEADER_MAP, sampling: 'lots' }))
    expect(trace.header.sampling).toBeUndefined()
    expect(trace.header.extra).toEqual({ sampling: 'lots' })
    expect(trace.events).toHaveLength(1)
  })

  it('keeps a "custom" that is not a map in the header store', () => {
    // The field is declared `Record<string, unknown>`, so a `5` in it would be
    // a type that lies to every caller reading the field. Losing typed access
    // is the smaller harm — nothing in the format gives `"custom"` keys
    // meaning — and the bytes survive.
    const map = { ...REQUIRED_HEADER_MAP, custom: 5 }
    const header = readHeaderMap(map)
    expect(header.custom).toBeUndefined()
    expect(header.extra).toEqual({ custom: 5 })
    expect(rewriteHeaderMap(map).custom).toBe(5)
  })

  it('keeps a "custom" carrying an unrecognised CBOR tag in the header store', () => {
    // The trap `typeof value === 'object'` walks into. cbor-x hands a tagged
    // value back as a `Tag` instance, which passes every check short of a
    // prototype test — so `"custom": 42("abc")` used to reach a field declared
    // `Record<string, unknown>` as an object with `value` and `tag` properties,
    // a shape the field's type says cannot occur. The bytes survive either way;
    // only the store keeps the type true.
    const map = { ...REQUIRED_HEADER_MAP, custom: new Tag('abc', 42) }
    const header = readHeaderMap(map)
    expect(header.custom).toBeUndefined()
    expect(header.extra?.custom).toBeInstanceOf(Tag)
    expect(rewriteHeaderMap(map).custom).toBeInstanceOf(Tag)
  })

  it('keeps an "appliesTo" with one bad element entire, not the elements it liked', () => {
    // The shape where discarding is not merely lossy but wrong. `"appliesTo"`
    // names the event types the drop policy touched, and readers may treat
    // every type absent from it as complete — so `[3, 5]` read out of
    // `[3, "x", 5]` reports event type 7 as fully recorded, the opposite of
    // what the file said, stated with the same confidence. The old reader was
    // worse still: `[3, NaN, 5]`, written straight back out.
    const map = { ...REQUIRED_HEADER_MAP, sampling: { droppedTotal: 3, appliesTo: [3, 'x', 5] } }
    const header = readHeaderMap(map)
    expect(header.sampling?.appliesTo).toBeUndefined()
    expect(header.sampling?.droppedTotal).toBe(3)
    expect(header.sampling?.extra).toEqual({ appliesTo: [3, 'x', 5] })
    expect((rewriteHeaderMap(map).sampling as Record<string, unknown>).appliesTo).toEqual([
      3,
      'x',
      5,
    ])
  })

  it('still reads an "appliesTo" whose elements are all event type IDs', () => {
    const header = readHeaderMap({ ...REQUIRED_HEADER_MAP, sampling: { appliesTo: [1, 3, 4] } })
    expect(header.sampling?.appliesTo).toEqual([1, 3, 4])
    expect(header.sampling?.extra).toBeUndefined()
  })

  it('does not fail the file over any number of unusable optional keys', () => {
    // The bound the rule states from the other side: an unusable *optional*
    // key MUST NOT fail the file at all. It is the case the whole rule exists
    // for.
    const trace = readMoqtrace(
      fileWithHeaderMap({
        ...REQUIRED_HEADER_MAP,
        endTime: 'later',
        transport: 42,
        source: [1],
        endpoint: null,
        sessionId: true,
        segment: 5,
        sampling: 'lots',
        custom: 'none',
      }),
    )
    expect(trace.events).toHaveLength(1)
    expect(trace.header.protocol).toBe('moq-transport-14')
    expect(Object.keys(trace.header.extra ?? {}).sort()).toEqual([
      'custom',
      'endTime',
      'endpoint',
      'sampling',
      'segment',
      'sessionId',
      'source',
      'transport',
    ])
  })
})

describe('the sampling rate', () => {
  // SPEC.md, Interoperability: "An integral value MUST be written as a CBOR
  // integer (major type 0 or 1), not as a float [...] The first rule is about
  // the **value**, not about the type this document gives the key."
  // `"effectiveRate"` is where that bites — a key declared a float whose
  // commonest value is `1.0`, "no rate-based dropping" — and the two
  // implementations disagreed on exactly it, one writing a float64 and one an
  // integer for the same trace.

  it('writes an integral rate as a CBOR integer', () => {
    expect(rateInitialByte(fileWithSampling({ effectiveRate: 1 }))).toBe(0x01)
  })

  it('writes a fractional rate as a CBOR float, there being no integer for it', () => {
    expect([0xf9, 0xfa, 0xfb]).toContain(rateInitialByte(fileWithSampling({ effectiveRate: 0.25 })))
  })

  it('reads a rate written as a CBOR integer', () => {
    // The mirror of the writer rule, and the half left implicit for one
    // revision too long: a reader MUST accept a CBOR integer for a key the
    // format types as a float.
    const header = readHeaderMap({ ...REQUIRED_HEADER_MAP, sampling: { effectiveRate: 1 } })
    expect(header.sampling?.effectiveRate).toBe(1)
    expect(header.sampling?.extra).toBeUndefined()
  })

  // SPEC.md, "Unrecognised keys in the header": "The range clause binds only
  // where this document states a range. In the header that is one key:
  // `"effectiveRate"`, defined as lying in `(0.0, 1.0]`. A rate of `1.5`, of
  // `0.0`, or of NaN is unusable and goes to the sampling store." The reason
  // it earns the check is that consumers divide by it: `0.0` is a division by
  // zero and `1.5` a count larger than what was recorded.

  const outOfRange: [name: string, value: number][] = [
    ['zero, the open end of the interval', 0],
    ['a rate above 1', 2],
    ['a rate above 1 by a fraction', 1.5],
    ['a negative rate', -0.5],
    ['NaN, which is in no interval', Number.NaN],
  ]

  it.each(outOfRange)('keeps %s in the sampling store rather than in the field', (_, value) => {
    const map = { ...REQUIRED_HEADER_MAP, sampling: { effectiveRate: value } }
    const header = readHeaderMap(map)
    expect(header.sampling?.effectiveRate).toBeUndefined()
    expect(header.sampling?.extra).toEqual({ effectiveRate: value })
    // Unusable, not unwanted: the key is optional, so the bytes survive the
    // rewrite and the file is not refused over them.
    expect((rewriteHeaderMap(map).sampling as Record<string, unknown>).effectiveRate).toEqual(value)
  })

  it('takes 1.0, the closed end of the interval and the commonest rate there is', () => {
    // The boundary the interval is asymmetric about. `1.0` means "no
    // rate-based dropping" and is the value a source writes when it wants to
    // say the trace is complete; refusing it would route the most ordinary
    // sampling map there is into a store.
    const header = readHeaderMap({ ...REQUIRED_HEADER_MAP, sampling: { effectiveRate: 1 } })
    expect(header.sampling?.effectiveRate).toBe(1)
    expect(header.sampling?.extra).toBeUndefined()
  })
})

describe('a required header key with no usable value', () => {
  // SPEC.md: the four required top-level keys and `"segment.sequence"` are the
  // only keys in the header whose absence or unusability makes the header
  // itself malformed. "What it MUST NOT do is return a header it invented — a
  // required key filled in with a default, an empty string, or a language's
  // null standing in for a value the file never carried. That reader reports a
  // fabricated trace as a real one, which is worse than reporting nothing."

  const malformed: [name: string, key: string, header: Record<string, unknown>][] = [
    [
      'an absent "protocol"',
      'protocol',
      { perspective: 'client', detail: 'control', startTime: 1700000000000 },
    ],
    ['a "protocol" that is not text', 'protocol', { ...REQUIRED_HEADER_MAP, protocol: 42 }],
    ['a "perspective" that is not text', 'perspective', { ...REQUIRED_HEADER_MAP, perspective: 5 }],
    [
      'an absent "detail"',
      'detail',
      { protocol: 'moq-transport-14', perspective: 'client', startTime: 1700000000000 },
    ],
    ['a negative "startTime"', 'startTime', { ...REQUIRED_HEADER_MAP, startTime: -5 }],
    [
      'a fractional "startTime"',
      'startTime',
      { ...REQUIRED_HEADER_MAP, startTime: 1700000000000.5 },
    ],
    [
      'a "segment" with no "sequence"',
      'segment.sequence',
      { ...REQUIRED_HEADER_MAP, segment: { streamId: 'abc' } },
    ],
    [
      'a "segment.sequence" that is not an unsigned integer',
      'segment.sequence',
      { ...REQUIRED_HEADER_MAP, segment: { sequence: -1 } },
    ],
  ]

  it.each(malformed)('fails the read on %s', (_, key, header) => {
    const file = fileWithHeaderMap(header)
    for (const read of [readMoqtrace, readMoqtraceSegments, readMoqtraceHeader]) {
      expect(() => read(file)).toThrow(MalformedHeaderError)
      expect(() => read(file)).toThrow(key)
    }
  })

  it('says which fault it was: absent, or present and unusable', () => {
    // Both are the same outcome — there is no header to construct either way —
    // but they are different faults, and one message for both told whoever has
    // to fix the file the wrong thing. "must be a text string" on a header
    // carrying no `"protocol"` at all sends them looking at a value that is not
    // there, and it is the message a person debugging a broken capture reads.
    // The Rust reader has always distinguished the two; this one did not, so
    // the same file got two different diagnoses depending on which library
    // opened it.
    const message = (header: Record<string, unknown>): string => {
      try {
        readMoqtraceHeader(fileWithHeaderMap(header))
      } catch (error) {
        return (error as MalformedHeaderError).message
      }
      throw new Error('the header was read')
    }

    const { protocol: _dropped, ...withoutProtocol } = REQUIRED_HEADER_MAP
    expect(message(withoutProtocol)).toBe('Malformed header: "protocol" is missing')
    expect(message({ ...REQUIRED_HEADER_MAP, protocol: 42 })).toBe(
      'Malformed header: "protocol" must be a text string',
    )

    const { startTime: _also, ...withoutStartTime } = REQUIRED_HEADER_MAP
    expect(message(withoutStartTime)).toBe('Malformed header: "startTime" is missing')
    expect(message({ ...REQUIRED_HEADER_MAP, startTime: -5 })).toBe(
      'Malformed header: "startTime" must be an unsigned integer',
    )

    // The same distinction one map down, where the key is named for the map it
    // sits in rather than by its bare name.
    expect(message({ ...REQUIRED_HEADER_MAP, segment: { streamId: 'abc' } })).toBe(
      'Malformed header: "segment.sequence" is missing',
    )
    expect(message({ ...REQUIRED_HEADER_MAP, segment: { sequence: 'first' } })).toBe(
      'Malformed header: "segment.sequence" must be an unsigned integer',
    )
  })

  it('reports a key present with an unusable value as unusable, not as absent', () => {
    // The direction that is easy to get backwards once the branch exists: a
    // `"perspective"` that is there but is a number is not a missing key, and
    // saying so would send the reader of the message hunting for something
    // that is right in front of them.
    try {
      readMoqtraceHeader(fileWithHeaderMap({ ...REQUIRED_HEADER_MAP, perspective: 5 }))
      throw new Error('the header was read')
    } catch (error) {
      expect((error as MalformedHeaderError).key).toBe('perspective')
      expect((error as MalformedHeaderError).message).not.toContain('missing')
    }
  })

  it('names the key it could not read', () => {
    // A distinct type, so a caller can tell a header it must not trust from a
    // truncated file it can — and the key, so the report says which.
    const read = (): TraceHeader =>
      readMoqtraceHeader(fileWithHeaderMap({ ...REQUIRED_HEADER_MAP, segment: { streamId: 'a' } }))
    expect(read).toThrow(MalformedHeaderError)
    try {
      read()
    } catch (error) {
      expect((error as MalformedHeaderError).key).toBe('segment.sequence')
      expect((error as MalformedHeaderError).name).toBe('MalformedHeaderError')
    }
  })

  it('returns no header at all rather than one with a hole in it', () => {
    // What the reader used to do: `obj.protocol as string` handed back
    // `undefined` in a field declared `string`, and the writer then encoded it
    // as CBOR `undefined` — a shape the format tells writers never to produce,
    // in a file that otherwise looks complete.
    const file = fileWithHeaderMap({
      perspective: 'client',
      detail: 'control',
      startTime: 1700000000000,
    })
    let header: TraceHeader | undefined
    try {
      header = readMoqtraceHeader(file)
    } catch {
      header = undefined
    }
    expect(header).toBeUndefined()
  })

  it('does not invent segment 0 for a segment whose sequence it cannot read', () => {
    // The sharpest case. `sequence` is the sole ordering key of a segmented
    // stream, and the `0` this reader used to default to does not merely lose
    // the segment's place — it claims the segment is the first one.
    expect(() =>
      readMoqtraceHeader(fileWithHeaderMap({ ...REQUIRED_HEADER_MAP, segment: { sequence: 'a' } })),
    ).toThrow(MalformedHeaderError)
  })

  it('costs that segment and no more when the reader is asked to recover', () => {
    // "Malformed here means malformed *for that segment*. A reader MUST report
    // it and MUST NOT present the segment as read; it MAY continue to the next
    // segment."
    const good = (sequence: number): Uint8Array =>
      fileWithHeaderMap({ ...REQUIRED_HEADER_MAP, segment: { sequence } })
    const parts = [
      good(0),
      fileWithHeaderMap({ ...REQUIRED_HEADER_MAP, segment: { streamId: 'abc' } }),
      good(2),
    ]
    const file = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
    let offset = 0
    for (const part of parts) {
      file.set(part, offset)
      offset += part.length
    }

    expect(() => readMoqtraceSegments(file)).toThrow(MalformedHeaderError)

    const recovered = readMoqtraceSegments(file, { recover: true })
    expect(recovered.map((segment) => segment.header.segment?.sequence)).toEqual([0, 2])
    // The events of the segments that did read are still there; only the
    // malformed segment's are gone, along with the header that could not be
    // built.
    expect(recovered.map((segment) => segment.events.length)).toEqual([1, 1])
  })

  it('names the segment recovery dropped instead of dropping it quietly', () => {
    const good = (sequence: number): Uint8Array =>
      fileWithHeaderMap({ ...REQUIRED_HEADER_MAP, segment: { sequence } })
    const parts = [
      good(0),
      fileWithHeaderMap({ ...REQUIRED_HEADER_MAP, segment: { streamId: 'abc' } }),
      good(2),
    ]
    const file = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
    let offset = 0
    for (const part of parts) {
      file.set(part, offset)
      offset += part.length
    }

    const regions: RecoveredRegion[] = []
    const recovered = readMoqtraceSegments(file, {
      recover: true,
      onRecovered: (region) => regions.push(region),
    })

    // Two segments back and three in the file: without this report, nothing in
    // the return value distinguishes that from a file that only ever had two.
    expect(recovered).toHaveLength(2)
    expect(regions).toHaveLength(1)
    expect(regions[0]?.kind).toBe('header')
    expect(regions[0]?.offset).toBe(parts[0]?.length)
    expect(regions[0]?.resumedAt).toBe((parts[0]?.length ?? 0) + (parts[1]?.length ?? 0))
    expect(regions[0]?.cause).toBeInstanceOf(MalformedHeaderError)
  })

  it('reports an undefined resume point when recovery discards the rest of the file', () => {
    // The largest loss recovery can inflict: with no segment left to
    // resynchronize to, the reader returns what it has — which without the
    // report is indistinguishable from a clean end of file.
    const whole = fileWithHeaderMap({ ...REQUIRED_HEADER_MAP, segment: { sequence: 0 } })
    const cut = whole.subarray(0, whole.length - 1)

    const regions: RecoveredRegion[] = []
    const recovered = readMoqtraceSegments(cut, {
      recover: true,
      onRecovered: (region) => regions.push(region),
    })

    expect(recovered).toHaveLength(1)
    expect(recovered[0]?.events).toHaveLength(0)
    expect(regions).toHaveLength(1)
    expect(regions[0]?.kind).toBe('truncated')
    expect(regions[0]?.resumedAt).toBeUndefined()
    expect(regions[0]?.cause).toBeUndefined()
  })

  it('reports nothing when a file reads cleanly', () => {
    const regions: RecoveredRegion[] = []
    readMoqtraceSegments(fileWithHeaderMap({ ...REQUIRED_HEADER_MAP, segment: { sequence: 0 } }), {
      recover: true,
      onRecovered: (region) => regions.push(region),
    })
    expect(regions).toEqual([])
  })
})
