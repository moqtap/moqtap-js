import type { SessionState } from '@moqtap/codec/session'
import type {
  DetailLevel,
  ErrorKind,
  RecorderOptions,
  Trace,
  TraceErrorEvent,
  TraceEvent,
  TraceHeader,
} from './types.js'

/**
 * The most bytes a recorder may put in an error event's `raw`.
 *
 * A MUST in the format, and a fixed number rather than a suggestion, because
 * an error event is one of the types sampling must not drop: every other
 * high-volume field is bounded by sampling, so if this one is not bounded here
 * it is not bounded at all. A peer that opens ten thousand streams and sends
 * garbage on each is what a fuzzer does to a relay, and the trace of it should
 * not be larger than the attack.
 *
 * It lives here, in the recorder, and appears nowhere in `binary.ts`. The cap
 * is addressed to the party deciding what to say about traffic it has just
 * observed — {@link TraceRecorder.recordError}, and nothing else. A serializer
 * cannot tell a freshly recorded event from one that arrived by being read, so
 * a cap applied there would either truncate evidence on a rewrite or refuse a
 * file the reader was required to accept. `writeMoqtrace` therefore writes a
 * `raw` of any length, and {@link TraceRecorder.record} — which inserts an
 * event a caller may well have read out of a file — does not apply it either.
 */
export const MAX_ERROR_RAW_BYTES = 4096

/**
 * What a recorder knows about an error beyond its code and reason.
 *
 * Every field is optional and each is gated at its own detail level, so one
 * call site can hand over everything it has and let the recorder keep what its
 * level allows.
 */
export interface ErrorDetails {
  /**
   * QUIC stream the error was observed on.
   *
   * Omit it when there was no stream or none is known — that is what its
   * absence says, and a reader must not read it as stream `0`.
   */
  readonly streamId?: bigint
  /** What sort of failure this was. An open vocabulary; any string is legal. */
  readonly errorKind?: ErrorKind
  /**
   * The offending bytes, in full and untruncated.
   *
   * Hand over everything held: the recorder applies {@link
   * MAX_ERROR_RAW_BYTES} and reports the untruncated length in `rawLength`,
   * so a caller that pre-truncates loses the one signal saying the capture is
   * partial. Recorded only at `'full'`, and only once per flow.
   */
  readonly raw?: Uint8Array
  /**
   * The length to report, where the caller already holds less than it saw.
   *
   * Defaults to `raw.length`, which is right whenever `raw` is everything
   * there was. Set it to state a length larger than the bytes on hand — a
   * caller that hit a cap of its own upstream, or one that knows a message's
   * declared length without having kept it.
   *
   * **Set it to `null` when the true length is unknown**, and the key is
   * omitted. SPEC.md requires that rather than a guess, because the guess is
   * not neutral: `rawlen` equal to the bytes present is this format's signal
   * for *not truncated*, so defaulting it would assert a complete capture
   * exactly where the caller knows least about whether the input was
   * complete. Absent, a reader treats a `raw` of exactly
   * {@link MAX_ERROR_RAW_BYTES} as possibly truncated, which is the truth.
   *
   * The caller this exists for is real rather than hypothetical: a recorder
   * that stops *reading* a stream once it will not parse — the sensible thing
   * to do with such a stream — never holds more than its own cap and cannot
   * know what it did not read.
   */
  readonly rawLength?: number | null
}

export interface TraceRecorder {
  /** Wrap a SessionState to auto-record control messages and state changes. */
  wrapSession<M extends { type: string }, T extends string>(
    session: SessionState<M, T>,
  ): SessionState<M, T>

  /**
   * Record an arbitrary event manually.
   *
   * A passthrough: no detail-level gate, and no cap on an error event's
   * `raw`, because an event handed here may have been read out of a file
   * rather than built from observed bytes, and shortening that one would
   * destroy evidence to enforce a rule addressed to whoever recorded it.
   * Callers building an event from bytes they just saw want
   * {@link recordError}.
   */
  record(event: TraceEvent): void

  /** Record a stream-opened event. Ignored at 'control' detail level. */
  recordStreamOpened(streamId: bigint, direction: 0 | 1, streamType: 0 | 1 | 2): void

  /** Record a stream-closed event. Ignored at 'control' detail level. */
  recordStreamClosed(streamId: bigint, errorCode?: number): void

  /** Record an object header event. Ignored below 'headers' detail level. */
  recordObjectHeader(
    streamId: bigint,
    groupId: bigint,
    objectId: bigint,
    publisherPriority: number,
    objectStatus: number,
  ): void

