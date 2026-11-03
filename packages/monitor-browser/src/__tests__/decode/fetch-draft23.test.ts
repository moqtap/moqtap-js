/**
 * The fetch walk on draft-23, against the codec's own encoder and decoder:
 * the Object ID Delta `+ 2`, End-of-Range IDs with their own delta rule, End
 * of Gone Range, and the field-less End of Group and End of Track.
 */

import { decodeFetchStream, encodeFetchStream, type FetchStream } from '@moqtap/codec/draft23'
import { describe, expect, it } from 'vitest'
import { FetchCounter } from '../../decode/fetch-counter.js'
import { DRAFT22_ADAPTER } from '../../drafts/draft22/index.js'
import { DRAFT23_ADAPTER } from '../../drafts/draft23/index.js'
import {
  type DeliveryPath,
  type DraftAdapter,
  type MarkSample,
  NEED,
  newCursor,
} from '../../types.js'
import { AscendingKeys, chunks, filled, Recorder } from './vectors.js'

const MAX_U64 = 2n ** 64n - 1n

class FetchKeys extends AscendingKeys {
  override fetchPath(): DeliveryPath {
    return 'fetch'
  }
}

class MarkRecorder extends Recorder {
  readonly marks: MarkSample[] = []
  onMark(m: MarkSample): void {
    this.marks.push(m)
  }
}

interface Entry {
  readonly flags: number
  readonly group?: bigint
  readonly id?: bigint
  readonly bytes?: number
}

/** Encoded by the codec, so the bytes are its reading of draft-23 and not ours. */
function stream(entries: readonly Entry[]): Uint8Array {
  const s: FetchStream = {
    type: 'fetch',
    requestId: 4n,
    objects: entries.map((e) => ({
      type: 'object',
      byteOffset: 0,
      payloadByteOffset: 0,
      serializationFlags: e.flags,
      groupId: e.group ?? 0n,
      subgroupId: 0n,
      objectId: e.id ?? 0n,
      publisherPriority: 128,
      payloadLength: e.bytes ?? 0,
      payload: filled(e.bytes ?? 0),
      extensionData: new Uint8Array(0),
    })),
  }
  return encodeFetchStream(s)
}

function count(
  bytes: Uint8Array,
  size = bytes.length,
  adapter: DraftAdapter = DRAFT23_ADAPTER,
): MarkRecorder {
  const sink = new MarkRecorder()
  const c = new FetchCounter('rx', new FetchKeys(), sink, adapter, { streamId: 3 })
  for (const part of chunks(bytes, size)) c.push(part, 1)
  c.end()
  return sink
}

const hex = (h: string): Uint8Array => Uint8Array.from(h.match(/../g)!.map((x) => parseInt(x, 16)))

/** Every delta form, three indicators, and objects resolved against each. */
const MIXED: readonly Entry[] = [
  { flags: 0x1c, group: 5n, id: 0n, bytes: 3 },
  { flags: 0x04, group: 5n, id: 4n, bytes: 3 },
  { flags: 0x10c, group: 5n, id: 7n },
  { flags: 0x04, group: 5n, id: 10n, bytes: 3 },
  { flags: 0x80 },
  { flags: 0x0c, group: 7n, id: 0n, bytes: 3 },
  { flags: 0x40c, group: 9n, id: 2n },
  { flags: 0x0c, group: 10n, id: 1n, bytes: 3 },
  { flags: 0x81 },
]

