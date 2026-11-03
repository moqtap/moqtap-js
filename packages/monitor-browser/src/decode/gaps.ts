/**
 * Prior Group ID Gap and Prior Object ID Gap, read out of an object's
 * property block: key 0x40 in drafts 11-13, 0x3C and 0x3E in 14 on. Every
 * other property is stepped over unread. From draft-16 property types are
 * deltas from the one before.
 */

import { NEED, type SupportedDraft, type VarintReader } from '../types.js'

export interface Gaps {
  group?: bigint
  object?: bigint
}

/** The gaps in `b[start, end)`, or `null` when there are none or the block does not read. */
export function readGaps(
  v: VarintReader,
  b: Uint8Array,
  start: number,
  end: number,
  draft: SupportedDraft,
): Gaps | null {
  if (draft < 11 || end <= start) return null
  const groupKey = draft < 14 ? 0x40n : 0x3cn
  const objectKey = draft < 14 ? -1n : 0x3en
  const delta = draft >= 16
  const block = b.subarray(start, end)
  let out: Gaps | null = null
  let p = 0
  let type = 0n
  while (p < block.length) {
    const t = v.read(block, p)
    if (t === NEED) return out
    type = delta ? type + t.value : t.value
    p = t.next
    if ((type & 1n) === 0n) {
      const value = v.read(block, p)
      if (value === NEED) return out
      p = value.next
      if (type === groupKey || type === objectKey) {
        out ??= {}
        if (type === groupKey) out.group = value.value
        else out.object = value.value
      }
    } else {
      const len = v.read(block, p)
      if (len === NEED) return out
      const n = Number(len.value)
      if (!Number.isSafeInteger(n) || len.next + n > block.length) return out
      p = len.next + n
    }
  }
  return out
}
