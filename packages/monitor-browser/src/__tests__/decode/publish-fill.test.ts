/**
 * From draft-23 a PUBLISH may carry FILL_PARAMETERS, and its fill stream's
 * FETCH_HEADER names the PUBLISH: a request the stream's own sender made.
 */

import { describe, expect, it } from 'vitest'
import { TrackKeys } from '../../decode/track-key.js'

const publish = (order?: bigint, fillOrder?: bigint) => ({
  type: 'publish',
  request_id: 1n,
  track_alias: 0n,
  parameters: {
    ...(order === undefined ? {} : { group_order: order }),
    ...(fillOrder === undefined ? {} : { fill_parameters: { group_order: fillOrder } }),
  },
})

describe('a fill stream answering a PUBLISH', () => {
  it('is a fill in the order FILL_PARAMETERS states', () => {
    const keys = new TrackKeys()
    keys.applyControl(publish(1n, 2n), 'rx', 5, 0)
    expect(keys.fetchPath('rx', 1n)).toBe('fill')
    expect(keys.descending('rx', 1n)).toBe(true)
  })

  it('takes the PUBLISH’s own GROUP_ORDER when FILL_PARAMETERS states none', () => {
    const keys = new TrackKeys()
    keys.applyControl(publish(2n), 'rx', 5, 0)
    expect(keys.descending('rx', 1n)).toBe(true)
  })

  it('names no request the stream’s sender made other than a PUBLISH', () => {
    const keys = new TrackKeys()
    keys.applyControl({ type: 'subscribe', request_id: 1n, parameters: {} }, 'rx', 5, 0)
    expect(keys.fetchPath('rx', 1n)).toBeNull()
    expect(keys.fetchPath('tx', 1n)).toBe('fill')
  })
})
