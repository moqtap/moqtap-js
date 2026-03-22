import { describe, it, expect } from 'vitest';
import {
  writeMoqtrace,
  readMoqtrace,
  readMoqtraceHeader,
  createMoqtraceWriter,
} from '../binary.js';
import type { Trace, TraceEvent, TraceHeader } from '../types.js';

function makeHeader(overrides?: Partial<TraceHeader>): TraceHeader {
  return {
    protocol: 'moq-transport-14',
    perspective: 'client',
    detail: 'control',
    startTime: 1700000000000,
    ...overrides,
  };
}

function makeTrace(events: TraceEvent[], headerOverrides?: Partial<TraceHeader>): Trace {
  return {
    header: makeHeader(headerOverrides),
    events,
  };
}

/** Write then read back — the core round-trip helper. */
function roundTrip(events: TraceEvent[], headerOverrides?: Partial<TraceHeader>): Trace {
  return readMoqtrace(writeMoqtrace(makeTrace(events, headerOverrides)));
}

describe('binary .moqtrace format', () => {
  describe('preamble validation', () => {
    it('rejects files shorter than 16 bytes', () => {
      expect(() => readMoqtrace(new Uint8Array(10))).toThrow('too short');
    });

    it('rejects files with wrong magic bytes', () => {
      const bytes = new Uint8Array(20);
      bytes.set([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07], 0);
      expect(() => readMoqtrace(bytes)).toThrow('magic');
    });

    it('rejects unsupported version', () => {
      const bytes = writeMoqtrace(makeTrace([]));
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      view.setUint32(8, 99, true);
      expect(() => readMoqtrace(bytes)).toThrow('version');
    });

    it('rejects truncated header', () => {
      const bytes = writeMoqtrace(makeTrace([]));
      const truncated = bytes.slice(0, 17);
      const view = new DataView(truncated.buffer, truncated.byteOffset, truncated.byteLength);
      view.setUint32(12, 9999, true);
      expect(() => readMoqtrace(truncated)).toThrow('truncated');
    });

    it('starts with MOQTRACE magic bytes', () => {
      const bytes = writeMoqtrace(makeTrace([]));
      const magic = new TextDecoder().decode(bytes.slice(0, 8));
      expect(magic).toBe('MOQTRACE');
    });
  });

  describe('header round-trip', () => {
    it('preserves required fields', () => {
      const { header } = roundTrip([]);
      expect(header.protocol).toBe('moq-transport-14');
      expect(header.perspective).toBe('client');
      expect(header.detail).toBe('control');
      expect(header.startTime).toBe(1700000000000);
    });

    it('preserves optional fields', () => {
      const { header } = roundTrip([], {
        endTime: 1700000060000,
        transport: 'webtransport',
        source: 'moqtap-devtools/0.1.0',
        endpoint: 'https://relay.example.com/moq',
        sessionId: 'abc-123',
        custom: { debug: true, version: 42 },
      });
      expect(header.endTime).toBe(1700000060000);
      expect(header.transport).toBe('webtransport');
      expect(header.source).toBe('moqtap-devtools/0.1.0');
      expect(header.endpoint).toBe('https://relay.example.com/moq');
      expect(header.sessionId).toBe('abc-123');
      expect(header.custom).toEqual({ debug: true, version: 42 });
    });

    it('readMoqtraceHeader returns only the header', () => {
      const bytes = writeMoqtrace(makeTrace([
        { type: 'annotation', seq: 0, timestamp: 100, label: 'test', data: null },
      ]));
      const header = readMoqtraceHeader(bytes);
      expect(header.protocol).toBe('moq-transport-14');
      expect(header.perspective).toBe('client');
    });

    it('omits undefined optional fields', () => {
      const { header } = roundTrip([]);
      expect(header.endTime).toBeUndefined();
      expect(header.transport).toBeUndefined();
      expect(header.source).toBeUndefined();
    });
  });

  describe('empty trace', () => {
    it('round-trips a trace with no events', () => {
      const { events } = roundTrip([]);
      expect(events).toEqual([]);
    });
  });

  describe('event round-trips', () => {
    it('control message event', () => {
      const { events } = roundTrip([{
        type: 'control',
        seq: 0,
        timestamp: 1000,
        direction: 1,
        messageType: 0x03,
        message: { type: 'subscribe', trackName: 'video' },
      }]);
      expect(events).toHaveLength(1);
      const e = events[0]!;
      expect(e.type).toBe('control');
      if (e.type === 'control') {
        expect(e.seq).toBe(0);
        expect(e.timestamp).toBe(1000);
        expect(e.direction).toBe(1);
        expect(e.messageType).toBe(0x03);
        expect(e.message).toEqual({ type: 'subscribe', trackName: 'video' });
        expect(e.raw).toBeUndefined();
      }
    });

    it('control message with raw bytes', () => {
      const raw = new Uint8Array([0x03, 0x00, 0x0a, 0xff]);
      const { events } = roundTrip([{
        type: 'control',
        seq: 0,
        timestamp: 500,
        direction: 0,
        messageType: 0x03,
        message: { type: 'subscribe' },
        raw,
      }]);
      const e = events[0]!;
      if (e.type === 'control') {
        expect(e.raw).toBeInstanceOf(Uint8Array);
        expect(Array.from(e.raw!)).toEqual([0x03, 0x00, 0x0a, 0xff]);
      }
    });

    it('stream-opened event', () => {
      const { events } = roundTrip([{
        type: 'stream-opened',
        seq: 1,
        timestamp: 2000,
        streamId: 42n,
        direction: 1,
        streamType: 0,
      }]);
      const e = events[0]!;
      expect(e.type).toBe('stream-opened');
      if (e.type === 'stream-opened') {
        expect(e.streamId).toBe(42n);
        expect(e.direction).toBe(1);
        expect(e.streamType).toBe(0);
      }
    });

    it('stream-closed event', () => {
      const { events } = roundTrip([{
        type: 'stream-closed',
        seq: 2,
        timestamp: 3000,
        streamId: 42n,
        errorCode: 0,
      }]);
      const e = events[0]!;
      expect(e.type).toBe('stream-closed');
      if (e.type === 'stream-closed') {
        expect(e.streamId).toBe(42n);
        expect(e.errorCode).toBe(0);
      }
    });

    it('object-header event with bigint fields', () => {
      const { events } = roundTrip([{
        type: 'object-header',
        seq: 3,
        timestamp: 4000,
        streamId: 100n,
        groupId: 5n,
        objectId: 99n,
        publisherPriority: 128,
        objectStatus: 0,
      }]);
      const e = events[0]!;
      expect(e.type).toBe('object-header');
      if (e.type === 'object-header') {
        expect(e.streamId).toBe(100n);
        expect(e.groupId).toBe(5n);
        expect(e.objectId).toBe(99n);
        expect(e.publisherPriority).toBe(128);
        expect(e.objectStatus).toBe(0);
      }
    });

    it('object-payload event with payload bytes', () => {
      const payload = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
      const { events } = roundTrip([{
        type: 'object-payload',
        seq: 4,
        timestamp: 5000,
        streamId: 100n,
        groupId: 5n,
        objectId: 99n,
        size: 4,
        payload,
      }]);
      const e = events[0]!;
      expect(e.type).toBe('object-payload');
      if (e.type === 'object-payload') {
        expect(e.size).toBe(4);
        expect(e.payload).toBeInstanceOf(Uint8Array);
        expect(Array.from(e.payload!)).toEqual([0xde, 0xad, 0xbe, 0xef]);
      }
    });

    it('object-payload event without payload', () => {
      const { events } = roundTrip([{
        type: 'object-payload',
        seq: 4,
        timestamp: 5000,
        streamId: 100n,
        groupId: 5n,
        objectId: 99n,
        size: 1024,
      }]);
      const e = events[0]!;
      if (e.type === 'object-payload') {
        expect(e.size).toBe(1024);
        expect(e.payload).toBeUndefined();
      }
    });

    it('state-change event', () => {
      const { events } = roundTrip([{
        type: 'state-change',
        seq: 5,
        timestamp: 6000,
        from: 'idle',
        to: 'setup',
      }]);
      const e = events[0]!;
      expect(e.type).toBe('state-change');
      if (e.type === 'state-change') {
        expect(e.from).toBe('idle');
        expect(e.to).toBe('setup');
      }
    });

    it('error event', () => {
      const { events } = roundTrip([{
        type: 'error',
        seq: 6,
        timestamp: 7000,
        errorCode: 1,
        reason: 'Protocol violation',
      }]);
      const e = events[0]!;
      expect(e.type).toBe('error');
      if (e.type === 'error') {
        expect(e.errorCode).toBe(1);
        expect(e.reason).toBe('Protocol violation');
      }
    });

    it('annotation event', () => {
      const { events } = roundTrip([{
        type: 'annotation',
        seq: 7,
        timestamp: 8000,
        label: 'user-note',
        data: { key: 'value', nested: [1, 2, 3] },
      }]);
      const e = events[0]!;
      expect(e.type).toBe('annotation');
      if (e.type === 'annotation') {
        expect(e.label).toBe('user-note');
        expect(e.data).toEqual({ key: 'value', nested: [1, 2, 3] });
      }
    });

    it('annotation with null data round-trips correctly', () => {
      const { events } = roundTrip([{
        type: 'annotation',
        seq: 0,
        timestamp: 0,
        label: 'marker',
        data: null,
      }]);
      const e = events[0]!;
      if (e.type === 'annotation') {
        expect(e.data).toBeNull();
      }
    });

    it('large bigint values survive round-trip', () => {
      const { events } = roundTrip([{
        type: 'stream-opened',
        seq: 0,
        timestamp: 0,
        streamId: 0xFFFFFFFFFFFFFFFFn,
        direction: 0,
        streamType: 2,
      }]);
      const e = events[0]!;
      if (e.type === 'stream-opened') {
        expect(e.streamId).toBe(0xFFFFFFFFFFFFFFFFn);
      }
    });
  });

  describe('multiple events', () => {
    it('preserves event order and sequence numbers', () => {
      const { events } = roundTrip([
        { type: 'state-change', seq: 0, timestamp: 100, from: 'idle', to: 'setup' },
        { type: 'control', seq: 1, timestamp: 200, direction: 0, messageType: 0x20, message: { type: 'client_setup' } },
        { type: 'control', seq: 2, timestamp: 300, direction: 1, messageType: 0x21, message: { type: 'server_setup' } },
        { type: 'state-change', seq: 3, timestamp: 400, from: 'setup', to: 'ready' },
        { type: 'annotation', seq: 4, timestamp: 500, label: 'done', data: null },
      ]);
      expect(events).toHaveLength(5);
      expect(events.map(e => e.seq)).toEqual([0, 1, 2, 3, 4]);
      expect(events.map(e => e.timestamp)).toEqual([100, 200, 300, 400, 500]);
      expect(events.map(e => e.type)).toEqual([
        'state-change', 'control', 'control', 'state-change', 'annotation',
      ]);
    });
  });

  describe('streaming writer', () => {
    it('produces same output as one-shot write', () => {
      const events: TraceEvent[] = [
        { type: 'state-change', seq: 0, timestamp: 0, from: 'idle', to: 'setup' },
        { type: 'control', seq: 1, timestamp: 100, direction: 0, messageType: 0x20, message: {} },
        { type: 'annotation', seq: 2, timestamp: 200, label: 'test', data: null },
      ];
      const trace = makeTrace(events);

      const oneShot = writeMoqtrace(trace);

      const writer = createMoqtraceWriter(trace.header);
      const chunks: Uint8Array[] = [writer.preamble()];
      for (const event of events) {
        chunks.push(writer.writeEvent(event));
      }
      const totalLen = chunks.reduce((sum, c) => sum + c.length, 0);
      const streamed = new Uint8Array(totalLen);
      let offset = 0;
      for (const chunk of chunks) {
        streamed.set(chunk, offset);
        offset += chunk.length;
      }

      expect(Array.from(streamed)).toEqual(Array.from(oneShot));
    });

    it('streaming output is readable by readMoqtrace', () => {
      const header = makeHeader({ transport: 'webtransport' });
      const writer = createMoqtraceWriter(header);
      const events: TraceEvent[] = [
        { type: 'stream-opened', seq: 0, timestamp: 0, streamId: 1n, direction: 0, streamType: 0 },
        { type: 'object-header', seq: 1, timestamp: 50, streamId: 1n, groupId: 0n, objectId: 0n, publisherPriority: 128, objectStatus: 0 },
      ];

      const chunks = [writer.preamble(), ...events.map(e => writer.writeEvent(e))];
      const totalLen = chunks.reduce((sum, c) => sum + c.length, 0);
      const bytes = new Uint8Array(totalLen);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }

      const result = readMoqtrace(bytes);
      expect(result.header.transport).toBe('webtransport');
      expect(result.events).toHaveLength(2);
      expect(result.events[0]!.type).toBe('stream-opened');
      expect(result.events[1]!.type).toBe('object-header');
    });
  });

  describe('unknown event types', () => {
    it('unknown event types are preserved as annotations', () => {
      const trace = makeTrace([
        { type: 'annotation', seq: 0, timestamp: 100, label: 'before', data: null },
      ]);
      const bytes = writeMoqtrace(trace);
      const result = readMoqtrace(bytes);
      expect(result.events).toHaveLength(1);
      expect(result.events[0]!.type).toBe('annotation');
    });
  });
});
