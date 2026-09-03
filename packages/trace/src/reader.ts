/**
 * Incremental reader for the `.moqtrace` binary format.
 *
 * The three entry points in `binary.ts` all take the whole file at once, which
 * a live capture does not have: the bytes arrive in chunks whose boundaries
 * fall wherever the transport put them, almost never on an item boundary. This
 * reader takes those chunks and hands back the items that have become whole,
 * keeping the remainder for the next one.
 *
 * It is the read side of {@link createMoqtraceWriter}, which has been
 * incremental from the start — the asymmetry this closes was one-sided.
 *
 * Decoding is not reimplemented here. The header and event decoders are
 * imported from `binary.ts` so that a trace read in instalments and the same
 * trace read whole produce the same values. A second decoder would be a second
 * set of answers, and nothing tests two readers of one format against each
 * other, so the disagreement would surface as a rendering bug somewhere far
 * from here.
 */

import {
  cborToEvent,
  cborToHeader,
  decode,
  MAGIC,
  PREAMBLE_SIZE,
  SUPPORTED_VERSIONS,
  startsWithMagic,
} from './binary.js'
import { cborItemLength } from './cbor-scan.js'
import type { TraceEvent, TraceHeader } from './types.js'

/**
 * The stream ended part-way through an item.
 *
 * Deliberately not `TruncatedTraceError`, whose `segments` field promises
 * "everything that decoded before the cut". An incremental reader has already
 * handed those events to its caller and does not keep them, so it cannot fill
 * that field — and filling it with an empty array would report a trace that
 * decoded nothing, which is a wrong answer rather than a missing one. The
 * caller holds what decoded; this says only where the bytes stopped.
 */
export class TruncatedStreamError extends Error {
  /**
   * Offset into the whole stream at which the incomplete item begins — not
   * where the bytes ran out. It matches the Rust reader's
   * `MoqTraceError::Truncated { offset }`, so the same cut is named the same
   * number in both languages.
   */
  readonly offset: number

  /**
   * How many events reached the caller before the cut.
   *
   * The events themselves are gone — that is what makes this error different
   * from {@link TruncatedTraceError} — but their count is not, and it costs one
   * integer to keep. It is the difference between "the stream was cut" and "the
   * stream was cut after 4,812 events at byte 190,224", and only the second
   * tells whoever is holding a damaged capture how much of it they still have.
   */
  readonly events: number

  constructor(offset: number, events: number) {
    super(
      `Trace stream truncated: the item starting at byte ${offset} is incomplete, ` +
        `after ${events} event${events === 1 ? '' : 's'}`,
    )
    this.name = 'TruncatedStreamError'
    this.offset = offset
    this.events = events
  }
}

/**
 * One thing the reader has finished reading.
 *
 * The two kinds mirror the Rust crate's `ReadItem`, so a consumer that has read
 * one implementation recognises the other. A `segment` arrives before any event
 * that belongs to it, including the first one: unlike the Rust reader, which
 * takes a blocking source and parses the opening header in its constructor,
 * this one cannot have a header until bytes arrive, so every header reaches the
 * caller the same way and there is no special case for the first.
 */
export type ReadItem =
  | { readonly kind: 'segment'; readonly header: TraceHeader }
  | { readonly kind: 'event'; readonly event: TraceEvent }

/** Reads a `.moqtrace` stream in whatever instalments it arrives in. */
export interface MoqtraceReader {
  /**
   * Add the next chunk and take everything it completed.
   *
   * Returns an empty array when the chunk did not finish an item, which is
   * ordinary and not a signal of anything. Bytes left over are kept.
   *
   * @throws {MalformedHeaderError} if a segment header carries no usable value
   *   for a key the format requires.
   * @throws {MalformedCborError} if the bytes at an item boundary are not a
   *   well-formed CBOR item.
   */
  push(chunk: Uint8Array): ReadItem[]

  /**
   * Declare the stream complete and take any last item.
   *
   * This can return items. An event shorter than the magic cannot be told from
   * the start of a segment preamble while more bytes might still arrive, so
   * such an event waits here until `end()` rules the preamble out.
   *
   * @throws {TruncatedStreamError} if bytes remain that do not form a whole
   *   item — the file stops mid-event, mid-preamble or mid-header.
   */
  end(): ReadItem[]

  /**
   * The header of the segment now being read, or `undefined` before the first
   * one is whole. In a segmented stream this changes at every boundary.
   */
  readonly header: TraceHeader | undefined

  /** Bytes held back because they do not yet form a whole item. */
  readonly pending: number
}

/**
 * A reader that takes the stream in chunks.
 *
 * ```ts
 * const reader = createMoqtraceReader()
 * for await (const chunk of stream) {
 *   for (const item of reader.push(chunk)) {
 *     if (item.kind === 'event') render(item.event)
 *   }
 * }
 * for (const item of reader.end()) { ... }
 * ```
 *
 * `ReadOptions.recover` has no counterpart here **on purpose.** Its behaviour
 * in the whole-buffer readers — drop the damaged segment, return the rest, say
 * nothing — is under revision, because a caller cannot tell three segments from
 * four with one unreadable. Guessing an answer here would make an incremental
 * reader the place that shipped it, and a live view is where a silently
 * dropped segment does the most harm. Until that is settled this reader stops
 * at damage and says where.
 */
