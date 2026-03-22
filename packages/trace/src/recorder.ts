import type { MoqtMessage } from '@moqtap/codec';
import type { SessionState } from '@moqtap/codec/session';
import type {
  Trace,
  TraceHeader,
  TraceEvent,
  RecorderOptions,
  DetailLevel,
} from './types.js';

export interface TraceRecorder {
  /** Wrap a SessionState to auto-record control messages and state changes. */
  wrapSession(session: SessionState): SessionState;

  /** Record an arbitrary event manually. */
  record(event: TraceEvent): void;

  /** Record a stream-opened event. Ignored at 'control' detail level. */
  recordStreamOpened(streamId: bigint, direction: 0 | 1, streamType: 0 | 1 | 2): void;

  /** Record a stream-closed event. Ignored at 'control' detail level. */
  recordStreamClosed(streamId: bigint, errorCode?: number): void;

  /** Record an object header event. Ignored below 'headers' detail level. */
  recordObjectHeader(
    streamId: bigint, groupId: bigint, objectId: bigint,
    publisherPriority: number, objectStatus: number,
  ): void;

  /** Record an object payload event. Ignored below 'headers+sizes' detail level. */
  recordObjectPayload(
    streamId: bigint, groupId: bigint, objectId: bigint,
    size: number, payload?: Uint8Array,
  ): void;

  /** Record a protocol error. */
  recordError(errorCode: number, reason: string): void;

  /** Record a user-defined annotation. */
  annotate(label: string, data?: unknown): void;

  /** Finalize the trace. Stops recording and returns the trace. */
  finalize(): Trace;

  /** Whether the recorder is still accepting events. */
  readonly recording: boolean;
}

const DETAIL_RANK: Record<DetailLevel, number> = {
  'control': 0,
  'headers': 1,
  'headers+sizes': 2,
  'headers+data': 3,
  'full': 4,
};

export function createRecorder(options: RecorderOptions): TraceRecorder {
  const detail = options.detail;
  const detailRank = DETAIL_RANK[detail];
  const maxEvents = options.maxEvents ?? 100_000;
  const clock = options.clock ?? (() => Math.round(performance.now() * 1000));
  const messageTypeId = options.messageTypeId ?? (() => 0);

  const events: TraceEvent[] = [];
  let _recording = true;
  let _seq = 0;
  const startTime = Date.now();

  function addEvent(event: TraceEvent): void {
    if (!_recording) return;
    if (events.length >= maxEvents) {
      events.shift();
    }
    events.push(event);
  }

  function nextSeq(): number {
    return _seq++;
  }

  function wrapSession(session: SessionState): SessionState {
    return {
      get phase() { return session.phase; },
      get role() { return session.role; },
      get subscriptions() { return session.subscriptions; },
      get announces() { return session.announces; },
      get legalOutgoing() { return session.legalOutgoing; },
      get legalIncoming() { return session.legalIncoming; },

      receive(message: MoqtMessage) {
        const prevPhase = session.phase;
        const result = session.receive(message);

        addEvent({
          type: 'control',
          seq: nextSeq(),
          timestamp: clock(),
          direction: 1, // rx
          messageType: messageTypeId(message.type),
          message: message as unknown as Record<string, unknown>,
        });

        if (result.ok && result.phase !== prevPhase) {
          addEvent({
            type: 'state-change',
            seq: nextSeq(),
            timestamp: clock(),
            from: prevPhase,
            to: result.phase,
          });
        }

        return result;
      },

      validateOutgoing(message: MoqtMessage) {
        return session.validateOutgoing(message);
      },

      send(message: MoqtMessage) {
        const prevPhase = session.phase;
        const result = session.send(message);

        addEvent({
          type: 'control',
          seq: nextSeq(),
          timestamp: clock(),
          direction: 0, // tx
          messageType: messageTypeId(message.type),
          message: message as unknown as Record<string, unknown>,
        });

        if (result.ok && result.phase !== prevPhase) {
          addEvent({
            type: 'state-change',
            seq: nextSeq(),
            timestamp: clock(),
            from: prevPhase,
            to: result.phase,
          });
        }

        return result;
      },

      reset() {
        session.reset();
      },
    };
  }

  return {
    wrapSession,

    record: addEvent,

    recordStreamOpened(streamId, direction, streamType) {
      if (detailRank < DETAIL_RANK['headers']) return;
      addEvent({
        type: 'stream-opened',
        seq: nextSeq(),
        timestamp: clock(),
        streamId,
        direction,
        streamType,
      });
    },

    recordStreamClosed(streamId, errorCode = 0) {
      if (detailRank < DETAIL_RANK['headers']) return;
      addEvent({
        type: 'stream-closed',
        seq: nextSeq(),
        timestamp: clock(),
        streamId,
        errorCode,
      });
    },

    recordObjectHeader(streamId, groupId, objectId, publisherPriority, objectStatus) {
      if (detailRank < DETAIL_RANK['headers']) return;
      addEvent({
        type: 'object-header',
        seq: nextSeq(),
        timestamp: clock(),
        streamId,
        groupId,
        objectId,
        publisherPriority,
        objectStatus,
      });
    },

    recordObjectPayload(streamId, groupId, objectId, size, payload) {
      if (detailRank < DETAIL_RANK['headers+sizes']) return;
      const event: TraceEvent = {
        type: 'object-payload',
        seq: nextSeq(),
        timestamp: clock(),
        streamId,
        groupId,
        objectId,
        size,
        ...(detailRank >= DETAIL_RANK['headers+data'] && payload != null ? { payload } : {}),
      };
      addEvent(event);
    },

    recordError(errorCode, reason) {
      addEvent({
        type: 'error',
        seq: nextSeq(),
        timestamp: clock(),
        errorCode,
        reason,
      });
    },

    annotate(label, data) {
      addEvent({
        type: 'annotation',
        seq: nextSeq(),
        timestamp: clock(),
        label,
        data,
      });
    },

    finalize(): Trace {
      _recording = false;
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
      };
      return { header, events: [...events] };
    },

    get recording() { return _recording; },
  };
}