describe('FetchCounter on draft-23', () => {
  it('resolves ids exactly as the codec one-shot decoder does', () => {
    const bytes = stream(MIXED)
    const oneShot = decodeFetchStream(bytes)
    expect(oneShot.ok).toBe(true)
    if (!oneShot.ok) return
    const real = oneShot.value.objects.filter((o) => o.serializationFlags < 0x80)
    for (const size of [1, 2, 5, bytes.length]) {
      const sink = count(bytes, size)
      expect(sink.failures).toEqual([])
      expect(sink.objects.map((o) => [o.groupId, o.objectId])).toEqual(
        real.map((o) => [o.groupId, o.objectId]),
      )
      // Every byte but the closing End of Track (`80 81`), which no Object follows.
      expect(sink.totalHeaderBytes + sink.totalPayloadBytes).toBe(bytes.length - 2)
    }
  })

  it('marks End-of-Range by its decoded range, End of Gone Range included', () => {
    const ranges = count(stream(MIXED)).marks.filter((m) => 'range' in m.what)
    expect(ranges.map((m) => [m.groupId, m.objectId, m.what])).toEqual([
      [5n, 4n, { range: 0x10c, g2: 5n, o2: 7n }],
      [7n, 0n, { range: 0x40c, g2: 9n, o2: 2n }],
    ])
  })

  it('marks End of Group and End of Track at the Object they follow', () => {
    const ends = count(stream(MIXED)).marks.filter((m) => 'end' in m.what)
    expect(ends.map((m) => [m.groupId, m.objectId, m.what, m.path, m.streamId])).toEqual([
      [5n, 10n, { end: 'group' }, 'fetch', 3],
      [10n, 1n, { end: 'track' }, 'fetch', 3],
    ])
  })

  it('reads the corpus vector for End of Group then a new group', () => {
    const sink = count(hex('05041c05008001aa0001aa0001aa80801c00008001aa'))
    expect(sink.failures).toEqual([])
    expect(sink.objects.map((o) => [o.groupId, o.objectId])).toEqual([
      [5n, 0n],
      [5n, 1n],
      [5n, 2n],
      [6n, 0n],
    ])
    expect(sink.marks.map((m) => m.what)).toEqual([{ end: 'group' }])
  })

  it('records no end straight after an End of Range', () => {
    const sink = count(
      stream([
        { flags: 0x1c, group: 5n, id: 0n, bytes: 1 },
        { flags: 0x8c, group: 5n, id: 9n },
        { flags: 0x80 },
      ]),
    )
    expect(sink.failures).toEqual([])
    expect(sink.marks.filter((m) => 'end' in m.what)).toEqual([])
  })

  it.each([
    ['an implicit Object ID past 2^64-1 after End of Group', '05041c05028001aa808018008001bb'],
    ['an End of Range Object ID past 2^64-1', '05041c05008001aa810c00ffffffffffffffffff00'],
    ['an Object ID Delta + 2 past 2^64-1', '05041c05fffffffffffffffffe8001aa0500024142'],
    ['an undefined value above 127', '0504808d050a00'],
    ['End of Group as the first entry', '05048080'],
    ['a zero Group ID Delta End of Range after End of Group', '05041c05028001aa8080810c000000'],
  ])('abandons the stream on %s', (_, h) => {
    expect(count(hex(h)).reasons).toEqual(['fetch-desync'])
  })

  it('marks an End of Range after End of Group from {G, 2^64-1}', () => {
    const sink = count(hex('05041c05028001aa8080840c0205000c000001cc'))
    expect(sink.failures).toEqual([])
    expect(sink.objects.map((o) => [o.groupId, o.objectId])).toEqual([
      [5n, 2n],
      [8n, 0n],
    ])
    expect(sink.marks.map((m) => [m.groupId, m.objectId, m.what])).toEqual([
      [5n, 2n, { end: 'group' }],
      [5n, MAX_U64, { range: 0x40c, g2: 7n, o2: 5n }],
    ])
  })

  it('reads the same bytes by draft-22 rules on a draft-22 connection', () => {
    // `05 02` after {5,3} is {5,5} in draft-22 and {5,7} in draft-23.
    const bytes = hex('05041c05038001aa05020141')
    expect(count(bytes, bytes.length, DRAFT22_ADAPTER).objects.map((o) => o.objectId)).toEqual([
      3n,
      5n,
    ])
    expect(count(bytes).objects.map((o) => o.objectId)).toEqual([3n, 7n])
  })

  it('walks End of Group and End of Track to Object ID 2^64-1 in the adapter walk', () => {
    const b = stream([{ flags: 0x1c, group: 5n, id: 2n, bytes: 1 }, { flags: 0x81 }])
    const head = DRAFT23_ADAPTER.readFetchHeader(b, 0)
    if (head === NEED) throw new Error('header')
    const cursor = newCursor()
    const first = DRAFT23_ADAPTER.readFetchObject(b, head.next, cursor)
    if (first === NEED) throw new Error('object')
    const end = DRAFT23_ADAPTER.readFetchObject(b, first.next, cursor)
    if (end === NEED) throw new Error('indicator')
    expect([end.marker, end.markerFlags, end.groupId, end.objectId]).toEqual([
      true,
      0x81,
      5n,
      MAX_U64,
    ])
    expect(end.next).toBe(b.length)
    expect(cursor.prevObjectId).toBe(MAX_U64)
  })
})
