/**
 * The run recorder: every arrival, as runs per flow, with nothing inferred
 * from ids. Runs break where the contract says a flow breaks, and continue
 * across a seal as `cont`.
 */

import { describe, expect, it } from 'vitest'
import { MAX_OPEN_FLOWS, RunRecorder, rangeKind, runIds, statusKind } from '../../rollup/runs.js'
import type { BucketKey, MarkSample, ObjectSample } from '../../types.js'

const ALIAS: BucketKey = Object.freeze({ dir: 'rx', kind: 'alias', id: 4n, epoch: 0 })
const FETCH: BucketKey = Object.freeze({ dir: 'rx', kind: 'fetch', id: 9n, epoch: 0 })

function obj(g: bigint, o: bigint, at: number, over: Partial<ObjectSample> = {}): ObjectSample {
  return {
    key: ALIAS,
    groupId: g,
    objectId: o,
    headerBytes: 2,
    payloadBytes: 10,
    streamId: 3,
    at,
    path: 'sub_stream',
    sub: 0n,
    fo: false,
    foKnown: true,
    eog: false,
    ...over,
  }
}

const datagram = (g: bigint, o: bigint, at: number, eog = false): ObjectSample => {
  const { streamId: _s, ...s } = obj(g, o, at, { path: 'datagram', sub: null, foKnown: false, eog })
  return s
}

describe('stream runs', () => {
  it('holds a stream’s objects as one run, times in µs from the mono base', () => {
    const r = new RunRecorder(0)
    for (let i = 0; i < 4; i++) r.onObject(0, obj(7n, BigInt(i), 100 + i * 33))
    r.onPayload(0, 3, 300)
    r.onStreamEnd(0, 3, 'fin', undefined, 9)
    const { runs } = r.take()
    expect(runs).toHaveLength(1)
    const [run] = runs
    expect(runIds(run!)).toEqual([0n, 1n, 2n, 3n])
    expect(run!.ids).toBeNull()
    expect(run!.times).toEqual([100_000, 133_000, 166_000, 199_000])
    expect(run!.tl).toBe(300_000)
    expect(run!.b).toBe(40)
    expect(run!.end).toBe('fin')
  })

  it('takes FIRST_OBJECT on the stream’s first run only, and EOG at FIN only', () => {
    const r = new RunRecorder(0)
    r.onObject(0, obj(7n, 0n, 1, { fo: true, eog: true }))
    expect(r.take().runs[0]).toMatchObject({ fo: true, eog: false, end: 'open', cont: false })
    r.onObject(0, obj(7n, 1n, 2, { fo: true, eog: true }))
    r.onStreamEnd(0, 3, 'fin', undefined, 9)
    expect(r.take().runs[0]).toMatchObject({ fo: false, eog: true, end: 'fin', cont: true })
  })

  it('breaks at an id not above the previous one, and that run does not continue', () => {
    const r = new RunRecorder(0)
    r.onObject(0, obj(7n, 3n, 1))
    r.onObject(0, obj(7n, 5n, 2))
    r.onObject(0, obj(7n, 5n, 3))
    r.onObject(0, obj(7n, 1n, 4))
    const { runs } = r.take()
    expect(runs.map((x) => [runIds(x), x.cont])).toEqual([
      [[3n, 5n], false],
      [[5n], false],
      [[1n], false],
    ])
    expect(runs[0]!.ids).toEqual([3n, 5n])
  })

  it('breaks a fetch stream at each group, and keeps each object’s subgroup', () => {
    const r = new RunRecorder(0)
    const f = (g: bigint, o: bigint, sub: bigint | null) =>
      obj(g, o, 1, { key: FETCH, path: 'fetch', sub, streamId: 5, foKnown: false })
    r.onObject(0, f(11n, 0n, 0n))
    r.onObject(0, f(11n, 1n, null))
    r.onObject(0, f(10n, 0n, 2n))
    const { runs } = r.take()
    expect(runs.map((x) => [x.g, runIds(x), x.osub, x.sub])).toEqual([
      [11n, [0n, 1n], [0n, null], null],
      [10n, [0n], [2n], null],
    ])
  })

  it('ends a reset stream’s run with the code, and a failed one open', () => {
    const r = new RunRecorder(0)
    r.onObject(0, obj(1n, 0n, 1, { streamId: 3 }))
    r.onObject(0, obj(2n, 0n, 1, { streamId: 7 }))
    r.onStreamEnd(0, 3, 'reset', 16, 9)
    r.onStreamEnd(0, 7, 'gone', undefined, 9)
    expect(r.take().runs.map((x) => [x.end, x.rc])).toEqual([
      ['reset', 16n],
      ['open', null],
    ])
  })

  it('records a fetch stream whose request was never seen as runs on its own path', () => {
    const r = new RunRecorder(0)
    r.onObject(0, obj(1n, 0n, 1, { key: FETCH, path: 'fetch_unseen', streamId: 5 }))
    expect(r.take().runs.map((x) => [x.path, x.g, x.osub])).toEqual([['fetch_unseen', 1n, [0n]]])
    expect(r.droppedObjects).toBe(0)
  })

  it('records receive tracks only', () => {
    const r = new RunRecorder(0)
    r.onObject(0, obj(1n, 0n, 1, { key: { ...ALIAS, dir: 'tx' } }))
    expect(r.take().runs).toEqual([])
  })
})

