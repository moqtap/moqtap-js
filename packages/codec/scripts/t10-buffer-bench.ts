/**
 * What the streaming decoders' buffering costs, and what emit shape costs.
 *
 * Three buffer policies have shipped or been considered, and this measures all
 * three against each other plus the real decoder end to end. Run it before
 * touching `StreamBuffer` in `src/drafts/draftNN/data-streams.ts`.
 *
 *   1. `preGrowth`   — through 0.10.0. Allocated `unread + chunk.length` and
 *                      copied both halves on *every* chunk.
 *   2. `sizedToNeed` — 0.11.0 as first written. Meant to grow geometrically,
 *                      but charged the consumed prefix against capacity and
 *                      restarted `cap` at 4096 each time, so it sized the new
 *                      array to exactly what was needed and left no room. It
 *                      reallocated on essentially every chunk — the cost it
 *                      was written to remove. Kept here because it looks
 *                      correct and is not.
 *   3. `geometric`   — what ships. Grows until reclaiming the consumed prefix
 *                      leaves the buffer at least half free.
 *
 * None of them compacts in place, and that constraint is what makes this
 * awkward rather than obvious: object payloads are handed out as views into
 * the buffer, so the consumed prefix can only be reclaimed by allocating a
 * fresh array. A realloc is therefore periodically *required*; the policy only
 * decides how often, and how much stays pinned by the views into the old ones.
 *
 * ── Recorded results, 2026-09-08 ────────────────────────────────────────────
 *
 * **The buffer fix, A/B against the previous decoder.** Both decoders built
 * from the same source tree, interleaved in one process so they share
 * conditions, bun 1.3.13, p50 of 11 reps after 4 warmup, ns per object:
 *
 *   object     chunk    sizedToNeed    geometric    delta
 *     6144 B   16 KB          6,418        4,550   -29.1%   <- the capture's shape
 *     6144 B    1 KB         31,821       26,938   -15.3%
 *     1185 B   16 KB          1,423        1,195   -16.0%
 *     1185 B    1 KB          6,474        5,980    -7.6%
 *      200 B   16 KB            594          497   -16.3%
 *      200 B    1 KB          1,329        1,356    +2.0%   <- inside the noise floor
 *   122880 B   16 KB         66,243       52,012   -21.5%
 *   122880 B    1 KB        495,611      477,181    -3.7%
 *
 * The one regression is at 200 B objects in 1 KB chunks, where roughly five
 * objects share a chunk and there is almost no consumed prefix to reclaim, so
 * the extra headroom buys nothing and the wider capacity search costs a little.
 * It is inside the run-to-run floor either way.
 *
 * **Emit shape, measured then rejected.** Chrome 151 headless, real draft-14
 * capture (2081 objects, 6165 B mean), 16 KB chunks, p50 of 9 reps after 3
 * warmup, ns per object:
 *
 *   one-shot (caller supplies a whole buffer)              240
 *   plain callback, no TransformStream                   6,824
 *   TransformStream, per-object enqueue  [status quo]    12,638
 *   TransformStream, batched enqueue     [API change]    11,677   -7.6%
 *   per-object enqueue + this buffer fix [no API chg]    10,908  -13.7%
 *   batched + buffer fix                                  8,794  -30.4%
 *
 * Two things that measurement settled, both against the guess that preceded it:
 *
 *   - **The overhead is not mostly TransformStream.** A plain callback with no
 *     stream machinery at all still costs 6.8 us/object against 240 ns for the
 *     one-shot decoder. The split is roughly 53% buffering, 47% stream. The
 *     one-shot decoder pays no buffering because its caller hands it an
 *     assembled buffer, so comparing the two attributes assembly to the emit
 *     mechanism.
 *   - **Batching the enqueues is not worth an API change.** It wins 7.6% here,
 *     which is at or below the run-to-run floor (the same config varies +/-20%
 *     between runs). Its benefit is entirely a function of how many objects
 *     share a chunk, and this traffic averages 2.6 objects per 16 KB chunk.
 *     Where it does pay is small objects — at 200 B/16 KB it is ~5x (2,280 ->
 *     440 ns), where ~80 objects share a chunk. Revisit only for a consumer
 *     with that profile; the change would break `createSubgroupStreamDecoder`,
 *     `createFetchStreamDecoder` and `createDataStreamDecoder` across 7 drafts
 *     and the `Draft{N}Codec` interfaces that declare them.
 *
 * `highWaterMark` tuning was measured and does nothing (default 4,671 /
 * 1024 -> 4,289 / 1e6 -> 4,607 ns in bun, all inside the spread).
 *
 * Usage: bun run scripts/t10-buffer-bench.ts
 */

