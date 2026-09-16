/**
 * The flush module — everything between a record being produced and bytes
 * arriving at ingest.
 *
 * ── **Sealing is not releasing.**
 *
 *  - **Sealing** — {@link FlushSchedule} and {@link FlushQueue.seal} — decides
 *    when a chunk is *built, keyed and persisted*. Its cadence is fixed and
 *    congestion never touches it.
 *  - **Release** — {@link ReleasePacer} — decides only how fast already-sealed
 *    chunks leave the device. It can *slow* release; it can never seal less
 *    often.
 *
 * That split is what keeps "a crash loses at most 60 seconds" true. If pressure
 * could stretch the sealing interval instead, an hour of congestion would leave
 * an hour of unkeyed, unpersisted records in memory — and the crash that
 * congestion makes likely would take all of it.
 *
 * ── Why the pacer slows down at all.
 *
 * Flight-recorder mode raises our output at the exact moment the network is
 * worst — the trigger *is* a network-trouble signal — so flushing on trigger
 * would do two harms: our upload competes with the media and makes the user's
 * stall worse, **and the measurement is biased by the act of measuring**,
 * because we would be recording a degradation we contribute to. The signal is
 * **object arrival rate**: already computed for the rollup, needs no probe of
 * our own, and measures the bottleneck the player actually cares about.
 *
 * ── Keying happens at creation.
 *
 * {@link FlushQueue.seal} allocates and *persists* the segment number, derives
 * `sha256(sessionId:segmentSeq)`, writes the batch frame, encodes the body, and
 * only then hands anything to storage or to the uploader. A chunk keyed at
 * upload time instead would get a fresh key after a reload and be counted twice.
 * {@link ChunkStore} never derives a key; it uses the one it is given as its
 * primary key, which is what makes "delete what ingest confirmed" exact.
 *
 * ── The ring is not here.
 *
 * IndexedDB persists **the flush buffer only**. The flight-recorder ring holds
 * raw wire bytes with payloads included; persisting it would put the customer's
 * end users' media into origin storage on their device. Nothing in this module
 * accepts, stores or forwards a ring entry: the only path from the ring is a
 * trigger that re-parses it into *derived* records, which arrive here as
 * ordinary {@link RecordSink} traffic.
 *
 * ── What the integrating module owes this one. There is deliberately no driver
 * class here — the api module owns the release loop — so its rules are written
 * down rather than encoded.
 *
 *  1. **Release order is segment order.** Walk {@link ChunkStore.pending} —
 *     index rows, oldest segment first, already in memory — and load one body at
 *     a time with {@link ChunkStore.get}, waiting
 *     {@link ReleasePacer.nextReleaseDelayMs} between sends. Do not start from
 *     {@link ChunkStore.list} on a page load: it materialises a whole session's
 *     bodies, which after a long offline stretch is the entire storage quota in
 *     one allocation.
 *  2. **Delete only what ingest confirmed.** On `ok`, delete by
 *     `chunk.idempotencyKey`. On a terminal outcome
 *     ({@link UploadOutcome.terminal}, a non-retryable 4xx) delete too — ingest
 *     will refuse that body forever, and counting a drop beats spinning. On any
 *     other failure **keep it**: that is what the persistence is for.
 *  3. **`stop()` must not clear an unflushed backlog.** An ordinary `stop()`
 *     while offline would flush (fail), then clear — destroying precisely the
 *     durability IndexedDB exists for, since the backlog is largest exactly when
 *     the session is most worth having. So `stop()` seals, releases what it can,
 *     and deletes only what was confirmed; **only `abort()` calls
 *     {@link ChunkStore.clearSession} unconditionally.**
 *  4. **`pagehide` takes the synchronous path.** {@link FlushQueue.sealSync}
 *     followed by {@link sendTail}. The page may not survive a single `await`, so
 *     that path neither compresses (`CompressionStream` is asynchronous by
 *     construction) nor persists, and its key comes from the non-secure-context
 *     fallback with `BatchRecord.keyFallback` set — because a fallback key has
 *     different collision properties and ingest dedupes exactly.
 *  5. **{@link Uploader.send}'s `maxAttempts` is per call, not per chunk.**
 *     `chunk.attempts` accumulates across calls; a caller that re-queues a chunk
 *     forever should read it and give up.
 *  6. **A drain that a page is awaiting carries a deadline.** `stop()` is
 *     awaited by the customer's own teardown, so it makes one
 *     {@link deadlineSignal} from `Limits.stopDrainDeadlineMs` and passes it to
 *     every {@link Uploader.send} in the drain. On expiry `send` returns a
 *     non-terminal failure and rule 2 keeps the chunk — the deadline gives up
 *     on *this* attempt, never on the data.
 */

export { BEACON_MAX_BYTES, type SendTailOptions, sendTail } from './beacon.js'
export { ClockSync } from './clock-sync.js'
export { type Deadline, deadlineSignal, NO_DEADLINE, sleepUntil } from './deadline.js'
export {
  type Chunk,
  type ChunkBackend,
  type ChunkIndexEntry,
  ChunkStore,
  type ChunkStoreOptions,
  IdbBackend,
  MemoryBackend,
  type SeqMeta,
} from './idb.js'
export { ReleasePacer, type ReleasePacerOptions } from './pacer.js'
export { FlushQueue, type FlushQueueOptions } from './queue.js'
export { FlushSchedule, type FlushScheduleOptions, type TimerSource } from './schedule.js'
export { RECV_HEADER, SEND_HEADER, Uploader, type UploaderOptions } from './uploader.js'