  /** Record an object payload event. Ignored below 'headers+sizes' detail level. */
  recordObjectPayload(
    streamId: bigint,
    groupId: bigint,
    objectId: bigint,
    size: number,
    payload?: Uint8Array,
  ): void

  /**
   * Record a protocol error.
   *
   * Recorded at every detail level — an error event is non-droppable — but
   * `details` is gated key by key: `streamId` and `errorKind` at every
   * level, `rawLength` from `'headers+sizes'`, and `raw` at `'full'`
   * alone, capped at {@link MAX_ERROR_RAW_BYTES} and written once per flow.
   */
  recordError(errorCode: number, reason: string, details?: ErrorDetails): void

  /** Record a user-defined annotation. */
  annotate(label: string, data?: unknown): void

  /** Finalize the trace. Stops recording and returns the trace. */
  finalize(): Trace

  /** Whether the recorder is still accepting events. */
  readonly recording: boolean
}

const DETAIL_RANK: Record<DetailLevel, number> = {
  control: 0,
  headers: 1,
  'headers+sizes': 2,
  'headers+data': 3,
  full: 4,
}

export function createRecorder(options: RecorderOptions): TraceRecorder {
  const detail = options.detail
  const detailRank = DETAIL_RANK[detail]
  // A reader must tolerate a detail level it does not know; a recorder cannot.
  // Asked for a level this build does not implement, it would either capture
  // less than the caller believes — writing a header that claims a detail the
  // events do not have — or capture more, which for the payload-bearing
  // levels is a privacy failure. Neither is worth a trace, so refuse instead.
  if (detailRank === undefined) {
    throw new Error(
      `Unknown detail level '${detail}': cannot record at a level this build does not implement`,
    )
  }
  const maxEvents = options.maxEvents ?? 100_000
  const clock = options.clock ?? (() => Math.round(performance.now() * 1000))
  const messageTypeId = options.messageTypeId ?? (() => 0)

  const events: TraceEvent[] = []
  /**
   * Flows whose bytes have already been recorded.
   *
   * The format allows `"raw"` once per flow — per stream where the error
   * names one, per peer where it does not, and this recorder writes no peer
   * identifier, so every error naming no stream shares one flow.
   *
   * The latch is on the field and not on the event: later errors on a flow are
   * still recorded in full, they simply carry no bytes. Suppressing the events
   * would discard the causal record precisely when a peer is misbehaving
   * repeatedly, which is when it matters most. What grows without bound is the
   * bytes, so that is what is bounded.
   */
  const rawRecorded = new Set<string>()
  let _recording = true
  let _seq = 0
  const startTime = Date.now()

  function addEvent(event: TraceEvent): void {
    if (!_recording) return
    if (events.length >= maxEvents) {
      events.shift()
    }
    events.push(event)
  }

  function nextSeq(): number {
    return _seq++
  }

  /** The flow an error belongs to, for the one-`raw`-per-flow latch. */
  function rawFlow(streamId: bigint | undefined): string {
    return streamId == null ? 'no-stream' : `stream:${streamId}`
  }

  /** Take a flow's one slot for recording bytes, or answer that it is spent. */
  function claimRawSlot(flow: string): boolean {
    if (rawRecorded.has(flow)) return false
    rawRecorded.add(flow)
    return true
  }

  function wrapSession<M extends { type: string }, T extends string>(
    session: SessionState<M, T>,
  ): SessionState<M, T> {
    return {
      get phase() {
        return session.phase
      },
      get role() {
        return session.role
      },
      get subscriptions() {
        return session.subscriptions
      },
      get announces() {
        return session.announces
      },
      get legalOutgoing() {
        return session.legalOutgoing
      },
      get legalIncoming() {
        return session.legalIncoming
      },

      receive(message: M) {
        const prevPhase = session.phase
        const result = session.receive(message)

        addEvent({
          type: 'control',
          seq: nextSeq(),
          timestamp: clock(),
          direction: 1, // rx
          messageType: messageTypeId(message.type),
          message,
        })

        if (result.ok && result.phase !== prevPhase) {
          addEvent({
            type: 'state-change',
            seq: nextSeq(),
            timestamp: clock(),
            from: prevPhase,
            to: result.phase,
          })
        }

        return result
      },

      validateOutgoing(message: M) {
        return session.validateOutgoing(message)
      },

      send(message: M) {
        const prevPhase = session.phase
        const result = session.send(message)

        addEvent({
          type: 'control',
          seq: nextSeq(),
          timestamp: clock(),
          direction: 0, // tx
          messageType: messageTypeId(message.type),
          message,
        })

        if (result.ok && result.phase !== prevPhase) {
          addEvent({
            type: 'state-change',
            seq: nextSeq(),
            timestamp: clock(),
            from: prevPhase,
            to: result.phase,
          })
        }

        return result
      },

      reset() {
        session.reset()
      },
    }
  }

  return {
    wrapSession,

    record: addEvent,

    recordStreamOpened(streamId, direction, streamType) {
      if (detailRank < DETAIL_RANK.headers) return
      addEvent({
        type: 'stream-opened',
        seq: nextSeq(),
        timestamp: clock(),
        streamId,
        direction,
        streamType,
      })
    },

    recordStreamClosed(streamId, errorCode = 0) {
      if (detailRank < DETAIL_RANK.headers) return
      addEvent({
        type: 'stream-closed',
        seq: nextSeq(),
        timestamp: clock(),
        streamId,
        errorCode,
      })
    },

    recordObjectHeader(streamId, groupId, objectId, publisherPriority, objectStatus) {
      if (detailRank < DETAIL_RANK.headers) return
      addEvent({
        type: 'object-header',
        seq: nextSeq(),
        timestamp: clock(),
        streamId,
        groupId,
        objectId,
        publisherPriority,
        objectStatus,
      })
    },

    recordObjectPayload(streamId, groupId, objectId, size, payload) {
      if (detailRank < DETAIL_RANK['headers+sizes']) return
      const event: TraceEvent = {
        type: 'object-payload',
        seq: nextSeq(),
        timestamp: clock(),
        streamId,
        groupId,
        objectId,
        size,
        ...(detailRank >= DETAIL_RANK['headers+data'] && payload != null ? { payload } : {}),
      }
      addEvent(event)
    },

    recordError(errorCode, reason, details) {
      const streamId = details?.streamId
      const raw = details?.raw
      // What the recorder held, before the cap below — the whole point of the
      // key, since a reader compares it against the bytes it got to learn that
      // the capture is partial and by how much. An explicit `null` means the
      // caller does not know, and omits the key rather than claiming the bytes
      // present are all there were.
      const rawLength =
        details?.rawLength === null ? undefined : (details?.rawLength ?? raw?.length)
      // Claimed only when the bytes are actually going to be written, so a
      // recording below 'full' does not spend a flow's one slot on an event
      // that carried nothing.
      const writeRaw =
        raw != null && detailRank >= DETAIL_RANK.full && claimRawSlot(rawFlow(streamId))

      const event: TraceErrorEvent = {
        type: 'error',
        seq: nextSeq(),
        timestamp: clock(),
        errorCode,
        reason,
        ...(streamId != null ? { streamId } : {}),
        ...(details?.errorKind != null ? { errorKind: details.errorKind } : {}),
        // A size, gated with the other sizes and one level below the bytes: an
        // error may name a data stream, so at 'control' this length would be a
        // fact about media volume in a trace whose declared level excludes it.
        // Written whether or not the bytes are, which is most of its value.
        ...(rawLength != null && detailRank >= DETAIL_RANK['headers+sizes'] ? { rawLength } : {}),
        ...(writeRaw && raw != null
          ? { raw: raw.length > MAX_ERROR_RAW_BYTES ? raw.slice(0, MAX_ERROR_RAW_BYTES) : raw }
          : {}),
      }
      addEvent(event)
    },

    annotate(label, data) {
      addEvent({
        type: 'annotation',
        seq: nextSeq(),
        timestamp: clock(),
        label,
        data,
      })
    },

    finalize(): Trace {
      _recording = false
      const header: TraceHeader = {
        protocol: options.protocol,
        perspective: options.perspective,
        detail,
        startTime,
        endTime: Date.now(),
        ...(options.transport != null ? { transport: options.transport } : {}),
        ...(options.source != null ? { source: options.source } : {}),
        ...(options.endpoint != null ? { endpoint: options.endpoint } : {}),
        ...(options.sessionId != null ? { sessionId: options.sessionId } : {}),
        // Carried through so a recorder with something to say the format has
        // no key for can say it, and so a header this package builds has the
        // same shape as one it reads. `writeMoqtrace` writes the store after
        // the keys above and drops any entry naming one of them.
        ...(options.extra != null ? { extra: options.extra } : {}),
      }
      return { header, events: [...events] }
    },

    get recording() {
      return _recording
    },
  }
}
