/**
 * The page's rules that need no DOM: how buckets, thresholds and unknown
 * parameters read, what the keys do, what the filter matches, and where
 * "next" lands.
 */

import { describe, expect, it } from 'vitest'
import type { MessageRow, ProblemRow } from '../analysis'
import { bucketRange, threshold, unknownParameter, wallClock } from '../format'
import {
  axisTicks,
  densityStep,
  isErrorRow,
  keyAction,
  matchesFilter,
  messageKey,
  nextGap,
  stepProblem,
} from '../navigate'
import type { Cell } from '../rollups'
import { bandLabel, cellLabel, laneLabel } from '../timeline'

const THIN = String.fromCharCode(0x2009)
const t = (s: string) => s.replaceAll(' ', THIN)

describe('bucketRange', () => {
  it('reads a duration bucket as the range it covers', () => {
    expect(bucketRange(11)).toBe(t('2–4 s'))
    expect(bucketRange(4)).toBe(t('16–32 ms'))
    expect(bucketRange(9)).toBe(`512${THIN}ms–1${THIN}s`)
  })

  it('folds everything under the first edge into the first bucket and the tail into the last', () => {
    expect(bucketRange(0)).toBe(t('<2 ms'))
    expect(bucketRange(16)).toBe(t('≥66 s'))
  })
})

describe('threshold', () => {
  it('writes a threshold as it is set', () => {
    expect(threshold(5000)).toBe(t('5 s'))
    expect(threshold(1500)).toBe(t('1.5 s'))
    expect(threshold(800)).toBe(t('800 ms'))
  })
})

describe('unknownParameter', () => {
  it("writes the codec's unknown parameter as its id, length and bytes", () => {
    expect(unknownParameter({ id: '0x3f', length: 2, raw_hex: 'beef' })).toBe(
      '0x3f · 2 bytes · beef',
    )
    expect(unknownParameter({ id: '0x21', length: 0, raw_hex: '' })).toBe('0x21 · 0 bytes')
  })

  it('cuts long bytes short', () => {
    const shown = unknownParameter({ id: '0x3f', length: 100, raw_hex: 'ab'.repeat(100) })
    expect(shown).toBe(`0x3f · 100 bytes · ${'ab'.repeat(32)}…`)
  })

  it('is null for anything else', () => {
    for (const value of [
      null,
      'x',
      [],
      { id: '0x1', length: 1 },
      { id: 1, length: 1, raw_hex: '' },
    ]) {
      expect(unknownParameter(value)).toBeNull()
    }
  })
})

describe('wallClock', () => {
  it('writes an offset as UTC wall time to the millisecond', () => {
    expect(wallClock(Date.UTC(2026, 9, 20, 20, 14, 3, 120), 41_212_000)).toBe('20:14:44.332Z')
  })
})

describe('keys', () => {
  it('maps the navigation keys, and leaves modified keys to the browser', () => {
    expect(['j', 'k', 'n', 'p', 'g', 'e', '/'].map((key) => keyAction({ key }))).toEqual([
      'next-message',
      'previous-message',
      'next-problem',
      'previous-problem',
      'next-gap',
      'next-error',
      'filter',
    ])
    expect(keyAction({ key: 'j', ctrlKey: true })).toBeNull()
    expect(keyAction({ key: 'x' })).toBeNull()
  })
})

const message = (fields: Partial<MessageRow>): MessageRow => ({
  segment: 0,
  seq: 0,
  timestamp: 0,
  at: 0,
  direction: 0,
  messageType: 0x3,
  name: 'SUBSCRIBE',
  reserved: false,
  note: null,
  section: null,
  specPath: null,
  ...fields,
})

describe('the message filter', () => {
  const row = message({
    requestId: '14',
    track: 'live/ch4 / video/1080p',
    aliases: ['ANNOUNCE'],
  })

  it('matches every word against name, aliases, wire ID, request id and track', () => {
    expect(matchesFilter(row, '')).toBe(true)
    expect(matchesFilter(row, 'subscribe')).toBe(true)
    expect(matchesFilter(row, 'announce')).toBe(true)
    expect(matchesFilter(row, '0x3 #14')).toBe(true)
    expect(matchesFilter(row, '1080p')).toBe(true)
    expect(matchesFilter(row, 'subscribe audio')).toBe(false)
  })

  it('finds an error by its code name, and undecodable bytes by the word', () => {
    const error = message({
      name: 'SUBSCRIBE_ERROR',
      error: {
        code: '4',
        codeName: 'TRACK_DOES_NOT_EXIST',
        label: 'TRACK_DOES_NOT_EXIST (0x4)',
        reason: '',
      },
    })
    expect(matchesFilter(error, 'does_not_exist')).toBe(true)
    expect(isErrorRow(error)).toBe(true)
    const bytes = message({ name: null, messageType: null, undecodable: 'bad frame' })
    expect(matchesFilter(bytes, 'undecodable')).toBe(true)
    expect(isErrorRow(bytes)).toBe(true)
    expect(isErrorRow(row)).toBe(false)
  })

  it('keys a message by segment and sequence', () => {
    expect(messageKey(message({ segment: 2, seq: 31 }))).toBe('2:31')
  })
})

