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

import type { Displayed } from '@moqtap/inspect'

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
 * A threshold given in milliseconds, as a person sets one: `5 s`, `1.5 s`,
 * `800 ms`.
 */
export function threshold(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}${THIN}ms`
  const s = Math.round(ms / 100) / 10
  return `${s}${THIN}s`
}

/** The upper edge of duration bucket `i`, `2^(i+1)` ms, rounded as it is read. */
function bucketEdge(i: number): string {
  const ms = 2 ** i
  return ms < 1000 ? `${ms}${THIN}ms` : `${Math.round(ms / 1000)}${THIN}s`
}

/**
 * A duration histogram bucket as the range it covers: `2–4 s`, `16–32 ms`.
 *
 * The collector's buckets double from 1 ms, so the range is the honest
 * precision; a single figure would claim more than was measured. The first
 * also holds everything under a millisecond, and the last everything past
 * its lower edge.
 */
export function bucketRange(i: number, top = 16): string {
  if (i <= 0) return `<${bucketEdge(1)}`
  if (i >= top) return `≥${bucketEdge(top)}`
  const low = 2 ** i
  const high = 2 ** (i + 1)
  if (high < 1000) return `${low}–${high}${THIN}ms`
  if (low < 1000) return `${low}${THIN}ms–${bucketEdge(i + 1)}`
  return `${Math.round(low / 1000)}–${Math.round(high / 1000)}${THIN}s`
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
 * An identifier shortened in the middle, `7f3a91c0…e2b4c91e`, or unchanged
 * when it is 20 characters or fewer. The two ends are the parts people
 * compare by eye; the full value goes in a tooltip and a copy control.
 */
export function middle(value: string, keep = 8): string {
  if (value.length <= Math.max(20, keep * 2 + 1)) return value
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
 * Where the draft specifies a message, as `draft-14 §9.8`, or null when either
 * half is unknown. Plain text: the message name is the one link to the spec.
 */
export function citation(draft: number | null, section: string | null): string | null {
  if (draft === null || section === null) return null
  return `${draftLabel(draft)} §${section}`
}

/**
 * Which way a message went, as a glyph, a colour pair, and words.
 *
 * The file records direction relative to the recorder (`0` is away from it).
 * Where the recorder says which end it was, that becomes client to relay or
 * relay to client: `↑` up to the relay, `↓` down to the client, in the
 * colours those directions take everywhere else in moqtap. An observer or
 * relay tap is neither end, so its messages are labelled as the file records
 * them, sent or received, and keep a glyph without claiming a side.
 */
export interface Heading {
  readonly glyph: '↑' | '↓'
  /** The colour pair to draw it in: client to relay, or relay to client. */
  readonly side: 'c2s' | 's2c'
  readonly label: string
}

const UP: Heading = { glyph: '↑', side: 'c2s', label: 'Client → relay' }
const DOWN: Heading = { glyph: '↓', side: 's2c', label: 'Relay → client' }

export function heading(value: 0 | 1, perspective: string): Heading {
  const away = value === 0
  if (perspective === 'client') return away ? UP : DOWN
  if (perspective === 'server') return away ? DOWN : UP
  return away
    ? { glyph: '↑', side: 'c2s', label: 'Sent' }
    : { glyph: '↓', side: 's2c', label: 'Received' }
}

/**
 * Where a message's spec page lives. The registry stores a path on the site,
 * and the viewer is on another origin, so the path is resolved against the
 * site rather than against this page.
 */
export const SPEC_ORIGIN = 'https://moqtap.com'

/**
 * A link to a spec page, or `null` when the registry path is not one.
 *
 * The path comes from the committed registry, never from the trace, but it is
 * still resolved and checked to land on the site: a link is the one thing on
 * this page that leaves it. The site serves each page at a path ending in
 * `/` and redirects the bare one, so the slash is added rather than costing
 * every click a redirect.
 */
export function specHref(specPath: string): string | null {
  if (!specPath.startsWith('/')) return null
  const url = new URL(specPath, SPEC_ORIGIN)
  if (url.origin !== SPEC_ORIGIN) return null
  if (!url.pathname.endsWith('/')) url.pathname = `${url.pathname}/`
  return url.href
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

/**
 * A field value with a shown form and a recorded one (`Displayed`), as the
 * worker's analysis puts it in a message's fields, or `null`.
 *
 * Checked here rather than with `@moqtap/inspect`'s own `isDisplayed` because
 * the page script does not load that package at run time: only the worker
 * decodes.
 */
export function asShown(value: unknown): Displayed | null {
  if (value === null || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  const shape =
    typeof v.$shown === 'string' &&
    typeof v.text === 'string' &&
    typeof v.raw === 'string' &&
    Object.keys(v).length === 3
  return shape ? (v as unknown as Displayed) : null
}

/**
 * Displayed fields as plain JSON: integers and text as shown, bytes and setup
 * versions as recorded.
 */
export function plainValue(value: unknown): unknown {
  const shown = asShown(value)
  if (shown !== null) {
    return shown.$shown === 'bytes' || shown.$shown === 'version' ? shown.raw : shown.text
  }
  if (Array.isArray(value)) return value.map(plainValue)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plainValue(v)]))
  }
  return value
}

/** Hex shown for an unknown parameter before the rest is cut. */
const UNKNOWN_HEX_SHOWN = 64

/**
 * An unknown parameter as the codec keeps it, `{ id, length, raw_hex }`,
 * written `0x3f · 12 bytes · 0a0b…`; `null` for any other value.
 */
export function unknownParameter(value: unknown): string | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const v = value as Record<string, unknown>
  if (typeof v.id !== 'string' || typeof v.length !== 'number' || typeof v.raw_hex !== 'string') {
    return null
  }
  if (Object.keys(v).length !== 3) return null
  const hex =
    v.raw_hex.length > UNKNOWN_HEX_SHOWN ? `${v.raw_hex.slice(0, UNKNOWN_HEX_SHOWN)}…` : v.raw_hex
  const size = `${v.length} ${v.length === 1 ? 'byte' : 'bytes'}`
  return hex.length > 0 ? `${v.id} · ${size} · ${hex}` : `${v.id} · ${size}`
}

/**
 * The wall-clock time of an offset, in UTC to the millisecond, as logs
 * write it: `20:14:44.332Z`. `startMs` is the session's start, epoch ms.
 */
export function wallClock(startMs: number, us: number): string | null {
  const at = new Date(startMs + Math.floor(us / 1000))
  return Number.isNaN(at.getTime()) ? null : `${at.toISOString().slice(11, 23)}Z`
}
