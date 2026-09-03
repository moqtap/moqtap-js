import { describe, expect, it } from 'vitest'
// Everything comes from the modules directly rather than the package barrel:
// `index.ts` has an uncommitted change belonging to another session, and the
// reader's own export line is not in it yet.
import {
  MalformedHeaderError,
  readMoqtrace,
  readMoqtraceSegments,
  writeMoqtrace,
  writeMoqtraceSegments,
} from '../binary.js'
import { MalformedCborError } from '../cbor-scan.js'
import { createMoqtraceReader, type ReadItem, TruncatedStreamError } from '../reader.js'
import type { Trace, TraceEvent, TraceHeader } from '../types.js'

const header = (over: Partial<TraceHeader> = {}): TraceHeader => ({
  protocol: 'moq-transport-19',
  perspective: 'client',
  detail: 'control',
  startTime: 1_756_800_000_000,
  ...over,
})

const annotation = (seq: number): TraceEvent => ({
  type: 'annotation',
  seq,
  timestamp: seq * 10,
  label: 'checkpoint',
  data: { at: seq },
})

const events = (count: number): TraceEvent[] =>
  Array.from({ length: count }, (_, i) => annotation(i))

function readAll(bytes: Uint8Array, chunkSize: number): ReadItem[] {
  const reader = createMoqtraceReader()
  const items: ReadItem[] = []
  for (let at = 0; at < bytes.length; at += chunkSize) {
    items.push(...reader.push(bytes.subarray(at, Math.min(at + chunkSize, bytes.length))))
  }
  items.push(...reader.end())
  return items
}

const eventsOf = (items: ReadItem[]): TraceEvent[] =>
  items.filter((i) => i.kind === 'event').map((i) => i.event)

const headersOf = (items: ReadItem[]): TraceHeader[] =>
  items.filter((i) => i.kind === 'segment').map((i) => i.header)

