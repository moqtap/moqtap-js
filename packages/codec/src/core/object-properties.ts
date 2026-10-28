/**
 * Object Properties (Extension Headers before draft-17), read and written as an
 * ordered list: a type may repeat and unknown types must round-trip.
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
   * The decoded contents of an Immutable Properties (Immutable Extensions)
   * property. Offsets are from the start of the outer block.
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
   * The contents of an Immutable Properties property, encoded when `bytes` is
   * absent; `bytes` takes precedence.
   */
  readonly properties?: readonly ObjectPropertyInit[]
}

/** What separates one draft's property block from another's. */
export interface ObjectPropertyRules {
  /** Each Type is a delta from the previous one (draft-16 on), so types ascend. */
  readonly deltaTypes: boolean
  /** The largest value an odd type may carry, where the draft sets one. */
  readonly maxValueLength?: number
  /** The type that holds Immutable Properties, in drafts that define one. */
  readonly immutableType?: bigint
}

const MAX_U64 = 0xffffffffffffffffn

/**
 * Read properties from `r` until `end`. Throws `CONSTRAINT_VIOLATION` for a
 * malformed block, including a truncated one: `end` is the declared length.
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
