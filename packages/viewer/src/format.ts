/**
 * Turning the numbers a trace holds into the ones a person reads.
 *
 * Kept apart from the page because the units here are easy to get subtly
 * wrong: the format stores wall-clock time in milliseconds and event offsets
 * in microseconds, and a thousand-fold error in either direction reads as a
 * plausible number rather than an obvious mistake.
 *
 * The shapes follow moqtap's data formatting rules, so a size or a duration
 * reads the same here as in every other moqtap tool: binary units with a thin
 * space (`1.4 KiB`), `+00:01.284` offsets, `7f3a…c91e` identifiers.
 */

const KIB = 1024
/** U+2009. Keeps a number and its unit together without the gap of a full space. */
const THIN = '\u2009'

export function bytes(n: number): string {
  if (n < KIB) return `${n}${THIN}B`
  const units = ['KiB', 'MiB', 'GiB', 'TiB']
  let value = n / KIB
  let unit = 0
  // Compared as shown, to one decimal, so a size just under the next unit
  // reads `1.0 MiB` rather than `1024.0 KiB`.
  while (Math.round(value * 10) / 10 >= KIB && unit < units.length - 1) {
    value /= KIB
    unit += 1
  }
  return `${value.toFixed(1)}${THIN}${units[unit]}`
}

/** A count with thousands separators, written the same whatever the reader's locale. */
export function count(n: number): string {
  return n.toLocaleString('en-US')
}

/**
 * A duration given in microseconds: `0.42 ms`, `18 ms`, `1.25 s`, `3 m 12 s`.
 *
 * A span too short to show in hundredths of a millisecond keeps its
 * microseconds, because it is real: a relay's per-hop latency lives there, and
 * rounding it to `0.00 ms` throws away the measurement rather than tidying it.
 *
 * Each unit is chosen after rounding to the precision it is shown at, so a
 * span that rounds up to the next unit is written in it: `1.00 s`, never
 * `1000 ms`; `1 m 0 s`, never `60.00 s`.
 */
export function duration(us: number): string {
  if (us < 10) return `${us}${THIN}µs`
  const hundredthsOfMs = Math.round(us / 10)
  if (hundredthsOfMs < 1_000) return `${(hundredthsOfMs / 100).toFixed(2)}${THIN}ms`
  const ms = Math.round(us / 1_000)
  if (ms < 1_000) return `${ms}${THIN}ms`
  const hundredthsOfS = Math.round(us / 10_000)
  if (hundredthsOfS < 6_000) return `${(hundredthsOfS / 100).toFixed(2)}${THIN}s`
  const seconds = Math.round(us / 1_000_000)
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  if (hours > 0) return `${hours}${THIN}h ${minutes}${THIN}m`
  return `${minutes}${THIN}m ${seconds % 60}${THIN}s`
}

/**
 * An event's offset from the start of the session, given in microseconds:
 * `+00:01.284`, and `+1:02:03.456` past the hour.
 *
 * Milliseconds, not microseconds, because the column has to line up and stay
 * narrow. The exact value is one tooltip away (`exactOffset`).
 */
export function offset(us: number): string {
  const ms = Math.floor(us / 1_000)
  const hours = Math.floor(ms / 3_600_000)
  const minutes = Math.floor((ms % 3_600_000) / 60_000)
  const seconds = Math.floor((ms % 60_000) / 1_000)
  const millis = ms % 1_000
  const mm = String(minutes).padStart(2, '0')
  const ss = String(seconds).padStart(2, '0')
  const fff = String(millis).padStart(3, '0')
  return hours > 0 ? `+${hours}:${mm}:${ss}.${fff}` : `+${mm}:${ss}.${fff}`
}

/** The same offset to the microsecond, for a tooltip. */
export function exactOffset(us: number): string {
  return `${count(us)} µs from the start of the session`
}

/**
 * A recording start time, in Unix epoch milliseconds.
 *
 * Rendered in the reader's own zone rather than UTC. Someone reading a trace
 * is usually comparing it against a log or a graph on the same screen, and
 * those are in local time. `iso` is the unambiguous form for a tooltip.
 */
export function instant(epochMs: number): string {
  const at = new Date(epochMs)
  if (Number.isNaN(at.getTime())) return `${epochMs} (not a time)`
  return at.toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'medium',
  })
}

export function iso(epochMs: number): string | null {
  const at = new Date(epochMs)
  return Number.isNaN(at.getTime()) ? null : at.toISOString()
}

/**
 * An identifier shortened in the middle, `7f3a…c91e`, or unchanged
 * when it is short enough to show whole. The two ends are the parts people
 * compare by eye; the full value goes in a tooltip and a copy control.
 */
export function middle(value: string, keep = 4): string {
  if (value.length <= keep * 2 + 1) return value
  return `${value.slice(0, keep)}…${value.slice(-keep)}`
}

/** A wire ID as the drafts write it: `0x3`, `0x20`. */
export function hexId(value: number): string {
  return `0x${value.toString(16)}`
}

/** `draft-16`: how moqtap writes a draft version everywhere. */
export function draftLabel(draft: number): string {
  return `draft-${String(draft).padStart(2, '0')}`
}

/**
 * Which way a message went, as a glyph, the side it travelled to, and words.
 *
 * The file records direction relative to the recorder (`0` is away from it).
 * Where the recorder says which end it was, that becomes client→server or
 * server→client, which is what the glyph and colour mean everywhere else in
 * moqtap. An observer or relay tap is neither end, so its messages are
 * labelled as the file records them, sent or received, and keep the glyph
 * without claiming a side.
 */
export interface Heading {
  readonly glyph: '→' | '←'
  /** The colour pair to draw it in: client→server or server→client. */
  readonly side: 'c2s' | 's2c'
  readonly label: string
}

export function heading(value: 0 | 1, perspective: string): Heading {
  const away = value === 0
  if (perspective === 'client') {
    return away
      ? { glyph: '→', side: 'c2s', label: 'client→server' }
      : { glyph: '←', side: 's2c', label: 'server→client' }
  }
  if (perspective === 'server') {
    return away
      ? { glyph: '←', side: 's2c', label: 'server→client' }
      : { glyph: '→', side: 'c2s', label: 'client→server' }
  }
  return away
    ? { glyph: '→', side: 'c2s', label: 'sent by the recorder' }
    : { glyph: '←', side: 's2c', label: 'received by the recorder' }
}

/** Sixteen bytes a line: an 8-digit offset, the bytes in hex, and their ASCII. */
export interface HexLine {
  readonly offset: string
  readonly hex: string
  readonly ascii: string
}

export function hexLines(data: Uint8Array): HexLine[] {
  const lines: HexLine[] = []
  for (let at = 0; at < data.length; at += 16) {
    const chunk = data.subarray(at, at + 16)
    const hex = Array.from(chunk, (b) => b.toString(16).padStart(2, '0')).join(' ')
    const ascii = Array.from(chunk, (b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.'))
    lines.push({
      offset: at.toString(16).padStart(8, '0'),
      hex: hex.padEnd(47, ' '),
      ascii: ascii.join(''),
    })
  }
  return lines
}
