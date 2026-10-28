import type { StreamOrigin } from '../types.js'
import { isControlPlane, UNI_CONTROL_STREAM_PREFIX } from './control-plane.js'

/**
 * Per-session stream ids and sticky control-plane classification.
 *
 * One registry per session, ids from 0.
 * `extension/src/intercept/webtransport-hook.ts` allocates `nextStreamId` once
 * per *install*, so every session on the page shares one counter and a session's
 * stream ids depend on how many streams every other session happened to open
 * first. `StreamChunk.streamId` is documented in `types.ts` as "synthetic,
 * per-session … meaningful only within one session's records", the
 * `streamId -> pending request` map is per session, and ids stamped on `ctrl`
 * records that ingest joins would collide across sessions.
 *
 * Classification is sticky: only the FIRST bytes of a unidirectional stream may
 * decide whether it is control (`af 00` is SETUP's type, and SETUP appears once,
 * at the head of the stream). A later chunk that happens to begin `af 00` is
 * object payload, so the first decision is frozen for the life of the stream id.
 *
 * The two-byte accumulator exists because nothing in WebTransport guarantees the
 * first chunk is longer than one byte: a one-byte chunk carrying `af` would
 * classify as "not control" and, the decision being sticky, stay wrong for the
 * whole stream and file the entire control plane as bulk. So the registry
 * buffers up to two bytes across chunks and does not decide until it has them.
 */
export class StreamRegistry {
  readonly sessionId: string

  private _next = 0
  /** Frozen answers. Absent means "not yet decided". */
  private _control = new Map<number, boolean>()
  /** Up to two leading bytes of an undecided unidirectional stream. */
  private _prefix = new Map<number, number[]>()

  constructor(sessionId: string) {
    this.sessionId = sessionId
  }

  /**
   * Allocate this session's next stream id.
   *
   * A bidirectional stream is control on every supported draft, so it is
   * classified here and needs no chunk. `origin` is recorded by the
   * caller on `onStreamOpen`; the registry takes it so that the one place ids
   * are minted is the one place a stream's provenance is known.
   */
  next(bidi: boolean, _origin: StreamOrigin): number {
    const id = this._next++
    if (bidi) this._control.set(id, true)
    return id
  }

  /**
   * Classify a stream from its leading bytes. Idempotent per stream id: the
   * first decision wins and every later call returns it unchanged.
   *
   * Returns the stream's control flag, which is what the seam stamps on
   * {@link StreamChunk.control}. While fewer than two bytes have been seen on a
   * unidirectional stream the answer is `false` and the decision stays open.
   */
  classify(streamId: number, bidi: boolean, firstChunk: Uint8Array): boolean {
    const decided = this._control.get(streamId)
    if (decided !== undefined) return decided

    if (bidi) {
      this._control.set(streamId, true)
      this._prefix.delete(streamId)
      return true
    }

    const need = UNI_CONTROL_STREAM_PREFIX.length
    let head = this._prefix.get(streamId)
    if (head === undefined) {
      head = []
      this._prefix.set(streamId, head)
    }
    for (let i = 0; i < firstChunk.length && head.length < need; i++) {
      head.push(firstChunk[i] as number)
    }
    // Not enough bytes yet: stay undecided rather than freeze a guess.
    if (head.length < need) return false

    const control = isControlPlane(false, Uint8Array.from(head))
    this._control.set(streamId, control)
    this._prefix.delete(streamId)
    return control
  }

  /** The frozen answer, or `false` while the stream is still undecided. */
  isControl(streamId: number): boolean {
    return this._control.get(streamId) === true
  }

  /** Drop a finished stream's state. Ids are never reused. */
  close(streamId: number): void {
    this._control.delete(streamId)
    this._prefix.delete(streamId)
  }

  /** Streams whose classification state is still held. Bounded by open streams. */
  get tracked(): number {
    return this._control.size + this._prefix.size
  }
}
