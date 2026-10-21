/**
 * What a `.moqtrace` says, reduced to what a person opening one wants to know.
 *
 * Framework-free and free of browser APIs on purpose: this runs in a worker
 * and would run in Node or a CLI unchanged.
 *
 * The rule running through every function here is that the file wins. Where a
 * trace is ambiguous, incomplete or self-contradictory, that is a finding to
 * report, not a gap to fill in with a plausible guess. Someone is reading
 * this because something went wrong, and an inference presented as a fact is
 * how they lose an afternoon.
 */

import {
  type ControlEvent,
  codeLabel,
  displayBytes,
  displayFields,
  displayValue,
  draftOfProtocol,
  type InspectEvent,
  messageAliases,
  messageKind,
  type Problem,
  pairRequests,
  problemDetail,
  problemSeverity,
  problems,
  problemTitle,
  requestIdOf,
  setupImplementation,
  setupVersionLabel,
  type TrackFields,
  TrackRegistry,
  trackDisplayName,
} from '@moqtap/inspect'
import {
  type AnnotationEvent,
  type ControlMessageEvent,
  controlMessageFields,
  type ObjectHeaderEvent,
  type ObjectPayloadEvent,
  type PeerDisconnectedEvent,
  type StreamClosedEvent,
  type StreamOpenedEvent,
  type Trace,
  type TraceErrorEvent,
  type TraceEvent,
  type TraceHeader,
  type UnknownEvent,
} from '@moqtap/trace'

import { byId, draftOf, type MessageDef, type MessageTables } from './drafts'
import { draftLabel, hexId, offset, plainValue } from './format'
import {
  type Delivery,
  type DeliveryStats,
  delivery,
  laneKey,
  type PlacedAnnotation,
} from './rollups'

// --------------------------------------------------------------- results ---

export type Severity = 'error' | 'warning' | 'note'

/** Something about this trace worth saying before anyone reads an event. */
export interface Finding {
  readonly id: string
  readonly severity: Severity
  readonly title: string
  readonly detail: string
}

export interface SessionSummary {
  readonly formatVersion: number
  readonly segments: number
  readonly protocol: string
  /** `null` when the protocol string names no draft the viewer carries. */
  readonly draft: number | null
  readonly perspective: string
  readonly detail: string
  /** The WebTransport protocol the session negotiated (`moqt-16`), when the recorder noted it. */
  readonly negotiatedProtocol?: string | undefined
  /**
   * How the draft is known, beyond the recorder declaring it: the negotiated
   * protocol named it, or the version SERVER_SETUP selected did.
   */
  readonly draftFrom?: 'negotiated-protocol' | 'setup-version' | undefined
  /** What the client and the relay call themselves in their setup messages. */
  readonly clientImplementation?: string | undefined
  readonly relayImplementation?: string | undefined
  readonly transport?: string | undefined
  readonly source?: string | undefined
  readonly endpoint?: string | undefined
  readonly sessionId?: string | undefined
  /** Unix epoch milliseconds, from the first segment's header. */
  readonly startTime: number
  readonly endTime?: number | undefined
  /**
   * Wall time from the first event to the last, in microseconds.
   *
   * Absent when every event shares one timestamp, which is not a session of
   * zero length but a recorder that did not stamp them. The
   * `degenerate-timestamps` finding says so where that happens.
   */
  readonly durationUs?: number | undefined
  readonly eventCounts: Readonly<Record<string, number>>
  readonly unknownEventTypes: Readonly<Record<number, number>>
  readonly peers: readonly string[]
  readonly streams: number
  readonly tracks: readonly string[]
  readonly objects: number
  /**
   * Bytes of object payload, summed from the declared sizes.
   *
   * The size is recorded from `headers+sizes` up and is independent of whether
   * the bytes themselves were kept, so this is the transferred volume even for
   * a trace that stored no media at all.
   */
  readonly payloadBytes: number
}

/** One control message, named and placed against the draft it was sent under. */
export interface MessageRow {
  readonly segment: number
  readonly seq: number
  /** Microseconds from the containing segment's start. */
  readonly timestamp: number
  /** Microseconds from the session's start: the first segment's start time. */
  readonly at: number
  /** `0` sent by the recorder, `1` received; `null` where the file does not say. */
  readonly direction: 0 | 1 | null
  /** The wire ID; `null` on bytes that did not decode as any message. */
  readonly messageType: number | null
  /**
   * Why the bytes on a control stream did not decode, for a row that holds
   * bytes rather than a message. Such a row is never given a message name.
   */
  readonly undecodable?: string | undefined
  /**
   * The draft's name for this ID, or `null` when the draft does not name it.
   *
   * Also `null` on a reserved code point, whose registry entry reads
   * `RESERVED`: a placeholder, not a message name, and showing it as one
   * would make an ID the draft deliberately left unassigned look like an
   * ordinary message. What the entry does carry is a note saying what the
   * code point was assigned to in earlier drafts, which is the useful half.
   */
  readonly name: string | null
  readonly reserved: boolean
  readonly note: string | null
  /** The draft section that specifies the message, such as `9.7`. */
  readonly section: string | null
  readonly specPath: string | null
  readonly peer?: string | undefined
  readonly streamId?: string | undefined
  /** The track the message is about, as `namespace / name`, once one is known. */
  readonly track?: string | undefined
  /** Length of the message's encoded bytes, when the recorder kept them. */
  readonly size?: number | undefined
  /** The first `RAW_PREVIEW_BYTES` of those bytes. */
  readonly raw?: Uint8Array | undefined
  /**
   * Decoded fields, when the writer recorded a map, made readable
   * (`displayFields`): a value with a shown form and a recorded one is a
   * `Displayed` record.
   */
  readonly fields?: Readonly<Record<string, unknown>> | undefined
  /**
   * The message value rendered as text, for a writer that recorded something
   * other than a map. Shown verbatim; the format requires such a value to
   * survive a read rather than be replaced with an empty one.
   */
  readonly opaque?: string | undefined
  /** The request id the message carries, in decimal. */
  readonly requestId?: string | undefined
  /** The same message's names in other drafts (ANNOUNCE for PUBLISH_NAMESPACE). */
  readonly aliases?: readonly string[] | undefined
  /** For a request: the response that answered it. */
  readonly response?: Exchange | undefined
  /** For a response: the request it answered. */
  readonly answers?: Exchange | undefined
  /** For a request: it went past the pending threshold without a response. */
  readonly pending?: { readonly waitedUs: number; readonly answered: boolean } | undefined
  /** For an error response: its code and the code's name in this draft. */
  readonly error?: ErrorInfo | undefined
  /**
   * The index of the request whose exchange this message belongs to: the
   * request itself, its response, and what followed under the same request.
   */
  readonly thread?: number | undefined
}