describe('a stream that ends after a take', () => {
  const twoObjects = (r: RunRecorder) => {
    r.onObject(0, obj(7n, 0n, 1, { eog: true }))
    r.onObject(0, obj(7n, 1n, 2, { eog: true }))
  }

  it('keeps the run open across a take that seals nothing, so FIN and EOG are its own', () => {
    const r = new RunRecorder(0)
    twoObjects(r)
    expect(r.take(true).runs).toEqual([])
    expect(r.openFlows).toBe(1)
    r.onStreamEnd(0, 3, 'fin', undefined, 9)
    expect(r.take().runs.map((x) => [x.n, x.end, x.eog, x.cont])).toEqual([[2, 'fin', true, false]])
  })

  it('keeps the reset code across a take that seals nothing', () => {
    const r = new RunRecorder(0)
    twoObjects(r)
    r.take(true)
    r.onStreamEnd(0, 3, 'reset', 7, 9)
    expect(r.take().runs.map((x) => [x.n, x.end, x.rc])).toEqual([[2, 'reset', 7n]])
  })

  it('records the end alone once its run was taken, with the run’s last object', () => {
    for (const [end, code, want] of [
      ['fin', undefined, [true, 'fin', 7n, 1n, null, 9000]],
      ['reset', 7, [false, 'reset', 7n, 1n, 7n, 9000]],
    ] as const) {
      const r = new RunRecorder(0)
      twoObjects(r)
      expect(r.take().runs.map((x) => [x.n, x.end])).toEqual([[2, 'open']])
      r.onStreamEnd(0, 3, end, code, 9)
      const { runs, ends } = r.take()
      expect(runs).toEqual([])
      expect(ends.map((e) => [e.eog, e.end, e.g, e.o, e.rc, e.tUs])).toEqual([want])
    }
  })

  it('in a worker, forwards the end alone, and the page joins it to the run', () => {
    for (const [end, code, want] of [
      ['fin', undefined, [2, 'fin', true, null]],
      ['reset', 7, [2, 'reset', false, 7n]],
    ] as const) {
      const w = new RunRecorder(0)
      twoObjects(w)
      const first = w.take()
      w.onStreamEnd(0, 3, end, code, 9)
      const second = w.take()
      expect(second.runs).toEqual([])
      expect(second.ends).toHaveLength(1)
      const page = new RunRecorder(0)
      page.absorb(first)
      // A take between forwards that seals nothing keeps the forwarded run open.
      expect(page.take(true).runs).toEqual([])
      page.absorb(second)
      const out = page.take()
      expect(out.runs.map((x) => [x.n, x.end, x.eog, x.rc])).toEqual([want])
      expect(out.ends).toEqual([])
    }
  })

  it('keeps a forwarded end whose run a seal already took as a stream end', () => {
    const w = new RunRecorder(0)
    twoObjects(w)
    const page = new RunRecorder(0)
    page.absorb(w.take())
    expect(page.take().runs.map((x) => x.end)).toEqual(['open'])
    w.onStreamEnd(0, 3, 'fin', undefined, 9)
    page.absorb(w.take())
    const { runs, ends } = page.take()
    expect(runs).toEqual([])
    expect(ends.map((e) => [e.end, e.eog, e.g, e.o])).toEqual([['fin', true, 7n, 1n]])
  })

  it('records no end for a stream that failed', () => {
    const r = new RunRecorder(0)
    twoObjects(r)
    r.take()
    r.onStreamEnd(0, 3, 'gone', undefined, 9)
    expect(r.take().ends).toEqual([])
  })
})

