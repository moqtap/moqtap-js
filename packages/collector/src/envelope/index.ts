/**
 * The envelope module — framing, compression and keying.
 *
 * The wire contract, and the only part of the collector whose output shape
 * ingest depends on. Everything above it (the rollup, the decoder, the flight
 * recorder) writes `EnvelopeRecord`s into a `RecordSink` and knows nothing about
 * bytes; everything below it (the uploader, the beacon) moves an opaque
 * `Uint8Array`. This is the seam.
 *
 * One body looks like this, on both delivery paths:
 *
 *     +--------------------------------+
 *     | 4d 51 54 43  ver  flags  00 00 |  8-byte preamble, never compressed
 *     +--------------------------------+
 *     | [u32 len][json] batch record   |  ALWAYS the first frame: it carries
 *     | [u32 len][json] ...            |  the idempotency key that sendBeacon
 *     | [u32 len][raw ] ...            |  cannot put in a header
 *     +--------------------------------+   ^ optionally gzipped as one unit
 *
 * Three gaps in the spec are resolved here, each documented where it is
 * implemented:
 *
 *  1. **Frame type discrimination** — bit 31 of the u32 length prefix
 *     (`frame-writer.ts`). The envelope interleaves JSON and raw frames and never says
 *     how a reader tells them apart.
 *  2. **The body preamble** — The `sendBeacon` path can set no request
 *     headers, so it can announce neither `Content-Encoding: gzip` nor an
 *     `Idempotency-Key`, and the envelope assumes both (`body.ts`).
 *  3. **Async keying** — the digest is sha256 and it has to be stamped
 *     stamped at creation, but `crypto.subtle.digest` is asynchronous and
 *     absent on insecure origins (`idempotency.ts`).
 */

export {
  BODY_MAGIC,
  BODY_PREAMBLE_BYTES,
  BODY_VERSION,
  type BodyPreamble,
  encodeBody,
  readPreamble,
  writePreamble,
} from './body.js'
export { FrameWriter, readFrames } from './frame-writer.js'
export { gzip, gzipSupported } from './gzip.js'
export { idempotencyKey, idempotencyKeySync, subtleAvailable } from './idempotency.js'