/** The other half of a request and its response. */
export interface Exchange {
  /** Index into `TraceAnalysis.messages`. */
  readonly index: number
  readonly name: string
  readonly requestId?: string | undefined
  /** Microseconds from request to response, when both carry a time. */
  readonly rttUs: number | null
}

export interface ErrorInfo {
  /** The code in decimal; `null` when the message carried none. */
  readonly code: string | null
  /** The code's name in the session's draft; `null` when that draft has none. */
  readonly codeName: string | null
  /** The code as shown: `TRACK_DOES_NOT_EXIST (0x4)`, `0x4, unknown for draft-14`. */
  readonly label: string
  readonly reason: string
}

/** Something wrong in the control messages, in time order. */
export interface ProblemRow {
  readonly kind: Problem<unknown>['kind']
  /** Microseconds from the session's start, when known. */
  readonly at: number | null
  /** The message it is about, as an index into `TraceAnalysis.messages`. */
  readonly index: number | null
  readonly title: string
  /** The request an error answers, or a pending request's track. */
  readonly detail: string | null
  readonly connection?: string | undefined
}

/** One connection in a trace that tags its events with one (`p`). */
export interface ConnectionRow {
  readonly id: string
  /** `Connection 1`, in the order they first appear. */
  readonly label: string
  readonly realm?: string | undefined
  readonly origin?: string | undefined
  readonly roles?: readonly string[] | undefined
  readonly protocol?: string | undefined
  readonly openedAt?: number | undefined
  readonly closedAt?: number | undefined
  /** How it closed: `closed`, `failed`, `worker-gone` or `session-end`. */
  readonly cause?: string | undefined
  readonly code?: number | undefined
  readonly reason?: string | undefined
}

/** One object seen on a stream, from its header, its payload, or both. */
export interface ObjectRow {
  readonly groupId: string
  readonly objectId: string
  /** Microseconds from the session's start, at the first event for this object. */
  readonly at: number
  readonly status?: number | undefined
  readonly priority?: number | undefined
  /** Declared payload size, when a payload event recorded one. */
  readonly size?: number | undefined
  /** The first PAYLOAD_PREVIEW_BYTES of the payload, on the first object of its stream that has one. */
  readonly payload?: Uint8Array | undefined
}

/** One QUIC stream (or datagram group) carrying objects, and what went over it. */
export interface StreamRow {
  readonly streamId: string
  /** Microseconds from the session's start, at the first event naming this stream. */
  readonly at: number
  readonly direction?: 0 | 1 | undefined
  /** `0` subgroup, `1` datagram, `2` fetch; absent when no open was recorded. */
  readonly streamType?: 0 | 1 | 2 | undefined
  readonly trackAlias?: string | undefined
  /** The track the stream carries, as `namespace / name`, when the control plane named it. */
  readonly track?: string | undefined
  readonly groupId?: string | undefined
  readonly subgroupId?: string | undefined
  readonly fetchRequestId?: string | undefined
  readonly peer?: string | undefined
  readonly closedAt?: number | undefined
  readonly closeCode?: number | undefined
  /** Distinct objects seen, which may exceed `objectRows.length`. */
  readonly objects: number
  /** Payload bytes, summed from the declared sizes. */
  readonly bytes: number
  /** The first `OBJECT_ROWS_PER_STREAM` objects, in the order they were seen. */
  readonly objectRows: readonly ObjectRow[]
}

/**
 * One track: as the control messages named it, keyed by namespace and name,
 * with what the rollups say about its delivery. A track the rollups report
 * and no recorded request named has no request fields.
 */
export interface TrackRow {
  /** Unique in the trace: the connection and the request, or the rollup lane. */
  readonly key: string
  /** `namespace / name`; empty when the request named neither. */
  readonly name: string
  readonly namespace: readonly string[]
  readonly trackName: string
  readonly alias?: string | undefined
  readonly connection?: string | undefined
  readonly requestId?: string | undefined
  readonly via?: TrackFields['via'] | undefined
  readonly status?: TrackFields['status'] | undefined
  /** Objects the recorder received on it. */
  readonly received?: DeliveryStats | undefined
  /** Objects the recorder sent on it. */
  readonly sent?: DeliveryStats | undefined
  /** The timeline lane of each direction, keyed as `Lane.key`. */
  readonly lanes: readonly string[]
  readonly errorReason?: string | undefined
  /** Microseconds from the session's start. */
  readonly requestedAt?: number | undefined
  /** When the request was accepted or refused. */
  readonly answeredAt?: number | undefined
  readonly endedAt?: number | undefined
}

export interface TraceAnalysis {
  readonly summary: SessionSummary
  readonly findings: readonly Finding[]
  readonly messages: readonly MessageRow[]
  readonly tracks: readonly TrackRow[]
  readonly streams: readonly StreamRow[]
  readonly problems: readonly ProblemRow[]
  /** Empty for a trace that does not tell its connections apart. */
  readonly connections: readonly ConnectionRow[]
  readonly delivery: Delivery
  /** Microseconds from the session's start to its last event. */
  readonly endUs: number
  /** How long a request waits for its response before it is marked. */
  readonly pendingMs: number
}

/** A request with no response this long after it was sent is marked, unless the parent says otherwise. */
export const DEFAULT_PENDING_MS = 5000

/**
 * How much of each byte string crosses from the worker to the page.
 *
 * A hex view is for reading a header or the start of a payload, and a capture
 * at `full` detail can hold gigabytes of media; carrying it all to the page to
 * show its first lines would double what a large file costs in memory.
 */
export const RAW_PREVIEW_BYTES = 4096
export const PAYLOAD_PREVIEW_BYTES = 512
export const OBJECT_ROWS_PER_STREAM = 500

// ----------------------------------------------------------- CBOR helpers ---

/** Render any recorded message value the format allows as one line of text. */
function opaqueText(message: unknown): string {
  if (typeof message === 'string') return message
  if (message instanceof Uint8Array) return displayBytes(message).text
  return JSON.stringify(plainValue(displayValue(message)))
}

/**
 * Read a key whether or not the reader has a typed field for it.
 *
 * Optional keys may be added to an existing event type without a format
 * version bump, and a reader that has not caught up hands those back verbatim
 * instead of on a named field. Looking in both places means a check reads the
 * same key out of a file whichever way the reader happened to deliver it.
 */