describe('a stream that carried no object', () => {
  const header = (path: 'sub_stream' | 'fetch', g: bigint | null, eog = false) => ({
    key: path === 'fetch' ? FETCH : ALIAS,
    streamId: 3,
    path,
    groupId: g,
    eog,
    at: 1,
  })

  it('ends with its header’s group, EOG only with FIN', () => {
    const r = new RunRecorder(0)
    r.onStreamHeader(0, header('sub_stream', 102n, true))
    expect(r.onStreamEnd(0, 3, 'fin', undefined, 5)).toEqual({ key: ALIAS, g: 102n })
    r.onStreamHeader(0, { ...header('sub_stream', 103n, true), streamId: 7 })
    expect(r.onStreamEnd(0, 7, 'reset', 2, 6)).toBeUndefined()
    expect(r.take().ends.map((e) => [e.path, e.sid, e.eog, e.end, e.g, e.o, e.rc])).toEqual([
      ['sub_stream', 3, true, 'fin', 102n, null, null],
      ['sub_stream', 7, false, 'reset', 103n, null, 2n],
    ])
  })

  it('ends a fetch stream with no group', () => {
    const r = new RunRecorder(0)
    r.onStreamHeader(0, header('fetch', null))
    r.onStreamEnd(0, 3, 'reset', 2, 5)
    expect(r.take().ends.map((e) => [e.path, e.end, e.g, e.o, e.rc])).toEqual([
      ['fetch', 'reset', null, null, 2n],
    ])
  })

  it('records a send stream’s header not at all', () => {
    const r = new RunRecorder(0)
    r.onStreamHeader(0, { ...header('sub_stream', 1n), key: { ...ALIAS, dir: 'tx' } })
    r.onStreamEnd(0, 3, 'fin', undefined, 5)
    expect(r.take().ends).toEqual([])
  })
})

describe('datagram runs', () => {
  it('keep ids in arrival order, a repeat included, one run per group', () => {
    const r = new RunRecorder(0)
    for (const [o, at] of [
      [5n, 1],
      [3n, 2],
      [4n, 3],
      [4n, 4],
    ] as const)
      r.onObject(0, datagram(40n, o, at))
    r.onObject(0, datagram(41n, 0n, 5, true))
    const { runs } = r.take()
    expect(runs.map((x) => [x.g, runIds(x), x.end, x.eog])).toEqual([
      [40n, [5n, 3n, 4n, 4n], 'na', false],
      [41n, [0n], 'na', true],
    ])
  })

  it('continue across a seal', () => {
    const r = new RunRecorder(0)
    r.onObject(0, datagram(40n, 0n, 1))
    r.take()
    r.onObject(0, datagram(40n, 1n, 2))
    expect(r.take().runs[0]?.cont).toBe(true)
  })
})

