/**
 * The body preamble — the resolution of the beacon tail against the envelope.
 *
 * The envelope is one shape: `POST /v1/ingest  Content-Encoding: gzip`, followed
 * by length-prefixed frames. The tail adds a second delivery path — `sendBeacon`
 * at `pagehide` — and **`sendBeacon` cannot set request headers at all**: it
 * sends a body with a Content-Type inferred from the payload type and nothing
 * else. So on that path there is no `Content-Encoding: gzip` to announce
 * compression and no `Idempotency-Key` to carry the key. Both move into the
 * body:
 *
 *  1. **The body announces its own encoding.** Eight plain bytes in front of the
 *     frame stream: a four-byte magic, a version, a flags byte whose bit 0 is
 *     `gzipped`, and two reserved bytes. The preamble is NEVER compressed — it
 *     is the thing that says whether the rest is — so ingest reads eight bytes,
 *     learns the encoding, and decompresses or does not. One body format on both
 *     paths.
 *
 *  2. **The key rides in the first frame.** The first frame of every body, on
 *     both paths, is a `BatchRecord` carrying `idempotencyKey` and `segmentSeq`.
 *     The `fetch()` path sets the `Idempotency-Key` header too, so ingest can
 *     dedupe without decompressing, but the frame is authoritative and always
 *     present. The flush module enforces that rule; this module only guarantees
 *     that two frame streams concatenate byte-for-byte, which is what makes
 *     prepending the batch frame at seal time a `Uint8Array.set` rather than a
 *     re-encode.
 */

import { gzip, gzipSupported } from './gzip.js'

/**
 * `MQTC`. Not a version marker and not a content type — a *shape* marker, so a
 * body that arrives at the wrong endpoint, or a frame stream handed to
 * {@link readPreamble} with its preamble already stripped, is diagnosed in one
 * comparison rather than as a nonsense frame length.
 *
 * Do not mutate it. It cannot be frozen: `Object.freeze` on a non-empty typed
 * array throws, because its indexed properties cannot be made non-configurable.
 */
export const BODY_MAGIC: Uint8Array = new Uint8Array([0x4d, 0x51, 0x54, 0x43])

export const BODY_VERSION = 1

/**
 * Byte length of the preamble. Exported because every reader needs it to find
 * the first frame, and a hard-coded `8` at each of those sites is the way a
 * reserved byte gets claimed without one of them noticing.
 */
export const BODY_PREAMBLE_BYTES = 8

/** Bit 0 of the flags byte: the frames after the preamble are gzip-compressed. */
const FLAG_GZIP = 0x01

export interface BodyPreamble {
  readonly version: number
  readonly gzipped: boolean
}

/**
 * Eight bytes: `4d 51 54 43 | version | flags | 00 00`.
 *
 * The two reserved bytes are written as zero and ignored on read, so a later
 * version can claim them without every existing reader rejecting the body.
 */
export function writePreamble(p: BodyPreamble): Uint8Array {
  const out = new Uint8Array(BODY_PREAMBLE_BYTES)
  out.set(BODY_MAGIC, 0)
  out[4] = p.version & 0xff
  out[5] = p.gzipped ? FLAG_GZIP : 0
  return out
}

/**
 * Read the preamble, or `null` when this is not a collector body at all — too
 * short, or the magic does not match.
 *
 * The version is returned **verbatim, not validated**. A reader that must
 * refuse an unknown version can compare against {@link BODY_VERSION} and say
 * so; conflating "not ours" with "ours, newer than I am" would leave ingest
 * unable to tell a misrouted request from a rolling client upgrade.
 */
export function readPreamble(body: Uint8Array): BodyPreamble | null {
  if (body.length < BODY_PREAMBLE_BYTES) return null
  for (let i = 0; i < BODY_MAGIC.length; i++) {
    if (body[i] !== BODY_MAGIC[i]) return null
  }
  return { version: body[4] as number, gzipped: ((body[5] as number) & FLAG_GZIP) !== 0 }
}

/**
 * Preamble + optionally-gzipped frames — the complete bytes of one POST or one
 * beacon.
 *
 * **Never throws, and never rejects.** Compression is an optimisation, not a
 * correctness requirement: a missing or broken `CompressionStream` must cost
 * bytes, not the batch. The returned `gzipped` is what actually happened, and
 * it always agrees with the flags byte in `bytes`.
 *
 * Compression is also *declined when it does not pay*. A gzip member costs about
 * twenty bytes of header and trailer, so a small or incompressible body comes out
 * larger than it went in, and the point is to put as few bytes as possible into a
 * network the player is already fighting. The preamble makes this free to decide
 * per body.
 *
 * `frames` must be a buffer the caller owns — `FrameWriter.take()`'s output —
 * because the platform compressor reads it asynchronously.
 *
 * **The `fetch()` path must NOT set `Content-Encoding: gzip` for these bytes**,
 * even though the sketch shows that header. The body returned here is not a
 * gzip stream: it is eight plain bytes followed by an optionally-gzipped one,
 * and the flag inside those eight bytes is authoritative. Declaring a transfer
 * encoding would also invite a proxy or a server framework to decompress before
 * ingest reads the preamble, at which point the flag would describe bytes that
 * no longer exist. `Content-Type: application/octet-stream` and nothing else:
 * what ingest receives is byte-for-byte what the collector produced, on both
 * paths, which is the whole point of moving the encoding into the body.
 */
export async function encodeBody(
  frames: Uint8Array,
  opts?: { gzip?: boolean },
): Promise<{ bytes: Uint8Array; gzipped: boolean }> {
  let payload = frames
  let gzipped = false
  if ((opts?.gzip ?? true) && gzipSupported()) {
    try {
      const z = await gzip(frames)
      if (z.length < frames.length) {
        payload = z
        gzipped = true
      }
    } catch {
      // Fall through uncompressed. The flags byte below is written from
      // `gzipped`, so the body stays self-consistent and readable.
      payload = frames
      gzipped = false
    }
  }
  const out = new Uint8Array(BODY_PREAMBLE_BYTES + payload.length)
  out.set(writePreamble({ version: BODY_VERSION, gzipped }), 0)
  out.set(payload, BODY_PREAMBLE_BYTES)
  return { bytes: out, gzipped }
}
