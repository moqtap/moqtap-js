/**
 * Turning the numbers a trace holds into the ones a person reads.
 *
 * Kept apart from the page because the units here are easy to get subtly
 * wrong: the format stores wall-clock time in milliseconds and event offsets
 * in microseconds, and a thousand-fold error in either direction reads as a
 * plausible number rather than an obvious mistake.
 */

const KIB = 1024

export function bytes(n: number): string {
  if (n < KIB) return `${n} B`
  if (n < KIB * KIB) return `${(n / KIB).toFixed(1)} KB`
  if (n < KIB * KIB * KIB) return `${(n / (KIB * KIB)).toFixed(1)} MB`
  return `${(n / (KIB * KIB * KIB)).toFixed(2)} GB`
}

/**
 * A duration given in microseconds.
 *
 * Sub-millisecond spans keep their microseconds because they are real: a
 * relay's per-hop latency lives there, and rounding it to "0 ms" throws away
 * the measurement rather than tidying it.
 */
export function duration(us: number): string {
  if (us < 1_000) return `${us} µs`
  if (us < 1_000_000) return `${(us / 1_000).toFixed(1)} ms`
  if (us < 60_000_000) return `${(us / 1_000_000).toFixed(2)} s`
  const seconds = us / 1_000_000
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ${(seconds - minutes * 60).toFixed(1)}s`
}

/** An event's offset from the start of its segment, given in microseconds. */
export function offset(us: number): string {
  return `+${duration(us)}`
}

/**
 * A recording start time, in Unix epoch milliseconds.
 *
 * Rendered in the reader's own zone rather than UTC. Someone reading a trace
 * is usually comparing it against a log or a graph on the same screen, and
 * those are in local time.
 */
export function instant(epochMs: number): string {
  const at = new Date(epochMs)
  if (Number.isNaN(at.getTime())) return `${epochMs} (not a time)`
  return at.toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'medium',
  })
}

/** `0` is the direction away from the recorder. */
export function direction(value: 0 | 1): string {
  return value === 0 ? 'sent' : 'received'
}
