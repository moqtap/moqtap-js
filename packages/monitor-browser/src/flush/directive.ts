/**
 * What ingest may ask of the collector, on an upload's own response: the only
 * channel it has. The page obeys within the bounds below, whatever it is
 * asked; anything outside them is clamped, and anything it cannot read is
 * ignored.
 */

import { DETAIL_LEVELS, type DetailLevel, type Directive } from '../types.js'

/** The response header carrying a {@link Directive}, as JSON. */
export const DIRECTIVE_HEADER = 'x-moqtap-directive'

/** The shortest and longest seal interval `flushMs` may ask for. */
export const DIRECTIVE_FLUSH_MIN_MS = 1_000
export const DIRECTIVE_FLUSH_MAX_MS = 10_000

/** The longest a `flushMs` holds, from the response that asked for it. */
export const DIRECTIVE_FLUSH_MAX_SPAN_MS = 10 * 60_000

/** The longest an `elevate` holds, from the response that asked for it: ingest's longest capture window. */
export const DIRECTIVE_ELEVATE_MAX_SPAN_MS = 30 * 60_000

/**
 * The longest a `hold` lasts from the response that sent it. Ingest repeats
 * it on every upload while the month's recording minutes are used up, so a
 * hold ends within this span once they are not, as after a move to a plan
 * with more minutes.
 */
export const DIRECTIVE_HOLD_MAX_SPAN_MS = 10 * 60_000

/**
 * The highest level an `elevate` raises to. `headers+data` uploads the same
 * records, and is a level only the page may choose.
 */
export const DIRECTIVE_ELEVATE_MAX_LEVEL: DetailLevel = 'headers+sizes'

/** The longest `elevate.reason` kept, in code points. */
export const DIRECTIVE_REASON_MAX = 200

/** Longer than any directive ingest sends; a longer header is not read. */
const MAX_HEADER_CHARS = 2_048

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** The directive in a header value, or `undefined` when it carries none the collector can read. */
export function parseDirective(raw: string | null): Directive | undefined {
  if (raw === null || raw.length === 0 || raw.length > MAX_HEADER_CHARS) return undefined
  let v: unknown
  try {
    v = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return undefined
  const o = v as Record<string, unknown>
  const out: {
    flushMs?: number
    until?: number
    elevate?: NonNullable<Directive['elevate']>
    hold?: NonNullable<Directive['hold']>
  } = {}
  if (finite(o.flushMs)) {
    out.flushMs = o.flushMs
    if (finite(o.until)) out.until = o.until
  }
  const e = o.elevate
  if (e !== null && typeof e === 'object' && !Array.isArray(e)) {
    const { level, until, reason } = e as Record<string, unknown>
    if (
      typeof level === 'string' &&
      (DETAIL_LEVELS as readonly string[]).includes(level) &&
      finite(until)
    ) {
      out.elevate = {
        level: level as DetailLevel,
        until,
        reason:
          typeof reason === 'string'
            ? Array.from(reason).slice(0, DIRECTIVE_REASON_MAX).join('')
            : '',
      }
    }
  }
  const h = o.hold
  if (h !== null && typeof h === 'object' && !Array.isArray(h)) {
    const { until } = h as Record<string, unknown>
    if (finite(until)) out.hold = { until }
  }
  return out.flushMs === undefined && out.elevate === undefined && out.hold === undefined
    ? undefined
    : out
}