describe('marks', () => {
  it('maps each status by the connection’s draft', () => {
    expect(statusKind(1n, 15)).toBe('dne')
    expect(statusKind(1n, 16)).toBe('status_unknown')
    expect(statusKind(3n, 22)).toBe('eog')
    expect(statusKind(4n, 7)).toBe('eotg')
    expect(statusKind(4n, 10)).toBe('eotg')
    expect(statusKind(4n, 11)).toBe('eot')
    expect(statusKind(5n, 7)).toBe('eosg')
    expect(statusKind(5n, 9)).toBe('eot')
    expect(statusKind(5n, 11)).toBe('status_unknown')
    expect(statusKind(2n, 20)).toBe('status_unknown')
  })

  it('records a status, a range marker and a gap as received', () => {
    const r = new RunRecorder(0)
    r.onMark(0, 22, obj(7n, 5n, 1, { status: 9n, payloadBytes: 0 }))
    const range: MarkSample = {
      key: FETCH,
      what: { range: 0x20c, g2: 13n, o2: 9n, first: false },
      groupId: 13n,
      objectId: 0n,
      path: 'fetch',
      streamId: 5,
      at: 2,
    }
    r.onMark(0, 22, range)
    r.onMark(0, 22, {
      ...range,
      what: { range: 0x8c, g2: 4n, o2: 1n, first: true },
      groupId: 4n,
      objectId: 1n,
    })
    r.onMark(0, 22, { ...range, key: ALIAS, what: { gap: 'object', n: 2n }, path: 'datagram' })
    const { marks, runs } = r.take()
    expect(runs).toEqual([])
    expect(marks.map((m) => [m.kind, m.g, m.o, m.g2, m.o2, m.n, m.path, m.sid])).toEqual([
      ['status_unknown', 7n, 5n, undefined, undefined, 9n, 'sub_stream', 3],
      ['rng_to', 13n, 0n, 13n, 9n, 0n, 'fetch', 5],
      ['rng_nx', 4n, 1n, 4n, 1n, 1n, 'fetch', 5],
      ['pog', 13n, 0n, undefined, undefined, 2n, 'datagram', 5],
    ])
  })
})

