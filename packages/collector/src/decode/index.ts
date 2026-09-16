/**
 * The counting decoder: parse an object header, update per-bucket counters,
 * **discard**.
 *
 * "This is the decision that makes the product economic: the expensive thing is
 * not *observing* objects, it is *recording one event per object*." Every export
 * below is shaped by that sentence — the walks return byte counts and ids, never
 * a payload view; the counters hold O(1) state per stream; and the only thing
 * that crosses into the rollup is a {@link ObjectSample} that is folded and
 * dropped.
 *
 * The header walks are hand-rolled, which the spec does not budget for and which
 * is not a preference:
 *
 *  - **No exported codec function reports a header's byte length without
 *    materialising the payload.** `decodeSubgroupStream` needs the whole stream
 *    in one buffer and returns every object with a `payload` view.
 *  - **A `@moqtap/codec` below 0.11.0 decodes these streams wrongly, and that
 *    is still not why this walk exists.** In 0.10.0 and earlier
 *    `createSubgroupStreamDecoder` reads Object Payload Length and then the
 *    payload with no `payloadLength === 0 -> readVarInt status` branch, so one
 *    status object desynchronises the stream and everything after it is
 *    garbage -- silently, because a varint read at the wrong offset yields a
 *    plausible number rather than an error, and `createDataStreamDecoder`
 *    selects an inner decoder and never feeds it. From 0.11.0 a cross-draft
 *    test holds the streaming and one-shot decoders to returning the same
 *    thing for the same bytes.
 *
 *    **The first reason above is the load-bearing one.** Measured in Chrome on
 *    real capture shapes, this walk costs
 *    170-240 ns per object at the median where the codec's streaming decoder
 *    costs 11.5-14.4 us fed in 16 KB chunks -- some sixty times more, most of
 *    it the buffer it regrows and recopies on every chunk. Parse-and-discard is
 *    a different job from decode-and-materialise.
 *  - `createStreamDecoder` calls `controller.error()` on
 *    `UNKNOWN_MESSAGE_TYPE`, killing the control plane for the whole session.
 */

export { ControlFramer, MAX_CONTROL_FRAME_BYTES } from './control-framer.js'
export { countDatagram } from './datagram-counter.js'
export type {
  DispatcherOptions,
  RecordedStream,
  ReplayEvent,
  ReplayOptions,
  ReplayStats,
  RollupExtensions,
} from './dispatch.js'
export {
  CountingStats,
  recordedStreamEvents,
  replay,
  replayStreams,
  StreamDispatcher,
  sniffStream,
} from './dispatch.js'
export type { FetchCounterOptions, FetchObjectInfo } from './fetch-counter.js'
export { FetchCounter, readFetchHeader, readFetchObject } from './fetch-counter.js'
export type { Desync, ParseRun } from './stream-walk.js'
export { DataStreamCounter, DEFAULT_HEADER_SLACK_BYTES, DESYNC } from './stream-walk.js'
export type { CounterOptions } from './subgroup-counter.js'
export { readSubgroupHeader, readSubgroupObject, SubgroupCounter } from './subgroup-counter.js'
export type { ExchangeLatency, TrackKeysOptions } from './track-key.js'
export { DEFAULT_MAX_BUCKETS, TrackKeys } from './track-key.js'
