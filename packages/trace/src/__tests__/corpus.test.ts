import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  PREAMBLE_SIZE,
  readMoqtrace,
  readMoqtraceSegments,
  TruncatedTraceError,
  writeMoqtrace,
  writeMoqtraceSegments,
} from '../binary.js'
import type { Trace } from '../types.js'
import { v2HeaderExtra, v2HeadersLevelFlow } from './corpus/cases.js'
import { CORPUS_MISSING_MESSAGE, findCorpusDir } from './corpus/locate.js'

/**
 * The shared `.moqtrace` corpus.
 *
 * SPEC.md claims the format's cross-language compatibility is "maintained by a
 * shared corpus of `.moqtrace` files that both implementations read and write
 * as part of their test suites". This is that suite's half of it.
 *
 * What it checks that nothing else can: every other test in this package reads
 * only bytes this package wrote, and an encoder always agrees with its own
 * decoder — including on conventions nobody else implements. Both normative
 * encoding rules in SPEC.md exist because that blind spot hid a real break in
 * each direction. Here, half the files came from `moqtap-trace` and a quarter
 * from third-party relays.
 */

const CORPUS = findCorpusDir()

interface ManifestCase {
  id: string
  description: string
  files: { name: string; writer: string; bytes: number }[]
  version: number
  segments: number
  truncated: boolean
  protocol: string
  perspective: string
  detail: string
  eventCount: number
  eventTypes: Record<string, number>
}

function loadManifest(root: string): ManifestCase[] {
  const raw = readFileSync(join(root, 'manifest.json'), 'utf-8')
  return (JSON.parse(raw) as { cases: ManifestCase[] }).cases
}

function bytesOf(root: string, id: string, file: string): Uint8Array {
  return new Uint8Array(readFileSync(join(root, id, file)))
}

function declaredVersion(bytes: Uint8Array): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(8, true)
}

/** The CBOR header of a single-segment file, as the bytes carry it. */
function headerBytes(file: Uint8Array): Uint8Array {
  const length = new DataView(file.buffer, file.byteOffset, file.byteLength).getUint32(12, true)
  return file.subarray(PREAMBLE_SIZE, PREAMBLE_SIZE + length)
}

function indexOfBytes(haystack: Uint8Array, needle: readonly number[]): number {
  for (let i = 0; i + needle.length <= haystack.length; i++) {
    if (needle.every((byte, j) => haystack[i + j] === byte)) return i
  }
  return -1
}

/**
 * The `count` bytes a CBOR map holds immediately after the given text key.
 *
 * For asserting how a value is *encoded*, where the decoded value cannot say:
 * cbor-x folds tag 64 and an integral float away before any code here runs, so
 * a value assertion about either passes whatever the file carried.
 *
 * The key is matched as a definite-length text string with its length in the
 * head byte, which covers any name up to 23 characters — every key in this
 * format, and every key any corpus case invents.
 */
function bytesAfterKey(cbor: Uint8Array, key: string, count: number): number[] {
  const name = new TextEncoder().encode(key)
  const at = indexOfBytes(cbor, [0x60 + name.length, ...name])
  if (at < 0) throw new Error(`no key '${key}' in these bytes`)
  const value = at + 1 + name.length
  return [...cbor.subarray(value, value + count)]
}

/** Read a file whether or not it is truncated, keeping what decoded. */
function readSegments(bytes: Uint8Array): Trace[] {
  try {
    return readMoqtraceSegments(bytes)
  } catch (error) {
    if (error instanceof TruncatedTraceError) return error.segments
    throw error
  }
}

/** Wire discriminant for an event, including one only the file names. */
const EVENT_TYPE_IDS: Record<string, number> = {
  control: 0,
  'stream-opened': 1,
  'stream-closed': 2,
  'object-header': 3,
  'object-payload': 4,
  'state-change': 5,
  error: 6,
  annotation: 7,
  'peer-connected': 8,
  'peer-disconnected': 9,
  'subscription-derivation': 10,
}

function eventTypeCounts(segments: Trace[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const segment of segments) {
    for (const event of segment.events) {
      const key = String(event.type === 'unknown' ? event.eventType : EVENT_TYPE_IDS[event.type])
      counts[key] = (counts[key] ?? 0) + 1
    }
  }
  return counts
}

/**
 * A checkout that cannot reach the corpus is a wiring gap, not a conformance
 * failure: it ships in `@moqtap/test-traces`, so a checkout with no
 * dependencies installed has nothing to read. Failing there would paint every
 * build red for a missing dependency rather than for anything this package got
 * wrong.
 *
 * So the suite skips, and its name carries the reason — a skipped suite in the
 * reporter with no explanation is how a corpus quietly stops being run.
 */
