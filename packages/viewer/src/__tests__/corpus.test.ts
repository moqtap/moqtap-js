/**
 * The parser and analysis, run over the shared `.moqtrace` corpus.
 *
 * Through `handle()`, the function the worker runs, so what is tested is the
 * path a trace actually takes: bytes in, registries attached, analysis out.
 * Each corpus case declares what a reader must see; the analysis has to agree
 * with that, and the findings it raises have to be the ones the case was
 * written to provoke.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { type ObjectHeaderEvent, type TraceEvent, writeMoqtrace } from '@moqtap/trace'
import { describe, expect, it } from 'vitest'
import { PAYLOAD_PREVIEW_BYTES, type TraceAnalysis } from '../analysis'
import { formatVersionOf, readTrace } from '../read'
import { handle } from '../worker'
import { CORPUS_MISSING_MESSAGE, findCorpusDir } from './locate'

interface CorpusCase {
  id: string
  files: { name: string }[]
  version: number
  segments: number
  truncated: boolean
  protocol: string
  perspective: string
  detail: string
  eventCount: number
}

const dir = findCorpusDir()
if (dir === undefined) throw new Error(CORPUS_MISSING_MESSAGE)
const corpusDir: string = dir

const manifest = JSON.parse(readFileSync(join(corpusDir, 'manifest.json'), 'utf8')) as {
  cases: CorpusCase[]
}

function bytesOf(caseId: string, file: string): Uint8Array {
  return new Uint8Array(readFileSync(join(corpusDir, caseId, file)))
}

function analyseBytes(bytes: Uint8Array, name: string): TraceAnalysis {
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  const response = handle({ bytes: buffer as ArrayBuffer })
  if (!response.ok) throw new Error(`${name}: ${response.message}`)
  return response.analysis
}

function analyse(caseId: string, file = 'js.moqtrace'): TraceAnalysis {
  return analyseBytes(bytesOf(caseId, file), `${caseId}/${file}`)
}

const ids = (a: TraceAnalysis) => a.findings.map((f) => f.id)

describe('every corpus file', () => {
  const files = manifest.cases.flatMap((c) => c.files.map((f) => [c.id, f.name, c] as const))

  it.each(files)('%s/%s reads to the summary its manifest declares', (caseId, file, expected) => {
    const { summary, findings } = analyse(caseId, file)
    expect(summary.formatVersion).toBe(expected.version)
    expect(summary.segments).toBe(expected.segments)
    expect(summary.protocol).toBe(expected.protocol)
    expect(summary.perspective).toBe(expected.perspective)
    expect(summary.detail).toBe(expected.detail)
    const events = Object.values(summary.eventCounts).reduce((a, b) => a + b, 0)
    expect(events).toBe(expected.eventCount)
    expect(findings.some((f) => f.id === 'truncated')).toBe(expected.truncated)
  })
})

describe('findings the corpus provokes', () => {
  it('a version-1 file is said to be unsegmented', () => {
    expect(ids(analyse('v1-basic'))).toContain('format-v1')
  })

  it('a truncated file still yields what precedes the cut, and says where it stops', () => {
    const bytes = bytesOf('v2-truncated', 'js.moqtrace')
    const read = readTrace(bytes)
    expect(read.truncatedAt).toBeGreaterThan(0)
    expect(read.segments.length).toBeGreaterThan(0)
    const finding = analyse('v2-truncated').findings.find((f) => f.id === 'truncated')
    expect(finding?.severity).toBe('error')
    expect(finding?.detail).toContain(String(read.truncatedAt))
  })

  it('an unknown protocol string names no draft rather than a guessed one', () => {
    // `moq-transport-rfc9999` has digits at the end; reading 99 out of it would
    // attach a registry of wrong names.
    const analysis = analyse('v2-unknown-perspective')
    expect(analysis.summary.draft).toBeNull()
    expect(ids(analysis)).toEqual(expect.arrayContaining(['unknown-draft', 'unknown-perspective']))
  })

  it('an event type the reader cannot name is counted and reported, not dropped', () => {
    const analysis = analyse('v2-unknown-event')
    expect(analysis.summary.unknownEventTypes).toEqual({ 99: 1 })
    expect(ids(analysis)).toContain('unknown-events')
  })

  it('header keys the reader cannot name are reported', () => {
    expect(ids(analyse('v2-header-extra'))).toContain('header-extra')
  })

  it('declared sampling is reported as dropped events', () => {
    expect(ids(analyse('v2-header-extra'))).toContain('sampling')
  })

  it('an error that kept its offending bytes is called out', () => {
    expect(ids(analyse('v2-error-with-raw'))).toEqual(
      expect.arrayContaining(['errors', 'error-evidence']),
    )
  })

  it('a SUBSCRIBE with a request id and no response is reported unanswered', () => {
    expect(ids(analyse('v2-control-msg-map'))).toContain('subscribe-unanswered')
  })

  it('subscriptions with no readable request id are unpairable, never "all answered"', () => {
    const found = ids(analyse('v2-msg-absent'))
    expect(found).toContain('subscribe-unpairable')
    expect(found).not.toContain('subscribe-unanswered')
  })

  it('a message ID the declared draft does not define is flagged as disagreement', () => {
    // Recorded as draft 14 but carrying the unified SETUP of a later draft.
    const analysis = analyse('capture-observer-draft18-moq-rs', 'capture.moqtrace')
    expect(ids(analysis)).toContain('message-id-undefined')
    expect(analysis.messages.filter((m) => m.name === null).map((m) => m.messageType)).toContain(
      0x2f00,
    )
  })

  it('a message on a reserved code point is unnamed and carries its note', () => {
    const analysis = analyse('v2-basic')
    const reserved = analysis.messages.find((m) => m.reserved)
    expect(reserved?.name).toBeNull()
    expect(reserved?.note).not.toBeNull()
    expect(ids(analysis)).toContain('message-id-reserved')
  })
})

describe('naming against the draft', () => {
  it('names a real draft-16 session with the draft-16 registry', () => {
    const analysis = analyse('capture-client-draft16-moq-rs', 'capture.moqtrace')
    expect(analysis.summary.draft).toBe(16)
    expect(analysis.messages.map((m) => m.name)).toEqual(['CLIENT_SETUP', 'SERVER_SETUP'])
    expect(analysis.messages[0]?.specPath).toMatch(/^\/spec\/draft-16\//)
  })

  it('names the same ID differently under the draft that redefined it', () => {
    const analysis = analyse('capture-client-draft19-imquic', 'capture.moqtrace')
    expect(analysis.summary.draft).toBe(19)
    expect(analysis.messages.map((m) => m.name)).toEqual(['SETUP', 'SETUP'])
    expect(ids(analysis)).toContain('no-control-stream-id')
  })

  it('carries the section the draft specifies a message in, for its § citation', () => {
    const analysis = analyse('capture-client-draft16-moq-rs', 'capture.moqtrace')
    for (const message of analysis.messages) expect(message.section).toMatch(/^\d+(\.\d+)*$/)
    const reserved = analyse('v2-basic').messages.find((m) => m.reserved)
    expect(reserved?.section).toBeNull()
  })

  it('carries the bytes a recorder kept for a message, and their length', () => {
    const [first] = analyse('capture-client-draft16-moq-rs', 'capture.moqtrace').messages
    expect(first?.size).toBeGreaterThan(0)
    expect(first?.raw?.length).toBe(first?.size)
  })

  it('orders a segmented trace by (segment, seq), not by seq alone', () => {
    const { summary, messages } = analyse('v2-segmented')
    expect(summary.segments).toBe(3)
    const keys = messages.map((m) => [m.segment, m.seq] as const)
    const sorted = [...keys].sort((a, b) => a[0] - b[0] || a[1] - b[1])
    expect(keys).toEqual(sorted)
  })
})

describe('streams and objects', () => {
  it('lists every stream with the objects seen on it', () => {
    const { summary, streams } = analyse('capture-observer-draft16-moq-rs', 'capture.moqtrace')
    expect(streams).toHaveLength(summary.streams)
    const objects = streams.reduce((n, s) => n + s.objects, 0)
    expect(objects).toBe(52)
    for (const stream of streams) expect(stream.objectRows).toHaveLength(stream.objects)
  })

  it('keeps an object seen as a header and then a payload as one object', () => {
    const { streams } = analyse('v2-basic')
    const objects = streams.flatMap((s) => s.objectRows)
    // One row carrying both the header's status and the payload's size: two
    // rows would each carry one of them.
    const merged = objects.filter((o) => o.status !== undefined && o.size !== undefined)
    expect(merged.length).toBeGreaterThan(0)
    for (const object of merged) {
      expect(object.payload?.length).toBeLessThanOrEqual(object.size!)
    }
  })

  it("carries each object's publisher priority from its header, for the Priority column", () => {
    const file = 'capture.moqtrace'
    const { streams } = analyse('capture-observer-draft16-moq-rs', file)
    const headers = readTrace(bytesOf('capture-observer-draft16-moq-rs', file))
      .segments.flatMap((s) => s.events)
      .filter((e): e is ObjectHeaderEvent => e.type === 'object-header')
    const want = new Map(
      headers.map((h) => [`${h.streamId}/${h.groupId}/${h.objectId}`, h.publisherPriority]),
    )
    const rows = streams.flatMap((s) =>
      s.objectRows.map((o) => [`${s.streamId}/${o.groupId}/${o.objectId}`, o.priority] as const),
    )
    expect(rows.length).toBeGreaterThan(0)
    for (const [key, priority] of rows) expect(priority, key).toBe(want.get(key))
  })

  it('keeps a payload preview on the first object of a stream that has one, and no other', () => {
    const payload = new Uint8Array(PAYLOAD_PREVIEW_BYTES * 2).fill(0xab)
    const events: TraceEvent[] = []
    for (const streamId of [2n, 6n]) {
      for (const objectId of [0n, 1n, 2n]) {
        events.push({
          type: 'object-payload',
          seq: events.length,
          timestamp: events.length * 10,
          streamId,
          groupId: 0n,
          objectId,
          size: payload.length,
          payload,
        })
      }
    }
    const bytes = writeMoqtrace({
      header: {
        protocol: 'moq-transport-16',
        perspective: 'client',
        detail: 'full',
        startTime: 1_767_225_600_000,
      },
      events,
    })
    const { streams } = analyseBytes(bytes, 'payloads')
    expect(streams).toHaveLength(2)
    for (const stream of streams) {
      expect(stream.objectRows.map((o) => o.payload?.length)).toEqual([
        PAYLOAD_PREVIEW_BYTES,
        undefined,
        undefined,
      ])
      for (const object of stream.objectRows) expect(object.size).toBe(payload.length)
    }
  })

  it('places every event on one clock from the session start', () => {
    // Each segment stamps its events from its own start, so the same raw
    // timestamp in a later segment is a later moment in the session.
    const { streams } = analyse('v2-segmented')
    const segments = readTrace(bytesOf('v2-segmented', 'js.moqtrace')).segments
    const raw = segments.flatMap((s) => s.events.filter((e) => e.type === 'object-header'))
    const at = streams.flatMap((s) => s.objectRows.map((o) => o.at))
    expect(at).toHaveLength(raw.length)
    expect(at.some((t, i) => t > raw[i]!.timestamp)).toBe(true)
    for (let i = 1; i < at.length; i++) expect(at[i]).toBeGreaterThanOrEqual(at[i - 1]!)
    for (const s of streams) expect(s.at).toBeGreaterThanOrEqual(0)
  })
})

describe('what is not a trace', () => {
  it('bytes that are not a .moqtrace come back as a message, not a throw', () => {
    const junk = new TextEncoder().encode('MOQTRACE but nothing after it')
    const response = handle({ bytes: junk.buffer as ArrayBuffer })
    expect(response.ok).toBe(false)
  })

  it('the format version is read from the preamble', () => {
    expect(formatVersionOf(bytesOf('v1-basic', 'js.moqtrace'))).toBe(1)
    expect(formatVersionOf(bytesOf('v2-basic', 'js.moqtrace'))).toBe(2)
  })
})