import { createSubgroupStreamDecoder, encodeSubgroupStream } from '../src/drafts/draft14/index.js'

interface Result {
  readonly ms: number
  readonly reallocs: number
  readonly copied: number
}

/**
 * The consumer models a decoder: it takes whole objects out of the buffer and
 * leaves a partial one behind, so the unread remainder is what an object's
 * unfinished tail actually is.
 */
type Strategy = (chunks: readonly Uint8Array[], objectSize: number) => Result

/** Through 0.10.0. */
const preGrowth: Strategy = (chunks, objectSize) => {
  let buffer = new Uint8Array(0)
  let offset = 0
  let reallocs = 0
  let copied = 0
  const t0 = performance.now()
  for (const chunk of chunks) {
    if (offset > 0) {
      buffer = buffer.subarray(offset)
      offset = 0
    }
    const next = new Uint8Array(buffer.length + chunk.length)
    next.set(buffer, 0)
    next.set(chunk, buffer.length)
    reallocs++
    copied += buffer.length + chunk.length
    buffer = next
    while (buffer.length - offset >= objectSize) offset += objectSize
  }
  return { ms: performance.now() - t0, reallocs, copied }
}

/** 0.11.0 as first written. Looks geometric, is not. */
const sizedToNeed: Strategy = (chunks, objectSize) => {
  let buf = new Uint8Array(0)
  let len = 0
  let offset = 0
  let reallocs = 0
  let copied = 0
  const t0 = performance.now()
  for (const chunk of chunks) {
    if (len + chunk.length > buf.length) {
      const live = len - offset
      let cap = 4096
      while (cap < live + chunk.length) cap *= 2
      const next = new Uint8Array(cap)
      next.set(buf.subarray(offset, len), 0)
      reallocs++
      copied += live
      buf = next
      len = live
      offset = 0
    }
    buf.set(chunk, len)
    len += chunk.length
    while (len - offset >= objectSize) offset += objectSize
  }
  return { ms: performance.now() - t0, reallocs, copied }
}

/** What ships. Must stay in step with `StreamBuffer.append`. */
const geometric: Strategy = (chunks, objectSize) => {
  let buf = new Uint8Array(0)
  let len = 0
  let offset = 0
  let reallocs = 0
  let copied = 0
  const t0 = performance.now()
  for (const chunk of chunks) {
    if (len + chunk.length > buf.length) {
      const live = len - offset
      const needed = live + chunk.length
      let cap = Math.max(4096, buf.length)
      while (cap < needed * 2) cap *= 2
      const next = new Uint8Array(cap)
      next.set(buf.subarray(offset, len), 0)
      reallocs++
      copied += live
      buf = next
      len = live
      offset = 0
    }
    buf.set(chunk, len)
    len += chunk.length
    while (len - offset >= objectSize) offset += objectSize
  }
  return { ms: performance.now() - t0, reallocs, copied }
}

function makeChunks(total: number, chunkSize: number): Uint8Array[] {
  const src = new Uint8Array(total)
  const out: Uint8Array[] = []
  for (let i = 0; i < total; i += chunkSize) {
    out.push(src.subarray(i, Math.min(i + chunkSize, total)))
  }
  return out
}