export function createMoqtraceReader(): MoqtraceReader {
  // One buffer rather than a chunk list. After a consume it is `subarray`d, so
  // the retained bytes are a view and not a copy, and in the steady state the
  // remainder is smaller than one item — the concatenation on each push costs
  // that remainder, not the stream.
  let buffer = new Uint8Array(0)
  // Where `buffer[0]` sits in the whole stream, so an error names an offset
  // into the file rather than into whatever is left of it.
  let consumed = 0
  // Events handed to the caller, kept only so a truncation can say how much of
  // the capture survived it.
  let delivered = 0
  let current: TraceHeader | undefined
  let ended = false

  function take(count: number): Uint8Array {
    const slice = buffer.subarray(0, count)
    buffer = buffer.subarray(count)
    consumed += count
    return slice
  }

  /**
   * Read a preamble and its header if all of it is here.
   *
   * Returns `undefined` to mean "not yet", which is why the length checks are
   * not `validatePreamble`'s: that function is written for a buffer that is the
   * whole file, so it reads a short one as a truncated file and throws. Here a
   * short buffer is the normal state between two chunks. What it does share is
   * the part worth sharing — the version check against
   * {@link SUPPORTED_VERSIONS} and, once the bytes are all present,
   * `cborToHeader`.
   */
  function tryReadSegment(): TraceHeader | undefined {
    if (buffer.length < PREAMBLE_SIZE) return undefined

    const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
    const version = view.getUint32(8, true)
    if (!SUPPORTED_VERSIONS.includes(version)) {
      throw new Error(
        `Unsupported format version: ${version} (supported: ${SUPPORTED_VERSIONS.join(', ')})`,
      )
    }

    const headerLength = view.getUint32(12, true)
    if (buffer.length < PREAMBLE_SIZE + headerLength) return undefined

    take(PREAMBLE_SIZE)
    const headerBytes = take(headerLength)
    return cborToHeader(decode(headerBytes) as Record<string, unknown>)
  }

  function drain(atEnd: boolean): ReadItem[] {
    const items: ReadItem[] = []

    for (;;) {
      if (current === undefined) {
        // Nothing has been read yet, so the stream must open with a preamble.
        // Saying so here means a caller who points this at some other file
        // learns that from the magic rather than from a CBOR error deep in it.
        if (buffer.length >= MAGIC.length && !startsWithMagic(buffer, 0)) {
          throw new Error('Invalid magic bytes: not a .moqtrace file')
        }
        const header = tryReadSegment()
        if (header === undefined) break
        current = header
        items.push({ kind: 'segment', header })
        continue
      }

      if (buffer.length === 0) break

      // A segment boundary is looked for only here, at a real item boundary —
      // the same eight bytes inside a captured payload are not one. Deciding
      // needs the whole magic: with fewer bytes than that in hand, "does not
      // start with the magic" is not yet a fact about the stream, only about
      // how much of it has arrived. Waiting is wrong at the end of the stream
      // and right everywhere else, which is what `atEnd` distinguishes.
      if (buffer.length < MAGIC.length && !atEnd) break

      if (startsWithMagic(buffer, 0)) {
        const header = tryReadSegment()
        if (header === undefined) break
        current = header
        items.push({ kind: 'segment', header })
        continue
      }

      const length = cborItemLength(buffer, 0)
      if (length === null) break

      const item = decode(take(length))
      items.push({ kind: 'event', event: cborToEvent(item as Record<string, unknown>) })
      delivered += 1
    }

    return items
  }

  return {
    push(chunk: Uint8Array): ReadItem[] {
      if (ended) throw new Error('Cannot push to a reader that has ended')
      if (chunk.length > 0) {
        const grown = new Uint8Array(buffer.length + chunk.length)
        grown.set(buffer, 0)
        grown.set(chunk, buffer.length)
        buffer = grown
      }
      return drain(false)
    },

    end(): ReadItem[] {
      if (ended) return []
      ended = true
      const items = drain(true)
      // The one place a truncation is declared. `drain` only ever stops at
      // bytes it cannot use yet, which is the ordinary state between chunks and
      // a fault only once no more are coming — so it reports nothing and leaves
      // the leftovers, and the verdict is taken here, where "no more are
      // coming" is known. Raising it in both places, as an earlier revision
      // did, gave one fault two throw sites that could drift apart.
      //
      // A reader that never produced a header is the same fault: it saw no
      // preamble at all, which includes the empty stream. Returning no items
      // for that would report a trace that recorded nothing, when what happened
      // is that no trace arrived.
      if (buffer.length > 0 || current === undefined) {
        throw new TruncatedStreamError(consumed, delivered)
      }
      return items
    },

    get header(): TraceHeader | undefined {
      return current
    },

    get pending(): number {
      return buffer.length
    },
  }
}