function loose(event: TraceEvent, key: string): unknown {
  const own = (event as unknown as Record<string, unknown>)[key]
  if (own !== undefined) return own
  const extra = (event as unknown as { extra?: Record<string, unknown> }).extra
  return extra?.[key]
}

// -------------------------------------------------------------- ordering ---

interface Placed {
  readonly segment: number
  readonly event: TraceEvent
}

/**
 * Every event across every segment, in the order the format defines.
 *
 * Sequence numbers are segment-local, so ordering is `(segment, seq)` and not
 * `seq` alone: on a segmented trace, sorting by `seq` interleaves segments
 * into an order that never happened.
 */
function ordered(segments: readonly Trace[]): Placed[] {
  const placed: Placed[] = []
  segments.forEach((segment, index) => {
    const sequence = segment.header.segment?.sequence ?? index
    for (const event of segment.events) placed.push({ segment: sequence, event })
  })
  return placed.sort((a, b) =>
    a.segment !== b.segment ? a.segment - b.segment : a.event.seq - b.event.seq,
  )
}

// ---------------------------------------------------------------- checks ---

const KNOWN_PERSPECTIVES = new Set(['client', 'server', 'observer', 'relay-tap'])
const KNOWN_DETAIL = new Set(['control', 'headers', 'headers+sizes', 'headers+data', 'full'])

/**
 * The draft that gave each request its own control stream.
 *
 * From here a response carries no request id, so the stream it arrived on is
 * the only thing tying it to its request, and a recording that omits the
 * stream cannot pair them at all.
 */
const STREAM_PER_REQUEST_FROM = 17

/** Datagram streams declare this in the stream type field. */
const STREAM_TYPE_DATAGRAM = 1

interface CheckInput {
  readonly header: TraceHeader
  readonly events: readonly Placed[]
  readonly messages: readonly MessageRow[]
  readonly summary: SessionSummary
  readonly defs: readonly MessageDef[]
  readonly draft: number | null
  readonly truncatedAt?: number | undefined
  readonly problems: readonly ProblemRow[]
}

function check(input: CheckInput): Finding[] {
  const { header, events, messages, summary, defs, draft, truncatedAt } = input
  const found: Finding[] = []
  const add = (id: string, severity: Severity, title: string, detail: string) =>
    found.push({ id, severity, title, detail })

  if (truncatedAt !== undefined) {
    add(
      'truncated',
      'error',
      'The file is cut short',
      `Decoding stopped at byte ${truncatedAt}, where an item begins that the file does not finish. Everything above was read normally and is as good as it ever was.`,
    )
  }

  if (summary.formatVersion === 1) {
    add(
      'format-v1',
      'note',
      'Format version 1',
      'A single-shot file with no segmentation, so a damaged region ends the read rather than costing one segment.',
    )
  }

  if (!KNOWN_PERSPECTIVES.has(header.perspective)) {
    add('unknown-perspective', 'note', `Unknown perspective "${header.perspective}"`, '')
  }
  if (!KNOWN_DETAIL.has(header.detail)) {
    add('unknown-detail', 'note', `Unknown detail level "${header.detail}"`, '')
  }

  if (draft === null) {
    add(
      'unknown-draft',
      'note',
      `No draft for protocol "${header.protocol}"`,
      'Control messages are shown by wire ID only. Naming them would mean picking a draft, and the wrong draft gives confidently wrong names.',
    )
  }

  if (header.sampling !== undefined) {
    const s = header.sampling
    const parts = [
      s.effectiveRate !== undefined
        ? `${(s.effectiveRate * 100).toFixed(1)}% of events kept`
        : null,
      s.droppedTotal !== undefined ? `${s.droppedTotal} dropped in total` : null,
      s.dropPolicy !== undefined ? `policy "${s.dropPolicy}"` : null,
      s.rule !== undefined ? `rule "${s.rule}"` : null,
    ].filter((p): p is string => p !== null)
    add(
      'sampling',
      'warning',
      'The recorder dropped events',
      `This trace says so itself${parts.length > 0 ? `: ${parts.join(', ')}` : ''}. Counts below are of what survived, so an absent message may never have been sent or may simply not have been kept.`,
    )
  }

  if (header.custom?.payloadMasked === true) {
    add(
      'payload-masked',
      'note',
      'Payload bytes are masked',
      'The recorder zeroed object payloads. Sizes are still real, so volume and timing hold; the content does not.',
    )
  }

  const unknownTypes = Object.entries(summary.unknownEventTypes)
  if (unknownTypes.length > 0) {
    add(
      'unknown-events',
      'note',
      `${unknownTypes.length} unknown event type${unknownTypes.length === 1 ? '' : 's'}`,
      unknownTypes.map(([type, n]) => `type ${type} (${n})`).join(', '),
    )
  }

  const errors = events.map((p) => p.event).filter((e): e is TraceErrorEvent => e.type === 'error')
  if (errors.length > 0) {
    const reasons = [...new Set(errors.map((e) => e.reason).filter((r) => r.length > 0))]
    add(
      'errors',
      'error',
      `${errors.length} error event${errors.length === 1 ? '' : 's'}`,
      reasons.slice(0, 3).join(' · '),
    )
  }

  // Error evidence: the recorder kept the bytes that would not parse. That is
  // the single most useful thing in a trace when one is present, so it is
  // called out on its own rather than folded into the error count above.
  const withRaw = errors.filter((e) => loose(e, 'raw') !== undefined)
  const withLength = errors.filter((e) => typeof loose(e, 'rawLength') === 'number')
  if (withRaw.length > 0 || withLength.length > 0) {
    add(
      'error-evidence',
      'warning',
      'An error carries the bytes behind it',
      `${withRaw.length > 0 ? `${withRaw.length} error event${withRaw.length === 1 ? '' : 's'} kept the offending bytes` : `${withLength.length} error event${withLength.length === 1 ? '' : 's'} recorded how many bytes were behind the failure`}. This is what a decode failure has to be diagnosed from.`,
    )
  }

  const goaways = input.problems.filter((p) => p.kind === 'goaway')
  if (goaways.length > 0) {
    const at = (p: ProblemRow) => (p.at === null ? null : `at ${offset(p.at)}`)
    const [first, ...more] = goaways
    const detail = [at(first!), ...more.map((p) => [p.title, at(p)].filter(Boolean).join(' '))]
    add('goaway', 'warning', first!.title, detail.filter(Boolean).join(' · '))
  }

  found.push(...problemFindings(input.problems))
  found.push(...unpairable(messages, draft))

  // Said once here rather than under each message it applies to. It is a fact
  // about the recorder, not about any one message, and repeating it down a log
  // of two hundred messages buries everything that is specific to one of them.
  const opaque = messages.filter((m) => m.opaque !== undefined).length
  if (opaque > 0) {
    add(
      'opaque-messages',
      'note',
      `${opaque} control message${opaque === 1 ? ' was' : 's were'} recorded as one opaque value`,
      'The recorder wrote a rendering of each message instead of a map of decoded fields, so there is nothing in them to address by name: no request id, no track. They are shown exactly as recorded, and checks that need a field cannot run on them.',
    )
  }

  found.push(...draftAgreementChecks(defs, messages, draft))

  if (messages.length > 0 && draft !== null && draft >= STREAM_PER_REQUEST_FROM) {
    const missing = messages.filter((m) => m.streamId === undefined).length
    if (missing > 0) {
      add(
        'no-control-stream-id',
        'warning',
        `${missing} control message${missing === 1 ? ' has' : 's have'} no stream id`,
        `From ${draftLabel(STREAM_PER_REQUEST_FROM)} each request gets its own control stream and responses carry no request id, so without the stream a response cannot be tied to its request.`,
      )
    }
  }

  const datagramStreams = events
    .map((p) => p.event)
    .filter((e): e is StreamOpenedEvent => e.type === 'stream-opened')
    .filter((e) => e.streamType === STREAM_TYPE_DATAGRAM)
  const unidentified = datagramStreams.filter((e) => e.trackAlias === undefined)
  if (unidentified.length > 0) {
    add(
      'datagram-track-unknown',
      'warning',
      `${unidentified.length} datagram group${unidentified.length === 1 ? '' : 's'} with no track`,
      '',
    )
  }

  if (events.length >= 2 && events.every((p) => p.event.timestamp === 0)) {
    add(
      'degenerate-timestamps',
      'warning',
      'Every event is stamped at zero',
      'The recorder did not stamp events, so ordering is by sequence number only and no timing can be read from this trace, including durations that would otherwise look like zero.',
    )
  }

  const headerExtra = header.extra
  if (headerExtra !== undefined && Object.keys(headerExtra).length > 0) {
    add(
      'header-extra',
      'note',
      `${Object.keys(headerExtra).length} unknown header key${Object.keys(headerExtra).length === 1 ? '' : 's'}`,
      Object.keys(headerExtra).join(', '),
    )
  }

  return found
}

