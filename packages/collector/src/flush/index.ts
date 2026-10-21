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
 * ── Keying happens at the seal.
 *
 * {@link FlushQueue.seal} takes the frames, takes this instance's next sequence
 * number, derives `sha256(sessionId:instanceId:seq)` and writes the batch frame,
 * synchronously and in that order. Compression ({@link compress}) and the
 * IndexedDB copy come afterwards, on a chunk that already exists in the outbox.
 * {@link ChunkStore} never derives a key or a number; it stores what it is
 * given under the key it is given, which is what makes "delete what ingest
 * confirmed" exact.
 *
 * ── The ring is not here.
 *
 * IndexedDB persists **sealed bodies only**. The flight-recorder ring holds
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
 *  1. **Release order is sequence order.** The outbox is drained front to back,
 *     waiting {@link ReleasePacer.nextReleaseDelayMs} between sends.
 *  2. **A body leaves the outbox only on an answer.** On `ok`, or on a terminal
 *     outcome ({@link UploadOutcome.terminal}, a 4xx ingest will repeat
 *     forever), it is removed and its stored copy deleted by
 *     `chunk.idempotencyKey`. On any other failure it stays at the front and is
 *     tried again on the next seal, on `online`, and on a backoff timer.
 *  3. **Stored bodies of a gone instance are swept.** On start-up a page sends
 *     every stored body bound for its own endpoint and key whose instance's
 *     lock is free ({@link heldInstances}), from any session. Walk
 *     {@link ChunkStore.backlog} — index rows, already in memory — and load one
 *     body at a time with {@link ChunkStore.get}.
 *  4. **`pagehide` takes the synchronous path.** Seal, then {@link sendTail} for
 *     every body still unconfirmed: the page may not survive a single `await`.
 *     Each body is also put to the store under its key, so a refused beacon is
 *     sent by the next page load and a delivered one dedupes.
 *  5. **{@link Uploader.send}'s `maxAttempts` is per call, not per chunk.**
 *     `chunk.attempts` accumulates across calls.
 *  6. **A drain that a page is awaiting carries a deadline.** `flush()` and
 *     `end()` are awaited by the customer's own code, so they make one
 *     {@link deadlineSignal} from `upload.drainDeadlineMs` and pass it to every
 *     {@link Uploader.send} in the drain. On expiry `send` returns a
 *     non-terminal failure and rule 2 keeps the chunk — the deadline gives up
 *     on *this* attempt, never on the data.
 */

export { BEACON_MAX_BYTES, type SendTailOptions, sendTail } from './beacon.js'
export { ClockSync } from './clock-sync.js'
export { type Deadline, deadlineSignal, NO_DEADLINE, sleepUntil } from './deadline.js'
export {
  type Chunk,
  type ChunkBackend,
  type ChunkDestination,
  type ChunkIndexEntry,
  ChunkStore,
  type ChunkStoreOptions,
  IdbBackend,
  MemoryBackend,
} from './idb.js'
export {
  heldInstances,
  holdInstanceLock,
  LOCK_PREFIX,
  type LockManagerLike,
  platformLocks,
} from './locks.js'
export { ReleasePacer, type ReleasePacerOptions } from './pacer.js'
export { compress, FlushQueue, type FlushQueueOptions, type SealOptions } from './queue.js'
export { FlushSchedule, type FlushScheduleOptions, type TimerSource } from './schedule.js'
export { RECV_HEADER, SEND_HEADER, Uploader, type UploaderOptions } from './uploader.js'