const SUITE =
  CORPUS == null ? `.moqtrace corpus — SKIPPED: ${CORPUS_MISSING_MESSAGE}` : '.moqtrace corpus'

describe.skipIf(CORPUS == null)(SUITE, () => {
  const root = CORPUS as string
  // `describe.skipIf` still evaluates this body to collect the tests it is
  // about to skip, so reading the manifest unguarded threw during collection
  // and reported the whole file as failed — the one outcome this block exists
  // to avoid.
  const cases = CORPUS == null ? [] : loadManifest(CORPUS)

  it('is present', () => {
    expect(cases.length).toBeGreaterThan(0)
  })

  describe.each(cases)('$id', (entry) => {
    it.each(entry.files)('reads $name, written by $writer', (file) => {
      const bytes = bytesOf(root, entry.id, file.name)
      expect(bytes.length).toBe(file.bytes)
      expect(declaredVersion(bytes)).toBe(entry.version)

      const segments = readSegments(bytes)
      expect(segments).toHaveLength(entry.segments)
      const [head] = segments
      if (head == null) throw new Error(`${entry.id}/${file.name} decoded to no segments`)
      expect(head.header.protocol).toBe(entry.protocol)
      expect(head.header.perspective).toBe(entry.perspective)
      expect(head.header.detail).toBe(entry.detail)

      const events = segments.flatMap((segment) => segment.events)
      expect(events).toHaveLength(entry.eventCount)
      expect(eventTypeCounts(segments)).toEqual(entry.eventTypes)
    })

    // The claim the corpus exists for. Two encoders wrote these files and they
    // do not agree byte for byte — ciborium writes an integer in the narrowest
    // form that holds it, cbor-x writes a BigInt in eight — so bytes are the
    // wrong thing to compare and content is the right one.
    it.runIf(entry.files.length > 1)('carries identical content in every file', () => {
      const [first, ...rest] = entry.files.map((file) =>
        readSegments(bytesOf(root, entry.id, file.name)),
      )
      for (const other of rest) {
        expect(other).toEqual(first)
      }
    })

    it.skipIf(entry.truncated)('survives a read-modify-write round trip', () => {
      const [file] = entry.files
      if (file == null) throw new Error(`${entry.id} lists no files`)
      const original = readSegments(bytesOf(root, entry.id, file.name))
      const [only] = original
      if (only == null) throw new Error(`${entry.id}/${file.name} decoded to no segments`)
      const rewritten =
        entry.segments > 1
          ? readMoqtraceSegments(writeMoqtraceSegments(original))
          : readMoqtraceSegments(writeMoqtrace(only))
      expect(rewritten).toEqual(original)
    })
  })

  describe('the two encoding conventions SPEC.md makes normative', () => {
    // A suite that reads only bytes it wrote itself cannot see either: an
    // encoder always agrees with its own decoder. These two files are shapes
    // cbor-x produces, which a conformant reader has to take.
    const canonical = () => readMoqtrace(bytesOf(root, 'v2-basic', 'js.moqtrace'))

    it('accepts integers written as floats', () => {
      expect(readMoqtrace(bytesOf(root, 'v2-float-ints', 'js.moqtrace'))).toEqual(canonical())
    })

    it('accepts byte strings wrapped in tag 64', () => {
      expect(readMoqtrace(bytesOf(root, 'v2-tag64', 'js.moqtrace'))).toEqual(canonical())
    })
  })

  describe('a truncated file', () => {
    it.each(['js.moqtrace', 'rust.moqtrace'])('reports the cut distinctly in %s', (file) => {
      const bytes = bytesOf(root, 'v2-truncated', file)
      expect(() => readMoqtrace(bytes)).toThrow(TruncatedTraceError)

      try {
        readMoqtrace(bytes)
      } catch (error) {
        // Everything before the cut is exactly as valid as it was, and a
        // truncated capture is usually the only capture of what went wrong.
        const truncated = error as TruncatedTraceError
        expect(truncated.trace?.events).toHaveLength(11)
        expect(truncated.offset).toBeGreaterThan(0)
      }
    })
  })

  describe('an event type no reader knows', () => {
    it('keeps its fields verbatim across a round trip', () => {
      const original = readMoqtrace(bytesOf(root, 'v2-unknown-event', 'rust.moqtrace'))
      const unknown = original.events.find((event) => event.type === 'unknown')
      expect(unknown).toBeDefined()
      if (unknown?.type !== 'unknown') throw new Error('unreachable')

      expect(unknown.eventType).toBe(99)
      expect(unknown.fields.note).toBe('from the future')
      expect(unknown.fields.count).toBe(3)
      expect(new Uint8Array(unknown.fields.blob as Uint8Array)).toEqual(
        new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
      )

      // The point of keeping them: a tool that reads and rewrites a trace must
      // not strip what it did not recognise, or its ignorance becomes
      // permanent for every reader downstream of it.
      expect(readMoqtrace(writeMoqtrace(original))).toEqual(original)
    })
  })

  describe('a key no reader knows, on an event type it does', () => {
    it('survives a round trip through the other implementation', () => {
      const trace = readMoqtrace(bytesOf(root, 'v2-extra-keys', 'rust.moqtrace'))

      const [opened, header, failure] = trace.events
      // Every key is `x-` prefixed, the range SPEC.md reserves for private use
      // and promises never to define. A key a later revision can claim leaves
      // these assertions passing while measuring less, which is what the
      // reservation is for. Reading them back off a file the other
      // implementation wrote is what makes "an unrecognised key survives" a
      // checked claim.
      expect(opened?.extra).toEqual({ 'x-ta': 7, 'x-sg': 2 })
      expect(header?.extra?.['x-ta']).toBe(7)
      expect(failure?.extra?.['x-ek']).toBe('decode')
      expect(new Uint8Array(failure?.extra?.['x-raw'] as Uint8Array)).toEqual(
        new Uint8Array([0x99, 0x01]),
      )

      // A nested value, because preservation has to be structural: a shallow
      // copy passes every flat assertion above and loses this one.
      expect(header?.extra?.['x-nested']).toEqual({
        blob: new Uint8Array([0x0f, 0xf0]),
        inner: { depth: 3 },
        list: [1, 'two'],
      })

      // Ignoring an unrecognised key is allowed. Dropping one is not: this
      // round trip is the redaction pass, the filter, the annotated download.
      expect(readMoqtrace(writeMoqtrace(trace))).toEqual(trace)
    })

    it('is not collected twice on an event type no reader knows', () => {
      // An UnknownEvent keeps every non-common key in `fields`. Putting them
      // in `extra` as well writes each one twice and yields a CBOR map with
      // duplicate keys — which is what the first draft of this did.
      const trace = readMoqtrace(bytesOf(root, 'v2-unknown-event', 'js.moqtrace'))
      const unknown = trace.events.find((event) => event.type === 'unknown')
      expect(unknown?.extra).toBeUndefined()
    })
  })

  describe('the three unrecognised-key stores in the header', () => {
    // Both files, deliberately. On `rust.moqtrace` the assertions say this
    // package reads what an implementation sharing no code with it wrote; on
    // `js.moqtrace` they say this package's own writer put the values where
    // SPEC.md requires — the half a decode-of-my-own-encode test cannot see.
    const files = ['js.moqtrace', 'rust.moqtrace']

    it.each(files)('keeps a key of one name in three maps apart, in %s', (file) => {
      const trace = readMoqtrace(bytesOf(root, 'v2-header-extra', file))
      const { header } = trace

      // One key name, three maps, three values. A reader that merged the
      // stores into one would emit the segment's private key at the top level,
      // and the file would then say something it never said. No other file in
      // the corpus carries an unrecognised *header* key at all, so nothing else
      // here can tell a merged store from three.
      expect(header.extra?.['x-scope']).toBe('header')
      expect(header.segment?.extra?.['x-scope']).toBe('segment')
      expect(header.sampling?.extra?.['x-scope']).toBe('sampling')

      // Structural, not shallow: a copy that kept only the top level passes
      // every flat assertion here and loses this one.
      expect(header.extra?.['x-tree']).toEqual({
        list: [1, 'two'],
        blob: new Uint8Array([0x0f, 0xf0]),
        gap: null,
      })

      // A key the format *defines*, carrying a value no reader can use. It
      // reaches the store through the ordinary field path, `transport` reads as
      // absent, and the entry survives: knowing more about a key must not mean
      // preserving it less.
      expect(header.transport).toBeUndefined()
      expect(header.extra?.transport).toBe(42)

      // Every unrecognised key in this file is in the header, so a store on an
      // event is a reader putting one where it does not belong.
      expect(trace.events.every((event) => event.extra == null)).toBe(true)

      // The round trip is the redaction pass, the filter, the annotated
      // download — and a fixed point, not merely lossless once.
      expect(readMoqtrace(writeMoqtrace(trace))).toEqual(trace)
    })

    it.each(files)('writes a stored value in the encoding SPEC.md requires, in %s', (file) => {
      // Checked in bytes rather than in values, because this reader cannot see
      // either shape: cbor-x hands back a bare byte string for one under tag 64
      // and an integer for an integral float, both below any code here. A value
      // assertion on this side would pass whatever the file carried, which is
      // exactly the blind spot the corpus exists for. The Rust case builds
      // these two entries as `Tag(64, Bytes)` and `Float(1.0)`, so a file
      // carrying either shape is one only that writer could have produced.
      const header = headerBytes(bytesOf(root, 'v2-header-extra', file))

      // A byte string of two bytes, major type 2 (0x42) — never RFC 8746's
      // tag 64 (0xd8 0x40).
      expect(bytesAfterKey(header, 'x-blob', 3)).toEqual([0x42, 0xca, 0xfe])
      // The CBOR integer 1, never a float (0xf9, 0xfa or 0xfb).
      expect(bytesAfterKey(header, 'x-scale', 1)).toEqual([0x01])
    })

    it('is the file this package writes for the case', () => {
      // Every assertion above reads a file, and a committed file has already
      // been through a writer once: it carries the required encoding whatever
      // the writer would do with the case today. So they all stay green through
      // a writer regression until somebody regenerates the corpus — the same
      // decode-of-my-own-encode shape one level out, with the encode cached on
      // disk. This is the assertion that reads the writer, and the one that
      // fails if `js.moqtrace` is stale.
      expect(writeMoqtrace(v2HeaderExtra)).toEqual(bytesOf(root, 'v2-header-extra', 'js.moqtrace'))
    })
  })

  describe('a headers-level trace, where the stream identifiers are all there is', () => {
    const files = ['js.moqtrace', 'rust.moqtrace']

    it.each(files)('groups three streams that share one track alias, in %s', (file) => {
      // The case existed for a session before anything named it, so its
      // documented claims were asserted nowhere and it could have decoded to
      // anything without a test noticing. `detail: 'headers'` records no
      // payload and no data-stream framing bytes, so these four keys are the
      // only thing in the file that says which track a stream carried.
      const trace = readMoqtrace(bytesOf(root, 'v2-headers-level-flow', file))
      expect(trace.header.detail).toBe('headers')

      const opened = trace.events.filter((e) => e.type === 'stream-opened')
      expect(opened).toHaveLength(3)

      // Every stream carries the same alias, which is legal and ordinary — one
      // track delivered as a subgroup, a fetch and a datagram. It is also the
      // whole point: `ta` alone cannot key a flow, which is why the flow
      // identity is the tuple and not this number.
      expect(opened.map((e) => e.trackAlias)).toEqual([9n, 9n, 9n])

      // One discriminating key each, and never the other two. A reader that
      // dropped any of them would leave three streams of one alias that
      // nothing in the file could tell apart.
      const [subgroup, fetch, datagram] = opened
      expect([subgroup?.subgroupId, subgroup?.fetchRequestId, subgroup?.groupId]).toEqual([
        2n,
        undefined,
        undefined,
      ])
      expect([fetch?.subgroupId, fetch?.fetchRequestId, fetch?.groupId]).toEqual([
        undefined,
        42n,
        undefined,
      ])
      // Past 2^32, where the integer-not-float rule bites and a `number` would
      // have stopped being exact long before.
      expect([datagram?.subgroupId, datagram?.fetchRequestId, datagram?.groupId]).toEqual([
        undefined,
        undefined,
        4294967296n,
      ])
    })

    it('is the file this package writes for the case', () => {
      expect(writeMoqtrace(v2HeadersLevelFlow)).toEqual(
        bytesOf(root, 'v2-headers-level-flow', 'js.moqtrace'),
      )
    })
  })

  describe('a capture from a third-party relay', () => {
    it('reads a draft-18 session where every stream declares id 0', () => {
      const trace = readMoqtrace(
        bytesOf(root, 'capture-observer-draft18-moq-rs', 'capture.moqtrace'),
      )
      const opened = trace.events.filter((event) => event.type === 'stream-opened')

      // Draft-18 gives each request its own bidirectional stream, so these are
      // four distinct QUIC streams. The recorder does not see stream IDs and
      // writes 0 for all of them, which is why a stream id alone cannot key a
      // flow and why Event 1 carries the stream header's identifiers. The
      // assertion pins today's behaviour so a change to it is visible, not
      // because 0 is correct.
      expect(opened).toHaveLength(4)
      expect(opened.every((event) => event.type === 'stream-opened' && event.streamId === 0n)).toBe(
        true,
      )
    })
  })
})
