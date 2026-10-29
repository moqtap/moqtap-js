// Box walking shared by the BMFF readers (ISO/IEC 14496-12 4.2).

export function u32(data: Uint8Array, offset: number): number {
  return (
    ((data[offset]! << 24) |
      (data[offset + 1]! << 16) |
      (data[offset + 2]! << 8) |
      data[offset + 3]!) >>>
    0
  )
}

export function u64(data: Uint8Array, offset: number): bigint {
  return (BigInt(u32(data, offset)) << 32n) | BigInt(u32(data, offset + 4))
}

export function fourcc(data: Uint8Array, offset: number): string {
  return String.fromCharCode(data[offset]!, data[offset + 1]!, data[offset + 2]!, data[offset + 3]!)
}

export function hex(data: Uint8Array, start: number, end: number): string {
  let out = ''
  for (let i = start; i < end; i++) out += data[i]!.toString(16).padStart(2, '0')
  return out
}

/** A box: its type and where its payload starts and ends. */
export interface Child {
  type: string
  /** Offset of the box header */
  offset: number
  /** First byte after the header (and largesize, if any) */
  body: number
  /** One past the last byte, clamped to the container */
  end: number
  /** The box claims to run past its container */
  truncated: boolean
}

export interface Walk {
  boxes: Child[]
  /** Offset of a size field that cannot be a box (2 to 7, or a largesize below 16), else null */
  invalidAt: number | null
  /** Bytes left over after the last box that are too few for a box header */
  trailing: number
}

/**
 * The boxes directly inside [start, end), of any type. A box that claims to
 * run past its container is clamped to it, and a malformed size ends the walk.
 */
export function walk(data: Uint8Array, start: number, end: number): Walk {
  const boxes: Child[] = []
  let offset = start
  let invalidAt: number | null = null
  while (offset + 8 <= end) {
    const size = u32(data, offset)
    const type = fourcc(data, offset + 4)
    let body = offset + 8
    let boxEnd: number
    if (size === 0) {
      boxEnd = end
    } else if (size === 1) {
      if (offset + 16 > end) break
      body = offset + 16
      // Past 4 GiB the box is necessarily cut short here.
      boxEnd = u32(data, offset + 8) > 0 ? Number.MAX_SAFE_INTEGER : offset + u32(data, offset + 12)
      if (boxEnd < body) {
        invalidAt = offset
        break
      }
    } else if (size >= 8) {
      boxEnd = offset + size
    } else {
      invalidAt = offset
      break
    }
    boxes.push({ type, offset, body, end: Math.min(boxEnd, end), truncated: boxEnd > end })
    if (boxEnd >= end) return { boxes, invalidAt, trailing: 0 }
    offset = boxEnd
  }
  return { boxes, invalidAt, trailing: invalidAt === null ? end - offset : 0 }
}

export function children(data: Uint8Array, start: number, end: number): Child[] {
  return walk(data, start, end).boxes
}

export function child(data: Uint8Array, parent: Child, type: string): Child | undefined {
  return children(data, parent.body, parent.end).find((c) => c.type === type)
}

export function childrenOf(data: Uint8Array, parent: Child, type: string): Child[] {
  return children(data, parent.body, parent.end).filter((c) => c.type === type)
}

export function topLevel(data: Uint8Array): Child[] {
  return children(data, 0, data.length)
}

/** A FullBox's version byte and 24-bit flags, or null when cut short. */
export function versionFlags(
  data: Uint8Array,
  box: Child,
): { version: number; flags: number } | null {
  if (box.body + 4 > box.end) return null
  return { version: data[box.body]!, flags: u32(data, box.body) & 0xffffff }
}

/**
 * A 32-bit FullBox field whose position depends on the box's version: at
 * `v0` bytes into the body (version/flags included) for version 0, at `v1`
 * for version 1. Null when the box is cut short before it.
 */
export function fullBoxU32(data: Uint8Array, box: Child, v0: number, v1: number): number | null {
  if (box.body + 4 > box.end) return null
  const at = box.body + (data[box.body] === 1 ? v1 : v0)
  return at + 4 <= box.end ? u32(data, at) : null
}

// ─── Sample groups (ISO/IEC 14496-12 8.9.2, 8.9.3) ──────────────────

/** One `sgpd`. `sap` holds its entries when the grouping type is `sap `. */
export interface SampleGroupDescription {
  groupingType: string
  version: number
  /** default_group_description_index (version 2 and later), else null */
  defaultIndex: number | null
  entryCount: number
  sap: { dependentFlag: boolean; sapType: number }[] | null
}

/** `onShort` is called when the box ends before its fields do. */
export function readSgpd(
  data: Uint8Array,
  box: Child,
  onShort?: () => void,
): SampleGroupDescription | null {
  const short = () => {
    onShort?.()
    return null
  }
  const vf = versionFlags(data, box)
  if (vf === null || box.body + 8 > box.end) return short()
  const { version } = vf
  const groupingType = fourcc(data, box.body + 4)
  let at = box.body + 8
  let defaultLength = 0
  if (version === 1) {
    if (at + 4 > box.end) return short()
    defaultLength = u32(data, at)
    at += 4
  }
  let defaultIndex: number | null = null
  if (version >= 2) {
    if (at + 4 > box.end) return short()
    defaultIndex = u32(data, at)
    at += 4
  }
  if (at + 4 > box.end) return short()
  const entryCount = u32(data, at)
  at += 4
  let sap: SampleGroupDescription['sap'] = null
  if (groupingType === 'sap ') {
    sap = []
    for (let i = 0; i < entryCount; i++) {
      let length = 1
      if (version === 1) {
        length = defaultLength
        if (length === 0) {
          if (at + 4 > box.end) {
            short()
            break
          }
          length = u32(data, at)
          at += 4
        }
      }
      if (length < 1 || at + length > box.end) {
        short()
        break
      }
      // SAPEntry: dependent_flag(1) reserved(3) SAP_type(4)
      const b = data[at]!
      sap.push({ dependentFlag: (b & 0x80) !== 0, sapType: b & 0x0f })
      at += length
    }
  }
  return { groupingType, version, defaultIndex, entryCount, sap }
}

export interface SampleToGroup {
  groupingType: string
  entries: { sampleCount: number; groupDescriptionIndex: number }[]
}

export function readSbgp(data: Uint8Array, box: Child, onShort?: () => void): SampleToGroup | null {
  const vf = versionFlags(data, box)
  const groupingType = vf && box.body + 8 <= box.end ? fourcc(data, box.body + 4) : ''
  let at = box.body + 8 + (vf?.version === 1 ? 4 : 0)
  if (vf === null || at + 4 > box.end) {
    onShort?.()
    return null
  }
  const count = u32(data, at)
  at += 4
  const entries: SampleToGroup['entries'] = []
  for (let i = 0; i < count && at + 8 <= box.end; i++, at += 8) {
    entries.push({ sampleCount: u32(data, at), groupDescriptionIndex: u32(data, at + 4) })
  }
  if (entries.length < count) onShort?.()
  return { groupingType, entries }
}

/** ftyp/styp body (ISO/IEC 14496-12 4.3): major_brand, minor_version, compatible_brands */
export function brandsAt(
  data: Uint8Array,
  start: number,
  end: number,
): { major: string; minorVersion: number; compatible: string[] } | null {
  if (start + 8 > end) return null
  const compatible: string[] = []
  for (let i = start + 8; i + 4 <= end; i += 4) compatible.push(fourcc(data, i))
  return { major: fourcc(data, start), minorVersion: u32(data, start + 4), compatible }
}
