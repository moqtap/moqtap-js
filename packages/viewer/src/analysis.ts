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

import type {
  ControlMessageEvent,
  ObjectHeaderEvent,
  ObjectPayloadEvent,
  StreamClosedEvent,
  StreamOpenedEvent,
  Trace,
  TraceErrorEvent,
  TraceEvent,
  TraceHeader,
  UnknownEvent,
} from '@moqtap/trace'

import { byId, draftOf, idsNamed, type MessageDef, type MessageTables } from './drafts'
import { draftLabel } from './format'

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
  readonly direction: 0 | 1
  readonly messageType: number
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
  /** Length of the message's encoded bytes, when the recorder kept them. */
  readonly size?: number | undefined
  /** The first `RAW_PREVIEW_BYTES` of those bytes. */
  readonly raw?: Uint8Array | undefined
  /** Decoded fields, when the writer recorded a map. */
  readonly fields?: Readonly<Record<string, unknown>> | undefined
  /**
   * The message value rendered as text, for a writer that recorded something
   * other than a map. Shown verbatim; the format requires such a value to
   * survive a read rather than be replaced with an empty one.
   */
  readonly opaque?: string | undefined
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

export interface TraceAnalysis {
  readonly summary: SessionSummary
  readonly findings: readonly Finding[]
  readonly messages: readonly MessageRow[]
  readonly streams: readonly StreamRow[]
}

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

/**
 * The decoded fields of a control message, or `undefined` when the recorded
 * message is not a map.
 *
 * `typeof x === 'object'` also admits `null`, an array and a byte string, and
 * every one of those would then be read for keys that come back `undefined`,
 * silently, and precisely on the traces where the writer recorded something
 * unusual, which are the traces someone is most likely to be looking at.
 */
function fieldsOf(message: unknown): Record<string, unknown> | undefined {
  if (message === null || typeof message !== 'object') return undefined
  if (Array.isArray(message) || ArrayBuffer.isView(message)) return undefined
  return message as Record<string, unknown>
}

const HEX_PREVIEW_BYTES = 32

/**
 * Convert a decoded CBOR value into something that survives `postMessage` and
 * renders as text.
 *
 * Byte strings are previewed rather than carried whole: a control message's
 * fields can hold a whole object payload, and the message log is not where
 * anyone reads one.
 */
function display(value: unknown, depth = 0): unknown {
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof Uint8Array) {
    const head = Array.from(value.subarray(0, HEX_PREVIEW_BYTES))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
    const suffix = value.length > HEX_PREVIEW_BYTES ? '…' : ''
    return `0x${head}${suffix} (${value.length} bytes)`
  }
  if (depth >= 4) return '…'
  if (Array.isArray(value)) return value.map((v) => display(v, depth + 1))
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, display(v, depth + 1)]),
    )
  }
  return value
}

/** Render any recorded message value the format allows as one line of text. */
function opaqueText(message: unknown): string {
  if (typeof message === 'string') return message
  const shown = display(message)
  return typeof shown === 'string' ? shown : JSON.stringify(shown)
}

/**
 * A request id read out of a decoded control message.
 *
 * Two spellings because the field was renamed across the drafts this reads,
 * and the value may arrive as a CBOR integer or a bignum depending on its
 * size, so it is normalised to a string, which compares correctly for both
 * and for the pairing this feeds.
 */
