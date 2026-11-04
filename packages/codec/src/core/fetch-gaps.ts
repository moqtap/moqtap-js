/**
 * The Prior Group ID Gap and Prior Object ID Gap conditions that show across
 * the Objects of one fetch stream, drafts 11-23, and of one subgroup stream,
 * drafts 14-15 and 23.
 *
 * A fetch stream carries its Groups in the requested Group Order and, within a
 * Group, its Objects in Object ID order: draft-11 Section 8.13 and draft-23
 * Section 3.2.1, "Within each group, objects are sent in Object ID order;
 * subgroup ID is not used for ordering." So the Group before this one, and the
 * Object before this one in its Group, are the only ones a gap below this
 * Object can cover, and the only ones whose gap can hold this Object.
 *
 * A subgroup stream carries one Group, its Objects "in ascending order by
 * Object ID" (draft-14 Section 2.2 and draft-23 Section 2.2), so the Object
 * before this one is the only one this Object's gap can cover.
 */

import type { ObjectProperty } from './object-properties.js'

/** Which gap Types a draft defines, and which conditions across Objects it states unambiguously. */
export interface FetchGapRules {
  readonly groupType: bigint
  /** Prior Object ID Gap, from draft-14. */
  readonly objectType?: bigint
  /**
   * "An endpoint receives an Object with a Prior Group ID Gap covering an
   * Object it previously received", and its Prior Object ID Gap twin: drafts
   * 14-15 and 23. Drafts 11-13 state neither. Drafts 16-22 state both, but
   * draft-16 Section 2.1 to draft-22 Section 2.1.2 say of an Object known to
   * exist, "From this state, it can transition to not existing, but not vice
   * versa", so whether such a gap makes the Track malformed is ambiguous.
   */
  readonly covering: boolean
  /**
   * "An endpoint receives an Object with a Group ID within a previously
   * communicated gap", and from draft-14 its Prior Object ID Gap twin: drafts
   * 11-17 and 23. Drafts 18-22 state both, but draft-18 Section 2.1 to
   * draft-22 Section 2.1.2 say of an Object received after it was recorded as
   * not existing, "This is not a protocol error and the Track is not
   * malformed", so whether it makes the Track malformed is ambiguous.
   */
  readonly withinGap: boolean
}

/** The stream state the conditions are checked against, one per stream. */
export class FetchGapOrder {
  private group: bigint | undefined
  /** The gap the current Group communicated: the largest of each Object's least value, 0 while none carried one. */
  private communicated = 0n
  private earlier: { readonly group: bigint; readonly gap: bigint } | undefined
  private last: { readonly object: bigint; readonly gap: bigint | undefined } | undefined

  constructor(private readonly rules: FetchGapRules) {}

  /**
   * Why the next Object makes the Track malformed, or null. The conditions
   * one Object shows by itself, a gap larger than its ID, are its draft's to
   * check first. An Object whose 0x40 values differ (drafts 11-13) has
   * communicated at least the least of them, whichever is that Object's.
   */
  check(groupId: bigint, objectId: bigint, properties: readonly ObjectProperty[]): string | null {
    const all: ObjectProperty[] = []
    for (const p of properties) {
      all.push(p)
      if (p.properties !== undefined) all.push(...p.properties)
    }
    const groupGaps: bigint[] = []
    let objectGap: bigint | undefined
    for (const p of all) {
      if (p.value === undefined) continue
      if (p.type === this.rules.groupType) groupGaps.push(p.value)
      else if (this.rules.objectType !== undefined && p.type === this.rules.objectType) {
        objectGap = p.value
      }
    }

    if (this.group !== groupId) {
      if (this.group !== undefined) this.earlier = { group: this.group, gap: this.communicated }
      this.group = groupId
      this.communicated = 0n
      this.last = undefined
    }
    const earlier = this.earlier
    if (earlier !== undefined) {
      if (
        this.rules.withinGap &&
        groupId < earlier.group &&
        groupId >= earlier.group - earlier.gap
      ) {
        return `Group ${groupId} is within the Prior Group ID Gap ${earlier.gap} that Group ${earlier.group} communicated`
      }
      if (this.rules.covering) {
        for (const gap of groupGaps) {
          if (earlier.group < groupId && earlier.group >= groupId - gap) {
            return `Prior Group ID Gap ${gap} of Group ${groupId} covers Group ${earlier.group}, received earlier`
          }
        }
      }
    }
    if (groupGaps.length > 0) {
      const least = groupGaps.reduce((a, b) => (b < a ? b : a))
      if (least > this.communicated) this.communicated = least
    }

    const last = this.last
    if (last !== undefined) {
      if (
        this.rules.covering &&
        objectGap !== undefined &&
        objectGap > 0n &&
        last.object < objectId &&
        last.object >= objectId - objectGap
      ) {
        return `Prior Object ID Gap ${objectGap} of Object ${objectId} covers Object ${last.object}`
      }
      if (
        this.rules.withinGap &&
        last.gap !== undefined &&
        objectId < last.object &&
        objectId >= last.object - last.gap
      ) {
        return `Object ${objectId} is within the Prior Object ID Gap ${last.gap} that Object ${last.object} communicated`
      }
    }
    this.last = { object: objectId, gap: objectGap }
    return null
  }
}
