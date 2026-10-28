/**
 * Object Properties — called Extension Headers before draft-17 — read and
 * written as an ordered list.
 *
 * The data-stream decoders do not call this. They hand back the property block
 * as raw bytes (`extensionData`) and nothing more, because the collector runs
 * them on every datagram of a consumer's session and reads none of it. A
 * consumer that wants the properties asks for them with the draft's own
 * `decodeObjectProperties`, which binds the rules below to that draft's varint.
 *
 * A list and not a map, for the same reasons control-message parameters are a
 * list: a type may repeat, an odd type carries bytes rather than a number, and
 * a type nothing names has no key to sit under. Every one of those is lost by a
 * map keyed by name, and the encoder could not put the bytes back.
 */

import type { BufferReader } from './buffer-reader.js'
import type { BufferWriter } from './buffer-writer.js'
import { DecodeError } from './types.js'

/** One property as the wire carried it. */
export interface ObjectProperty {
  readonly type: bigint
  /** Byte offset of the property's Type field, from the start of the block. */
  readonly offset: number
  /** Bytes the property occupies, from its Type field to the end of its value. */
  readonly length: number
  /** The value of an even type. */
  readonly value?: bigint
  /** The value of an odd type: a view into the decoded block, not a copy. */
  readonly bytes?: Uint8Array
  /**
   * The contents of an Immutable Properties (Immutable Extensions) property,
   * decoded by the same rules. Their offsets are from the start of the outer
   * block too, so a caller can point at them without adding anything up. The
   * raw value stays in `bytes`.
   */
  readonly properties?: readonly ObjectProperty[]
}

/** One property to encode. */
export interface ObjectPropertyInit {
  readonly type: bigint
  /** Required for an even type. */
  readonly value?: bigint
  /** Required for an odd type, unless `properties` is given. */
  readonly bytes?: Uint8Array
  /**
   * The contents of an Immutable Properties property, encoded in place of
   * `bytes`. When both are given `bytes` wins: those are the serialization the
   * original publisher chose, and the property MUST NOT change it.
   */
  readonly properties?: readonly ObjectPropertyInit[]
}

/** What separates one draft's property block from another's. */
export interface ObjectPropertyRules {
  /**
   * Whether each Type is a delta from the one before it (draft-16 on) rather
   * than absolute. Delta encoding also forces the types into ascending order.
   */
  readonly deltaTypes: boolean
  /** The largest value an odd type may carry, where the draft sets one. */
  readonly maxValueLength?: number
  /** The type that holds Immutable Properties, in drafts that define one. */
  readonly immutableType?: bigint
}

const MAX_U64 = 0xffffffffffffffffn

/**
 * Read properties from `r` until `end`.
 *
 * Throws `CONSTRAINT_VIOLATION` for a block that is malformed by the draft's
 * own rules — a property that runs past the block, a value longer than the
 * draft allows, a delta past 2^64 - 1, Immutable Properties inside Immutable
 * Properties. A truncated property is malformed here, not a reason to wait for
 * more bytes: the caller has already cut the block to the length the object
 * declared.
 */
export function readObjectProperties(
  r: BufferReader,
  end: number,
  rules: ObjectPropertyRules,
  nested = false,
): ObjectProperty[] {
  const props: ObjectProperty[] = []
  let prevType = 0n

  try {
    while (r.offset < end) {
      const offset = r.offset
      const raw = r.readVarInt()
      const type = rules.deltaTypes ? prevType + raw : raw
      if (type > MAX_U64) {
        throw new DecodeError(
          'CONSTRAINT_VIOLATION',
          `property type ${prevType} + delta ${raw} exceeds 2^64 - 1`,
          offset,
        )
      }
      prevType = type

      if (type % 2n === 0n) {
        const value = r.readVarInt()
        if (r.offset > end) throw overrun(offset)
        props.push({ type, offset, length: r.offset - offset, value })
        continue
      }

      const valueLength = r.readVarInt()
      if (rules.maxValueLength !== undefined && valueLength > BigInt(rules.maxValueLength)) {
        throw new DecodeError(
          'CONSTRAINT_VIOLATION',
          `property 0x${type.toString(16)} carries ${valueLength} bytes, more than the ${rules.maxValueLength} allowed`,
          offset,
        )
      }
      if (BigInt(r.offset) + valueLength > BigInt(end)) throw overrun(offset)
      const valueStart = r.offset
      const valueEnd = valueStart + Number(valueLength)

      if (rules.immutableType !== undefined && type === rules.immutableType) {
        if (nested) {
          throw new DecodeError(
            'CONSTRAINT_VIOLATION',
            'Immutable Properties may not contain another Immutable Properties',
            offset,
          )
        }
        // The contents are read off the same reader, so their offsets stay
        // relative to the outer block.
        const properties = readObjectProperties(r, valueEnd, rules, true)
        const bytes = r.buffer.subarray(valueStart, valueEnd)
        props.push({ type, offset, length: valueEnd - offset, bytes, properties })
        continue
      }

      const bytes = r.readBytesView(Number(valueLength))
      props.push({ type, offset, length: r.offset - offset, bytes })
    }
  } catch (e) {
    if (e instanceof DecodeError && e.code === 'UNEXPECTED_END') throw overrun(e.offset)
    throw e
  }

  return props
}

function overrun(offset: number): DecodeError {
  return new DecodeError(
    'CONSTRAINT_VIOLATION',
    'a property runs past the end of the properties block',
    offset,
  )
}

/** Write `props` in the order given. */
export function writeObjectProperties(
  w: BufferWriter,
  props: readonly ObjectPropertyInit[],
  rules: ObjectPropertyRules,
  makeWriter: () => BufferWriter,
): void {
  let prevType = 0n
  for (const p of props) {
    if (rules.deltaTypes && p.type < prevType) {
      throw new Error(
        `property types must ascend under delta encoding: 0x${p.type.toString(16)} follows 0x${prevType.toString(16)}`,
      )
    }
    w.writeVarInt(rules.deltaTypes ? p.type - prevType : p.type)
    prevType = p.type

    if (p.type % 2n === 0n) {
      if (p.value === undefined) {
        throw new Error(`even property 0x${p.type.toString(16)} needs a value`)
      }
      w.writeVarInt(p.value)
      continue
    }

    let bytes = p.bytes
    if (bytes === undefined && p.properties !== undefined) {
      const inner = makeWriter()
      writeObjectProperties(inner, p.properties, rules, makeWriter)
      bytes = inner.finish()
    }
    if (bytes === undefined) {
      throw new Error(`odd property 0x${p.type.toString(16)} needs bytes`)
    }
    w.writeVarInt(bytes.byteLength)
    w.writeBytes(bytes)
  }
}
