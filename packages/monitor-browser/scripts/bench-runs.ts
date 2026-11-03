/**
 * `bun run bench` — CPU per object of what a v2 viewer adds: the run
 * recorder on the data path, the encoding of its runs into records at the
 * seal, and the per-capture clock-break check, against the rollup's own
 * `onObject`, which every object already pays.
 *
 * Three shapes: a 30 fps video subgroup stream (one run per group), 20 ms
 * audio objects one per stream, and datagrams. Each stream's header is
 * reported before its first object, as the decoders do. Each is fed through the
 * recorder with a take every 60 s of media, as a page seals, and each take
 * is encoded as the seal encodes it. Timed with `performance.now()` over
 * enough objects to swamp its resolution. Prints ns per object for the
 * recorder alone, for encoding, and for both; never fails on a number.
 */

import { ClockSync } from '../src/flush/clock-sync.js'
import { Emitter, encodeFacts } from '../src/flush/emitter.js'
import { RollupEngine } from '../src/rollup/interval.js'
import { RunRecorder, type Taken } from '../src/rollup/runs.js'
import type { BucketKey, EnvelopeRecord, ObjectSample } from '../src/types.js'

const OBJECTS = 2_000_000
const ROUNDS = 5

const KEY: BucketKey = Object.freeze({ dir: 'rx', kind: 'alias', id: 4n, epoch: 0 })

/** `n` samples of one shape, each with its own arrival time in ms. */
function shape(kind: 'video' | 'audio' | 'datagram', n: number): ObjectSample[] {
  const out: ObjectSample[] = []
  for (let i = 0; i < n; i++) {
    const at = kind === 'audio' ? i * 20 : i * 33.3
    const perGroup = kind === 'video' ? 8 : 1
    const group = BigInt(Math.floor(i / perGroup))
    const object = BigInt(i % perGroup)
    const base = {
      key: KEY,
      groupId: group,
      objectId: object,
      headerBytes: 4,
      payloadBytes: kind === 'video' ? 5_000 : 160,
      at,
      fo: false,
      foKnown: true,
      eog: false,
    }
    out.push(
      kind === 'datagram'
        ? { ...base, foKnown: false, path: 'datagram', sub: null }
        : { ...base, streamId: kind === 'video' ? Number(group) : i, path: 'sub_stream', sub: 0n },
    )
  }
  return out
}

function time(run: () => void): number {
  let best = Number.POSITIVE_INFINITY
  for (let r = 0; r < ROUNDS; r++) {
    const t0 = performance.now()
    run()
    best = Math.min(best, performance.now() - t0)
  }
  return (best * 1e6) / OBJECTS
}

const sink = { json: (_r: EnvelopeRecord) => {}, raw: (_b: Uint8Array) => {} }
const clock = { now: () => performance.now(), wall: () => Date.now() }

for (const kind of ['video', 'audio', 'datagram'] as const) {
  const objects = shape(kind, OBJECTS)
  const perTake = kind === 'video' ? 1_800 : 3_000

  const record = (onTake: (t: Taken) => void) => () => {
    const r = new RunRecorder(0)
    for (let i = 0; i < objects.length; i++) {
      const s = objects[i] as ObjectSample
      if (s.streamId !== undefined && s.objectId === 0n) {
        r.onStreamHeader(0, { ...s, streamId: s.streamId, path: s.path, groupId: s.groupId })
      }
      r.onObject(0, s)
      if (kind === 'audio' && s.streamId !== undefined) {
        r.onStreamEnd(0, s.streamId, 'fin', undefined, s.at)
      }
      if (kind === 'video' && s.objectId === 7n && s.streamId !== undefined) {
        r.onStreamEnd(0, s.streamId, 'fin', undefined, s.at)
      }
      if (i % perTake === perTake - 1) onTake(r.take())
    }
  }
  const recorder = time(record(() => {}))
  const both = time(
    record((t) => {
      encodeFacts(new Emitter('bench', 0), t, () => {})
    }),
  )

  const rollup = time(() => {
    const e = new RollupEngine({ intervalMs: 10_000, maxBuckets: 64, clock, sink })
    for (const s of objects) e.onObject(s)
  })

  const check = time(() => {
    const c = new ClockSync()
    for (let i = 0; i < objects.length; i++) c.check(Date.now(), performance.now())
  })

  const ns = (v: number) => v.toFixed(0).padStart(4)
  console.log(
    `${kind.padEnd(9)} recorder ${ns(recorder)}   encode ${ns(both - recorder)}   ` +
      `both ${ns(both)} ns/object   break check ${ns(check)} ns   rollup onObject ${ns(rollup)} ns`,
  )
}
