/**
 * Getting as much of a file as it will give up.
 *
 * A trace is read because something went wrong, so the file is more likely
 * than average to be damaged: a capture killed mid-write, a transfer that
 * lost its tail. Refusing those is refusing exactly the evidence someone came
 * for, so this reads what it can and reports the boundary rather than treating
 * a partial file as no file.
 */

import { readMoqtraceSegments, type Trace, TruncatedTraceError } from '@moqtap/trace'

/** Magic (8) + version (4) + header length (4), fixed by the format. */
const VERSION_OFFSET = 8

export interface ReadResult {
  readonly segments: readonly Trace[]
  readonly formatVersion: number
  /** Byte offset of the incomplete item that ended the read, if one did. */
  readonly truncatedAt?: number
  /**
   * Segments recovered past the damage by resynchronising to a later segment
   * boundary, beyond those the first read returned.
   */
  readonly recoveredSegments?: number | undefined
}

/**
 * The declared format version, read straight from the preamble.
 *
 * Worth reading separately because the reader does not hand it back and it is
 * the difference between "a damaged region costs one segment" and "a damaged
 * region ends the file".
 */
export function formatVersionOf(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return view.getUint32(VERSION_OFFSET, true)
}

export function readTrace(bytes: Uint8Array): ReadResult {
  const formatVersion = formatVersionOf(bytes)

  try {
    return { segments: readMoqtraceSegments(bytes), formatVersion }
  } catch (error) {
    if (!(error instanceof TruncatedTraceError)) throw error

    // The plain read is tried first because only it reports where the file
    // stopped being readable; recovery skips the damage and so cannot say. A
    // second read with recovery on then asks whether anything survives past
    // that point, which on a segmented file it often does.
    const salvaged = recover(bytes)
    const segments = salvaged.length > error.segments.length ? salvaged : error.segments
    if (segments.length === 0) throw error

    return {
      segments,
      formatVersion,
      truncatedAt: error.offset,
      recoveredSegments:
        salvaged.length > error.segments.length
          ? salvaged.length - error.segments.length
          : undefined,
    }
  }
}

/**
 * Read past the damage, or give up quietly.
 *
 * A failure here means recovery found nothing the first read had not already
 * returned, which is the ordinary outcome for an unsegmented file: there is
 * no later boundary to resynchronise to. The caller falls back to what the
 * first read salvaged, so this must not turn that into an error.
 */
function recover(bytes: Uint8Array): readonly Trace[] {
  try {
    return readMoqtraceSegments(bytes, { recover: true })
  } catch {
    return []
  }
}