describe('draft-23 fetch indicators', () => {
  const fetchObj = (g: bigint, o: bigint, at: number): ObjectSample =>
    obj(g, o, at, { key: FETCH, path: 'fetch', sub: 0n, foKnown: false })
  const end = (what: 'group' | 'track', g: bigint, o: bigint): MarkSample => ({
    key: FETCH,
    what: { end: what },
    groupId: g,
    objectId: o,
    path: 'fetch',
    streamId: 3,
    at: 9,
  })

  it('maps End-of-Range markers by the connection’s draft, End of Gone Range from 23', () => {
    expect(rangeKind(0x8c, 16)).toBe('rng_nx')
    expect(rangeKind(0x10c, 23)).toBe('rng_unk')
    expect(rangeKind(0x20c, 19)).toBeUndefined()
    expect(rangeKind(0x20c, 20)).toBe('rng_to')
    expect(rangeKind(0x40c, 22)).toBeUndefined()
    expect(rangeKind(0x40c, 23)).toBe('rng_gone')
    expect(rangeKind(0x80, 23)).toBeUndefined()
  })

  it('ends the group on the run holding the Object End of Group follows', () => {
    const r = new RunRecorder(0)
    r.onObject(0, fetchObj(5n, 0n, 1))
    r.onObject(0, fetchObj(5n, 1n, 2))
    r.onMark(0, 23, end('group', 5n, 1n))
    r.onObject(0, fetchObj(6n, 0n, 3))
    r.onStreamEnd(0, 3, 'fin', undefined, 9)
    const { runs, marks } = r.take()
    expect(runs.map((x) => [x.g, x.eog, x.end])).toEqual([
      [5n, true, 'open'],
      [6n, false, 'fin'],
    ])
    expect(marks).toEqual([])
  })

  it('ends the group on End of Track, and marks End of Track past its Object', () => {
    const r = new RunRecorder(0)
    r.onObject(0, fetchObj(9n, 4n, 1))
    r.onMark(0, 23, end('track', 9n, 4n))
    const { runs, marks } = r.take()
    expect(runs[0]?.eog).toBe(true)
    expect(marks.map((m) => [m.kind, m.g, m.o, m.path, m.sid])).toEqual([
      ['eot', 9n, 5n, 'fetch', 3],
    ])
  })

  it('leaves a run whose last Object is another alone', () => {
    const r = new RunRecorder(0)
    r.onObject(0, fetchObj(5n, 0n, 1))
    r.onMark(0, 23, end('group', 5n, 3n))
    expect(r.take().runs[0]?.eog).toBe(false)
  })

  it('carries a worker’s End of Group across a forward to the run it ends', () => {
    const worker = new RunRecorder(0)
    const page = new RunRecorder(0)
    worker.onObject(9, fetchObj(5n, 0n, 1))
    page.absorb(worker.take())
    worker.onMark(9, 23, end('group', 5n, 0n))
    page.absorb(worker.take())
    const { runs, ends } = page.take()
    expect(runs.map((x) => [x.g, x.n, x.eog])).toEqual([[5n, 1, true]])
    expect(ends).toEqual([])
  })

  it('records End of Group alone once its run was taken, then the FIN', () => {
    const r = new RunRecorder(0)
    r.onObject(9, fetchObj(40n, 7n, 1))
    r.take()
    r.onMark(9, 23, end('group', 40n, 7n))
    r.onStreamEnd(9, 3, 'fin', undefined, 10)
    expect(r.take().ends.map((e) => [e.eog, e.end, e.g, e.o])).toEqual([
      [true, 'none', 40n, 7n],
      [false, 'fin', 40n, 7n],
    ])
  })
})

describe('across realms and bounds', () => {
  it('joins a forwarded piece to the run it continues, in the same interval', () => {
    const worker = new RunRecorder(0)
    const page = new RunRecorder(0)
    worker.onObject(9, obj(7n, 0n, 1))
    worker.onObject(9, obj(7n, 1n, 2))
    page.absorb(worker.take())
    worker.onObject(9, obj(7n, 2n, 3))
    worker.onStreamEnd(9, 3, 'fin', undefined, 9)
    page.absorb(worker.take())
    const { runs } = page.take()
    expect(runs.map((x) => [runIds(x), x.end, x.cont, x.times])).toEqual([
      [[0n, 1n, 2n], 'fin', false, [1000, 2000, 3000]],
    ])
  })

  it('keeps a forwarded continuation as cont when what it continues went in an earlier body', () => {
    const worker = new RunRecorder(0)
    const page = new RunRecorder(0)
    worker.onObject(9, obj(7n, 0n, 1))
    page.absorb(worker.take())
    page.take()
    worker.onObject(9, obj(7n, 1n, 2))
    page.absorb(worker.take())
    expect(page.take().runs.map((x) => x.cont)).toEqual([true])
  })

  it('asks for an early seal when its open flows reach the cap', () => {
    let full = 0
    const r = new RunRecorder(0, () => full++)
    for (let g = 0; g < MAX_OPEN_FLOWS; g++) r.onObject(0, datagram(BigInt(g), 0n, 1))
    expect(full).toBe(1)
    expect(r.openFlows).toBe(MAX_OPEN_FLOWS)
    r.take()
    expect(r.openFlows).toBe(0)
  })

  it('closes a connection’s runs where they stood', () => {
    const r = new RunRecorder(0)
    r.onObject(1, obj(7n, 0n, 1))
    r.onObject(1, datagram(8n, 0n, 1))
    r.onConnClose(1)
    expect(r.openFlows).toBe(0)
    expect(r.take().runs.map((x) => x.end)).toEqual(['open', 'na'])
  })
})
