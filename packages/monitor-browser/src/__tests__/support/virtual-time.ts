import { settle } from './settle.js'

/**
 * The page's clock and timers, moved by the test. Each timer that falls due
 * runs, then the real work it started (streams, gzip, the upload's fetch) is
 * let settle before the next. A second of the page's clock passes here in
 * milliseconds, and gzip takes real time: a compression still running when
 * the clock moves on would finish seconds late on the page's clock, which no
 * page sees, so the clock waits while `busy()` says one is, for at most
 * {@link BUSY_MS}.
 */
export function virtualTime(busy: () => boolean = () => false) {
  let now = 0
  let nextId = 1
  let order = 0
  const timers = new Map<number, { due: number; order: number; ms: number; fn: () => void }>()
  const fired = new Map<number, number>()
  const due = (until: number): number | undefined => {
    let best: number | undefined
    for (const [id, t] of timers) {
      if (t.due > until) continue
      const b = best === undefined ? undefined : timers.get(best)
      if (b === undefined || t.due < b.due || (t.due === b.due && t.order < b.order)) best = id
    }
    return best
  }
  return {
    ports: {
      clock: { now: () => now, wall: () => 1_700_000_000_000 + now },
      setTimer: (fn: () => void, ms: number): unknown => {
        const id = nextId++
        timers.set(id, { due: now + Math.max(0, ms), order: order++, ms, fn })
        return id
      },
      clearTimer: (h: unknown): void => {
        timers.delete(h as number)
      },
    },
    /** Timers armed with `ms` that have fired. */
    fired: (ms: number): number => fired.get(ms) ?? 0,
    get now() {
      return now
    },
    async advanceTo(t: number): Promise<void> {
      for (;;) {
        await settle(8)
        const until = performance.now() + BUSY_MS
        while (busy()) {
          if (performance.now() > until) throw new Error(`gzip still busy after ${BUSY_MS} ms`)
          await settle(1, 1)
        }
        const id = due(t)
        if (id === undefined) break
        const timer = timers.get(id) as { due: number; ms: number; fn: () => void }
        timers.delete(id)
        fired.set(timer.ms, (fired.get(timer.ms) ?? 0) + 1)
        now = Math.max(now, timer.due)
        timer.fn()
      }
      now = Math.max(now, t)
    },
  }
}

/** Real time the clock waits for compression before the test fails. */
const BUSY_MS = 5_000
