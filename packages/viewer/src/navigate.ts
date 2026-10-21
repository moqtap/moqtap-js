/**
 * Moving around a trace: the keys, the filter, and where "next" lands.
 *
 * Kept free of the DOM so the rules can be tested as functions; `main.ts`
 * wires them to the page.
 */

import type { MessageRow, ProblemRow } from './analysis'
import type { Cell } from './rollups'

/** What a key does on the page, when no text field has it. */
export type KeyAction =
  | 'next-message'
  | 'previous-message'
  | 'next-problem'
  | 'previous-problem'
  | 'next-gap'
  | 'next-error'
  | 'filter'

const KEYS: Readonly<Record<string, KeyAction>> = {
  j: 'next-message',
  k: 'previous-message',
  n: 'next-problem',
  p: 'previous-problem',
  g: 'next-gap',
  e: 'next-error',
  '/': 'filter',
}

/** The action for a key press, or `null`. Modified keys are the browser's. */
export function keyAction(event: {
  readonly key: string
  readonly ctrlKey?: boolean
  readonly metaKey?: boolean
  readonly altKey?: boolean
}): KeyAction | null {
  if (event.ctrlKey === true || event.metaKey === true || event.altKey === true) return null
  return KEYS[event.key] ?? null
}

/** `segment:seq`: a message's key, stable while a trace grows, and the `msg` of a permalink. */
export function messageKey(message: Pick<MessageRow, 'segment' | 'seq'>): string {
  return `${message.segment}:${message.seq}`
}

/**
 * Whether a message matches the filter: every word, case-insensitive,
 * somewhere in its name, its names in other drafts, its wire ID, its request
 * id (`#14` or `14`), its track or its error.
 */
export function matchesFilter(message: MessageRow, filter: string): boolean {
  const words = filter
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 0)
  if (words.length === 0) return true
  const haystack = [
    message.name ?? '',
    ...(message.aliases ?? []),
    message.messageType === null ? 'undecodable' : `0x${message.messageType.toString(16)}`,
    message.requestId === undefined ? '' : `#${message.requestId}`,
    message.track ?? '',
    message.error?.codeName ?? '',
    message.undecodable ?? '',
  ]
    .join('\n')
    .toLowerCase()
  return words.every((word) => haystack.includes(word))
}

/** Whether a row reads as an error: an error response, or bytes that did not decode. */
export function isErrorRow(message: MessageRow): boolean {
  return message.undecodable !== undefined || message.error !== undefined
}

/**
 * The problem after (`step` 1) or before (-1) the moment `fromUs`, among
 * those with a message to show. A problem exactly at `fromUs` is the one
 * already shown, so it is passed over.
 */
export function stepProblem(
  problems: readonly ProblemRow[],
  fromUs: number,
  step: 1 | -1,
): ProblemRow | null {
  const placed = problems.filter((p) => p.index !== null && p.at !== null)
  if (step === 1) return placed.find((p) => p.at! > fromUs) ?? null
  for (let i = placed.length - 1; i >= 0; i -= 1) if (placed[i]!.at! < fromUs) return placed[i]!
  return null
}

/** The first cell starting after `fromUs` with a group ID gap or a stall. */
export function nextGap(cells: readonly Cell[], fromUs: number): Cell | null {
  let found: Cell | null = null
  for (const cell of cells) {
    if (cell.groupGaps === 0 && cell.stalls === 0) continue
    if (cell.from <= fromUs) continue
    if (found === null || cell.from < found.from) found = cell
  }
  return found
}

/**
 * How dense a cell is against the busiest cell on its lane, as one of four
 * steps, by object rate. A cell with no objects is step 0.
 */
export function densityStep(rate: number, busiest: number): 0 | 1 | 2 | 3 | 4 {
  if (rate <= 0 || busiest <= 0) return 0
  return Math.min(4, Math.max(1, Math.ceil((rate / busiest) * 4))) as 1 | 2 | 3 | 4
}

/**
 * Where the time axis is labelled: a round step giving at most about eight
 * labels over `spanUs`, in microseconds from the start.
 */
export function axisTicks(spanUs: number, most = 8): number[] {
  const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600].map((s) => s * 1e6)
  const step = steps.find((s) => spanUs / s <= most) ?? Math.ceil(spanUs / most / 3.6e9) * 3.6e9
  const ticks: number[] = []
  for (let at = 0; at <= spanUs; at += step) ticks.push(at)
  return ticks
}