const STREAM = 4 << 20 // 4 MB, about a third of one T10 capture

console.log('── buffer policies in isolation ──')
console.log('stream 4 MB, best of 5, reallocations in parentheses\n')
console.log('object    chunk        preGrowth      sizedToNeed        geometric')
for (const objectSize of [6 * 1024, 120 * 1024]) {
  for (const chunkSize of [16384, 1024]) {
    const chunks = makeChunks(STREAM, chunkSize)
    const best = (s: Strategy): Result => {
      let r = s(chunks, objectSize)
      for (let i = 1; i < 5; i++) {
        const next = s(chunks, objectSize)
        if (next.ms < r.ms) r = next
      }
      return r
    }
    const cells = [preGrowth, sizedToNeed, geometric]
      .map(best)
      .map((r) => `${r.ms.toFixed(1)} (${r.reallocs})`.padStart(17))
      .join('')
    console.log(
      `${String(objectSize / 1024).padStart(4)} KB ${String(chunkSize).padStart(6)} B${cells}`,
    )
  }
}

// ── the real decoder, end to end ────────────────────────────────────────────
// The isolation above measures the copy volume the policy controls. This
// measures what a caller actually pays, so the two can be told apart.

// The codec's per-draft stream types are nominal and this builds fixtures for
// them rather than consuming them.
// biome-ignore lint/suspicious/noExplicitAny: see above
type AnyStream = any

function encodeStream(count: number, objectSize: number): Uint8Array {
  const payload = new Uint8Array(objectSize)
  const objects = Array.from({ length: count }, (_, i) => ({
    type: 'object',
    byteOffset: 0,
    payloadByteOffset: 0,
    objectId: BigInt(i),
    payloadLength: objectSize,
    payload,
    extensionData: new Uint8Array(0),
  }))
  return encodeSubgroupStream({
    type: 'subgroup',
    headerType: 0x10,
    trackAlias: 1n,
    groupId: 0n,
    subgroupId: 0n,
    publisherPriority: 128,
    objects,
  } as AnyStream)
}

async function decodeOnce(bytes: Uint8Array, chunkSize: number): Promise<number> {
  const decoder = createSubgroupStreamDecoder()
  const writer = decoder.writable.getWriter()
  const reader = decoder.readable.getReader()

  // Drain concurrently rather than in lockstep: pumping one object at a time
  // measures round-trip latency through the microtask queue, not throughput.
  let seen = 0
  const drain = (async () => {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value && (value as { type?: string }).type === 'object') seen++
    }
  })()

  const t0 = performance.now()
  for (let i = 0; i < bytes.length; i += chunkSize) {
    await writer.write(bytes.subarray(i, Math.min(i + chunkSize, bytes.length)))
  }
  await writer.close()
  await drain
  const ms = performance.now() - t0
  if (seen === 0) throw new Error('decoded nothing — fixture or decoder is wrong')
  return (ms * 1e6) / seen
}

function p50(xs: number[]): number {
  return [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0
}

console.log('\n── the shipped decoder, end to end ──')
console.log('p50 of 9 reps after 3 warmup, ns per object\n')
console.log('object size   chunk size    ns/object')
for (const [count, objectSize] of [
  [2000, 6144],
  [8000, 1185],
  [20000, 200],
] as const) {
  const bytes = encodeStream(count, objectSize)
  for (const chunkSize of [16384]) {
    for (let i = 0; i < 3; i++) await decodeOnce(bytes, chunkSize)
    const runs: number[] = []
    for (let i = 0; i < 9; i++) runs.push(await decodeOnce(bytes, chunkSize))
    console.log(
      `${String(objectSize).padStart(9)} B ${String(chunkSize).padStart(9)} B ` +
        `${p50(runs).toFixed(0).padStart(12)}`,
    )
  }
}
