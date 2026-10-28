/**
 * What a realm's transports carry before a session can claim it: before
 * `init()` has attached in the page, before the link in a worker.
 *
 * **Control-plane bytes are held** and replayed into the session's decoder when
 * it attaches. A worker opens its transport right after `initWorker()`, and an
 * instant handshake finishes before the page's answer arrives; without these
 * bytes the session would start with no SETUP and no first SUBSCRIBE, and its
 * control framer would start in the middle of a stream.
 *
 * They are held raw, Authorization Token included: a chunk is not
 * frame-aligned, and masking needs the framer the dispatcher already runs.
 * The dispatcher masks them on replay exactly as it masks live ones, nothing
 * here is copied anywhere else, a connection that closes first is forgotten,
 * and a worker whose link never comes releases them.
 *
 * **Object data is counted, not held.** A subgroup stream is undecodable
 * without its header and the header is the part that came first, so its
 * halves are remembered instead: the session counts their remainder too
 * rather than decoding a stream from its middle.
 *
 * Bounded twice: {@link EARLY_CONTROL_CONNECTION_BYTES} per connection,
 * {@link EARLY_CONTROL_REALM_BYTES} per realm. A refused chunk is counted as
 * dropped and ends the connection's buffer, so what is replayed is always a
 * prefix of the control plane, and every half it cut is skipped thereafter.
 */

import type { Direction, StreamChunk } from '../types.js'

/** Control bytes held per connection. SETUP and a burst of SUBSCRIBEs fit many times over. */
export const EARLY_CONTROL_CONNECTION_BYTES = 64 * 1024

/** Control bytes held across every connection of one realm. */
export const EARLY_CONTROL_REALM_BYTES = 256 * 1024

/**
 * Stream halves remembered per connection. A page that never calls `init()`
 * keeps its hook dormant for its whole life, and a closed stream's entry is
 * dropped, so this only bounds a page holding thousands of streams open at once.
 */
const MAX_HALVES = 1024

/** One direction of one stream: the unit a decoder starts at the beginning of. */
export function halfOf(streamId: number, dir: Direction): string {
  return `${streamId}/${dir}`
}

/** What one connection carried before its session attached. */
export interface EarlyConnection {
  /** Held control chunks, in arrival order, copied. */
  readonly control: StreamChunk[]
  /** Control chunks refused: the bounds were reached. */
  readonly dropped: number
  /** Object-data chunks and datagrams seen, and their bytes. */
  readonly dataChunks: number
  readonly dataBytes: number
  /** Halves the session must not decode: object streams, and control streams cut short. */
  readonly skip: Set<string>
}

interface Held {
  control: StreamChunk[]
  controlBytes: number
  full: boolean
  dropped: number
  dataChunks: number
  dataBytes: number
  skip: Set<string>
}

export class EarlyBuffer {
  private readonly _conns = new Map<string, Held>()
  private _bytes = 0
  private _released = false

  /** Control bytes held across every connection. */
  get controlBytes(): number {
    return this._bytes
  }

  onStream(c: StreamChunk): void {
    if (this._released) return
    const h = this._held(c.sessionId)
    const half = halfOf(c.streamId, c.direction)
    const n = c.data.byteLength
    if (!c.control) {
      h.dataChunks += 1
      h.dataBytes += n
      remember(h.skip, half)
      return
    }
    if (
      !h.full &&
      h.controlBytes + n <= EARLY_CONTROL_CONNECTION_BYTES &&
      this._bytes + n <= EARLY_CONTROL_REALM_BYTES
    ) {
      // `StreamChunk.data` is a borrowed view onto the page's own buffer.
      h.control.push({ ...c, data: c.data.slice() })
      h.controlBytes += n
      this._bytes += n
      return
    }
    // Everything after the first refusal is refused too, so the replay is a
    // prefix and never a stream with a hole in its middle.
    h.full = true
    h.dropped += 1
    remember(h.skip, half)
  }

  onDatagram(sessionId: string, bytes: number): void {
    if (this._released) return
    const h = this._held(sessionId)
    h.dataChunks += 1
    h.dataBytes += bytes
  }

  /** A stream that ended needs no skipping: nothing more of it will arrive. */
  onStreamClose(sessionId: string, streamId: number): void {
    const h = this._conns.get(sessionId)
    if (h === undefined) return
    h.skip.delete(halfOf(streamId, 'rx'))
    h.skip.delete(halfOf(streamId, 'tx'))
  }

  /** The connection closed before any session saw it. */
  forget(sessionId: string): void {
    const h = this._conns.get(sessionId)
    if (h === undefined) return
    this._bytes -= h.controlBytes
    this._conns.delete(sessionId)
  }

  /** Hand everything to the session that attaches, and hold nothing more. */
  take(): Map<string, EarlyConnection> {
    const out = new Map<string, EarlyConnection>()
    for (const [id, h] of this._conns) {
      out.set(id, {
        control: h.control,
        dropped: h.dropped,
        dataChunks: h.dataChunks,
        dataBytes: h.dataBytes,
        skip: h.skip,
      })
    }
    this.release()
    return out
  }

  /** Drop everything held and hold nothing from now on. */
  release(): void {
    this._released = true
    this._conns.clear()
    this._bytes = 0
  }

  private _held(sessionId: string): Held {
    let h = this._conns.get(sessionId)
    if (h === undefined) {
      h = {
        control: [],
        controlBytes: 0,
        full: false,
        dropped: 0,
        dataChunks: 0,
        dataBytes: 0,
        skip: new Set(),
      }
      this._conns.set(sessionId, h)
    }
    return h
  }
}

function remember(skip: Set<string>, half: string): void {
  if (skip.size < MAX_HALVES) skip.add(half)
}