/**
 * Whether the messages in the file are ones the draft it claims actually has.
 *
 * A recorder writes the protocol string from its own configuration and the
 * message IDs from the wire, so the two can disagree, and when they do, every
 * name on this page is drawn from the wrong registry. That is worth saying
 * loudly, because a wrong name is read as a fact and sends someone looking for
 * a bug in the wrong message entirely.
 */
function draftAgreementChecks(
  defs: readonly MessageDef[],
  messages: readonly MessageRow[],
  draft: number | null,
): Finding[] {
  if (draft === null || messages.length === 0) return []

  const hex = (id: number) => `0x${id.toString(16)}`
  const findings: Finding[] = []

  const undefinedIds = [
    ...new Set(
      messages
        .filter((m) => m.name === null && !m.reserved)
        .map((m) => m.messageType)
        .filter((id): id is number => id !== null),
    ),
  ]
  if (undefinedIds.length > 0) {
    findings.push({
      id: 'message-id-undefined',
      severity: 'warning',
      title: `Not defined in ${draftLabel(draft)}: ${undefinedIds.map(hex).join(', ')}`,
      detail: '',
    })
  }

  const reservedIds = [
    ...new Set(
      messages
        .filter((m) => m.reserved)
        .map((m) => m.messageType)
        .filter((id): id is number => id !== null),
    ),
  ]
  if (reservedIds.length > 0) {
    const notes = reservedIds
      .map((id) => {
        const def = defs.find((d) => d.value === id)
        return def?.note === null || def?.note === undefined ? hex(id) : `${hex(id)} (${def.note})`
      })
      .join(', ')
    findings.push({
      id: 'message-id-reserved',
      severity: 'note',
      title: `${reservedIds.length === 1 ? 'A message uses' : 'Messages use'} a code point ${draftLabel(draft)} reserved`,
      detail: `${notes}. ${draftLabel(draft)} assigns no message here, so the sender is using an ID from an older revision or one of its own.`,
    })
  }

  return findings
}

/** Problems said on the overview, at most this many before the rest are counted. */
const PROBLEM_FINDINGS = 20

/**
 * The control-message problems as findings. GOAWAY has its own finding, and
 * undecodable bytes are counted with the other error events.
 */
function problemFindings(rows: readonly ProblemRow[]): Finding[] {
  const listed = rows.filter((p) => p.kind !== 'goaway' && p.kind !== 'undecodable')
  const findings: Finding[] = listed.slice(0, PROBLEM_FINDINGS).map((p) => ({
    id: p.kind === 'error' ? 'error-response' : p.kind === 'pending' ? 'request-pending' : p.kind,
    severity: problemSeverity(p.kind),
    title: p.title,
    detail: [p.detail, p.at === null ? null : `At ${offset(p.at)}`]
      .filter((part): part is string => part !== null)
      .join(' · '),
  }))
  const more = listed.length - PROBLEM_FINDINGS
  if (more > 0) {
    findings.push({
      id: 'more-problems',
      severity: 'note',
      title: `${more} more problem${more === 1 ? '' : 's'}`,
      detail: '',
    })
  }
  return findings
}

/**
 * Requests that went unanswered and carry nothing a response could be matched
 * by. Before draft-17 a response names its request in its fields, so a request
 * recorded without any is not one this trace can pair, and is said to be so
 * rather than left looking answered. From draft-17 the stream pairs them, and
 * `no-control-stream-id` covers a recording without one.
 */
function unpairable(messages: readonly MessageRow[], draft: number | null): Finding[] {
  if (draft !== null && draft >= STREAM_PER_REQUEST_FROM) return []
  const bare = messages.filter(
    (m, i) =>
      m.thread === i &&
      m.response === undefined &&
      (m.fields === undefined || Object.keys(m.fields).length === 0),
  )
  if (bare.length === 0) return []
  return [
    {
      id: 'requests-unpairable',
      severity: 'note',
      title: `${bare.length} request${bare.length === 1 ? '' : 's'} with no fields to match a response by`,
      detail: [...new Set(bare.map((m) => m.name ?? hexId(m.messageType ?? 0)))].join(', '),
    },
  ]
}

// -------------------------------------------------------------- analysis ---