describe('where next lands', () => {
  const problem = (at: number | null, index: number | null): ProblemRow => ({
    kind: 'error',
    at,
    index,
    title: '',
    detail: null,
  })
  const problems = [problem(100, 0), problem(200, null), problem(300, 2), problem(400, 3)]

  it('steps to the problem after or before a moment, passing over the one there', () => {
    expect(stepProblem(problems, 100, 1)?.at).toBe(300)
    expect(stepProblem(problems, 300, -1)?.at).toBe(100)
    expect(stepProblem(problems, 400, 1)).toBeNull()
    expect(stepProblem(problems, -1, 1)?.at).toBe(100)
  })

  it('finds the next cell with a gap or a stall', () => {
    const cell = (from: number, gaps: number, stalls: number): Cell => ({
      lane: 'a',
      from,
      to: from + 10,
      objects: 1,
      groupGaps: gaps,
      skipped: 0,
      stalls,
      longestStall: null,
    })
    const cells = [cell(30, 1, 0), cell(10, 0, 0), cell(20, 0, 1)]
    expect(nextGap(cells, -1)?.from).toBe(20)
    expect(nextGap(cells, 20)?.from).toBe(30)
    expect(nextGap(cells, 30)).toBeNull()
  })
})

describe('the timeline scale', () => {
  it('shades density in four steps against the busiest cell', () => {
    expect([0, 1, 26, 50, 100].map((rate) => densityStep(rate, 100))).toEqual([0, 1, 2, 2, 4])
    expect(densityStep(5, 0)).toBe(0)
  })

  it('labels the axis at a round step, eight labels at most', () => {
    expect(axisTicks(30e6)).toEqual([0, 5e6, 10e6, 15e6, 20e6, 25e6, 30e6])
    expect(axisTicks(600e6).length).toBeLessThanOrEqual(9)
    expect(axisTicks(600e6)[1]).toBe(120e6)
  })
})

describe('timeline labels', () => {
  const cell = (fields: Partial<Cell>): Cell => ({
    lane: 'c1|rx:alias:9',
    from: 0,
    to: 10e6,
    objects: 412,
    groupGaps: 0,
    skipped: 0,
    stalls: 0,
    longestStall: null,
    ...fields,
  })

  it('labels a cell with its stall by bucket, its gaps and its skips', () => {
    expect(cellLabel(cell({}))).toBe('412 objects')
    expect(cellLabel(cell({ stalls: 1, longestStall: 11, groupGaps: 1, skipped: 2 }))).toBe(
      `412 objects · stall 2–4${THIN}s · 1 group ID gap · 2 skipped`,
    )
    expect(cellLabel(cell({ stalls: 3, longestStall: 9 }))).toBe(
      `412 objects · stall 512${THIN}ms–1${THIN}s (3 stalls)`,
    )
  })

  it('names a lane by its track, else by its alias, and marks the sending side', () => {
    const stats = {
      direction: 'tx' as const,
      kind: 'alias' as const,
      id: '3',
      objects: 0,
      payloadBytes: 0,
      groups: 0,
      groupGaps: 0,
      skipped: 0,
      stalls: 0,
      longestStall: null,
      cadenceP50: null,
      cadenceP95: null,
      arrivalP95: null,
    }
    const lane = { key: 'c1|tx:alias:3', connection: 'c1', stats }
    expect(laneLabel(lane, [])).toBe('alias 3 (sent)')
    const track = {
      key: 'k',
      name: 'live / audio',
      namespace: [],
      trackName: '',
      lanes: [lane.key],
    }
    expect(laneLabel(lane, [track])).toBe('live / audio (sent)')
  })

  it('labels a detail band with its level, its cause and how long it lasted', () => {
    expect(bandLabel('headers', 'stall', 15e6, false)).toBe(`headers · stall · 15.00${THIN}s`)
    expect(bandLabel('headers', null, 3e6, true)).toBe(`headers · 3.00${THIN}s so far`)
  })
})
