/**
 * The Group Order a fetch stream is read or written in, as the FETCH's
 * GROUP_ORDER parameter spells it: Ascending `1n`, Descending `2n`. From
 * draft-18 a later Object's Group ID Delta counts up or down by it, and the
 * stream does not carry it. draft-23 Section 9.19.8: "If omitted from FETCH,
 * the receiver uses Ascending (0x1)."
 */
export type FetchGroupOrder = 1n | 2n

/** Whether `order` is Descending; throws on a value that is neither. */
export function isDescending(order: FetchGroupOrder): boolean {
  if (order === 1n) return false
  if (order === 2n) return true
  throw new RangeError(`Group Order ${String(order)} is neither Ascending (1n) nor Descending (2n)`)
}