export interface AnalyzeInput {
  readonly segments: readonly Trace[]
  readonly formatVersion: number
  readonly tables: MessageTables
  /** Byte offset the file was cut at, when the read ended early. */
  readonly truncatedAt?: number
  /** How long a request waits for its response before it is marked; 5 s when not given. */
  readonly pendingMs?: number
}

/** One connection's tracks, kept apart because aliases and request ids are per connection. */
interface ConnectionTracks {
  readonly tracks: Map<string, TrackFields>
  readonly registry: TrackRegistry<TrackFields>
}

export function analyze(input: AnalyzeInput): TraceAnalysis {
  const { segments, formatVersion, tables, truncatedAt } = input
  const pendingMs = input.pendingMs ?? DEFAULT_PENDING_MS
  const header = segments[0]!.header
  const events = ordered(segments)

  const draft = draftOf(header.protocol, tables)
  const defs: readonly MessageDef[] = draft === null ? [] : (tables[draft] ?? [])
  const names = byId(defs)

  const since = sessionClock(header, segments)
  const byConnection = new Map<string, ConnectionTracks>()
  const tracksOn = (peer: string | undefined): ConnectionTracks => {
    const key = peer ?? ''
    let found = byConnection.get(key)
    if (found === undefined) {
      const tracks = new Map<string, TrackFields>()
      found = { tracks, registry: new TrackRegistry(tracks, (fields) => fields) }
      byConnection.set(key, found)
    }
    return found
  }

  const dataStreams = dataStreamIds(events)
  const setup: SetupFacts = {}
  const rows: MessageRow[] = []
  let endUs = 0
  for (const { segment, event } of events) {
    endUs = Math.max(endUs, since(segment, event.timestamp))
    if (event.type === 'control') {
      rows.push(
        row(segment, event as ControlMessageEvent, {
          names,
          since,
          registry: tracksOn(event.peer).registry,
          setup,
          perspective: header.perspective,
          draft,
        }),
      )
    } else if (event.type === 'error') {
      const error = event as TraceErrorEvent
      // A decode failure on a data stream is a broken object, not a control
      // message; only the ones on a control stream sit in the message log.
      const onData = error.streamId !== undefined && dataStreams.has(error.streamId.toString())
      if (error.errorKind === 'decode' && !onData) rows.push(undecodableRow(segment, error, since))
    }
  }
  const { messages, problems: problemRows } = link(rows, {
    draft,
    pendingMs,
    endUs,
    perspective: header.perspective,
  })

  const summary = {
    ...summarize(header, segments, events, formatVersion, draft),
    ...sessionFacts(events, setup, draft),
  }
  const streams = streamRows(events, since).map((stream) => {
    const { tracks, registry } = tracksOn(stream.peer)
    const track =
      stream.fetchRequestId !== undefined
        ? tracks.get(stream.fetchRequestId)
        : stream.trackAlias !== undefined
          ? registry.byAlias(stream.trackAlias)
          : undefined
    const name = track === undefined ? '' : trackDisplayName(track)
    return name.length === 0 ? stream : { ...stream, track: name }
  })

  const annotations: PlacedAnnotation[] = events
    .filter((p) => p.event.type === 'annotation')
    .map(({ segment, event }) => ({
      segment,
      at: since(segment, event.timestamp),
      event: event as AnnotationEvent,
    }))
  const delivered = delivery(annotations, (event) => event.peer ?? '')
  const findings = check({
    header,
    events,
    messages,
    summary,
    defs,
    draft,
    truncatedAt,
    problems: problemRows,
  })
  return {
    summary,
    findings,
    messages,
    tracks: trackRows(byConnection, delivered),
    streams,
    problems: problemRows,
    connections: connectionRows(events, since),
    delivery: delivered,
    endUs,
    pendingMs,
  }
}

/** Streams that carried objects, whose errors are about objects rather than control messages. */
function dataStreamIds(events: readonly Placed[]): Set<string> {
  const ids = new Set<string>()
  for (const { event } of events) {
    if (
      event.type === 'stream-opened' ||
      event.type === 'stream-closed' ||
      event.type === 'object-header' ||
      event.type === 'object-payload'
    ) {
      ids.add((event as unknown as { streamId: bigint }).streamId.toString())
    }
  }
  return ids
}

function undecodableRow(segment: number, event: TraceErrorEvent, since: Clock): MessageRow {
  const raw = loose(event, 'raw')
  const bytes = raw instanceof Uint8Array ? raw : undefined
  const length = loose(event, 'rawLength')
  return {
    segment,
    seq: event.seq,
    timestamp: event.timestamp,
    at: since(segment, event.timestamp),
    // The format records no direction for an error, and none is guessed.
    direction: null,
    messageType: null,
    undecodable: event.reason,
    name: null,
    reserved: false,
    note: null,
    section: null,
    specPath: null,
    peer: event.peer,
    streamId: event.streamId?.toString(),
    size: typeof length === 'number' ? length : bytes?.length,
    raw: preview(bytes, RAW_PREVIEW_BYTES),
  }
}

interface LinkContext {
  readonly draft: number | null
  readonly pendingMs: number
  readonly endUs: number
  readonly perspective: string
}

type RowLinks = {
  -readonly [K in 'response' | 'answers' | 'pending' | 'error' | 'thread']?: MessageRow[K]
}

/** Messages that name a limit rather than a request, though they carry a request id field. */
const LIMIT_MESSAGES = new Set(['MAX_REQUEST_ID', 'MAX_SUBSCRIBE_ID'])

/**
 * Requests joined to their responses, and the problems the messages show,
 * from `@moqtap/inspect`. Each row learns the other half of its exchange, its
 * error code's name, whether it went unanswered past the threshold, and which
 * request's exchange it belongs to.
 */
