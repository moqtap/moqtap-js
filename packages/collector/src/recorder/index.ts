/**
 * `@moqtap/collector` — the flight recorder.
 *
 * Three files and one promise: **armed costs nothing**.
 *
 *  - `triggers.ts` decides *that* a capture window should open. The cadence
 *    trigger is a multiple of the track's own observed median rather than a
 *    millisecond figure, and it does not fire until that median is warm.
 *  - `replay.ts` re-parses the ring at full resolution, once, on a trigger, and
 *    recovers the per-object wire timings and delivery durations no
 *    after-the-fact instrumentation can produce.
 *  - `columnar.ts` turns them into **one** record with six parallel arrays —
 *    never one row per object, which is the shape the O(1) budget exists to avoid.
 *
 * Nothing in this module runs while merely armed. The ring overwrites itself and
 * no byte of it is parsed, which is what makes the "we do not bill for
 * readiness" a property of the implementation rather than a claim about it.
 *
 * The only thing that crosses from the ring to the wire is derived records
 * payload bytes are skipped by arithmetic and never viewed, copied or
 * measured for content.
 */

export type { ColumnarBlock, ObjectTiming } from './columnar.js'
export { encodeColumnar, roundMs, TIME_DECIMALS } from './columnar.js'
export type { FlightRecorderOptions, ReplayOptions, ReplayResult, ReplayWindow } from './replay.js'
export {
  DATAGRAM_STREAM_ID,
  DEFAULT_MAX_OBJECTS,
  FlightRecorder,
  ReplayKeys,
  replayRing,
  replayWindow,
} from './replay.js'
export type { MedianSource, TriggerEngineOptions, TriggerEvent } from './triggers.js'
export {
  DEFAULT_MAX_TRACKED,
  DEFAULT_TRIGGER_COOLDOWN_MS,
  TriggerEngine,
} from './triggers.js'
