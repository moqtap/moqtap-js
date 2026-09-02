import { describe, expect, it } from 'vitest'
import { traceToJSON } from '../json.js'
import type { Trace } from '../types.js'

describe('traceToJSON', () => {
  it('produces valid JSON', () => {
    const trace: Trace = {
      header: {
        protocol: 'moq-transport-14',
        perspective: 'client',
        detail: 'control',
        startTime: 1700000000000,
      },
      events: [
        {
          type: 'annotation',
          seq: 0,
          timestamp: 100,
          label: 'test',
          data: 'hello',
        },
      ],
    }
    const json = traceToJSON(trace)
    expect(() => JSON.parse(json)).not.toThrow()
  })

  it('converts bigint to hex string', () => {
    const trace: Trace = {
      header: {
        protocol: 'moq-transport-14',
        perspective: 'client',
        detail: 'headers',
        startTime: 1700000000000,
      },
      events: [
        {
          type: 'stream-opened',
          seq: 0,
          timestamp: 100,
          streamId: 255n,
          direction: 0,
          streamType: 0,
        },
      ],
    }
    const json = traceToJSON(trace)
    expect(json).toContain('"0xff"')
  })

  it('converts Uint8Array to hex string', () => {
    const trace: Trace = {
      header: {
        protocol: 'moq-transport-14',
        perspective: 'client',
        detail: 'full',
        startTime: 1700000000000,
      },
      events: [
        {
          type: 'control',
          seq: 0,
          timestamp: 100,
          direction: 0,
          messageType: 3,
          message: {},
          raw: new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
        },
      ],
    }
    const json = traceToJSON(trace)
    expect(json).toContain('"deadbeef"')
  })

  it('preserves structure for JSON.parse consumers', () => {
    const trace: Trace = {
      header: {
        protocol: 'moq-transport-14',
        perspective: 'observer',
        detail: 'control',
        startTime: 1700000000000,
        endTime: 1700000060000,
      },
      events: [
        {
          type: 'state-change',
          seq: 0,
          timestamp: 0,
          from: 'idle',
          to: 'setup',
        },
        { type: 'error', seq: 1, timestamp: 100, errorCode: 1, reason: 'test' },
        {
          type: 'annotation',
          seq: 2,
          timestamp: 200,
          label: 'note',
          data: { x: 1 },
        },
      ],
    }
    const json = traceToJSON(trace)
    const parsed = JSON.parse(json)
    expect(parsed.header.protocol).toBe('moq-transport-14')
    expect(parsed.header.perspective).toBe('observer')
    expect(parsed.events).toHaveLength(3)
    expect(parsed.events[0].type).toBe('state-change')
  })

  it('is pretty-printed with 2-space indent', () => {
    const trace: Trace = {
      header: {
        protocol: 'moq-transport-14',
        perspective: 'client',
        detail: 'control',
        startTime: 0,
      },
      events: [],
    }
    const json = traceToJSON(trace)
    expect(json).toContain('  "header"')
  })
})

describe('the unrecognised-key stores in the JSON view', () => {
  // The JSON export is what someone reaches for when they suspect a key went
  // missing, so a rendering that dropped the stores would hide exactly the
  // loss the binary reader stopped making — and would do it in the one view
  // whose whole purpose is to show what the file said.

  const trace: Trace = {
    header: {
      protocol: 'moq-transport-14',
      perspective: 'client',
      detail: 'control',
      startTime: 1700000000000,
      segment: { sequence: 0, extra: { 'x-rot': 'size' } },
      sampling: { droppedTotal: 3, extra: { appliesTo: [3, 'x', 5] } },
      extra: { 'x-note': 'hello', 'x-bytes': new Uint8Array([0xde, 0xad]) },
    },
    events: [
      { type: 'annotation', seq: 0, timestamp: 0, label: 'a', data: null, extra: { 'x-e': 1 } },
    ],
  }

  it('shows all three header stores, each inside the map it belongs to', () => {
    const parsed = JSON.parse(traceToJSON(trace))
    expect(parsed.header.extra['x-note']).toBe('hello')
    expect(parsed.header.segment.extra).toEqual({ 'x-rot': 'size' })
    expect(parsed.header.sampling.extra).toEqual({ appliesTo: [3, 'x', 5] })
    expect(parsed.events[0].extra).toEqual({ 'x-e': 1 })
  })

  it('renders a byte string nested in a store as hex, like any other', () => {
    expect(JSON.parse(traceToJSON(trace)).header.extra['x-bytes']).toBe('dead')
  })
})