function link(
  rows: readonly MessageRow[],
  ctx: LinkContext,
): { messages: MessageRow[]; problems: ProblemRow[] } {
  const inspected: InspectEvent[] = rows.map((r): InspectEvent => {
    const common = {
      direction: r.direction ?? undefined,
      streamId: r.streamId,
      atMs: r.at / 1000,
      connection: r.peer,
    }
    return r.undecodable !== undefined
      ? { kind: 'undecodable', reason: r.undecodable, ...common }
      : ({ name: r.name, fields: r.fields, ...common } satisfies ControlEvent)
  })
  const indexOf = new Map(inspected.map((event, i) => [event, i]))
  const links: RowLinks[] = rows.map(() => ({}))
  const exchange = (i: number, rttMs: number | null): Exchange => ({
    index: i,
    name: rows[i]!.name ?? hexId(rows[i]!.messageType ?? 0),
    ...(rows[i]!.requestId === undefined ? {} : { requestId: rows[i]!.requestId }),
    rttUs: rttMs === null ? null : Math.round(rttMs * 1000),
  })

  const threads = new Map<string, number>()
  const draft17 = ctx.draft !== null && ctx.draft >= STREAM_PER_REQUEST_FROM
  for (const pair of pairRequests(inspected, { draft: ctx.draft })) {
    const request = indexOf.get(pair.request)!
    links[request]!.thread = request
    const { requestId, peer, streamId } = rows[request]!
    if (requestId !== undefined) threads.set(`${peer ?? ''}|id:${requestId}`, request)
    if (draft17 && streamId !== undefined) threads.set(`${peer ?? ''}|s:${streamId}`, request)
    if (pair.response === null) continue
    const response = indexOf.get(pair.response)!
    links[request]!.response = exchange(response, pair.rttMs)
    links[response]!.answers = exchange(request, pair.rttMs)
    links[response]!.thread = request
  }
  rows.forEach((r, i) => {
    if (links[i]!.thread !== undefined || r.name === null || LIMIT_MESSAGES.has(r.name)) return
    const conn = r.peer ?? ''
    const byId = r.requestId === undefined ? undefined : threads.get(`${conn}|id:${r.requestId}`)
    const byStream =
      draft17 && r.streamId !== undefined ? threads.get(`${conn}|s:${r.streamId}`) : undefined
    const thread = byId ?? byStream
    if (thread !== undefined && thread < i) links[i]!.thread = thread
  })

  const wording = {
    pendingMs: ctx.pendingMs,
    draft: ctx.draft,
    perspective: ctx.perspective,
    trackOf: (event: InspectEvent) => {
      const i = indexOf.get(event)
      return i === undefined ? undefined : rows[i]!.track
    },
  }
  const found: ProblemRow[] = []
  for (const problem of problems(inspected, {
    pendingMs: ctx.pendingMs,
    draft: ctx.draft,
    endMs: ctx.endUs / 1000,
  })) {
    const index = indexOf.get(problem.event) ?? null
    const at = problem.atMs === null ? null : Math.round(problem.atMs * 1000)
    const message = index === null ? undefined : rows[index]
    if (index !== null && problem.kind === 'error') {
      links[index]!.error = {
        code: problem.code,
        codeName: problem.codeName,
        label: codeLabel(problem.code, problem.codeName, ctx.draft),
        reason: problem.reason,
      }
    }
    if (index !== null && problem.kind === 'pending') {
      links[index]!.pending = {
        waitedUs: Math.round(problem.waitedMs * 1000),
        answered: problem.response !== null,
      }
    }
    found.push({
      kind: problem.kind,
      at,
      index,
      title: problemTitle(problem, wording),
      detail: problemDetail(problem, wording),
      ...(message?.peer === undefined ? {} : { connection: message.peer }),
    })
  }

  const messages = rows.map((r, i) => {
    const own = links[i]!
    return Object.keys(own).length === 0 ? r : { ...r, ...own }
  })
  return { messages, problems: found }
}

interface ConnectionBuilder {
  id: string
  label: string
  realm?: string
  origin?: string
  roles?: string[]
  protocol?: string
  openedAt?: number
  closedAt?: number
  cause?: string
  code?: number
  reason?: string
}

/**
 * The connections a trace tells apart by its events' `p`, in the order each
 * first appears, with what the collector said about each one.
 */
function connectionRows(events: readonly Placed[], since: Clock): ConnectionRow[] {
  const rows = new Map<string, ConnectionBuilder>()
  for (const { segment, event } of events) {
    if (event.peer === undefined) continue
    let row = rows.get(event.peer)
    if (row === undefined) {
      row = { id: event.peer, label: `Connection ${rows.size + 1}` }
      rows.set(event.peer, row)
    }
    const at = since(segment, event.timestamp)
    if (event.type === 'peer-connected') row.openedAt ??= at
    if (event.type === 'peer-disconnected') {
      const closed = event as PeerDisconnectedEvent
      row.closedAt ??= at
      if (closed.errorCode !== 0) row.code ??= closed.errorCode
      if (closed.reason !== undefined) row.reason ??= closed.reason
    }
    if (event.type !== 'annotation') continue
    const { label, data } = event as AnnotationEvent
    if (data === null || typeof data !== 'object') continue
    const d = data as Record<string, unknown>
    if (label === 'collector.conn-open') {
      // Re-sent as the collector learns more; the later word wins.
      if (typeof d.realm === 'string') row.realm = d.realm
      if (typeof d.origin === 'string') row.origin = d.origin
      if (typeof d.protocol === 'string') row.protocol = d.protocol
      if (Array.isArray(d.roles)) row.roles = d.roles.filter((r) => typeof r === 'string')
    } else if (label === 'collector.conn-close') {
      if (typeof d.cause === 'string') row.cause = d.cause
      if (typeof d.code === 'number') row.code = d.code
      if (typeof d.reason === 'string') row.reason = d.reason
      row.closedAt ??= at
    }
  }
  return [...rows.values()]
}

/**
 * Each connection's tracks with their delivery joined on, then any track the
 * rollups report that no recorded request named.
 */
function trackRows(
  byConnection: ReadonlyMap<string, ConnectionTracks>,
  delivered: Delivery,
): TrackRow[] {
  const stats = new Map(delivered.lanes.map((lane) => [lane.key, lane.stats]))
  const claimed = new Set<string>()
  const rows: TrackRow[] = []
  for (const [connection, { tracks, registry }] of byConnection) {
    for (const track of tracks.values()) {
      const kind = track.via === 'fetch' ? 'fetch' : 'alias'
      const id = track.via === 'fetch' ? track.subscribeId : track.trackAlias
      // An alias reused by a later request carries that request's objects.
      const owns = id !== undefined && (kind === 'fetch' || registry.byAlias(id) === track)
      const rx = owns ? laneKey(connection, 'rx', kind, id) : null
      const tx = owns ? laneKey(connection, 'tx', kind, id) : null
      const received = rx === null ? undefined : stats.get(rx)
      const sent = tx === null ? undefined : stats.get(tx)
      const lanes: string[] = []
      if (received !== undefined && rx !== null) lanes.push(rx)
      if (sent !== undefined && tx !== null) lanes.push(tx)
      for (const lane of lanes) claimed.add(lane)
      rows.push({
        key: `${connection}|${track.subscribeId}`,
        name: trackDisplayName(track),
        namespace: track.trackNamespace,
        trackName: track.trackName,
        alias: track.trackAlias,
        ...(connection === '' ? {} : { connection }),
        requestId: track.subscribeId,
        via: track.via,
        status: track.status,
        ...(received === undefined ? {} : { received }),
        ...(sent === undefined ? {} : { sent }),
        lanes,
        errorReason: track.errorReason,
        requestedAt: track.subscribedAt,
        answeredAt: track.subscribeOkAt ?? track.subscribeErrorAt,
        endedAt: track.subscribeDoneAt,
      })
    }
  }
  for (const lane of delivered.lanes) {
    if (claimed.has(lane.key)) continue
    const { stats: s } = lane
    rows.push({
      key: lane.key,
      name: '',
      namespace: [],
      trackName: '',
      ...(s.kind === 'alias' ? { alias: s.id } : { requestId: s.id }),
      ...(lane.connection === '' ? {} : { connection: lane.connection }),
      ...(s.direction === 'rx' ? { received: s } : { sent: s }),
      lanes: [lane.key],
    })
  }
  return rows
}