function requestIdOf(fields: Readonly<Record<string, unknown>> | undefined): string | undefined {
  if (fields === undefined) return undefined
  const raw = fields.request_id ?? fields.subscribe_id
  if (typeof raw === 'bigint' || typeof raw === 'number') return raw.toString()
  // `display` has already turned a bignum into its decimal string by the time
  // a row is built, so the string form is the common case here, not a fallback.
  if (typeof raw === 'string' && /^\d+$/.test(raw)) return raw
  return undefined
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

/** Message names that answer a SUBSCRIBE, across every draft that defines one. */
const SUBSCRIBE_RESPONSES = ['SUBSCRIBE_OK', 'SUBSCRIBE_ERROR', 'REQUEST_OK', 'REQUEST_ERROR']

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
    add(
      'unknown-perspective',
      'note',
      `Perspective "${header.perspective}"`,
      'Not one of the perspectives this page knows, and shown as recorded. The vocabulary is open, so this is a trace from a newer or private recorder rather than a broken one.',
    )
  }
  if (!KNOWN_DETAIL.has(header.detail)) {
    add(
      'unknown-detail',
      'note',
      `Detail level "${header.detail}"`,
      'Not one of the levels this page knows, so which events to expect cannot be inferred from it. Shown as recorded.',
    )
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
      `${unknownTypes.length} event type${unknownTypes.length === 1 ? '' : 's'} this page cannot name`,
      `${unknownTypes.map(([type, n]) => `type ${type} (${n})`).join(', ')}. Their fields are kept as recorded. New event types may be added without a format version bump, so this is expected on a trace from a newer recorder.`,
    )
  }

  const errors = events.map((p) => p.event).filter((e): e is TraceErrorEvent => e.type === 'error')
  if (errors.length > 0) {
    const reasons = [...new Set(errors.map((e) => e.reason).filter((r) => r.length > 0))]
    add(
      'errors',
      'error',
      `${errors.length} error event${errors.length === 1 ? '' : 's'}`,
      reasons.length > 0 ? reasons.slice(0, 3).join(' · ') : 'No reason string was recorded.',
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

  const goawayIds = idsNamed(defs, ['GOAWAY'])
  const goaways = messages.filter((m) => goawayIds.has(m.messageType))
  if (goaways.length > 0) {
    add(
      'goaway',
      'warning',
      `GOAWAY sent ${goaways.length === 1 ? 'once' : `${goaways.length} times`}`,
      'One side asked the other to migrate away. Subscriptions ending after this point ended because of it, not because they failed.',
    )
  }

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

  found.push(...draftAgreementChecks(defs, messages, header.protocol, draft))
  found.push(...subscriptionChecks(defs, messages))

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
      `${unidentified.length} datagram group${unidentified.length === 1 ? '' : 's'} name no track`,
      'Objects carry no track alias of their own, and a datagram group has no stream header to take one from. These groups cannot be attributed to a track from this file, and this page does not guess one.',
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
      `${Object.keys(headerExtra).length} header key${Object.keys(headerExtra).length === 1 ? '' : 's'} this page cannot name`,
      `${Object.keys(headerExtra).join(', ')}. Kept as recorded.`,
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
  protocol: string,
  draft: number | null,
): Finding[] {
  if (draft === null || messages.length === 0) return []

  const hex = (id: number) => `0x${id.toString(16)}`
  const findings: Finding[] = []

  const undefinedIds = [
    ...new Set(messages.filter((m) => m.name === null && !m.reserved).map((m) => m.messageType)),
  ]
  if (undefinedIds.length > 0) {
    findings.push({
      id: 'message-id-undefined',
      severity: 'warning',
      title: `${draftLabel(draft)} does not define ${undefinedIds.length === 1 ? 'this message ID' : 'these message IDs'}`,
      detail: `${undefinedIds.map(hex).join(', ')}. The file declares "${protocol}", so either the session used a different draft than the recorder was told, or these are private code points. Names on this page come from ${draftLabel(draft)} and are only as right as that string.`,
    })
  }

  const reservedIds = [...new Set(messages.filter((m) => m.reserved).map((m) => m.messageType))]
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

/**
 * Subscriptions that were asked for and never answered.
 *
 * The pairing runs on request ids read out of the decoded message, which not
 * every writer records: some write the message as an opaque rendering with no
 * addressable fields at all. Where that happens the answer is to say the check
 * could not run, never to report zero unanswered: a trace with no readable ids
 * and a trace where every subscription succeeded look identical otherwise, and
 * they are opposite findings.
 */
function subscriptionChecks(
  defs: readonly MessageDef[],
  messages: readonly MessageRow[],
): Finding[] {
  const subscribeIds = idsNamed(defs, ['SUBSCRIBE'])
  if (subscribeIds.size === 0) return []

  const subscribes = messages.filter((m) => subscribeIds.has(m.messageType))
  if (subscribes.length === 0) return []

  const answered = new Set<string>()
  const responseIds = idsNamed(defs, SUBSCRIBE_RESPONSES)
  for (const message of messages) {
    if (!responseIds.has(message.messageType)) continue
    const id = requestIdOf(message.fields)
    if (id !== undefined) answered.add(id)
  }

  const unmatchable = subscribes.filter((m) => requestIdOf(m.fields) === undefined)
  if (unmatchable.length === subscribes.length) {
    return [
      {
        id: 'subscribe-unpairable',
        severity: 'note',
        title: 'Subscriptions cannot be paired with their responses',
        detail: `No request id could be read from any of the ${subscribes.length} SUBSCRIBE message${subscribes.length === 1 ? '' : 's'}, so whether each was answered is not something this file can say.`,
      },
    ]
  }

  const unanswered = subscribes.filter((m) => {
    const id = requestIdOf(m.fields)
    return id !== undefined && !answered.has(id)
  })

  const findings: Finding[] = []
  if (unanswered.length > 0) {
    findings.push({
      id: 'subscribe-unanswered',
      severity: 'warning',
      title: `${unanswered.length} SUBSCRIBE never answered`,
      detail: `Request id${unanswered.length === 1 ? '' : 's'} ${unanswered.map((m) => requestIdOf(m.fields)).join(', ')}. Either the response is outside the recorded window, or it never came.`,
    })
  }
  if (unmatchable.length > 0) {
    findings.push({
      id: 'subscribe-partly-unpairable',
      severity: 'note',
      title: `${unmatchable.length} SUBSCRIBE carries no readable request id`,
      detail: 'Those are excluded from the count above rather than assumed answered.',
    })
  }
  return findings
}

// -------------------------------------------------------------- analysis ---

export interface AnalyzeInput {
  readonly segments: readonly Trace[]
  readonly formatVersion: number
  readonly tables: MessageTables
  /** Byte offset the file was cut at, when the read ended early. */
  readonly truncatedAt?: number
}

export function analyze(input: AnalyzeInput): TraceAnalysis {
  const { segments, formatVersion, tables, truncatedAt } = input
  const header = segments[0]!.header
  const events = ordered(segments)

  const draft = draftOf(header.protocol, tables)
  const defs: readonly MessageDef[] = draft === null ? [] : (tables[draft] ?? [])
  const names = byId(defs)

  const summary = summarize(header, segments, events, formatVersion, draft)
  const since = sessionClock(header, segments)
  const messages = events
    .filter((p): p is { segment: number; event: ControlMessageEvent } => p.event.type === 'control')
    .map(({ segment, event }) => row(segment, event, names, since))

  const findings = check({ header, events, messages, summary, defs, draft, truncatedAt })
  return { summary, findings, messages, streams: streamRows(events, since) }
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

function row(
  segment: number,
  event: ControlMessageEvent,
  names: ReadonlyMap<number, MessageDef>,
  since: Clock,
): MessageRow {
  const def = names.get(event.messageType)
  const fields = fieldsOf(event.message)
  const named = def !== undefined && !def.reserved
  return {
    segment,
    seq: event.seq,
    timestamp: event.timestamp,
    at: since(segment, event.timestamp),
    direction: event.direction,
    messageType: event.messageType,
    name: named ? def.name : null,
    reserved: def?.reserved ?? false,
    note: def?.note ?? null,
    section: named ? def.section : null,
    specPath: def?.specPath ?? null,
    peer: event.peer,
    streamId: event.streamId?.toString(),
    size: event.raw?.length,
    raw: preview(event.raw, RAW_PREVIEW_BYTES),
    fields: fields === undefined ? undefined : (display(fields) as Record<string, unknown>),
    opaque:
      fields === undefined && event.message !== undefined && event.message !== null
        ? opaqueText(event.message)
        : undefined,
  }
}