describe('createMoqtraceReader', () => {
  /**
   * The property that matters is that chunking cannot change the answer. A
   * fixed chunk size would only prove the reader works for boundaries that
   * happen to fall where that size puts them; sweeping every size from one byte
   * up puts a boundary inside every field of every item at least once.
   */
  it('reads the same trace at every chunk size', () => {
    const trace: Trace = { header: header(), events: events(12) }
    const bytes = writeMoqtrace(trace)
    const whole = readMoqtrace(bytes)

    for (let size = 1; size <= bytes.length; size++) {
      const items = readAll(bytes, size)
      expect(headersOf(items), `chunk size ${size}`).toEqual([whole.header])
      expect(eventsOf(items), `chunk size ${size}`).toEqual(whole.events)
    }
  })

  it('agrees with the whole-buffer reader on a segmented stream', () => {
    const segments: Trace[] = [
      { header: header({ segment: { sequence: 0 } }), events: events(3) },
      { header: header({ segment: { sequence: 1 } }), events: events(4) },
      { header: header({ segment: { sequence: 2 } }), events: events(2) },
    ]
    const bytes = writeMoqtraceSegments(segments)
    const whole = readMoqtraceSegments(bytes)

    for (const size of [1, 2, 7, 13, 64, bytes.length]) {
      const items = readAll(bytes, size)
      expect(headersOf(items), `chunk size ${size}`).toEqual(whole.map((s) => s.header))
      expect(eventsOf(items), `chunk size ${size}`).toEqual(whole.flatMap((s) => s.events))
    }
  })

  it('announces a segment before any event belonging to it', () => {
    const bytes = writeMoqtraceSegments([
      { header: header({ segment: { sequence: 0 } }), events: events(2) },
      { header: header({ segment: { sequence: 1 } }), events: events(2) },
    ])
    // The first item must be a segment, and the kinds must alternate in the
    // order written — an event arriving before its header would leave a
    // consumer attributing it to the segment before.
    expect(readAll(bytes, 3).map((i) => i.kind)).toEqual([
      'segment',
      'event',
      'event',
      'segment',
      'event',
      'event',
    ])
  })

  it('exposes the current segment header as it advances', () => {
    const bytes = writeMoqtraceSegments([
      { header: header({ segment: { sequence: 0 } }), events: events(1) },
      { header: header({ segment: { sequence: 7 } }), events: events(1) },
    ])
    const reader = createMoqtraceReader()
    expect(reader.header).toBeUndefined()

    const seen: (number | undefined)[] = []
    for (let at = 0; at < bytes.length; at++) {
      reader.push(bytes.subarray(at, at + 1))
      seen.push(reader.header?.segment?.sequence)
    }
    reader.end()

    expect(seen[seen.length - 1]).toBe(7)
    expect(new Set(seen)).toEqual(new Set([undefined, 0, 7]))
  })

  /**
   * The case the design turns on. An event smaller than the eight magic bytes
   * cannot be told from the start of a segment preamble while more bytes might
   * still arrive, so it has to wait — and if `end()` did not drain, it would be
   * lost silently, which is the worst way to lose the last event of a capture.
   */
  it('yields a trailing event too short to rule out a preamble', () => {
    // Hand-built, because this writer has no event that encodes to under eight
    // bytes and the reader must not depend on that staying true — a shorter
    // event is well-formed CBOR and a future event type or another writer may
    // produce one. These seven bytes are the map `{n: 1, t: 2}`; with no `e`
    // key it decodes as an event type this version does not know.
    const short = new Uint8Array([0xa2, 0x61, 0x6e, 0x01, 0x61, 0x74, 0x02])
    const unknown: TraceEvent = { type: 'unknown', seq: 1, timestamp: 2, eventType: -1, fields: {} }

    const opening = writeMoqtrace({ header: header(), events: [] })
    const bytes = new Uint8Array(opening.length + short.length)
    bytes.set(opening, 0)
    bytes.set(short, opening.length)

    const reader = createMoqtraceReader()

    const duringPush = reader.push(bytes)
    expect(reader.pending, 'the short event should still be held back').toBeGreaterThan(0)
    expect(eventsOf(duringPush)).toEqual([])

    const atEnd = reader.end()
    expect(eventsOf(atEnd)).toEqual([unknown])
    expect(reader.pending).toBe(0)
  })

  it('does not mistake magic bytes inside a payload for a segment', () => {
    // The eight bytes of the magic, carried as data. A reader that scanned for
    // them rather than checking at item boundaries would split here.
    const magic = new Uint8Array([0x4d, 0x4f, 0x51, 0x54, 0x52, 0x41, 0x43, 0x45])
    const carrier: TraceEvent = {
      type: 'object-payload',
      seq: 0,
      timestamp: 1,
      streamId: 4n,
      groupId: 0n,
      objectId: 0n,
      size: magic.length,
      payload: magic,
    }
    const bytes = writeMoqtrace({ header: header({ detail: 'headers+data' }), events: [carrier] })

    for (const size of [1, 5, bytes.length]) {
      const items = readAll(bytes, size)
      expect(headersOf(items), `chunk size ${size}`).toHaveLength(1)
      expect(eventsOf(items), `chunk size ${size}`).toEqual([carrier])
    }
  })

  describe('refuses what it cannot read', () => {
    it('rejects bytes that are not a trace', () => {
      const reader = createMoqtraceReader()
      expect(() => reader.push(new TextEncoder().encode('not a trace at all'))).toThrow(
        /Invalid magic bytes/,
      )
    })

    it('waits rather than rejecting while the magic is still arriving', () => {
      const bytes = writeMoqtrace({ header: header(), events: events(1) })
      const reader = createMoqtraceReader()
      // Four bytes cannot be judged either way; the reader must not decide yet.
      expect(reader.push(bytes.subarray(0, 4))).toEqual([])
      expect(reader.push(bytes.subarray(4))).not.toEqual([])
    })

    it('rejects a version it does not support', () => {
      const bytes = writeMoqtrace({ header: header(), events: events(1) })
      new DataView(bytes.buffer, bytes.byteOffset).setUint32(8, 99, true)
      expect(() => createMoqtraceReader().push(bytes)).toThrow(/Unsupported format version: 99/)
    })

    it('reports a stream cut mid-event, naming where', () => {
      const bytes = writeMoqtrace({ header: header(), events: events(4) })
      const reader = createMoqtraceReader()
      reader.push(bytes.subarray(0, bytes.length - 3))

      try {
        reader.end()
        expect.unreachable('should have thrown')
      } catch (error) {
        expect(error).toBeInstanceOf(TruncatedStreamError)
        // The offset names where the incomplete item starts, not where the
        // bytes ran out — that is what a caller needs to resume or report.
        const { offset, events } = error as TruncatedStreamError
        expect(offset).toBeGreaterThan(0)
        expect(offset).toBeLessThan(bytes.length - 3)
        // Three of the four events were whole before the cut, and the count has
        // to say so: "truncated" alone does not tell whoever holds the damaged
        // capture how much of it survived.
        expect(events).toBe(3)
      }
    })

    it('counts nothing delivered when the cut is in the header', () => {
      const bytes = writeMoqtrace({ header: header(), events: events(2) })
      const reader = createMoqtraceReader()
      reader.push(bytes.subarray(0, 20))
      try {
        reader.end()
        expect.unreachable('should have thrown')
      } catch (error) {
        expect((error as TruncatedStreamError).events).toBe(0)
      }
    })

    it('reports a stream cut inside the header', () => {
      const bytes = writeMoqtrace({ header: header(), events: events(1) })
      const reader = createMoqtraceReader()
      reader.push(bytes.subarray(0, 20))
      expect(() => reader.end()).toThrow(TruncatedStreamError)
    })

    it('reports a stream cut inside the preamble', () => {
      const bytes = writeMoqtrace({ header: header(), events: events(1) })
      const reader = createMoqtraceReader()
      reader.push(bytes.subarray(0, 12))
      expect(() => reader.end()).toThrow(TruncatedStreamError)
    })

    it('treats an empty stream as no trace rather than an empty one', () => {
      // Returning no items here would be indistinguishable from a valid capture
      // that recorded nothing, and the two mean opposite things.
      expect(() => createMoqtraceReader().end()).toThrow(TruncatedStreamError)
    })

    it('rejects a header missing a key the format requires', () => {
      const bytes = writeMoqtrace({ header: header(), events: events(1) })
      const whole = writeMoqtrace({
        // `protocol` absent: the whole-buffer reader throws MalformedHeaderError
        // for this, and the incremental one must not differ.
        header: { ...header(), protocol: undefined as unknown as string },
        events: [],
      })
      expect(() => readMoqtrace(whole)).toThrow(MalformedHeaderError)
      expect(() => createMoqtraceReader().push(whole)).toThrow(MalformedHeaderError)
      expect(() => createMoqtraceReader().push(bytes)).not.toThrow()
    })

    it('rejects malformed CBOR where an event should start', () => {
      const good = writeMoqtrace({ header: header(), events: events(1) })
      // 0x1c is reserved additional information — not a decodable item.
      const bad = new Uint8Array(good.length + 1)
      bad.set(good, 0)
      bad[good.length] = 0x1c
      const reader = createMoqtraceReader()
      expect(() => {
        reader.push(bad)
        reader.end()
      }).toThrow(MalformedCborError)
    })

    it('refuses to be pushed to after it has ended', () => {
      const bytes = writeMoqtrace({ header: header(), events: events(1) })
      const reader = createMoqtraceReader()
      reader.push(bytes)
      reader.end()
      expect(() => reader.push(bytes)).toThrow(/ended/)
    })
  })
})
