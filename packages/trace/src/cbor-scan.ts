/**
 * Measure one CBOR item without decoding it.
 *
 * A `.moqtrace` file is a CBOR sequence, and a segmented one splices a
 * preamble between two of its items. Finding those boundaries means knowing
 * where each item ends — and knowing it *only* at real item boundaries. A
 * plain byte scan for the magic would also match the same eight bytes sitting
 * inside a captured payload, and would split a trace that was never segmented.
 *
 * Measuring is cheaper than decoding: a byte or text string is skipped by its
 * declared length rather than read, so the cost follows the structure of the
 * data and not its size.
 */

/** The item at the given offset ran past the end of the buffer. */
export const INCOMPLETE = null

/** Thrown when the bytes are not a well-formed CBOR item at all. */
export class MalformedCborError extends Error {
  readonly offset: number

  constructor(message: string, offset: number) {
    super(`${message} at byte ${offset}`)
    this.name = 'MalformedCborError'
    this.offset = offset
  }
}

const MAJOR_UNSIGNED = 0
const MAJOR_NEGATIVE = 1
const MAJOR_BYTES = 2
const MAJOR_TEXT = 3
const MAJOR_ARRAY = 4
const MAJOR_MAP = 5
const MAJOR_TAG = 6
const MAJOR_SIMPLE = 7

const AI_ONE_BYTE = 24
const AI_TWO_BYTES = 25
const AI_FOUR_BYTES = 26
const AI_EIGHT_BYTES = 27
const AI_INDEFINITE = 31
const BREAK = 0xff

/** Bytes that follow the initial byte for each additional-information value. */
function headerExtraBytes(additionalInfo: number, offset: number): number {
  if (additionalInfo < AI_ONE_BYTE) return 0
  switch (additionalInfo) {
    case AI_ONE_BYTE:
      return 1
    case AI_TWO_BYTES:
      return 2
    case AI_FOUR_BYTES:
      return 4
    case AI_EIGHT_BYTES:
      return 8
    case AI_INDEFINITE:
      return 0
    default:
      throw new MalformedCborError(`reserved additional information ${additionalInfo}`, offset)
  }
}

/** Read the argument encoded in the item header. */
function readArgument(bytes: Uint8Array, offset: number, additionalInfo: number): number {
  if (additionalInfo < AI_ONE_BYTE) return additionalInfo
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  switch (additionalInfo) {
    case AI_ONE_BYTE:
      return view.getUint8(offset + 1)
    case AI_TWO_BYTES:
      return view.getUint16(offset + 1, false)
    case AI_FOUR_BYTES:
      return view.getUint32(offset + 1, false)
    case AI_EIGHT_BYTES: {
      const value = view.getBigUint64(offset + 1, false)
      // A length this large cannot be indexed anyway; treating it as a number
      // is safe because the caller only ever compares it against the buffer.
      return Number(value)
    }
    default:
      throw new MalformedCborError(`reserved additional information ${additionalInfo}`, offset)
  }
}

/**
 * Advance past the item at `offset`, returning the offset just after it, or
 * {@link INCOMPLETE} if the buffer ends part-way through.
 *
 * @param allowBreak whether a break code is a legal item here — true only
 *   directly inside an indefinite-length container.
 */
function skipItem(bytes: Uint8Array, offset: number, allowBreak: boolean): number | null {
  if (offset >= bytes.length) return INCOMPLETE

  const initial = bytes[offset] as number
  if (initial === BREAK) {
    if (!allowBreak) {
      throw new MalformedCborError('break outside an indefinite-length item', offset)
    }
    return offset + 1
  }

  const major = initial >> 5
  const additionalInfo = initial & 0x1f
  const extra = headerExtraBytes(additionalInfo, offset)
  if (offset + 1 + extra > bytes.length) return INCOMPLETE

  const indefinite = additionalInfo === AI_INDEFINITE
  if (indefinite && (major === MAJOR_UNSIGNED || major === MAJOR_NEGATIVE || major === MAJOR_TAG)) {
    throw new MalformedCborError(`major type ${major} cannot be indefinite-length`, offset)
  }

  const afterHeader = offset + 1 + extra

  switch (major) {
    case MAJOR_UNSIGNED:
    case MAJOR_NEGATIVE:
      return afterHeader

    case MAJOR_BYTES:
    case MAJOR_TEXT: {
      if (!indefinite) {
        const length = readArgument(bytes, offset, additionalInfo)
        const end = afterHeader + length
        return end > bytes.length ? INCOMPLETE : end
      }
      // Indefinite strings are a run of definite-length chunks, then a break.
      let cursor = afterHeader
      for (;;) {
        if (cursor >= bytes.length) return INCOMPLETE
        if (bytes[cursor] === BREAK) return cursor + 1
        const next = skipItem(bytes, cursor, false)
        if (next === INCOMPLETE) return INCOMPLETE
        cursor = next
      }
    }

    case MAJOR_ARRAY:
    case MAJOR_MAP: {
      const perEntry = major === MAJOR_MAP ? 2 : 1
      if (!indefinite) {
        const count = readArgument(bytes, offset, additionalInfo) * perEntry
        let cursor = afterHeader
        for (let i = 0; i < count; i++) {
          const next = skipItem(bytes, cursor, false)
          if (next === INCOMPLETE) return INCOMPLETE
          cursor = next
        }
        return cursor
      }
      let cursor = afterHeader
      for (;;) {
        if (cursor >= bytes.length) return INCOMPLETE
        if (bytes[cursor] === BREAK) return cursor + 1
        for (let i = 0; i < perEntry; i++) {
          const next = skipItem(bytes, cursor, false)
          if (next === INCOMPLETE) return INCOMPLETE
          cursor = next
        }
      }
    }

    case MAJOR_TAG:
      return skipItem(bytes, afterHeader, false)

    case MAJOR_SIMPLE:
      // Floats and simple values carry no content beyond the header.
      return afterHeader

    default:
      throw new MalformedCborError(`unknown major type ${major}`, offset)
  }
}

/**
 * Byte length of the CBOR item beginning at `start`, or {@link INCOMPLETE} if
 * the buffer ends before the item does.
 *
 * @throws {MalformedCborError} if the bytes are not a well-formed item.
 */
export function cborItemLength(bytes: Uint8Array, start: number): number | null {
  const end = skipItem(bytes, start, false)
  return end === INCOMPLETE ? INCOMPLETE : end - start
}
