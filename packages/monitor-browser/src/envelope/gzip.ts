/**
 * `CompressionStream('gzip')`.
 *
 * "Compress with `CompressionStream('gzip')` — platform-native, no dependency,
 * no CSP allowance." Platform-native gzip is the only compressor in the
 * package, and this file is it.
 *
 * Two functions, deliberately: a *predicate* and a *doer*. `encodeBody` in
 * `./body.ts` is the one that never throws, and it can only make that promise
 * if it is allowed to see the failure — so {@link gzip} rejects rather than
 * silently returning the input, and {@link gzipSupported} answers the cheap
 * question without constructing anything.
 *
 * What it achieves depends on the records more than on the compressor: in a
 * ~32 KB segment, with no dictionary shared between segments, of flight dump
 * columns, jittered arrival times compress far worse than evenly spaced ones,
 * about 4× in the tests.
 */

/**
 * Whether `CompressionStream('gzip')` exists here.
 *
 * `typeof` on a possibly-undeclared global is safe; a bare reference is not.
 * The check is `=== 'function'` rather than `!== 'undefined'` because a test
 * or a polyfill shim may leave the name bound to a non-constructor.
 */
import { MQ2201 } from '../codes.js'

export function gzipSupported(): boolean {
  return typeof CompressionStream === 'function'
}

/**
 * A view the platform compressor will accept.
 *
 * `CompressionStream`'s writable takes a WebIDL `BufferSource`, which is not
 * `[AllowShared]`: a `SharedArrayBuffer`-backed view is a `TypeError` at
 * runtime, and TypeScript 5.7's typed `ArrayBufferLike` says the same thing at
 * compile time. Nothing in this package produces one — `FrameWriter` allocates
 * its own buffers — but `gzip` is exported, and a caller in a cross-origin
 * isolated page could hand one over. The shared case is copied rather than
 * thrown at; the ordinary case is re-viewed, not copied, so a 32 KB batch
 * still reaches the compressor without a second allocation.
 */
function asBufferSource(input: Uint8Array): Uint8Array<ArrayBuffer> {
  const buffer = input.buffer
  if (buffer instanceof ArrayBuffer) {
    return new Uint8Array(buffer, input.byteOffset, input.byteLength)
  }
  const copy = new Uint8Array(input.byteLength)
  copy.set(input)
  return copy
}

/**
 * Bytes handed to the compressor in one task. `CompressionStream` compresses
 * each chunk as it is written, on the thread that writes it, so a large input
 * written whole is one long task: 272 KB of object headers takes about 5 ms
 * on a desktop, and several times that on a low-end phone, on a player's
 * main thread. Written in pieces this long, with a task between them, no task
 * compresses more than about a millisecond's worth on a desktop.
 */
const PIECE_BYTES = 32 * 1024

/** The next task: a message to a channel of its own, which no timer clamps or fakes. */
function nextTask(): Promise<void> {
  return new Promise((resolve) => {
    const c = new MessageChannel()
    c.port1.onmessage = () => {
      c.port1.close()
      resolve()
    }
    c.port2.postMessage(0)
  })
}

/**
 * Gzip one buffer, whole, written to the compressor in pieces of
 * {@link PIECE_BYTES} with a task between them.
 *
 * Rejects when `CompressionStream` is missing or the stream errors. Callers on
 * the upload path must go through {@link encodeBody}, which catches; this is
 * exported raw because a caller that wants to *know* compression failed —
 * a test, a size probe — cannot learn it from a silent fallback.
 *
 * `input` is read asynchronously by the platform's compressor and must not be
 * mutated until the returned promise settles. Everything on the upload path
 * hands over the buffer `FrameWriter.take()` just produced, which nothing else
 * holds.
 */
export async function gzip(input: Uint8Array): Promise<Uint8Array> {
  if (!gzipSupported()) {
    throw new Error(MQ2201)
  }
  const cs = new CompressionStream('gzip')
  const writer = cs.writable.getWriter()

  // Write and read CONCURRENTLY. A transform stream's queues are bounded, so
  // draining the writer first — `await writer.write(big); await writer.close()`
  // before reading a byte — deadlocks as soon as the compressor produces more
  // output than one internal chunk. Measured against this workspace's Node
  // (v24): the naive form completes at 16,000 B of incompressible input
  // (16,023 B out) and hangs at 16,384 B (16,409 B out) — the 16 KB chunk
  // boundary, and a property of the OUTPUT, not the input. A 32 KB seal (the
  // item 1) full of repetitive rollup JSON stays under it; the same seal
  // carrying raw control and header bytes does not. The naive form would
  // therefore hang on exactly the sessions with the most to report.
  const written = (async () => {
    const view = asBufferSource(input)
    for (let at = 0; at < view.byteLength || at === 0; at += PIECE_BYTES) {
      if (at > 0 && typeof MessageChannel === 'function') await nextTask()
      await writer.write(view.subarray(at, at + PIECE_BYTES))
    }
    await writer.close()
  })()
  // Never let that promise float: if the read loop throws first we return
  // without awaiting it, and an unattended rejection would surface as an
  // unhandled rejection inside the customer's page.
  written.catch(() => {})

  const reader = cs.readable.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value !== undefined) {
        chunks.push(value)
        total += value.length
      }
    }
  } finally {
    reader.releaseLock()
  }
  await written

  const out = new Uint8Array(total)
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.length
  }
  return out
}
