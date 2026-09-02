import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  readMoqtrace,
  readMoqtraceSegments,
  TruncatedTraceError,
  writeMoqtrace,
  writeMoqtraceSegments,
} from '../binary.js'
import type { Trace } from '../types.js'
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
 * failure: the corpus ships in `@moqtap/test-vectors`, and until the release
 * that carries `trace/`, CI resolves a version without it. Failing there would
 * paint every build red for a missing dependency rather than for anything this
 * package got wrong.
 *
 * So the suite skips, and its name carries the reason — a skipped suite in the
 * reporter with no explanation is how a corpus quietly stops being run. It
 * self-heals: the moment the dependency carries `trace/`, every test below
 * becomes live with no change here.
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
    // Both were broken, in opposite directions, by the two implementations,
    // and neither test suite could see it: each read only bytes it had written
    // itself. These two files are the shapes each used to write.
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
      // and promises never to define. The fixture used to borrow keys from this
      // proposal's own sections instead, until §2 shipped and claimed two of
      // them — turning these assertions red, which invited weakening them
      // rather than replacing the fixture.
      // Reading them back off a file the other implementation wrote is what
      // makes "an unrecognised key survives" a checked claim.
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

  describe('a capture from a third-party relay', () => {
    it('reads a draft-18 session where every stream declares id 0', () => {
      const trace = readMoqtrace(
        bytesOf(root, 'capture-observer-draft18-moq-rs', 'capture.moqtrace'),
      )
      const opened = trace.events.filter((event) => event.type === 'stream-opened')

      // Draft-18 gives each request its own bidirectional stream, so these are
      // four distinct QUIC streams. The recorder does not see stream IDs and
      // writes 0 for all of them, which is the gap PROPOSAL-v3 §1 closes. The
      // assertion pins today's behaviour so the change is visible when it
      // lands, not so that it is correct.
      expect(opened).toHaveLength(4)
      expect(opened.every((event) => event.type === 'stream-opened' && event.streamId === 0n)).toBe(
        true,
      )
    })
  })
})