/** What the setup messages said, gathered while the rows are built. */
interface SetupFacts {
  clientImplementation?: string
  relayImplementation?: string
  /** The draft SERVER_SETUP selected, as `draft-NN`. */
  selectedVersion?: string
}

/**
 * The annotation labels a collector notes its connection's negotiated
 * protocol under: the session's setup, or a connection's opening.
 */
const PROTOCOL_ANNOTATIONS = new Set(['collector.setup', 'collector.conn-open'])

function negotiatedProtocolOf(events: readonly Placed[]): string | undefined {
  for (const { event } of events) {
    if (event.type !== 'annotation') continue
    const { label, data } = event as AnnotationEvent
    if (!PROTOCOL_ANNOTATIONS.has(label) || data === null || typeof data !== 'object') continue
    const protocol = (data as Record<string, unknown>).protocol
    if (typeof protocol === 'string' && protocol.length > 0) return protocol
  }
  return undefined
}

function sessionFacts(
  events: readonly Placed[],
  setup: SetupFacts,
  draft: number | null,
): Pick<
  SessionSummary,
  'negotiatedProtocol' | 'draftFrom' | 'clientImplementation' | 'relayImplementation'
> {
  const negotiatedProtocol = negotiatedProtocolOf(events)
  const draftFrom =
    draft === null
      ? undefined
      : negotiatedProtocol !== undefined && draftOfProtocol(negotiatedProtocol) === draft
        ? 'negotiated-protocol'
        : setup.selectedVersion === draftLabel(draft)
          ? 'setup-version'
          : undefined
  return {
    ...(negotiatedProtocol === undefined ? {} : { negotiatedProtocol }),
    ...(draftFrom === undefined ? {} : { draftFrom }),
    ...(setup.clientImplementation === undefined
      ? {}
      : { clientImplementation: setup.clientImplementation }),
    ...(setup.relayImplementation === undefined
      ? {}
      : { relayImplementation: setup.relayImplementation }),
  }
}

type Clock = (segment: number, timestamp: number) => number

/**
 * Microseconds from the session's start for an event in a given segment.
 *
 * Each segment stamps its events from its own start time, so offsets from two
 * segments cannot share one column until both are moved onto the first
 * segment's clock.
 */
function sessionClock(header: TraceHeader, segments: readonly Trace[]): Clock {
  const startOf = new Map<number, number>()
  segments.forEach((segment, index) => {
    startOf.set(segment.header.segment?.sequence ?? index, segment.header.startTime)
  })
  return (segment, timestamp) =>
    ((startOf.get(segment) ?? header.startTime) - header.startTime) * 1000 + timestamp
}

function preview(bytes: Uint8Array | undefined, limit: number): Uint8Array | undefined {
  if (bytes === undefined) return undefined
  // A copy, not a view: a view would carry its whole underlying buffer across
  // to the page with it.
  return bytes.slice(0, limit)
}

interface StreamBuilder {
  streamId: string
  at: number
  direction?: 0 | 1
  streamType?: 0 | 1 | 2
  trackAlias?: string
  groupId?: string
  subgroupId?: string
  fetchRequestId?: string
  peer?: string
  closedAt?: number
  closeCode?: number
  bytes: number
  objects: Map<string, ObjectRow>
  /**
   * Whether an object on this stream already carries a payload preview. One
   * per stream: a stream of thousands of objects would otherwise carry
   * thousands of previews to the page, and the first shows what the stream
   * carries.
   */
  previewed?: boolean
}

/** Streams and the objects on them, in the order each stream was first seen. */
function streamRows(events: readonly Placed[], since: Clock): StreamRow[] {
  const streams = new Map<string, StreamBuilder>()
  const streamFor = (id: bigint, at: number, peer: string | undefined): StreamBuilder => {
    const key = id.toString()
    let stream = streams.get(key)
    if (stream === undefined) {
      stream = { streamId: key, at, bytes: 0, objects: new Map() }
      if (peer !== undefined) stream.peer = peer
      streams.set(key, stream)
    }
    return stream
  }
  const objectIn = (stream: StreamBuilder, groupId: bigint, objectId: bigint, at: number) => {
    const key = `${groupId}/${objectId}`
    const row = stream.objects.get(key) ?? {
      groupId: groupId.toString(),
      objectId: objectId.toString(),
      at,
    }
    return { key, row }
  }

  for (const { segment, event } of events) {
    const at = since(segment, event.timestamp)
    switch (event.type) {
      case 'stream-opened': {
        const opened = event as StreamOpenedEvent
        const stream = streamFor(opened.streamId, at, opened.peer)
        stream.direction = opened.direction
        stream.streamType = opened.streamType
        if (opened.trackAlias !== undefined) stream.trackAlias = opened.trackAlias.toString()
        if (opened.groupId !== undefined) stream.groupId = opened.groupId.toString()
        if (opened.subgroupId !== undefined) stream.subgroupId = opened.subgroupId.toString()
        if (opened.fetchRequestId !== undefined) {
          stream.fetchRequestId = opened.fetchRequestId.toString()
        }
        break
      }
      case 'stream-closed': {
        const closed = event as StreamClosedEvent
        const stream = streamFor(closed.streamId, at, closed.peer)
        stream.closedAt = at
        stream.closeCode = closed.errorCode
        break
      }
      case 'object-header': {
        const header = event as ObjectHeaderEvent
        const stream = streamFor(header.streamId, at, header.peer)
        const { key, row } = objectIn(stream, header.groupId, header.objectId, at)
        stream.objects.set(key, {
          ...row,
          status: header.objectStatus,
          priority: header.publisherPriority,
        })
        break
      }
      case 'object-payload': {
        const payload = event as ObjectPayloadEvent
        const stream = streamFor(payload.streamId, at, payload.peer)
        const { key, row } = objectIn(stream, payload.groupId, payload.objectId, at)
        stream.bytes += payload.size
        const kept =
          row.payload ??
          (stream.previewed ? undefined : preview(payload.payload, PAYLOAD_PREVIEW_BYTES))
        if (kept !== undefined) stream.previewed = true
        stream.objects.set(key, {
          ...row,
          size: (row.size ?? 0) + payload.size,
          ...(kept === undefined ? {} : { payload: kept }),
        })
        break
      }
      default:
        break
    }
  }

  return [...streams.values()].map(({ objects, previewed: _previewed, ...stream }) => ({
    ...stream,
    objects: objects.size,
    objectRows: [...objects.values()].slice(0, OBJECT_ROWS_PER_STREAM),
  }))
}

