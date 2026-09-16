/**
 * The chunk-driving skeleton the subgroup and fetch counters share.
 *
 * Per-object budget: parse an object header, update per-track counters, discard.
 * Two properties hold the O(1) memory per track:
 *
 *  1. **Payload bytes are never buffered and never viewed.** A declared payload
 *     length running past the end of the arriving chunk becomes a *byte counter*
 *     ({@link DataStreamCounter.skip}), so a 4 MB object costs four bytes.
 *
 *  2. **Only an incomplete *header* crosses a chunk boundary**, and never more
 *     than `slackBytes` of it. A header that cannot complete inside the slack
 *     window is declared desynchronised and the stream abandoned — counted,
 *     never silently dropped — so a peer dribbling one byte of a nine-byte
 *     varint per second costs a bounded amount.
 *
 * Not `@moqtap/codec`'s streaming decoders: they materialise every payload as a
 * view, which is the cost this budget exists to avoid, and measure some sixty
 * times this walk's per-object cost in a browser. Below 0.11.0 they are also
 * wrong -- `createSubgroupStreamDecoder` omits the
 * `payloadLength === 0 -> readVarInt status` branch, so one status object
 * desynchronises everything after it, and `createDataStreamDecoder` selects an
 * inner decoder and never feeds it.
 */

import type { Mono } from '../types.js'

/**
 * "This is not a legal stream of this kind", as distinct from {@link NEED}'s
 * "not yet".
 *
 * A unique symbol for the same reason `NEED` is one: the two outcomes have
 * opposite consequences — one buffers and waits, the other abandons the stream —
 * so conflating them either buffers a malformed stream forever or throws away a
 * stream merely split across a packet.
 * {@link import('../types.js').DraftAdapter}'s walk methods are declared
 * `T | Need` and cannot express this third outcome.
 */
export const DESYNC: unique symbol = Symbol('desync')
export type Desync = typeof DESYNC

/**
 * Header bytes carried across a chunk boundary before a stream is declared
 * desynchronised; {@link import('../types.js').Limits.maxHeaderSlackBytes} is
 * where the api module overrides it.
 *
 * 4 KB is sized against the largest header the walks can legitimately need: an
 * object header of at most ~30 bytes of varints, plus an Object Properties block
 * whose declared length the walk must skip to reach the payload length. Past
 * that it is a fuzzing peer or a stream already out of sync, and buffering more
 * helps neither.
 */
export const DEFAULT_HEADER_SLACK_BYTES = 4096

/** What one parse pass over one buffer achieved. */
export interface ParseRun {
  /** Bytes of the buffer consumed. Everything before this is fully counted. */
  readonly consumed: number
  /** Payload bytes still to be skipped, lying *beyond* the buffer's end. */
  readonly skip: number
  /** The bytes are not a legal stream of this kind; abandon it. */
  readonly desync: boolean
}

const EMPTY = new Uint8Array(0)

/**
 * Drives {@link parse} over an arriving byte stream in O(1) memory.
 *
 * Subclasses implement the per-stream-kind walk and nothing else: the buffer
 * arithmetic, the payload skip counter, the bounded header carry and the
 * one-shot failure latch all live here.
 */
export abstract class DataStreamCounter {
  protected readonly slack: number

  /** An incomplete header, and never anything else. At most {@link slack}. */
  private carry: Uint8Array | null = null

  /** Payload bytes still owed from earlier chunks. The whole of the O(1). */
  private skip = 0

  private dead = false
  private closed = false

  constructor(slackBytes: number = DEFAULT_HEADER_SLACK_BYTES) {
    this.slack = slackBytes > 0 ? slackBytes : DEFAULT_HEADER_SLACK_BYTES
  }

  /**
   * Parse as much of `b` as completes. Must not read past `b.length`; may
   * report a `skip` for payload bytes that lie beyond it.
   */
  protected abstract parse(b: Uint8Array, at: Mono): ParseRun

  /** Report the desync to the sink. Called at most once per stream. */
  protected abstract onDesync(): void

  /** True once the stream was abandoned. Nothing further is parsed. */
  get failed(): boolean {
    return this.dead
  }

  /** Bytes currently held across a chunk boundary. Asserted in tests. */
  get bufferedBytes(): number {
    return this.carry === null ? 0 : this.carry.length
  }

  push(chunk: Uint8Array, at: Mono): void {
    if (this.dead || this.closed || chunk.length === 0) return

    let off = 0
    while (off < chunk.length) {
      if (this.skip > 0) {
        const n = Math.min(this.skip, chunk.length - off)
        this.skip -= n
        off += n
        continue
      }

      const carry = this.carry
      if (carry !== null) {
        // A header straddled the previous boundary. Splice it against at most
        // `slack` new bytes rather than against the whole chunk: a header that
        // cannot complete inside that window is not going to.
        const extra = Math.min(chunk.length - off, this.slack)
        const probe = new Uint8Array(carry.length + extra)
        probe.set(carry, 0)
        probe.set(chunk.subarray(off, off + extra), carry.length)

        const run = this.parse(probe, at)
        if (run.desync) return this.fail()
        this.skip = run.skip

        if (run.consumed >= carry.length) {
          // Back in sync with the chunk itself; parse the rest of it directly.
          off += run.consumed - carry.length
          this.carry = null
          continue
        }
        if (extra < chunk.length - off) {
          // We offered carry + a full slack window and still could not finish
          // one header.
          return this.fail()
        }
        const tail = probe.subarray(run.consumed)
        if (tail.length > this.slack) return this.fail()
        this.carry = tail.slice()
        return
      }

      const view = chunk.subarray(off)
      const run = this.parse(view, at)
      if (run.desync) return this.fail()
      this.skip = run.skip
      off += run.consumed
      if (this.skip > 0) continue
      if (run.consumed === view.length) return

      const tail = view.subarray(run.consumed)
      if (tail.length > this.slack) return this.fail()
      // Copy: `chunk` is a borrowed view onto the page's own buffer and the
      // page may write through it on its next frame (`StreamChunk.data`).
      this.carry = tail.slice()
      return
    }
  }

  /**
   * The stream ended.
   *
   * A residue — an incomplete header, or payload bytes still owed — is NOT a
   * parse failure. A reset or a `STOP_SENDING` truncates a perfectly well-formed
   * stream, and counting that as a decode fault would put a normal event in a
   * field that exists to find real ones.
   */
  end(): void {
    this.closed = true
    this.carry = null
    this.skip = 0
  }

  private fail(): void {
    this.dead = true
    this.carry = null
    this.skip = 0
    this.onDesync()
  }
}

/** A zero-length view, shared, for readers that need an empty buffer. */
export const EMPTY_BYTES: Uint8Array = EMPTY
