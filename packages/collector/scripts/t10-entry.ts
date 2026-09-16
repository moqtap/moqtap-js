/**
 * Browser entry for the T10 measurement: the counting decoder, and nothing else.
 *
 * The `SubgroupCounter` is what actually runs in a customer's page — the
 * codec's decoders do not, because "parse a header, update counters, discard"
 * is not what either of them offers. Measuring the codec instead would measure
 * a path this product never takes.
 *
 * The sink counts and drops. Anything that retained an object would turn a
 * decode benchmark into an allocation benchmark.
 */

import { SubgroupCounter } from '../src/decode/subgroup-counter.js'
import { TrackKeys } from '../src/decode/track-key.js'
import { VI64_READER } from '../src/draft/varint.js'
import type {
  BucketKey,
  ControlFrameEvent,
  CountingSink,
  ParseFailureReason,
} from '../src/types.js'

class NullSink implements CountingSink {
  objects = 0
  failures = 0
  onObject(): void {
    this.objects++
  }
  onControlFrame(_e: ControlFrameEvent): void {}
  onParseFailure(_k: BucketKey | null, _r: ParseFailureReason): void {
    this.failures++
  }
}

export interface BenchResult {
  objectsCounted: number
  failures: number
  nsPerObject: number[]
}

/** Feed each stream through a fresh counter, in `chunkSize` pieces. */
export function benchCounter(
  streams: readonly Uint8Array[],
  chunkSize: number,
  reps: number,
  warmup: number,
): BenchResult {
  const out: number[] = []
  let counted = 0
  let failures = 0
  for (let rep = 0; rep < reps; rep++) {
    const sink = new NullSink()
    const t0 = performance.now()
    for (const s of streams) {
      const c = new SubgroupCounter('rx', new TrackKeys(), sink, VI64_READER)
      for (let i = 0; i < s.length; i += chunkSize) {
        c.push(s.subarray(i, Math.min(i + chunkSize, s.length)), 100)
      }
      c.end()
    }
    const dt = performance.now() - t0
    if (rep >= warmup && sink.objects > 0) out.push((dt * 1e6) / sink.objects)
    counted = sink.objects
    failures = sink.failures
  }
  return { objectsCounted: counted, failures, nsPerObject: out }
}