function summarize(
  header: TraceHeader,
  segments: readonly Trace[],
  events: readonly Placed[],
  formatVersion: number,
  draft: number | null,
): SessionSummary {
  const eventCounts: Record<string, number> = {}
  const unknownEventTypes: Record<number, number> = {}
  const peers = new Set<string>()
  const streams = new Set<string>()
  const tracks = new Set<string>()
  let objects = 0
  let payloadBytes = 0

  // Absolute microseconds, so a segmented trace whose segments start at
  // different wall times yields one span rather than per-segment spans laid on
  // top of each other.
  let first = Number.POSITIVE_INFINITY
  let last = Number.NEGATIVE_INFINITY

  const startOf = new Map<number, number>()
  segments.forEach((segment, index) => {
    startOf.set(segment.header.segment?.sequence ?? index, segment.header.startTime)
  })

  for (const { segment, event } of events) {
    eventCounts[event.type] = (eventCounts[event.type] ?? 0) + 1
    if (event.peer !== undefined) peers.add(event.peer)

    const at = (startOf.get(segment) ?? header.startTime) * 1000 + event.timestamp
    if (at < first) first = at
    if (at > last) last = at

    switch (event.type) {
      case 'unknown': {
        const { eventType } = event as UnknownEvent
        unknownEventTypes[eventType] = (unknownEventTypes[eventType] ?? 0) + 1
        break
      }
      case 'stream-opened': {
        const opened = event as StreamOpenedEvent
        streams.add(opened.streamId.toString())
        if (opened.trackAlias !== undefined) tracks.add(opened.trackAlias.toString())
        break
      }
      case 'stream-closed':
      case 'object-header':
        streams.add((event as unknown as { streamId: bigint }).streamId.toString())
        break
      case 'object-payload': {
        const payload = event as ObjectPayloadEvent
        streams.add(payload.streamId.toString())
        objects += 1
        payloadBytes += payload.size
        break
      }
      default:
        break
    }
  }

  const spanUs = last - first

  return {
    formatVersion,
    segments: segments.length,
    protocol: header.protocol,
    draft,
    perspective: header.perspective,
    detail: header.detail,
    transport: header.transport,
    source: header.source,
    endpoint: header.endpoint,
    sessionId: header.sessionId,
    startTime: header.startTime,
    endTime: header.endTime,
    durationUs: events.length > 0 && spanUs > 0 ? spanUs : undefined,
    eventCounts,
    unknownEventTypes,
    peers: [...peers].sort(),
    streams: streams.size,
    tracks: [...tracks].sort((a, b) => Number(a) - Number(b)),
    objects,
    payloadBytes,
  }
}

interface RowContext {
  readonly names: ReadonlyMap<number, MessageDef>
  readonly since: Clock
  readonly registry: TrackRegistry<TrackFields>
  readonly setup: SetupFacts
  readonly perspective: string
  readonly draft: number | null
}

function row(segment: number, event: ControlMessageEvent, ctx: RowContext): MessageRow {
  const def = ctx.names.get(event.messageType)
  const fields = controlMessageFields(event.message)
  const named = def !== undefined && !def.reserved
  const name = named ? def.name : null
  const at = ctx.since(segment, event.timestamp)
  const kind = fields === undefined ? null : messageKind(name, fields)

  let track: string | undefined
  if (fields !== undefined && kind !== null) {
    const touched = ctx.registry.apply(kind, fields, {
      direction: event.direction === 0 ? 'tx' : 'rx',
      streamId: event.streamId,
      timestamp: at,
    })
    const shown = touched === null ? '' : trackDisplayName(touched)
    if (shown.length > 0) track = shown
    noteSetup(ctx, kind, fields, event.direction)
  }

  const shown = fields === undefined ? undefined : displayFields(name, fields)
  const requestId = requestIdOf(name, shown) ?? undefined
  const aliases = name === null ? [] : messageAliases(name, ctx.draft)
  return {
    segment,
    seq: event.seq,
    timestamp: event.timestamp,
    at,
    direction: event.direction,
    messageType: event.messageType,
    name,
    reserved: def?.reserved ?? false,
    note: def?.note ?? null,
    section: named ? def.section : null,
    specPath: def?.specPath ?? null,
    peer: event.peer,
    streamId: event.streamId?.toString(),
    track,
    size: event.raw?.length,
    raw: preview(event.raw, RAW_PREVIEW_BYTES),
    fields: shown,
    opaque:
      fields === undefined && event.message !== undefined && event.message !== null
        ? opaqueText(event.message)
        : undefined,
    ...(requestId === undefined ? {} : { requestId }),
    ...(aliases.length === 0 ? {} : { aliases }),
  }
}

/** Keep what a setup message says about the two ends: the first word of each wins. */
function noteSetup(
  ctx: RowContext,
  kind: string,
  fields: Record<string, unknown>,
  direction: 0 | 1,
) {
  // Which end sent a unified SETUP follows from which end recorded it.
  const sentByClient =
    ctx.perspective === 'client'
      ? direction === 0
      : ctx.perspective === 'server'
        ? direction === 1
        : undefined
  const named = setupImplementation(kind, fields, sentByClient)
  if (named?.side === 'client') ctx.setup.clientImplementation ??= named.implementation
  if (named?.side === 'server') ctx.setup.relayImplementation ??= named.implementation
  const selected = kind === 'server_setup' ? setupVersionLabel(fields.selected_version) : null
  if (selected !== null) ctx.setup.selectedVersion ??= selected
}
